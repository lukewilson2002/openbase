//! Storage of the OAuth authorization server: clients, pending authorization requests,
//! authorization codes, grants ("connected apps") and their access / refresh tokens.
//!
//! Every secret (codes, access and refresh tokens, client secrets) is stored as its SHA-256 hash,
//! like sessions and personal access tokens; the raw values are returned once, to the caller that
//! creates them. The protocol rules (what to check, which error to answer) live in
//! [`crate::oauth`]; this module only keeps the data consistent. Functions that change several
//! rows are meant to be called inside one write transaction.

use ob_core::api::oauth::{GrantBase, GrantInfo};
use rusqlite::{Connection, OptionalExtension, params};

use crate::auth::TokenScope;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::{hash_token, new_id, new_token};
use crate::oauth::scope;

/// Access tokens live one hour.
pub const ACCESS_TTL_MS: i64 = 3_600_000;
/// A refresh token expires 30 days after it was issued; every rotation issues a new one, so a
/// grant lapses after 30 idle days.
pub const REFRESH_TTL_MS: i64 = 30 * 24 * 3_600_000;
/// Authorization codes live 60 seconds.
pub const CODE_TTL_MS: i64 = 60_000;
/// A pending authorization request waits this long for the user.
pub const REQUEST_TTL_MS: i64 = 10 * 60_000;
/// Used codes are kept this long so that a replay can still be recognised (and the tokens issued
/// for the code revoked).
const USED_CODE_KEEP_MS: i64 = 24 * 3_600_000;
/// Clients that never completed anything are forgotten after this long.
pub const UNUSED_CLIENT_MS: i64 = 7 * 24 * 3_600_000;
/// Pending authorization requests the whole instance holds at most. Only a signed-in user can
/// create one, but the table still needs a ceiling.
pub const MAX_PENDING_REQUESTS: i64 = 5_000;
/// Pending authorization requests one client holds at most, so a single app (or one account
/// scripting a client of its own) cannot use up the instance-wide room.
pub const MAX_PENDING_PER_CLIENT: i64 = 200;
/// Self-registered (DCR) clients the instance holds at most. When the table is full the longest
/// unused client that nobody connected through is forgotten to make room, see [`make_room`].
pub const MAX_DCR_CLIENTS: i64 = 5_000;
/// Cached client metadata documents the instance holds at most (same rule as above).
pub const MAX_CIMD_CLIENTS: i64 = 5_000;
/// A refresh token that was exchanged is "just used" for this long: presenting it again in that
/// window is a client racing itself (two parallel refreshes) and is refused with `invalid_grant`
/// without revoking the connection. After the window it counts as theft.
pub const REFRESH_GRACE_MS: i64 = 30_000;
/// Connected apps one user can have.
pub const MAX_GRANTS_PER_USER: i64 = 100;

pub const SOURCE_DCR: &str = "dcr";
pub const SOURCE_CIMD: &str = "cimd";
pub const SOURCE_PREREGISTERED: &str = "preregistered";

/// Prefix of authorization codes.
pub const CODE_PREFIX: &str = "ocd";
/// Prefix of refresh tokens (access tokens use [`crate::auth::OAUTH_ACCESS_PREFIX`]).
pub const REFRESH_PREFIX: &str = "ort";
/// Prefix of client secrets.
pub const SECRET_PREFIX: &str = "ocs";

// ---------------------------------------------------------------------------------- clients

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub source: String,
    pub name: String,
    pub logo_uri: Option<String>,
    pub redirect_uris: Vec<String>,
    pub secret_hash: Option<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub fetched_at: Option<i64>,
}

impl Client {
    /// Confidential clients authenticate at the token endpoint with a secret.
    pub fn is_confidential(&self) -> bool {
        self.secret_hash.is_some()
    }
}

const CLIENT_COLS: &str =
    "id, source, name, logo_uri, redirect_uris, secret_hash, created_at, last_used_at, fetched_at";

fn client_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(Client, String)> {
    let uris: String = r.get(4)?;
    Ok((
        Client {
            id: r.get(0)?,
            source: r.get(1)?,
            name: r.get(2)?,
            logo_uri: r.get(3)?,
            redirect_uris: Vec::new(),
            secret_hash: r.get(5)?,
            created_at: r.get(6)?,
            last_used_at: r.get(7)?,
            fetched_at: r.get(8)?,
        },
        uris,
    ))
}

