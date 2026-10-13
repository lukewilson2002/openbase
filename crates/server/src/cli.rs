//! Implementations of administrative CLI commands.

use crate::auth::{password, session};
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::state::AppState;

pub fn create_admin(state: &AppState, email: &str, name: &str, pw: &str) -> AppResult<String> {
    password::validate_new_password(pw)?;
    let email = crate::store::users::normalize_email(email)?;
    let hash = password::hash(pw)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::bad_request("name is required"));
    }
    state.db.write_sync(|tx| {
        let id = new_id(ob_core::ids::USER);
        let now = now_ms();
        tx.execute(
            "INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
            rusqlite::params![id, email, name, hash, now],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::conflict("a user with that email already exists")
            }
            other => other.into(),
        })?;
        Ok(id)
    })
}

pub fn reset_password(state: &AppState, email: &str, pw: &str) -> AppResult<()> {
    password::validate_new_password(pw)?;
    let hash = password::hash(pw)?;
    let email = email.trim().to_string();
    state.db.write_sync(|tx| {
        let id: String = tx
            .query_row("SELECT id FROM users WHERE email = ?1", [&email], |r| {
                r.get(0)
            })
            .map_err(|_| AppError::not_found("user"))?;
        tx.execute(
            "UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![hash, now_ms(), id],
        )?;
        session::delete_all_for_user(tx, &id, None)?;
        crate::store::tokens::delete_all_for_user(tx, &id)?;
        Ok(())
    })
}
