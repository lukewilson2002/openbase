//! Regression tests for the authentication / token / invite security review
//! (see docs/security.md). Each test fails on the code before its fix.

mod common;

use common::{Client, TestApp};
use serde_json::json;

const PW: &str = "password1234";

/// A login attempt from `ip` (needs `trust_proxy`).
async fn login_from(app: &TestApp, ip: &str, email: &str, password: &str) -> common::Response {
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/login",
        Some(json!({"email": email, "password": password})),
        &[("x-forwarded-for", ip)],
        true,
        None,
    )
    .await
}

// ------------------------------------------------- login memory / disk abuse

#[tokio::test]
async fn oversized_login_email_is_refused_before_touching_limiter_or_audit_log() {
    let app = TestApp::new();
    app.user("a@example.com", "A");
    let big = format!("{}@example.com", "a".repeat(2_000_000));
    let res = app
        .post(
            &app.anon(),
            "/api/auth/login",
            json!({"email": big, "password": "whatever password"}),
        )
        .await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_credentials");
    assert_eq!(app.query_i64("SELECT count(*) FROM audit_log", &[]), 0);
    // Only the per-IP counter exists; no per-email key was created.
    assert_eq!(app.state.limiter.len(), 1);

    // A long junk string that is not an email address is refused too.
    let res = app
        .post(
            &app.anon(),
            "/api/auth/login",
            json!({"email": "x".repeat(300), "password": "whatever password"}),
        )
        .await;
    res.assert_status(401);
    assert_eq!(app.query_i64("SELECT count(*) FROM audit_log", &[]), 0);
    assert_eq!(app.state.limiter.len(), 1);
}

#[tokio::test]
async fn failed_logins_from_other_clients_cannot_lock_the_owner_out() {
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    // 24 wrong passwords from three addresses (8 each): more than the old
    // 20-per-email lockout threshold.
    for ip in ["10.1.0.1", "10.1.0.2", "10.1.0.3"] {
        for _ in 0..8 {
            login_from(&app, ip, "a@example.com", "wrong password!")
                .await
                .assert_status(401);
        }
    }
    // The real owner, from a fresh address, can still sign in.
    login_from(&app, "10.1.0.9", "a@example.com", PW)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn one_client_is_limited_per_email_even_across_minutes() {
    // The per-(email, client) bucket outlives the per-minute IP bucket: a
    // guesser who waits a minute cannot keep trying one account from one address.
    let app = TestApp::new();
    app.user("a@example.com", "A");
    for _ in 0..10 {
        app.login("a@example.com", "wrong password!")
            .await
            .0
            .assert_status(401);
    }
    // Simulate the one-minute IP window passing; the hourly bucket remains.
    app.state.limiter.reset("login_ip", "unknown");
    app.login("a@example.com", PW).await.0.assert_status(429);
    // Another account from the same address is unaffected.
    app.user("b@example.com", "B");
    app.login("b@example.com", PW).await.0.assert_status(200);
}

// ------------------------------------------------------------------ 2FA

mod second_factor {
    use super::*;
    use totp_rs::{Algorithm, Builder, Secret};

    fn code(secret_b32: &str, step_offset: i64) -> String {
        let totp = Builder::new()
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
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        totp.generate((now + step_offset * 30) as u64).to_string()
    }

    async fn enable_2fa(app: &TestApp, user: &Client) -> String {
        let res = app.post(user, "/api/auth/2fa/setup", json!({})).await;
        res.assert_status(200);
        let secret = res.body["secret"].as_str().unwrap().to_string();
        app.post(
            user,
            "/api/auth/2fa/enable",
            json!({"code": code(&secret, -1)}),
        )
        .await
        .assert_status(200);
        secret
    }

    #[tokio::test]
    async fn guesses_are_limited_per_account_across_pending_sessions() {
        let app = TestApp::new();
        let user = app.user("a@example.com", "A");
        let secret = enable_2fa(&app, &user).await;
        let good = code(&secret, 0);
        let wrong = if good == "000000" { "111111" } else { "000000" };
        // Each fresh password login hands out a new pending session (with its
        // own 10 guesses); the account as a whole only gets 10 an hour.
        let mut failed = 0;
        for _ in 0..3 {
            let (_, pending) = app.login("a@example.com", PW).await;
            for _ in 0..4 {
                let res = app
                    .post(&pending, "/api/auth/login/2fa", json!({"code": wrong}))
                    .await;
                if res.status == 401 {
                    failed += 1;
                } else {
                    res.assert_status(429);
                }
            }
        }
        assert_eq!(failed, 10, "only 10 wrong guesses per account per hour");
        // Even the right code is refused now, from a brand new pending session.
        let (_, pending) = app.login("a@example.com", PW).await;
        app.post(&pending, "/api/auth/login/2fa", json!({"code": good}))
            .await
            .assert_status(429);
    }

    #[tokio::test]
    async fn random_pending_cookies_do_not_grow_the_limiter_and_are_ip_limited() {
        let app = TestApp::new();
        app.user("a@example.com", "A");
        let mut limited = 0;
        for i in 0..60 {
            let bogus = Client {
                cookie: Some(format!("ses_random_{i}")),
                ..Client::default()
            };
            let res = app
                .post(&bogus, "/api/auth/login/2fa", json!({"code": "123456"}))
                .await;
            if res.status == 429 {
                limited += 1;
            } else {
                res.assert_status(401);
            }
        }
        assert!(limited > 0, "the endpoint has a per-IP limit");
        assert!(
            app.state.limiter.len() <= 2,
            "random cookies created {} limiter keys",
            app.state.limiter.len()
        );
    }
}
