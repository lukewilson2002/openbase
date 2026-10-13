//! `POST /oauth/token` (authorization code and refresh token grants) and `POST /oauth/revoke`
//! (RFC 7009).
//!
//! Authorization codes are single use. A code is burned the moment it is presented, so even a
//! request that then fails PKCE or redirect URI validation has spent it, and a second
//! presentation of a code that was already exchanged revokes the grant created from it (RFC 6749
//! 4.1.2). Refresh tokens rotate on every use; presenting one that was already exchanged revokes
//! the whole grant (RFC 9700 4.14), because either the client or an attacker holds a stale copy.
//! The exception is a short grace window ([`store::REFRESH_GRACE_MS`]): a client that fires two
//! refreshes at once (two tabs, two workers) would otherwise destroy its own connection, so the
//! second one is refused with `invalid_grant` and nothing is revoked; the first one's answer is
//! the live pair. A refresh may repeat the grant's scope but not ask for less (the server keeps
//! one scope per connection) and never for more.
//! Failed checks are reported as `invalid_grant` without saying which one failed.

use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::{MAX_BODY_BYTES, OAuthError, no_store, normalize_resource, parse_params, scope};
use crate::auth::ClientInfo;
use crate::error::AppError;
use crate::ids::hash_token;
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::oauth::{self as store, Client, Issued, Redeem, Refresh};

/// Token requests one client address may make per minute.
pub const REQUESTS_PER_IP_PER_MINUTE: u32 = 300;

type Params = std::collections::HashMap<String, String>;

/// PKCE (RFC 7636): the verifier is 43 to 128 characters of `[A-Za-z0-9-._~]`, and the challenge
/// stored with the code must equal `BASE64URL(SHA256(verifier))`.
pub fn verifier_matches(verifier: &str, challenge: &str) -> bool {
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
    {
        return false;
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    expected.as_bytes().ct_eq(challenge.as_bytes()).into()
}

async fn read_form(
    state: &AppState,
    client: &ClientInfo,
    bucket: &'static str,
    headers: &HeaderMap,
    body: Body,
) -> Result<Params, OAuthError> {
    if !state.config.oauth_enabled() {
        return Err(OAuthError::disabled());
    }
    state.limiter.check(
        bucket,
        &super::rate_key(&client.ip),
        REQUESTS_PER_IP_PER_MINUTE,
        Duration::from_secs(60),
    )?;
    let is_form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/x-www-form-urlencoded")
        });
    if !is_form {
        return Err(OAuthError::invalid_request(
            "send the parameters as application/x-www-form-urlencoded",
        ));
    }
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| OAuthError::invalid_request("the request body is too large"))?;
    parse_params(&bytes)
}

/// Identify the client (RFC 6749 2.3): public clients by `client_id` alone, confidential ones
/// (added with a secret) also by `client_secret`.
async fn authenticate_client(state: &AppState, params: &Params) -> Result<Client, OAuthError> {
    let Some(client_id) = params.get("client_id").filter(|s| !s.is_empty()) else {
        return Err(OAuthError::invalid_request("client_id is required"));
    };
    let id = client_id.clone();
    let Some(client) = state.db.read(move |c| store::client(c, &id)).await? else {
        return Err(OAuthError::invalid_client("unknown client"));
    };
    if let Some(expected) = &client.secret_hash {
        let ok = params.get("client_secret").is_some_and(|secret| {
            hash_token(secret)
                .as_bytes()
                .ct_eq(expected.as_bytes())
                .into()
        });
        if !ok {
            return Err(OAuthError::invalid_client(
                "client authentication failed: send the client_secret",
            ));
        }
    }
    Ok(client)
}

fn token_response(issued: &Issued) -> Response {
    let body = json!({
        "access_token": issued.access_token,
        "token_type": "Bearer",
        "expires_in": issued.expires_in_secs,
        "refresh_token": issued.refresh_token,
        "scope": issued.scope,
    });
    let mut res = axum::Json(body).into_response();
    no_store(&mut res);
    res
}

/// What a token request leads to inside its transaction. Failures are `Ok` values on purpose:
/// the transaction must commit what the failure itself changed (a burned code, a revoked grant).
enum Outcome {
    Issued(Box<Issued>),
    Failed(OAuthError),
}

fn failed(e: OAuthError) -> Result<Outcome, AppError> {
    Ok(Outcome::Failed(e))
}