fn finish_client((mut c, uris): (Client, String)) -> AppResult<Client> {
    c.redirect_uris = serde_json::from_str(&uris)?;
    Ok(c)
}

pub fn client(conn: &Connection, id: &str) -> AppResult<Option<Client>> {
    conn.query_row(
        &format!("SELECT {CLIENT_COLS} FROM oauth_clients WHERE id = ?1"),
        [id],
        client_from_row,
    )
    .optional()?
    .map(finish_client)
    .transpose()
}

pub fn list_clients(conn: &Connection) -> AppResult<Vec<Client>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CLIENT_COLS} FROM oauth_clients ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([], client_from_row)?;
    rows.map(|r| finish_client(r?)).collect()
}

/// A public DCR client that was registered with exactly this fingerprint, if any: repeated
/// registrations of the same app (same name and redirect URIs) share one client.
pub fn client_by_fingerprint(conn: &Connection, fingerprint: &str) -> AppResult<Option<Client>> {
    conn.query_row(
        &format!(
            "SELECT {CLIENT_COLS} FROM oauth_clients
             WHERE fingerprint = ?1 AND source = 'dcr' AND secret_hash IS NULL LIMIT 1"
        ),
        [fingerprint],
        client_from_row,
    )
    .optional()?
    .map(finish_client)
    .transpose()
}

pub fn count_clients(conn: &Connection, source: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM oauth_clients WHERE source = ?1",
        [source],
        |r| r.get(0),
    )?)
}

/// Insert a client. `fingerprint` is the dedupe key of public DCR clients.
pub fn insert_client(conn: &Connection, c: &Client, fingerprint: Option<&str>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO oauth_clients
           (id, source, name, logo_uri, redirect_uris, secret_hash, fingerprint, created_at,
            last_used_at, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            c.id,
            c.source,
            c.name,
            c.logo_uri,
            serde_json::to_string(&c.redirect_uris)?,
            c.secret_hash,
            fingerprint,
            c.created_at,
            c.last_used_at,
            c.fetched_at,
        ],
    )?;
    Ok(())
}

/// Store (or refresh) the cached copy of a client's metadata document.
pub fn upsert_cimd_client(conn: &Connection, c: &Client) -> AppResult<()> {
    conn.execute(
        "INSERT INTO oauth_clients
           (id, source, name, logo_uri, redirect_uris, created_at, fetched_at)
         VALUES (?1, 'cimd', ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, logo_uri = excluded.logo_uri,
           redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at
         WHERE oauth_clients.source = 'cimd'",
        params![
            c.id,
            c.name,
            c.logo_uri,
            serde_json::to_string(&c.redirect_uris)?,
            now_ms(),
        ],
    )?;
    Ok(())
}

/// Make room for one more client of `source`: when the table already holds `max` of them, delete
/// the one that was used longest ago (never used: the oldest) among those nobody connected
/// through. Refusing instead would let a flood of registrations keep every real app out;
/// evicting only ever costs an unused client its registration. Fails (429) only when every
/// client has a connected app, which the per-user limit on connected apps makes unreachable
/// in practice.
pub fn make_room(conn: &Connection, source: &str, max: i64) -> AppResult<()> {
    if count_clients(conn, source)? < max {
        return Ok(());
    }
    let evicted = conn.execute(
        "DELETE FROM oauth_clients WHERE id = (
             SELECT c.id FROM oauth_clients c
             WHERE c.source = ?1
               AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
             ORDER BY COALESCE(c.last_used_at, c.created_at), c.created_at
             LIMIT 1)",
        [source],
    )?;
    if evicted == 0 {
        return Err(AppError::TooManyRequests);
    }
    Ok(())
}

/// Record that a client completed something (an authorization code was exchanged). Anonymous or
/// merely started authorization requests never call this, otherwise a stranger could keep
/// clients alive past the unused-client cleanup.
pub fn touch_client(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE oauth_clients SET last_used_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    Ok(())
}

/// Delete a client with its pending requests, codes and grants. Returns whether it existed.
pub fn delete_client(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.execute("DELETE FROM oauth_clients WHERE id = ?1", [id])? > 0)
}

