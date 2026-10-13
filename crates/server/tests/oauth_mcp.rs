//! OAuth access tokens on the MCP endpoint: scope mapping onto the token model, enforcement per
//! tool, 401 versus 403 answers, audience binding, expiry, revocation, and the rule that these
//! tokens work on `/mcp` and nowhere else. Also the "connected apps" lists and a run over real
//! HTTP.

mod common;
mod mcp_support;
mod oauth_support;

use common::{Client, TestApp};
use mcp_support::{LiveApp, legacy, modern, tool};
use oauth_support::*;
use serde_json::{Value, json};

struct World {
    app: TestApp,
    user: Client,
    ws: String,
    base: String,
    other_base: String,
}

impl World {
    async fn new() -> World {
        let app = TestApp::new();
        let user = app.user("alice@example.com", "Alice");
        let (ws, base) = app.workspace_with_base(&user, "Acme");
        let (_, other_base) = app.workspace_with_base(&user, "Other");
        World {
            app,
            user,
            ws,
            base,
            other_base,
        }
    }

    async fn connect(&self, access: &str, bases: Option<Vec<String>>) -> Connected {
        connect(&self.app, &self.user, "Test Agent", access, bases).await
    }

    fn count(&self, sql: &str) -> i64 {
        self.app.query_i64(sql, &[])
    }
}

fn www_authenticate(res: &common::Response) -> String {
    res.headers
        .get("www-authenticate")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

// --------------------------------------------------------------- scope mapping

#[tokio::test]
async fn each_access_level_sees_the_tools_of_the_matching_token_scope() {
    let w = World::new().await;
    for (access, scope) in [
        ("read", json!({"name": "r", "write": false})),
        ("write", json!({"name": "w", "write": true})),
        (
            "manage",
            json!({"name": "m", "write": true, "manage": true}),
        ),
    ] {
        let granted = w.connect(access, None).await;
        let pat = w.app.api_token(&w.user, scope).await;
        let mut oauth_tools = tool_names(&w.app, &granted.bearer()).await;
        let mut pat_tools = tool_names(&w.app, &pat).await;
        oauth_tools.sort();
        pat_tools.sort();
        assert_eq!(
            oauth_tools, pat_tools,
            "{access}: same tools as the equivalent token"
        );
        assert!(oauth_tools.len() > 10);
    }
    let read = tool_names(&w.app, &w.connect("read", None).await.bearer()).await;
    let write = tool_names(&w.app, &w.connect("write", None).await.bearer()).await;
    let manage = tool_names(&w.app, &w.connect("manage", None).await.bearer()).await;
    assert!(read.contains(&"list_records".into()) && !read.contains(&"create_records".into()));
    assert!(
        write.contains(&"create_records".into()) && !write.contains(&"create_workspace".into())
    );
    assert!(manage.contains(&"create_workspace".into()));
    assert!(read.len() < write.len() && write.len() < manage.len());
}

#[tokio::test]
async fn a_read_only_grant_reads_and_cannot_write() {
    let w = World::new().await;
    let granted = w.connect("read", None).await;
    let agent = granted.bearer();
    let bases = tool(&w.app, &agent, "list_bases", json!({})).await;
    assert!(!bases.is_error, "{}", bases.text);
    assert!(bases.text.contains(&w.base));

    // The tool is refused at the HTTP level with the scope that would be enough.
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_table", "arguments": {"base_id": w.base, "name": "T"}}),
    )
    .await;
    res.assert_status(403);
    let challenge = www_authenticate(&res);
    assert!(
        challenge.starts_with("Bearer realm=\"OpenBase MCP\", error=\"insufficient_scope\""),
        "{challenge}"
    );
    assert!(
        challenge.contains("scope=\"openbase:read openbase:write\""),
        "{challenge}"
    );
    assert!(
        challenge.ends_with(
            "resource_metadata=\"http://localhost:8080/.well-known/oauth-protected-resource/mcp\""
        ),
        "{challenge}"
    );
    let message = res.body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("create_table") && message.contains("Reconnect"),
        "{message}"
    );
    assert_eq!(w.count("SELECT count(*) FROM tables WHERE name = 'T'"), 0);

    // Manage tools ask for the manage scope.
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_workspace", "arguments": {"name": "W"}}),
    )
    .await;
    res.assert_status(403);
    assert!(
        www_authenticate(&res).contains("scope=\"openbase:read openbase:write openbase:manage\"")
    );
    // The modern protocol era gets the same answer.
    let res = modern(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "create_workspace", "arguments": {"name": "W"}}),
    )
    .await;
    res.assert_status(403);

    // Nothing but a tool of this endpoint is turned into a 403: unknown tools stay protocol
    // errors, and reading and listing are fine.
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "no_such_tool", "arguments": {}}),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["error"]["code"], -32602);
    legacy(&w.app, &agent, "tools/list", json!({}))
        .await
        .assert_status(200);
    legacy(&w.app, &agent, "ping", json!({}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_personal_access_token_that_lacks_the_scope_still_gets_a_tool_error() {
    let w = World::new().await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "r", "write": false}))
        .await;
    let res = legacy(
        &w.app,
        &pat,
        "tools/call",
        json!({"name": "create_table", "arguments": {"base_id": w.base, "name": "T"}}),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["result"]["isError"], true);
    assert!(!res.headers.contains_key("www-authenticate"));
}

