//! TOTP two-factor authentication: setup, enable, login challenge, disable,
//! replay protection, rate limits and admin reset.

mod common;

use common::{Client, TestApp};
use serde_json::{Value, json};
use totp_rs::{Algorithm, Builder, Secret, Totp};

const PW: &str = "password1234";

fn totp(secret_b32: &str) -> Totp {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(
            Secret::try_from_base32(secret_b32)
                .unwrap()
                .as_bytes()
                .to_vec(),
        )
        .build()
        .unwrap()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Code for a specific step offset from now (-1 = previous 30 s window).
fn code(secret: &str, step_offset: i64) -> String {
    let t = now_secs() as i64 + step_offset * 30;
    totp(secret).generate(t as u64).to_string()
}

/// Turn 2FA on for `user`, returning the secret. Uses the previous window's
/// code so tests can use the current/next windows afterwards.
async fn enable_2fa(app: &TestApp, user: &Client) -> String {
    let res = app.post(user, "/api/auth/2fa/setup", json!({})).await;
    res.assert_status(200);
    let secret = res.body["secret"].as_str().unwrap().to_string();
    let res = app
        .post(
            user,
            "/api/auth/2fa/enable",
            json!({"code": code(&secret, -1)}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["totp_enabled"], true);
    secret
}

#[tokio::test]
async fn setup_returns_secret_and_otpauth_url_without_enabling() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let res = app.post(&user, "/api/auth/2fa/setup", json!({})).await;
    res.assert_status(200);
    let secret = res.body["secret"].as_str().unwrap();
    assert!(Secret::try_from_base32(secret).is_ok());
    let url = res.body["otpauth_url"].as_str().unwrap();
    assert!(
        url.starts_with("otpauth://totp/OpenGrid:a%40example.com?"),
        "{url}"
    );
    assert!(url.contains("issuer=OpenGrid"));
    // Not enabled until a code is verified: login needs no second factor.
    let me = app.get(&user, "/api/auth/me").await;
    assert_eq!(me.body["totp_enabled"], false);
    let (res, _) = app.login("a@example.com", PW).await;
    assert_eq!(res.body["two_factor_required"], false);
    // Running setup again replaces the secret.
    let res2 = app.post(&user, "/api/auth/2fa/setup", json!({})).await;
    assert_ne!(res2.body["secret"], res.body["secret"]);
}

#[tokio::test]
async fn enable_requires_setup_and_a_valid_code() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    app.post(&user, "/api/auth/2fa/enable", json!({"code": "123456"}))
        .await
        .assert_status(400);
    let res = app.post(&user, "/api/auth/2fa/setup", json!({})).await;
    let secret = res.body["secret"].as_str().unwrap().to_string();
    for bad in ["000000", "abcdef", "", "1234567"] {
        // (000000 could collide with the real code once in a million runs.)
        if bad == code(&secret, 0) {
            continue;
        }
        app.post(&user, "/api/auth/2fa/enable", json!({"code": bad}))
            .await
            .assert_status(400);
    }
    let res = app
        .post(
            &user,
            "/api/auth/2fa/enable",
            json!({"code": code(&secret, 0)}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["totp_enabled"], true);
    // Setting up again while enabled is refused.
    app.post(&user, "/api/auth/2fa/setup", json!({}))
        .await
        .assert_status(409);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = '2fa_enable'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn login_with_2fa_full_flow() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;

    let (res, pending) = app.login("a@example.com", PW).await;
    res.assert_status(200);
    assert_eq!(res.body["two_factor_required"], true);
    assert_eq!(res.body["user"], Value::Null);
    assert!(pending.cookie.is_some(), "a pending session cookie is set");

    // The pending session grants no access.
    app.get(&pending, "/api/auth/me").await.assert_status(401);
    app.get(&pending, "/api/auth/sessions")
        .await
        .assert_status(401);
    app.get(&pending, "/api/tokens").await.assert_status(401);
    // ...and does not show up as a session.
    let sessions = app.get(&user, "/api/auth/sessions").await;
    assert_eq!(sessions.body.as_array().unwrap().len(), 1);

    // Wrong code.
    let wrong = if code(&secret, 0) == "000000" {
        "111111"
    } else {
        "000000"
    };
    let res = app
        .post(&pending, "/api/auth/login/2fa", json!({"code": wrong}))
        .await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_code");

    let res = app
        .post(
            &pending,
            "/api/auth/login/2fa",
            json!({"code": code(&secret, 0)}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["user"]["email"], "a@example.com");
    assert_eq!(res.body["two_factor_required"], false);
    let full = Client {
        cookie: res.session_cookie(),
        ..Default::default()
    };
    assert_ne!(full.cookie, pending.cookie, "session token is rotated");
    app.get(&full, "/api/auth/me").await.assert_status(200);
    // The pending token is gone.
    app.post(
        &pending,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, 1)}),
    )
    .await
    .assert_status(401);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'login_2fa_failed'",
            &[]
        ),
        1
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'login' AND detail LIKE '%two_factor%'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn totp_codes_cannot_be_replayed() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;
    let c = code(&secret, 0);
    let (_, p1) = app.login("a@example.com", PW).await;
    app.post(&p1, "/api/auth/login/2fa", json!({"code": c}))
        .await
        .assert_status(200);
    let (_, p2) = app.login("a@example.com", PW).await;
    let res = app
        .post(&p2, "/api/auth/login/2fa", json!({"code": c}))
        .await;
    res.assert_status(401);
    // The code used to enable (previous window) is also dead now.
    app.post(
        &p2,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, -1)}),
    )
    .await
    .assert_status(401);
    // The next window's code still works.
    app.post(
        &p2,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, 1)}),
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn second_factor_needs_a_pending_session() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;
    // No cookie.
    let res = app
        .post(
            &app.anon(),
            "/api/auth/login/2fa",
            json!({"code": code(&secret, 0)}),
        )
        .await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "two_factor_expired");
    // A full session is not a pending one.
    app.post(
        &user,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, 0)}),
    )
    .await
    .assert_status(401);
    // An expired pending session is refused.
    let (_, pending) = app.login("a@example.com", PW).await;
    app.state
        .db
        .write_sync(|tx| {
            Ok(tx.execute(
                "UPDATE sessions SET expires_at = 0 WHERE pending_2fa = 1",
                [],
            )?)
        })
        .unwrap();
    app.post(
        &pending,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, 0)}),
    )
    .await
    .assert_status(401);
}

