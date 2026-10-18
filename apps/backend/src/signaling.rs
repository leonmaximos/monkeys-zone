use crate::{AppState, error::ApiError, identity, now_ms};
use axum::{Json, extract::State, http::HeaderMap};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

#[derive(Clone)]
pub struct IceSettings {
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
}

impl Default for IceSettings {
    fn default() -> Self {
        Self {
            stun_urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            turn_urls: vec![],
            turn_secret: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceConfig {
    pub ice_servers: Vec<IceServer>,
    pub expires_at: i64,
}

pub async fn config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<IceConfig>, ApiError> {
    let session = identity::authenticate(&state, &headers).await?;
    let expires_at = now_ms() + 60 * 60 * 1000;
    let mut ice_servers = vec![];
    if !state.ice.stun_urls.is_empty() {
        ice_servers.push(IceServer {
            urls: state.ice.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }
    if let Some(secret) = &state.ice.turn_secret {
        let username = format!("{}:{}", expires_at / 1000, session.id);
        let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
            .map_err(|_| ApiError::bad("turn_configuration", "Configuração TURN inválida."))?;
        mac.update(username.as_bytes());
        ice_servers.push(IceServer {
            urls: state.ice.turn_urls.clone(),
            username: Some(username),
            credential: Some(STANDARD.encode(mac.finalize().into_bytes())),
        });
    }
    Ok(Json(IceConfig {
        ice_servers,
        expires_at,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Signal {
    Description { description: Description },
    Candidate { candidate: Candidate },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Description {
    pub r#type: DescriptionType,
    pub sdp: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DescriptionType {
    Offer,
    Answer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
    pub username_fragment: Option<String>,
}

impl Signal {
    pub fn validate(&self) -> Result<(), ApiError> {
        let valid = match self {
            Self::Description { description } => {
                !description.sdp.is_empty() && description.sdp.len() <= 24000
            }
            Self::Candidate { candidate } => {
                candidate.candidate.len() <= 4096
                    && candidate.sdp_mid.as_ref().is_none_or(|s| s.len() <= 256)
                    && candidate
                        .username_fragment
                        .as_ref()
                        .is_none_or(|s| s.len() <= 256)
            }
        };
        if valid {
            Ok(())
        } else {
            Err(ApiError::bad(
                "invalid_signal",
                "Sinalização inválida ou muito grande.",
            ))
        }
    }
}
