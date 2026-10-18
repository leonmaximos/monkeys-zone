use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
}

/// Liveness: o processo HTTP está respondendo; não consulta dependências.
pub async fn get_health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}
