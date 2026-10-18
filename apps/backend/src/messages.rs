use crate::{
    AppState,
    error::ApiError,
    identity::{self, Session},
    now_ms,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, PartialEq)]
pub struct Message {
    pub id: i64,
    pub client_id: String,
    pub server_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub created_at: i64,
}

pub async fn persist(
    state: &AppState,
    session: &Session,
    server_id: &str,
    client_id: &str,
    content: &str,
) -> Result<Message, ApiError> {
    Uuid::parse_str(client_id)
        .map_err(|_| ApiError::bad("invalid_message_id", "client_id deve ser UUID."))?;
    let content = content.trim();
    if content.is_empty() || content.chars().count() > 2000 || content.contains('\0') {
        return Err(ApiError::bad(
            "invalid_message",
            "A mensagem deve conter entre 1 e 2.000 caracteres.",
        ));
    }
    sqlx::query("INSERT INTO messages (client_id, server_id, sender_id, sender_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sender_id, client_id) DO NOTHING")
        .bind(client_id).bind(server_id).bind(&session.id).bind(&session.display_name).bind(content).bind(now_ms()).execute(&state.pool).await?;
    let message = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE sender_id = ? AND client_id = ?",
    )
    .bind(&session.id)
    .bind(client_id)
    .fetch_one(&state.pool)
    .await?;
    if message.server_id != server_id || message.content != content {
        return Err(ApiError::conflict(
            "message_id_conflict",
            "Este identificador já foi usado em outra mensagem.",
        ));
    }
    Ok(message)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    pub before: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Serialize)]
pub struct History {
    pub messages: Vec<Message>,
    pub next_before: Option<i64>,
}

pub async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    query: Result<Query<HistoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<History>, ApiError> {
    let Query(query) = query
        .map_err(|_| ApiError::bad("invalid_pagination", "Parâmetros de paginação inválidos."))?;
    let session = identity::authenticate(&state, &headers).await?;
    let hub = state.presence.lock().await;
    hub.require_member(&session.id, &server_id)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) || query.before.is_some_and(|b| b <= 0) {
        return Err(ApiError::bad(
            "invalid_pagination",
            "Use limit entre 1 e 100 e cursor positivo.",
        ));
    }
    let mut messages = sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE server_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
        .bind(&server_id).bind(query.before).bind(query.before).bind(limit + 1)
        .fetch_all(&state.pool).await?;
    let more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    let next_before = if more {
        messages.last().map(|m| m.id)
    } else {
        None
    };
    messages.reverse();
    Ok(Json(History {
        messages,
        next_before,
    }))
}
