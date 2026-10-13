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
    /// Whether the token may also do account-level management a signed-in user can do in the
    /// web app (workspaces, members, invites, deleting bases, the admin pages when the user is
    /// an administrator). Only meaningful together with `write`; see [`Capability`].
    #[serde(default)]
    pub manage: bool,
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
    /// SHA-256 of the API token when authenticated by token (so long-lived
    /// connections can notice the token being revoked or expiring).
    pub token_hash: Option<String>,
    /// Id of the API token (for audit entries), when authenticated by token.
    pub token_id: Option<String>,
}

/// What an endpoint needs beyond a role, checked with [`Actor::require_capability`]. Sessions
/// (the web app) have every capability; API tokens only the ones their scope grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// Account-level actions a user can do in the UI: tokens need `manage` (and `write`).
    /// Per-base limits of the token still apply through `perm::require_base`.
    Manage,
    /// Like [`Capability::Manage`], for actions that reach beyond a single base (workspaces,
    /// workspace members and invites, the admin pages): also refused for tokens limited to
    /// specific bases, because such a token must not be able to touch what it cannot see.
    ManageUnscoped,
    /// Never available to a token, whatever its scope: credentials, 2FA, sessions and the
    /// token list itself. A leaked token must not be able to take over the account.
    SessionOnly,
}

impl Actor {
    /// The one place token capabilities are decided (see [`Capability`]). Sessions always pass.
    pub fn require_capability(&self, cap: Capability) -> AppResult<()> {
        let Some(scope) = &self.token_scope else {
            return Ok(());
        };
        match cap {
            Capability::SessionOnly => Err(AppError::forbidden(
                "API tokens can never use this endpoint (it changes credentials, sessions or \
                 tokens); sign in to the web app instead",
            )),
            Capability::Manage | Capability::ManageUnscoped => {
                if !(scope.manage && scope.write) {
                    return Err(AppError::forbidden(
                        "this action needs an API token with the 'manage' permission (create one \
                         in the account page with \"Allow managing workspaces, members and \
                         settings\")",
                    ));
                }
                if cap == Capability::ManageUnscoped && scope.base_ids.is_some() {
                    return Err(AppError::forbidden(
                        "this action reaches beyond single bases, so it is not available to an \
                         API token that is limited to specific bases",
                    ));
                }
                Ok(())
            }
        }
    }

    /// Instance administrator: signed in, or a token with the `manage` permission whose user is
    /// an administrator. Not an audited check; admin handlers use [`admin_guard`].
    pub fn require_admin(&self) -> AppResult<()> {
        if !self.is_admin {
            return Err(AppError::forbidden("administrator access required"));
        }
        self.require_capability(Capability::ManageUnscoped)
    }
}

/// [`Actor::require_admin`] for admin endpoints, plus an audit entry whenever a token (rather
/// than a session) is what got the administrator in, so usage of `manage` tokens on the admin
/// pages is always traceable. `what` names the operation, e.g. `GET /api/admin/users`.
pub async fn admin_guard(
    state: &AppState,
    actor: &Actor,
    client: &ClientInfo,
    what: &str,
) -> AppResult<()> {
    actor.require_admin()?;
    if let Some(token_id) = &actor.token_id {
        let (user_id, token_id, ip, what) = (
            actor.user_id.clone(),
            token_id.clone(),
            client.ip.clone(),
            what.to_string(),
        );
        state
            .db
            .write(move |tx| {
                crate::store::audit::record(
                    tx,
                    Some(&user_id),
                    crate::store::audit::actions::ADMIN_TOKEN_USE,
                    Some(&token_id),
                    Some(serde_json::json!({ "request": what })),
                    Some(&ip),
                )
            })
            .await?;
    }
    Ok(())
}

/// Where a request came from, for audit entries, sessions and rate limits.
#[derive(Debug, Clone)]
pub struct ClientInfo {
    /// Client IP: the last `X-Forwarded-For` entry (the one the trusted proxy
    /// added) when `trust_proxy` is on, else the TCP peer address, else
    /// `"unknown"` (in-process tests).
    pub ip: String,
    pub user_agent: Option<String>,
}

/// Compute the client IP from the request parts (see [`ClientInfo::ip`]).
pub fn client_ip(parts: &Parts, trust_proxy: bool) -> String {
    if trust_proxy {
        // Entries left of the last one may have been written by the client; a
        // proxy that appends (nginx) or overwrites (Caddy) makes the last
        // entry the address it actually saw.
        let forwarded = parts
            .headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
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
        token_hash: None,
        token_id: None,
    }))
}

