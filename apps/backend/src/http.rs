use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{Method, header::CONTENT_TYPE},
    routing::get,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::{AppState, health, identity, messages, realtime, servers, signaling};

pub fn application(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(state.origins.clone()))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([CONTENT_TYPE])
        .allow_credentials(true);
    Router::new()
        .route("/health", get(health::get_health))
        .route(
            "/api/session",
            get(identity::current).post(identity::identify),
        )
        .route("/api/servers", get(servers::list).post(servers::create))
        .route("/api/servers/{id}/messages", get(messages::history))
        .route("/api/rtc-config", get(signaling::config))
        .route("/api/ws", get(realtime::upgrade))
        .layer(DefaultBodyLimit::max(16384))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
