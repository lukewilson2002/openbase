//! `passkeys` API: the account's passkeys (list, add, rename, remove) and signing in with one.
//!
//! Managing passkeys is **session-only**: no API token or OAuth grant of any scope can register,
//! list, rename or remove one (a leaked token must not be able to plant a credential that
//! outlives its own revocation). Adding one also needs the account password unless the session
//! signed in within [`RECENT_SIGN_IN_MS`]. Signing in is anonymous and rate limited per client
//! address; a passkey sign-in always includes user verification, so it does not ask for the TOTP
//! code, and the account's password keeps working as before. See docs/security.md.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use ob_core::api::auth::LoginResponse;
use ob_core::api::passkeys::{
    PasskeyChallenge, PasskeyInfo, PasskeyLoginFinish, PasskeyRegisterFinish, PasskeyRegisterStart,
    PasskeyRename,
};
use rusqlite::OptionalExtension;
use serde_json::json;

use super::auth::{unauthorized, verify_user_password};
use crate::auth::passkey::{
    LoginRefused, RECENT_SIGN_IN_MS, reported_not_discoverable, reported_transports,
};
use crate::auth::{Actor, Capability, ClientInfo, session};
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::{passkeys, users};

const MINUTE: Duration = Duration::from_secs(60);

/// Sign-in attempts (finishing) per client address per minute.
const LOGIN_FINISH_PER_MINUTE: u32 = 10;
/// Sign-in challenges requested per client address per minute. Higher: the login page asks for
/// one every time it opens (for the autofill suggestion), before anyone has done anything.
const LOGIN_START_PER_MINUTE: u32 = 30;
/// Passkey changes per user per 10 minutes (start and finish of a registration, rename, remove).
const MANAGE_PER_10_MIN: u32 = 60;
/// Password attempts made to confirm a registration, per user per 10 minutes.
const REAUTH_PER_10_MIN: u32 = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/passkeys", get(list))
        .route("/api/auth/passkeys/register/start", post(register_start))
        .route("/api/auth/passkeys/register/finish", post(register_finish))
        .route("/api/auth/passkeys/{id}", patch(rename).delete(remove))
        .route("/api/auth/passkey-login/start", post(login_start))
        .route("/api/auth/passkey-login/finish", post(login_finish))
}

async fn list(State(state): State<AppState>, actor: Actor) -> AppResult<Json<Vec<PasskeyInfo>>> {
    actor.require_capability(Capability::SessionOnly)?;
    Ok(Json(
        state
            .db
            .read(move |c| passkeys::list(c, &actor.user_id))
            .await?,
    ))
}

/// 403 with its own code, so the page knows to ask for the password and try again.
fn reauth_required() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": {
            "code": "reauth_required",
            "message": "confirm your password to add a passkey",
        } })),
    )
        .into_response()
}

