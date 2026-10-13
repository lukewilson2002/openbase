//! TOTP second factor (RFC 6238): SHA-1, 6 digits, 30-second steps, ±1 step
//! of clock skew — the parameters every authenticator app supports.
//!
//! A code is accepted at most once: the matched time step is remembered per
//! user (in `settings`, key `totp_last_step:<user_id>`) and codes from that
//! step or earlier are rejected, so a code observed over someone's shoulder
//! cannot be replayed within its validity window.

use rusqlite::{Connection, OptionalExtension, params};
use totp_rs::{Algorithm, Builder, Secret, Totp};

use crate::error::{AppError, AppResult};

pub const ISSUER: &str = "OpenBase";
const DIGITS: u8 = 6;
const STEP_SECS: u64 = 30;
const SKEW: u16 = 1;

/// A new random base32 secret (160 bits).
pub fn generate_secret() -> String {
    Secret::generate().to_base32()
}

fn build(secret_b32: &str, account: &str) -> AppResult<Totp> {
    let secret = Secret::try_from_base32(secret_b32)
        .map_err(|_| AppError::internal("stored TOTP secret is not valid base32"))?;
    // Account names may not contain ':' in otpauth URIs.
    let account = account.replace(':', "_");
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(DIGITS)
        .with_step_duration(STEP_SECS)
        .with_skew(SKEW)
        .with_secret(secret.as_bytes().to_vec())
        .with_issuer(Some(ISSUER))
        .with_account_name(account)
        .build()
        .map_err(AppError::internal)
}

/// otpauth:// URI for QR codes.
pub fn otpauth_url(secret_b32: &str, account: &str) -> AppResult<String> {
    build(secret_b32, account)?
        .to_url()
        .map_err(AppError::internal)
}

/// The code for `secret_b32` at unix time `time` (used by tests and the CLI).
pub fn code_at(secret_b32: &str, time: u64) -> AppResult<String> {
    Ok(build(secret_b32, "")?.generate(time).to_string())
}

/// If `code` is valid for `secret_b32` at unix time `time`, the matched step.
/// Malformed codes (wrong length, non-digits) are simply invalid.
pub fn check_at(secret_b32: &str, code: &str, time: u64) -> AppResult<Option<u64>> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if code.len() != DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    Ok(build(secret_b32, "")?.check(&code, time))
}

fn unix_now() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp()).unwrap_or(0)
}

fn last_step_key(user_id: &str) -> String {
    format!("totp_last_step:{user_id}")
}

/// Verify `code` for a user at the current time, rejecting replays, and
/// remember the accepted step. Returns whether the code was accepted.
pub fn verify_and_consume(
    conn: &Connection,
    user_id: &str,
    secret_b32: &str,
    code: &str,
) -> AppResult<bool> {
    verify_and_consume_at(conn, user_id, secret_b32, code, unix_now())
}

/// [`verify_and_consume`] at an explicit time (for tests).
pub fn verify_and_consume_at(
    conn: &Connection,
    user_id: &str,
    secret_b32: &str,
    code: &str,
    time: u64,
) -> AppResult<bool> {
    let Some(step) = check_at(secret_b32, code, time)? else {
        return Ok(false);
    };
    let key = last_step_key(user_id);
    let last: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [&key], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(last) = last.and_then(|v| v.parse::<u64>().ok()) {
        if step <= last {
            return Ok(false);
        }
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, step.to_string()],
    )?;
    Ok(true)
}

/// Forget the replay marker (when 2FA is disabled or reset).
pub fn clear_replay_state(conn: &Connection, user_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        [last_step_key(user_id)],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn secret_and_url() {
        let s = generate_secret();
        assert_eq!(Secret::try_from_base32(&s).unwrap().as_bytes().len(), 20);
        let url = otpauth_url(&s, "a@example.com").unwrap();
        assert!(url.starts_with("otpauth://totp/OpenBase:a%40example.com?"));
        assert!(url.contains("issuer=OpenBase"));
        assert!(url.contains(&format!("secret={s}")));
    }

    #[test]
    fn checks_codes_with_skew() {
        let s = generate_secret();
        let t = 1_700_000_000;
        let code = code_at(&s, t).unwrap();
        assert_eq!(code.len(), 6);
        assert!(check_at(&s, &code, t).unwrap().is_some());
        assert!(check_at(&s, &code, t + 30).unwrap().is_some());
        assert!(check_at(&s, &code, t - 30).unwrap().is_some());
        assert!(check_at(&s, &code, t + 90).unwrap().is_none());
        assert!(check_at(&s, "12345", t).unwrap().is_none());
        assert!(check_at(&s, "abcdef", t).unwrap().is_none());
        assert!(check_at(&s, "", t).unwrap().is_none());
        assert!(check_at(&s, &"9".repeat(1000), t).unwrap().is_none());
    }

    #[test]
    fn codes_cannot_be_replayed() {
        let c = db();
        let s = generate_secret();
        let t = 1_700_000_000;
        let code = code_at(&s, t).unwrap();
        assert!(verify_and_consume_at(&c, "usr1", &s, &code, t).unwrap());
        assert!(!verify_and_consume_at(&c, "usr1", &s, &code, t).unwrap());
        // An older code (previous step, still within skew) is also rejected.
        let older = code_at(&s, t - 30).unwrap();
        assert!(!verify_and_consume_at(&c, "usr1", &s, &older, t).unwrap());
        // The next step's code works.
        let next = code_at(&s, t + 30).unwrap();
        assert!(verify_and_consume_at(&c, "usr1", &s, &next, t + 30).unwrap());
        // Another user's marker is independent.
        assert!(verify_and_consume_at(&c, "usr2", &s, &code, t).unwrap());
        clear_replay_state(&c, "usr1").unwrap();
        assert!(verify_and_consume_at(&c, "usr1", &s, &code, t).unwrap());
    }
}
