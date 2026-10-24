//! The MCP transport at `/mcp`: JSON-RPC and protocol-version handling in both protocol eras,
//! authentication (bearer tokens only), Origin validation, limits and tool listing by scope.

mod common;
mod mcp_support;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, TestApp};
use mcp_support::*;
use serde_json::{Value, json};

/// A user with a base, and tokens of each flavour.
struct World {
    app: TestApp,
    owner: Client,
    base: String,
    read: Client,
    write: Client,
    manage: Client,
}

async fn world() -> World {
    world_with(|_| {}).await
}

async fn world_with(f: impl FnOnce(&mut openbase::config::Config)) -> World {
    let app = TestApp::with_config(f);
    let owner = app.user("owner@example.com", "Owner");
    let (_ws, base) = app.workspace_with_base(&owner, "Acme");
    let read = app
        .api_token(&owner, json!({"name": "r", "write": false}))
        .await;
    let write = app
        .api_token(&owner, json!({"name": "w", "write": true}))
        .await;
    let manage = app
        .api_token(&owner, json!({"name": "m", "write": true, "manage": true}))
        .await;
    World {
        app,
        owner,
        base,
        read,
        write,
        manage,
    }
}

// ------------------------------------------------------------------ handshake era

#[tokio::test]
async fn initialize_negotiates_the_protocol_version() {
    let w = world().await;
    for v in ["2025-11-25", "2025-06-18", "2025-03-26"] {
        let res = legacy(
            &w.app,
            &w.write,
            "initialize",
            json!({"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}),
        )
        .await;
        res.assert_status(200);
        assert_eq!(res.body["jsonrpc"], "2.0");
        assert_eq!(res.body["id"], 1);
        let r = &res.body["result"];
        assert_eq!(r["protocolVersion"], v, "a version we speak is echoed");
        assert!(r["capabilities"]["tools"].is_object());
        assert!(r["capabilities"].get("resources").is_none());
        assert_eq!(r["serverInfo"]["name"], "openbase");
        assert!(
            r["instructions"]
                .as_str()
                .unwrap()
                .contains("list_projects"),
            "server instructions guide the model"
        );
        let instructions = r["instructions"].as_str().unwrap();
        assert!(
            instructions.contains("query_view"),
            "they ask for views kept up to date"
        );
        // Claude Code shows the first 2048 characters of a server's instructions.
        assert!(
            instructions.len() <= 2048,
            "instructions are {} characters, over 2048",
            instructions.len()
        );
        assert!(
            res.headers.get("mcp-session-id").is_none(),
            "no sessions are minted"
        );
        assert_eq!(res.headers["cache-control"], "no-store");
        assert_eq!(res.headers["content-type"], "application/json");
    }
    // An unknown (older or newer) version gets our newest handshake revision to accept or leave.
    for v in ["1999-01-01", "2024-11-05", "9999-12-31"] {
        let res = legacy(
            &w.app,
            &w.write,
            "initialize",
            json!({"protocolVersion": v, "capabilities": {}}),
        )
        .await;
        res.assert_status(200);
        assert_eq!(res.body["result"]["protocolVersion"], "2025-11-25", "{v}");
    }
    // A missing version is the client's mistake.
    let res = legacy(&w.app, &w.write, "initialize", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["error"]["code"], -32602);
}

#[tokio::test]
async fn notifications_are_accepted_without_a_body_and_ping_answers() {
    let w = world().await;
    for method in [
        "notifications/initialized",
        "notifications/cancelled",
        "notifications/anything",
    ] {
        let res = w
            .app
            .request_with(
                &w.write,
                "POST",
                "/mcp",
                Some(json!({"jsonrpc": "2.0", "method": method})),
                &[("accept", "application/json, text/event-stream")],
                false,
                None,
            )
            .await;
        res.assert_status(202);
        assert!(res.bytes.is_empty(), "{method}: 202 has no body");
    }
    // A response from the client (to a server request we never send) is ignored.
    let res = w
        .app
        .request_with(
            &w.write,
            "POST",
            "/mcp",
            Some(json!({"jsonrpc": "2.0", "id": 9, "result": {}})),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(202);
    let res = legacy(&w.app, &w.write, "ping", json!({})).await;
    res.assert_status(200);
    assert_eq!(res.body["result"], json!({}));
}

#[tokio::test]
async fn requests_without_a_version_header_are_served_as_the_oldest_revision() {
    let w = world().await;
    let res = w
        .app
        .request_with(
            &w.write,
            "POST",
            "/mcp",
            Some(rpc_message(3, "tools/list", json!({}))),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["id"], 3);
    assert!(res.body["result"]["tools"].as_array().unwrap().len() > 5);
    assert!(res.body["result"].get("resultType").is_none());
}

#[tokio::test]
async fn unsupported_or_misplaced_version_headers_are_400() {
    let w = world().await;
    let call = |version: &'static str, params: Value| {
        let w = &w;
        async move {
            w.app
                .request_with(
                    &w.write,
                    "POST",
                    "/mcp",
                    Some(rpc_message(1, "tools/list", params)),
                    &[("mcp-protocol-version", version)],
                    false,
                    None,
                )
                .await
        }
    };
    let res = call("1999-01-01", json!({})).await;
    res.assert_status(400);
    assert_eq!(res.body["error"]["code"], -32022);
    assert_eq!(res.body["error"]["data"]["requested"], "1999-01-01");
    let supported = res.body["error"]["data"]["supported"].as_array().unwrap();
    assert!(supported.contains(&json!("2026-07-28")) && supported.contains(&json!("2025-11-25")));
    // The stateless revision needs its _meta; the header alone is not enough.
    let res = call("2026-07-28", json!({})).await;
    res.assert_status(400);
    assert_eq!(res.body["error"]["code"], -32020);
}

#[tokio::test]
async fn unknown_methods_are_json_rpc_errors() {
    let w = world().await;
    for method in [
        "resources/list",
        "prompts/list",
        "logging/setLevel",
        "tools/nope",
    ] {
        let res = legacy(&w.app, &w.write, method, json!({})).await;
        res.assert_status(200);
        assert_eq!(res.body["error"]["code"], -32601, "{method}");
        assert_eq!(res.body["id"], 1);
    }
}

// ------------------------------------------------------------- stateless era

#[tokio::test]
async fn server_discover_and_stateless_requests() {
    let w = world().await;
    let res = modern(&w.app, &w.read, "server/discover", json!({})).await;
    res.assert_status(200);
    let r = &res.body["result"];
    assert_eq!(r["resultType"], "complete");
    let versions = r["supportedVersions"].as_array().unwrap();
    assert_eq!(versions[0], "2026-07-28");
    assert!(versions.contains(&json!("2025-11-25")));
    assert!(r["capabilities"]["tools"].is_object());
    assert!(r["instructions"].as_str().unwrap().contains("api_request"));
    assert_eq!(
        r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "openbase"
    );

    let res = modern(&w.app, &w.manage, "tools/list", json!({})).await;
    res.assert_status(200);
    let r = &res.body["result"];
    assert_eq!(r["resultType"], "complete");
    assert_eq!(r["cacheScope"], "private", "the list depends on the token");
    assert!(r["ttlMs"].as_u64().is_some());
    assert!(r["tools"].as_array().unwrap().len() > 10);

    // A tool call carries the tool name in a header, too.
    let res = modern(
        &w.app,
        &w.read,
        "tools/call",
        json!({"name": "list_bases", "arguments": {}}),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["result"]["resultType"], "complete");
    assert_eq!(res.body["result"]["isError"], false);
    assert_eq!(
        res.body["result"]["structuredContent"]["workspaces"][0]["bases"][0]["id"],
        w.base.as_str()
    );

    // Methods the stateless revision does not have answer 404 with the JSON-RPC error.
    let res = modern(&w.app, &w.read, "resources/list", json!({})).await;
    res.assert_status(404);
    assert_eq!(res.body["error"]["code"], -32601);
}

#[tokio::test]
async fn stateless_requests_must_repeat_version_method_and_name_in_headers() {
    let w = world().await;
    let meta = json!({"io.modelcontextprotocol/protocolVersion": "2026-07-28"});
    let send = |method: &'static str, params: Value, headers: Vec<(&'static str, String)>| {
        let w = &w;
        async move {
            let hs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            w.app
                .request_with(
                    &w.write,
                    "POST",
                    "/mcp",
                    Some(rpc_message(7, method, params)),
                    &hs,
                    false,
                    None,
                )
                .await
        }
    };
    let call = json!({"name": "list_bases", "arguments": {}, "_meta": meta});
    let ok_headers = || {
        vec![
            ("mcp-protocol-version", "2026-07-28".to_string()),
            ("mcp-method", "tools/call".to_string()),
            ("mcp-name", "list_bases".to_string()),
        ]
    };
    send("tools/call", call.clone(), ok_headers())
        .await
        .assert_status(200);

    // Each missing or wrong header is a 400 HeaderMismatch.
    let without = |drop: &str| -> Vec<(&'static str, String)> {
        ok_headers()
            .into_iter()
            .filter(|(k, _)| *k != drop)
            .collect()
    };
    for drop in ["mcp-protocol-version", "mcp-method", "mcp-name"] {
        let res = send("tools/call", call.clone(), without(drop)).await;
        res.assert_status(400);
        assert_eq!(res.body["error"]["code"], -32020, "missing {drop}");
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Header mismatch")
        );
    }
    for (name, value) in [
        ("mcp-protocol-version", "2025-11-25"),
        ("mcp-method", "tools/list"),
        ("mcp-name", "get_record"),
    ] {
        let mut hs = without(name);
        hs.push((name, value.to_string()));
        let res = send("tools/call", call.clone(), hs).await;
        res.assert_status(400);
        assert_eq!(res.body["error"]["code"], -32020, "wrong {name}");
    }
    // A name that cannot be a plain header value travels base64-encoded (and is compared decoded).
    let mut hs = without("mcp-name");
    hs.push(("mcp-name", "=?base64?bGlzdF9iYXNlcw==?=".to_string()));
    send("tools/call", call.clone(), hs)
        .await
        .assert_status(200);

    // An unsupported version in _meta lists what is supported.
    let bad_meta = json!({"io.modelcontextprotocol/protocolVersion": "1900-01-01"});
    let res = send(
        "tools/list",
        json!({"_meta": bad_meta}),
        vec![
            ("mcp-protocol-version", "1900-01-01".to_string()),
            ("mcp-method", "tools/list".to_string()),
        ],
    )
    .await;
    res.assert_status(400);
    assert_eq!(res.body["error"]["code"], -32022);
    assert_eq!(res.body["error"]["data"]["requested"], "1900-01-01");
}

