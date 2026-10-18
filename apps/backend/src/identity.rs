use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, normalized_name},
    now_ms,
};

pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct Session {
    pub id: String,
    pub display_name: String,
    pub expires_at: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identify {
    pub display_name: String,
}

pub fn validate_origin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    match headers.get(header::ORIGIN) {
        Some(origin) if state.origins.contains(origin) => Ok(()),
        _ => Err(ApiError::forbidden()),
    }
}

fn credential(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("comm_session="))
        .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()))
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Session, ApiError> {
    let token = credential(headers).ok_or_else(ApiError::unauthorized)?;
    sqlx::query_as::<_, Session>(
        "SELECT id, display_name, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
    .bind(token_hash(token))
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(ApiError::unauthorized)
}

pub async fn current(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Session>, ApiError> {
    Ok(Json(authenticate(&state, &headers).await?))
}

pub async fn identify(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<Identify>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, ApiError> {
    validate_origin(&state, &headers)?;
    let Json(input) = payload
        .map_err(|_| ApiError::bad("invalid_json", "Envie um objeto JSON com display_name."))?;
    let name = normalized_name(&input.display_name, 32)?;
    match authenticate(&state, &headers).await {
        Ok(session) => {
            if session.display_name != name {
                return Err(ApiError::conflict(
                    "session_exists",
                    "Esta sessão já possui um nome. Use outro perfil do navegador para outra identidade.",
                ));
            }
            return Ok(Json(session).into_response());
        }
        Err(error) if error.status == axum::http::StatusCode::UNAUTHORIZED => {}
        Err(error) => return Err(error),
    }
    // Contenção global simples para criação anônima; sem confiança em X-Forwarded-For.
    if !state.presence.lock().await.allow_identity() {
        return Err(ApiError::limited());
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let session = Session {
        id: Uuid::new_v4().to_string(),
        display_name: name,
        expires_at: now_ms() + SESSION_TTL_MS,
    };
    sqlx::query("INSERT INTO sessions (id, token_hash, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&session.id).bind(token_hash(&token)).bind(&session.display_name).bind(now_ms()).bind(session.expires_at)
        .execute(&state.pool).await?;
    let mut response = Json(session).into_response();
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    let cookie = HeaderValue::from_str(&format!(
        "comm_session={token}; HttpOnly; SameSite=Lax; Path=/api{secure}"
    ))
    .map_err(|_| ApiError::bad("cookie", "Falha ao criar sessão."))?;
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}
