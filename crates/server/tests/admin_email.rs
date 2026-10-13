//! The Admin -> Email settings: defaults, layering with the `OPENGRID_SMTP_*` environment,
//! write-only password, immediate effect, persistence across a restart, the test email (including
//! the real error of an unreachable or refusing mail server), audit rows and who may do what.

mod common;

use std::sync::Arc;

use common::{Client, TestApp};
use opengrid::config::Config;
use opengrid::email::{CapturingMailer, RawSmtp, smtp_factory};
use opengrid::state::AppState;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const SECRET: &str = "S3cr3t-smtp-pa55word!";

async fn settings(app: &TestApp, c: &Client) -> Value {
    let res = app.get(c, "/api/admin/email").await;
    res.assert_status(200);
    res.body
}

/// A port nothing listens on.
fn closed_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

fn audit_rows(app: &TestApp, action: &str) -> Vec<Value> {
    app.state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare(
                "SELECT user_id, target, detail FROM audit_log WHERE action = ?1 ORDER BY id",
            )?;
            let rows = stmt
                .query_map([action], |r| {
                    let detail: Option<String> = r.get(2)?;
                    Ok(json!({
                        "user_id": r.get::<_, Option<String>>(0)?,
                        "detail": detail.and_then(|d| serde_json::from_str::<Value>(&d).ok()),
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap()
}

// ------------------------------------------------------------------------------ the basics

#[tokio::test]
async fn a_fresh_instance_has_email_off_and_shows_defaults_and_budgets() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let s = settings(&app, &admin).await;
    assert_eq!(s["enabled"], false);
    assert_eq!(s["source"], "unset");
    assert!(s["host"].is_null() && s["username"].is_null());
    assert_eq!(s["port"], 587);
    assert_eq!(s["security"], "starttls");
    assert_eq!(s["from"], "OpenGrid <opengrid@localhost>");
    assert_eq!(s["password_set"], false);
    assert_eq!(s["sources"]["host"], "unset");
    assert_eq!(s["sources"]["port"], "default");
    assert_eq!(s["sources"]["security"], "default");
    assert_eq!(s["sources"]["password"], "unset");
    assert_eq!(s["sources"]["from"], "default");
    // the budgets are the environment's, read-only
    assert_eq!(s["budgets"], json!({"per_user_hour": 100, "per_hour": 500}));
    // the public setup status follows the settings
    let setup = app.get(&app.anon(), "/api/setup").await;
    assert_eq!(setup.body["email_enabled"], false);
}

#[tokio::test]
async fn only_administrators_reach_the_email_settings() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let plain = app.user("plain@example.com", "Plain");
    for (method, path, body) in [
        ("GET", "/api/admin/email", None),
        ("PATCH", "/api/admin/email", Some(json!({"port": 25}))),
        ("POST", "/api/admin/email/test", Some(json!({}))),
    ] {
        let res = app.request(&plain, method, path, body.clone()).await;
        assert_eq!(res.status.as_u16(), 403, "{method} {path} as a plain user");
        let res = app.request(&app.anon(), method, path, body.clone()).await;
        assert_eq!(res.status.as_u16(), 401, "{method} {path} anonymously");
        // an administrator's tokens: only a manage token that is not limited to bases
        let (_, base) = app.workspace_with_base(&admin, "Acme");
        for (label, scope, status) in [
            ("read-only", json!({"write": false}), 403),
            ("write-only", json!({"write": true}), 403),
            (
                "base-limited manage",
                json!({"write": true, "manage": true, "base_ids": [base]}),
                403,
            ),
        ] {
            let mut t = json!({"name": "t"});
            for (k, v) in scope.as_object().unwrap() {
                t[k] = v.clone();
            }
            let token = app.api_token(&admin, t).await;
            let res = app.request(&token, method, path, body.clone()).await;
            assert_eq!(res.status.as_u16(), status, "{label}: {method} {path}");
        }
        let manage = app
            .api_token(&admin, json!({"name": "m", "write": true, "manage": true}))
            .await;
        let res = app.request(&manage, method, path, body.clone()).await;
        assert_eq!(res.status.as_u16(), 200, "manage token: {method} {path}");
        // and a non-admin's manage token
        let plain_manage = app
            .api_token(&plain, json!({"name": "pm", "write": true, "manage": true}))
            .await;
        let res = app.request(&plain_manage, method, path, body).await;
        assert_eq!(res.status.as_u16(), 403, "non-admin manage token");
    }
}

// ------------------------------------------------------------- saving, effect, persistence

#[tokio::test]
async fn saved_settings_take_effect_immediately_without_a_restart() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.user("someone@example.com", "Someone");
    let request_reset = || async {
        app.post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "someone@example.com"}),
        )
        .await
        .assert_status(200);
    };

    // off: a reset request sends nothing
    request_reset().await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(app.mailer.sent().is_empty());

    // save a host: the very next request sends mail
    let res = app
        .patch(
            &admin,
            "/api/admin/email",
            json!({
                "host": "smtp.example.com", "port": 2525, "security": "tls",
                "username": "mailer", "password": SECRET,
                "from": "Acme Grid <grid@example.com>"
            }),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["enabled"], true);
    assert_eq!(res.body["source"], "settings");
    assert_eq!(res.body["host"], "smtp.example.com");
    assert_eq!(res.body["port"], 2525);
    assert_eq!(res.body["security"], "tls");
    assert_eq!(res.body["username"], "mailer");
    assert_eq!(res.body["from"], "Acme Grid <grid@example.com>");
    assert_eq!(res.body["password_set"], true);
    for k in ["host", "port", "security", "username", "password", "from"] {
        assert_eq!(res.body["sources"][k], "settings", "{k}");
    }
    assert_eq!(
        app.get(&app.anon(), "/api/setup").await.body["email_enabled"],
        true
    );
    request_reset().await;
    let sent = app.mailer.wait_for(1).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "someone@example.com");

    // clear the host: email is off again, at once
    let res = app
        .patch(&admin, "/api/admin/email", json!({"host": null}))
        .await;
    res.assert_status(200);
    assert_eq!(res.body["enabled"], false);
    assert!(res.body["host"].is_null());
    assert_eq!(res.body["source"], "unset");
    // the other settings are kept for when it is switched on again
    assert_eq!(res.body["port"], 2525);
    assert_eq!(res.body["password_set"], true);
    request_reset().await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(app.mailer.sent().len(), 1, "nothing more was sent");
}