pub fn new_client_id() -> String {
    new_id(ob_core::ids::OAUTH_CLIENT)
}

/// A new client secret and the hash to store.
pub fn new_client_secret() -> (String, String) {
    let secret = new_token(SECRET_PREFIX);
    let hash = hash_token(&secret);
    (secret, hash)
}

// ---------------------------------------------------------------------------------- requests

/// An authorization request the client made, waiting for the user's decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRequest {
    pub id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub state: Option<String>,
    pub resource: String,
    /// Space separated list of the known scopes the client asked for ('' = none).
    pub scope: String,
    pub created_at: i64,
    pub expires_at: i64,
}

pub fn create_request(
    conn: &Connection,
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: Option<&str>,
    resource: &str,
    scope: &str,
) -> AppResult<PendingRequest> {
    let now = now_ms();
    conn.execute("DELETE FROM oauth_requests WHERE expires_at <= ?1", [now])?;
    let pending: i64 = conn.query_row("SELECT count(*) FROM oauth_requests", [], |r| r.get(0))?;
    let of_client: i64 = conn.query_row(
        "SELECT count(*) FROM oauth_requests WHERE client_id = ?1",
        [client_id],
        |r| r.get(0),
    )?;
    if pending >= MAX_PENDING_REQUESTS || of_client >= MAX_PENDING_PER_CLIENT {
        return Err(AppError::TooManyRequests);
    }
    let req = PendingRequest {
        id: new_token(ob_core::ids::OAUTH_REQUEST),
        client_id: client_id.to_string(),
        redirect_uri: redirect_uri.to_string(),
        code_challenge: code_challenge.to_string(),
        state: state.map(str::to_string),
        resource: resource.to_string(),
        scope: scope.to_string(),
        created_at: now,
        expires_at: now + REQUEST_TTL_MS,
    };
    conn.execute(
        "INSERT INTO oauth_requests
           (id, client_id, redirect_uri, code_challenge, state, resource, scope, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            req.id,
            req.client_id,
            req.redirect_uri,
            req.code_challenge,
            req.state,
            req.resource,
            req.scope,
            req.created_at,
            req.expires_at
        ],
    )?;
    Ok(req)
}

/// A pending request that has not expired.
pub fn request(conn: &Connection, id: &str) -> AppResult<Option<PendingRequest>> {
    Ok(conn
        .query_row(
            "SELECT id, client_id, redirect_uri, code_challenge, state, resource, scope,
                    created_at, expires_at
             FROM oauth_requests WHERE id = ?1 AND expires_at > ?2",
            params![id, now_ms()],
            |r| {
                Ok(PendingRequest {
                    id: r.get(0)?,
                    client_id: r.get(1)?,
                    redirect_uri: r.get(2)?,
                    code_challenge: r.get(3)?,
                    state: r.get(4)?,
                    resource: r.get(5)?,
                    scope: r.get(6)?,
                    created_at: r.get(7)?,
                    expires_at: r.get(8)?,
                })
            },
        )
        .optional()?)
}

pub fn delete_request(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM oauth_requests WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------------- codes

/// An authorization code that was just redeemed for the first time.
#[derive(Debug, Clone)]
pub struct RedeemedCode {
    pub client_id: String,
    pub user_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub resource: String,
    pub scope: TokenScope,
}

/// What presenting an authorization code leads to.
#[derive(Debug)]
pub enum Redeem {
    /// First use of a valid code. The code is now burned.
    Fresh(RedeemedCode),
    /// The code was used before: the grant created from it (if any) must be revoked.
    Replayed {
        grant_id: Option<String>,
    },
    Expired,
    /// No such code for this client.
    Unknown,
}

/// Create the authorization code for an approved request. Returns the raw code.
pub fn create_code(
    conn: &Connection,
    client_id: &str,
    user_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    resource: &str,
    scope: &TokenScope,
) -> AppResult<String> {
    let code = new_token(CODE_PREFIX);
    let now = now_ms();
    conn.execute(
        "INSERT INTO oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scopes,
            created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            hash_token(&code),
            client_id,
            user_id,
            redirect_uri,
            code_challenge,
            resource,
            serde_json::to_string(scope)?,
            now,
            now + CODE_TTL_MS
        ],
    )?;
    Ok(code)
}

