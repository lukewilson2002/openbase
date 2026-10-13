//! Passkey storage: the credentials a user registered and the WebAuthn user handle of an account.
//! The cryptography and the ceremonies are in [`crate::auth::passkey`]; this is only rows.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ob_core::api::passkeys::PasskeyInfo;
use rusqlite::{Connection, OptionalExtension, Row, params};
use webauthn_rs::prelude::{Passkey, Uuid};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;

/// Passkeys one account may register. Far more than anyone needs; it keeps a runaway client from
/// filling the table.
pub const MAX_PER_USER: i64 = 20;
/// Longest passkey name, in characters.
pub const MAX_NAME_LEN: usize = 100;
/// Name given to a passkey registered without one.
pub const DEFAULT_NAME: &str = "Passkey";

/// Id prefix of a passkey row (`pky` + 14 characters).
const ID_PREFIX: &str = "pky";

/// The transports a browser may report that are kept; anything else is dropped.
const KNOWN_TRANSPORTS: &[&str] = &["internal", "usb", "nfc", "ble", "hybrid", "smart-card"];

/// The credential id as it is stored and looked up (unpadded base64url).
pub fn encode_credential_id(raw: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(raw)
}

/// Trim and validate a passkey name; an empty one becomes [`DEFAULT_NAME`].
pub fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Ok(DEFAULT_NAME.to_string());
    }
    if n.chars().count() > MAX_NAME_LEN {
        return Err(AppError::bad_request(format!(
            "a passkey name must be at most {MAX_NAME_LEN} characters"
        )));
    }
    if n.chars().any(char::is_control) {
        return Err(AppError::bad_request("name contains invalid characters"));
    }
    Ok(n.to_string())
}

/// Keep only the transports we know, once each, in a stable order.
pub fn clean_transports(reported: &[String]) -> Vec<String> {
    KNOWN_TRANSPORTS
        .iter()
        .filter(|k| reported.iter().any(|r| r.eq_ignore_ascii_case(k)))
        .map(|k| k.to_string())
        .collect()
}

/// A stored passkey with the credential parsed.
pub struct PasskeyRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub passkey: Passkey,
}

const INFO_COLUMNS: &str =
    "id, name, created_at, last_used_at, transports, backup_eligible, backup_state";

fn info_from_row(r: &Row) -> rusqlite::Result<PasskeyInfo> {
    let transports: Option<String> = r.get(4)?;
    Ok(PasskeyInfo {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        last_used_at: r.get(3)?,
        transports: transports
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default(),
        backup_eligible: r.get(5)?,
        backup_state: r.get(6)?,
    })
}

/// The WebAuthn user handle of an account, created on first use. Random and unrelated to the
/// user id or the email: it is stored in the authenticator, which any holder of the device can
/// read.
pub fn user_handle(conn: &Connection, user_id: &str) -> AppResult<Uuid> {
    let existing: Option<Vec<u8>> = conn
        .query_row(
            "SELECT handle FROM passkey_user_handles WHERE user_id = ?1",
            [user_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(bytes) = existing {
        return Uuid::from_slice(&bytes).map_err(AppError::internal);
    }
    let handle = Uuid::new_v4();
    conn.execute(
        "INSERT INTO passkey_user_handles (user_id, handle) VALUES (?1, ?2)",
        params![user_id, handle.as_bytes().as_slice()],
    )?;
    Ok(handle)
}

/// The account a user handle belongs to.
pub fn user_for_handle(conn: &Connection, handle: &Uuid) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT user_id FROM passkey_user_handles WHERE handle = ?1",
            [handle.as_bytes().as_slice()],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn count(conn: &Connection, user_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM passkeys WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )?)
}