#[tokio::test]
async fn automations_see_email_turn_on_and_off() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let (_, base) = app.workspace_with_base(&admin, "Acme");
    let body = json!({
        "name": "Mail", "enabled": false,
        "trigger": {"type": "schedule", "cron": "0 9 * * *", "timezone": "UTC"},
        "actions": [{"type": "send_email", "to": "a@example.com", "subject": "s", "body": "b"}],
    });
    let refused = app
        .post(
            &admin,
            &format!("/api/bases/{base}/automations"),
            body.clone(),
        )
        .await;
    assert_eq!(refused.status.as_u16(), 400, "{}", refused.body);
    assert!(
        refused.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Admin > Email"),
        "{}",
        refused.body
    );
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "smtp.example.com"}),
    )
    .await
    .assert_status(200);
    app.post(&admin, &format!("/api/bases/{base}/automations"), body)
        .await
        .assert_status(201);
}

#[tokio::test]
async fn settings_survive_a_restart_and_the_environment_then_wins() {
    let dir = tempfile::tempdir().unwrap();
    let factory = || -> opengrid::email::MailerFactory {
        let m = Arc::new(CapturingMailer::default());
        Arc::new(move |_| Ok(m.clone() as Arc<dyn opengrid::email::Mailer>))
    };
    let config = |f: &dyn Fn(&mut Config)| {
        let mut c = Config::for_tests(dir.path());
        f(&mut c);
        c
    };

    // first run: save through the API
    {
        let state = AppState::open_with_mail(config(&|_| {}), factory()).unwrap();
        let router = opengrid::http::router(state.clone());
        let app = TestApp::from_parts(state, router);
        let admin = app.admin("admin@example.com", "Admin");
        app.patch(
            &admin,
            "/api/admin/email",
            json!({"host": "stored.example.com", "port": 465, "security": "tls", "username": "u", "password": SECRET}),
        )
        .await
        .assert_status(200);
    }

    // second run, no environment: everything is back, password included
    {
        let state = AppState::open_with_mail(config(&|_| {}), factory()).unwrap();
        let resolved = state.email.resolved();
        let smtp = resolved.smtp.unwrap();
        assert_eq!(smtp.host, "stored.example.com");
        assert_eq!(smtp.port, 465);
        assert_eq!(smtp.user.as_deref(), Some("u"));
        assert_eq!(smtp.password.as_deref(), Some(SECRET));
        assert!(state.email.enabled());
    }

    // third run, the environment sets host and password: those win, the rest is stored
    {
        let state = AppState::open_with_mail(
            config(&|c| {
                c.smtp_host = Some("env.example.com".into());
                c.smtp_password = Some("env-password".into());
            }),
            factory(),
        )
        .unwrap();
        let resolved = state.email.resolved();
        let smtp = resolved.smtp.clone().unwrap();
        assert_eq!(smtp.host, "env.example.com");
        assert_eq!(smtp.password.as_deref(), Some("env-password"));
        assert_eq!(smtp.port, 465, "not in the environment: the saved value");
        assert_eq!(smtp.user.as_deref(), Some("u"));
        assert_eq!(resolved.sources.host, "environment");
        assert_eq!(resolved.sources.password, "environment");
        assert_eq!(resolved.sources.port, "settings");
        // the API shows it and refuses to change the locked fields
        let router = opengrid::http::router(state.clone());
        let app = TestApp::from_parts(state, router);
        let admin = app.login("admin@example.com", "password1234").await.1;
        let s = settings(&app, &admin).await;
        assert_eq!(s["source"], "environment");
        assert_eq!(s["sources"]["host"], "environment");
        assert_eq!(s["sources"]["password"], "environment");
        assert_eq!(s["sources"]["security"], "settings");
        assert_eq!(s["password_set"], true);
        assert!(!s.to_string().contains("env-password") && !s.to_string().contains(SECRET));
    }
}