#[tokio::test]
async fn second_factor_attempts_are_rate_limited_per_pending_session() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;
    let (_, pending) = app.login("a@example.com", PW).await;
    let good = code(&secret, 0);
    let wrong = if good == "000000" { "111111" } else { "000000" };
    for _ in 0..10 {
        app.post(&pending, "/api/auth/login/2fa", json!({"code": wrong}))
            .await
            .assert_status(401);
    }
    app.post(&pending, "/api/auth/login/2fa", json!({"code": good}))
        .await
        .assert_status(429);
}

#[tokio::test]
async fn deactivated_user_cannot_finish_2fa() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;
    let (_, pending) = app.login("a@example.com", PW).await;
    app.patch(
        &admin,
        &format!("/api/admin/users/{}", user.user_id.as_ref().unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    app.post(
        &pending,
        "/api/auth/login/2fa",
        json!({"code": code(&secret, 0)}),
    )
    .await
    .assert_status(401);
}

#[tokio::test]
async fn disable_requires_password_and_code() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let secret = enable_2fa(&app, &user).await;
    app.post(
        &user,
        "/api/auth/2fa/disable",
        json!({"password": "wrong password", "code": code(&secret, 0)}),
    )
    .await
    .assert_status(403);
    let wrong = if code(&secret, 0) == "000000" {
        "111111"
    } else {
        "000000"
    };
    app.post(
        &user,
        "/api/auth/2fa/disable",
        json!({"password": PW, "code": wrong}),
    )
    .await
    .assert_status(400);
    let res = app
        .post(
            &user,
            "/api/auth/2fa/disable",
            json!({"password": PW, "code": code(&secret, 0)}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["totp_enabled"], false);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM users WHERE totp_secret IS NOT NULL",
            &[]
        ),
        0
    );
    let (res, _) = app.login("a@example.com", PW).await;
    assert_eq!(res.body["two_factor_required"], false);
    // Disabling again: not enabled.
    app.post(
        &user,
        "/api/auth/2fa/disable",
        json!({"password": PW, "code": code(&secret, 1)}),
    )
    .await
    .assert_status(400);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = '2fa_disable'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn admin_can_reset_lost_2fa() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("a@example.com", "A");
    enable_2fa(&app, &user).await;
    let res = app
        .patch(
            &admin,
            &format!("/api/admin/users/{}", user.user_id.as_ref().unwrap()),
            json!({"disable_2fa": true}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["totp_enabled"], false);
    let (res, client) = app.login("a@example.com", PW).await;
    assert_eq!(res.body["two_factor_required"], false);
    app.get(&client, "/api/auth/me").await.assert_status(200);
}