/// Present `code` on behalf of `client_id`. A valid code is burned (marked used) here, before
/// anything else is checked: a request that then fails PKCE or redirect URI validation has still
/// spent it, so a stolen code gets one try.
pub fn redeem_code(conn: &Connection, code: &str, client_id: &str) -> AppResult<Redeem> {
    let hash = hash_token(code);
    let now = now_ms();
    let row = conn
        .query_row(
            "SELECT client_id, user_id, redirect_uri, code_challenge, resource, scopes,
                    expires_at, used_at, grant_id
             FROM oauth_codes WHERE code_hash = ?1",
            [&hash],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?;
    let Some((
        cid,
        user_id,
        redirect_uri,
        code_challenge,
        resource,
        scopes,
        expires_at,
        used,
        grant_id,
    )) = row
    else {
        return Ok(Redeem::Unknown);
    };
    if cid != client_id {
        return Ok(Redeem::Unknown);
    }
    if used.is_some() {
        return Ok(Redeem::Replayed { grant_id });
    }
    if expires_at <= now {
        return Ok(Redeem::Expired);
    }
    conn.execute(
        "UPDATE oauth_codes SET used_at = ?1 WHERE code_hash = ?2",
        params![now, hash],
    )?;
    Ok(Redeem::Fresh(RedeemedCode {
        client_id: cid,
        user_id,
        redirect_uri,
        code_challenge,
        resource,
        scope: serde_json::from_str(&scopes)?,
    }))
}

/// Remember which grant a redeemed code produced.
pub fn link_code_to_grant(conn: &Connection, code: &str, grant_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE oauth_codes SET grant_id = ?1 WHERE code_hash = ?2",
        params![grant_id, hash_token(code)],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------- grants

/// Tokens handed to a client.
#[derive(Debug, Clone)]
pub struct Issued {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in_secs: i64,
    pub scope: String,
}

/// Create a grant for a user. Fails with a message the user can act on when they have too many.
pub fn create_grant(
    conn: &Connection,
    user_id: &str,
    client_id: &str,
    redirect_uri: &str,
    resource: &str,
    scope: &TokenScope,
) -> AppResult<String> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM oauth_grants WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )?;
    if n >= MAX_GRANTS_PER_USER {
        return Err(AppError::bad_request(format!(
            "you have {MAX_GRANTS_PER_USER} connected apps; revoke some before connecting another"
        )));
    }
    let id = new_id(ob_core::ids::OAUTH_GRANT);
    conn.execute(
        "INSERT INTO oauth_grants (id, user_id, client_id, redirect_uri, resource, scopes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            user_id,
            client_id,
            redirect_uri,
            resource,
            serde_json::to_string(scope)?,
            now_ms()
        ],
    )?;
    Ok(id)
}

/// Issue a new access / refresh token pair for a grant.
pub fn issue_tokens(conn: &Connection, grant_id: &str) -> AppResult<Issued> {
    let now = now_ms();
    // Housekeeping for this grant: expired access tokens and rotated refresh tokens that are
    // past their expiry (a reuse of those can no longer be told from a random guess).
    conn.execute(
        "DELETE FROM oauth_tokens WHERE grant_id = ?1 AND expires_at <= ?2",
        params![grant_id, now],
    )?;
    let scopes: String = conn.query_row(
        "SELECT scopes FROM oauth_grants WHERE id = ?1",
        [grant_id],
        |r| r.get(0),
    )?;
    let scope: TokenScope = serde_json::from_str(&scopes)?;
    let access = new_token(crate::auth::OAUTH_ACCESS_PREFIX);
    let refresh = new_token(REFRESH_PREFIX);
    for (token, kind, ttl) in [
        (&access, "access", ACCESS_TTL_MS),
        (&refresh, "refresh", REFRESH_TTL_MS),
    ] {
        conn.execute(
            "INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash_token(token), grant_id, kind, now, now + ttl],
        )?;
    }
    Ok(Issued {
        access_token: access,
        refresh_token: refresh,
        expires_in_secs: ACCESS_TTL_MS / 1000,
        scope: scope::scope_string(&scope),
    })
}