/// The user's passkeys, oldest first.
pub fn list(conn: &Connection, user_id: &str) -> AppResult<Vec<PasskeyInfo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {INFO_COLUMNS} FROM passkeys WHERE user_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([user_id], info_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_info(conn: &Connection, user_id: &str, id: &str) -> AppResult<PasskeyInfo> {
    conn.query_row(
        &format!("SELECT {INFO_COLUMNS} FROM passkeys WHERE id = ?1 AND user_id = ?2"),
        params![id, user_id],
        info_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("passkey"))
}

/// The raw credential ids of the user's passkeys, for the registration's exclude list (a device
/// that already has a passkey for the account is not offered to register another).
pub fn credential_ids(conn: &Connection, user_id: &str) -> AppResult<Vec<Vec<u8>>> {
    let mut stmt = conn.prepare("SELECT credential_id FROM passkeys WHERE user_id = ?1")?;
    let rows = stmt.query_map([user_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for id in rows {
        if let Ok(raw) = URL_SAFE_NO_PAD.decode(id?) {
            out.push(raw);
        }
    }
    Ok(out)
}

/// The passkey with this credential id, if any. A stored credential that no longer parses (it
/// would take a library change that dropped a format) reads as absent, so it can never sign in.
pub fn find_by_credential(conn: &Connection, raw_id: &[u8]) -> AppResult<Option<PasskeyRow>> {
    let row = conn
        .query_row(
            "SELECT id, user_id, name, credential FROM passkeys WHERE credential_id = ?1",
            [encode_credential_id(raw_id)],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, user_id, name, json)) = row else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Passkey>(&json)
        .ok()
        .map(|passkey| PasskeyRow {
            id,
            user_id,
            name,
            passkey,
        }))
}

/// The backup flags of a credential as the authenticator reported them, read from its JSON (the
/// library only exposes them behind a feature that also exposes the key material).
fn backup_flags(passkey: &Passkey) -> (bool, bool) {
    let v = serde_json::to_value(passkey).unwrap_or_default();
    let flag = |name: &str| v["cred"][name].as_bool().unwrap_or(false);
    (flag("backup_eligible"), flag("backup_state"))
}

/// Store a newly registered passkey. The credential id is unique across the instance: a second
/// registration of the same credential (for any account) is a conflict.
pub fn insert(
    conn: &Connection,
    user_id: &str,
    passkey: &Passkey,
    name: &str,
    transports: &[String],
) -> AppResult<PasskeyInfo> {
    if count(conn, user_id)? >= MAX_PER_USER {
        return Err(AppError::conflict(format!(
            "you can register at most {MAX_PER_USER} passkeys; remove one you no longer use"
        )));
    }
    let id = new_id(ID_PREFIX);
    let (eligible, state) = backup_flags(passkey);
    let transports_json = (!transports.is_empty()).then(|| serde_json::json!(transports));
    let inserted = conn.execute(
        "INSERT INTO passkeys (id, user_id, credential_id, credential, name, created_at,
                               transports, backup_eligible, backup_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            user_id,
            encode_credential_id(passkey.cred_id()),
            serde_json::to_string(passkey)?,
            name,
            now_ms(),
            transports_json.map(|t| t.to_string()),
            eligible,
            state
        ],
    );
    match inserted {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return Err(AppError::conflict(
                "this passkey is already registered; use a different authenticator",
            ));
        }
        Err(e) => return Err(e.into()),
    }
    get_info(conn, user_id, &id)
}

/// After a successful sign-in: store the credential as the library updated it (signature
/// counter, backup flags) and stamp the use.
pub fn mark_used(conn: &Connection, id: &str, passkey: &Passkey) -> AppResult<()> {
    let (eligible, state) = backup_flags(passkey);
    conn.execute(
        "UPDATE passkeys SET credential = ?1, last_used_at = ?2, backup_eligible = ?3,
                             backup_state = ?4
         WHERE id = ?5",
        params![
            serde_json::to_string(passkey)?,
            now_ms(),
            eligible,
            state,
            id
        ],
    )?;
    Ok(())
}

/// Rename a passkey of `user_id`; the name is validated by the caller.
pub fn rename(conn: &Connection, user_id: &str, id: &str, name: &str) -> AppResult<PasskeyInfo> {
    let n = conn.execute(
        "UPDATE passkeys SET name = ?1 WHERE id = ?2 AND user_id = ?3",
        params![name, id, user_id],
    )?;
    if n == 0 {
        return Err(AppError::not_found("passkey"));
    }
    get_info(conn, user_id, id)
}

/// Remove one passkey of `user_id`; returns its name.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> AppResult<String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM passkeys WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(name) = name else {
        return Err(AppError::not_found("passkey"));
    };
    conn.execute(
        "DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    )?;
    Ok(name)
}

/// Remove every passkey of a user; returns how many there were.
pub fn delete_all_for_user(conn: &Connection, user_id: &str) -> AppResult<i64> {
    Ok(conn.execute("DELETE FROM passkeys WHERE user_id = ?1", [user_id])? as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_defaulted_and_bounded() {
        assert_eq!(clean_name("  MacBook  ").unwrap(), "MacBook");
        assert_eq!(clean_name("   ").unwrap(), DEFAULT_NAME);
        assert!(clean_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
        assert!(clean_name("bad\u{7}name").is_err());
        assert_eq!(
            clean_name(&"é".repeat(MAX_NAME_LEN))
                .unwrap()
                .chars()
                .count(),
            100
        );
    }

    #[test]
    fn only_known_transports_are_kept() {
        let reported = [
            "usb".into(),
            "INTERNAL".into(),
            "usb".into(),
            "<script>".into(),
        ];
        assert_eq!(clean_transports(&reported), vec!["internal", "usb"]);
        assert!(clean_transports(&[]).is_empty());
    }
}
