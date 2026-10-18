use std::{str::FromStr, time::Duration};

use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use thiserror::Error;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("could not create the SQLite directory: {0}")]
    Directory(#[from] std::io::Error),
    #[error("could not configure or connect to SQLite: {0}")]
    Sqlite(#[from] sqlx::Error),
    #[error("could not apply database migrations: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
}

pub async fn connect(database_url: &str) -> Result<SqlitePool, DatabaseError> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    if let Some(parent) = options
        .get_filename()
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await?;

    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initializes_database_and_can_rerun_migrations() -> Result<(), DatabaseError> {
        let pool = connect("sqlite::memory:").await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await?;
        assert_eq!(usize::try_from(count), Ok(MIGRATOR.iter().count()));
        MIGRATOR.run(&pool).await?;

        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await?;
        assert_eq!(foreign_keys, 1);
        pool.close().await;
        Ok(())
    }
}
