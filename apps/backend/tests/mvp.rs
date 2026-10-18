use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode, header},
    response::Response,
};
use discord_backend::{
    AppState, database, http,
    identity::Session,
    messages,
    presence::{Hub, RECONNECT_GRACE, Window},
    realtime::{self, ClientEvent, ServerEvent},
    servers::Server,
    signaling::{Description, DescriptionType, Signal},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
const ORIGIN: &str = "http://localhost:5173";

#[tokio::test]
async fn configured_https_origin_creates_secure_session_without_relaxing_local_or_csrf_rules()
-> TestResult {
    const PUBLIC_ORIGIN: &str = "https://submersed-footwear-slimness.ngrok-free.dev";
    let mut state = setup().await?;
    state
        .origins
        .extend(["http://127.0.0.1:5173".parse()?, PUBLIC_ORIGIN.parse()?]);
    state.secure_cookie = true;
    for origin in [PUBLIC_ORIGIN, ORIGIN, "http://127.0.0.1:5173"] {
        let response = call(
            http::application(state.clone()),
            "POST",
            "/api/session",
            None,
            Some(origin),
            json!({"display_name":"Teste Origem"}),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            origin
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        let cookie = response.headers()[header::SET_COOKIE].to_str()?.to_owned();
        assert!(cookie.contains("HttpOnly; SameSite=Lax; Path=/api; Secure"));
        let cookie = cookie.split(';').next().ok_or("cookie")?;
        let session: Session = decode(response).await?;
        let current = call(
            http::application(state.clone()),
            "GET",
            "/api/session",
            Some(cookie),
            None,
            Value::Null,
        )
        .await?;
        assert_eq!(current.status(), StatusCode::OK);
        assert_eq!(decode::<Session>(current).await?.id, session.id);
    }
    for origin in [
        None,
        Some("https://hostile.example"),
        Some("http://submersed-footwear-slimness.ngrok-free.dev"),
        Some("https://submersed-footwear-slimness.ngrok-free.dev.hostile.example"),
    ] {
        let response = call(
            http::application(state.clone()),
            "POST",
            "/api/session",
            None,
            origin,
            json!({"display_name":"Teste Origem"}),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
    }
    Ok(())
}

async fn setup() -> TestResult<AppState> {
    Ok(AppState::new(
        database::connect("sqlite::memory:").await?,
        vec![ORIGIN.parse()?],
    ))
}
async fn call(
    app: Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
    body: Value,
) -> TestResult<Response> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    Ok(app
        .oneshot(request.body(Body::from(serde_json::to_vec(&body)?))?)
        .await?)
}
async fn decode<T: DeserializeOwned>(response: Response) -> TestResult<T> {
    Ok(serde_json::from_slice(
        &to_bytes(response.into_body(), 1000000).await?,
    )?)
}
async fn identified(state: &AppState, name: &str) -> TestResult<(Session, String)> {
    let response = call(
        http::application(state.clone()),
        "POST",
        "/api/session",
        None,
        Some(ORIGIN),
        json!({"display_name":name}),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()?
        .split(';')
        .next()
        .ok_or("missing cookie")?
        .to_owned();
    Ok((decode(response).await?, cookie))
}
async fn server(state: &AppState, cookie: &str, name: &str) -> TestResult<Server> {
    let response = call(
        http::application(state.clone()),
        "POST",
        "/api/servers",
        Some(cookie),
        Some(ORIGIN),
        json!({"name":name}),
    )
    .await?;
    assert_eq!(response.status(), StatusCode::CREATED);
    decode(response).await
}
async fn connected(state: &AppState, session: &Session) -> (String, mpsc::Receiver<ServerEvent>) {
    let (sender, receiver) = mpsc::channel(256);
    let id = state.presence.lock().await.connect(session.clone(), sender);
    (id, receiver)
}

#[tokio::test]
async fn identity_normalizes_and_uses_non_forgeable_cookie() -> TestResult {
    let state = setup().await?;
    let response = call(
        http::application(state.clone()),
        "POST",
        "/api/session",
        None,
        Some(ORIGIN),
        json!({"display_name":"  Ana   Maria  "}),
    )
    .await?;
    let cookie_header = response.headers()[header::SET_COOKIE].to_str()?.to_owned();
    assert!(cookie_header.contains("HttpOnly; SameSite=Lax; Path=/api"));
    let cookie = cookie_header.split(';').next().ok_or("cookie")?;
    let session: Session = decode(response).await?;
    assert_eq!(session.display_name, "Ana Maria");
    let response = call(
        http::application(state.clone()),
        "GET",
        "/api/session",
        Some(cookie),
        None,
        Value::Null,
    )
    .await?;
    assert_eq!(decode::<Session>(response).await?.id, session.id);
    for forged in [
        format!("comm_session={}", session.id),
        format!("comm_session={}", "a".repeat(64)),
    ] {
        assert_eq!(
            call(
                http::application(state.clone()),
                "GET",
                "/api/session",
                Some(&forged),
                None,
                Value::Null
            )
            .await?
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_one(&state.pool)
        .await?;
    assert!(!cookie.contains(&stored));
    Ok(())
}

#[tokio::test]
async fn validates_names_and_csrf_origin() -> TestResult {
    let state = setup().await?;
    for name in ["", " ", "a", &"x".repeat(33), "a\0b"] {
        let response = call(
            http::application(state.clone()),
            "POST",
            "/api/session",
            None,
            Some(ORIGIN),
            json!({"display_name":name}),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    for origin in [None, Some("https://hostile.example")] {
        assert_eq!(
            call(
                http::application(state.clone()),
                "POST",
                "/api/session",
                None,
                origin,
                json!({"display_name":"Ana"})
            )
            .await?
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let (_, cookie) = identified(&state, "Ana").await?;
    for name in ["", " ", "a", &"x".repeat(65)] {
        assert_eq!(
            call(
                http::application(state.clone()),
                "POST",
                "/api/servers",
                Some(&cookie),
                Some(ORIGIN),
                json!({"name":name})
            )
            .await?
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    Ok(())
}

#[tokio::test]
async fn creates_and_lists_persistent_servers() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    let created = server(&state, &cookie, "  Café   Rust  ").await?;
    assert_eq!(created.name, "Café Rust");
    assert_eq!(created.creator_id, session.id);
    assert_eq!(created.capacity, 5);
    let servers: Vec<Server> = decode(
        call(
            http::application(state.clone()),
            "GET",
            "/api/servers",
            Some(&cookie),
            None,
            Value::Null,
        )
        .await?,
    )
    .await?;
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].id, created.id);
    assert_eq!(
        call(
            http::application(state.clone()),
            "POST",
            "/api/servers",
            None,
            Some(ORIGIN),
            json!({"name":"Teste"})
        )
        .await?
        .status(),
        StatusCode::UNAUTHORIZED
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_joins_never_exceed_five_and_release_on_leave() -> TestResult {
    let state = setup().await?;
    let (_, cookie) = identified(&state, "Criador").await?;
    let room = server(&state, &cookie, "Concorrência").await?;
    let mut tasks = vec![];
    let mut receivers = vec![];
    let mut sessions = vec![];
    for index in 0..8 {
        let (session, _) = identified(&state, &format!("Pessoa {index}")).await?;
        let (connection, receiver) = connected(&state, &session).await;
        receivers.push(receiver);
        sessions.push(session.clone());
        let state = state.clone();
        let id = room.id.clone();
        tasks.push(tokio::spawn(async move {
            realtime::handle(
                &state,
                &session,
                &connection,
                ClientEvent::Join { server_id: id },
            )
            .await
        }));
    }
    let mut accepted = 0;
    let mut rejected = 0;
    for task in tasks {
        match task.await? {
            Ok(()) => accepted += 1,
            Err(error) => {
                assert_eq!(error.code, "server_full");
                rejected += 1;
            }
        }
    }
    assert_eq!((accepted, rejected), (5, 3));
    let mut hub = state.presence.lock().await;
    assert_eq!(hub.count(&room.id), 5);
    let member = sessions
        .iter()
        .find(|s| hub.require_member(&s.id, &room.id).is_ok())
        .ok_or("member")?;
    hub.leave(&member.id);
    assert_eq!(hub.count(&room.id), 4);
    let waiting = sessions
        .iter()
        .find(|s| hub.require_member(&s.id, &room.id).is_err() && s.id != member.id)
        .ok_or("waiting")?;
    assert!(hub.join(&waiting.id, &room.id).is_ok());
    assert_eq!(hub.count(&room.id), 5);
    Ok(())
}

#[tokio::test]
async fn reconnect_and_tab_takeover_do_not_duplicate_slots() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    let room = server(&state, &cookie, "Sala").await?;
    let (first, _rx1) = connected(&state, &session).await;
    {
        let mut hub = state.presence.lock().await;
        hub.join(&session.id, &room.id).map_err(|e| e.code)?;
        hub.voice(&session.id, true, false).map_err(|e| e.code)?;
        hub.disconnect(&session.id, &first);
        assert_eq!(hub.count(&room.id), 1);
    }
    let (second, _rx2) = connected(&state, &session).await;
    let mut hub = state.presence.lock().await;
    hub.disconnect(&session.id, &first);
    assert!(hub.is_current(&session.id, &second));
    assert_eq!(hub.count(&room.id), 1);
    assert!(!hub.snapshot(&room.id).participants[0].in_voice);
    hub.disconnect(&session.id, &second);
    hub.expire(Instant::now() + RECONNECT_GRACE + Duration::from_millis(1));
    assert_eq!(hub.count(&room.id), 0);
    Ok(())
}

#[tokio::test]
async fn session_may_join_only_one_server() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    let a = server(&state, &cookie, "Sala A").await?;
    let b = server(&state, &cookie, "Sala B").await?;
    let (_connection, _rx) = connected(&state, &session).await;
    let mut hub = state.presence.lock().await;
    hub.join(&session.id, &a.id).map_err(|e| e.code)?;
    assert_eq!(
        hub.join(&session.id, &b.id)
            .err()
            .ok_or("expected error")?
            .code,
        "already_in_server"
    );
    hub.leave(&session.id);
    hub.join(&session.id, &b.id).map_err(|e| e.code)?;
    assert_eq!(hub.count(&a.id), 0);
    assert_eq!(hub.count(&b.id), 1);
    Ok(())
}

#[tokio::test]
async fn authorized_messages_are_persisted_and_idempotent() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    let room = server(&state, &cookie, "Texto").await?;
    let (connection, _rx) = connected(&state, &session).await;
    let client_id = Uuid::new_v4().to_string();
    assert!(
        realtime::handle(
            &state,
            &session,
            &connection,
            ClientEvent::Message {
                client_id: client_id.clone(),
                content: "Oi".into()
            }
        )
        .await
        .is_err()
    );
    realtime::handle(
        &state,
        &session,
        &connection,
        ClientEvent::Join {
            server_id: room.id.clone(),
        },
    )
    .await
    .map_err(|e| e.code)?;
    for _ in 0..2 {
        realtime::handle(
            &state,
            &session,
            &connection,
            ClientEvent::Message {
                client_id: client_id.clone(),
                content: "Oi".into(),
            },
        )
        .await
        .map_err(|e| e.code)?;
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
        .fetch_one(&state.pool)
        .await?;
    assert_eq!(count, 1);
    assert!(
        messages::persist(&state, &session, &room.id, &client_id, "Diferente")
            .await
            .is_err()
    );
    state.presence.lock().await.leave(&session.id);
    assert!(
        realtime::handle(
            &state,
            &session,
            &connection,
            ClientEvent::Message {
                client_id: Uuid::new_v4().to_string(),
                content: "Fora".into()
            }
        )
        .await
        .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn history_is_paginated_and_isolated_and_payload_is_validated() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    let a = server(&state, &cookie, "Sala A").await?;
    let b = server(&state, &cookie, "Sala B").await?;
    let (_connection, _rx) = connected(&state, &session).await;
    state
        .presence
        .lock()
        .await
        .join(&session.id, &a.id)
        .map_err(|e| e.code)?;
    for content in ["", "   ", &"é".repeat(2001)] {
        assert!(
            messages::persist(
                &state,
                &session,
                &a.id,
                &Uuid::new_v4().to_string(),
                content
            )
            .await
            .is_err()
        );
    }
    for content in ["um", "dois", "três"] {
        messages::persist(
            &state,
            &session,
            &a.id,
            &Uuid::new_v4().to_string(),
            content,
        )
        .await
        .map_err(|e| e.code)?;
    }
    let page: Value = decode(
        call(
            http::application(state.clone()),
            "GET",
            &format!("/api/servers/{}/messages?limit=2", a.id),
            Some(&cookie),
            None,
            Value::Null,
        )
        .await?,
    )
    .await?;
    assert_eq!(page["messages"].as_array().ok_or("array")?.len(), 2);
    assert_eq!(page["messages"][0]["content"], "dois");
    let older: Value = decode(
        call(
            http::application(state.clone()),
            "GET",
            &format!(
                "/api/servers/{}/messages?limit=2&before={}",
                a.id, page["next_before"]
            ),
            Some(&cookie),
            None,
            Value::Null,
        )
        .await?,
    )
    .await?;
    assert_eq!(older["messages"][0]["content"], "um");
    assert!(older["next_before"].is_null());
    assert_eq!(
        call(
            http::application(state.clone()),
            "GET",
            &format!("/api/servers/{}/messages", b.id),
            Some(&cookie),
            None,
            Value::Null
        )
        .await?
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            http::application(state.clone()),
            "GET",
            &format!("/api/servers/{}/messages?limit=101", a.id),
            Some(&cookie),
            None,
            Value::Null
        )
        .await?
        .status(),
        StatusCode::BAD_REQUEST
    );
    Ok(())
}

#[tokio::test]
async fn signaling_requires_both_members_in_same_voice_room() -> TestResult {
    let state = setup().await?;
    let (a, cookie) = identified(&state, "Ana").await?;
    let (b, _) = identified(&state, "Bruno").await?;
    let (c, _) = identified(&state, "Carla").await?;
    let room = server(&state, &cookie, "Sala A").await?;
    let other = server(&state, &cookie, "Sala B").await?;
    let (ca, _rx1) = connected(&state, &a).await;
    let (_cb, _rx2) = connected(&state, &b).await;
    let (_cc, _rx3) = connected(&state, &c).await;
    let mut hub = state.presence.lock().await;
    hub.join(&a.id, &room.id).map_err(|e| e.code)?;
    hub.join(&b.id, &room.id).map_err(|e| e.code)?;
    hub.join(&c.id, &other.id).map_err(|e| e.code)?;
    assert!(hub.authorize_signal(&a.id, &b.id).is_err());
    for session in [&a, &b, &c] {
        hub.voice(&session.id, true, false).map_err(|e| e.code)?;
    }
    assert!(hub.authorize_signal(&a.id, &b.id).is_ok());
    assert!(hub.authorize_signal(&a.id, &c.id).is_err());
    assert!(hub.authorize_signal(&a.id, &a.id).is_err());
    hub.mute(&a.id, true).map_err(|e| e.code)?;
    assert!(
        hub.snapshot(&room.id)
            .participants
            .iter()
            .any(|p| p.id == a.id && p.muted)
    );
    hub.voice(&b.id, false, false).map_err(|e| e.code)?;
    assert!(hub.authorize_signal(&a.id, &b.id).is_err());
    drop(hub);
    let signal = Signal::Description {
        description: Description {
            r#type: DescriptionType::Offer,
            sdp: "v=0".into(),
        },
    };
    assert!(
        realtime::handle(&state, &a, &ca, ClientEvent::Signal { to: b.id, signal })
            .await
            .is_err()
    );
    Ok(())
}

#[test]
fn websocket_contract_rejects_invalid_versions_spoofing_and_shapes() {
    assert!(realtime::parse(r#"{"v":1,"type":"join","server_id":"test"}"#).is_ok());
    for value in [
        "no json",
        r#"{"v":2,"type":"leave"}"#,
        r#"{"v":1,"type":"message","content":"hi"}"#,
        r#"{"v":1,"type":"leave","session_id":"victim"}"#,
        r#"{"v":1,"type":"mute","muted":"yes"}"#,
        r#"{"v":1,"type":"signal","to":"x","signal":{"kind":"description","description":{"type":"rollback","sdp":"x"}}}"#,
    ] {
        assert!(realtime::parse(value).is_err(), "{value}");
    }
    assert!(realtime::parse(&" ".repeat(32769)).is_err());
    let mut window = Window::default();
    assert!(window.allow(2, Duration::from_secs(60)));
    assert!(window.allow(2, Duration::from_secs(60)));
    assert!(!window.allow(2, Duration::from_secs(60)));
}

#[tokio::test]
async fn expired_sessions_and_untrusted_origins_are_rejected() -> TestResult {
    let state = setup().await?;
    let (session, cookie) = identified(&state, "Ana").await?;
    assert_eq!(
        call(
            http::application(state.clone()),
            "POST",
            "/api/servers",
            Some(&cookie),
            Some("https://hostile.example"),
            json!({"name":"Sala"})
        )
        .await?
        .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE sessions SET expires_at = 0 WHERE id = ?")
        .bind(session.id)
        .execute(&state.pool)
        .await?;
    assert_eq!(
        call(
            http::application(state.clone()),
            "GET",
            "/api/session",
            Some(&cookie),
            None,
            Value::Null
        )
        .await?
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, "https://hostile.example".parse()?);
    assert!(discord_backend::identity::validate_origin(&state, &headers).is_err());
    Ok(())
}

#[test]
fn empty_presence_is_safe() {
    let mut hub = Hub::default();
    hub.leave("missing");
    hub.disconnect("missing", "missing");
    hub.expire(Instant::now());
    assert_eq!(hub.count("missing"), 0);
}

#[tokio::test]
async fn turn_configuration_uses_temporary_credentials_and_secure_cookie() -> TestResult {
    let mut state = setup().await?;
    state.secure_cookie = true;
    state.ice.turn_urls = vec!["turn:relay.example:3478".to_owned()];
    state.ice.turn_secret = Some("private-server-only-secret-for-tests".to_owned());
    let response = call(
        http::application(state.clone()),
        "POST",
        "/api/session",
        None,
        Some(ORIGIN),
        json!({"display_name":"Ana TURN"}),
    )
    .await?;
    let header = response.headers()[header::SET_COOKIE].to_str()?.to_owned();
    assert!(header.contains("; Secure"));
    let cookie = header.split(';').next().ok_or("cookie")?;
    let session: Session = decode(response).await?;
    let config: Value = decode(
        call(
            http::application(state.clone()),
            "GET",
            "/api/rtc-config",
            Some(cookie),
            None,
            Value::Null,
        )
        .await?,
    )
    .await?;
    assert_eq!(
        config["iceServers"][1]["urls"][0],
        "turn:relay.example:3478"
    );
    let username = config["iceServers"][1]["username"]
        .as_str()
        .ok_or("username")?;
    assert!(username.ends_with(&format!(":{}", session.id)));
    assert_eq!(
        config["iceServers"][1]["credential"]
            .as_str()
            .ok_or("credential")?
            .len(),
        28
    );
    assert!(config["expiresAt"].as_i64().ok_or("expiry")? > discord_backend::now_ms() + 3500000);
    assert!(!config.to_string().contains("private-server-only-secret"));
    Ok(())
}