// ----------------------------------------------------------- malformed messages

async fn raw_post(
    w: &World,
    token: &Client,
    content_type: &str,
    accept: Option<&str>,
    body: Vec<u8>,
) -> common::Response {
    let mut req = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", token.bearer.as_ref().unwrap()),
        );
    if let Some(a) = accept {
        req = req.header(header::ACCEPT, a);
    }
    w.app.send(req.body(Body::from(body)).unwrap()).await
}

#[tokio::test]
async fn malformed_json_rpc_is_rejected_with_json_rpc_errors() {
    let w = world().await;
    let cases: Vec<(&str, Vec<u8>, u16, i64)> = vec![
        ("not json", b"{nope".to_vec(), 400, -32700),
        ("empty body", Vec::new(), 400, -32700),
        (
            "batch",
            br#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#.to_vec(),
            400,
            -32600,
        ),
        ("scalar", b"42".to_vec(), 400, -32600),
        (
            "no jsonrpc",
            br#"{"id":1,"method":"ping"}"#.to_vec(),
            400,
            -32600,
        ),
        (
            "wrong version",
            br#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#.to_vec(),
            400,
            -32600,
        ),
        (
            "no method",
            br#"{"jsonrpc":"2.0","id":1}"#.to_vec(),
            400,
            -32600,
        ),
        (
            "numeric method",
            br#"{"jsonrpc":"2.0","id":1,"method":5}"#.to_vec(),
            400,
            -32600,
        ),
        (
            "object id",
            br#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#.to_vec(),
            400,
            -32600,
        ),
        (
            "array params",
            br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":[1]}"#.to_vec(),
            400,
            -32602,
        ),
    ];
    for (what, body, status, code) in cases {
        let res = raw_post(&w, &w.write, "application/json", None, body).await;
        assert_eq!(res.status.as_u16(), status, "{what}: {}", res.body);
        assert_eq!(res.body["error"]["code"], code, "{what}");
        assert_eq!(res.body["jsonrpc"], "2.0");
        assert!(
            res.body["error"]["message"]
                .as_str()
                .is_some_and(|m| !m.is_empty())
        );
    }
    // String ids are echoed as they are.
    let res = raw_post(
        &w,
        &w.write,
        "application/json; charset=utf-8",
        Some("application/json"),
        br#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#.to_vec(),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["id"], "abc");

    // Bad tool-call parameters are protocol errors (-32602), not tool errors.
    for params in [
        json!({}),
        json!({"name": 5}),
        json!({"name": "list_bases", "arguments": [1]}),
    ] {
        let res = legacy(&w.app, &w.write, "tools/call", params).await;
        res.assert_status(200);
        assert_eq!(res.body["error"]["code"], -32602);
    }
    let res = legacy(
        &w.app,
        &w.write,
        "tools/call",
        json!({"name": "no_such_tool"}),
    )
    .await;
    assert_eq!(res.body["error"]["code"], -32602);
    assert_eq!(res.body["error"]["message"], "Unknown tool: no_such_tool");
}

#[tokio::test]
async fn content_type_accept_and_size_are_enforced() {
    let w = world().await;
    let body = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_vec();
    raw_post(&w, &w.write, "text/plain", None, body.clone())
        .await
        .assert_status(415);
    raw_post(
        &w,
        &w.write,
        "application/json",
        Some("text/event-stream"),
        body.clone(),
    )
    .await
    .assert_status(406);
    raw_post(&w, &w.write, "application/json", Some("*/*"), body.clone())
        .await
        .assert_status(200);
    // 8 MiB is the limit.
    let big = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"pad":"{}"}}}}"#,
        "x".repeat(openbase::mcp::MAX_BODY_BYTES)
    );
    let res = raw_post(&w, &w.write, "application/json", None, big.into_bytes()).await;
    res.assert_status(413);
    assert_eq!(res.body["error"]["code"], -32000);
}

