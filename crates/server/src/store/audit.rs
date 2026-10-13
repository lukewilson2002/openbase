//! Audit log of security-relevant events (logins, password and 2FA changes,
//! tokens, invites, admin actions). Rows are append-only.

use ob_core::api::auth::{AuditEntry, AuditPage};
use rusqlite::{Connection, params};
use serde_json::Value;

use crate::db::now_ms;
use crate::error::AppResult;

/// Action names written to `audit_log.action`.
pub mod actions {
    pub const SIGNUP: &str = "signup";
    pub const LOGIN: &str = "login";
    pub const LOGIN_FAILED: &str = "login_failed";
    pub const LOGIN_2FA_FAILED: &str = "login_2fa_failed";
    pub const LOGOUT: &str = "logout";
    pub const PASSWORD_CHANGE: &str = "password_change";
    pub const PASSWORD_RESET_REQUEST: &str = "password_reset_request";
    pub const PASSWORD_RESET: &str = "password_reset";
    pub const SESSION_REVOKE: &str = "session_revoke";
    pub const TWO_FACTOR_ENABLE: &str = "2fa_enable";
    pub const TWO_FACTOR_DISABLE: &str = "2fa_disable";
    pub const TOKEN_CREATE: &str = "token_create";
    pub const TOKEN_DELETE: &str = "token_delete";
    pub const INVITE_CREATE: &str = "invite_create";
    pub const INVITE_ACCEPT: &str = "invite_accept";
    pub const INVITE_REVOKE: &str = "invite_revoke";
    pub const ADMIN_USER_CREATE: &str = "admin_user_create";
    pub const ADMIN_USER_UPDATE: &str = "admin_user_update";
    pub const ADMIN_RESET_LINK: &str = "admin_reset_link";
    /// SMTP settings changed on the Admin -> Email page (detail: the changed fields; the
    /// password only as set / replaced / removed).
    pub const ADMIN_EMAIL_UPDATE: &str = "admin_email_update";
    /// A test email was sent from the Admin -> Email page.
    pub const ADMIN_EMAIL_TEST: &str = "admin_email_test";
    /// A user approved an app on the OAuth consent page (an authorization code was issued).
    pub const OAUTH_APPROVE: &str = "oauth_approve";
    /// A user refused an app on the OAuth consent page.
    pub const OAUTH_DENY: &str = "oauth_deny";
    /// An app exchanged its authorization code: the grant ("connected app") now exists.
    pub const OAUTH_GRANT_CREATE: &str = "oauth_grant_create";
    /// A grant was revoked: by the user, an administrator or the app itself (detail: `by`).
    pub const OAUTH_GRANT_REVOKE: &str = "oauth_grant_revoke";
    /// An already used refresh token was presented: the grant was revoked.
    pub const OAUTH_REFRESH_REUSE: &str = "oauth_refresh_reuse";
    /// An already used authorization code was presented: the grant created from it was revoked.
    pub const OAUTH_CODE_REPLAY: &str = "oauth_code_replay";
    /// A passkey was registered (target: the passkey id; detail: its name).
    pub const PASSKEY_ADD: &str = "passkey_add";
    /// A passkey was renamed (detail: the new name).
    pub const PASSKEY_RENAME: &str = "passkey_rename";
    /// A passkey was removed by its owner (detail: its name).
    pub const PASSKEY_REMOVE: &str = "passkey_remove";
    /// Someone signed in with a passkey (target: the passkey id).
    pub const PASSKEY_LOGIN: &str = "passkey_login";
    /// A passkey sign-in was refused (detail: `reason`).
    pub const PASSKEY_LOGIN_FAILED: &str = "passkey_login_failed";
    /// An administrator removed all of a user's passkeys (target: the user; detail: how many).
    pub const ADMIN_PASSKEYS_REMOVE: &str = "admin_passkeys_remove";
    /// An API token with the `manage` permission called an admin endpoint.
    pub const ADMIN_TOKEN_USE: &str = "admin_token_use";
}

/// Largest `detail` JSON stored in one row; bigger ones are replaced by a marker.
pub const MAX_DETAIL_BYTES: usize = 2048;

/// Append one audit entry.
pub fn record(
    conn: &Connection,
    user_id: Option<&str>,
    action: &str,
    target: Option<&str>,
    detail: Option<Value>,
    ip: Option<&str>,
) -> AppResult<()> {
    // Detail can echo caller-supplied text; never let one row grow large.
    let detail = detail.map(|d| {
        let s = d.to_string();
        if s.len() > MAX_DETAIL_BYTES {
            r#"{"truncated":true}"#.to_string()
        } else {
            s
        }
    });
    conn.execute(
        "INSERT INTO audit_log (user_id, action, target, detail, ip, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![user_id, action, target, detail, ip, now_ms()],
    )?;
    Ok(())
}

pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 200;

/// Entries with id < `before` (all when None), newest first, at most `limit`.
pub fn list(conn: &Connection, before: Option<i64>, limit: u32) -> AppResult<AuditPage> {
    let limit = limit.clamp(1, MAX_PAGE);
    let mut stmt = conn.prepare(
        "SELECT a.id, a.user_id, u.email, a.action, a.target, a.detail, a.ip, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.id < ?1
         ORDER BY a.id DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![before.unwrap_or(i64::MAX), limit], |r| {
        let detail: Option<String> = r.get(5)?;
        Ok(AuditEntry {
            id: r.get(0)?,
            user_id: r.get(1)?,
            user_email: r.get(2)?,
            action: r.get(3)?,
            target: r.get(4)?,
            detail: detail.and_then(|d| serde_json::from_str(&d).ok()),
            ip: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    let entries = rows.collect::<Result<Vec<_>, _>>()?;
    let next_before = if entries.len() == limit as usize {
        entries.last().map(|e| e.id)
    } else {
        None
    };
    Ok(AuditPage {
        entries,
        next_before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_and_pages_newest_first() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        for i in 0..5 {
            record(
                &c,
                None,
                actions::LOGIN_FAILED,
                Some(&format!("t{i}")),
                Some(json!({"i": i})),
                Some("1.2.3.4"),
            )
            .unwrap();
        }
        let p1 = list(&c, None, 2).unwrap();
        assert_eq!(p1.entries.len(), 2);
        assert_eq!(p1.entries[0].target.as_deref(), Some("t4"));
        assert_eq!(p1.entries[0].detail, Some(json!({"i": 4})));
        assert_eq!(p1.entries[0].ip.as_deref(), Some("1.2.3.4"));
        let p2 = list(&c, p1.next_before, 2).unwrap();
        assert_eq!(p2.entries[0].target.as_deref(), Some("t2"));
        let p3 = list(&c, p2.next_before, 2).unwrap();
        assert_eq!(p3.entries.len(), 1);
        assert_eq!(p3.next_before, None);
    }
}
