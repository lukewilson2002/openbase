//! Server-side sessions.

use axum_extra::extract::cookie::{Cookie, SameSite};
use rusqlite::{Connection, params};

use crate::config::Config;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::ids::{hash_token, new_token};

/// Sessions last 30 days at most, however active they are.
pub const SESSION_TTL_MS: i64 = 30 * 24 * 3600 * 1000;
/// A session that has not been used for 14 days ends, even inside its 30 days.
pub const SESSION_IDLE_TIMEOUT_MS: i64 = 14 * 24 * 3600 * 1000;
/// `last_seen_at` is refreshed at most this often per session. The idle timeout is measured in
/// days, so minute-level accuracy buys nothing, and each refresh is a write on the single
/// writer; this bounds the cost of a busy tab to a few writes an hour.
pub const SESSION_TOUCH_INTERVAL_MS: i64 = 10 * 60 * 1000;
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

/// Delete sessions past their 30-day end or idle for longer than the idle timeout.
pub fn purge_expired(conn: &Connection) -> AppResult<usize> {
    let now = now_ms();
    Ok(conn.execute(
        "DELETE FROM sessions WHERE expires_at <= ?1 OR last_seen_at <= ?2",
        params![now, now - SESSION_IDLE_TIMEOUT_MS],
    )?)
}

/// Record that the session behind `token_hash` was used, unless it was already recorded within
/// [`SESSION_TOUCH_INTERVAL_MS`]. The condition is in the statement so that concurrent requests
/// of one session write once.
pub fn touch(conn: &Connection, token_hash: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE sessions SET last_seen_at = ?1 WHERE token_hash = ?2 AND last_seen_at < ?3",
        params![now, token_hash, now - SESSION_TOUCH_INTERVAL_MS],
    )?;
    Ok(())
}

pub fn cookie(config: &Config, token: String) -> Cookie<'static> {
    Cookie::build((config.session_cookie_name(), token))
        .http_only(true)
        .secure(config.secure_cookies())
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time_duration(SESSION_TTL_MS))
        .build()
}

pub fn removal_cookie(config: &Config) -> Cookie<'static> {
    removal(config.session_cookie_name(), config.secure_cookies())
}

/// Removal of the pre-`__Host-` cookie name, sent on logout over https so a browser that signed
/// in before the rename does not keep a dead session token around for up to 30 days.
pub fn legacy_removal_cookie(config: &Config) -> Option<Cookie<'static>> {
    config
        .public_https()
        .then(|| removal(super::SESSION_COOKIE, true))
}

fn removal(name: &'static str, secure: bool) -> Cookie<'static> {
    Cookie::build((name, ""))
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time_duration(0))
        .build()
}

fn time_duration(ms: i64) -> cookie::time::Duration {
    cookie::time::Duration::milliseconds(ms)
}
