use std::{env, net::SocketAddr};

use axum::http::{HeaderValue, Uri};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub cors_allowed_origins: Vec<HeaderValue>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("environment variable {0} is not valid Unicode")]
    InvalidEnvironment(&'static str),
    #[error("BACKEND_ADDR must be an IP address and port: {0}")]
    InvalidAddress(#[from] std::net::AddrParseError),
    #[error("DATABASE_URL must not be empty")]
    EmptyDatabaseUrl,
    #[error("CORS_ALLOWED_ORIGINS must contain at least one explicit HTTP(S) origin")]
    EmptyOrigins,
    #[error("invalid CORS origin: {0}; use scheme://host[:port] without paths or wildcards")]
    InvalidOrigin(String),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::parse(
            &read_env("BACKEND_ADDR", "127.0.0.1:3000")?,
            &read_env("DATABASE_URL", "sqlite://data/discord.db")?,
            &read_env(
                "CORS_ALLOWED_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173",
            )?,
        )
    }

    fn parse(address: &str, database_url: &str, origins: &str) -> Result<Self, ConfigError> {
        if database_url.trim().is_empty() {
            return Err(ConfigError::EmptyDatabaseUrl);
        }
        if origins.trim().is_empty() {
            return Err(ConfigError::EmptyOrigins);
        }

        let cors_allowed_origins = origins
            .split(',')
            .map(|origin| parse_origin(origin.trim()))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            bind_addr: address.parse()?,
            database_url: database_url.to_owned(),
            cors_allowed_origins,
        })
    }
}

fn read_env(key: &'static str, default: &str) -> Result<String, ConfigError> {
    match env::var(key) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError::InvalidEnvironment(key)),
    }
}

fn parse_origin(origin: &str) -> Result<HeaderValue, ConfigError> {
    let invalid = || ConfigError::InvalidOrigin(origin.to_owned());
    let uri = origin.parse::<Uri>().map_err(|_| invalid())?;
    let scheme = uri.scheme_str().ok_or_else(invalid)?;
    let authority = uri.authority().ok_or_else(invalid)?;

    if !matches!(scheme, "http" | "https")
        || uri.host().is_none_or(str::is_empty)
        || authority.as_str().contains(['@', '*'])
        || origin != format!("{scheme}://{authority}")
    {
        return Err(invalid());
    }

    HeaderValue::from_str(origin).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_explicit_origins() -> Result<(), ConfigError> {
        let config = Config::parse(
            "127.0.0.1:3000",
            "sqlite::memory:",
            "http://localhost:5173, https://example.com",
        )?;
        assert_eq!(config.cors_allowed_origins.len(), 2);
        Ok(())
    }

    #[test]
    fn rejects_invalid_configuration() {
        for origin in [
            "",
            "*",
            "null",
            "localhost:5173",
            "http://*.example.com",
            "https://example.com/",
            "https://example.com/path",
            "https://example.com?query=1",
            "https://user@example.com",
            "ftp://example.com",
            "https://example.com,",
        ] {
            assert!(
                Config::parse("127.0.0.1:3000", "sqlite::memory:", origin).is_err(),
                "{origin}"
            );
        }
        assert!(Config::parse("invalid", "sqlite::memory:", "http://localhost:5173").is_err());
        assert!(Config::parse("127.0.0.1:3000", " ", "http://localhost:5173").is_err());
    }
}