#[tokio::test]
async fn a_write_grant_edits_data_but_does_not_manage() {
    let w = World::new().await;
    let agent = w.connect("write", None).await.bearer();
    let table = tool(
        &w.app,
        &agent,
        "create_table",
        json!({"base_id": w.base, "name": "Customers"}),
    )
    .await;
    assert!(!table.is_error, "{}", table.text);
    tool(
        &w.app,
        &agent,
        "create_field",
        json!({"base_id": w.base, "table": "Customers", "name": "Email", "type": "email"}),
    )
    .await
    .ok();
    let created = tool(
        &w.app,
        &agent,
        "create_records",
        json!({"base_id": w.base, "table": "Customers", "records": [{"fields": {"Name": "Ada", "Email": "ada@example.com"}}]}),
    )
    .await;
    assert!(!created.is_error, "{}", created.text);
    let listed = tool(
        &w.app,
        &agent,
        "list_records",
        json!({"base_id": w.base, "table": "Customers"}),
    )
    .await;
    assert!(listed.text.contains("ada@example.com"));

    // Changes are attributed to the user, as with a token.
    let id = created.ok()["created"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let history = w
        .app
        .get(&w.user, &format!("/api/records/{id}/history"))
        .await;
    history.assert_status(200);
    assert!(
        history
            .body
            .to_string()
            .contains(w.user.user_id.as_ref().unwrap())
    );

    // No manage tools.
    let res = legacy(
        &w.app,
        &agent,
        "tools/call",
        json!({"name": "delete_workspace", "arguments": {"workspace_id": w.ws}}),
    )
    .await;
    res.assert_status(403);
    assert_eq!(
        w.count("SELECT count(*) FROM workspaces WHERE deleted_at IS NOT NULL"),
        0
    );
}

#[tokio::test]
async fn a_full_control_grant_manages_workspaces_but_never_credentials() {
    let w = World::new().await;
    let agent = w.connect("manage", None).await.bearer();
    let ws = tool(
        &w.app,
        &agent,
        "create_workspace",
        json!({"name": "Made by agent"}),
    )
    .await;
    assert!(!ws.is_error, "{}", ws.text);
    // The escape hatches run as the grant: allowed endpoints work...
    let me = tool(
        &w.app,
        &agent,
        "api_request",
        json!({"method": "GET", "path": "/api/auth/me"}),
    )
    .await;
    assert!(!me.is_error, "{}", me.text);
    assert!(me.text.contains("alice@example.com"));
    // ...and credentials, sessions and tokens are out of reach, as for every token.
    for (method, path, body) in [
        ("GET", "/api/tokens", None),
        (
            "POST",
            "/api/tokens",
            Some(json!({"name": "x", "write": true, "manage": true})),
        ),
        ("GET", "/api/auth/sessions", None),
        (
            "POST",
            "/api/auth/password",
            Some(json!({"current_password": "password1234", "new_password": "another password 1"})),
        ),
        ("GET", "/api/oauth/grants", None),
        ("DELETE", "/api/oauth/grants/grtNope", None),
        (
            "POST",
            "/api/oauth/requests/oarNope/decision",
            Some(json!({"decision": "approve", "access": "manage"})),
        ),
        ("GET", "/api/admin/oauth/grants", None),
    ] {
        let mut args = json!({"method": method, "path": path});
        if let Some(b) = body {
            args["body"] = b;
        }
        let res = tool(&w.app, &agent, "api_request", args).await;
        assert!(
            res.is_error,
            "{method} {path} must be refused: {}",
            res.text
        );
        assert!(
            res.text.contains("not available through MCP"),
            "{method} {path}: {}",
            res.text
        );
    }
    assert_eq!(w.count("SELECT count(*) FROM api_tokens"), 0);
    assert_eq!(w.count("SELECT count(*) FROM oauth_grants"), 1);
}

#[tokio::test]
async fn the_grants_own_permissions_apply_inside_api_request_too() {
    let w = World::new().await;
    // Read-only: a write is refused by the same rule as for a read-only token.
    let read = w.connect("read", None).await.bearer();
    let ok = tool(
        &w.app,
        &read,
        "api_request",
        json!({"method": "GET", "path": format!("/api/bases/{}", w.base)}),
    )
    .await;
    assert!(!ok.is_error, "{}", ok.text);
    let denied = tool(
        &w.app,
        &read,
        "api_request",
        json!({"method": "POST", "path": format!("/api/bases/{}/tables", w.base), "body": {"name": "T"}}),
    )
    .await;
    assert!(
        denied.is_error || denied.text.contains("read-only"),
        "{}",
        denied.text
    );
    assert_eq!(w.count("SELECT count(*) FROM tables WHERE name = 'T'"), 0);
    // Write without manage: workspace-level actions need the manage permission.
    let write = w.connect("write", None).await.bearer();
    let res = tool(
        &w.app,
        &write,
        "api_request",
        json!({"method": "PATCH", "path": format!("/api/workspaces/{}", w.ws), "body": {"name": "Renamed"}}),
    )
    .await;
    assert!(res.is_error || res.text.contains("manage"), "{}", res.text);
    assert_eq!(
        w.count("SELECT count(*) FROM workspaces WHERE name = 'Renamed'"),
        0
    );
}

#[tokio::test]
async fn a_grant_limited_to_one_base_sees_only_that_base() {
    let w = World::new().await;
    let agent = w
        .connect("write", Some(vec![w.base.clone()]))
        .await
        .bearer();
    let bases = tool(&w.app, &agent, "list_bases", json!({})).await;
    assert!(bases.text.contains(&w.base), "{}", bases.text);
    assert!(!bases.text.contains(&w.other_base), "{}", bases.text);
    let other = tool(
        &w.app,
        &agent,
        "get_base_schema",
        json!({"base_id": w.other_base}),
    )
    .await;
    assert!(other.is_error, "{}", other.text);
    let via_api = tool(
        &w.app,
        &agent,
        "api_request",
        json!({"method": "GET", "path": format!("/api/bases/{}", w.other_base)}),
    )
    .await;
    assert!(
        via_api.is_error || via_api.text.contains("404") || via_api.text.contains("not found"),
        "{}",
        via_api.text
    );
    let own = tool(
        &w.app,
        &agent,
        "get_base_schema",
        json!({"base_id": w.base}),
    )
    .await;
    assert!(!own.is_error, "{}", own.text);
    // Workspace-level actions are not available to a base-limited grant, even with manage.
    let manage = w
        .connect("manage", Some(vec![w.base.clone()]))
        .await
        .bearer();
    let res = tool(&w.app, &manage, "create_workspace", json!({"name": "Nope"})).await;
    assert!(res.is_error, "{}", res.text);
    assert_eq!(
        w.count("SELECT count(*) FROM workspaces WHERE name = 'Nope'"),
        0
    );
}

#[tokio::test]
async fn the_role_of_the_user_still_limits_the_grant() {
    let w = World::new().await;
    let bob = w.app.user("bob@example.com", "Bob");
    w.app.grant_base_role(&bob, &w.base, "viewer");
    let agent = connect(&w.app, &bob, "Bobs Agent", "manage", None)
        .await
        .bearer();
    // Full control, but Bob is only a viewer of this base.
    let res = tool(
        &w.app,
        &agent,
        "create_table",
        json!({"base_id": w.base, "name": "T"}),
    )
    .await;
    assert!(res.is_error, "{}", res.text);
    assert!(res.text.contains("role"), "{}", res.text);
    let bases = tool(&w.app, &agent, "list_bases", json!({})).await;
    assert!(!bases.text.contains(&w.other_base));
}

// -------------------------------------------------------------- 401 versus 403

#[tokio::test]
async fn invalid_expired_and_misdirected_tokens_are_401_with_invalid_token() {
    let w = World::new().await;
    let granted = w.connect("write", None).await;
    let agent = granted.bearer();
    legacy(&w.app, &agent, "tools/list", json!({}))
        .await
        .assert_status(200);

    let expect_invalid = |res: &common::Response, why: &str| {
        assert_eq!(res.status, 401, "{why}");
        let h = www_authenticate(res);
        assert!(h.contains("error=\"invalid_token\""), "{why}: {h}");
        assert!(h.contains("resource_metadata=\""), "{why}: {h}");
        assert!(!h.contains("insufficient_scope"), "{why}: {h}");
    };
    // Unknown token, a refresh token and a code are no access tokens.
    for bad in ["oatNOTATOKEN", &granted.refresh, "ocdNOTACODE"] {
        expect_invalid(
            &legacy(&w.app, &TestApp::bearer(bad), "tools/list", json!({})).await,
            bad,
        );
    }
    // Expired.
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_tokens SET expires_at = ?1 WHERE kind = 'access'",
                [openbase::db::now_ms() - 1],
            )?;
            Ok(())
        })
        .unwrap();
    expect_invalid(
        &legacy(&w.app, &agent, "tools/list", json!({})).await,
        "expired",
    );
    // A refresh yields a working token again.
    let fresh = token_refresh(&w.app, &granted.client_id, &granted.refresh).await;
    fresh.assert_status(200);
    let agent = TestApp::bearer(fresh.body["access_token"].as_str().unwrap());
    legacy(&w.app, &agent, "tools/list", json!({}))
        .await
        .assert_status(200);
    // Issued for another audience (the public URL changed, or the row was tampered with).
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_grants SET resource = 'https://other.example/mcp'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    expect_invalid(
        &legacy(&w.app, &agent, "tools/list", json!({})).await,
        "wrong audience",
    );
}

