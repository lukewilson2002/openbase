//! Workspace and base invites: create, list, revoke, preview, accept, and
//! signing up with an invite.

mod common;

use common::TestApp;
use serde_json::json;

const PW: &str = "correct horse battery";

fn token_of(url: &str) -> String {
    url.rsplit('/').next().unwrap().to_string()
}

#[tokio::test]
async fn workspace_owner_creates_and_lists_invites() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "Olivia");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "editor", "email": " New@Example.com "}),
        )
        .await;
    res.assert_status(201);
    let url = res.body["url"].as_str().unwrap();
    assert!(url.starts_with("http://localhost:8080/invite/inv_"));
    let info = &res.body["info"];
    assert_eq!(info["workspace_id"], ws.as_str());
    assert_eq!(info["base_id"], serde_json::Value::Null);
    assert_eq!(info["email"], "New@Example.com");
    assert_eq!(info["role"], "editor");
    let ttl = info["expires_at"].as_i64().unwrap() - info["created_at"].as_i64().unwrap();
    assert_eq!(ttl, 7 * 24 * 3600 * 1000);

    let list = app
        .get(&owner, &format!("/api/workspaces/{ws}/invites"))
        .await;
    list.assert_status(200);
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert_eq!(list.body[0]["id"], info["id"]);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'invite_create'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn workspace_invites_need_owner_role() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let creator = app.user("creator@example.com", "C");
    app.grant_workspace_role(&creator, &ws, "creator");
    let outsider = app.user("x@example.com", "X");
    let path = format!("/api/workspaces/{ws}/invites");
    app.post(&creator, &path, json!({"role": "viewer"}))
        .await
        .assert_status(403);
    app.get(&creator, &path).await.assert_status(403);
    app.post(&outsider, &path, json!({"role": "viewer"}))
        .await
        .assert_status(404);
    app.get(&outsider, &path).await.assert_status(404);
    app.post(
        &owner,
        "/api/workspaces/wspNope/invites",
        json!({"role": "viewer"}),
    )
    .await
    .assert_status(404);
    app.post(&owner, &path, json!({"role": "superuser"}))
        .await
        .assert_status(400);
    app.post(&owner, &path, json!({"role": "viewer", "email": "bad"}))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn base_invites_need_creator_and_cannot_exceed_own_role() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (_ws, base) = app.workspace_with_base(&owner, "Acme");
    let creator = app.user("creator@example.com", "C");
    app.grant_base_role(&creator, &base, "creator");
    let editor = app.user("editor@example.com", "E");
    app.grant_base_role(&editor, &base, "editor");
    let path = format!("/api/bases/{base}/invites");

    app.post(&editor, &path, json!({"role": "viewer"}))
        .await
        .assert_status(403);
    app.get(&editor, &path).await.assert_status(403);
    let res = app.post(&creator, &path, json!({"role": "owner"})).await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("above your own")
    );
    let res = app.post(&creator, &path, json!({"role": "creator"})).await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["base_id"], base.as_str());
    // Workspace owner can grant owner on the base.
    app.post(&owner, &path, json!({"role": "owner"}))
        .await
        .assert_status(201);
    assert_eq!(
        app.get(&creator, &path)
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn preview_is_public_and_hides_invalid_invites() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "Olivia");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "commenter", "email": "z@example.com"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    let res = app
        .get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await;
    res.assert_status(200);
    assert_eq!(
        res.body,
        json!({
            "target_name": "Acme base",
            "target_icon": null,
            "target_kind": "base",
            "role": "commenter",
            "email": "z@example.com",
            "invited_by": "Olivia",
        })
    );
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let ws_token = token_of(res.body["url"].as_str().unwrap());
    let res = app
        .get(&app.anon(), &format!("/api/invites/by-token/{ws_token}"))
        .await;
    assert_eq!(res.body["target_kind"], "workspace");
    assert_eq!(res.body["target_name"], "Acme");

    app.get(&app.anon(), "/api/invites/by-token/inv_bogus")
        .await
        .assert_status(404);
    // Expired.
    app.state
        .db
        .write_sync(|tx| {
            Ok(tx.execute(
                "UPDATE invites SET expires_at = 0 WHERE base_id IS NOT NULL",
                [],
            )?)
        })
        .unwrap();
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn logged_in_user_accepts_invite_and_keeps_higher_role() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let member = app.user("m@example.com", "M");
    app.grant_workspace_role(&member, &ws, "creator");

    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    let res = app
        .post(
            &member,
            &format!("/api/invites/by-token/{token}/accept"),
            json!({}),
        )
        .await;
    res.assert_status(200);
    assert!(res.body["accepted_at"].is_i64());
    // Still creator, not downgraded to viewer.
    let uid = member.user_id.clone().unwrap();
    let ws2 = ws.clone();
    let role = app
        .state
        .db
        .read(move |c| opengrid::perm::workspace_role(c, &uid, &ws2))
        .await
        .unwrap();
    assert_eq!(role, Some(opengrid::perm::Role::Creator));
    // Single use.
    let other = app.user("o2@example.com", "O2");
    app.post(
        &other,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(404);

    // A base invite grants a base role.
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "editor"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    app.post(
        &other,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
    let uid = other.user_id.clone().unwrap();
    let role = app
        .state
        .db
        .read(move |c| opengrid::perm::base_role(c, &uid, &base))
        .await
        .unwrap();
    assert_eq!(role, Some(opengrid::perm::Role::Editor));
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'invite_accept'",
            &[]
        ),
        2
    );
    // Anonymous accept is 401.
    app.post(
        &app.anon(),
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(401);
}

