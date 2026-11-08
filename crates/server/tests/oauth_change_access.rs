//! AGT-2: the person grants an app more (or less) access than it asked for. At consent time the
//! choice is explicit and the token response reports what was granted; later, Account -> AI
//! assistants -> Change access moves a connected app up or down with no reconnect. It never
//! reaches past the person's own role, is session-only and CSRF-protected, and is audited.

mod common;
mod mcp_support;
mod oauth_support;

use common::{Client, TestApp};
use mcp_support::{api, legacy, tool};
use oauth_support::*;
use serde_json::{Value, json};

struct World {
    app: TestApp,
    user: Client,
    ws: String,
    base: String,
}

impl World {
    fn new() -> World {
        let app = TestApp::new();
        let user = app.user("alice@example.com", "Alice");
        let (ws, base) = app.workspace_with_base(&user, "Acme");
        World {
            app,
            user,
            ws,
            base,
        }
    }

    /// The grant id of the only connected app of `user`.
    async fn grant_id(&self, user: &Client) -> String {
        let list = self.app.get(user, "/api/oauth/grants").await;
        list.assert_status(200);
        assert_eq!(list.body.as_array().unwrap().len(), 1, "{}", list.body);
        list.body[0]["id"].as_str().unwrap().to_string()
    }

    async fn change(&self, user: &Client, grant: &str, access: &str) -> common::Response {
        self.app
            .patch(
                user,
                &format!("/api/oauth/grants/{grant}"),
                json!({ "access": access }),
            )
            .await
    }

    async fn tools(&self, agent: &Client) -> Vec<String> {
        tool_names(&self.app, agent).await
    }

