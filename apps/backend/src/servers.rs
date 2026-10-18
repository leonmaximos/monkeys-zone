use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, normalized_name},
    identity, now_ms,
};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub creator_id: String,
    pub created_at: i64,
    #[sqlx(skip)]
    pub participants: usize,
    #[sqlx(skip)]
    pub capacity: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateServer {
    pub name: String,
}

pub async fn all(state: &AppState) -> Result<Vec<Server>, ApiError> {
    let mut servers = sqlx::query_as::<_, Server>(
        "SELECT id, name, creator_id, created_at FROM servers ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    let hub = state.presence.lock().await;
    for server in &mut servers {
        server.participants = hub.count(&server.id);
        server.capacity = 5;
    }
    Ok(servers)
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Server>>, ApiError> {
    identity::authenticate(&state, &headers).await?;
    Ok(Json(all(&state).await?))
}

pub async fn find(state: &AppState, id: &str) -> Result<Server, ApiError> {
    sqlx::query_as::<_, Server>("SELECT id, name, creator_id, created_at FROM servers WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .map(|mut s| {
            s.capacity = 5;
            s
        })
        .ok_or_else(ApiError::not_found)
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateServer>, axum::extract::rejection::JsonRejection>,
) -> Result<(axum::http::StatusCode, Json<Server>), ApiError> {
    identity::validate_origin(&state, &headers)?;
    let session = identity::authenticate(&state, &headers).await?;
    let Json(input) =
        payload.map_err(|_| ApiError::bad("invalid_json", "Envie um objeto JSON com name."))?;
    let name = normalized_name(&input.name, 64)?;
    if !state.presence.lock().await.allow_create(&session.id) {
        return Err(ApiError::limited());
    }
    let server = Server {
        id: Uuid::new_v4().to_string(),
        name,
        creator_id: session.id,
        created_at: now_ms(),
        participants: 0,
        capacity: 5,
    };
    sqlx::query("INSERT INTO servers (id, name, creator_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(&server.id)
        .bind(&server.name)
        .bind(&server.creator_id)
        .bind(server.created_at)
        .execute(&state.pool)
        .await?;
    state
        .presence
        .lock()
        .await
        .broadcast(crate::realtime::ServerEvent::ServersChanged);
    Ok((axum::http::StatusCode::CREATED, Json(server)))
}
