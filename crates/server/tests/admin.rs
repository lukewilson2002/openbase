//! Admin API: users, audit log, stats, and access control.

mod common;

use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn admin_endpoints_reject_non_admins_and_anonymous() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("u@example.com", "U");
    let aid = admin.user_id.clone().unwrap();
    for (method, path, body) in [
        ("GET", "/api/admin/users".to_string(), None),
        (
            "POST",
            "/api/admin/users".to_string(),
            Some(json!({"email": "x@example.com", "name": "X"})),
        ),
        (
            "PATCH",
            format!("/api/admin/users/{aid}"),
            Some(json!({"is_admin": false})),
        ),
        (
            "POST",
            format!("/api/admin/users/{aid}/reset-link"),
            Some(json!({})),
        ),
        ("GET", "/api/admin/audit".to_string(), None),
        ("GET", "/api/admin/stats".to_string(), None),
    ] {
        let res = app.request(&user, method, &path, body.clone()).await;
        assert_eq!(res.status.as_u16(), 403, "{method} {path}");
        let res = app.request(&app.anon(), method, &path, body).await;
        assert_eq!(res.status.as_u16(), 401, "{method} {path} anon");
    }
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 2);
}

#[tokio::test]
async fn list_users() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.user("u@example.com", "U");
    let res = app.get(&admin, "/api/admin/users").await;
    res.assert_status(200);
    let users = res.body.as_array().unwrap();
    assert_eq!(users.len(), 2);
    // Ordered by creation time, then id: users created in the same millisecond tie.
    let by_email = |e: &str| users.iter().find(|u| u["email"] == e).unwrap();
    assert_eq!(by_email("admin@example.com")["is_admin"], true);
    assert_eq!(by_email("u@example.com")["is_active"], true);
    assert!(by_email("u@example.com").get("password_hash").is_none());
}

#[tokio::test]
async fn create_user_with_password() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let res = app
        .post(
            &admin,
            "/api/admin/users",
            json!({"email": "new@example.com", "name": "New", "password": "a fine password", "is_admin": true}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["user"]["email"], "new@example.com");
    assert_eq!(res.body["user"]["is_admin"], true);
    assert_eq!(res.body["reset_link"], serde_json::Value::Null);
    app.login("new@example.com", "a fine password")
        .await
        .0
        .assert_status(200);
    // Duplicate and invalid input.
    app.post(
        &admin,
        "/api/admin/users",
        json!({"email": "NEW@example.com", "name": "Dup", "password": "a fine password"}),
    )
    .await
    .assert_status(409);
    app.post(
        &admin,
        "/api/admin/users",
        json!({"email": "x@example.com", "name": "X", "password": "short"}),
    )
    .await
    .assert_status(400);
    app.post(
        &admin,
        "/api/admin/users",
        json!({"email": "bad", "name": "X"}),
    )
    .await
    .assert_status(400);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'admin_user_create'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn create_user_without_password_returns_reset_link() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let res = app
        .post(
            &admin,
            "/api/admin/users",
            json!({"email": "new@example.com", "name": "New"}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["user"]["is_admin"], false);
    let url = res.body["reset_link"]["url"].as_str().unwrap();
    let token = url.split("token=").nth(1).unwrap();
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "my own password"}),
    )
    .await
    .assert_status(200);
    app.login("new@example.com", "my own password")
        .await
        .0
        .assert_status(200);
}

#[tokio::test]
async fn update_user_name_admin_and_active() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("u@example.com", "U");
    let uid = user.user_id.clone().unwrap();
    let path = format!("/api/admin/users/{uid}");

    let res = app
        .patch(&admin, &path, json!({"name": "Renamed", "is_admin": true}))
        .await;
    res.assert_status(200);
    assert_eq!(res.body["name"], "Renamed");
    assert_eq!(res.body["is_admin"], true);
    // The promoted user can now use admin endpoints.
    app.get(&user, "/api/admin/users").await.assert_status(200);

    let res = app
        .patch(
            &admin,
            &path,
            json!({"is_admin": false, "is_active": false}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["is_active"], false);
    app.get(&user, "/api/admin/users").await.assert_status(401);

    app.patch(&admin, &path, json!({"name": ""}))
        .await
        .assert_status(400);
    app.patch(&admin, "/api/admin/users/usrNope", json!({"name": "X"}))
        .await
        .assert_status(404);

    let audit = app.get(&admin, "/api/admin/audit").await;
    let updates: Vec<_> = audit.body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["action"] == "admin_user_update")
        .collect();
    assert_eq!(updates.len(), 2);
    assert_eq!(
        updates[0]["detail"],
        json!({"is_admin": false, "is_active": false})
    );
    assert_eq!(updates[0]["target"], uid.as_str());
    assert_eq!(updates[0]["user_email"], "admin@example.com");
}

