//! Setup, signup, login, logout, rate limits and CSRF.

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use common::{Client, TestApp};
use serde_json::json;

const PW: &str = "correct horse battery";

#[tokio::test]
async fn setup_reports_needs_setup_until_first_user() {
    let app = TestApp::new();
    let res = app.get(&app.anon(), "/api/setup").await;
    res.assert_status(200);
    assert_eq!(
        res.body,
        json!({"needs_setup": true, "open_signup": false, "email_enabled": false, "public_url": "http://localhost:8080"})
    );
    app.signup("first@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let res = app.get(&app.anon(), "/api/setup").await;
    assert_eq!(res.body["needs_setup"], false);
}

#[tokio::test]
async fn setup_reflects_config() {
    let app = TestApp::with_config(|c| {
        c.open_signup = true;
        c.smtp_host = Some("smtp.example.com".into());
    });
    let res = app.get(&app.anon(), "/api/setup").await;
    assert_eq!(res.body["open_signup"], true);
    assert_eq!(res.body["email_enabled"], true);
}

#[tokio::test]
async fn setup_reports_the_public_url_without_a_trailing_slash() {
    // The account page builds the address AI assistants connect to from this value.
    let app = TestApp::with_config(|c| c.public_url = "https://base.example.com/".into());
    let res = app.get(&app.anon(), "/api/setup").await;
    assert_eq!(res.body["public_url"], "https://base.example.com");
}

#[tokio::test]
async fn first_user_becomes_admin_and_is_logged_in() {
    let app = TestApp::new();
    let (res, client) = app.signup("Boss@Example.com", PW, None).await;
    res.assert_status(200);
    assert_eq!(res.body["is_admin"], true);
    assert_eq!(res.body["email"], "Boss@Example.com");
    assert_eq!(res.body["totp_enabled"], false);
    assert!(client.cookie.is_some(), "signup sets a session cookie");
    let cookie_header = res
        .headers
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .find(|v| v.starts_with("ob_session="))
        .unwrap();
    assert!(cookie_header.contains("HttpOnly"));
    assert!(cookie_header.contains("SameSite=Lax"));
    let me = app.get(&client, "/api/auth/me").await;
    me.assert_status(200);
    assert_eq!(me.body["id"], res.body["id"]);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'signup' AND user_id = ?1",
            &[res.body["id"].as_str().unwrap()]
        ),
        1
    );
}

#[tokio::test]
async fn second_user_needs_an_invite_by_default() {
    let app = TestApp::new();
    app.signup("first@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let (res, client) = app.signup("second@example.com", PW, None).await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("invitation")
    );
    assert!(client.cookie.is_none());
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 1);
}

#[tokio::test]
async fn open_signup_allows_anyone_as_non_admin() {
    let app = TestApp::with_config(|c| c.open_signup = true);
    app.signup("first@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let (res, _) = app.signup("second@example.com", PW, None).await;
    res.assert_status(200);
    assert_eq!(res.body["is_admin"], false);
}

#[tokio::test]
async fn signup_validates_input() {
    let app = TestApp::new();
    let anon = app.anon();
    for (body, why) in [
        (
            json!({"email": "nope", "name": "A", "password": PW}),
            "bad email",
        ),
        (
            json!({"email": "a@example.com", "name": "  ", "password": PW}),
            "blank name",
        ),
        (
            json!({"email": "a@example.com", "name": "A", "password": "short"}),
            "short password",
        ),
        (
            json!({"email": "a@example.com", "name": "A", "password": "x".repeat(300)}),
            "long password",
        ),
    ] {
        let res = app.post(&anon, "/api/auth/signup", body).await;
        assert_eq!(res.status.as_u16(), 400, "{why}: {}", res.body);
        assert_eq!(res.body["error"]["code"], "bad_request");
    }
    // Malformed JSON never reaches the handler.
    let res = app
        .post(&anon, "/api/auth/signup", json!({"email": 1}))
        .await;
    assert!(res.status.is_client_error());
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 0);
}

#[tokio::test]
async fn duplicate_email_is_rejected_case_insensitively() {
    let app = TestApp::with_config(|c| c.open_signup = true);
    app.signup("a@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let (res, _) = app.signup("A@EXAMPLE.COM", PW, None).await;
    res.assert_status(409);
}

#[tokio::test]
async fn signup_rate_limited_per_ip() {
    let app = TestApp::new();
    app.signup("first@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    // 9 more attempts are refused for lack of an invite but still count.
    for i in 0..9 {
        let (res, _) = app.signup(&format!("u{i}@example.com"), PW, None).await;
        res.assert_status(403);
    }
    let (res, _) = app.signup("late@example.com", PW, None).await;
    res.assert_status(429);
    assert_eq!(res.body["error"]["code"], "too_many_requests");
}

#[tokio::test]
async fn login_succeeds_and_updates_last_login() {
    let app = TestApp::new();
    app.signup("a@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    app.state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE users SET last_login_at = NULL", [])?))
        .unwrap();
    let (res, client) = app.login("A@example.com", PW).await;
    res.assert_status(200);
    assert_eq!(res.body["two_factor_required"], false);
    assert_eq!(res.body["user"]["email"], "a@example.com");
    app.get(&client, "/api/auth/me").await.assert_status(200);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM users WHERE last_login_at IS NOT NULL",
            &[]
        ),
        1
    );
    assert_eq!(
        app.query_i64("SELECT count(*) FROM audit_log WHERE action = 'login'", &[]),
        1
    );
}

