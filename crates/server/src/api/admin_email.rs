//! `GET|PATCH /api/admin/email` and `POST /api/admin/email/test`: the instance's outgoing-email
//! (SMTP) settings, for instance administrators (signed in, or an API token with the `manage`
//! permission, whose use is audited).
//!
//! - Each setting comes from the environment (`OPENGRID_SMTP_*`, read-only here), from what is
//!   saved here (the `settings` table), or from a default; see [`crate::email`].
//! - A change applies at once, without a restart.
//! - The password is write-only: no response, log line or audit row contains it.
//! - Credential rules for API tokens: a token may read the settings, change host, port, security,
//!   username and sender address, and send a test email, but can never set or remove the
//!   password, and cannot change where an existing password is sent (host, port, security,
//!   username) while one is in use, because that would let it make the server hand the password
//!   to a server of its choosing.

use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use lettre::Address;
use lettre::message::Mailbox;
use og_core::api::email::{
    EmailBudgets, EmailSettings, EmailSources, EmailTestResult, SendTestEmail, UpdateEmailSettings,
};
use serde_json::json;

use crate::auth::{Actor, ClientInfo, admin_guard};
use crate::email::{self, RawSmtp, Resolved, SmtpSecurity};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::email_settings;

/// How long a test email may take in all (connect, TLS, authenticate, deliver).
const TEST_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_FIELD_LEN: usize = 255;
const MAX_PASSWORD_LEN: usize = 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/email", get(read).patch(update))
        .route("/api/admin/email/test", post(send_test))
}

/// The effective settings as the API shows them.
pub fn view(state: &AppState) -> EmailSettings {
    let r = state.email.resolved();
    EmailSettings {
        enabled: r.smtp.is_some(),
        source: r.sources.host.to_string(),
        host: r.smtp.as_ref().map(|s| s.host.clone()),
        port: r.port,
        security: r.security.as_str().to_string(),
        username: r.user.clone(),
        from: r.from.clone(),
        password_set: r.password_set,
        sources: EmailSources {
            host: r.sources.host.to_string(),
            port: r.sources.port.to_string(),
            security: r.sources.security.to_string(),
            username: r.sources.user.to_string(),
            password: r.sources.password.to_string(),
            from: r.sources.from.to_string(),
        },
        budgets: EmailBudgets {
            per_user_hour: state.config.email_per_user_hour,
            per_hour: state.config.email_per_hour,
        },
    }
}

async fn read(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
) -> AppResult<Json<EmailSettings>> {
    admin_guard(&state, &actor, &client, "GET /api/admin/email").await?;
    Ok(Json(view(&state)))
}

// ------------------------------------------------------------------------------ validation

fn no_control(value: &str, what: &str) -> AppResult<()> {
    if value.chars().any(char::is_control) {
        return Err(AppError::bad_request(format!(
            "{what} must not contain control characters"
        )));
    }
    Ok(())
}

fn validate_host(host: &str) -> AppResult<String> {
    let host = host.trim();
    if host.is_empty() || host.len() > 253 {
        return Err(AppError::bad_request(
            "the SMTP host must be 1 to 253 characters",
        ));
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Err(AppError::bad_request(
            "the SMTP host may only contain letters, digits, '.', '-' and '_' (a host name or an \
             IP address, without a scheme, path or port)",
        ));
    }
    Ok(host.to_string())
}

fn validate_username(user: &str) -> AppResult<String> {
    let user = user.trim();
    if user.len() > MAX_FIELD_LEN {
        return Err(AppError::bad_request("the SMTP username is too long"));
    }
    no_control(user, "the SMTP username")?;
    Ok(user.to_string())
}

fn validate_password(password: &str) -> AppResult<String> {
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::bad_request("the SMTP password is too long"));
    }
    no_control(password, "the SMTP password")?;
    Ok(password.to_string())
}

fn validate_from(from: &str) -> AppResult<String> {
    let from = from.trim();
    if from.len() > MAX_FIELD_LEN {
        return Err(AppError::bad_request("the sender address is too long"));
    }
    no_control(from, "the sender address")?;
    from.parse::<Mailbox>().map_err(|e| {
        AppError::bad_request(format!(
            "invalid sender address '{from}': {e} (use name@example.com or \
             OpenGrid <name@example.com>)"
        ))
    })?;
    Ok(from.to_string())
}

fn locked(field: &str, var: &str) -> AppError {
    AppError::bad_request(format!(
        "the SMTP {field} is set by the environment variable {var} and cannot be changed here; \
         remove the variable to manage it on this page"
    ))
}

/// What the request does to the password.
#[derive(Debug, PartialEq, Eq)]
enum PasswordChange {
    Keep,
    Set(String),
    Clear,
}

