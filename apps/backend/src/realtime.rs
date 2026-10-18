use crate::{
    AppState,
    error::ApiError,
    identity::{self, Session},
    messages, now_ms,
    presence::{Room, Window},
    servers,
    signaling::Signal,
};
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::{
    sync::mpsc,
    time::{MissedTickBehavior, interval, timeout},
};

#[derive(Debug, Deserialize)]
pub struct ClientEnvelope {
    pub v: u8,
    #[serde(flatten)]
    pub event: ClientEvent,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientEvent {
    Join { server_id: String },
    Leave,
    Message { client_id: String, content: String },
    VoiceJoin,
    VoiceLeave,
    Mute { muted: bool },
    Signal { to: String, signal: Signal },
    Heartbeat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Welcome {
        session_id: String,
        room: Option<Room>,
        grace_seconds: u64,
    },
    Joined {
        room: Room,
    },
    Left,
    Presence {
        room: Room,
    },
    Notice {
        server_id: String,
        display_name: String,
        action: &'static str,
    },
    ServersChanged,
    Message {
        message: messages::Message,
    },
    Ack {
        message: messages::Message,
    },
    Signal {
        from: String,
        signal: Signal,
    },
    Error {
        code: &'static str,
        message: &'static str,
        client_id: Option<String>,
    },
    Pong,
    Replaced,
    Shutdown,
}

impl ServerEvent {
    pub fn error(error: ApiError, client_id: Option<String>) -> Self {
        Self::Error {
            code: error.code,
            message: error.message,
            client_id,
        }
    }
}

pub fn parse(text: &str) -> Result<ClientEvent, ApiError> {
    if text.len() > 32768 {
        return Err(ApiError::bad("payload_too_large", "Evento excede 32 KiB."));
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| ApiError::bad("invalid_event", "Evento WebSocket inválido."))?;
    let fields: &[&str] = match value.get("type").and_then(|v| v.as_str()) {
        Some("join") => &["v", "type", "server_id"],
        Some("message") => &["v", "type", "client_id", "content"],
        Some("mute") => &["v", "type", "muted"],
        Some("signal") => &["v", "type", "to", "signal"],
        _ => &["v", "type"],
    };
    if value
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !fields.contains(&key.as_str())))
    {
        return Err(ApiError::bad(
            "invalid_event",
            "Campos de evento inválidos.",
        ));
    }
    let envelope: ClientEnvelope = serde_json::from_value(value)
        .map_err(|_| ApiError::bad("invalid_event", "Evento WebSocket inválido."))?;
    if envelope.v != 1 {
        return Err(ApiError::bad(
            "unsupported_version",
            "Versão de protocolo não suportada.",
        ));
    }
    Ok(envelope.event)
}

pub async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    identity::validate_origin(&state, &headers)?;
    let session = identity::authenticate(&state, &headers).await?;
    if !state.presence.lock().await.allow_connection(&session.id) {
        return Err(ApiError::limited());
    }
    Ok(ws
        .max_message_size(32768)
        .max_frame_size(32768)
        .on_upgrade(move |socket| serve(socket, state, session)))
}

async fn send(socket: &mut WebSocket, event: &ServerEvent) -> bool {
    #[derive(Serialize)]
    struct Envelope<'a> {
        v: u8,
        #[serde(flatten)]
        event: &'a ServerEvent,
    }
    let Ok(text) = serde_json::to_string(&Envelope { v: 1, event }) else {
        return false;
    };
    matches!(
        timeout(
            Duration::from_secs(5),
            socket.send(WsMessage::Text(text.into()))
        )
        .await,
        Ok(Ok(()))
    )
}

