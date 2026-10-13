//! OpenGrid server library. `main.rs` is a thin CLI over this crate; tests
//! build the router directly with [`http::router`].

pub mod api;
pub mod auth;
pub mod automations;
pub mod backup;
pub mod cli;
pub mod config;
pub mod db;
pub mod email;
pub mod engine;
pub mod error;
pub mod events;
pub mod extract;
pub mod http;
pub mod ids;
pub mod mcp;
pub mod perm;
pub mod ratelimit;
pub mod state;
pub mod store;
pub mod tasks;
pub mod v1;
pub mod web;

use config::Config;
use state::AppState;

/// Run the server until SIGINT/SIGTERM.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    let bind = config.bind.clone();
    let state = AppState::open(config)?;
    tasks::spawn_all(&state);
    let (events, db) = (state.events.clone(), state.db.clone());
    let app = http::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("OpenGrid listening on http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        // Open event streams never end by themselves; without this the
        // server would wait for them until it is killed.
        events.begin_shutdown();
    })
    .await?;
    // Leave an empty WAL behind (see `Db::checkpoint`).
    if let Err(e) = db.checkpoint() {
        tracing::warn!(error = %e, "could not checkpoint the database on shutdown");
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