#[tokio::test]
async fn environment_settings_are_read_only_and_everything_else_stays_editable() {
    let app = TestApp::with_config(|c| {
        c.smtp_host = Some("env.example.com".into());
        c.smtp_port = Some(2525);
        c.smtp_password = Some("env-secret".into());
    });
    let admin = app.admin("admin@example.com", "Admin");
    let s = settings(&app, &admin).await;
    assert_eq!(s["enabled"], true);
    assert_eq!(s["source"], "environment");
    assert_eq!(s["host"], "env.example.com");
    assert_eq!(s["port"], 2525);
    assert_eq!(s["password_set"], true);
    assert_eq!(s["sources"]["host"], "environment");
    assert_eq!(s["sources"]["port"], "environment");
    assert_eq!(s["sources"]["password"], "environment");
    assert_eq!(s["sources"]["security"], "default");
    assert_eq!(s["sources"]["username"], "unset");
    assert!(!s.to_string().contains("env-secret"));

    for (body, var) in [
        (json!({"host": "other.example.com"}), "OPENGRID_SMTP_HOST"),
        (json!({"host": null}), "OPENGRID_SMTP_HOST"),
        (json!({"port": 25}), "OPENGRID_SMTP_PORT"),
        (json!({"password": "new"}), "OPENGRID_SMTP_PASSWORD"),
        (json!({"password": null}), "OPENGRID_SMTP_PASSWORD"),
    ] {
        let res = app.patch(&admin, "/api/admin/email", body.clone()).await;
        assert_eq!(res.status.as_u16(), 400, "{body}: {}", res.body);
        assert!(
            res.body["error"]["message"].as_str().unwrap().contains(var),
            "{body}: {}",
            res.body
        );
    }
    // nothing was stored by the refused calls
    assert_eq!(
        app.query_i64("SELECT count(*) FROM settings WHERE key LIKE 'smtp.%'", &[]),
        0
    );
    // sending back what the environment says is fine (a client may echo the whole form)
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "env.example.com", "port": 2525, "password": ""}),
    )
    .await
    .assert_status(200);
    // the other fields can be managed
    let res = app
        .patch(
            &admin,
            "/api/admin/email",
            json!({"username": "me", "security": "none", "from": "Grid <g@example.com>"}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["username"], "me");
    assert_eq!(res.body["sources"]["username"], "settings");
    assert_eq!(res.body["sources"]["host"], "environment");
}

// ------------------------------------------------------------------------------- password

