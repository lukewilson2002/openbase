//! `auth` API: setup status, signup, login (with optional TOTP second step),
//! logout, profile, password change and reset, 2FA management, and the
//! caller's session list.
//!
//! Everything except setup/signup/login/reset is session-only: API tokens are
//! rejected so a leaked token can't take over the account.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use og_core::api::auth::{
    ChangePasswordRequest, LoginRequest, LoginResponse, OkResponse, PasswordResetConfirm,
    PasswordResetRequest, SessionInfo, SetupStatus, SignupRequest, TwoFactorCode, TwoFactorDisable,
    TwoFactorSetup, UpdateMeRequest, User,
};
use rusqlite::{OptionalExtension, params};
use serde_json::json;

use crate::auth::password::{self, DUMMY_HASH};
use crate::auth::{Actor, ClientInfo, SESSION_COOKIE, session, totp};
use crate::db::now_ms;
use crate::email;
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::ids::hash_token;
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::{invites, users};

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);

/// Length of the public session id (a prefix of the token hash).
pub const SESSION_ID_LEN: usize = 16;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/setup", get(setup))
        .route("/api/auth/signup", post(signup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/login/2fa", post(login_2fa))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me).patch(update_me))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/password-reset/request", post(reset_request))
        .route("/api/auth/password-reset/confirm", post(reset_confirm))
        .route("/api/auth/2fa/setup", post(totp_setup))
        .route("/api/auth/2fa/enable", post(totp_enable))
        .route("/api/auth/2fa/disable", post(totp_disable))
        .route("/api/auth/sessions", get(list_sessions))
        .route(
            "/api/auth/sessions/revoke-others",
            post(revoke_other_sessions),
        )
        .route("/api/auth/sessions/{id}", delete(revoke_session))
}

/// `{"ok": true}` for actions with nothing else to return.
fn ok() -> Json<OkResponse> {
    Json(OkResponse::new())
}

