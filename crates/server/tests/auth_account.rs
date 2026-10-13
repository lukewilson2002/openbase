//! Profile, password change, sessions, and password reset.

mod common;

use common::{Client, TestApp};
use serde_json::json;

const PW: &str = "password1234";

fn extract_token(body: &str) -> String {
    let start = body.find("token=").expect("reset link in email") + "token=".len();
    body[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

#[tokio::test]
async fn me_returns_profile_and_patch_updates_it() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "Ann");
    let res = app.get(&user, "/api/auth/me").await;
    res.assert_status(200);
    assert_eq!(res.body["name"], "Ann");
    assert_eq!(res.body["is_admin"], false);
    assert_eq!(res.body["timezone"], serde_json::Value::Null);

    let res = app
        .patch(
            &user,
            "/api/auth/me",
            json!({"name": "  Annie ", "timezone": "Europe/Paris"}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["name"], "Annie");
    assert_eq!(res.body["timezone"], "Europe/Paris");

    // Omitted fields are untouched; empty timezone clears it.
    let res = app
        .patch(&user, "/api/auth/me", json!({"timezone": ""}))
        .await;
    assert_eq!(res.body["name"], "Annie");
    assert_eq!(res.body["timezone"], serde_json::Value::Null);

    for bad in [
        json!({"name": ""}),
        json!({"timezone": "Not/AZone"}),
        json!({"name": "x".repeat(101)}),
    ] {
        app.patch(&user, "/api/auth/me", bad)
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn password_change_requires_current_and_revokes_other_sessions() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (_, other_device) = app.login("a@example.com", PW).await;
    app.get(&other_device, "/api/auth/me")
        .await
        .assert_status(200);

    let res = app
        .post(
            &user,
            "/api/auth/password",
            json!({"current_password": "wrong password", "new_password": "brand new password"}),
        )
        .await;
    res.assert_status(403);
    let res = app
        .post(
            &user,
            "/api/auth/password",
            json!({"current_password": PW, "new_password": "short"}),
        )
        .await;
    res.assert_status(400);

    let res = app
        .post(
            &user,
            "/api/auth/password",
            json!({"current_password": PW, "new_password": "brand new password"}),
        )
        .await;
    res.assert_status(200);
    // This session survives, the other device is signed out.
    app.get(&user, "/api/auth/me").await.assert_status(200);
    app.get(&other_device, "/api/auth/me")
        .await
        .assert_status(401);
    app.login("a@example.com", PW).await.0.assert_status(401);
    app.login("a@example.com", "brand new password")
        .await
        .0
        .assert_status(200);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'password_change'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn password_change_attempts_are_rate_limited() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    for _ in 0..10 {
        app.post(
            &user,
            "/api/auth/password",
            json!({"current_password": "guess guess", "new_password": "brand new password"}),
        )
        .await
        .assert_status(403);
    }
    app.post(
        &user,
        "/api/auth/password",
        json!({"current_password": PW, "new_password": "brand new password"}),
    )
    .await
    .assert_status(429);
}

#[tokio::test]
async fn sessions_list_revoke_one_and_revoke_others() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");
    let (_, laptop) = app.login("a@example.com", PW).await;
    let (_, phone) = app.login("a@example.com", PW).await;
    let other_user = app.user("b@example.com", "B");

    let res = app.get(&me, "/api/auth/sessions").await;
    res.assert_status(200);
    let list = res.body.as_array().unwrap().clone();
    assert_eq!(list.len(), 3);
    assert_eq!(list.iter().filter(|s| s["current"] == true).count(), 1);
    for s in &list {
        let id = s["id"].as_str().unwrap();
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // Find the laptop's id from its own listing.
    let laptop_list = app.get(&laptop, "/api/auth/sessions").await;
    let laptop_id = laptop_list
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == true)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Another user can't revoke it (404), malformed ids are 404.
    app.delete(&other_user, &format!("/api/auth/sessions/{laptop_id}"))
        .await
        .assert_status(404);
    app.delete(&me, "/api/auth/sessions/zzzz")
        .await
        .assert_status(404);
    app.delete(&me, "/api/auth/sessions/%27%20OR%201%3D1--")
        .await
        .assert_status(404);

    app.delete(&me, &format!("/api/auth/sessions/{laptop_id}"))
        .await
        .assert_status(204);
    app.get(&laptop, "/api/auth/me").await.assert_status(401);
    app.get(&phone, "/api/auth/me").await.assert_status(200);
    app.delete(&me, &format!("/api/auth/sessions/{laptop_id}"))
        .await
        .assert_status(404);

    app.post(&me, "/api/auth/sessions/revoke-others", json!({}))
        .await
        .assert_status(200);
    app.get(&phone, "/api/auth/me").await.assert_status(401);
    app.get(&me, "/api/auth/me").await.assert_status(200);
    app.get(&other_user, "/api/auth/me")
        .await
        .assert_status(200);
    let res = app.get(&me, "/api/auth/sessions").await;
    assert_eq!(res.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn reset_request_without_email_configured_is_silent() {
    let app = TestApp::new();
    app.user("a@example.com", "A");
    let res = app
        .post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "a@example.com"}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM password_resets", &[]),
        0
    );
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(app.mailer.sent().is_empty());
}

#[tokio::test]
async fn password_reset_full_flow_by_email() {
    let app = TestApp::with_config(|c| {
        c.smtp_host = Some("smtp.example.com".into());
        c.public_url = "https://base.example.com".into();
    });
    let user = app.user("a@example.com", "Ann");
    let (_, other_device) = app.login("a@example.com", PW).await;

    // Unknown emails get the same answer and no email.
    let res = app
        .post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "ghost@example.com"}),
        )
        .await;
    res.assert_status(200);
    let res2 = app
        .post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "A@example.com"}),
        )
        .await;
    res2.assert_status(200);
    assert_eq!(res.body, res2.body);

    let sent = app.mailer.wait_for(1).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "a@example.com");
    assert!(
        sent[0]
            .body
            .contains("https://base.example.com/reset-password?token=rst_")
    );
    assert!(sent[0].body.contains("Ann"));
    let token = extract_token(&sent[0].body);

    // Weak password is refused without consuming the token.
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "short"}),
    )
    .await
    .assert_status(400);

    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "my new password"}),
    )
    .await
    .assert_status(200);

    // All sessions revoked, old password dead, new one works.
    app.get(&user, "/api/auth/me").await.assert_status(401);
    app.get(&other_device, "/api/auth/me")
        .await
        .assert_status(401);
    app.login("a@example.com", PW).await.0.assert_status(401);
    app.login("a@example.com", "my new password")
        .await
        .0
        .assert_status(200);

    // Single use.
    let res = app
        .post(
            &app.anon(),
            "/api/auth/password-reset/confirm",
            json!({"token": token, "new_password": "another password"}),
        )
        .await;
    res.assert_status(400);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("invalid or has expired")
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'password_reset'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn expired_or_bogus_reset_tokens_are_rejected() {
    let app = TestApp::with_config(|c| c.smtp_host = Some("smtp.example.com".into()));
    app.user("a@example.com", "A");
    app.post(
        &app.anon(),
        "/api/auth/password-reset/request",
        json!({"email": "a@example.com"}),
    )
    .await
    .assert_status(200);
    let token = extract_token(&app.mailer.wait_for(1).await[0].body);
    app.state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE password_resets SET expires_at = 0", [])?))
        .unwrap();
    for t in [token.as_str(), "rst_bogus", ""] {
        app.post(
            &app.anon(),
            "/api/auth/password-reset/confirm",
            json!({"token": t, "new_password": "my new password"}),
        )
        .await
        .assert_status(400);
    }
}