#[tokio::test]
async fn the_password_is_write_only_keep_replace_and_clear() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let everything = |v: &Value| v.to_string();

    let saved = app
        .patch(
            &admin,
            "/api/admin/email",
            json!({"host": "smtp.example.com", "username": "u", "password": SECRET}),
        )
        .await;
    saved.assert_status(200);
    assert_eq!(saved.body["password_set"], true);
    assert!(
        !everything(&saved.body).contains(SECRET),
        "not in the PATCH response"
    );
    assert!(
        !everything(&settings(&app, &admin).await).contains(SECRET),
        "not in GET"
    );
    assert!(!String::from_utf8_lossy(&saved.bytes).contains(SECRET));
    // stored, and used by the transport
    assert_eq!(
        app.state.email.resolved().smtp.unwrap().password.as_deref(),
        Some(SECRET)
    );

    // an empty submit keeps it; changing other fields keeps it
    let res = app
        .patch(
            &admin,
            "/api/admin/email",
            json!({"password": "", "port": 465}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["password_set"], true);
    assert_eq!(
        app.state.email.resolved().smtp.unwrap().password.as_deref(),
        Some(SECRET)
    );

    // replace
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"password": "another-secret-1"}),
    )
    .await
    .assert_status(200);
    assert_eq!(
        app.state.email.resolved().smtp.unwrap().password.as_deref(),
        Some("another-secret-1")
    );

    // explicit clear (null)
    let res = app
        .patch(&admin, "/api/admin/email", json!({"password": null}))
        .await;
    res.assert_status(200);
    assert_eq!(res.body["password_set"], false);
    assert_eq!(res.body["sources"]["password"], "unset");
    assert!(app.state.email.resolved().smtp.unwrap().password.is_none());
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM settings WHERE key = 'smtp.password'",
            &[]
        ),
        0,
        "the stored row is gone"
    );

    // invalid values
    for bad in [
        json!({"password": "a\nb"}),
        json!({"password": "x".repeat(2000)}),
    ] {
        app.patch(&admin, "/api/admin/email", bad)
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn the_password_never_appears_in_the_audit_log_or_the_test_email() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "smtp.example.com", "password": SECRET}),
    )
    .await
    .assert_status(200);
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"password": format!("{SECRET}-2")}),
    )
    .await
    .assert_status(200);
    app.patch(&admin, "/api/admin/email", json!({"password": null}))
        .await
        .assert_status(200);
    app.post(&admin, "/api/admin/email/test", json!({}))
        .await
        .assert_status(200);
    let dump: String = app
        .state
        .db
        .write_sync(|tx| {
            let mut stmt =
                tx.prepare("SELECT coalesce(detail, '') || coalesce(target, '') FROM audit_log")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows.join("\n"))
        })
        .unwrap();
    assert!(!dump.contains("S3cr3t"), "{dump}");
    let rows = audit_rows(&app, "admin_email_update");
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(rows[0]["detail"]["host"], "smtp.example.com");
    assert_eq!(rows[0]["detail"]["password"], "set");
    assert_eq!(rows[1]["detail"]["password"], "replaced");
    assert_eq!(rows[2]["detail"]["password"], "removed");
    assert_eq!(rows[0]["user_id"], admin.user_id.clone().unwrap());
    for m in app.mailer.sent() {
        assert!(!m.body.contains("S3cr3t") && !m.subject.contains("S3cr3t"));
    }
}

#[tokio::test]
async fn invalid_settings_are_refused_and_change_nothing() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "smtp.example.com"}),
    )
    .await
    .assert_status(200);
    for bad in [
        json!({"host": "https://smtp.example.com"}),
        json!({"host": "smtp.example.com/x"}),
        json!({"host": "a b"}),
        json!({"host": "x".repeat(300)}),
        json!({"port": 0}),
        json!({"port": 70000}),
        json!({"security": "ssl"}),
        json!({"from": "not an address"}),
        json!({"username": "bad\u{0}user"}),
        json!({"unknown_field": 1}),
    ] {
        let res = app.patch(&admin, "/api/admin/email", bad.clone()).await;
        assert!(
            matches!(res.status.as_u16(), 400 | 422),
            "{bad}: {} {}",
            res.status,
            res.body
        );
    }
    let s = settings(&app, &admin).await;
    assert_eq!(s["host"], "smtp.example.com");
    assert_eq!(s["port"], 587);
    assert_eq!(s["security"], "starttls");
    assert!(
        audit_rows(&app, "admin_email_update").len() == 1,
        "only the good change"
    );
    // an empty PATCH is accepted and records nothing
    app.patch(&admin, "/api/admin/email", json!({}))
        .await
        .assert_status(200);
    assert!(audit_rows(&app, "admin_email_update").len() == 1);
}