/// A 401 with a specific code and message (the generic `Unauthorized` error
/// means "sign in first", which is wrong for a failed sign-in).
fn unauthorized(code: &str, message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn invalid_credentials() -> Response {
    unauthorized("invalid_credentials", "invalid email or password")
}

/// Whether a stored hash can verify at all (accounts created without a
/// password store an unusable marker).
fn usable_hash(phc: &str) -> bool {
    phc.starts_with("$argon2")
}

/// Verify `pw` against a user's stored hash in constant-ish time: unusable
/// hashes are checked against the dummy hash so timing doesn't reveal them.
async fn verify_user_password(pw: String, stored: &str) -> AppResult<bool> {
    if usable_hash(stored) {
        password::verify_async(pw, stored.to_string()).await
    } else {
        password::verify_async(pw, DUMMY_HASH.clone()).await?;
        Ok(false)
    }
}

async fn setup(State(state): State<AppState>) -> AppResult<Json<SetupStatus>> {
    let n = state.db.read(users::count).await?;
    Ok(Json(SetupStatus {
        needs_setup: n == 0,
        open_signup: state.config.open_signup,
        email_enabled: state.config.email_enabled(),
    }))
}

async fn signup(
    State(state): State<AppState>,
    client: ClientInfo,
    jar: CookieJar,
    ApiJson(req): ApiJson<SignupRequest>,
) -> AppResult<(CookieJar, Json<User>)> {
    state.limiter.check("signup", &client.ip, 10, HOUR)?;
    let email = users::normalize_email(&req.email)?;
    let name = users::validate_name(&req.name)?;
    password::validate_new_password(&req.password)?;
    let invite_token = req.invite_token.filter(|t| !t.trim().is_empty());
    let open = state.config.open_signup;

    // Cheap check before spending a password hash on a request that can't succeed.
    if invite_token.is_none() && !open && state.db.read(users::count).await? > 0 {
        return Err(invite_only());
    }
    let hash = password::hash_async(req.password).await?;

    let (user, token) = state
        .db
        .write(move |tx| {
            let first = users::count(tx)? == 0;
            let invite = match (&invite_token, first) {
                (Some(t), false) => Some(invites::require_valid_by_token(tx, t)?),
                _ => None,
            };
            if !first && invite.is_none() && !open {
                return Err(invite_only());
            }
            let id = users::create(tx, &email, &name, &hash, first)?;
            let ip = Some(client.ip.as_str());
            if let Some(inv) = &invite {
                invites::accept(tx, inv, &id, &email)?;
                audit::record(
                    tx,
                    Some(&id),
                    actions::INVITE_ACCEPT,
                    Some(&inv.info.id),
                    None,
                    ip,
                )?;
            }
            users::touch_last_login(tx, &id)?;
            let token = session::create(tx, &id, false, client.user_agent.as_deref(), ip)?;
            audit::record(
                tx,
                Some(&id),
                actions::SIGNUP,
                Some(&id),
                Some(json!({ "first_user": first, "invite": invite.map(|i| i.info.id) })),
                ip,
            )?;
            Ok((users::require(tx, &id)?.to_api(), token))
        })
        .await?;
    Ok((jar.add(session::cookie(&state.config, token)), Json(user)))
}

fn invite_only() -> AppError {
    AppError::forbidden("sign-up is by invitation only; ask an administrator for an invite link")
}

async fn login(
    State(state): State<AppState>,
    client: ClientInfo,
    jar: CookieJar,
    ApiJson(req): ApiJson<LoginRequest>,
) -> AppResult<Response> {
    let email_key = req.email.trim().to_lowercase();
    state.limiter.check("login_ip", &client.ip, 10, MINUTE)?;
    state.limiter.check("login_email", &email_key, 20, HOUR)?;

    let lookup = email_key.clone();
    let user = state
        .db
        .read(move |c| users::get_by_email(c, &lookup))
        .await?;
    // Always run one Argon2 verification so unknown emails take as long as
    // wrong passwords (no account enumeration by timing).
    let password_ok = match &user {
        Some(u) => verify_user_password(req.password, &u.password_hash).await?,
        None => {
            password::verify_async(req.password, DUMMY_HASH.clone()).await?;
            false
        }
    };
    let ip = client.ip.clone();
    let failed_id = user.as_ref().map(|u| u.id.clone());
    let Some(user) = user.filter(|_| password_ok) else {
        state
            .db
            .write(move |tx| {
                audit::record(
                    tx,
                    failed_id.as_deref(),
                    actions::LOGIN_FAILED,
                    None,
                    Some(json!({ "email": email_key })),
                    Some(&ip),
                )
            })
            .await?;
        return Ok(invalid_credentials());
    };
    if !user.is_active {
        let uid = user.id.clone();
        state
            .db
            .write(move |tx| {
                audit::record(
                    tx,
                    Some(&uid),
                    actions::LOGIN_FAILED,
                    None,
                    Some(json!({ "reason": "deactivated" })),
                    Some(&ip),
                )
            })
            .await?;
        return Err(AppError::forbidden(
            "this account has been deactivated; contact your administrator",
        ));
    }

    let pending = user.totp_enabled && user.totp_secret.is_some();
    let uid = user.id.clone();
    let ua = client.user_agent.clone();
    let token = state
        .db
        .write(move |tx| {
            let token = session::create(tx, &uid, pending, ua.as_deref(), Some(&ip))?;
            if !pending {
                users::touch_last_login(tx, &uid)?;
                audit::record(tx, Some(&uid), actions::LOGIN, None, None, Some(&ip))?;
            }
            Ok(token)
        })
        .await?;
    let jar = jar.add(session::cookie(&state.config, token));
    let body = if pending {
        LoginResponse {
            user: None,
            two_factor_required: true,
        }
    } else {
        state.limiter.reset("login_email", &email_key);
        LoginResponse {
            user: Some(user.to_api()),
            two_factor_required: false,
        }
    };
    Ok((jar, Json(body)).into_response())
}

enum SecondFactor {
    NoPendingSession,
    BadCode,
    Ok(User, String),
}

async fn login_2fa(
    State(state): State<AppState>,
    client: ClientInfo,
    jar: CookieJar,
    ApiJson(req): ApiJson<TwoFactorCode>,
) -> AppResult<Response> {
    let expired = || {
        unauthorized(
            "two_factor_expired",
            "your sign-in attempt has expired; sign in again",
        )
    };
    let Some(raw) = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()) else {
        return Ok(expired());
    };
    let pending_hash = hash_token(&raw);
    state
        .limiter
        .check("login_2fa", &pending_hash, 10, 10 * MINUTE)?;

    let ip = client.ip.clone();
    let ua = client.user_agent.clone();
    let outcome = state
        .db
        .write(move |tx| {
            // actor_from_session rejects pending sessions by design; read it here.
            let uid: Option<String> = tx
                .query_row(
                    "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ?1 AND s.pending_2fa = 1 AND s.expires_at > ?2
                       AND u.is_active = 1",
                    params![pending_hash, now_ms()],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(uid) = uid else {
                return Ok(SecondFactor::NoPendingSession);
            };
            let user = users::require(tx, &uid)?;
            let Some(secret) = user.totp_secret.as_deref().filter(|_| user.totp_enabled) else {
                return Ok(SecondFactor::NoPendingSession);
            };
            if !totp::verify_and_consume(tx, &uid, secret, &req.code)? {
                audit::record(
                    tx,
                    Some(&uid),
                    actions::LOGIN_2FA_FAILED,
                    None,
                    None,
                    Some(&ip),
                )?;
                return Ok(SecondFactor::BadCode);
            }
            // Issue a fresh token rather than upgrading the pending one.
            session::delete(tx, &pending_hash)?;
            let token = session::create(tx, &uid, false, ua.as_deref(), Some(&ip))?;
            users::touch_last_login(tx, &uid)?;
            audit::record(
                tx,
                Some(&uid),
                actions::LOGIN,
                None,
                Some(json!({ "two_factor": true })),
                Some(&ip),
            )?;
            Ok(SecondFactor::Ok(user.to_api(), token))
        })
        .await?;
    match outcome {
        SecondFactor::NoPendingSession => Ok(expired()),
        SecondFactor::BadCode => Ok(unauthorized(
            "invalid_code",
            "that code is not valid; check your authenticator app and try again",
        )),
        SecondFactor::Ok(user, token) => {
            state
                .limiter
                .reset("login_email", &user.email.to_lowercase());
            let jar = jar.add(session::cookie(&state.config, token));
            let body = LoginResponse {
                user: Some(user),
                two_factor_required: false,
            };
            Ok((jar, Json(body)).into_response())
        }
    }
}

/// Deletes whatever session the cookie names (also a pending 2FA one) and
/// clears the cookie. Succeeds even when not signed in.
async fn logout(
    State(state): State<AppState>,
    client: ClientInfo,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<OkResponse>)> {
    if let Some(raw) = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()) {
        let hash = hash_token(&raw);
        state
            .db
            .write(move |tx| {
                let uid: Option<String> = tx
                    .query_row(
                        "SELECT user_id FROM sessions WHERE token_hash = ?1",
                        [&hash],
                        |r| r.get(0),
                    )
                    .optional()?;
                session::delete(tx, &hash)?;
                if let Some(uid) = uid {
                    audit::record(
                        tx,
                        Some(&uid),
                        actions::LOGOUT,
                        None,
                        None,
                        Some(&client.ip),
                    )?;
                }
                Ok(())
            })
            .await?;
    }
    Ok((jar.add(session::removal_cookie(&state.config)), ok()))
}