#[tokio::test]
async fn get_and_delete_are_405_because_there_is_no_stream_and_no_session() {
    let w = world().await;
    for method in ["GET", "DELETE"] {
        let res = w.app.request(&w.write, method, "/mcp", None).await;
        res.assert_status(405);
        assert_eq!(res.headers["allow"], "POST");
        assert_eq!(res.body["error"]["code"], -32600);
    }
    // Even anonymous callers learn nothing but the method rule.
    w.app.get(&w.app.anon(), "/mcp").await.assert_status(405);
}

// ---------------------------------------------------------------- authentication

#[tokio::test]
async fn only_bearer_tokens_authenticate() {
    let w = world().await;
    let body = rpc_message(1, "tools/list", json!({}));
    let post = |c: Client, headers: Vec<(&'static str, &'static str)>| {
        let (w, body) = (&w, body.clone());
        async move {
            w.app
                .request_with(&c, "POST", "/mcp", Some(body), &headers, false, None)
                .await
        }
    };
    // No credentials.
    let res = post(w.app.anon(), vec![]).await;
    res.assert_status(401);
    assert_eq!(
        res.headers["www-authenticate"],
        "Bearer realm=\"OpenBase MCP\", scope=\"openbase:read openbase:write\", resource_metadata=\"http://localhost:8080/.well-known/oauth-protected-resource/mcp\""
    );
    // A signed-in session cookie is refused, with or without the CSRF header, and says why.
    for csrf in [false, true] {
        let res = w
            .app
            .request_with(
                &w.owner,
                "POST",
                "/mcp",
                Some(body.clone()),
                &[],
                csrf,
                None,
            )
            .await;
        res.assert_status(401);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("session cookies are not accepted"),
            "{}",
            res.body
        );
        assert!(res.headers.contains_key("www-authenticate"));
    }
    // A bad token, an expired one and a non-bearer scheme.
    let res = post(common::TestApp::bearer("pat_does_not_exist"), vec![]).await;
    res.assert_status(401);
    assert!(
        res.headers["www-authenticate"]
            .to_str()
            .unwrap()
            .contains("invalid_token")
    );
    let res = post(w.app.anon(), vec![("authorization", "Basic dXNlcjpwdw==")]).await;
    res.assert_status(401);
    w.app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.execute("UPDATE api_tokens SET expires_at = 1 WHERE name = 'r'", [])?)
        })
        .unwrap();
    post(w.read.clone(), vec![]).await.assert_status(401);
    // A valid cookie does not rescue an invalid token, and a valid token ignores the cookie.
    let mixed = Client {
        cookie: w.owner.cookie.clone(),
        bearer: Some("pat_nope".into()),
        user_id: w.owner.user_id.clone(),
    };
    post(mixed, vec![]).await.assert_status(401);
    let mixed = Client {
        cookie: Some("garbage".into()),
        bearer: w.write.bearer.clone(),
        user_id: w.owner.user_id.clone(),
    };
    post(mixed, vec![]).await.assert_status(200);
    // A deactivated user's token stops working.
    w.app
        .state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE users SET is_active = 0", [])?))
        .unwrap();
    post(w.write.clone(), vec![]).await.assert_status(401);
}