/// What presenting a refresh token leads to.
#[derive(Debug)]
pub enum Refresh {
    /// The token was valid and has been exchanged for a new pair.
    Issued { grant_id: String, tokens: Issued },
    /// The token had been exchanged before: the whole grant was revoked.
    Reused { grant_id: String, user_id: String },
    /// The token was exchanged a moment ago ([`REFRESH_GRACE_MS`]): a client racing itself.
    /// Nothing is issued and nothing is revoked.
    JustUsed,
    /// Unknown, expired, issued to another client, or its grant no longer works.
    Invalid,
}

/// Exchange a refresh token for a new pair (rotation). The presented token is marked used; a
/// second presentation revokes the grant. `client_id` must be the client the grant belongs to.
pub fn rotate_refresh(conn: &Connection, token: &str, client_id: &str) -> AppResult<Refresh> {
    let hash = hash_token(token);
    let now = now_ms();
    let row = conn
        .query_row(
            "SELECT t.grant_id, t.expires_at, t.used_at, g.client_id, g.user_id, u.is_active
             FROM oauth_tokens t
             JOIN oauth_grants g ON g.id = t.grant_id
             JOIN users u ON u.id = g.user_id
             WHERE t.token_hash = ?1 AND t.kind = 'refresh'",
            [&hash],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((grant_id, expires_at, used_at, owner, user_id, active)) = row else {
        return Ok(Refresh::Invalid);
    };
    if owner != client_id {
        return Ok(Refresh::Invalid);
    }
    if let Some(used) = used_at {
        if now - used <= REFRESH_GRACE_MS {
            return Ok(Refresh::JustUsed);
        }
        revoke_grant(conn, &grant_id)?;
        return Ok(Refresh::Reused { grant_id, user_id });
    }
    if expires_at <= now || !active {
        return Ok(Refresh::Invalid);
    }
    conn.execute(
        "UPDATE oauth_tokens SET used_at = ?1 WHERE token_hash = ?2",
        params![now, hash],
    )?;
    let tokens = issue_tokens(conn, &grant_id)?;
    Ok(Refresh::Issued { grant_id, tokens })
}

/// Delete a grant with all its tokens. Returns whether it existed.
pub fn revoke_grant(conn: &Connection, grant_id: &str) -> AppResult<bool> {
    Ok(conn.execute("DELETE FROM oauth_grants WHERE id = ?1", [grant_id])? > 0)
}

/// Delete every grant of a user, and the authorization codes they approved but nobody has
/// redeemed yet (password change or reset, enabling two-factor, signing out other sessions,
/// deactivation: access obtained before such a change must not outlive it, and a code is access
/// that has not been cashed in). Returns how many grants were deleted.
pub fn revoke_all_for_user(conn: &Connection, user_id: &str) -> AppResult<usize> {
    conn.execute(
        "DELETE FROM oauth_codes WHERE user_id = ?1 AND used_at IS NULL",
        [user_id],
    )?;
    Ok(conn.execute("DELETE FROM oauth_grants WHERE user_id = ?1", [user_id])?)
}

/// RFC 7009: revoke the grant behind `token` (an access or a refresh token), if it belongs to
/// `client_id`. Returns the revoked grant and its user.
pub fn revoke_by_token(
    conn: &Connection,
    token: &str,
    client_id: &str,
) -> AppResult<Option<(String, String)>> {
    let row = conn
        .query_row(
            "SELECT g.id, g.user_id FROM oauth_tokens t
             JOIN oauth_grants g ON g.id = t.grant_id
             WHERE t.token_hash = ?1 AND g.client_id = ?2",
            params![hash_token(token), client_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((grant_id, _)) = &row {
        revoke_grant(conn, grant_id)?;
    }
    Ok(row)
}

/// The owner of a grant, if it exists (for audit entries).
pub fn grant_owner(conn: &Connection, grant_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT user_id FROM oauth_grants WHERE id = ?1",
            [grant_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// A grant as listed on the account and admin pages. `user_id` None = every user (admin).
pub fn list_grants(conn: &Connection, user_id: Option<&str>) -> AppResult<Vec<GrantInfo>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.scopes, g.created_at, g.last_used_at, c.name, c.source, g.redirect_uri,
                u.email, u.name,
                COALESCE((SELECT max(t.expires_at) FROM oauth_tokens t
                          WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.used_at IS NULL),
                         g.created_at)
         FROM oauth_grants g
         JOIN oauth_clients c ON c.id = g.client_id
         JOIN users u ON u.id = g.user_id
         WHERE (?1 IS NULL OR g.user_id = ?1)
         ORDER BY g.created_at DESC, g.id",
    )?;
    let rows = stmt.query_map([user_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, i64>(9)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            scopes,
            created_at,
            last_used_at,
            client_name,
            source,
            redirect_uri,
            email,
            user_name,
            until,
        ) = row?;
        let scope: TokenScope = serde_json::from_str(&scopes)?;
        let bases = match scope.base_ids {
            None => None,
            Some(ids) => {
                let mut named = Vec::new();
                for id in ids {
                    let name: Option<String> = conn
                        .query_row("SELECT name FROM bases WHERE id = ?1", [&id], |r| r.get(0))
                        .optional()?;
                    named.push(GrantBase {
                        name: name.unwrap_or_else(|| id.clone()),
                        id,
                    });
                }
                Some(named)
            }
        };
        out.push(GrantInfo {
            id,
            client_name: crate::oauth::redirect::display_name(&client_name),
            client_source: source,
            redirect_host: crate::oauth::redirect::host_label(&redirect_uri),
            write: scope.write,
            manage: scope.manage && scope.write,
            bases,
            created_at,
            last_used_at,
            expires_at: until,
            user_email: user_id.is_none().then_some(email),
            user_name: user_id.is_none().then_some(user_name),
        });
    }
    Ok(out)
}

/// What a garbage collection removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcStats {
    pub requests: usize,
    pub codes: usize,
    pub tokens: usize,
    pub grants: usize,
    pub clients: usize,
}

/// Remove what can no longer be used: expired requests, codes and tokens, grants whose last
/// refresh token has expired, and clients that were never used (nothing connected through them)
/// for [`UNUSED_CLIENT_MS`].
pub fn gc(conn: &Connection, now: i64) -> AppResult<GcStats> {
    let requests = conn.execute("DELETE FROM oauth_requests WHERE expires_at <= ?1", [now])?;
    let codes = conn.execute(
        "DELETE FROM oauth_codes WHERE expires_at <= ?1",
        [now - USED_CODE_KEEP_MS],
    )?;
    let tokens = conn.execute("DELETE FROM oauth_tokens WHERE expires_at <= ?1", [now])?;
    let grants = conn.execute(
        "DELETE FROM oauth_grants
         WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t
                           WHERE t.grant_id = oauth_grants.id AND t.kind = 'refresh'
                             AND t.used_at IS NULL AND t.expires_at > ?1)
           AND created_at < ?1 - 60000",
        [now],
    )?;
    let clients = conn.execute(
        "DELETE FROM oauth_clients
         WHERE source IN ('dcr', 'cimd')
           AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
           AND COALESCE(last_used_at, created_at) < ?1",
        [now - UNUSED_CLIENT_MS],
    )?;
    Ok(GcStats {
        requests,
        codes,
        tokens,
        grants,
        clients,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Connection, String, Client) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::db::migrate(&c).unwrap();
        let user = crate::store::users::create(&c, "a@example.com", "A", "!", false).unwrap();
        let client = Client {
            id: new_client_id(),
            source: SOURCE_DCR.into(),
            name: "App".into(),
            logo_uri: None,
            redirect_uris: vec!["https://app.example/cb".into()],
            secret_hash: None,
            created_at: now_ms(),
            last_used_at: None,
            fetched_at: None,
        };
        insert_client(&c, &client, None).unwrap();
        (c, user, client)
    }

    fn scope() -> TokenScope {
        TokenScope {
            write: true,
            manage: false,
            base_ids: None,
        }
    }

    const CB: &str = "https://app.example/cb";

    #[test]
    fn codes_are_single_use_and_bound_to_a_client() {
        let (c, user, client) = db();
        let code = create_code(&c, &client.id, &user, CB, "chal", "res", &scope()).unwrap();
        assert!(matches!(
            redeem_code(&c, &code, "oclOther").unwrap(),
            Redeem::Unknown
        ));
        let Redeem::Fresh(row) = redeem_code(&c, &code, &client.id).unwrap() else {
            panic!("first use is fresh");
        };
        assert_eq!(row.redirect_uri, CB);
        assert_eq!(row.scope, scope());
        assert!(matches!(
            redeem_code(&c, &code, &client.id).unwrap(),
            Redeem::Replayed { grant_id: None }
        ));
        assert!(matches!(
            redeem_code(&c, "ocdNope", &client.id).unwrap(),
            Redeem::Unknown
        ));
        // Expired codes are not redeemable.
        let code = create_code(&c, &client.id, &user, CB, "chal", "res", &scope()).unwrap();
        c.execute(
            "UPDATE oauth_codes SET expires_at = 1 WHERE used_at IS NULL",
            [],
        )
        .unwrap();
        assert!(matches!(
            redeem_code(&c, &code, &client.id).unwrap(),
            Redeem::Expired
        ));
    }

    #[test]
    fn refresh_rotation_and_reuse() {
        let (c, user, client) = db();
        let grant = create_grant(&c, &user, &client.id, CB, "res", &scope()).unwrap();
        let first = issue_tokens(&c, &grant).unwrap();
        assert_eq!(first.scope, "openbase:read openbase:write");
        let Refresh::Issued { tokens: second, .. } =
            rotate_refresh(&c, &first.refresh_token, &client.id).unwrap()
        else {
            panic!("rotation");
        };
        assert_ne!(second.refresh_token, first.refresh_token);
        // A second presentation right away is a client racing itself: refused, not revoked.
        assert!(matches!(
            rotate_refresh(&c, &first.refresh_token, &client.id).unwrap(),
            Refresh::JustUsed
        ));
        // Reuse after the grace window revokes everything of the grant.
        c.execute(
            "UPDATE oauth_tokens SET used_at = used_at - ?1 WHERE used_at IS NOT NULL",
            [REFRESH_GRACE_MS + 1],
        )
        .unwrap();
        assert!(matches!(
            rotate_refresh(&c, &first.refresh_token, &client.id).unwrap(),
            Refresh::Reused { .. }
        ));
        assert!(matches!(
            rotate_refresh(&c, &second.refresh_token, &client.id).unwrap(),
            Refresh::Invalid
        ));
        let n: i64 = c
            .query_row("SELECT count(*) FROM oauth_tokens", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn garbage_collection_keeps_what_is_alive() {
        let (c, user, client) = db();
        let now = now_ms();
        // Alive: a grant with tokens, a pending request, a fresh code.
        let live = create_grant(&c, &user, &client.id, CB, "res", &scope()).unwrap();
        issue_tokens(&c, &live).unwrap();
        create_request(&c, &client.id, CB, "chal", None, "res", "").unwrap();
        create_code(&c, &client.id, &user, CB, "chal", "res", &scope()).unwrap();
        assert_eq!(gc(&c, now).unwrap(), GcStats::default());

        // Dead: a grant whose refresh token has expired, with its tokens; an old request and code.
        let dead = create_grant(&c, &user, &client.id, CB, "res", &scope()).unwrap();
        issue_tokens(&c, &dead).unwrap();
        c.execute(
            "UPDATE oauth_tokens SET expires_at = 1 WHERE grant_id = ?1",
            [&dead],
        )
        .unwrap();
        c.execute(
            "UPDATE oauth_grants SET created_at = 1 WHERE id = ?1",
            [&dead],
        )
        .unwrap();
        c.execute("UPDATE oauth_requests SET expires_at = 1", [])
            .unwrap();
        c.execute("UPDATE oauth_codes SET expires_at = 1", [])
            .unwrap();
        let stats = gc(&c, now).unwrap();
        assert_eq!(stats.requests, 1);
        assert_eq!(stats.tokens, 2);
        assert_eq!(stats.grants, 1);
        assert_eq!(stats.codes, 1, "expired and long past the replay window");
        let n: i64 = c
            .query_row("SELECT count(*) FROM oauth_grants", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        // The used client stays because it has a grant; an unused one goes after a week.
        let idle = Client {
            id: new_client_id(),
            ..client.clone()
        };
        insert_client(&c, &idle, None).unwrap();
        c.execute(
            "UPDATE oauth_clients SET created_at = 1 WHERE id = ?1",
            [&idle.id],
        )
        .unwrap();
        assert_eq!(gc(&c, now).unwrap().clients, 1);
        assert!(super::client(&c, &client.id).unwrap().is_some());
        assert!(super::client(&c, &idle.id).unwrap().is_none());
    }
}