/// `POST /oauth/token`.
pub async fn token(
    State(state): State<AppState>,
    client_info: ClientInfo,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, OAuthError> {
    let params = read_form(&state, &client_info, "oauth_token", &headers, body).await?;
    let grant_type = params.get("grant_type").map(String::as_str).unwrap_or("");
    if !matches!(grant_type, "authorization_code" | "refresh_token") {
        return Err(OAuthError::new(
            "unsupported_grant_type",
            "supported grant types: authorization_code, refresh_token",
        ));
    }
    let client = authenticate_client(&state, &params).await?;
    let resource = state.config.mcp_resource();
    if let Some(requested) = params.get("resource")
        && normalize_resource(requested) != resource
    {
        return Err(OAuthError::new(
            "invalid_target",
            format!("this server issues tokens for {resource} only"),
        ));
    }
    let ip = client_info.ip.clone();

    let outcome = if grant_type == "authorization_code" {
        let (Some(code), Some(redirect_uri), Some(verifier)) = (
            params.get("code").cloned(),
            params.get("redirect_uri").cloned(),
            params.get("code_verifier").cloned(),
        ) else {
            return Err(OAuthError::invalid_request(
                "code, redirect_uri and code_verifier are required",
            ));
        };
        state
            .db
            .write(move |tx| exchange_code(tx, &client, &code, &redirect_uri, &verifier, &ip))
            .await?
    } else {
        let Some(refresh_token) = params.get("refresh_token").cloned() else {
            return Err(OAuthError::invalid_request("refresh_token is required"));
        };
        let requested_scope = params.get("scope").cloned();
        state
            .db
            .write(move |tx| refresh(tx, &client, &refresh_token, requested_scope.as_deref(), &ip))
            .await
            .map_err(|e| match e {
                // `refresh` refuses a scope wider than the grant this way.
                AppError::BadRequest(m) => OAuthError::new("invalid_scope", m),
                other => other.into(),
            })?
    };
    match outcome {
        Outcome::Issued(issued) => Ok(token_response(&issued)),
        Outcome::Failed(e) => Err(e),
    }
}

fn exchange_code(
    tx: &rusqlite::Transaction<'_>,
    client: &Client,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    ip: &str,
) -> Result<Outcome, AppError> {
    let grant_error = || OAuthError::invalid_grant("the authorization code is invalid or expired");
    let code_row = match store::redeem_code(tx, code, &client.id)? {
        Redeem::Unknown | Redeem::Expired => return failed(grant_error()),
        Redeem::Replayed { grant_id } => {
            if let Some(grant_id) = grant_id {
                let owner = store::grant_owner(tx, &grant_id)?;
                if store::revoke_grant(tx, &grant_id)? {
                    audit::record(
                        tx,
                        owner.as_deref(),
                        actions::OAUTH_CODE_REPLAY,
                        Some(&grant_id),
                        Some(json!({ "client": client.name, "client_id": client.id })),
                        Some(ip),
                    )?;
                }
            }
            return failed(grant_error());
        }
        Redeem::Fresh(row) => row,
    };
    // The code is burned from here on, whatever else fails.
    if code_row.redirect_uri != redirect_uri
        || !verifier_matches(verifier, &code_row.code_challenge)
    {
        return failed(grant_error());
    }
    let active: bool = tx
        .query_row(
            "SELECT is_active FROM users WHERE id = ?1",
            [&code_row.user_id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !active {
        return failed(grant_error());
    }
    let grant_id = match store::create_grant(
        tx,
        &code_row.user_id,
        &client.id,
        &code_row.redirect_uri,
        &code_row.resource,
        &code_row.scope,
    ) {
        Ok(id) => id,
        Err(AppError::BadRequest(message)) => return failed(OAuthError::invalid_grant(message)),
        Err(e) => return Err(e),
    };
    store::link_code_to_grant(tx, code, &grant_id)?;
    let issued = store::issue_tokens(tx, &grant_id)?;
    store::touch_client(tx, &client.id)?;
    audit::record(
        tx,
        Some(&code_row.user_id),
        actions::OAUTH_GRANT_CREATE,
        Some(&grant_id),
        Some(json!({
            "client": client.name,
            "client_id": client.id,
            "source": client.source,
            "redirect_host": super::redirect::host_label(&code_row.redirect_uri),
            "write": code_row.scope.write,
            "manage": code_row.scope.manage,
            "base_ids": code_row.scope.base_ids,
        })),
        Some(ip),
    )?;
    Ok(Outcome::Issued(Box::new(issued)))
}

fn refresh(
    tx: &rusqlite::Transaction<'_>,
    client: &Client,
    token: &str,
    requested_scope: Option<&str>,
    ip: &str,
) -> Result<Outcome, AppError> {
    match store::rotate_refresh(tx, token, &client.id)? {
        Refresh::Invalid => failed(OAuthError::invalid_grant(
            "the refresh token is invalid or expired",
        )),
        Refresh::JustUsed => failed(OAuthError::invalid_grant(
            "the refresh token was just exchanged; use the tokens issued for that request",
        )),
        Refresh::Reused { grant_id, user_id } => {
            audit::record(
                tx,
                Some(&user_id),
                actions::OAUTH_REFRESH_REUSE,
                Some(&grant_id),
                Some(json!({ "client": client.name, "client_id": client.id })),
                Some(ip),
            )?;
            failed(OAuthError::invalid_grant(
                "the refresh token was already used; the connection has been revoked and the app \
                 must be connected again",
            ))
        }
        Refresh::Issued { tokens, .. } => {
            // RFC 6749 6: the scope of a refresh may not exceed the grant. Asking for less is
            // not supported either: tokens carry the scope of the connection, so answering a
            // narrower request with the full scope would hand out more than was asked. Both are
            // `invalid_scope`, and the error rolls the rotation back (the token stays usable).
            let (asked, _) = scope::requested(requested_scope);
            if !asked.is_empty() && asked != tokens.scope {
                let granted: Vec<&str> = tokens.scope.split(' ').collect();
                let exceeds = asked.split(' ').any(|s| !granted.contains(&s));
                return Err(AppError::BadRequest(
                    if exceeds {
                        "the requested scope exceeds the scope granted"
                    } else {
                        "this server cannot narrow the scope of a connection when refreshing: \
                         omit scope, or ask for exactly the granted scope"
                    }
                    .into(),
                ));
            }
            Ok(Outcome::Issued(Box::new(tokens)))
        }
    }
}

/// `POST /oauth/revoke`: RFC 7009. Revokes the connection the token belongs to (revoking either
/// token of a pair ends the whole grant). Answers 200 whether or not the token existed, so it
/// cannot be used to probe for valid tokens.
pub async fn revoke(
    State(state): State<AppState>,
    client_info: ClientInfo,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, OAuthError> {
    let params = read_form(&state, &client_info, "oauth_revoke", &headers, body).await?;
    let client = authenticate_client(&state, &params).await?;
    let Some(token) = params.get("token").filter(|t| !t.is_empty()).cloned() else {
        return Err(OAuthError::invalid_request("token is required"));
    };
    let ip = client_info.ip.clone();
    state
        .db
        .write(move |tx| {
            if let Some((grant_id, user_id)) = store::revoke_by_token(tx, &token, &client.id)? {
                audit::record(
                    tx,
                    Some(&user_id),
                    actions::OAUTH_GRANT_REVOKE,
                    Some(&grant_id),
                    Some(json!({ "by": "client", "client": client.name, "client_id": client.id })),
                    Some(&ip),
                )?;
            }
            Ok(())
        })
        .await?;
    let mut res = StatusCode::OK.into_response();
    no_store(&mut res);
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge(verifier: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }

    #[test]
    fn pkce_rfc_7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(challenge(verifier), expected);
        assert!(verifier_matches(verifier, expected));
    }

    #[test]
    fn pkce_rejects_wrong_short_long_and_malformed_verifiers() {
        let v = "a".repeat(64);
        let c = challenge(&v);
        assert!(verifier_matches(&v, &c));
        assert!(!verifier_matches(&"b".repeat(64), &c));
        assert!(!verifier_matches(&v, &c.replace(&c[..1], "Z")));
        // The challenge itself is not a valid verifier for itself (no plain method).
        assert!(!verifier_matches(&c, &c));
        // Too short / too long / illegal characters, even when the hash would match.
        for bad in [
            "a".repeat(42),
            "a".repeat(129),
            format!("{}!", "a".repeat(50)),
            format!("{} ", "a".repeat(50)),
        ] {
            assert!(!verifier_matches(&bad, &challenge(&bad)), "{bad:?}");
        }
        assert!(verifier_matches(
            &"a".repeat(43),
            &challenge(&"a".repeat(43))
        ));
        assert!(verifier_matches(
            &"a".repeat(128),
            &challenge(&"a".repeat(128))
        ));
    }
}