#[tokio::test]
async fn tokens_die_with_their_user_or_their_grant() {
    let w = World::new().await;
    // Deactivated user.
    let a = w.connect("read", None).await;
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE users SET is_active = 0", [])?;
            Ok(())
        })
        .unwrap();
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE users SET is_active = 1", [])?;
            Ok(())
        })
        .unwrap();
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);
    // A deleted user takes the grants with them (foreign keys).
    let bob = w.app.user("bob@example.com", "Bob");
    let b = connect(&w.app, &bob, "Bobs", "read", None).await;
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("DELETE FROM users WHERE email = 'bob@example.com'", [])?;
            Ok(())
        })
        .unwrap();
    legacy(&w.app, &b.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
}

#[tokio::test]
async fn changing_the_password_disconnects_every_app() {
    let w = World::new().await;
    let a = w.connect("manage", None).await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);
    let res = w
        .app
        .post(
            &w.user,
            "/api/auth/password",
            json!({"current_password": "password1234", "new_password": "a brand new password 99"}),
        )
        .await;
    res.assert_status(200);
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
    legacy(&w.app, &pat, "tools/list", json!({}))
        .await
        .assert_status(401);
    token_refresh(&w.app, &a.client_id, &a.refresh)
        .await
        .assert_status(400);
    assert_eq!(w.count("SELECT count(*) FROM oauth_grants"), 0);
}

// ---------------------------------------------------------- MCP only, not /api