async fn register_start(
    State(state): State<AppState>,
    actor: Actor,
    ApiJson(req): ApiJson<PasskeyRegisterStart>,
) -> AppResult<Response> {
    actor.require_capability(Capability::SessionOnly)?;
    state.passkeys.require_enabled()?;
    state.limiter.check(
        "passkey_manage",
        &actor.user_id,
        MANAGE_PER_10_MIN,
        10 * MINUTE,
    )?;

    let uid = actor.user_id.clone();
    let session_hash = actor.session_hash.clone().unwrap_or_default();
    let (user, session_started) = state
        .db
        .read(move |c| {
            let user = users::require(c, &uid)?;
            let started: Option<i64> = c
                .query_row(
                    "SELECT created_at FROM sessions WHERE token_hash = ?1",
                    [&session_hash],
                    |r| r.get(0),
                )
                .optional()?;
            Ok((user, started))
        })
        .await?;

    // Re-authentication: the password, or a sign-in in the last few minutes. A stolen session
    // cookie that is older than that cannot plant a passkey without the password.
    match req.password.filter(|p| !p.is_empty()) {
        Some(password) => {
            state.limiter.check(
                "passkey_reauth",
                &actor.user_id,
                REAUTH_PER_10_MIN,
                10 * MINUTE,
            )?;
            if !verify_user_password(password, &user.password_hash).await? {
                return Err(AppError::forbidden("password is incorrect"));
            }
        }
        None => {
            let recent = session_started.is_some_and(|t| now_ms() - t <= RECENT_SIGN_IN_MS);
            if !recent {
                return Ok(reauth_required());
            }
        }
    }

    let session_hash = actor.session_hash.clone();
    let (handle, exclude) = state
        .db
        .write(move |tx| {
            if passkeys::count(tx, &actor.user_id)? >= passkeys::MAX_PER_USER {
                return Err(AppError::conflict(format!(
                    "you can register at most {} passkeys; remove one you no longer use",
                    passkeys::MAX_PER_USER
                )));
            }
            Ok((
                passkeys::user_handle(tx, &actor.user_id)?,
                passkeys::credential_ids(tx, &actor.user_id)?,
            ))
        })
        .await?;
    let challenge = state.passkeys.start_registration(
        &user.id,
        session_hash,
        handle,
        &user.email,
        &user.name,
        exclude,
    )?;
    Ok(Json(challenge).into_response())
}

async fn register_finish(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<PasskeyRegisterFinish>,
) -> AppResult<(StatusCode, Json<PasskeyInfo>)> {
    actor.require_capability(Capability::SessionOnly)?;
    state.limiter.check(
        "passkey_manage",
        &actor.user_id,
        MANAGE_PER_10_MIN,
        10 * MINUTE,
    )?;
    // Validate what the user typed before the challenge is spent, so a too long name can be
    // corrected without starting over.
    let name = passkeys::clean_name(req.name.as_deref().unwrap_or(""))?;
    let Some(pending) = state.passkeys.take_registration(
        &req.challenge_id,
        &actor.user_id,
        actor.session_hash.as_deref(),
    ) else {
        return Err(AppError::bad_request(
            "this passkey setup has expired or was already used; start again",
        ));
    };
    if reported_not_discoverable(&req.credential) {
        return Err(AppError::bad_request(
            "this authenticator cannot keep a passkey that signs you in without a username; \
             choose another one (a phone, a computer's screen lock or a password manager)",
        ));
    }
    let passkey = state
        .passkeys
        .finish_registration(&pending, &req.credential)?;
    let transports = passkeys::clean_transports(&reported_transports(&req.credential));
    let info = state
        .db
        .write(move |tx| {
            let info = passkeys::insert(tx, &actor.user_id, &passkey, &name, &transports)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::PASSKEY_ADD,
                Some(&info.id),
                Some(json!({ "name": info.name })),
                Some(&client.ip),
            )?;
            Ok(info)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(info)))
}