#[tokio::test]
async fn wrong_password_and_unknown_email_look_identical() {
    let app = TestApp::new();
    app.signup("a@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let (wrong, c1) = app.login("a@example.com", "wrong password!").await;
    let (unknown, c2) = app.login("ghost@example.com", PW).await;
    wrong.assert_status(401);
    unknown.assert_status(401);
    assert_eq!(wrong.body, unknown.body);
    assert_eq!(wrong.body["error"]["code"], "invalid_credentials");
    assert!(c1.cookie.is_none() && c2.cookie.is_none());
    // Both failures are audited; the known one is attributed to the user.
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'login_failed'",
            &[]
        ),
        2
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'login_failed' AND user_id IS NOT NULL",
            &[]
        ),
        1
    );
}

/// Unknown emails must still pay for an Argon2 verification (DUMMY_HASH), so
/// response time doesn't reveal which accounts exist.
#[tokio::test]
async fn unknown_email_login_takes_as_long_as_wrong_password() {
    let app = TestApp::new();
    app.signup("a@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    // Warm up DUMMY_HASH (computed lazily on first use).
    app.login("warm@example.com", PW).await.0.assert_status(401);
    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for i in 0..3 {
        let t = Instant::now();
        app.login("a@example.com", "wrong password!")
            .await
            .0
            .assert_status(401);
        known.push(t.elapsed());
        let t = Instant::now();
        app.login(&format!("ghost{i}@example.com"), PW)
            .await
            .0
            .assert_status(401);
        unknown.push(t.elapsed());
    }
    known.sort();
    unknown.sort();
    let (k, u) = (known[1], unknown[1]);
    assert!(
        u * 3 >= k,
        "unknown-email login ({u:?}) is much faster than wrong-password login ({k:?})"
    );
    assert!(u >= Duration::from_millis(1));
}

#[tokio::test]
async fn deactivated_user_cannot_log_in() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("u@example.com", "U");
    app.patch(
        &admin,
        &format!("/api/admin/users/{}", user.user_id.as_ref().unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    let (res, c) = app.login("u@example.com", "password1234").await;
    res.assert_status(403);
    assert!(c.cookie.is_none());
    // Wrong password for a deactivated account stays generic.
    let (res, _) = app.login("u@example.com", "nope nope nope").await;
    res.assert_status(401);
}

#[tokio::test]
async fn account_created_without_password_cannot_log_in() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.post(
        &admin,
        "/api/admin/users",
        json!({"email": "new@example.com", "name": "New"}),
    )
    .await
    .assert_status(201);
    let (res, _) = app.login("new@example.com", "!").await;
    res.assert_status(401);
    let (res, _) = app.login("new@example.com", "").await;
    res.assert_status(401);
}

#[tokio::test]
async fn login_rate_limited_per_ip() {
    let app = TestApp::new();
    app.user("a@example.com", "A");
    for _ in 0..10 {
        app.login("a@example.com", "wrong password!")
            .await
            .0
            .assert_status(401);
    }
    // Even the right password is refused while limited.
    let (res, _) = app.login("a@example.com", "password1234").await;
    res.assert_status(429);
}

#[tokio::test]
async fn login_rate_limited_per_email_across_ips() {
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    for i in 0..60 {
        let ip = format!("10.0.{}.{}", i / 10, i % 10);
        let res = app
            .request_with(
                &app.anon(),
                "POST",
                "/api/auth/login",
                Some(json!({"email": "a@example.com", "password": "wrong password!"})),
                &[("x-forwarded-for", ip.as_str())],
                true,
                None,
            )
            .await;
        res.assert_status(401);
    }
    let res = app
        .request_with(
            &app.anon(),
            "POST",
            "/api/auth/login",
            Some(json!({"email": "A@example.com", "password": "password1234"})),
            &[("x-forwarded-for", "10.0.1.1")],
            true,
            None,
        )
        .await;
    res.assert_status(429);
    // Another account from a fresh IP is unaffected.
    app.user("b@example.com", "B");
    let res = app
        .request_with(
            &app.anon(),
            "POST",
            "/api/auth/login",
            Some(json!({"email": "b@example.com", "password": "password1234"})),
            &[("x-forwarded-for", "10.0.2.1")],
            true,
            None,
        )
        .await;
    res.assert_status(200);
}

#[tokio::test]
async fn client_ip_comes_from_peer_or_trusted_proxy_header() {
    let peer: SocketAddr = "192.0.2.7:5555".parse().unwrap();
    // Untrusted proxy: the header is ignored, the peer address is used.
    let app = TestApp::new();
    app.user("a@example.com", "A");
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/login",
        Some(json!({"email": "a@example.com", "password": "bad password"})),
        &[("x-forwarded-for", "203.0.113.9")],
        true,
        Some(peer),
    )
    .await
    .assert_status(401);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM audit_log WHERE ip = '192.0.2.7'", &[]),
        1
    );
    // Without ConnectInfo (in-process) the IP is "unknown".
    app.login("a@example.com", "bad password")
        .await
        .0
        .assert_status(401);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM audit_log WHERE ip = 'unknown'", &[]),
        1
    );

    // Trusted proxy: the last X-Forwarded-For entry (added by the proxy) wins; garbage falls back.
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/login",
        Some(json!({"email": "a@example.com", "password": "bad password"})),
        &[("x-forwarded-for", "10.0.0.1, 203.0.113.9")],
        true,
        Some(peer),
    )
    .await;
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/login",
        Some(json!({"email": "a@example.com", "password": "bad password"})),
        &[("x-forwarded-for", "not-an-ip")],
        true,
        Some(peer),
    )
    .await;
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE ip = '203.0.113.9'",
            &[]
        ),
        1
    );
    assert_eq!(
        app.query_i64("SELECT count(*) FROM audit_log WHERE ip = '192.0.2.7'", &[]),
        1
    );
}