fn password_change(req: &UpdateEmailSettings) -> AppResult<PasswordChange> {
    Ok(match &req.password {
        None => PasswordChange::Keep,
        Some(None) => PasswordChange::Clear,
        Some(Some(p)) if p.is_empty() => PasswordChange::Keep,
        Some(Some(p)) => PasswordChange::Set(validate_password(p)?),
    })
}

/// The new stored settings after applying `req` to `stored`, refusing changes to fields the
/// environment sets (unless the value is the one already in effect).
fn apply_request(
    req: &UpdateEmailSettings,
    password: PasswordChange,
    env: &RawSmtp,
    stored: &RawSmtp,
) -> AppResult<RawSmtp> {
    let mut next = stored.clone();
    let blank = |v: &Option<String>| v.as_deref().is_none_or(|s| s.trim().is_empty());

    if let Some(host) = &req.host {
        let new = if blank(host) {
            None
        } else {
            Some(validate_host(host.as_deref().unwrap_or_default())?)
        };
        match &env.host {
            Some(e) if new.as_deref() != Some(e.as_str()) => {
                return Err(locked("host", "OPENGRID_SMTP_HOST"));
            }
            Some(_) => {}
            None => next.host = new,
        }
    }
    if let Some(port) = req.port {
        if port == 0 {
            return Err(AppError::bad_request("the SMTP port must be 1 to 65535"));
        }
        match env.port {
            Some(e) if e != port => return Err(locked("port", "OPENGRID_SMTP_PORT")),
            Some(_) => {}
            None => next.port = Some(port),
        }
    }
    if let Some(security) = &req.security {
        let new = SmtpSecurity::parse(security)?.as_str();
        match &env.security {
            Some(e) if !e.trim().eq_ignore_ascii_case(new) => {
                return Err(locked("security mode", "OPENGRID_SMTP_SECURITY"));
            }
            Some(_) => {}
            None => next.security = Some(new.to_string()),
        }
    }
    if let Some(user) = &req.username {
        let new = if blank(user) {
            None
        } else {
            Some(validate_username(user.as_deref().unwrap_or_default())?)
        };
        match &env.user {
            Some(e) if new.as_deref() != Some(e.as_str()) => {
                return Err(locked("username", "OPENGRID_SMTP_USER"));
            }
            Some(_) => {}
            None => next.user = new,
        }
    }
    if let Some(from) = &req.from {
        let new = if from.trim().is_empty() {
            None
        } else {
            Some(validate_from(from)?)
        };
        match &env.from {
            Some(e) if new.as_deref() != Some(e.as_str()) => {
                return Err(locked("sender address", "OPENGRID_SMTP_FROM"));
            }
            Some(_) => {}
            None => next.from = new,
        }
    }
    match password {
        PasswordChange::Keep => {}
        PasswordChange::Set(_) | PasswordChange::Clear if env.password.is_some() => {
            return Err(locked("password", "OPENGRID_SMTP_PASSWORD"));
        }
        PasswordChange::Set(p) => next.password = Some(p),
        PasswordChange::Clear => next.password = None,
    }
    Ok(next)
}

/// Whether the connection target (where the credentials go) differs between two configurations.
fn target_changed(old: &Resolved, new: &Resolved) -> bool {
    let key = |r: &Resolved| {
        (
            r.smtp.as_ref().map(|s| s.host.clone()),
            r.port,
            r.security,
            r.user.clone(),
        )
    };
    key(old) != key(new)
}

/// The names of the settings that differ, and their new values (never the password).
fn changed_fields(old: &RawSmtp, new: &RawSmtp) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let mut note = |name: &str, a: &Option<String>, b: &Option<String>| {
        if a != b {
            out.insert(name.into(), json!(b));
        }
    };
    note("host", &old.host, &new.host);
    note(
        "port",
        &old.port.map(|p| p.to_string()),
        &new.port.map(|p| p.to_string()),
    );
    note("security", &old.security, &new.security);
    note("username", &old.user, &new.user);
    note("from", &old.from, &new.from);
    out
}