// ------------------------------------------------------------------------- token rules

#[tokio::test]
async fn an_admin_manage_token_reads_and_edits_but_never_touches_the_password() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let token = app
        .api_token(
            &admin,
            json!({"name": "agent", "write": true, "manage": true}),
        )
        .await;

    // no password yet: a token may set up the connection
    let res = app
        .patch(
            &token,
            "/api/admin/email",
            json!({"host": "smtp.example.com", "port": 587, "username": "u", "from": "G <g@example.com>"}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["host"], "smtp.example.com");

    // ... but it can never set, replace or remove the password
    for body in [
        json!({"password": SECRET}),
        json!({"password": null}),
        json!({"host": "other.example.com", "password": SECRET}),
    ] {
        let res = app.patch(&token, "/api/admin/email", body.clone()).await;
        assert_eq!(res.status.as_u16(), 403, "{body}: {}", res.body);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("API tokens can never"),
            "{}",
            res.body
        );
    }
    assert_eq!(
        settings(&app, &admin).await["host"],
        "smtp.example.com",
        "all-or-nothing"
    );
    // "keep" is not a change
    app.patch(&token, "/api/admin/email", json!({"password": ""}))
        .await
        .assert_status(200);

    // the administrator, signed in, sets the password
    app.patch(&admin, "/api/admin/email", json!({"password": SECRET}))
        .await
        .assert_status(200);

    // now the token must not be able to point the password at another server
    for body in [
        json!({"host": "evil.example.com"}),
        json!({"host": null}),
        json!({"port": 25}),
        json!({"security": "none"}),
        json!({"username": "someone-else"}),
        json!({"username": null}),
    ] {
        let res = app.patch(&token, "/api/admin/email", body.clone()).await;
        assert_eq!(res.status.as_u16(), 403, "{body}: {}", res.body);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("different server"),
            "{}",
            res.body
        );
    }
    let s = settings(&app, &token).await;
    assert_eq!(s["host"], "smtp.example.com");
    assert_eq!(s["username"], "u");
    assert_eq!(s["password_set"], true);
    assert_eq!(
        app.state.email.resolved().smtp.unwrap().password.as_deref(),
        Some(SECRET)
    );
    // changes that do not move the password are fine, and so is repeating the current values
    let res = app
        .patch(
            &token,
            "/api/admin/email",
            json!({"from": "Grid <grid@example.com>", "host": "smtp.example.com", "port": 587}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["from"], "Grid <grid@example.com>");
    // the signed-in administrator can still move it
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "new.example.com"}),
    )
    .await
    .assert_status(200);

    // every token use is audited, and the token's own changes name the token's user
    let uses = app.query_i64(
        "SELECT count(*) FROM audit_log WHERE action = 'admin_token_use'",
        &[],
    );
    assert!(uses >= 8, "{uses}");
}

// --------------------------------------------------------------------------- test email

#[tokio::test]
async fn the_test_email_goes_to_the_admin_or_to_a_given_address() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");

    // email off: a normal answer that says so
    let res = app.post(&admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["ok"], false);
    assert_eq!(res.body["to"], "admin@example.com");
    assert!(res.body["error"].as_str().unwrap().contains("no SMTP host"));
    assert!(app.mailer.sent().is_empty());

    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "smtp.example.com"}),
    )
    .await
    .assert_status(200);
    let res = app.post(&admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["ok"], true, "{}", res.body);
    assert_eq!(res.body["to"], "admin@example.com");
    assert!(res.body["error"].is_null());
    let sent = app.mailer.wait_for(1).await;
    assert_eq!(sent[0].to, "admin@example.com");
    assert!(sent[0].subject.contains("test email"));
    assert!(sent[0].body.contains("http://localhost:8080"));

    let res = app
        .post(
            &admin,
            "/api/admin/email/test",
            json!({"to": " ops@example.org "}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["to"], "ops@example.org");
    assert_eq!(app.mailer.wait_for(2).await[1].to, "ops@example.org");

    // bad recipients are a request error, nothing is sent
    for bad in [
        "nope",
        "a b@example.com",
        "Name <a@example.com>",
        &"x".repeat(300),
    ] {
        let res = app
            .post(&admin, "/api/admin/email/test", json!({"to": bad}))
            .await;
        assert_eq!(res.status.as_u16(), 400, "{bad}: {}", res.body);
    }
    assert_eq!(app.mailer.sent().len(), 2);

    // audited, with the outcome
    let rows = audit_rows(&app, "admin_email_test");
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(rows[0]["detail"]["ok"], false);
    assert_eq!(rows[1]["detail"]["ok"], true);
    assert_eq!(rows[2]["detail"]["to"], "ops@example.org");
}

