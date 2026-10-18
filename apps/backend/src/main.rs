use std::error::Error;

use discord_backend::{AppState, config::Config, database, http, signaling::IceSettings};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let filter = match std::env::var("RUST_LOG") {
        Ok(value) => EnvFilter::try_new(value)?,
        Err(std::env::VarError::NotPresent) => EnvFilter::new("info,tower_http=debug"),
        Err(error) => return Err(error.into()),
    };
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .try_init()?;

    let config = Config::from_env()?;
    let pool = database::connect(&config.database_url).await?;
    tracing::info!("database connected and migrations applied");

    let listener = TcpListener::bind(config.bind_addr).await?;
    tracing::info!(address = %listener.local_addr()?, "HTTP server listening");
    let mut state = AppState::new(pool.clone(), config.cors_allowed_origins);
    state.secure_cookie = match std::env::var("COOKIE_SECURE").as_deref() {
        Ok("true") => true,
        Ok("false") | Err(std::env::VarError::NotPresent) => false,
        _ => return Err("COOKIE_SECURE must be true or false".into()),
    };
    let urls = |key: &str, default: &str| -> Vec<String> {
        std::env::var(key)
            .unwrap_or_else(|_| default.to_owned())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    };
    state.ice = IceSettings {
        stun_urls: urls("STUN_URLS", "stun:stun.l.google.com:19302"),
        turn_urls: urls("TURN_URLS", ""),
        turn_secret: std::env::var("TURN_SHARED_SECRET")
            .ok()
            .filter(|s| !s.is_empty()),
    };
    if state.ice.turn_urls.is_empty() != state.ice.turn_secret.is_none() {
        return Err("TURN_URLS and TURN_SHARED_SECRET must be configured together".into());
    }
    if !state
        .ice
        .stun_urls
        .iter()
        .all(|s| s.starts_with("stun:") || s.starts_with("stuns:"))
        || !state
            .ice
            .turn_urls
            .iter()
            .all(|s| s.starts_with("turn:") || s.starts_with("turns:"))
    {
        return Err("invalid ICE URL scheme".into());
    }
    let cleanup_state = state.clone();
    let cleanup = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            cleanup_state
                .presence
                .lock()
                .await
                .expire(std::time::Instant::now());
        }
    });
    let result = axum::serve(listener, http::application(state.clone()))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            state.presence.lock().await.close_all();
        })
        .await;

    cleanup.abort();
    pool.close().await;
    result?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "could not listen for Ctrl+C");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "could not listen for SIGTERM"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
    tracing::info!("shutdown requested");
}
