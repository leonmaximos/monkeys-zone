pub mod config;
pub mod database;
pub mod error;
pub mod health;
pub mod http;
pub mod identity;
pub mod messages;
pub mod presence;
pub mod realtime;
pub mod servers;
pub mod signaling;

use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub presence: Arc<Mutex<presence::Hub>>,
    pub origins: Vec<axum::http::HeaderValue>,
    pub secure_cookie: bool,
    pub ice: signaling::IceSettings,
}

impl AppState {
    pub fn new(pool: SqlitePool, origins: Vec<axum::http::HeaderValue>) -> Self {
        Self {
            pool,
            origins,
            presence: Arc::new(Mutex::new(presence::Hub::default())),
            secure_cookie: false,
            ice: signaling::IceSettings::default(),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}