#[tokio::test]
async fn oauth_tokens_work_on_mcp_and_nowhere_else() {
    let w = World::new().await;
    let granted = w.connect("manage", None).await;
    let agent = granted.bearer();
    legacy(&w.app, &agent, "tools/list", json!({}))
        .await
        .assert_status(200);

    let base = w.base.as_str();
    for path in [
        "/api/auth/me".to_string(),
        "/api/tokens/whoami".to_string(),
        "/api/workspaces".to_string(),
        format!("/api/bases/{base}"),
        format!("/api/bases/{base}/events"),
        "/api/v1/meta/bases".to_string(),
        format!("/api/v1/{base}/Table%201"),
        "/api/admin/users".to_string(),
        "/api/oauth/grants".to_string(),
    ] {
        let res = w.app.get(&agent, &path).await;
        assert_eq!(
            res.status, 401,
            "GET {path} must not accept an OAuth access token"
        );
    }
    for (method, path, body) in [
        ("POST", "/api/workspaces", Some(json!({"name": "Backdoor"}))),
        (
            "POST",
            "/api/tokens",
            Some(json!({"name": "x", "write": true, "manage": true})),
        ),
        ("DELETE", &format!("/api/bases/{base}"), None),
    ] {
        let res = w.app.request(&agent, method, path, body).await;
        assert_eq!(res.status, 401, "{method} {path}");
    }
    assert_eq!(
        w.count("SELECT count(*) FROM workspaces WHERE name = 'Backdoor'"),
        0
    );
    assert_eq!(
        w.count("SELECT count(*) FROM bases WHERE deleted_at IS NOT NULL"),
        0
    );
    // The refresh token is not accepted anywhere either.
    let refresh = TestApp::bearer(&granted.refresh);
    assert_eq!(w.app.get(&refresh, "/api/auth/me").await.status, 401);
    // A personal access token is not accepted by the OAuth-only rules in the other direction.
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;
    assert_eq!(w.app.get(&pat, "/api/auth/me").await.status, 200);
    assert_eq!(w.app.get(&pat, "/api/v1/meta/bases").await.status, 200);
}

#[tokio::test]
async fn the_mcp_origin_rule_applies_to_oauth_tokens_too() {
    let w = World::new().await;
    let agent = w.connect("read", None).await.bearer();
    let body = mcp_support::rpc_message(1, "tools/list", json!({}));
    let post = |origin: &'static str| {
        let (w, agent, body) = (&w, &agent, body.clone());
        async move {
            w.app
                .request_with(
                    agent,
                    "POST",
                    "/mcp",
                    Some(body),
                    &[("origin", origin)],
                    false,
                    None,
                )
                .await
        }
    };
    post("https://evil.example").await.assert_status(403);
    post("http://localhost:8080").await.assert_status(200);
}

#[tokio::test]
async fn session_cookies_still_do_not_reach_mcp() {
    let w = World::new().await;
    let res = legacy(&w.app, &w.user, "tools/list", json!({})).await;
    res.assert_status(401);
    let h = www_authenticate(&res);
    assert!(h.contains("resource_metadata="), "{h}");
}

// --------------------------------------------------------------- limits and use

#[tokio::test]
async fn a_grant_is_rate_limited_as_a_whole_across_token_refreshes() {
    let app = TestApp::with_config(|c| {
        c.mcp_rate_per_token = 3;
        c.mcp_rate_per_user = 1000;
    });
    let user = app.user("alice@example.com", "Alice");
    let granted = connect(&app, &user, "Busy", "read", None).await;
    for _ in 0..3 {
        legacy(&app, &granted.bearer(), "ping", json!({}))
            .await
            .assert_status(200);
    }
    let res = legacy(&app, &granted.bearer(), "ping", json!({})).await;
    res.assert_status(429);
    assert_eq!(res.headers["retry-after"], "1");
    // Rotating the tokens does not buy a new allowance.
    let fresh = token_refresh(&app, &granted.client_id, &granted.refresh).await;
    let again = TestApp::bearer(fresh.body["access_token"].as_str().unwrap());
    legacy(&app, &again, "ping", json!({}))
        .await
        .assert_status(429);
    // Invalid tokens are not counted against anyone.
    legacy(&app, &TestApp::bearer("oatNope"), "ping", json!({}))
        .await
        .assert_status(401);
}

#[tokio::test]
async fn using_a_grant_stamps_its_last_use() {
    let w = World::new().await;
    let granted = w.connect("read", None).await;
    let list = w.app.get(&w.user, "/api/oauth/grants").await;
    assert!(list.body[0]["last_used_at"].is_null(), "never used so far");
    legacy(&w.app, &granted.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);
    let list = w.app.get(&w.user, "/api/oauth/grants").await;
    let used = list.body[0]["last_used_at"].as_i64().unwrap();
    assert!((openbase::db::now_ms() - used).abs() < 60_000);
}

#[tokio::test]
async fn both_protocol_eras_work_with_oauth_tokens() {
    let w = World::new().await;
    let agent = w.connect("read", None).await.bearer();
    let res = legacy(
        &w.app,
        &agent,
        "initialize",
        json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["result"]["serverInfo"]["name"], "openbase");
    let res = modern(&w.app, &agent, "server/discover", json!({})).await;
    res.assert_status(200);
    let res = modern(&w.app, &agent, "tools/list", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["result"]["cacheScope"], "private");
}

// ------------------------------------------------------------- connected apps