#[tokio::test]
async fn reset_for_deactivated_user_sends_nothing() {
    let app = TestApp::with_config(|c| c.smtp_host = Some("smtp.example.com".into()));
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("a@example.com", "A");
    app.patch(
        &admin,
        &format!("/api/admin/users/{}", user.user_id.unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    app.post(
        &app.anon(),
        "/api/auth/password-reset/request",
        json!({"email": "a@example.com"}),
    )
    .await
    .assert_status(200);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(app.mailer.sent().is_empty());
}

#[tokio::test]
async fn reset_request_rate_limited_per_ip() {
    let app = TestApp::new();
    for _ in 0..5 {
        app.post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "x@example.com"}),
        )
        .await
        .assert_status(200);
    }
    app.post(
        &app.anon(),
        "/api/auth/password-reset/request",
        json!({"email": "x@example.com"}),
    )
    .await
    .assert_status(429);
}

#[tokio::test]
async fn admin_reset_link_works_without_email() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("a@example.com", "A");
    let uid = user.user_id.clone().unwrap();
    let res = app
        .post(
            &admin,
            &format!("/api/admin/users/{uid}/reset-link"),
            json!({}),
        )
        .await;
    res.assert_status(200);
    let url = res.body["url"].as_str().unwrap();
    assert!(url.starts_with("http://localhost:8080/reset-password?token=rst_"));
    assert!(res.body["expires_at"].as_i64().unwrap() > openbase::db::now_ms() + 23 * 3600 * 1000);
    let token = extract_token(url);
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "chosen by user"}),
    )
    .await
    .assert_status(200);
    app.get(&user, "/api/auth/me").await.assert_status(401);
    app.login("a@example.com", "chosen by user")
        .await
        .0
        .assert_status(200);

    // Non-admins can't mint links; unknown users are 404.
    let other = app.user("b@example.com", "B");
    app.post(
        &other,
        &format!("/api/admin/users/{uid}/reset-link"),
        json!({}),
    )
    .await
    .assert_status(403);
    app.post(&admin, "/api/admin/users/usrNope/reset-link", json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn credentials_and_sessions_reject_api_tokens() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let res = app
        .post(&user, "/api/tokens", json!({"name": "ci", "write": true}))
        .await;
    res.assert_status(201);
    let token_client = Client {
        bearer: Some(res.body["token"].as_str().unwrap().to_string()),
        ..Default::default()
    };
    // Reading the profile is harmless; sessions are credentials.
    let me = app.get(&token_client, "/api/auth/me").await;
    me.assert_status(200);
    assert_eq!(me.body["email"], "a@example.com");
    let res = app.get(&token_client, "/api/auth/sessions").await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("API tokens")
    );
    for (path, body) in [
        (
            "/api/auth/password",
            json!({"current_password": PW, "new_password": "brand new password"}),
        ),
        ("/api/auth/2fa/setup", json!({})),
        ("/api/auth/sessions/revoke-others", json!({})),
    ] {
        app.post(&token_client, path, body).await.assert_status(403);
    }
    // Changing the profile needs the manage permission, which this token lacks.
    app.patch(&token_client, "/api/auth/me", json!({"name": "Hacked"}))
        .await
        .assert_status(403);
}
