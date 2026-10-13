//! Personal access tokens. The raw token (`pat` + 43 random chars) is shown
//! once at creation; only its SHA-256 is stored. Scopes are a JSON
//! [`TokenScope`].

use ob_core::api::auth::{CreateTokenRequest, CreatedToken, TokenInfo};
use rusqlite::{Connection, params};

use crate::auth::TokenScope;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::{hash_token, new_id, new_token};
use crate::store::users::validate_name;

/// Prefix of raw API tokens.
pub const TOKEN_PREFIX: &str = "pat";
/// Tokens per user.
pub const MAX_TOKENS_PER_USER: i64 = 50;
/// Longest allowed expiry.
pub const MAX_EXPIRY_DAYS: u32 = 3650;
/// Most bases one token may be limited to.
pub const MAX_BASES_PER_TOKEN: usize = 100;

const DAY_MS: i64 = 24 * 3600 * 1000;

/// The bases a token (or an OAuth grant) may be limited to: at least one, at most
/// [`MAX_BASES_PER_TOKEN`], all of them bases `user_id` can currently access. Returned sorted
/// and without duplicates.
pub fn validate_base_ids(
    conn: &Connection,
    user_id: &str,
    ids: &[String],
) -> AppResult<Vec<String>> {
    if ids.is_empty() {
        return Err(AppError::bad_request(
            "base_ids must list at least one base (omit it for all bases)",
        ));
    }
    if ids.len() > MAX_BASES_PER_TOKEN {
        return Err(AppError::bad_request("too many bases for one token"));
    }
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    for id in &ids {
        if crate::perm::base_role(conn, user_id, id)?.is_none() {
            return Err(AppError::bad_request(format!("unknown base '{id}'")));
        }
    }
    Ok(ids)
}

/// Create a token for `user_id`. Base restrictions must name bases the user
/// can currently access (the effective role is still checked on every use).
pub fn create(
    conn: &Connection,
    user_id: &str,
    req: &CreateTokenRequest,
) -> AppResult<CreatedToken> {
    let name = validate_name(&req.name)
        .map_err(|_| AppError::bad_request("token name is required (at most 100 characters)"))?;
    let existing: i64 = conn.query_row(
        "SELECT count(*) FROM api_tokens WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )?;
    if existing >= MAX_TOKENS_PER_USER {
        return Err(AppError::bad_request(format!(
            "you can have at most {MAX_TOKENS_PER_USER} tokens; delete one first"
        )));
    }
    let base_ids = match &req.base_ids {
        None => None,
        Some(ids) => Some(validate_base_ids(conn, user_id, ids)?),
    };
    let expires_at = match req.expires_in_days {
        None => None,
        Some(0) => return Err(AppError::bad_request("expires_in_days must be at least 1")),
        Some(d) if d > MAX_EXPIRY_DAYS => {
            return Err(AppError::bad_request(format!(
                "expires_in_days must be at most {MAX_EXPIRY_DAYS}"
            )));
        }
        Some(d) => Some(now_ms() + i64::from(d) * DAY_MS),
    };
    if req.manage && !req.write {
        return Err(AppError::bad_request(
            "a token that can manage workspaces and members must also allow writes",
        ));
    }
    let scope = TokenScope {
        write: req.write,
        manage: req.manage,
        base_ids: base_ids.clone(),
    };
    let id = new_id(ob_core::ids::TOKEN);
    let token = new_token(TOKEN_PREFIX);
    let now = now_ms();
    conn.execute(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            user_id,
            name,
            hash_token(&token),
            serde_json::to_string(&scope)?,
            now,
            expires_at
        ],
    )?;
    Ok(CreatedToken {
        token,
        info: TokenInfo {
            id,
            name,
            write: req.write,
            manage: req.manage,
            base_ids,
            created_at: now,
            last_used_at: None,
            expires_at,
        },
    })
}

/// The user's tokens, newest first.
pub fn list(conn: &Connection, user_id: &str) -> AppResult<Vec<TokenInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, scopes, created_at, last_used_at, expires_at
         FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC, id",
    )?;
    let rows = stmt.query_map([user_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, scopes, created_at, last_used_at, expires_at) = row?;
        let scope: TokenScope = serde_json::from_str(&scopes)?;
        out.push(TokenInfo {
            id,
            name,
            write: scope.write,
            manage: scope.manage && scope.write,
            base_ids: scope.base_ids,
            created_at,
            last_used_at,
            expires_at,
        });
    }
    Ok(out)
}

/// Delete one of the user's tokens; 404 if it isn't theirs.
pub fn delete(conn: &Connection, user_id: &str, token_id: &str) -> AppResult<()> {
    let n = conn.execute(
        "DELETE FROM api_tokens WHERE id = ?1 AND user_id = ?2",
        params![token_id, user_id],
    )?;
    if n == 0 {
        return Err(AppError::not_found("token"));
    }
    Ok(())
}

/// Delete every token of a user (password change or reset: a token minted
/// during a compromise must not outlive the credential change). The user's OAuth
/// grants ("connected apps") go with them. Returns how many API tokens were deleted.
pub fn delete_all_for_user(conn: &Connection, user_id: &str) -> AppResult<usize> {
    crate::store::oauth::revoke_all_for_user(conn, user_id)?;
    Ok(conn.execute("DELETE FROM api_tokens WHERE user_id = ?1", [user_id])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Connection, String) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::db::migrate(&c).unwrap();
        let u = crate::store::users::create(&c, "a@example.com", "A", "!", false).unwrap();
        (c, u)
    }

    fn req(name: &str) -> CreateTokenRequest {
        CreateTokenRequest {
            name: name.into(),
            write: false,
            manage: false,
            base_ids: None,
            expires_in_days: None,
        }
    }

    #[test]
    fn create_list_delete() {
        let (c, u) = db();
        let t = create(&c, &u, &req("ci")).unwrap();
        assert!(t.token.starts_with("pat") && t.token.len() == 46);
        let resolved = crate::auth::actor_from_api_token(&c, &t.token)
            .unwrap()
            .unwrap();
        assert!(!resolved.token_scope.unwrap().write);
        assert_eq!(list(&c, &u).unwrap(), vec![t.info.clone()]);
        delete(&c, &u, &t.info.id).unwrap();
        assert!(matches!(
            delete(&c, &u, &t.info.id),
            Err(AppError::NotFound(_))
        ));
        assert!(list(&c, &u).unwrap().is_empty());
    }

    #[test]
    fn validates_input() {
        let (c, u) = db();
        assert!(create(&c, &u, &req("  ")).is_err());
        let mut r = req("x");
        r.expires_in_days = Some(0);
        assert!(create(&c, &u, &r).is_err());
        r.expires_in_days = Some(MAX_EXPIRY_DAYS + 1);
        assert!(create(&c, &u, &r).is_err());
        let mut r = req("x");
        r.base_ids = Some(vec![]);
        assert!(create(&c, &u, &r).is_err());
        r.base_ids = Some(vec!["appNope".into()]);
        assert!(create(&c, &u, &r).is_err());
    }

    #[test]
    fn caps_tokens_per_user() {
        let (c, u) = db();
        for i in 0..MAX_TOKENS_PER_USER {
            create(&c, &u, &req(&format!("t{i}"))).unwrap();
        }
        assert!(create(&c, &u, &req("one too many")).is_err());
    }
}
