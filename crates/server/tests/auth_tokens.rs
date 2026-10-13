//! Personal access tokens: CRUD, scopes, expiry, and what tokens may not do.

mod common;

use common::{Client, TestApp};
use opengrid::perm::{self, Role};
use serde_json::json;

fn bearer(token: &str) -> Client {
    Client {
        bearer: Some(token.to_string()),
        ..Default::default()
    }
}

async fn create_token(
    app: &TestApp,
    user: &Client,
    body: serde_json::Value,
) -> (String, serde_json::Value) {
    let res = app.post(user, "/api/tokens", body).await;
    res.assert_status(201);
    (
        res.body["token"].as_str().unwrap().to_string(),
        res.body["info"].clone(),
    )
}

#[tokio::test]
async fn create_list_delete_tokens() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (token, info) = create_token(&app, &user, json!({"name": " CI ", "write": true})).await;
    assert!(token.starts_with("pat") && token.len() == 46);
    assert_eq!(info["name"], "CI");
    assert_eq!(info["write"], true);
    assert_eq!(info["base_ids"], serde_json::Value::Null);
    assert_eq!(info["expires_at"], serde_json::Value::Null);
    let id = info["id"].as_str().unwrap().to_string();
    // Only the hash is stored.
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM api_tokens WHERE token_hash = ?1",
            &[&opengrid::ids::hash_token(&token)]
        ),
        1
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM api_tokens WHERE instr(token_hash || scopes || name, ?1) > 0",
            &[&token]
        ),
        0
    );

    let list = app.get(&user, "/api/tokens").await;
    list.assert_status(200);
    let arr = list.body.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], id.as_str());
    assert!(
        arr[0].get("token").is_none(),
        "the raw token is never listed"
    );

    // Other users neither see nor delete it.
    let other = app.user("b@example.com", "B");
    assert!(
        app.get(&other, "/api/tokens")
            .await
            .body
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.delete(&other, &format!("/api/tokens/{id}"))
        .await
        .assert_status(404);

    app.delete(&user, &format!("/api/tokens/{id}"))
        .await
        .assert_status(204);
    app.delete(&user, &format!("/api/tokens/{id}"))
        .await
        .assert_status(404);
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action IN ('token_create', 'token_delete')",
            &[]
        ),
        2
    );
}

#[tokio::test]
async fn token_validation_errors() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    for body in [
        json!({"name": "", "write": false}),
        json!({"name": "x", "write": false, "expires_in_days": 0}),
        json!({"name": "x", "write": false, "expires_in_days": 100000}),
        json!({"name": "x", "write": false, "base_ids": []}),
        json!({"name": "x", "write": false, "base_ids": ["appNotMine"]}),
    ] {
        app.post(&user, "/api/tokens", body.clone())
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn tokens_authenticate_via_whoami_with_their_scope() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "Ann");
    let (_ws, base) = app.workspace_with_base(&user, "Acme");
    let (token, _) = create_token(
        &app,
        &user,
        json!({"name": "ro", "write": false, "base_ids": [base], "expires_in_days": 30}),
    )
    .await;
    let res = app.get(&bearer(&token), "/api/tokens/whoami").await;
    res.assert_status(200);
    assert_eq!(res.body["user_id"], user.user_id.clone().unwrap().as_str());
    assert_eq!(res.body["name"], "Ann");
    assert_eq!(res.body["via_token"], true);
    assert_eq!(res.body["write"], false);
    assert_eq!(res.body["base_ids"], json!([base]));
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM api_tokens WHERE last_used_at IS NOT NULL",
            &[]
        ),
        1
    );
    // Sessions work too.
    let res = app.get(&user, "/api/tokens/whoami").await;
    assert_eq!(res.body["via_token"], false);
    assert_eq!(res.body["write"], true);
    // Garbage tokens are 401.
    app.get(&bearer("patnope"), "/api/tokens/whoami")
        .await
        .assert_status(401);
}

