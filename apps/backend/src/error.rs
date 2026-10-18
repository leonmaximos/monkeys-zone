use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: &'static str,
}

impl ApiError {
    pub fn bad(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message,
        }
    }
    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "Identifique-se para continuar.",
        }
    }
    pub fn forbidden() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "Operação não autorizada nesta sala.",
        }
    }
    pub fn conflict(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message,
        }
    }
    pub fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: "Servidor não encontrado.",
        }
    }
    pub fn limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "Muitas operações. Aguarde alguns segundos.",
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        // Não registrar SQL, parâmetros ou credenciais em erros de entrada.
        tracing::error!(kind = ?std::mem::discriminant(&error), "database operation failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: "Não foi possível concluir a operação.",
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

pub fn normalized_name(value: &str, max: usize) -> Result<String, ApiError> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(2..=max).contains(&normalized.chars().count()) || normalized.chars().any(char::is_control)
    {
        return Err(ApiError::bad(
            "invalid_name",
            "Informe um nome válido dentro do limite de caracteres.",
        ));
    }
    Ok(normalized)
}