#[tokio::test]
async fn using_the_endpoint_stamps_the_token() {
    let w = world().await;
    let used = || {
        w.app.query_i64(
            "SELECT count(*) FROM api_tokens WHERE last_used_at IS NOT NULL AND name = 'w'",
            &[],
        )
    };
    assert_eq!(used(), 0);
    legacy(&w.app, &w.write, "ping", json!({}))
        .await
        .assert_status(200);
    assert_eq!(used(), 1);
}

// ---------------------------------------------------------------------- Origin

#[tokio::test]
async fn browser_origins_other_than_the_public_url_are_refused() {
    let w = world_with(|c| {
        c.public_url = "https://base.example.com".into();
        c.mcp_allowed_origins = vec!["https://inspector.example.org/".into()];
    })
    .await;
    let with_origin = |origin: &'static str| {
        let w = &w;
        async move {
            w.app
                .request_with(
                    &w.write,
                    "POST",
                    "/mcp",
                    Some(rpc_message(1, "ping", json!({}))),
                    &[("origin", origin)],
                    false,
                    None,
                )
                .await
        }
    };
    // No Origin header (every non-browser client): fine.
    legacy(&w.app, &w.write, "ping", json!({}))
        .await
        .assert_status(200);
    for ok in [
        "https://base.example.com",
        "https://BASE.example.com",
        "https://base.example.com/",
        "https://inspector.example.org",
    ] {
        with_origin(ok).await.assert_status(200);
    }
    for bad in [
        "https://evil.example.com",
        "http://base.example.com",
        "https://base.example.com:8443",
        "https://base.example.com.evil.com",
        "null",
        "http://localhost:8080",
        "",
    ] {
        let res = with_origin(bad).await;
        assert_eq!(res.status.as_u16(), 403, "origin {bad:?}");
        assert_eq!(res.body["jsonrpc"], "2.0");
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Origin")
        );
    }
    // The check comes before authentication: a bad Origin never learns whether a token is valid.
    let res = w
        .app
        .request_with(
            &common::TestApp::bearer("pat_nope"),
            "POST",
            "/mcp",
            Some(rpc_message(1, "ping", json!({}))),
            &[("origin", "https://evil.example.com")],
            false,
            None,
        )
        .await;
    res.assert_status(403);
}

