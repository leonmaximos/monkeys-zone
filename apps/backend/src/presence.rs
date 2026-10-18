use crate::{error::ApiError, identity::Session, realtime::ServerEvent};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const RECONNECT_GRACE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
pub struct Participant {
    pub id: String,
    pub display_name: String,
    pub connected: bool,
    pub in_voice: bool,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Room {
    pub server_id: String,
    pub participants: Vec<Participant>,
}

struct Slot {
    session: Session,
    connection_id: String,
    sender: mpsc::Sender<ServerEvent>,
    room: Option<String>,
    disconnected: Option<Instant>,
    in_voice: bool,
    muted: bool,
    overflowed: bool,
}

pub struct Window {
    start: Instant,
    count: u32,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            start: Instant::now(),
            count: 0,
        }
    }
}

impl Window {
    pub fn allow(&mut self, maximum: u32, duration: Duration) -> bool {
        if self.start.elapsed() >= duration {
            self.start = Instant::now();
            self.count = 0;
        }
        self.count += 1;
        self.count <= maximum
    }
}

#[derive(Default)]
pub struct Hub {
    slots: BTreeMap<String, Slot>,
    create_limits: HashMap<String, Window>,
    connection_limits: HashMap<String, Window>,
    message_limits: HashMap<String, Window>,
    identity_limit: Window,
}

impl Hub {
    pub fn allow_connection(&mut self, session: &str) -> bool {
        self.connection_limits
            .retain(|_, window| window.start.elapsed() < Duration::from_secs(60));
        (self.slots.len() < 1024 || self.slots.contains_key(session))
            && self
                .connection_limits
                .entry(session.to_owned())
                .or_default()
                .allow(20, Duration::from_secs(60))
    }
    pub fn allow_message(&mut self, session: &str) -> bool {
        self.message_limits
            .retain(|_, window| window.start.elapsed() < Duration::from_secs(10));
        self.message_limits
            .entry(session.to_owned())
            .or_default()
            .allow(10, Duration::from_secs(10))
    }
    pub fn allow_identity(&mut self) -> bool {
        self.identity_limit.allow(120, Duration::from_secs(60))
    }
    pub fn allow_create(&mut self, session: &str) -> bool {
        // Limpeza de janelas antigas evita crescimento indefinido sem atividade.
        self.create_limits
            .retain(|_, window| window.start.elapsed() < Duration::from_secs(60));
        self.create_limits
            .entry(session.to_owned())
            .or_default()
            .allow(5, Duration::from_secs(60))
    }

    pub fn connect(&mut self, session: Session, sender: mpsc::Sender<ServerEvent>) -> String {
        self.expire(Instant::now());
        let id = session.id.clone();
        let connection_id = Uuid::new_v4().to_string();
        let room = self.slots.get(&id).and_then(|slot| slot.room.clone());
        if let Some(previous) = self.slots.get(&id) {
            let _ = previous.sender.try_send(ServerEvent::Replaced);
        }
        self.slots.insert(
            id.clone(),
            Slot {
                session,
                sender,
                connection_id: connection_id.clone(),
                room: room.clone(),
                disconnected: None,
                in_voice: false,
                muted: false,
                overflowed: false,
            },
        );
        if let Some(room) = room {
            self.publish_room(&room);
        }
        self.send(
            &id,
            ServerEvent::Welcome {
                session_id: id.clone(),
                room: self.room_for(&id),
                grace_seconds: RECONNECT_GRACE.as_secs(),
            },
        );
        connection_id
    }

    pub fn is_current(&self, session: &str, connection: &str) -> bool {
        self.slots.get(session).is_some_and(|slot| {
            slot.connection_id == connection && slot.disconnected.is_none() && !slot.overflowed
        })
    }

    pub fn room_for(&self, session: &str) -> Option<Room> {
        self.slots
            .get(session)
            .and_then(|slot| slot.room.as_deref())
            .map(|room| self.snapshot(room))
    }

    pub fn snapshot(&self, server_id: &str) -> Room {
        Room {
            server_id: server_id.to_owned(),
            participants: self
                .slots
                .values()
                .filter(|slot| slot.room.as_deref() == Some(server_id))
                .map(|slot| Participant {
                    id: slot.session.id.clone(),
                    display_name: slot.session.display_name.clone(),
                    connected: slot.disconnected.is_none() && !slot.overflowed,
                    in_voice: slot.in_voice,
                    muted: slot.muted,
                })
                .collect(),
        }
    }

    pub fn count(&self, server: &str) -> usize {
        self.slots
            .values()
            .filter(|slot| slot.room.as_deref() == Some(server))
            .count()
    }

    pub fn require_member(&self, session: &str, server: &str) -> Result<(), ApiError> {
        if self.slots.get(session).is_some_and(|slot| {
            slot.room.as_deref() == Some(server) && slot.disconnected.is_none() && !slot.overflowed
        }) {
            Ok(())
        } else {
            Err(ApiError::forbidden())
        }
    }