async fn rename(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<PasskeyRename>,
) -> AppResult<Json<PasskeyInfo>> {
    actor.require_capability(Capability::SessionOnly)?;
    state.limiter.check(
        "passkey_manage",
        &actor.user_id,
        MANAGE_PER_10_MIN,
        10 * MINUTE,
    )?;
    let name = passkeys::clean_name(&req.name)?;
    let info = state
        .db
        .write(move |tx| {
            let info = passkeys::rename(tx, &actor.user_id, &id, &name)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::PASSKEY_RENAME,
                Some(&info.id),
                Some(json!({ "name": info.name })),
                Some(&client.ip),
            )?;
            Ok(info)
        })
        .await?;
    Ok(Json(info))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_capability(Capability::SessionOnly)?;
    state.limiter.check(
        "passkey_manage",
        &actor.user_id,
        MANAGE_PER_10_MIN,
        10 * MINUTE,
    )?;
    state
        .db
        .write(move |tx| {
            let name = passkeys::delete(tx, &actor.user_id, &id)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::PASSKEY_REMOVE,
                Some(&id),
                Some(json!({ "name": name })),
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------------------------ sign-in

async fn login_start(
    State(state): State<AppState>,
    client: ClientInfo,
) -> AppResult<Json<PasskeyChallenge>> {
    state.limiter.check(
        "passkey_start_ip",
        &client.ip,
        LOGIN_START_PER_MINUTE,
        MINUTE,
    )?;
    Ok(Json(state.passkeys.start_login()?))
}

/// A refused sign-in: audited, and answered the same whatever the reason (an unknown credential
/// looks like a wrong signature, so the answer reveals nothing about which credentials exist).
async fn refuse(
    state: &AppState,
    client: &ClientInfo,
    user_id: Option<String>,
    passkey_id: Option<String>,
    reason: &'static str,
) -> AppResult<Response> {
    let ip = client.ip.clone();
    state
        .db
        .write(move |tx| {
            audit::record(
                tx,
                user_id.as_deref(),
                actions::PASSKEY_LOGIN_FAILED,
                passkey_id.as_deref(),
                Some(json!({ "reason": reason })),
                Some(&ip),
            )
        })
        .await?;
    Ok(unauthorized(
        "invalid_passkey",
        "that passkey was not accepted; try again, or sign in with your password",
    ))
}

async fn login_finish(
    State(state): State<AppState>,
    client: ClientInfo,
    jar: CookieJar,
    ApiJson(req): ApiJson<PasskeyLoginFinish>,
) -> AppResult<Response> {
    // Counted before anything is looked up, successful or not.
    state.limiter.check(
        "passkey_login_ip",
        &client.ip,
        LOGIN_FINISH_PER_MINUTE,
        MINUTE,
    )?;
    let Some(pending) = state.passkeys.take_login(&req.challenge_id) else {
        return Ok(unauthorized(
            "passkey_expired",
            "your sign-in attempt has expired; try again",
        ));
    };
    let (credential, handle, raw_id) = state.passkeys.identify_login(&req.credential)?;

    // Whose credential is it, and does the user handle the authenticator returned agree?
    let found = state
        .db
        .read(move |c| {
            let Some(row) = passkeys::find_by_credential(c, &raw_id)? else {
                return Ok(None);
            };
            if passkeys::user_for_handle(c, &handle)?.as_deref() != Some(row.user_id.as_str()) {
                return Ok(None);
            }
            let user = users::require(c, &row.user_id)?;
            Ok(Some((row, user)))
        })
        .await?;
    let Some((mut row, user)) = found else {
        return refuse(&state, &client, None, None, "unknown_credential").await;
    };

    if let Err(why) = state
        .passkeys
        .finish_login(&credential, pending, &mut row.passkey)
    {
        let reason = match why {
            LoginRefused::Invalid => "invalid_response",
            LoginRefused::CounterRegression => "counter_regression",
        };
        return refuse(&state, &client, Some(user.id), Some(row.id), reason).await;
    }

    // The signature is good: this is the account's owner, so the real reason may be said aloud.
    if !user.is_active {
        refuse(
            &state,
            &client,
            Some(user.id.clone()),
            Some(row.id),
            "deactivated",
        )
        .await?;
        return Err(AppError::forbidden(
            "this account has been deactivated; contact your administrator",
        ));
    }

    let (uid, ip, ua) = (
        user.id.clone(),
        client.ip.clone(),
        client.user_agent.clone(),
    );
    let token = state
        .db
        .write(move |tx| {
            passkeys::mark_used(tx, &row.id, &row.passkey)?;
            // A full session: user verification already was the second factor.
            let token = session::create(tx, &uid, false, ua.as_deref(), Some(&ip))?;
            users::touch_last_login(tx, &uid)?;
            audit::record(
                tx,
                Some(&uid),
                actions::PASSKEY_LOGIN,
                Some(&row.id),
                Some(json!({ "name": row.name })),
                Some(&ip),
            )?;
            Ok(token)
        })
        .await?;
    let body = LoginResponse {
        user: Some(user.to_api()),
        two_factor_required: false,
    };
    Ok((jar.add(session::cookie(&state.config, token)), Json(body)).into_response())
}