async fn me(State(state): State<AppState>, actor: Actor) -> AppResult<Json<User>> {
    actor.require_session()?;
    let user = state
        .db
        .read(move |c| users::require(c, &actor.user_id))
        .await?;
    Ok(Json(user.to_api()))
}

async fn update_me(
    State(state): State<AppState>,
    actor: Actor,
    ApiJson(req): ApiJson<UpdateMeRequest>,
) -> AppResult<Json<User>> {
    actor.require_session()?;
    let name = req.name.as_deref().map(users::validate_name).transpose()?;
    let timezone = req
        .timezone
        .as_deref()
        .map(users::validate_timezone)
        .transpose()?;
    let user = state
        .db
        .write(move |tx| {
            users::update_profile(
                tx,
                &actor.user_id,
                name.as_deref(),
                timezone.as_ref().map(|t| t.as_deref()),
            )?;
            users::require(tx, &actor.user_id)
        })
        .await?;
    Ok(Json(user.to_api()))
}

async fn change_password(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<ChangePasswordRequest>,
) -> AppResult<Json<OkResponse>> {
    actor.require_session()?;
    state
        .limiter
        .check("password_change", &actor.user_id, 10, 10 * MINUTE)?;
    password::validate_new_password(&req.new_password)?;
    let uid = actor.user_id.clone();
    let user = state.db.read(move |c| users::require(c, &uid)).await?;
    if !verify_user_password(req.current_password, &user.password_hash).await? {
        return Err(AppError::forbidden("current password is incorrect"));
    }
    let hash = password::hash_async(req.new_password).await?;
    state
        .db
        .write(move |tx| {
            users::set_password_hash(tx, &actor.user_id, &hash)?;
            session::delete_all_for_user(tx, &actor.user_id, actor.session_hash.as_deref())?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::PASSWORD_CHANGE,
                None,
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(ok())
}

/// Always answers 200 so it can't be used to discover accounts. When email is
/// configured and the account exists and is active, a 1-hour link is emailed.
async fn reset_request(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(req): ApiJson<PasswordResetRequest>,
) -> AppResult<Json<OkResponse>> {
    state.limiter.check("reset_request", &client.ip, 5, HOUR)?;
    if !state.config.email_enabled() {
        return Ok(ok());
    }
    let Ok(email) = users::normalize_email(&req.email) else {
        return Ok(ok());
    };
    let ip = client.ip.clone();
    let issued = state
        .db
        .write(move |tx| {
            let Some(user) = users::get_by_email(tx, &email)?.filter(|u| u.is_active) else {
                return Ok(None);
            };
            let (token, _) = users::create_reset_token(tx, &user.id, users::RESET_TTL_MS)?;
            audit::record(
                tx,
                Some(&user.id),
                actions::PASSWORD_RESET_REQUEST,
                None,
                None,
                Some(&ip),
            )?;
            Ok(Some((user.email, user.name, token)))
        })
        .await?;
    if let Some((to, name, token)) = issued {
        let url = users::reset_url(&state.config.public_url, &token);
        let body = format!(
            "Hi {name},\n\nSomeone (hopefully you) asked to reset your OpenGrid password.\n\
             Open this link within 1 hour to choose a new one:\n\n{url}\n\n\
             If you didn't ask for this, you can ignore this email; your password is unchanged.\n"
        );
        email::send_in_background(
            state.mailer.clone(),
            to,
            "Reset your OpenGrid password".into(),
            body,
        );
    }
    Ok(ok())
}

async fn reset_confirm(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(req): ApiJson<PasswordResetConfirm>,
) -> AppResult<Json<OkResponse>> {
    state.limiter.check("reset_confirm", &client.ip, 20, HOUR)?;
    password::validate_new_password(&req.new_password)?;
    let invalid = || AppError::bad_request("this reset link is invalid or has expired");
    // Check the token before spending a password hash on it.
    let probe = hash_token(&req.token);
    let exists: bool = state
        .db
        .read(move |c| {
            Ok(c.query_row(
                "SELECT 1 FROM password_resets WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
                params![probe, now_ms()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
        })
        .await?;
    if !exists {
        return Err(invalid());
    }
    let hash = password::hash_async(req.new_password).await?;
    let token = req.token;
    state
        .db
        .write(move |tx| {
            let Some(uid) = users::consume_reset_token(tx, &token)? else {
                return Err(invalid());
            };
            users::set_password_hash(tx, &uid, &hash)?;
            session::delete_all_for_user(tx, &uid, None)?;
            audit::record(
                tx,
                Some(&uid),
                actions::PASSWORD_RESET,
                None,
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(ok())
}

async fn totp_setup(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<TwoFactorSetup>> {
    actor.require_session()?;
    let secret = totp::generate_secret();
    let stored = secret.clone();
    let user = state
        .db
        .write(move |tx| {
            let user = users::require(tx, &actor.user_id)?;
            if user.totp_enabled {
                return Err(AppError::conflict(
                    "two-factor authentication is already on; turn it off first to set up a new device",
                ));
            }
            users::set_totp(tx, &user.id, Some(&stored), false)?;
            Ok(user)
        })
        .await?;
    Ok(Json(TwoFactorSetup {
        otpauth_url: totp::otpauth_url(&secret, &user.email)?,
        secret,
    }))
}

async fn totp_enable(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<TwoFactorCode>,
) -> AppResult<Json<User>> {
    actor.require_session()?;
    state
        .limiter
        .check("2fa_manage", &actor.user_id, 10, 10 * MINUTE)?;
    let user = state
        .db
        .write(move |tx| {
            let user = users::require(tx, &actor.user_id)?;
            if user.totp_enabled {
                return Err(AppError::conflict(
                    "two-factor authentication is already on",
                ));
            }
            let Some(secret) = user.totp_secret.as_deref() else {
                return Err(AppError::bad_request("start two-factor setup first"));
            };
            if !totp::verify_and_consume(tx, &user.id, secret, &req.code)? {
                return Err(AppError::bad_request("that code is not valid"));
            }
            users::set_totp(tx, &user.id, Some(secret), true)?;
            audit::record(
                tx,
                Some(&user.id),
                actions::TWO_FACTOR_ENABLE,
                None,
                None,
                Some(&client.ip),
            )?;
            users::require(tx, &user.id)
        })
        .await?;
    Ok(Json(user.to_api()))
}

async fn totp_disable(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<TwoFactorDisable>,
) -> AppResult<Json<User>> {
    actor.require_session()?;
    state
        .limiter
        .check("2fa_manage", &actor.user_id, 10, 10 * MINUTE)?;
    let uid = actor.user_id.clone();
    let user = state.db.read(move |c| users::require(c, &uid)).await?;
    if !verify_user_password(req.password, &user.password_hash).await? {
        return Err(AppError::forbidden("password is incorrect"));
    }
    let user = state
        .db
        .write(move |tx| {
            let user = users::require(tx, &actor.user_id)?;
            let Some(secret) = user.totp_secret.as_deref().filter(|_| user.totp_enabled) else {
                return Err(AppError::bad_request("two-factor authentication is not on"));
            };
            if !totp::verify_and_consume(tx, &user.id, secret, &req.code)? {
                return Err(AppError::bad_request("that code is not valid"));
            }
            users::set_totp(tx, &user.id, None, false)?;
            audit::record(
                tx,
                Some(&user.id),
                actions::TWO_FACTOR_DISABLE,
                None,
                None,
                Some(&client.ip),
            )?;
            users::require(tx, &user.id)
        })
        .await?;
    Ok(Json(user.to_api()))
}

async fn list_sessions(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<Vec<SessionInfo>>> {
    actor.require_session()?;
    let current = actor.session_hash.clone().unwrap_or_default();
    let sessions = state
        .db
        .read(move |c| {
            let mut stmt = c.prepare(
                "SELECT token_hash, created_at, last_seen_at, expires_at, user_agent, ip
                 FROM sessions WHERE user_id = ?1 AND pending_2fa = 0 AND expires_at > ?2
                 ORDER BY last_seen_at DESC, created_at DESC",
            )?;
            let rows = stmt.query_map(params![actor.user_id, now_ms()], |r| {
                let hash: String = r.get(0)?;
                Ok(SessionInfo {
                    id: hash.chars().take(SESSION_ID_LEN).collect(),
                    current: hash == current,
                    created_at: r.get(1)?,
                    last_seen_at: r.get(2)?,
                    expires_at: r.get(3)?,
                    user_agent: r.get(4)?,
                    ip: r.get(5)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(sessions))
}

async fn revoke_session(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_session()?;
    let valid_id = id.len() == SESSION_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if !valid_id {
        return Err(AppError::not_found("session"));
    }
    state
        .db
        .write(move |tx| {
            let n = tx.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND substr(token_hash, 1, ?2) = ?3",
                params![actor.user_id, SESSION_ID_LEN as i64, id],
            )?;
            if n == 0 {
                return Err(AppError::not_found("session"));
            }
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::SESSION_REVOKE,
                Some(&id),
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_other_sessions(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
) -> AppResult<Json<OkResponse>> {
    actor.require_session()?;
    state
        .db
        .write(move |tx| {
            session::delete_all_for_user(tx, &actor.user_id, actor.session_hash.as_deref())?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::SESSION_REVOKE,
                Some("others"),
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(ok())
}
