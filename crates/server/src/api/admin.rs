//! `admin` API (instance administrators, session only): users, reset links,
//! the audit log and instance stats. Backups live in `api::backups` (ops).

use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use og_core::api::auth::{
    AdminCreateUser, AdminCreatedUser, AdminUpdateUser, AdminUser, AuditPage, InstanceStats,
    ResetLink,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;

use crate::auth::{Actor, ClientInfo, password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::users;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users", get(list_users).post(create_user))
        .route("/api/admin/users/{id}", patch(update_user))
        .route("/api/admin/users/{id}/reset-link", post(reset_link))
        .route("/api/admin/audit", get(audit_log))
        .route("/api/admin/stats", get(stats))
}

async fn list_users(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<Vec<AdminUser>>> {
    actor.require_admin()?;
    Ok(Json(state.db.read(users::list_admin).await?))
}

fn issue_reset_link(conn: &Connection, public_url: &str, user_id: &str) -> AppResult<ResetLink> {
    let (token, expires_at) = users::create_reset_token(conn, user_id, users::ADMIN_RESET_TTL_MS)?;
    Ok(ResetLink {
        url: users::reset_url(public_url, &token),
        expires_at,
    })
}

async fn create_user(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Json(req): Json<AdminCreateUser>,
) -> AppResult<(StatusCode, Json<AdminCreatedUser>)> {
    actor.require_admin()?;
    let email = users::normalize_email(&req.email)?;
    let name = users::validate_name(&req.name)?;
    let hash = match req.password {
        Some(pw) => {
            password::validate_new_password(&pw)?;
            Some(password::hash_async(pw).await?)
        }
        None => None,
    };
    let public_url = state.config.public_url.clone();
    let created = state
        .db
        .write(move |tx| {
            let id = users::create(
                tx,
                &email,
                &name,
                hash.as_deref().unwrap_or(users::UNUSABLE_PASSWORD_HASH),
                req.is_admin,
            )?;
            let reset_link = match hash {
                Some(_) => None,
                None => Some(issue_reset_link(tx, &public_url, &id)?),
            };
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::ADMIN_USER_CREATE,
                Some(&id),
                Some(json!({ "email": email, "is_admin": req.is_admin })),
                Some(&client.ip),
            )?;
            Ok(AdminCreatedUser {
                user: users::require(tx, &id)?.to_admin(),
                reset_link,
            })
        })
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn update_user(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    Json(req): Json<AdminUpdateUser>,
) -> AppResult<Json<AdminUser>> {
    actor.require_admin()?;
    let user = state
        .db
        .write(move |tx| {
            let (user, changes) = users::admin_update(tx, &actor.user_id, &id, &req)?;
            if changes.as_object().is_some_and(|m| !m.is_empty()) {
                audit::record(
                    tx,
                    Some(&actor.user_id),
                    actions::ADMIN_USER_UPDATE,
                    Some(&id),
                    Some(changes),
                    Some(&client.ip),
                )?;
            }
            Ok(user)
        })
        .await?;
    Ok(Json(user))
}

/// A 24-hour password-reset link for any user, for admins to hand over when
/// email isn't configured (or the user lost access to their mailbox).
async fn reset_link(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<Json<ResetLink>> {
    actor.require_admin()?;
    let public_url = state.config.public_url.clone();
    let link = state
        .db
        .write(move |tx| {
            let user = users::require(tx, &id)?;
            if !user.is_active {
                return Err(AppError::bad_request(
                    "this user is deactivated; reactivate them first",
                ));
            }
            let link = issue_reset_link(tx, &public_url, &user.id)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::ADMIN_RESET_LINK,
                Some(&user.id),
                None,
                Some(&client.ip),
            )?;
            Ok(link)
        })
        .await?;
    Ok(Json(link))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    before: Option<i64>,
    limit: Option<u32>,
}

async fn audit_log(
    State(state): State<AppState>,
    actor: Actor,
    Query(q): Query<AuditQuery>,
) -> AppResult<Json<AuditPage>> {
    actor.require_admin()?;
    let limit = q.limit.unwrap_or(audit::DEFAULT_PAGE);
    Ok(Json(
        state
            .db
            .read(move |c| audit::list(c, q.before, limit))
            .await?,
    ))
}

async fn stats(State(state): State<AppState>, actor: Actor) -> AppResult<Json<InstanceStats>> {
    actor.require_admin()?;
    let (users, workspaces, bases, records, database_bytes) = state
        .db
        .read(|c| {
            let count = |sql: &str| -> AppResult<i64> { Ok(c.query_row(sql, [], |r| r.get(0))?) };
            Ok((
                count("SELECT count(*) FROM users")?,
                count("SELECT count(*) FROM workspaces WHERE deleted_at IS NULL")?,
                count(
                    "SELECT count(*) FROM bases b JOIN workspaces w ON w.id = b.workspace_id
                     WHERE b.deleted_at IS NULL AND w.deleted_at IS NULL",
                )?,
                count("SELECT count(*) FROM records WHERE deleted_at IS NULL")?,
                count(
                    "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
                )?,
            ))
        })
        .await?;
    let attachments_dir = state.config.attachments_dir();
    let backups_dir = state.config.backups_dir();
    let (attachments_bytes, last_backup_at) = tokio::task::spawn_blocking(move || {
        (dir_size(&attachments_dir), newest_file_ms(&backups_dir))
    })
    .await
    .map_err(AppError::internal)?;
    Ok(Json(InstanceStats {
        users,
        workspaces,
        bases,
        records,
        database_bytes,
        attachments_bytes: i64::try_from(attachments_bytes).unwrap_or(i64::MAX),
        last_backup_at,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }))
}

/// Total size of regular files under `dir` (symlinks are not followed).
/// Unreadable entries are skipped: stats are best-effort.
fn dir_size(dir: &FsPath) -> u64 {
    let mut total = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// Modification time (unix ms) of the newest regular file directly in `dir`.
fn newest_file_ms(dir: &FsPath) -> Option<i64> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.path().symlink_metadata().ok())
        .filter(|m| m.is_file())
        .filter_map(|m| m.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .filter_map(|d| i64::try_from(d.as_millis()).ok())
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_and_newest_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(dir_size(dir.path()), 0);
        assert_eq!(newest_file_ms(dir.path()), None);
        std::fs::create_dir_all(dir.path().join("ab")).unwrap();
        std::fs::write(dir.path().join("ab/one"), [0u8; 100]).unwrap();
        std::fs::write(dir.path().join("two"), [0u8; 23]).unwrap();
        assert_eq!(dir_size(dir.path()), 123);
        assert!(newest_file_ms(dir.path()).is_some());
        assert_eq!(dir_size(&dir.path().join("missing")), 0);
    }
}