#[tokio::test]
async fn connected_apps_list_what_each_app_may_do() {
    let w = World::new().await;
    let a = connect(
        &w.app,
        &w.user,
        "Notes Helper",
        "write",
        Some(vec![w.base.clone()]),
    )
    .await;
    let _ = a;
    let client = register_client(&w.app, "Server Agent", &["https://agent.example.org/cb"]).await;
    connect_as(
        &w.app,
        &w.user,
        &client,
        "https://agent.example.org/cb",
        "manage",
        None,
    )
    .await;
    let bob = w.app.user("bob@example.com", "Bob");
    connect(&w.app, &bob, "Bobs Tool", "read", None).await;

    let list = w.app.get(&w.user, "/api/oauth/grants").await;
    list.assert_status(200);
    let grants = list.body.as_array().unwrap();
    assert_eq!(grants.len(), 2, "only my own");
    let by_name = |n: &str| {
        grants
            .iter()
            .find(|g| g["client_name"] == n)
            .unwrap()
            .clone()
    };
    let notes = by_name("Notes Helper");
    assert_eq!(notes["write"], true);
    assert_eq!(notes["manage"], false);
    assert_eq!(notes["bases"], json!([{"id": w.base, "name": "Acme base"}]));
    assert_eq!(notes["redirect_host"], "127.0.0.1:53124");
    assert_eq!(notes["client_source"], "dcr");
    assert!(notes["id"].as_str().unwrap().starts_with("grt"));
    assert!(notes["created_at"].as_i64().unwrap() > 0);
    assert!(notes["expires_at"].as_i64().unwrap() > openbase::db::now_ms() + 29 * 24 * 3_600_000);
    assert!(
        notes["user_email"].is_null(),
        "the owner's own list does not repeat who they are"
    );
    let server = by_name("Server Agent");
    assert_eq!(server["manage"], true);
    assert!(server["bases"].is_null());
    assert_eq!(server["redirect_host"], "agent.example.org");

    // A signed-out visitor sees nothing.
    w.app
        .get(&w.app.anon(), "/api/oauth/grants")
        .await
        .assert_status(401);
}

#[tokio::test]
async fn revoking_a_connected_app_cuts_it_off_at_once() {
    let w = World::new().await;
    let a = w.connect("write", None).await;
    let list = w.app.get(&w.user, "/api/oauth/grants").await;
    let id = list.body[0]["id"].as_str().unwrap().to_string();
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);

    // Another user cannot revoke it (and cannot tell it exists).
    let bob = w.app.user("bob@example.com", "Bob");
    w.app
        .delete(&bob, &format!("/api/oauth/grants/{id}"))
        .await
        .assert_status(404);
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);

    w.app
        .delete(&w.user, &format!("/api/oauth/grants/{id}"))
        .await
        .assert_status(204);
    legacy(&w.app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
    token_refresh(&w.app, &a.client_id, &a.refresh)
        .await
        .assert_status(400);
    w.app
        .delete(&w.user, &format!("/api/oauth/grants/{id}"))
        .await
        .assert_status(404);
    assert_eq!(
        w.app.get(&w.user, "/api/oauth/grants").await.body,
        json!([])
    );
    assert_eq!(w.count("SELECT count(*) FROM oauth_tokens"), 0);
    assert!(audit_actions(&w.app).contains(&"oauth_grant_revoke".to_string()));
}

/// The actor `api_request` hands to the router for an OAuth grant.
fn trusted(w: &World, granted: &Connected) -> openbase::auth::TrustedActor {
    let access = granted.access.clone();
    let (actor, _) = w
        .app
        .state
        .db
        .write_sync(move |tx| {
            openbase::auth::lookup_oauth_token(tx, &access, "http://localhost:8080/mcp")
        })
        .unwrap()
        .expect("a valid token");
    openbase::auth::TrustedActor(actor)
}

async fn send_trusted(
    w: &World,
    actor: &openbase::auth::TrustedActor,
    method: &str,
    path: &str,
) -> axum::response::Response {
    use tower::ServiceExt;
    let mut req = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from("{\"name\":\"Made in process\"}"))
        .unwrap();
    req.extensions_mut().insert(actor.clone());
    w.app.router.clone().oneshot(req).await.unwrap()
}

#[tokio::test]
async fn a_trusted_actor_is_judged_by_the_grants_scope_not_by_headers() {
    let w = World::new().await;
    // The in-process request that `api_request` builds carries the actor as an extension, with no
    // credentials at all: read-only grants still cannot write, and may read.
    let read = trusted(&w, &w.connect("read", None).await);
    assert_eq!(
        send_trusted(&w, &read, "GET", "/api/auth/me")
            .await
            .status(),
        200
    );
    assert_eq!(
        send_trusted(&w, &read, "POST", "/api/workspaces")
            .await
            .status(),
        403
    );
    assert_eq!(
        w.count("SELECT count(*) FROM workspaces WHERE name = 'Made in process'"),
        0
    );
    let manage = trusted(&w, &w.connect("manage", None).await);
    assert_eq!(
        send_trusted(&w, &manage, "POST", "/api/workspaces")
            .await
            .status(),
        201
    );
    // Session-only routes stay closed to it.
    assert_eq!(
        send_trusted(&w, &manage, "GET", "/api/tokens")
            .await
            .status(),
        403
    );
    // Over the network nothing can supply the extension: headers do not stand in for it.
    let res = w
        .app
        .request_with(
            &w.app.anon(),
            "GET",
            "/api/auth/me",
            None,
            &[
                ("x-trusted-actor", "usr"),
                ("x-openbase-actor", w.user.user_id.as_deref().unwrap()),
            ],
            false,
            None,
        )
        .await;
    res.assert_status(401);
}

