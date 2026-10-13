//! Shared application state handed to every handler.

use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;
use crate::email::{EmailService, Mailer, MailerFactory};
use crate::engine::query::QueryCache;
use crate::error::AppResult;
use crate::events::EventBus;
use crate::ratelimit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub events: EventBus,
    pub limiter: RateLimiter,
    /// Outgoing email: the [`EmailService`] as a [`Mailer`] (SMTP, or a no-op logger when SMTP
    /// is not configured; it follows the settings on the Admin -> Email page at once).
    pub mailer: Arc<dyn Mailer>,
    /// The same service, for its settings (is email on, what is configured, apply a change).
    pub email: Arc<EmailService>,
    /// Cached view-query results (ordered ids + group headers), invalidated
    /// by the per-base data versions of `events.versions()`.
    pub query_cache: Arc<QueryCache>,
    /// Snapshots behind the `offset` of the Airtable-compatible list endpoint.
    pub v1_cursors: Arc<crate::v1::cursor::Cursors>,
    /// The fully assembled router, set once by [`crate::http::router`]. The MCP server runs
    /// `api_request` calls through it, so an agent's request meets exactly the middleware,
    /// permission checks and side effects of a browser's.
    pub app_router: Arc<std::sync::OnceLock<axum::Router>>,
}

impl AppState {
    /// Open the data directory (creating it), migrate the database and build state.
    pub fn open(config: Config) -> AppResult<AppState> {
        Self::open_with_mail(config, crate::email::smtp_factory())
    }

    /// [`AppState::open`] with another way to build mail transports (tests install a capturing
    /// mailer).
    pub fn open_with_mail(config: Config, mail: MailerFactory) -> AppResult<AppState> {
        std::fs::create_dir_all(&config.data_dir).map_err(crate::error::AppError::internal)?;
        std::fs::create_dir_all(config.attachments_dir())
            .map_err(crate::error::AppError::internal)?;
        std::fs::create_dir_all(config.backups_dir()).map_err(crate::error::AppError::internal)?;
        let db = Db::open(&config.db_path())?;
        let stored = db.write_sync(|tx| crate::store::email_settings::load(tx))?;
        let email = EmailService::with_factory(&config, &stored, mail)?;
        let mailer: Arc<dyn Mailer> = email.clone();
        Ok(AppState {
            db,
            config: Arc::new(config),
            events: EventBus::default(),
            limiter: RateLimiter::default(),
            mailer,
            email,
            query_cache: Arc::new(QueryCache::new()),
            v1_cursors: Arc::default(),
            app_router: Arc::default(),
        })
    }
}
