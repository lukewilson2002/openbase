//! Admin backup endpoints (instance administrators, session auth only):
//!
//! - `GET /api/admin/backups` lists archives and pre-migration snapshots.
//! - `POST /api/admin/backups` writes a manual backup now.
//! - `GET /api/admin/backups/{name}` downloads one. `name` must match the
//!   strict backup-name pattern, which is the path-traversal guard.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use og_core::api::auth::BackupInfo;
use tokio::sync::Mutex;

use crate::auth::Actor;
use crate::backup;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// One backup at a time: a second click while one is running waits rather
/// than doubling disk and CPU use.
static CREATE_LOCK: Mutex<()> = Mutex::const_new(());

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/backups", get(list).post(create))
        .route("/api/admin/backups/{name}", get(download))
}

async fn list(State(state): State<AppState>, actor: Actor) -> AppResult<Json<Vec<BackupInfo>>> {
    actor.require_admin()?;
    let dir = state.config.backups_dir();
    let items = tokio::task::spawn_blocking(move || backup::list(&dir))
        .await
        .map_err(AppError::internal)??;
    Ok(Json(items))
}

async fn create(State(state): State<AppState>, actor: Actor) -> AppResult<Json<BackupInfo>> {
    actor.require_admin()?;
    let _guard = CREATE_LOCK.lock().await;
    let st = state.clone();
    let path = tokio::task::spawn_blocking(move || backup::create(&st, None))
        .await
        .map_err(AppError::internal)??;
    tracing::info!(path = %path.display(), by = %actor.email, "backup created");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dir = state.config.backups_dir();
    let info = tokio::task::spawn_blocking(move || backup::list(&dir))
        .await
        .map_err(AppError::internal)??
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| AppError::internal("new backup not found after writing it"))?;
    Ok(Json(info))
}

async fn download(
    State(state): State<AppState>,
    actor: Actor,
    Path(name): Path<String>,
) -> AppResult<Response> {
    actor.require_admin()?;
    if !backup::is_backup_name(&name) {
        return Err(AppError::not_found("backup"));
    }
    let path = state.config.backups_dir().join(&name);
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::not_found("backup"));
        }
        Err(e) => return Err(AppError::internal(e)),
    };
    let meta = file.metadata().await.map_err(AppError::internal)?;
    if !meta.is_file() {
        return Err(AppError::not_found("backup"));
    }
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .map_err(AppError::internal)?;
    let mut res = Response::new(super::attachments::file_body(file));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    h.insert(header::CONTENT_DISPOSITION, disposition);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}