// ------------------------------------------------------------------ rate limits

#[tokio::test]
async fn requests_are_rate_limited_per_token_and_per_user() {
    let w = world_with(|c| {
        c.mcp_rate_per_token = 3;
        c.mcp_rate_per_user = 100;
    })
    .await;
    let mut statuses = Vec::new();
    for _ in 0..30 {
        statuses.push(legacy(&w.app, &w.write, "ping", json!({})).await);
    }
    assert_eq!(statuses[0].status, 200);
    let limited = statuses
        .iter()
        .find(|r| r.status == 429)
        .expect("the limit is hit");
    assert_eq!(limited.headers["retry-after"], "1");
    assert_eq!(limited.body["error"]["code"], -32000);
    // The limit is per token: another token of the same user has its own budget.
    legacy(&w.app, &w.read, "ping", json!({}))
        .await
        .assert_status(200);

    let w = world_with(|c| {
        c.mcp_rate_per_token = 100;
        c.mcp_rate_per_user = 4;
    })
    .await;
    let mut hit = false;
    for i in 0..30 {
        let token = if i % 2 == 0 { &w.write } else { &w.read };
        hit |= legacy(&w.app, token, "ping", json!({})).await.status == 429;
    }
    assert!(hit, "all tokens of a user share the per-user budget");
    // Garbage tokens cost nothing and are never rate-limited into a different answer.
    for _ in 0..10 {
        legacy(
            &w.app,
            &common::TestApp::bearer("pat_nope"),
            "ping",
            json!({}),
        )
        .await
        .assert_status(401);
    }
}