#[tokio::test]
async fn session_records_ip_and_user_agent() {
    let app = TestApp::new();
    app.user("a@example.com", "A");
    let res = app
        .request_with(
            &app.anon(),
            "POST",
            "/api/auth/login",
            Some(json!({"email": "a@example.com", "password": "password1234"})),
            &[("user-agent", "TestBrowser/1.0")],
            true,
            Some("198.51.100.4:1234".parse().unwrap()),
        )
        .await;
    res.assert_status(200);
    let client = Client {
        cookie: res.session_cookie(),
        ..Default::default()
    };
    let sessions = app.get(&client, "/api/auth/sessions").await;
    let current = sessions
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == true)
        .unwrap();
    assert_eq!(current["ip"], "198.51.100.4");
    assert_eq!(current["user_agent"], "TestBrowser/1.0");
}

#[tokio::test]
async fn logout_deletes_session_and_clears_cookie() {
    let app = TestApp::new();
    app.signup("a@example.com", PW, None)
        .await
        .0
        .assert_status(200);
    let (_, client) = app.login("a@example.com", PW).await;
    let res = app.post(&client, "/api/auth/logout", json!({})).await;
    res.assert_status(200);
    let cleared = res.headers.get_all("set-cookie").iter().any(|v| {
        v.to_str().unwrap().starts_with("ob_session=;")
            || v.to_str().unwrap().starts_with("ob_session=\"\"")
    });
    assert!(cleared, "logout must clear the cookie: {:?}", res.headers);
    assert!(res.session_cookie().is_none());
    app.get(&client, "/api/auth/me").await.assert_status(401);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'logout'",
            &[]
        ),
        1
    );
    // Logging out again (or anonymously) is harmless.
    app.post(&client, "/api/auth/logout", json!({}))
        .await
        .assert_status(200);
    app.post(&app.anon(), "/api/auth/logout", json!({}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn cookie_requests_without_csrf_header_are_rejected() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    for (method, path) in [
        ("POST", "/api/auth/logout"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/tokens"),
        ("POST", "/api/auth/password"),
    ] {
        let res = app
            .request_with(&user, method, path, Some(json!({})), &[], false, None)
            .await;
        assert_eq!(res.status.as_u16(), 403, "{method} {path}");
        assert_eq!(res.body["error"]["message"], "missing CSRF header");
    }
    // The session survived (logout was blocked).
    app.get(&user, "/api/auth/me").await.assert_status(200);
    // GETs don't need the header.
    let res = app
        .request_with(&user, "GET", "/api/auth/me", None, &[], false, None)
        .await;
    res.assert_status(200);
}

#[tokio::test]
async fn unauthenticated_requests_get_401() {
    let app = TestApp::new();
    let anon = app.anon();
    for path in [
        "/api/auth/me",
        "/api/auth/sessions",
        "/api/tokens",
        "/api/admin/users",
    ] {
        app.get(&anon, path).await.assert_status(401);
    }
    let bogus = Client {
        cookie: Some("ses_bogus".into()),
        ..Default::default()
    };
    app.get(&bogus, "/api/auth/me").await.assert_status(401);
}
