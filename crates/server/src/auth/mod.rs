//! Authentication: who is calling.
//!
//! Browser clients use an opaque session cookie (`og_session`); integrations
//! use `Authorization: Bearer <api token>`. Both resolve to an [`Actor`].
//! Only SHA-256 hashes of tokens are stored.

pub mod password;
pub mod session;
pub mod totp;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::hash_token;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "og_session";

/// Scope of an API token. Session-authenticated actors have no scope (full
/// access as the user).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenScope {
    /// Whether the token may write. Read-only tokens act as Viewer.
    pub write: bool,
    /// Bases the token may access; None = every base the user can access.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
}

/// The authenticated caller.
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub is_admin: bool,
    /// Set when authenticated by API token.
    pub token_scope: Option<TokenScope>,
    /// SHA-256 of the session token when authenticated by session (for logout).
    pub session_hash: Option<String>,
}

impl Actor {
    pub fn require_admin(&self) -> AppResult<()> {
        if self.is_admin && self.token_scope.is_none() {
            Ok(())
        } else {
            Err(AppError::forbidden("administrator access required"))
        }
    }

    /// Reject API-token callers: account, token, invite and workspace
    /// management are only available to signed-in users (session cookie).
    pub fn require_session(&self) -> AppResult<()> {
        if self.token_scope.is_none() {
            Ok(())
        } else {
            Err(AppError::forbidden(
                "API tokens cannot use this endpoint; sign in instead",
            ))
        }
    }
}

/// Where a request came from, for audit entries, sessions and rate limits.
#[derive(Debug, Clone)]
pub struct ClientInfo {
    /// Client IP: the first `X-Forwarded-For` entry when `trust_proxy` is on,
    /// else the TCP peer address, else `"unknown"` (in-process tests).
    pub ip: String,
    pub user_agent: Option<String>,
}

/// Compute the client IP from the request parts (see [`ClientInfo::ip`]).
pub fn client_ip(parts: &Parts, trust_proxy: bool) -> String {
    if trust_proxy {
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .and_then(|v| v.parse::<std::net::IpAddr>().ok());
        if let Some(ip) = forwarded {
            return ip.to_string();
        }
    }
    parts
        .extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

impl FromRequestParts<AppState> for ClientInfo {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user_agent = parts
            .headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(255).collect());
        Ok(ClientInfo {
            ip: client_ip(parts, state.config.trust_proxy),
            user_agent,
        })
    }
}

/// Resolve a session token to an actor. Expired, 2FA-pending, or inactive-user
/// sessions resolve to None. Refreshes `last_seen_at` at most once a minute.
pub fn actor_from_session(conn: &Connection, token: &str) -> AppResult<Option<Actor>> {
    let hash = hash_token(token);
    let now = now_ms();
    let row = conn
        .query_row(
            "SELECT u.id, u.name, u.email, u.is_admin, s.expires_at, s.pending_2fa, s.last_seen_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND u.is_active = 1",
            [&hash],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, bool>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((user_id, name, email, is_admin, expires_at, pending_2fa, _last_seen)) = row else {
        return Ok(None);
    };
    if expires_at <= now || pending_2fa {
        return Ok(None);
    }
    Ok(Some(Actor {
        user_id,
        name,
        email,
        is_admin,
        token_scope: None,
        session_hash: Some(hash),
    }))
}

/// Resolve an API token (`pat...`) to an actor.
pub fn actor_from_api_token(conn: &Connection, token: &str) -> AppResult<Option<Actor>> {
    let hash = hash_token(token);
    let now = now_ms();
    let row = conn
        .query_row(
            "SELECT u.id, u.name, u.email, u.is_admin, t.scopes, t.expires_at
             FROM api_tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ?1 AND u.is_active = 1",
            [&hash],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((user_id, name, email, is_admin, scopes, expires_at)) = row else {
        return Ok(None);
    };
    if expires_at.is_some_and(|e| e <= now) {
        return Ok(None);
    }
    let scope: TokenScope = serde_json::from_str(&scopes)?;
    Ok(Some(Actor {
        user_id,
        name,
        email,
        is_admin,
        token_scope: Some(scope),
        session_hash: None,
    }))
}

fn bearer(parts: &Parts) -> Option<&str> {
    let v = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    v.strip_prefix("Bearer ").map(str::trim)
}

impl FromRequestParts<AppState> for Actor {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(token) = bearer(parts) {
            let token = token.to_string();
            let actor = state
                .db
                .read(move |c| actor_from_api_token(c, &token))
                .await?;
            if let Some(a) = &actor {
                let id = a.user_id.clone();
                let hash = hash_token(bearer(parts).unwrap_or_default());
                // Best-effort usage stamp; never fail the request over it.
                let _ = state
                    .db
                    .write(move |tx| {
                        tx.execute(
                            "UPDATE api_tokens SET last_used_at = ?1 WHERE token_hash = ?2 AND user_id = ?3",
                            rusqlite::params![now_ms(), hash, id],
                        )?;
                        Ok(())
                    })
                    .await;
            }
            return actor.ok_or(AppError::Unauthorized);
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let Some(cookie) = jar.get(SESSION_COOKIE) else {
            return Err(AppError::Unauthorized);
        };
        let token = cookie.value().to_string();
        state
            .db
            .read(move |c| actor_from_session(c, &token))
            .await?
            .ok_or(AppError::Unauthorized)
    }
}

/// Optional actor, for endpoints that also serve anonymous callers.
pub struct MaybeActor(pub Option<Actor>);

impl FromRequestParts<AppState> for MaybeActor {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match Actor::from_request_parts(parts, state).await {
            Ok(a) => Ok(MaybeActor(Some(a))),
            Err(AppError::Unauthorized) => Ok(MaybeActor(None)),
            Err(e) => Err(e),
        }
    }
}