#[tokio::test]
async fn an_event_stream_of_a_grant_ends_when_the_grant_is_revoked() {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let w = World::new().await;
    openbase::api::events::set_timing_for_tests(
        std::time::Duration::from_millis(200),
        std::time::Duration::from_millis(100),
    );
    let granted = w.connect("read", None).await;
    let actor = trusted(&w, &granted);
    let mut req = axum::http::Request::builder()
        .uri(format!("/api/bases/{}/events", w.base))
        .body(axum::body::Body::empty())
        .unwrap();
    req.extensions_mut().insert(actor);
    let res = w.app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let mut body = res.into_body();
    // The greeting arrives; the stream is open.
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
        .await
        .unwrap();
    assert!(first.is_some());
    w.app
        .delete(&w.user, &format!("/api/oauth/grants/{}", grant_id(&w)))
        .await
        .assert_status(204);
    // It ends within a few re-check intervals.
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(frame) = body.frame().await {
            let _ = frame;
        }
    })
    .await;
    assert!(ended.is_ok(), "the stream of a revoked grant must end");
}

fn grant_id(w: &World) -> String {
    w.app
        .state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT id FROM oauth_grants", [], |r| r.get(0))?))
        .unwrap()
}

#[tokio::test]
async fn administrators_see_and_revoke_every_connection() {
    let app = TestApp::new();
    let admin = app.admin("root@example.com", "Root");
    let alice = app.user("alice@example.com", "Alice");
    let a = connect(&app, &alice, "Alices Agent", "write", None).await;
    connect(&app, &admin, "Roots Agent", "read", None).await;

    let list = app.get(&admin, "/api/admin/oauth/grants").await;
    list.assert_status(200);
    let grants = list.body.as_array().unwrap();
    assert_eq!(grants.len(), 2);
    let alices = grants
        .iter()
        .find(|g| g["client_name"] == "Alices Agent")
        .unwrap();
    assert_eq!(alices["user_email"], "alice@example.com");
    assert_eq!(alices["user_name"], "Alice");

    // Ordinary users and anonymous visitors cannot.
    app.get(&alice, "/api/admin/oauth/grants")
        .await
        .assert_status(403);
    app.get(&app.anon(), "/api/admin/oauth/grants")
        .await
        .assert_status(401);
    let id = alices["id"].as_str().unwrap();
    app.delete(&alice, &format!("/api/admin/oauth/grants/{id}"))
        .await
        .assert_status(403);
    legacy(&app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);

    app.delete(&admin, &format!("/api/admin/oauth/grants/{id}"))
        .await
        .assert_status(204);
    legacy(&app, &a.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
    app.delete(&admin, &format!("/api/admin/oauth/grants/{id}"))
        .await
        .assert_status(404);
    assert_eq!(
        app.get(&admin, "/api/admin/oauth/grants")
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // The audit log says who did it and to whom.
    let audit = app.get(&admin, "/api/admin/audit").await;
    let entry = audit.body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["action"] == "oauth_grant_revoke")
        .unwrap()
        .clone();
    assert_eq!(entry["target"], id);
    assert_eq!(entry["detail"]["by"], "admin");
    assert_eq!(entry["user_email"], "root@example.com");
}

#[tokio::test]
async fn the_audit_log_follows_the_whole_story() {
    let w = World::new().await;
    let fx_client = register_client(&w.app, "Story App", &[LOOPBACK_REDIRECT]).await;
    // Denied once, then approved.
    let id =
        request_id(&authorize_with(&w.app, &fx_client, LOOPBACK_REDIRECT, &pkce().1, &[]).await);
    decide(&w.app, &w.user, &id, json!({"decision": "deny"}))
        .await
        .assert_status(200);
    let a = connect_as(
        &w.app,
        &w.user,
        &fx_client,
        LOOPBACK_REDIRECT,
        "write",
        None,
    )
    .await;
    // Reuse of a refresh token, then a fresh connection revoked by the user.
    token_refresh(&w.app, &fx_client, &a.refresh)
        .await
        .assert_status(200);
    // (Past the grace window in which a client racing itself is merely refused.)
    w.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_tokens SET used_at = used_at - 60000 WHERE used_at IS NOT NULL",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    token_refresh(&w.app, &fx_client, &a.refresh)
        .await
        .assert_status(400);
    let b = connect_as(&w.app, &w.user, &fx_client, LOOPBACK_REDIRECT, "read", None).await;
    let grants = w.app.get(&w.user, "/api/oauth/grants").await;
    let grant = grants.body[0]["id"].as_str().unwrap().to_string();
    w.app
        .delete(&w.user, &format!("/api/oauth/grants/{grant}"))
        .await
        .assert_status(204);
    let _ = b;
    let actions = audit_actions(&w.app);
    for expected in [
        "oauth_deny",
        "oauth_approve",
        "oauth_grant_create",
        "oauth_refresh_reuse",
        "oauth_grant_revoke",
    ] {
        assert!(
            actions.contains(&expected.to_string()),
            "{expected} in {actions:?}"
        );
    }
    // Entries name the app and where the access went, never a token.
    let admin = w.app.admin("root@example.com", "Root");
    let log = w.app.get(&admin, "/api/admin/audit?limit=100").await;
    let text = log.body.to_string();
    assert!(text.contains("Story App") && text.contains("127.0.0.1:53124"));
    assert!(!text.contains("oat") || !text.contains(&a.access));
    assert!(!text.contains(&a.refresh));
}

// -------------------------------------------------------------- over real HTTP

#[tokio::test]
async fn the_whole_flow_over_real_http() {
    let live = LiveApp::start().await;
    let app = &live.app;
    let user = app.user("alice@example.com", "Alice");
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // 1. Discovery from the 401 of the MCP endpoint.
    let res = http
        .post(format!("{}/mcp", live.url))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let challenge = res.headers()["www-authenticate"]
        .to_str()
        .unwrap()
        .to_string();
    let metadata_url = challenge
        .split("resource_metadata=\"")
        .nth(1)
        .unwrap()
        .trim_end_matches('"')
        .to_string();
    assert_eq!(
        metadata_url,
        format!("{}/.well-known/oauth-protected-resource/mcp", live.url)
    );
    let resource: Value = http
        .get(&metadata_url)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resource["resource"], format!("{}/mcp", live.url));
    let issuer = resource["authorization_servers"][0]
        .as_str()
        .unwrap()
        .to_string();
    let server: Value = http
        .get(format!("{issuer}/.well-known/oauth-authorization-server"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // 2. Register with a loopback redirect, authorize, approve.
    let reg: Value = http
        .post(server["registration_endpoint"].as_str().unwrap())
        .json(&json!({"client_name": "HTTP Test", "redirect_uris": ["http://127.0.0.1:40000/cb"], "token_endpoint_auth_method": "none"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let client_id = reg["client_id"].as_str().unwrap().to_string();
    let (verifier, challenge) = pkce();
    let query = encode(&[
        ("response_type", "code"),
        ("client_id", &client_id),
        ("redirect_uri", "http://127.0.0.1:40000/cb"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", "s1"),
        ("resource", &format!("{}/mcp", live.url)),
    ]);
    let authorize_url = format!(
        "{}?{query}",
        server["authorization_endpoint"].as_str().unwrap()
    );
    // Without a session the browser is sent to sign in and back to this very request; nothing
    // is stored.
    let res = http.get(&authorize_url).send().await.unwrap();
    assert_eq!(res.status(), 302);
    let to = res.headers()["location"].to_str().unwrap().to_string();
    assert!(to.starts_with("/login?next="), "{to}");
    // With the session cookie of the person who signed in, the request is validated and stored.
    let res = http
        .get(&authorize_url)
        .header(
            "cookie",
            format!(
                "{}={}",
                openbase::auth::SESSION_COOKIE,
                user.cookie.as_deref().unwrap()
            ),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 302);
    let to = res.headers()["location"].to_str().unwrap().to_string();
    assert!(to.starts_with("/oauth/consent?request="));
    let id = to.trim_start_matches("/oauth/consent?request=").to_string();
    // The consent page is the app (served by the SPA fallback), and it is not frameable.
    let page = http.get(format!("{}{to}", live.url)).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(
        page.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert_eq!(page.headers()["x-frame-options"], "DENY");
    let approval = approve(app, &user, &id, "write").await;
    let code = code_of(&approval);
    let redirect = query_of(approval.body["redirect_to"].as_str().unwrap());
    assert_eq!(redirect["state"], "s1");
    assert_eq!(redirect["iss"], issuer);

    // 3. Token request, then MCP with the access token.
    let tokens: Value = http
        .post(server["token_endpoint"].as_str().unwrap())
        .header("content-type", "application/x-www-form-urlencoded")
        .body(encode(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", "http://127.0.0.1:40000/cb"),
            ("code_verifier", verifier.as_str()),
        ]))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    let agent = live.agent(access);
    agent.initialize().await;
    let names = agent.tool_names().await;
    assert!(names.contains(&"create_records".to_string()));
    assert!(!names.contains(&"create_workspace".to_string()));
    let (status, body) = agent
        .rpc("tools/call", json!({"name": "list_bases", "arguments": {}}))
        .await;
    assert_eq!(status, 200, "{body}");

    // 4. Revoke over HTTP.
    let res = http
        .post(server["revocation_endpoint"].as_str().unwrap())
        .header("content-type", "application/x-www-form-urlencoded")
        .body(encode(&[
            ("token", access),
            ("client_id", client_id.as_str()),
        ]))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let (status, _) = agent.rpc("tools/list", json!({})).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn a_full_control_grant_of_an_administrator_cannot_fetch_a_backup_archive() {
    let app = TestApp::new();
    let admin = app.admin("root@example.com", "Root");
    let grant = connect(&app, &admin, "Admin Agent", "manage", None).await;
    let name = app.post(&admin, "/api/admin/backups", json!({})).await.body["name"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/admin/backups/{name}");

    // The archive carries every password hash, two-factor secret and the SMTP password: even a
    // grant with full control gets nothing of it, through the tool or any other way.
    let (t, _) = mcp_support::api(
        &app,
        &grant.bearer(),
        "GET",
        &path,
        Value::Null,
        Value::Null,
    )
    .await;
    assert!(t.err().contains("not available through MCP"), "{}", t.text);
    assert!(!t.raw.body.to_string().contains("body_base64"));
    // Used as a bearer on the REST API directly, an OAuth token is refused anyway.
    app.request(&grant.bearer(), "GET", &path, None)
        .await
        .assert_status(401);
    // The signed-in administrator still downloads it.
    app.request(&admin, "GET", &path, None)
        .await
        .assert_status(200);
    // The tools that only list and create keep working for the grant.
    tool(&app, &grant.bearer(), "admin_list_backups", json!({}))
        .await
        .ok();
}

/// `/api/v1` takes a personal access token and nothing else, so it cannot work for an app that
/// connected through OAuth. `api_request` says so up front and `api_reference` marks the area
/// unavailable instead of offering endpoints that can only answer 401.
#[tokio::test]
async fn the_airtable_api_is_not_available_to_oauth_grants_and_says_so() {
    let w = World::new().await;
    let grant = w.connect("write", None).await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;

    for path in [
        "/api/v1/meta/bases".to_string(),
        format!("/api/v1/{}/Anything", w.base),
    ] {
        let (t, _) = mcp_support::api(
            &w.app,
            &grant.bearer(),
            "GET",
            &path,
            Value::Null,
            Value::Null,
        )
        .await;
        let msg = t.err();
        assert!(
            msg.contains("not available to apps connected through OAuth")
                && msg.contains("personal access token"),
            "{path}: {msg}"
        );
        assert!(!msg.contains("401"), "{msg}");
    }
    // A personal access token reaches it through the same tool.
    let (t, inner) = mcp_support::api(
        &w.app,
        &pat,
        "GET",
        "/api/v1/meta/bases",
        Value::Null,
        Value::Null,
    )
    .await;
    t.ok();
    assert_eq!(inner["status"], 200, "{inner}");
    // The ordinary API is unaffected for the grant.
    let (t, inner) = mcp_support::api(
        &w.app,
        &grant.bearer(),
        "GET",
        &format!("/api/bases/{}", w.base),
        Value::Null,
        Value::Null,
    )
    .await;
    t.ok();
    assert_eq!(inner["status"], 200);

    // The reference marks the area, and each of its endpoints, unavailable to the grant only.
    let reference = |client: Client, area: Value| {
        let app = &w.app;
        async move {
            let args = if area.is_null() {
                json!({})
            } else {
                json!({"area": area})
            };
            tool(app, &client, "api_reference", args).await
        }
    };
    let all = reference(grant.bearer(), Value::Null).await;
    let areas = all.ok()["areas"].as_array().unwrap().clone();
    let airtable = areas.iter().find(|a| a["area"] == "airtable").unwrap();
    assert_eq!(airtable["available"], false);
    assert!(
        airtable["note"]
            .as_str()
            .unwrap()
            .contains("personal access token")
    );
    let list = reference(grant.bearer(), json!("airtable")).await;
    let endpoints = list.ok()["endpoints"].as_array().unwrap().clone();
    assert!(!endpoints.is_empty());
    for e in &endpoints {
        assert_eq!(e["available"], false, "{e}");
        assert!(
            e["token_capability"]
                .as_str()
                .unwrap()
                .contains("not available"),
            "{e}"
        );
    }
    let all = reference(pat.clone(), Value::Null).await;
    let airtable = all.ok()["areas"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["area"] == "airtable")
        .unwrap()
        .clone();
    assert!(airtable.get("available").is_none());
    let list = reference(pat, json!("airtable")).await;
    assert!(list.ok()["endpoints"][0].get("available").is_none());
}

/// What an assistant does is told apart from what the person does themselves: audit entries of
/// actions taken with a connected app or a personal access token name it in `detail.via`.
#[tokio::test]
async fn the_audit_log_names_the_app_or_token_behind_an_action() {
    let app = TestApp::new();
    let admin = app.admin("root@example.com", "Root");
    let (ws, _) = app.workspace_with_base(&admin, "Acme");
    let grant = connect(&app, &admin, "Audited Agent", "manage", None).await;
    let pat = app
        .api_token(
            &admin,
            json!({"name": "ci token", "write": true, "manage": true}),
        )
        .await;
    let invite = |role: &'static str| json!({"role": role});
    let path = format!("/api/workspaces/{ws}/invites");

    // The person, an app connected through OAuth, and a personal access token each invite.
    app.post(&admin, &path, invite("viewer"))
        .await
        .assert_status(201);
    let (t, inner) = mcp_support::api(
        &app,
        &grant.bearer(),
        "POST",
        &path,
        Value::Null,
        invite("commenter"),
    )
    .await;
    t.ok();
    assert_eq!(inner["status"], 201, "{inner}");
    app.post(&pat, &path, invite("editor"))
        .await
        .assert_status(201);
    // An admin endpoint used by the app is audited with the app, too.
    let (t, inner) = mcp_support::api(
        &app,
        &grant.bearer(),
        "GET",
        "/api/admin/stats",
        Value::Null,
        Value::Null,
    )
    .await;
    t.ok();
    assert_eq!(inner["status"], 200, "{inner}");

    let log = app.get(&admin, "/api/admin/audit?limit=100").await;
    log.assert_status(200);
    let entries = log.body["entries"].as_array().unwrap();
    let invites: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "invite_create")
        .collect();
    assert_eq!(invites.len(), 3);
    // Newest first: token, app, person.
    assert_eq!(invites[0]["detail"]["via"]["kind"], "token");
    assert_eq!(invites[0]["detail"]["via"]["token"], "ci token");
    assert!(
        invites[0]["detail"]["via"]["token_id"]
            .as_str()
            .unwrap()
            .starts_with("pat")
    );
    assert_eq!(invites[1]["detail"]["via"]["kind"], "oauth");
    assert_eq!(invites[1]["detail"]["via"]["client"], "Audited Agent");
    assert!(
        invites[1]["detail"]["via"]["client_id"]
            .as_str()
            .unwrap()
            .starts_with("ocl")
    );
    assert!(
        invites[1]["detail"]["via"]["grant_id"]
            .as_str()
            .unwrap()
            .starts_with("grt")
    );
    assert!(
        invites[2]["detail"].get("via").is_none(),
        "the person's own click has no via: {}",
        invites[2]
    );
    // The admin_token_use entry of the app's admin call carries it as well.
    let used = entries
        .iter()
        .find(|e| {
            e["action"] == "admin_token_use" && e["detail"]["request"] == "GET /api/admin/stats"
        })
        .expect("the admin call is audited");
    assert_eq!(used["detail"]["via"]["client"], "Audited Agent");
    // The log never contains a token.
    let text = log.body.to_string();
    assert!(!text.contains(&grant.access) && !text.contains(&grant.refresh));
}
