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

/// Add an OAuth client by hand. Returns its `client_id` and, for a confidential client, its
/// secret (shown once; only the hash is stored).
pub fn add_oauth_client(
    state: &AppState,
    name: &str,
    redirect_uris: &[String],
    confidential: bool,
) -> AppResult<(String, Option<String>)> {
    use crate::store::oauth as store;
    let name = crate::oauth::register::clean_name(name).map_err(AppError::bad_request)?;
    if redirect_uris.is_empty() {
        return Err(AppError::bad_request(
            "at least one --redirect-uri is required",
        ));
    }
    for uri in redirect_uris {
        crate::oauth::redirect::validate(uri).map_err(AppError::bad_request)?;
    }
    let mut uris: Vec<String> = Vec::new();
    for u in redirect_uris {
        if !uris.contains(u) {
            uris.push(u.clone());
        }
    }
    let (secret, secret_hash) = if confidential {
        let (s, h) = store::new_client_secret();
        (Some(s), Some(h))
    } else {
        (None, None)
    };
    let client = store::Client {
        id: store::new_client_id(),
        source: store::SOURCE_PREREGISTERED.into(),
        name,
        logo_uri: None,
        redirect_uris: uris,
        secret_hash,
        created_at: now_ms(),
        last_used_at: None,
        fetched_at: None,
    };
    state
        .db
        .write_sync(|tx| store::insert_client(tx, &client, None))?;
    Ok((client.id, secret))
}

/// One line per OAuth client: id, source, name and redirect URIs.
pub fn list_oauth_clients(state: &AppState) -> AppResult<Vec<String>> {
    let clients = state
        .db
        .write_sync(|tx| crate::store::oauth::list_clients(tx))?;
    Ok(clients
        .into_iter()
        .map(|c| {
            format!(
                "{}  {:<13}  {}{}  {}",
                c.id,
                c.source,
                c.name,
                if c.is_confidential() {
                    " (confidential)"
                } else {
                    ""
                },
                c.redirect_uris.join(" ")
            )
        })
        .collect())
}

/// Remove an OAuth client and, with it, every grant made through it.
pub fn remove_oauth_client(state: &AppState, client_id: &str) -> AppResult<()> {
    let removed = state
        .db
        .write_sync(|tx| crate::store::oauth::delete_client(tx, client_id))?;
    if removed {
        Ok(())
    } else {
        Err(AppError::not_found("OAuth client"))
    }
}