#[tokio::test]
async fn tokens_cannot_use_session_only_endpoints() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let (ws, base) = app.workspace_with_base(&admin, "Acme");
    let (token, info) = create_token(&app, &admin, json!({"name": "all", "write": true})).await;
    let t = bearer(&token);
    app.get(&t, "/api/auth/me").await.assert_status(403);
    app.get(&t, "/api/tokens").await.assert_status(403);
    app.post(&t, "/api/tokens", json!({"name": "child", "write": true}))
        .await
        .assert_status(403);
    app.delete(&t, &format!("/api/tokens/{}", info["id"].as_str().unwrap()))
        .await
        .assert_status(403);
    // Admin endpoints are session-only even for an admin's token.
    app.get(&t, "/api/admin/users").await.assert_status(403);
    app.get(&t, "/api/admin/stats").await.assert_status(403);
    // Invite management is session-only.
    app.post(
        &t,
        &format!("/api/workspaces/{ws}/invites"),
        json!({"role": "viewer"}),
    )
    .await
    .assert_status(403);
    app.post(
        &t,
        &format!("/api/bases/{base}/invites"),
        json!({"role": "viewer"}),
    )
    .await
    .assert_status(403);
    // A bearer request needs no CSRF header (no ambient credentials).
    let res = app
        .request_with(
            &t,
            "POST",
            "/api/tokens",
            Some(json!({"name": "x", "write": true})),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(403);
    assert_ne!(res.body["error"]["message"], "missing CSRF header");
    assert_eq!(app.query_i64("SELECT count(*) FROM api_tokens", &[]), 1);
}

#[tokio::test]
async fn read_only_and_base_limited_scopes_are_enforced_by_perm() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (_ws, base) = app.workspace_with_base(&user, "Acme");
    let (_ws2, other_base) = app.workspace_with_base(&user, "Other");
    let (ro, _) = create_token(&app, &user, json!({"name": "ro", "write": false})).await;
    let (limited, _) = create_token(
        &app,
        &user,
        json!({"name": "lim", "write": true, "base_ids": [base]}),
    )
    .await;
    let (b1, b2) = (base.clone(), other_base.clone());
    app.state
        .db
        .read(move |c| {
            let ro = opengrid::auth::actor_from_api_token(c, &ro)?.unwrap();
            assert_eq!(perm::require_base(c, &ro, &b1, Role::Viewer)?, Role::Viewer);
            assert!(perm::require_base(c, &ro, &b1, Role::Editor).is_err());
            let lim = opengrid::auth::actor_from_api_token(c, &limited)?.unwrap();
            assert_eq!(perm::require_base(c, &lim, &b1, Role::Editor)?, Role::Owner);
            assert!(matches!(
                perm::require_base(c, &lim, &b2, Role::Viewer),
                Err(opengrid::error::AppError::NotFound(_))
            ));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn expired_tokens_are_rejected() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (token, _) = create_token(
        &app,
        &user,
        json!({"name": "x", "write": true, "expires_in_days": 1}),
    )
    .await;
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(200);
    app.state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE api_tokens SET expires_at = 1", [])?))
        .unwrap();
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
}

#[tokio::test]
async fn deactivated_user_is_locked_out_immediately() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("a@example.com", "A");
    let (_, second_session) = app.login("a@example.com", "password1234").await;
    let (token, _) = create_token(&app, &user, json!({"name": "x", "write": true})).await;
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(200);

    app.patch(
        &admin,
        &format!("/api/admin/users/{}", user.user_id.as_ref().unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    app.get(&user, "/api/auth/me").await.assert_status(401);
    app.get(&second_session, "/api/auth/me")
        .await
        .assert_status(401);
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM sessions WHERE user_id = ?1",
            &[user.user_id.as_ref().unwrap()]
        ),
        0
    );
    // Reactivation restores token access (sessions stay revoked).
    app.patch(
        &admin,
        &format!("/api/admin/users/{}", user.user_id.as_ref().unwrap()),
        json!({"is_active": true}),
    )
    .await
    .assert_status(200);
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(200);
    app.get(&user, "/api/auth/me").await.assert_status(401);
}

#[tokio::test]
async fn last_used_at_is_stamped_at_most_once_a_minute() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "Ann");
    let (token, _) = create_token(&app, &user, json!({"name": "ci", "write": true})).await;
    let stamp = || app.query_i64("SELECT last_used_at FROM api_tokens", &[]);
    let set = |ms_ago: i64| {
        app.state
            .db
            .write_sync(move |tx| {
                tx.execute(
                    "UPDATE api_tokens SET last_used_at = ?1",
                    [opengrid::db::now_ms() - ms_ago],
                )?;
                Ok(())
            })
            .unwrap();
    };
    let t = bearer(&token);

    // The first use stamps the token.
    app.get(&t, "/api/tokens/whoami").await.assert_status(200);
    assert!(stamp() > 0);

    // A use within the minute leaves the stamp alone (no write on the single writer).
    set(10_000);
    let before = stamp();
    app.get(&t, "/api/tokens/whoami").await.assert_status(200);
    assert_eq!(
        stamp(),
        before,
        "a use 10 seconds after the last stamp wrote again"
    );

    // A use after the minute refreshes it.
    set(120_000);
    let stale = stamp();
    app.get(&t, "/api/tokens/whoami").await.assert_status(200);
    assert!(stamp() > stale + 100_000, "a stale stamp was not refreshed");
}