// ----------------------------------------------------------------- tool listing

#[tokio::test]
async fn tools_listed_depend_on_the_token() {
    let w = world().await;
    let read = tool_names(&w.app, &w.read).await;
    let write = tool_names(&w.app, &w.write).await;
    let manage = tool_names(&w.app, &w.manage).await;

    let read_tools = [
        "list_projects",
        "get_project_schema",
        "list_records",
        "search_records",
        "search_everything",
        "aggregate_records",
        "get_record",
        "list_comments",
        "api_reference",
        "api_request",
        "list_workspaces",
        "list_collaborators",
        "field_types",
        "list_icons",
        "get_view",
        "query_view",
        "list_trash",
        "get_record_history",
        "list_activity",
        "list_notifications",
        "list_share_links",
        "list_automations",
        "get_automation",
        "list_automation_runs",
        "export_csv",
        "list_inbox",
    ];
    let write_tools = [
        "create_records",
        "update_records",
        "delete_records",
        "move_records",
        "duplicate_records",
        "add_comment",
        "create_project",
        "rename_project",
        "create_table",
        "rename_table",
        "reorder_workspaces",
        "reorder_projects",
        "reorder_tables",
        "reorder_views",
        "duplicate_table",
        "delete_table",
        "create_field",
        "update_field",
        "delete_field",
        "set_primary_field",
        "check_formula",
        "create_view",
        "update_view",
        "delete_view",
        "restore_from_trash",
        "mark_notifications_read",
        "create_share_link",
        "update_share_link",
        "delete_share_link",
        "create_automation",
        "update_automation",
        "delete_automation",
        "test_automation",
        "upload_attachment",
        "import_csv",
        "add_to_inbox",
        "update_inbox_item",
        "file_inbox_item",
        "delete_inbox_item",
    ];
    let manage_tools = [
        "create_workspace",
        "list_members",
        "set_member_role",
        "create_invite",
        "rename_workspace",
        "delete_workspace",
        "remove_member",
        "list_invites",
        "revoke_invite",
        "duplicate_project",
        "delete_project",
    ];
    let sorted = |v: &[String]| {
        let mut v = v.to_vec();
        v.sort();
        v
    };
    let set = |names: &[&str]| sorted(&names.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(sorted(&read), set(&read_tools), "read-only: reads only");
    assert_eq!(
        sorted(&write),
        set(&[&read_tools[..], &write_tools[..]].concat()),
        "write adds the write tools"
    );
    assert_eq!(
        sorted(&manage),
        set(&[&read_tools[..], &write_tools[..], &manage_tools[..]].concat()),
        "manage adds the manage tools"
    );
    // The order is the same for everyone (a token sees a subsequence of the full list), so
    // clients can cache it.
    let in_order = |full: &[String], part: &[String]| {
        full.iter()
            .filter(|n| part.contains(n))
            .cloned()
            .collect::<Vec<_>>()
            == part
    };
    assert!(in_order(&manage, &write) && in_order(&write, &read));
    assert_eq!(
        tool_names(&w.app, &w.manage).await,
        manage,
        "stable across calls"
    );

    // Base-limited tokens see the same tools as their level.
    let limited = w
        .app
        .api_token(
            &w.owner,
            json!({"name": "l", "write": true, "manage": true, "base_ids": [w.base]}),
        )
        .await;
    assert_eq!(tool_names(&w.app, &limited).await, manage);
    // `manage` without `write` (a shape the API refuses to create) offers nothing extra.
    let odd = w.app.raw_token(
        &w.owner,
        json!({"write": false, "manage": true, "base_ids": null}),
    );
    assert_eq!(tool_names(&w.app, &odd).await, read);

    // Tool definitions carry what a model needs.
    let res = legacy(&w.app, &w.manage, "tools/list", json!({})).await;
    for t in res.body["result"]["tools"].as_array().unwrap() {
        let name = t["name"].as_str().unwrap();
        assert!(t["description"].as_str().unwrap().len() > 30, "{name}");
        assert_eq!(t["inputSchema"]["type"], "object", "{name}");
        assert_eq!(t["inputSchema"]["additionalProperties"], false, "{name}");
        assert!(t["annotations"]["readOnlyHint"].is_boolean(), "{name}");
        for (prop, spec) in t["inputSchema"]["properties"].as_object().unwrap() {
            assert!(
                spec["description"].is_string(),
                "{name}.{prop} needs a description"
            );
        }
    }
    let destructive: Vec<&str> = res.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["annotations"]["destructiveHint"] == true)
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(destructive.contains(&"delete_records") && destructive.contains(&"api_request"));
}