#[tokio::test]
async fn email_restricted_invite_only_accepted_by_that_email() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "editor", "email": "right@example.com"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    let wrong = app.user("wrong@example.com", "W");
    app.post(
        &wrong,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(403);
    let right = app.user("RIGHT@example.com", "R");
    app.post(
        &right,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn signup_with_invite_when_invite_only() {
    let app = TestApp::new();
    let (_, admin) = app.signup("admin@example.com", PW, None).await;
    let (ws, _) = app.workspace_with_base(&admin, "Acme");
    let res = app
        .post(
            &admin,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "editor"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());

    // A bogus token is refused.
    let (res, _) = app.signup("new@example.com", PW, Some("inv_bogus")).await;
    res.assert_status(404);

    let (res, client) = app.signup("new@example.com", PW, Some(&token)).await;
    res.assert_status(200);
    assert_eq!(res.body["is_admin"], false);
    app.get(&client, "/api/auth/me").await.assert_status(200);
    let uid = client.user_id.clone().unwrap();
    let role = app
        .state
        .db
        .read(move |c| opengrid::perm::workspace_role(c, &uid, &ws))
        .await
        .unwrap();
    assert_eq!(role, Some(opengrid::perm::Role::Editor));
    // The invite is used up.
    let (res, _) = app.signup("third@example.com", PW, Some(&token)).await;
    res.assert_status(404);
}

#[tokio::test]
async fn signup_with_restricted_or_expired_invite() {
    let app = TestApp::new();
    let (_, admin) = app.signup("admin@example.com", PW, None).await;
    let (ws, _) = app.workspace_with_base(&admin, "Acme");
    let res = app
        .post(
            &admin,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer", "email": "only@example.com"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    let (res, _) = app.signup("someone@example.com", PW, Some(&token)).await;
    res.assert_status(403);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM users", &[]),
        1,
        "no user created"
    );
    let (res, _) = app.signup("Only@Example.com", PW, Some(&token)).await;
    res.assert_status(200);

    let res = app
        .post(
            &admin,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    app.state
        .db
        .write_sync(|tx| {
            Ok(tx.execute(
                "UPDATE invites SET expires_at = 0 WHERE accepted_at IS NULL",
                [],
            )?)
        })
        .unwrap();
    let (res, _) = app.signup("late@example.com", PW, Some(&token)).await;
    res.assert_status(404);
}

#[tokio::test]
async fn invites_to_deleted_workspaces_are_invalid() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let token = token_of(res.body["url"].as_str().unwrap());
    app.state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE workspaces SET deleted_at = 1", [])?))
        .unwrap();
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
    let u = app.user("u@example.com", "U");
    app.post(
        &u,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(404);
}

#[tokio::test]
async fn revoke_invite() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    let token = token_of(res.body["url"].as_str().unwrap());

    let outsider = app.user("x@example.com", "X");
    app.delete(&outsider, &format!("/api/invites/{id}"))
        .await
        .assert_status(404);
    let creator = app.user("c@example.com", "C");
    app.grant_workspace_role(&creator, &ws, "creator");
    app.delete(&creator, &format!("/api/invites/{id}"))
        .await
        .assert_status(403);

    app.delete(&owner, &format!("/api/invites/{id}"))
        .await
        .assert_status(204);
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
    app.delete(&owner, &format!("/api/invites/{id}"))
        .await
        .assert_status(404);

    // Base creators can revoke base invites.
    app.grant_base_role(&creator, &base, "creator");
    let res = app
        .post(
            &creator,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    app.delete(&creator, &format!("/api/invites/{id}"))
        .await
        .assert_status(204);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'invite_revoke'",
            &[]
        ),
        2
    );

    // ...but not an invite for a role above their own (made by the owner).
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "owner"}),
        )
        .await;
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    app.delete(&creator, &format!("/api/invites/{id}"))
        .await
        .assert_status(403);
    app.delete(&owner, &format!("/api/invites/{id}"))
        .await
        .assert_status(204);
}

#[tokio::test]
async fn invite_email_sent_when_smtp_configured() {
    let app = TestApp::with_config(|c| {
        c.smtp_host = Some("smtp.example.com".into());
        c.public_url = "https://grid.example.com/".into();
    });
    let owner = app.user("owner@example.com", "Olivia");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "editor", "email": "new@example.com"}),
        )
        .await;
    res.assert_status(201);
    let url = res.body["url"].as_str().unwrap();
    assert!(url.starts_with("https://grid.example.com/invite/inv_"));
    let sent = app.mailer.wait_for(1).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "new@example.com");
    assert!(sent[0].subject.contains("Olivia"));
    assert!(sent[0].body.contains(url));
    // No email address: no email.
    app.post(
        &owner,
        &format!("/api/workspaces/{ws}/invites"),
        json!({"role": "editor"}),
    )
    .await
    .assert_status(201);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(app.mailer.sent().len(), 1);
}

#[tokio::test]
async fn invite_email_not_sent_without_smtp() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    app.post(
        &owner,
        &format!("/api/workspaces/{ws}/invites"),
        json!({"role": "editor", "email": "new@example.com"}),
    )
    .await
    .assert_status(201);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(app.mailer.sent().is_empty());
}

#[tokio::test]
async fn invite_preview_rate_limited() {
    let app = TestApp::new();
    for _ in 0..60 {
        app.get(&app.anon(), "/api/invites/by-token/inv_x")
            .await
            .assert_status(404);
    }
    app.get(&app.anon(), "/api/invites/by-token/inv_x")
        .await
        .assert_status(429);
}
