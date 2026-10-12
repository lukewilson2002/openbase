//! Shared application state handed to every handler.

use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;
use crate::error::AppResult;
use crate::events::EventBus;
use crate::ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub events: EventBus,
    pub limiter: RateLimiter,
}

impl AppState {
    /// Open the data directory (creating it), migrate the database and build state.
    pub fn open(config: Config) -> AppResult<AppState> {
        std::fs::create_dir_all(&config.data_dir).map_err(crate::error::AppError::internal)?;
        std::fs::create_dir_all(config.attachments_dir())
            .map_err(crate::error::AppError::internal)?;
        std::fs::create_dir_all(config.backups_dir()).map_err(crate::error::AppError::internal)?;
        let db = Db::open(&config.db_path())?;
        Ok(AppState {
            db,
            config: Arc::new(config),
            events: EventBus::default(),
            limiter: RateLimiter::default(),
        })
    }
}