    pub fn join(&mut self, session: &str, server: &str) -> Result<(), ApiError> {
        self.expire(Instant::now());
        let slot = self.slots.get(session).ok_or_else(ApiError::unauthorized)?;
        if slot
            .room
            .as_deref()
            .is_some_and(|current| current != server)
        {
            return Err(ApiError::conflict(
                "already_in_server",
                "Saia do servidor atual antes de entrar em outro.",
            ));
        }
        let already = slot.room.as_deref() == Some(server);
        if !already && self.count(server) >= 5 {
            return Err(ApiError::conflict(
                "server_full",
                "Este servidor está lotado (5 participantes).",
            ));
        }
        if let Some(slot) = self.slots.get_mut(session) {
            slot.room = Some(server.to_owned());
        }
        self.send(
            session,
            ServerEvent::Joined {
                room: self.snapshot(server),
            },
        );
        if !already {
            self.notice(session, server, "joined");
            self.publish_room(server);
            self.broadcast(ServerEvent::ServersChanged);
        }
        Ok(())
    }

    pub fn leave(&mut self, session: &str) {
        let room = self.slots.get(session).and_then(|slot| slot.room.clone());
        if let Some(room) = room {
            self.notice(session, &room, "left");
            if let Some(slot) = self.slots.get_mut(session) {
                slot.room = None;
                slot.in_voice = false;
                slot.muted = false;
            }
            self.send(session, ServerEvent::Left);
            self.publish_room(&room);
            self.broadcast(ServerEvent::ServersChanged);
        } else {
            self.send(session, ServerEvent::Left);
        }
    }

    pub fn voice(&mut self, session: &str, join: bool, muted: bool) -> Result<(), ApiError> {
        let room = self
            .room_for(session)
            .ok_or_else(ApiError::forbidden)?
            .server_id;
        self.require_member(session, &room)?;
        if let Some(slot) = self.slots.get_mut(session) {
            slot.in_voice = join;
            slot.muted = join && muted;
        }
        self.publish_room(&room);
        Ok(())
    }

    pub fn mute(&mut self, session: &str, muted: bool) -> Result<(), ApiError> {
        if !self.slots.get(session).is_some_and(|slot| slot.in_voice) {
            return Err(ApiError::forbidden());
        }
        self.voice(session, true, muted)
    }

    pub fn authorize_signal(&self, from: &str, to: &str) -> Result<(), ApiError> {
        let source = self.slots.get(from).ok_or_else(ApiError::forbidden)?;
        let target = self.slots.get(to).ok_or_else(ApiError::forbidden)?;
        if from == to
            || !source.in_voice
            || !target.in_voice
            || source.room.is_none()
            || source.room != target.room
            || target.disconnected.is_some()
            || target.overflowed
        {
            return Err(ApiError::forbidden());
        }
        Ok(())
    }

    pub fn disconnect(&mut self, session: &str, connection: &str) {
        let Some(slot) = self
            .slots
            .get_mut(session)
            .filter(|s| s.connection_id == connection)
        else {
            return;
        };
        if slot.disconnected.is_some() {
            return;
        }
        slot.disconnected = Some(Instant::now());
        slot.in_voice = false;
        slot.muted = false;
        if let Some(room) = slot.room.clone() {
            self.notice(session, &room, "disconnected");
            self.publish_room(&room);
        }
    }

    pub fn expire(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .slots
            .iter()
            .filter(|(_, slot)| {
                slot.disconnected
                    .is_some_and(|at| now.saturating_duration_since(at) >= RECONNECT_GRACE)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.leave(&id);
            self.slots.remove(&id);
        }
    }

    fn notice(&mut self, session: &str, server: &str, action: &'static str) {
        if let Some(slot) = self.slots.get(session) {
            self.room_event(
                server,
                ServerEvent::Notice {
                    server_id: server.to_owned(),
                    display_name: slot.session.display_name.clone(),
                    action,
                },
            );
        }
    }

    pub fn send(&mut self, session: &str, event: ServerEvent) {
        if let Some(slot) = self
            .slots
            .get_mut(session)
            .filter(|s| s.disconnected.is_none())
            && slot.sender.try_send(event).is_err()
        {
            slot.overflowed = true;
        }
    }

    pub fn room_event(&mut self, server: &str, event: ServerEvent) {
        let ids: Vec<_> = self
            .slots
            .iter()
            .filter(|(_, s)| s.room.as_deref() == Some(server))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.send(&id, event.clone());
        }
    }
    fn publish_room(&mut self, server: &str) {
        self.room_event(
            server,
            ServerEvent::Presence {
                room: self.snapshot(server),
            },
        );
    }
    pub fn broadcast(&mut self, event: ServerEvent) {
        let ids: Vec<_> = self.slots.keys().cloned().collect();
        for id in ids {
            self.send(&id, event.clone());
        }
    }

    pub fn close_all(&mut self) {
        self.broadcast(ServerEvent::Shutdown);
    }
}