#[tokio::test]
async fn the_test_email_counts_against_the_budgets_and_a_hard_cap() {
    let app = TestApp::with_config(|c| {
        c.smtp_host = Some("smtp.example.com".into());
        c.email_per_hour = 2;
    });
    let admin = app.admin("admin@example.com", "Admin");
    for _ in 0..2 {
        app.post(&admin, "/api/admin/email/test", json!({}))
            .await
            .assert_status(200);
    }
    app.post(&admin, "/api/admin/email/test", json!({}))
        .await
        .assert_status(429);

    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    for _ in 0..20 {
        app.post(&admin, "/api/admin/email/test", json!({}))
            .await
            .assert_status(200);
    }
    app.post(&admin, "/api/admin/email/test", json!({}))
        .await
        .assert_status(429);
}

#[tokio::test]
async fn an_unreachable_mail_server_is_reported_with_the_real_error() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let port = closed_port();
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "127.0.0.1", "port": port, "security": "none"}),
    )
    .await
    .assert_status(200);
    // talk real SMTP from here on
    app.state
        .email
        .set_factory(
            smtp_factory(),
            &RawSmtp {
                host: Some("127.0.0.1".into()),
                port: Some(port),
                security: Some("none".into()),
                ..Default::default()
            },
        )
        .unwrap();

    let res = app.post(&admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["ok"], false);
    let error = res.body["error"].as_str().unwrap().to_lowercase();
    assert!(
        error.contains("refused") || error.contains("connect"),
        "the real connection error: {error}"
    );
    assert!(!error.contains("internal error"), "{error}");
    assert!(app.mailer.sent().is_empty());
    let rows = audit_rows(&app, "admin_email_test");
    assert_eq!(rows[0]["detail"]["ok"], false);
    assert!(rows[0]["detail"]["error"].is_string());

    // an unresolvable host is reported too
    app.state
        .email
        .set_factory(
            smtp_factory(),
            &RawSmtp {
                host: Some("nonexistent.invalid".into()),
                security: Some("none".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let res = app.post(&admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["ok"], false);
    assert!(res.body["error"].as_str().unwrap().len() > 5);
}

/// A tiny SMTP server that greets and then refuses everything with a distinctive message.
async fn refusing_smtp_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut lines = BufReader::new(r).lines();
                let _ = w.write_all(b"220 refuser.test ESMTP ready\r\n").await;
                while let Ok(Some(line)) = lines.next_line().await {
                    let up = line.to_uppercase();
                    let reply: &[u8] = if up.starts_with("QUIT") {
                        b"221 bye\r\n"
                    } else if up.starts_with("EHLO") || up.starts_with("HELO") {
                        b"554 5.7.1 Relay access denied for tests\r\n"
                    } else {
                        b"502 5.5.2 not implemented\r\n"
                    };
                    let _ = w.write_all(reply).await;
                    if up.starts_with("QUIT") {
                        break;
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_server_that_refuses_the_message_is_quoted() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let port = refusing_smtp_server().await;
    app.patch(
        &admin,
        "/api/admin/email",
        json!({"host": "127.0.0.1", "port": port, "security": "none"}),
    )
    .await
    .assert_status(200);
    app.state
        .email
        .set_factory(
            smtp_factory(),
            &RawSmtp {
                host: Some("127.0.0.1".into()),
                port: Some(port),
                security: Some("none".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let res = app.post(&admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["ok"], false);
    let error = res.body["error"].as_str().unwrap();
    assert!(
        error.contains("Relay access denied for tests") || error.contains("554"),
        "the server's own reply is shown: {error}"
    );
}
