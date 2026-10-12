//! Server-side sessions.

use axum_extra::extract::cookie::{Cookie, SameSite};
use rusqlite::{Connection, params};

use crate::config::Config;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::ids::{hash_token, new_token};

/// Sessions last 30 days.
pub const SESSION_TTL_MS: i64 = 30 * 24 * 3600 * 1000;
/// A session awaiting its second factor lasts 10 minutes.
pub const PENDING_2FA_TTL_MS: i64 = 10 * 60 * 1000;

/// Create a session and return the raw token (to put in the cookie).
pub fn create(
    conn: &Connection,
    user_id: &str,
    pending_2fa: bool,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> AppResult<String> {
    let token = new_token("ses_");
    let now = now_ms();
    let ttl = if pending_2fa {
        PENDING_2FA_TTL_MS
    } else {
        SESSION_TTL_MS
    };
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip, pending_2fa)
         VALUES (?1, ?2, ?3, ?4, ?3, ?5, ?6, ?7)",
        params![
            hash_token(&token),
            user_id,
            now,
            now + ttl,
            user_agent.map(|s| s.chars().take(255).collect::<String>()),
            ip,
            pending_2fa
        ],
    )?;
    Ok(token)
}

pub fn delete(conn: &Connection, token_hash: &str) -> AppResult<()> {
    conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])?;
    Ok(())
}

/// Revoke every session of a user (password change, deactivation, "log out everywhere").
pub fn delete_all_for_user(
    conn: &Connection,
    user_id: &str,
    except_hash: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sessions WHERE user_id = ?1 AND token_hash IS NOT ?2",
        params![user_id, except_hash],
    )?;
    Ok(())
}

pub fn purge_expired(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now_ms()])?)
}

pub fn cookie(config: &Config, token: String) -> Cookie<'static> {
    Cookie::build((super::SESSION_COOKIE, token))
        .http_only(true)
        .secure(config.secure_cookies())
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time_duration(SESSION_TTL_MS))
        .build()
}

pub fn removal_cookie(config: &Config) -> Cookie<'static> {
    Cookie::build((super::SESSION_COOKIE, ""))
        .http_only(true)
        .secure(config.secure_cookies())
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time_duration(0))
        .build()
}

fn time_duration(ms: i64) -> cookie::time::Duration {
    cookie::time::Duration::milliseconds(ms)
}