// -------------------------------------------------------------------------------- handlers

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<UpdateEmailSettings>,
) -> AppResult<Json<EmailSettings>> {
    admin_guard(&state, &actor, &client, "PATCH /api/admin/email").await?;
    let password = password_change(&req)?;
    if password != PasswordChange::Keep {
        actor.require_session_for("set or remove the SMTP password")?;
    }
    let env = state.email.env().clone();
    let email = state.email.clone();
    let by_token = actor.token_scope.is_some();
    let (user_id, ip) = (actor.user_id.clone(), client.ip.clone());
    state
        .db
        .write(move |tx| {
            let stored = email_settings::load(tx)?;
            let next = apply_request(&req, password, &env, &stored)?;
            let old = email.resolved();
            let new = email.preview(&next)?;
            if by_token && old.password_set && target_changed(&old, &new) {
                return Err(AppError::forbidden(
                    "an SMTP password is in use, and changing the host, port, security mode or \
                     username would send it to a different server; API tokens can never do that. \
                     Change these in the web app (Admin > Email) while signed in",
                ));
            }
            let mut changes = changed_fields(&stored, &next);
            let password_state = match (&stored.password, &next.password) {
                (None, Some(_)) => Some("set"),
                (Some(a), Some(b)) if a != b => Some("replaced"),
                (Some(_), None) => Some("removed"),
                _ => None,
            };
            if let Some(p) = password_state {
                changes.insert("password".into(), json!(p));
            }
            if changes.is_empty() {
                return Ok(());
            }
            let prepared = email.prepare(&next)?;
            email_settings::save(tx, &next)?;
            audit::record(
                tx,
                Some(&user_id),
                actions::ADMIN_EMAIL_UPDATE,
                None,
                Some(serde_json::Value::Object(changes)),
                Some(&ip),
            )?;
            // Last, so a failure above leaves the running configuration untouched. The writer is
            // single, so installs happen in the order the changes were saved.
            email.install(prepared);
            Ok(())
        })
        .await?;
    Ok(Json(view(&state)))
}