async fn serve(mut socket: WebSocket, state: AppState, session: Session) {
    let (sender, mut receiver) = mpsc::channel(128);
    let connection = state.presence.lock().await.connect(session.clone(), sender);
    let mut heartbeat = interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_seen = Instant::now();
    let mut events = Window::default();
    let mut malformed = 0;
    loop {
        tokio::select! {
            outgoing = receiver.recv() => {
                let Some(event) = outgoing else { break; };
                let terminal = matches!(event, ServerEvent::Replaced | ServerEvent::Shutdown);
                if !send(&mut socket, &event).await || terminal { break; }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                last_seen = Instant::now();
                if !events.allow(120, Duration::from_secs(10)) { let _ = send(&mut socket, &ServerEvent::error(ApiError::limited(), None)).await; break; }
                match message {
                    WsMessage::Text(text) => {
                        let event = match parse(&text) {
                            Ok(event) => event,
                            Err(error) => { malformed += 1; if !send(&mut socket, &ServerEvent::error(error, None)).await || malformed >= 5 { break; } continue; }
                        };
                        let client_id = match &event { ClientEvent::Message { client_id, .. } => Some(client_id.clone()), _ => None };
                        if matches!(event, ClientEvent::Message {..}) && !state.presence.lock().await.allow_message(&session.id) {
                            if !send(&mut socket, &ServerEvent::error(ApiError::limited(), client_id)).await { break; }
                            continue;
                        }
                        if let Err(error) = handle(&state, &session, &connection, event).await
                            && !send(&mut socket, &ServerEvent::error(error, client_id)).await { break; }
                    }
                    WsMessage::Close(_) => break,
                    WsMessage::Ping(data) => { if !matches!(timeout(Duration::from_secs(5), socket.send(WsMessage::Pong(data))).await, Ok(Ok(()))) { break; } }
                    WsMessage::Pong(_) => {},
                    WsMessage::Binary(_) => { if !send(&mut socket, &ServerEvent::error(ApiError::bad("invalid_event", "Envie eventos JSON em texto."), None)).await { break; } }
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(30) || session.expires_at <= now_ms() || !state.presence.lock().await.is_current(&session.id, &connection) { break; }
                if !matches!(timeout(Duration::from_secs(5), socket.send(WsMessage::Ping(vec![].into()))).await, Ok(Ok(()))) { break; }
            }
        }
    }
    state
        .presence
        .lock()
        .await
        .disconnect(&session.id, &connection);
    let _ = timeout(Duration::from_secs(1), socket.send(WsMessage::Close(None))).await;
}

pub async fn handle(
    state: &AppState,
    session: &Session,
    connection: &str,
    event: ClientEvent,
) -> Result<(), ApiError> {
    // Serializa autorização e mutação com trocas de conexão e saída de sala.
    // As operações SQLite são assíncronas e curtas; não há locks síncronos no runtime.
    let mut hub = state.presence.lock().await;
    if !hub.is_current(&session.id, connection) || session.expires_at <= now_ms() {
        return Err(ApiError::unauthorized());
    }
    match event {
        ClientEvent::Join { server_id } => {
            servers::find(state, &server_id).await?;
            hub.join(&session.id, &server_id)?;
        }
        ClientEvent::Leave => hub.leave(&session.id),
        ClientEvent::Heartbeat => hub.send(&session.id, ServerEvent::Pong),
        ClientEvent::VoiceJoin => hub.voice(&session.id, true, false)?,
        ClientEvent::VoiceLeave => hub.voice(&session.id, false, false)?,
        ClientEvent::Mute { muted } => hub.mute(&session.id, muted)?,
        ClientEvent::Signal { to, signal } => {
            signal.validate()?;
            hub.authorize_signal(&session.id, &to)?;
            hub.send(
                &to,
                ServerEvent::Signal {
                    from: session.id.clone(),
                    signal,
                },
            );
        }
        ClientEvent::Message { client_id, content } => {
            let room = hub
                .room_for(&session.id)
                .ok_or_else(ApiError::forbidden)?
                .server_id;
            hub.require_member(&session.id, &room)?;
            let message = messages::persist(state, session, &room, &client_id, &content).await?;
            hub.room_event(
                &room,
                ServerEvent::Message {
                    message: message.clone(),
                },
            );
            hub.send(&session.id, ServerEvent::Ack { message });
        }
    }
    Ok(())
}