/// `last_used_at` of an API token is refreshed at most this often, so a busy
/// integration does not queue a write on the single writer for every request.
const LAST_USED_GRANULARITY_MS: i64 = 60_000;

/// Resolve an API token (`pat...`) to an actor.
pub fn actor_from_api_token(conn: &Connection, token: &str) -> AppResult<Option<Actor>> {
    Ok(lookup_api_token(conn, token)?.map(|(actor, _)| actor))
}

/// Like [`actor_from_api_token`], also returning the token's `last_used_at`
/// (for [`stamp_token_use`]).
pub fn lookup_api_token(conn: &Connection, token: &str) -> AppResult<Option<(Actor, Option<i64>)>> {
    let hash = hash_token(token);
    let now = now_ms();
    let row = conn
        .query_row(
            "SELECT u.id, u.name, u.email, u.is_admin, t.scopes, t.expires_at, t.last_used_at, t.id
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
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((user_id, name, email, is_admin, scopes, expires_at, last_used_at, token_id)) = row
    else {
        return Ok(None);
    };
    if expires_at.is_some_and(|e| e <= now) {
        return Ok(None);
    }
    let scope: TokenScope = serde_json::from_str(&scopes)?;
    Ok(Some((
        Actor {
            user_id,
            name,
            email,
            is_admin,
            token_scope: Some(scope),
            session_hash: None,
            token_hash: Some(hash),
            token_id: Some(token_id),
        },
        last_used_at,
    )))
}

/// Best-effort usage stamp for the token behind `actor`, at most once a minute
/// per token: when the `last_used_at` read with the token is recent there is no
/// write at all, and the update re-checks so concurrent requests stamp once.
/// Never fails the request. Shared by the [`Actor`] extractor and `/api/v1`.
pub async fn stamp_token_use(state: &AppState, actor: &Actor, last_used_at: Option<i64>) {
    let Some(hash) = actor.token_hash.clone() else {
        return;
    };
    let now = now_ms();
    if last_used_at.is_some_and(|t| t >= now - LAST_USED_GRANULARITY_MS) {
        return;
    }
    let id = actor.user_id.clone();
    let _ = state
        .db
        .write(move |tx| {
            tx.execute(
                "UPDATE api_tokens SET last_used_at = ?1
                 WHERE token_hash = ?2 AND user_id = ?3
                   AND (last_used_at IS NULL OR last_used_at < ?4)",
                rusqlite::params![now, hash, id, now - LAST_USED_GRANULARITY_MS],
            )?;
            Ok(())
        })
        .await;
}

/// The token of an `Authorization: Bearer <token>` header. Any other
/// `Authorization` value is ignored (the request is then judged by its
/// cookie, and so is subject to the CSRF check).
pub(crate) fn bearer_from_headers(headers: &axum::http::HeaderMap) -> Option<&str> {
    let v = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    v.strip_prefix("Bearer ").map(str::trim)
}

pub(crate) fn bearer(parts: &Parts) -> Option<&str> {
    bearer_from_headers(&parts.headers)
}

/// POST routes that only read, so read-only tokens may call them (matched
/// route patterns).
const READ_ONLY_POSTS: &[&str] = &["/api/views/{id}/query"];

/// A read-only API token acts as a Viewer and may only read: refuse every
/// state-changing request here, in the one place all authenticated routes
/// pass through, instead of relying on each handler to ask for a role above
/// Viewer (several act on the caller's own data at Viewer level: deleting
/// their comments or personal views, marking notifications read).
fn enforce_read_only(parts: &Parts, actor: &Actor) -> AppResult<()> {
    let Some(scope) = &actor.token_scope else {
        return Ok(());
    };
    if scope.write || matches!(parts.method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return Ok(());
    }
    let route = parts
        .extensions
        .get::<axum::extract::MatchedPath>()
        .map(|m| m.as_str());
    if route.is_some_and(|r| READ_ONLY_POSTS.contains(&r)) {
        return Ok(());
    }
    Err(AppError::forbidden(
        "this API token is read-only; use a token with write access",
    ))
}

impl FromRequestParts<AppState> for Actor {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(token) = bearer(parts) {
            let token = token.to_string();
            let found = state.db.read(move |c| lookup_api_token(c, &token)).await?;
            if let Some((a, last_used_at)) = &found {
                enforce_read_only(parts, a)?;
                stamp_token_use(state, a, *last_used_at).await;
            }
            return found.map(|(a, _)| a).ok_or(AppError::Unauthorized);
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