    fn stored_scope(&self, grant: &str) -> Value {
        let grant = grant.to_string();
        let text: String = self
            .app
            .state
            .db
            .write_sync(move |tx| {
                Ok(tx.query_row(
                    "SELECT scopes FROM oauth_grants WHERE id = ?1",
                    [&grant],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }
}

// ------------------------------------------------------------------- consent choice

/// An app that asked for reading and editing gets Full control only because the person chose it
/// in their decision; the token response reports the scope actually granted.
#[tokio::test]
async fn the_token_response_reports_the_scope_the_person_granted() {
    let w = World::new();
    for (asked, chosen, scope) in [
        (
            "write",
            "manage",
            "openbase:read openbase:write openbase:manage",
        ),
        ("manage", "read", "openbase:read"),
        ("read", "write", "openbase:read openbase:write"),
    ] {
        let client_id = register_client(&w.app, "Agent", &[LOOPBACK_REDIRECT]).await;
        let (verifier, challenge) = pkce();
        let res = authorize_with_as(
            &w.app,
            &w.user,
            &client_id,
            LOOPBACK_REDIRECT,
            &challenge,
            &[("scope", scope_for(asked))],
        )
        .await;
        let id = request_id(&res);
        let info = w
            .app
            .get(&w.user, &format!("/api/oauth/requests/{id}"))
            .await;
        assert_eq!(info.body["max_access"], "manage");
        assert_eq!(info.body["default_access"], asked);
        let code = code_of(&approve(&w.app, &w.user, &id, chosen).await);
        let tokens = token_code(&w.app, &client_id, &code, LOOPBACK_REDIRECT, &verifier).await;
        tokens.assert_status(200);
        assert_eq!(tokens.body["scope"], scope, "asked {asked}, chose {chosen}");
        let refreshed = token_refresh(
            &w.app,
            &client_id,
            tokens.body["refresh_token"].as_str().unwrap(),
        )
        .await;
        assert_eq!(refreshed.body["scope"], scope);
    }
}

/// Only the signed-in person's own submission can grant more: a token, an OAuth grant, or a
/// request that names no level (or one that does not exist) gets nothing.
#[tokio::test]
async fn a_larger_scope_is_granted_only_by_the_persons_own_submission() {
    let w = World::new();
    let client_id = register_client(&w.app, "Agent", &[LOOPBACK_REDIRECT]).await;
    let (_, challenge) = pkce();
    let id = request_id(
        &authorize_with_as(
            &w.app,
            &w.user,
            &client_id,
            LOOPBACK_REDIRECT,
            &challenge,
            &[("scope", scope_for("read"))],
        )
        .await,
    );
    let pat = w
        .app
        .api_token(
            &w.user,
            json!({"name": "all", "write": true, "manage": true}),
        )
        .await;
    let path = format!("/api/oauth/requests/{id}/decision");
    let body = json!({"decision": "approve", "access": "manage"});
    w.app
        .post(&pat, &path, body.clone())
        .await
        .assert_status(403);
    w.app
        .post(&w.app.anon(), &path, body.clone())
        .await
        .assert_status(401);
    // Without the CSRF header or from another origin: refused, nothing issued.
    let no_csrf = w
        .app
        .request_with(&w.user, "POST", &path, Some(body.clone()), &[], false, None)
        .await;
    no_csrf.assert_status(403);
    let cross = w
        .app
        .request_with(
            &w.user,
            "POST",
            &path,
            Some(body),
            &[("origin", "https://evil.example")],
            true,
            None,
        )
        .await;
    cross.assert_status(403);
    assert_eq!(w.app.query_i64("SELECT count(*) FROM oauth_codes", &[]), 0);
}

// ------------------------------------------------------------------- change access

#[tokio::test]
async fn an_upgrade_reaches_the_live_token_on_its_next_request() {
    let w = World::new();
    let granted = connect(&w.app, &w.user, "Agent", "write", None).await;
    let agent = granted.bearer();
    let grant = w.grant_id(&w.user).await;
    assert!(!w.tools(&agent).await.contains(&"create_workspace".into()));
    legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_workspace", "arguments": {"name": "Made"}}),
    )
    .await
    .assert_status(403);

    let res = w.change(&w.user, &grant, "manage").await;
    res.assert_status(200);
    assert_eq!(res.body["id"], grant.as_str());
    assert_eq!(res.body["write"], true);
    assert_eq!(res.body["manage"], true);

    // The very same access token, no reconnect.
    assert!(w.tools(&agent).await.contains(&"create_workspace".into()));
    let made = tool(&w.app, &agent, "create_workspace", json!({"name": "Made"})).await;
    assert!(!made.is_error, "{}", made.text);

    // The refresh token issues the new scope too.
    let refreshed = token_refresh(&w.app, &granted.client_id, &granted.refresh).await;
    refreshed.assert_status(200);
    assert_eq!(
        refreshed.body["scope"],
        "openbase:read openbase:write openbase:manage"
    );
    // And the list shows it.
    let list = w.app.get(&w.user, "/api/oauth/grants").await;
    assert_eq!(list.body[0]["manage"], true);
}

#[tokio::test]
async fn a_downgrade_removes_manage_from_the_live_token_on_its_next_request() {
    let w = World::new();
    let granted = connect(&w.app, &w.user, "Agent", "manage", None).await;
    let agent = granted.bearer();
    let grant = w.grant_id(&w.user).await;
    let made = tool(&w.app, &agent, "create_workspace", json!({"name": "One"})).await;
    assert!(!made.is_error, "{}", made.text);

    w.change(&w.user, &grant, "write").await.assert_status(200);
    assert!(!w.tools(&agent).await.contains(&"create_workspace".into()));
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_workspace", "arguments": {"name": "Two"}}),
    )
    .await;
    res.assert_status(403);
    assert_eq!(
        w.app
            .query_i64("SELECT count(*) FROM workspaces WHERE name = 'Two'", &[]),
        0
    );
    // Still writes.
    let t = tool(
        &w.app,
        &agent,
        "create_table",
        json!({"base_id": w.base, "name": "T"}),
    )
    .await;
    assert!(!t.is_error, "{}", t.text);

    w.change(&w.user, &grant, "read").await.assert_status(200);
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_table", "arguments": {"base_id": w.base, "name": "U"}}),
    )
    .await;
    res.assert_status(403);
    let refreshed = token_refresh(&w.app, &granted.client_id, &granted.refresh).await;
    assert_eq!(refreshed.body["scope"], "openbase:read");
}

/// Full control is a ceiling on the app, not a promotion of the person: a Viewer's app is still a
/// Viewer's, and deleting a workspace still needs to be its owner.
#[tokio::test]
async fn a_change_never_gives_an_app_more_than_the_persons_own_role() {
    let w = World::new();
    let bob = w.app.user("bob@example.com", "Bob");
    w.app.grant_workspace_role(&bob, &w.ws, "viewer");
    let granted = connect(&w.app, &bob, "Bobs Agent", "read", None).await;
    let agent = granted.bearer();
    let grant = w.grant_id(&bob).await;
    w.change(&bob, &grant, "manage").await.assert_status(200);

    let t = tool(
        &w.app,
        &agent,
        "create_table",
        json!({"base_id": w.base, "name": "T"}),
    )
    .await;
    assert!(t.is_error, "{}", t.text);
    let d = tool(
        &w.app,
        &agent,
        "delete_workspace",
        json!({"workspace_id": w.ws}),
    )
    .await;
    assert!(d.is_error, "{}", d.text);
    assert_eq!(
        w.app.query_i64(
            "SELECT count(*) FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
            &[&w.ws]
        ),
        1
    );
    // An editor with Full control cannot delete a workspace they do not own either.
    w.app.grant_workspace_role(&bob, &w.ws, "editor");
    let d = tool(
        &w.app,
        &agent,
        "delete_workspace",
        json!({"workspace_id": w.ws}),
    )
    .await;
    assert!(d.is_error, "{}", d.text);
    // Nor can Bob hand his app a grant of someone else.
    let alice_agent = connect(&w.app, &w.user, "Alices Agent", "write", None).await;
    let alices = w.app.get(&w.user, "/api/oauth/grants").await.body[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    w.change(&bob, &alices, "manage").await.assert_status(404);
    assert!(
        !tool_names(&w.app, &alice_agent.bearer())
            .await
            .contains(&"create_workspace".into())
    );
}

#[tokio::test]
async fn an_app_limited_to_some_projects_still_cannot_manage() {
    let w = World::new();
    let granted = connect(
        &w.app,
        &w.user,
        "Agent",
        "write",
        Some(vec![w.base.clone()]),
    )
    .await;
    let grant = w.grant_id(&w.user).await;
    let res = w.change(&w.user, &grant, "manage").await;
    res.assert_status(400);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("limited to some projects"),
        "{}",
        res.body
    );
    assert_eq!(w.stored_scope(&grant)["manage"], false);
    // Downgrading keeps the project limit.
    w.change(&w.user, &grant, "read").await.assert_status(200);
    assert_eq!(
        w.stored_scope(&grant),
        json!({"write": false, "manage": false, "base_ids": [w.base]})
    );
    let _ = granted;
}

#[tokio::test]
async fn the_choice_is_validated() {
    let w = World::new();
    connect(&w.app, &w.user, "Agent", "write", None).await;
    let grant = w.grant_id(&w.user).await;
    for body in [
        json!({}),
        json!({"access": "root"}),
        json!({"access": ""}),
        json!({"access": "openbase:manage"}),
    ] {
        w.app
            .patch(&w.user, &format!("/api/oauth/grants/{grant}"), body)
            .await
            .assert_status(400);
    }
    w.change(&w.user, "grtNope", "read")
        .await
        .assert_status(404);
    assert_eq!(w.stored_scope(&grant)["write"], true);
}

// ------------------------------------------------------------------- who may call it

/// Session only, like every other way of changing a connected app: neither a token nor the
/// grant itself (also through `api_request`) can raise its own access.
#[tokio::test]
async fn only_a_signed_in_session_can_change_access() {
    let w = World::new();
    let granted = connect(&w.app, &w.user, "Agent", "write", None).await;
    let agent = granted.bearer();
    let grant = w.grant_id(&w.user).await;
    let path = format!("/api/oauth/grants/{grant}");
    let pat = w
        .app
        .api_token(
            &w.user,
            json!({"name": "all", "write": true, "manage": true}),
        )
        .await;
    w.app
        .patch(&pat, &path, json!({"access": "manage"}))
        .await
        .assert_status(403);
    w.app
        .patch(&w.app.anon(), &path, json!({"access": "manage"}))
        .await
        .assert_status(401);
    // The app itself, over MCP api_request: refused up front, and nothing changes.
    let (t, _) = api(
        &w.app,
        &agent,
        "PATCH",
        &path,
        Value::Null,
        json!({"access": "manage"}),
    )
    .await;
    assert!(t.is_error, "{}", t.text);
    assert_eq!(w.stored_scope(&grant)["manage"], false);
    assert!(
        audit_actions(&w.app)
            .iter()
            .all(|a| a != "oauth_grant_update")
    );
}

#[tokio::test]
async fn change_access_needs_the_csrf_header_and_the_right_origin() {
    let w = World::new();
    connect(&w.app, &w.user, "Agent", "write", None).await;
    let grant = w.grant_id(&w.user).await;
    let path = format!("/api/oauth/grants/{grant}");
    let body = || Some(json!({"access": "manage"}));

    let res = w
        .app
        .request_with(&w.user, "PATCH", &path, body(), &[], false, None)
        .await;
    res.assert_status(403);
    for origin in ["https://evil.example", "null", "http://localhost:9999"] {
        let res = w
            .app
            .request_with(
                &w.user,
                "PATCH",
                &path,
                body(),
                &[("origin", origin)],
                true,
                None,
            )
            .await;
        res.assert_status(403);
        assert_eq!(res.body["error"]["message"], "cross-origin request refused");
    }
    let res = w
        .app
        .request_with(
            &w.user,
            "PATCH",
            &path,
            body(),
            &[("referer", "https://evil.example/page")],
            true,
            None,
        )
        .await;
    res.assert_status(403);
    assert_eq!(w.stored_scope(&grant)["manage"], false);
    assert!(
        audit_actions(&w.app)
            .iter()
            .all(|a| a != "oauth_grant_update")
    );

    // The app's own origin passes.
    w.app
        .request_with(
            &w.user,
            "PATCH",
            &path,
            body(),
            &[("origin", "http://localhost:8080")],
            true,
            None,
        )
        .await
        .assert_status(200);
}

// ------------------------------------------------------------------- audit

#[tokio::test]
async fn every_change_is_in_the_audit_log_without_secrets() {
    let w = World::new();
    let granted = connect(&w.app, &w.user, "Agent", "write", None).await;
    let grant = w.grant_id(&w.user).await;
    w.change(&w.user, &grant, "manage").await.assert_status(200);
    w.change(&w.user, &grant, "read").await.assert_status(200);
    // A refused change leaves no entry.
    w.change(&w.user, &grant, "root").await.assert_status(400);

    let details = audit_details(&w.app, "oauth_grant_update");
    assert_eq!(details.len(), 2);
    assert_eq!(
        (details[0]["from"].as_str(), details[0]["to"].as_str()),
        (Some("write"), Some("manage"))
    );
    assert_eq!(
        (details[1]["from"].as_str(), details[1]["to"].as_str()),
        (Some("manage"), Some("read"))
    );
    assert_eq!(details[0]["client"], "Agent");
    let (target, user_id): (String, String) = w
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT target, user_id FROM audit_log WHERE action = 'oauth_grant_update' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(target, grant);
    assert_eq!(Some(user_id), w.user.user_id);
    let all = details.iter().map(Value::to_string).collect::<String>();
    assert!(!all.contains(&granted.access) && !all.contains(&granted.refresh));
}