async fn send_test(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<SendTestEmail>,
) -> AppResult<Json<EmailTestResult>> {
    admin_guard(&state, &actor, &client, "POST /api/admin/email/test").await?;
    let to = match req.to.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => actor.email.clone(),
    };
    if to.len() > 254 || to.parse::<Address>().is_err() {
        return Err(AppError::bad_request(format!(
            "'{to}' is not a valid email address (give a plain address like name@example.com)"
        )));
    }
    // A test mail is real mail from the server's identity: it counts against the budgets, and an
    // extra cap stops a loop from hammering the mail server.
    state
        .limiter
        .check("email_test", &actor.user_id, 20, Duration::from_secs(3600))?;
    email::spend_budget(&state.limiter, &state.config, &actor.user_id, 1)?;

    let result = if !state.email.enabled() {
        EmailTestResult {
            ok: false,
            to: to.clone(),
            error: Some(
                "Email is not set up: no SMTP host is configured. Save a host first.".to_string(),
            ),
        }
    } else {
        let mailer = state.email.mailer();
        let body = format!(
            "This is a test email from OpenGrid at {}.\n\nIf you can read it, outgoing email \
             works: invitations, password resets and automation emails will be delivered.\n",
            state.config.public_url
        );
        let sent =
            tokio::time::timeout(TEST_TIMEOUT, mailer.send(&to, "OpenGrid test email", &body))
                .await;
        let error = match sent {
            Ok(Ok(())) => None,
            Ok(Err(AppError::Internal(m))) => Some(m),
            Ok(Err(e)) => Some(e.to_string()),
            Err(_) => Some(format!(
                "the mail server did not answer within {} seconds",
                TEST_TIMEOUT.as_secs()
            )),
        };
        EmailTestResult {
            ok: error.is_none(),
            to: to.clone(),
            error,
        }
    };
    let (user_id, ip, detail) = (
        actor.user_id.clone(),
        client.ip.clone(),
        json!({
            "to": to,
            "ok": result.ok,
            "error": result.error.as_deref().map(|e| e.chars().take(300).collect::<String>()),
        }),
    );
    state
        .db
        .write(move |tx| {
            audit::record(
                tx,
                Some(&user_id),
                actions::ADMIN_EMAIL_TEST,
                None,
                Some(detail),
                Some(&ip),
            )
        })
        .await?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(json: serde_json::Value) -> UpdateEmailSettings {
        serde_json::from_value(json).unwrap()
    }

    fn apply(r: serde_json::Value, env: &RawSmtp, stored: &RawSmtp) -> AppResult<RawSmtp> {
        let r = req(r);
        let pw = password_change(&r)?;
        apply_request(&r, pw, env, stored)
    }

    #[test]
    fn password_semantics_are_keep_set_clear() {
        assert_eq!(
            password_change(&req(json!({}))).unwrap(),
            PasswordChange::Keep
        );
        assert_eq!(
            password_change(&req(json!({"password": ""}))).unwrap(),
            PasswordChange::Keep,
            "an empty submit keeps the old password"
        );
        assert_eq!(
            password_change(&req(json!({"password": null}))).unwrap(),
            PasswordChange::Clear
        );
        assert_eq!(
            password_change(&req(json!({"password": "s3cret"}))).unwrap(),
            PasswordChange::Set("s3cret".into())
        );
        assert!(password_change(&req(json!({"password": "a\nb"}))).is_err());
    }

    #[test]
    fn fields_are_validated_and_normalised() {
        let none = RawSmtp::default();
        let s = apply(
            json!({"host": " smtp.example.com ", "port": 465, "security": "TLS", "username": " me ", "from": "OpenGrid <og@example.com>"}),
            &none,
            &none,
        )
        .unwrap();
        assert_eq!(s.host.as_deref(), Some("smtp.example.com"));
        assert_eq!(s.port, Some(465));
        assert_eq!(s.security.as_deref(), Some("tls"));
        assert_eq!(s.user.as_deref(), Some("me"));
        for bad in [
            json!({"host": "https://smtp.example.com"}),
            json!({"host": "smtp.example.com/path"}),
            json!({"host": "a b"}),
            json!({"port": 0}),
            json!({"security": "ssl"}),
            json!({"from": "nope"}),
            json!({"username": "a\u{0}b"}),
        ] {
            assert!(apply(bad.clone(), &none, &none).is_err(), "{bad}");
        }
        // null / blank clear host and username; blank sender goes back to the default
        let stored = RawSmtp {
            host: Some("h.example.com".into()),
            user: Some("u".into()),
            from: Some("A <a@example.com>".into()),
            ..Default::default()
        };
        let s = apply(
            json!({"host": null, "username": "", "from": " "}),
            &none,
            &stored,
        )
        .unwrap();
        assert_eq!((s.host, s.user, s.from), (None, None, None));
        // fields left out keep their values
        let s = apply(json!({"port": 25}), &none, &stored).unwrap();
        assert_eq!(s.host.as_deref(), Some("h.example.com"));
        assert_eq!(s.port, Some(25));
    }

    #[test]
    fn environment_fields_cannot_be_changed() {
        let env = RawSmtp {
            host: Some("env.example.com".into()),
            port: Some(587),
            password: Some("env-secret".into()),
            ..Default::default()
        };
        let stored = RawSmtp::default();
        // a different value is refused and names the variable
        let e = apply(json!({"host": "other.example.com"}), &env, &stored).unwrap_err();
        assert!(e.to_string().contains("OPENGRID_SMTP_HOST"), "{e}");
        assert!(apply(json!({"host": null}), &env, &stored).is_err());
        assert!(apply(json!({"port": 2525}), &env, &stored).is_err());
        let e = apply(json!({"password": "new"}), &env, &stored).unwrap_err();
        assert!(e.to_string().contains("OPENGRID_SMTP_PASSWORD"), "{e}");
        assert!(apply(json!({"password": null}), &env, &stored).is_err());
        // echoing the value in effect is accepted and changes nothing
        let s = apply(
            json!({"host": "env.example.com", "port": 587, "password": ""}),
            &env,
            &stored,
        )
        .unwrap();
        assert_eq!(s, stored);
        // other fields stay editable
        let s = apply(json!({"username": "u", "security": "none"}), &env, &stored).unwrap();
        assert_eq!(s.user.as_deref(), Some("u"));
        assert_eq!(s.security.as_deref(), Some("none"));
    }

    #[test]
    fn changed_fields_never_list_the_password() {
        let a = RawSmtp::default();
        let b = RawSmtp {
            host: Some("h".into()),
            password: Some("secret".into()),
            ..Default::default()
        };
        let changes = changed_fields(&a, &b);
        assert!(changes.contains_key("host"));
        assert!(!changes.contains_key("password"));
        assert!(
            !serde_json::Value::Object(changes)
                .to_string()
                .contains("secret")
        );
    }

    #[test]
    fn target_change_detection_ignores_the_sender_and_password() {
        let env = RawSmtp::default();
        let base = RawSmtp {
            host: Some("h.example.com".into()),
            user: Some("u".into()),
            password: Some("p".into()),
            ..Default::default()
        };
        let r = |s: &RawSmtp| email::resolve(&env, s).unwrap();
        let old = r(&base);
        let mut other = base.clone();
        other.from = Some("X <x@example.com>".into());
        assert!(!target_changed(&old, &r(&other)));
        other.password = Some("different".into());
        assert!(!target_changed(&old, &r(&other)));
        for tweak in [
            |s: &mut RawSmtp| s.host = Some("evil.example.com".into()),
            |s: &mut RawSmtp| s.port = Some(2525),
            |s: &mut RawSmtp| s.security = Some("none".into()),
            |s: &mut RawSmtp| s.user = Some("other".into()),
        ] {
            let mut t = base.clone();
            tweak(&mut t);
            assert!(target_changed(&old, &r(&t)));
        }
    }
}
