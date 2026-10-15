//! Invites (always to a workspace, for all its bases or a picked list, made
//! by owners or, from a base, by its creators): create, list, revoke,
//! preview, accept, and signing up with an invite.

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
    assert_eq!(info["all_bases"], true);
    assert_eq!(info["base_ids"], json!([]));
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
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
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
    // A base invite is a workspace invite limited to that base.
    let res = app.post(&creator, &path, json!({"role": "creator"})).await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["workspace_id"], ws.as_str());
    assert!(res.body["info"]["base_id"].is_null());
    assert_eq!(res.body["info"]["all_bases"], false);
    assert_eq!(res.body["info"]["base_ids"], json!([base]));
    // The workspace owner can invite an owner from a base: owners get every base.
    let res = app.post(&owner, &path, json!({"role": "owner"})).await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["all_bases"], true);
    assert_eq!(
        app.get(&creator, &path)
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Both show in the workspace's own listing.
    assert_eq!(
        app.get(&owner, &format!("/api/workspaces/{ws}/invites"))
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn creator_base_invites_cannot_reach_beyond_their_bases() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let mine = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/bases"),
            json!({"name": "Mine too"}),
        )
        .await
        .body["id"]
        .as_str()
        .unwrap()
        .to_string();
    let hidden = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/bases"),
            json!({"name": "Hidden"}),
        )
        .await
        .body["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, foreign) = app.workspace_with_base(&owner, "Elsewhere");
    let creator = app.user("creator@example.com", "C");
    app.grant_base_role(&creator, &base, "creator");
    app.grant_base_role(&creator, &mine, "creator");
    let path = format!("/api/bases/{base}/invites");

    // A base they cannot open: 404, as for any base they cannot see.
    app.post(
        &creator,
        &path,
        json!({"role": "viewer", "base_ids": [base, hidden]}),
    )
    .await
    .assert_status(404);
    // A base of another workspace.
    app.post(
        &creator,
        &path,
        json!({"role": "viewer", "base_ids": [foreign]}),
    )
    .await
    .assert_status(400);
    // Every base: only owners.
    let res = app
        .post(
            &creator,
            &path,
            json!({"role": "viewer", "all_bases": true}),
        )
        .await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("owners")
    );
    // Above their role.
    app.post(
        &creator,
        &path,
        json!({"role": "owner", "base_ids": [base]}),
    )
    .await
    .assert_status(403);
    // Bases they can open are fine.
    let res = app
        .post(
            &creator,
            &path,
            json!({"role": "editor", "base_ids": [base, mine]}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["base_ids"], json!([base, mine]));
    // The invite shows on both bases' listings, not on the hidden one.
    for (b, n) in [(&base, 1), (&mine, 1)] {
        let list = app.get(&creator, &format!("/api/bases/{b}/invites")).await;
        list.assert_status(200);
        assert_eq!(list.body.as_array().unwrap().len(), n, "{b}");
    }
    let list = app
        .get(&owner, &format!("/api/bases/{hidden}/invites"))
        .await;
    assert_eq!(list.body, json!([]));
    // Workspace owners pick bases on the workspace endpoint, but only that workspace's.
    let wpath = format!("/api/workspaces/{ws}/invites");
    let res = app
        .post(
            &owner,
            &wpath,
            json!({"role": "editor", "base_ids": [hidden]}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["all_bases"], false);
    assert_eq!(res.body["info"]["base_ids"], json!([hidden]));
    app.post(
        &owner,
        &wpath,
        json!({"role": "editor", "base_ids": [foreign]}),
    )
    .await
    .assert_status(400);
    app.post(
        &owner,
        &wpath,
        json!({"role": "editor", "all_bases": false}),
    )
    .await
    .assert_status(400);
    // An owner invite always gives every base.
    let res = app
        .post(
            &owner,
            &wpath,
            json!({"role": "owner", "base_ids": [hidden]}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["info"]["all_bases"], true);
}

#[tokio::test]
async fn accepting_an_invite_merges_base_access() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let second = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/bases"),
            json!({"name": "Second"}),
        )
        .await
        .body["id"]
        .as_str()
        .unwrap()
        .to_string();
    let member = app.user("m@example.com", "M");
    app.grant_base_role(&member, &base, "editor");
    let accept = |token: String| {
        let (app, member) = (&app, &member);
        async move {
            app.post(
                member,
                &format!("/api/invites/by-token/{token}/accept"),
                json!({}),
            )
            .await
            .assert_status(200);
        }
    };
    let invite = |body: serde_json::Value| {
        let (app, owner, ws) = (&app, &owner, ws.clone());
        async move {
            let res = app
                .post(owner, &format!("/api/workspaces/{ws}/invites"), body)
                .await;
            res.assert_status(201);
            token_of(res.body["url"].as_str().unwrap())
        }
    };
    let members = || async {
        app.get(&owner, &format!("/api/workspaces/{ws}/members"))
            .await
            .body
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["email"] == "m@example.com")
            .cloned()
            .unwrap()
    };
    // A lower role for another base: the role stays, the bases add up.
    accept(invite(json!({"role": "viewer", "base_ids": [second]})).await).await;
    let m = members().await;
    assert_eq!(m["role"], "editor");
    assert_eq!(m["all_bases"], false);
    assert_eq!(m["base_ids"], json!([base, second]));
    // An all-bases invite at a higher role: both win.
    accept(invite(json!({"role": "creator"})).await).await;
    let m = members().await;
    assert_eq!(m["role"], "creator");
    assert_eq!(m["all_bases"], true);
    // A later limited invite does not narrow them.
    accept(invite(json!({"role": "viewer", "base_ids": [base]})).await).await;
    let m = members().await;
    assert_eq!(
        (m["role"].as_str(), &m["all_bases"]),
        (Some("creator"), &json!(true))
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
    // A base invite joins the workspace, so the workspace is what is shown.
    assert_eq!(
        res.body,
        json!({
            "target_name": "Acme",
            "target_icon": null,
            "target_color": "blue",
            "target_kind": "workspace",
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
            Ok(tx.execute("UPDATE invites SET expires_at = 0 WHERE all_bases = 0", [])?)
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
        .read(move |c| openbase::perm::workspace_role(c, &uid, &ws2))
        .await
        .unwrap();
    assert_eq!(role, Some(openbase::perm::Role::Creator));
    // Single use.
    let other = app.user("o2@example.com", "O2");
    app.post(
        &other,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(404);

    // A base invite makes them a member limited to that base.
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
        .read(move |c| openbase::perm::base_role(c, &uid, &base))
        .await
        .unwrap();
    assert_eq!(role, Some(openbase::perm::Role::Editor));
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
        .read(move |c| openbase::perm::workspace_role(c, &uid, &ws))
        .await
        .unwrap();
    assert_eq!(role, Some(openbase::perm::Role::Editor));
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
        c.public_url = "https://base.example.com/".into();
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
    assert!(url.starts_with("https://base.example.com/invite/inv_"));
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

#[tokio::test]
async fn only_owners_revoke_an_invite_whose_bases_are_all_in_the_trash() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    res.assert_status(201);
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    app.delete(&owner, &format!("/api/bases/{base}"))
        .await
        .assert_status(200);
    for role in ["viewer", "creator"] {
        let member = app.user(&format!("{role}@example.com"), role);
        app.grant_workspace_role(&member, &ws, role);
        let res = app.delete(&member, &format!("/api/invites/{id}")).await;
        res.assert_status(403);
    }
    app.delete(&owner, &format!("/api/invites/{id}"))
        .await
        .assert_status(204);
}

/// Workspace "Acme" with bases `base`, `mine` and `hidden`; a creator limited
/// to `base` and `mine`.
async fn invite_fixture(app: &TestApp) -> (common::Client, common::Client, String, [String; 3]) {
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let mut more = Vec::new();
    for name in ["Mine", "Hidden"] {
        let res = app
            .post(
                &owner,
                &format!("/api/workspaces/{ws}/bases"),
                json!({ "name": name }),
            )
            .await;
        res.assert_status(201);
        more.push(res.body["id"].as_str().unwrap().to_string());
    }
    let [mine, hidden] = <[String; 2]>::try_from(more).unwrap();
    let creator = app.user("creator@example.com", "C");
    app.grant_base_role(&creator, &base, "creator");
    app.grant_base_role(&creator, &mine, "creator");
    (owner, creator, ws, [base, mine, hidden])
}

#[tokio::test]
async fn owners_change_an_invite_in_place_and_the_link_keeps_working() {
    let app = TestApp::new();
    let (owner, _, ws, [base, mine, _]) = invite_fixture(&app).await;
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer", "email": "new@example.com"}),
        )
        .await;
    res.assert_status(201);
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    let token = token_of(res.body["url"].as_str().unwrap());
    let expires = res.body["info"]["expires_at"].clone();

    let path = format!("/api/invites/{id}");
    let res = app
        .patch(&owner, &path, json!({"role": "editor", "base_ids": [mine]}))
        .await;
    res.assert_status(200);
    assert_eq!(res.body["id"], id.as_str());
    assert_eq!(res.body["role"], "editor");
    assert_eq!(res.body["all_bases"], false);
    assert_eq!(res.body["base_ids"], json!([mine]));
    assert_eq!(res.body["email"], "new@example.com");
    assert_eq!(res.body["expires_at"], expires);
    // Only the role: the bases stay.
    let res = app.patch(&owner, &path, json!({"role": "commenter"})).await;
    res.assert_status(200);
    assert_eq!(res.body["base_ids"], json!([mine]));
    // The owner role always gives every base.
    let res = app.patch(&owner, &path, json!({"role": "owner"})).await;
    res.assert_status(200);
    assert_eq!(res.body["all_bases"], true);
    app.patch(&owner, &path, json!({"role": "editor", "all_bases": false}))
        .await
        .assert_status(400);
    app.patch(&owner, &path, json!({"role": "boss"}))
        .await
        .assert_status(400);
    app.patch(&owner, &path, json!({"role": "editor", "base_ids": [base]}))
        .await
        .assert_status(200);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'invite_update' AND target = ?1",
            &[&id],
        ),
        4
    );

    // The same link, with the latest terms.
    let new = app.user("new@example.com", "New");
    app.post(
        &new,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
    let list = app.get(&new, "/api/workspaces").await;
    let bases: Vec<&str> = list.body[0]["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert_eq!(bases, [base.as_str()]);
    assert_eq!(list.body[0]["role"], "editor");
    // Used up: nothing left to change.
    app.patch(&owner, &path, json!({"role": "viewer"}))
        .await
        .assert_status(409);
}

#[tokio::test]
async fn creators_change_invites_only_within_what_they_could_create() {
    let app = TestApp::new();
    let (owner, creator, ws, [base, mine, hidden]) = invite_fixture(&app).await;
    let res = app
        .post(
            &creator,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    res.assert_status(201);
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());

    let res = app
        .patch(
            &creator,
            &path,
            json!({"role": "creator", "base_ids": [base, mine]}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["base_ids"], json!([base, mine]));
    // A base they cannot open, every base, or a role above their own.
    app.patch(&creator, &path, json!({"base_ids": [hidden]}))
        .await
        .assert_status(404);
    let res = app.patch(&creator, &path, json!({"all_bases": true})).await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("owners")
    );
    app.patch(&creator, &path, json!({"role": "owner"}))
        .await
        .assert_status(403);
    // Editors manage no invites.
    let editor = app.user("editor@example.com", "E");
    app.grant_workspace_role(&editor, &ws, "editor");
    app.patch(&editor, &path, json!({"role": "viewer"}))
        .await
        .assert_status(403);
    // An owner's invite to every base is beyond a creator, even to narrow it.
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let all = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    app.patch(&creator, &all, json!({"base_ids": [base]}))
        .await
        .assert_status(403);
}

#[tokio::test]
async fn an_owners_invite_changed_by_a_creator_no_longer_raises_existing_members() {
    let app = TestApp::new();
    let (owner, creator, ws, [base, mine, _]) = invite_fixture(&app).await;
    let member = app.user("member@example.com", "M");
    app.grant_base_role(&member, &mine, "viewer");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer", "base_ids": [base]}),
        )
        .await;
    res.assert_status(201);
    let token = token_of(res.body["url"].as_str().unwrap());
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    // From the owner, accepting this would make the member a creator on every
    // base they have; with the terms set by a creator it only adds `base`.
    app.patch(&creator, &path, json!({"role": "creator"}))
        .await
        .assert_status(200);
    app.post(
        &member,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
    let list = app.get(&member, "/api/workspaces").await;
    assert_eq!(list.body[0]["role"], "viewer");
    assert_eq!(list.body[0]["bases"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn changing_only_the_role_keeps_a_trashed_base_on_the_invite() {
    let app = TestApp::new();
    let (owner, _, ws, [base, mine, _]) = invite_fixture(&app).await;
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer", "base_ids": [base, mine]}),
        )
        .await;
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    app.delete(&owner, &format!("/api/bases/{mine}"))
        .await
        .assert_status(200);
    let token = token_of(res.body["url"].as_str().unwrap());
    let res = app.patch(&owner, &path, json!({"role": "editor"})).await;
    res.assert_status(200);
    assert_eq!(res.body["base_ids"], json!([base, mine]));
    // Restoring the base restores what the invite gives.
    app.post(
        &owner,
        "/api/trash/restore",
        json!({"kind": "base", "id": mine}),
    )
    .await
    .assert_status(200);
    let new = app.user("new@example.com", "New");
    app.post(
        &new,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
    assert_eq!(bases_of(&app, &new).await, [base, mine]);
    let list = app.get(&new, "/api/workspaces").await;
    assert_eq!(list.body[0]["role"], "editor");
}

/// Ids of the bases `user` can open in their first workspace.
async fn bases_of(app: &TestApp, user: &common::Client) -> Vec<String> {
    let list = app.get(user, "/api/workspaces").await;
    list.assert_status(200);
    list.body[0]["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap().to_string())
        .collect()
}

async fn workspace_role_of(app: &TestApp, user: &common::Client) -> String {
    let list = app.get(user, "/api/workspaces").await;
    list.assert_status(200);
    list.body[0]["role"].as_str().unwrap().to_string()
}

fn ids(list: &common::Response) -> Vec<String> {
    list.assert_status(200);
    list.body
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_creator_changing_the_role_drops_trashed_bases_they_cannot_open() {
    let app = TestApp::new();
    let (owner, creator, ws, [base, mine, hidden]) = invite_fixture(&app).await;
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "viewer", "base_ids": [base, mine, hidden]}),
        )
        .await;
    res.assert_status(201);
    let token = token_of(res.body["url"].as_str().unwrap());
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    for b in [&mine, &hidden] {
        app.delete(&owner, &format!("/api/bases/{b}"))
            .await
            .assert_status(200);
    }
    // The creator now stands behind the invite: a trashed base they cannot
    // open would void all of it once restored, so it goes; one they can open
    // stays.
    let res = app.patch(&creator, &path, json!({"role": "editor"})).await;
    res.assert_status(200);
    assert_eq!(res.body["base_ids"], json!([base, mine]));
    for b in [&mine, &hidden] {
        app.post(
            &owner,
            "/api/trash/restore",
            json!({"kind": "base", "id": b}),
        )
        .await
        .assert_status(200);
    }
    let new = app.user("new@example.com", "New");
    app.post(
        &new,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
    assert_eq!(bases_of(&app, &new).await, [base, mine]);
}

#[tokio::test]
async fn a_removed_members_invite_is_not_listed_and_cannot_be_revived_by_editing() {
    let app = TestApp::new();
    let (owner, creator, ws, [base, _, _]) = invite_fixture(&app).await;
    let res = app
        .post(
            &creator,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    res.assert_status(201);
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    let token = token_of(res.body["url"].as_str().unwrap());
    let ws_list = format!("/api/workspaces/{ws}/invites");
    let base_list = format!("/api/bases/{base}/invites");
    assert_eq!(ids(&app.get(&owner, &ws_list).await), [id.as_str()]);
    app.delete(
        &owner,
        &format!(
            "/api/workspaces/{ws}/members/{}",
            creator.user_id.as_deref().unwrap()
        ),
    )
    .await
    .assert_status(200);

    // Void: not offered as pending anywhere, and the link is dead.
    assert!(ids(&app.get(&owner, &ws_list).await).is_empty());
    assert!(ids(&app.get(&owner, &base_list).await).is_empty());
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
    // Editing it would make the owner its inviter and bring back the link the
    // removed member kept.
    let res = app
        .patch(
            &owner,
            &format!("/api/invites/{id}"),
            json!({"role": "editor"}),
        )
        .await;
    res.assert_status(409);
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
    // It can still be cancelled.
    app.delete(&owner, &format!("/api/invites/{id}"))
        .await
        .assert_status(204);
}

#[tokio::test]
async fn a_base_limited_owner_token_cannot_make_an_invite_that_raises_existing_members() {
    let app = TestApp::new();
    let (owner, _, ws, [base, mine, _]) = invite_fixture(&app).await;
    // Viewers of every base, who would become creators everywhere.
    let members: Vec<_> = (0..3)
        .map(|i| {
            let m = app.user(&format!("m{i}@example.com"), "M");
            app.grant_workspace_role(&m, &ws, "viewer");
            m
        })
        .collect();
    let limited = app
        .api_token(
            &owner,
            json!({"name": "lim", "write": true, "manage": true, "base_ids": [base]}),
        )
        .await;
    let accept = async |token: &str, who: &common::Client| {
        app.post(
            who,
            &format!("/api/invites/by-token/{token}/accept"),
            json!({}),
        )
        .await
        .assert_status(200);
    };

    // Created through the token.
    let res = app
        .post(
            &limited,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "creator"}),
        )
        .await;
    res.assert_status(201);
    accept(&token_of(res.body["url"].as_str().unwrap()), &members[0]).await;
    assert_eq!(workspace_role_of(&app, &members[0]).await, "viewer");

    // An owner's invite whose role the token changes.
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    res.assert_status(201);
    let token = token_of(res.body["url"].as_str().unwrap());
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    app.patch(&limited, &path, json!({"role": "creator"}))
        .await
        .assert_status(200);
    accept(&token, &members[1]).await;
    assert_eq!(workspace_role_of(&app, &members[1]).await, "viewer");

    // The same invite from the owner's own session does raise.
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "creator"}),
        )
        .await;
    res.assert_status(201);
    accept(&token_of(res.body["url"].as_str().unwrap()), &members[2]).await;
    assert_eq!(workspace_role_of(&app, &members[2]).await, "creator");

    // The token stays inside its base when changing an invite.
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let path = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    app.patch(&limited, &path, json!({"base_ids": [base, mine]}))
        .await
        .assert_status(404);
    for body in [json!({"role": "owner"}), json!({"all_bases": true})] {
        app.patch(&limited, &path, body).await.assert_status(403);
    }
    let res = app
        .post(
            &owner,
            &format!("/api/bases/{mine}/invites"),
            json!({"role": "viewer"}),
        )
        .await;
    let elsewhere = format!("/api/invites/{}", res.body["info"]["id"].as_str().unwrap());
    app.patch(&limited, &elsewhere, json!({"role": "editor"}))
        .await
        .assert_status(404);
    // Tokens without the manage permission, or read-only ones, change nothing.
    let no_manage = app
        .api_token(&owner, json!({"name": "w", "write": true}))
        .await;
    let read_only = app
        .api_token(&owner, json!({"name": "r", "write": false}))
        .await;
    for t in [&no_manage, &read_only] {
        app.patch(t, &path, json!({"role": "editor"}))
            .await
            .assert_status(403);
    }
    let res = app
        .get(&owner, &format!("/api/workspaces/{ws}/invites"))
        .await;
    let unchanged = res
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|i| format!("/api/invites/{}", i["id"].as_str().unwrap()) == path)
        .unwrap();
    assert_eq!(unchanged["role"], "viewer");
    assert_eq!(unchanged["base_ids"], json!([base]));
}