#[tokio::test]
async fn pagination_cursors_work_and_bad_ones_are_rejected() {
    let w = world().await;
    let res = legacy(&w.app, &w.write, "tools/list", json!({"cursor": "!!!"})).await;
    assert_eq!(res.body["error"]["code"], -32602);
    // The page holds every tool, so there is no next cursor.
    let res = legacy(&w.app, &w.write, "tools/list", json!({})).await;
    assert!(res.body["result"].get("nextCursor").is_none());
}

#[tokio::test]
async fn a_tool_the_token_may_not_use_is_a_helpful_tool_error() {
    let w = world().await;
    let t = tool(
        &w.app,
        &w.read,
        "create_records",
        json!({"base_id": w.base, "table": "x", "records": [{"fields": {}}]}),
    )
    .await;
    assert!(t.err().contains("write access"), "{}", t.text);
    let t = tool(
        &w.app,
        &w.write,
        "create_workspace",
        json!({"name": "Nope"}),
    )
    .await;
    assert!(t.err().contains("'manage' permission"), "{}", t.text);
    assert_eq!(
        w.app
            .query_i64("SELECT count(*) FROM workspaces WHERE name = 'Nope'", &[]),
        0
    );
}

#[tokio::test]
async fn json_rpc_ids_and_results_survive_odd_values() {
    let w = world().await;
    let res = w
        .app
        .request_with(
            &w.write,
            "POST",
            "/mcp",
            Some(json!({"jsonrpc": "2.0", "id": 18446744073709551615u64, "method": "ping"})),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["id"].as_u64(), Some(u64::MAX));
}