#[tokio::test]
async fn admins_cannot_deactivate_or_demote_themselves() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let path = format!("/api/admin/users/{}", admin.user_id.clone().unwrap());
    let res = app.patch(&admin, &path, json!({"is_active": false})).await;
    res.assert_status(400);
    let res = app.patch(&admin, &path, json!({"is_admin": false})).await;
    res.assert_status(400);
    // Even with another admin around.
    app.admin("admin2@example.com", "Admin 2");
    app.patch(&admin, &path, json!({"is_admin": false}))
        .await
        .assert_status(400);
    // Harmless self-edits are fine.
    app.patch(&admin, &path, json!({"name": "Boss", "is_active": true}))
        .await
        .assert_status(200);
    app.get(&admin, "/api/auth/me").await.assert_status(200);
}

#[tokio::test]
async fn admin_can_demote_another_admin_but_last_admin_is_protected() {
    let app = TestApp::new();
    let a = app.admin("a@example.com", "A");
    let b = app.admin("b@example.com", "B");
    let a_path = format!("/api/admin/users/{}", a.user_id.clone().unwrap());
    // B demotes A (allowed: B remains).
    app.patch(&b, &a_path, json!({"is_admin": false}))
        .await
        .assert_status(200);
    // Now B is the last active admin; the store rule refuses any path that
    // would remove it (exercised directly because the API's self-protection
    // already stops B from demoting B).
    let b_id = b.user_id.clone().unwrap();
    let a_id = a.user_id.clone().unwrap();
    let err = app
        .state
        .db
        .write_sync(|tx| {
            opengrid::store::users::admin_update(
                tx,
                &a_id,
                &b_id,
                &og_core::api::auth::AdminUpdateUser {
                    is_active: Some(false),
                    ..Default::default()
                },
            )
        })
        .unwrap_err();
    assert!(
        matches!(err, opengrid::error::AppError::Conflict(_)),
        "{err:?}"
    );
}

#[tokio::test]
async fn deactivating_revokes_sessions_immediately() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let user = app.user("u@example.com", "U");
    let uid = user.user_id.clone().unwrap();
    app.patch(
        &admin,
        &format!("/api/admin/users/{uid}"),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    app.get(&user, "/api/auth/me").await.assert_status(401);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM sessions WHERE user_id = ?1", &[&uid]),
        0
    );
    // Reset links can't be minted for deactivated users.
    app.post(
        &admin,
        &format!("/api/admin/users/{uid}/reset-link"),
        json!({}),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn audit_log_pages_newest_first() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.user("u@example.com", "U");
    for _ in 0..5 {
        app.login("u@example.com", "wrong password")
            .await
            .0
            .assert_status(401);
    }
    let res = app.get(&admin, "/api/admin/audit?limit=2").await;
    res.assert_status(200);
    let entries = res.body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries[0]["id"].as_i64() > entries[1]["id"].as_i64());
    assert_eq!(entries[0]["action"], "login_failed");
    assert_eq!(entries[0]["ip"], "unknown");
    assert_eq!(entries[0]["user_email"], "u@example.com");
    let next = res.body["next_before"].as_i64().unwrap();
    let mut seen = 2;
    let mut before = Some(next);
    while let Some(b) = before {
        let res = app
            .get(&admin, &format!("/api/admin/audit?limit=2&before={b}"))
            .await;
        let page = res.body["entries"].as_array().unwrap();
        assert!(page.iter().all(|e| e["id"].as_i64().unwrap() < b));
        seen += page.len();
        before = res.body["next_before"].as_i64();
    }
    assert_eq!(seen, 5);
    // Default page and oversized limits are clamped, bad params are 400.
    app.get(&admin, "/api/admin/audit?limit=100000")
        .await
        .assert_status(200);
    app.get(&admin, "/api/admin/audit?limit=abc")
        .await
        .assert_status(400);
}

#[tokio::test]
async fn stats_report_counts_and_sizes() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    app.workspace_with_base(&admin, "Acme");
    let dir = app.state.config.attachments_dir();
    std::fs::create_dir_all(dir.join("ab")).unwrap();
    std::fs::write(dir.join("ab").join("abc"), vec![0u8; 1000]).unwrap();
    let res = app.get(&admin, "/api/admin/stats").await;
    res.assert_status(200);
    assert_eq!(res.body["users"], 1);
    assert_eq!(res.body["workspaces"], 1);
    assert_eq!(res.body["bases"], 1);
    assert_eq!(res.body["records"], 0);
    assert!(res.body["database_bytes"].as_i64().unwrap() > 0);
    assert_eq!(res.body["attachments_bytes"], 1000);
    assert_eq!(res.body["last_backup_at"], serde_json::Value::Null);
    assert_eq!(res.body["version"], env!("CARGO_PKG_VERSION"));

    std::fs::write(app.state.config.backups_dir().join("b.tar.gz"), b"x").unwrap();
    let res = app.get(&admin, "/api/admin/stats").await;
    let at = res.body["last_backup_at"].as_i64().unwrap();
    assert!((opengrid::db::now_ms() - at).abs() < 60_000);
}
