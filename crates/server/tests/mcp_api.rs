//! `api_reference` and `api_request`: the full-parity escape hatch of the MCP server. Requests
//! run through the real router with the caller's token, so everything below is the web UI's own
//! behaviour reached through a tool call, plus the refusals that keep agents away from
//! credentials, and the scope rules that hide other bases.

mod automations_support;
mod common;
mod mcp_support;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod sse_support;

use base64::Engine;
use common::Client;
use mcp_support::*;
use ob_core::api::events::BaseEvent;
use openbase::mcp::catalogue::{Access, ENDPOINTS};
use query_support::*;
use serde_json::{Value, json};

struct Rig {
    p: People,
    read: Client,
    write: Client,
    manage: Client,
}

async fn rig() -> Rig {
    let p = people().await;
    let owner = p.f.owner.clone();
    let read =
        p.f.app
            .api_token(&owner, json!({"name": "r", "write": false}))
            .await;
    let write =
        p.f.app
            .api_token(&owner, json!({"name": "w", "write": true}))
            .await;
    let manage =
        p.f.app
            .api_token(&owner, json!({"name": "m", "write": true, "manage": true}))
            .await;
    Rig {
        p,
        read,
        write,
        manage,
    }
}

impl Rig {
    fn app(&self) -> &common::TestApp {
        &self.p.f.app
    }
    fn base(&self) -> &str {
        &self.p.f.base_id
    }
    fn table(&self) -> &str {
        &self.p.f.table_id
    }
}

// ------------------------------------------------------------------ api_reference

#[tokio::test]
async fn api_reference_lists_areas_then_endpoints_in_detail() {
    let r = rig().await;
    let t = tool(r.app(), &r.read, "api_reference", json!({})).await;
    let v = t.ok();
    let areas: Vec<&str> = v["areas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["area"].as_str().unwrap())
        .collect();
    for expected in [
        "workspaces",
        "bases",
        "records",
        "csv",
        "automations",
        "admin",
        "airtable",
    ] {
        assert!(areas.contains(&expected), "{expected} in {areas:?}");
    }
    assert!(v["usage"].as_str().unwrap().contains("api_request"));
    assert!(
        t.text.len() < 5_000,
        "the overview stays small ({} bytes)",
        t.text.len()
    );

    let t = tool(
        r.app(),
        &r.read,
        "api_reference",
        json!({"area": "Records"}),
    )
    .await;
    let list = t.ok()["endpoints"].as_array().unwrap().clone();
    let query = list
        .iter()
        .find(|e| e["path"] == "/api/views/{id}/query")
        .unwrap();
    assert_eq!(query["method"], "POST");
    assert_eq!(query["min_role"], "viewer");
    assert_eq!(query["token_capability"], "read");
    assert!(query["request"].as_str().unwrap().contains("limit"));
    assert!(query["response"].as_str().unwrap().contains("records"));
    let create = list
        .iter()
        .find(|e| e["method"] == "POST" && e["path"] == "/api/tables/{id}/records")
        .unwrap();
    assert_eq!(create["token_capability"], "write");
    assert_eq!(create["min_role"], "editor");

    let t = tool(
        r.app(),
        &r.read,
        "api_reference",
        json!({"area": "workspaces"}),
    )
    .await;
    let caps: Vec<&str> = t.ok()["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["token_capability"].as_str().unwrap())
        .collect();
    assert!(caps.iter().any(|c| c.starts_with("manage")), "{caps:?}");

    let t = tool(
        r.app(),
        &r.read,
        "api_reference",
        json!({"area": "nonsense"}),
    )
    .await;
    assert!(t.err().contains("Areas:") && t.err().contains("records"));
}

#[tokio::test]
async fn every_catalogued_endpoint_is_served_by_the_router() {
    // A fake id never creates, changes or deletes anything; what matters is that the method and
    // path pair exists (the router answers 405 for a registered path with another method).
    let r = rig().await;
    let admin = r.p.f.app.admin("root@example.com", "Root");
    let admin_token = r
        .app()
        .api_token(&admin, json!({"name": "a", "write": true, "manage": true}))
        .await;
    let mut checked = 0;
    for ep in ENDPOINTS {
        if ep.access.blocked_for_agents() {
            continue;
        }
        let path = ep
            .path
            .replace("{id}", "idX")
            .replace("{user_id}", "usrX")
            .replace("{rid}", "recX")
            .replace("{token}", "tokX")
            .replace("{name}", "nameX")
            .replace("{filename}", "f.txt")
            .replace("{base_id}", "appX")
            .replace("{table}", "tblX")
            .replace("{record_id}", "recX");
        assert!(!path.contains('{'), "{path}");
        let token = if ep.access == Access::Admin {
            &admin_token
        } else {
            &r.manage
        };
        let t = tool(
            r.app(),
            token,
            "api_request",
            json!({"method": ep.method, "path": path}),
        )
        .await;
        let status = t.structured["status"].as_u64().unwrap_or(0);
        assert!(
            status != 405,
            "{} {}: the router has no such route ({})",
            ep.method,
            ep.path,
            t.text
        );
        assert!(status != 500, "{} {} -> 500 {}", ep.method, ep.path, t.text);
        assert!(status != 401, "{} {} -> 401", ep.method, ep.path);
        checked += 1;
    }
    assert!(checked > 90, "only {checked} endpoints were exercised");
}

// ----------------------------------------------------------------------- api_request

#[tokio::test]
async fn api_request_runs_gets_posts_patches_and_deletes_like_the_web_app() {
    let r = rig().await;
    let app = r.app();
    let mut rx = app.state.events.subscribe(r.base());

    // GET
    let (t, res) = api(
        app,
        &r.write,
        "GET",
        &format!("/api/bases/{}", r.base()),
        Value::Null,
        Value::Null,
    )
    .await;
    t.ok();
    assert_eq!(res["status"], 200);
    assert_eq!(res["ok"], true);
    assert_eq!(res["content_type"], "application/json");
    assert_eq!(res["body"]["tables"][0]["name"], "Table 1");
    assert_eq!(res["body"]["role"], "owner");

    // POST creates a table (201), PATCH renames it, a field and records follow.
    let (t, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/bases/{}/tables", r.base()),
        Value::Null,
        json!({"name": "Via MCP"}),
    )
    .await;
    t.ok();
    assert_eq!(res["status"], 201);
    let table = res["body"]["id"].as_str().unwrap().to_string();
    let (_, res) = api(
        app,
        &r.write,
        "PATCH",
        &format!("/api/tables/{table}"),
        Value::Null,
        json!({"name": "Renamed by agent"}),
    )
    .await;
    assert_eq!(res["status"], 200);
    assert_eq!(res["body"]["name"], "Renamed by agent");
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/tables/{table}/fields"),
        Value::Null,
        json!({"name": "Qty", "type": "number", "options": {}}),
    )
    .await;
    assert_eq!(res["status"], 201, "{res}");
    let qty = res["body"]["id"].as_str().unwrap().to_string();
    let primary = r.p.f.table(&table).await["primary_field_id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/tables/{table}/records"),
        Value::Null,
        json!({"records": [{"values": {&primary: "Widget", &qty: 3}}, {"values": {&primary: "Gadget", &qty: 5}}]}),
    )
    .await;
    assert_eq!(res["status"], 201, "{res}");
    let rec = res["body"]["records"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let rec2 = res["body"]["records"][1]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Query parameters become the query string.
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        &format!("/api/records/{rec}/history"),
        json!({"limit": 1}),
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 200);
    assert_eq!(res["body"].as_array().unwrap().len(), 1);
    // A POST that only reads works even for the read-only token.
    let view = r.p.f.table(&table).await["views"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, res) = api(
        app,
        &r.read,
        "POST",
        &format!("/api/views/{view}/query"),
        Value::Null,
        json!({"limit": 1}),
    )
    .await;
    assert_eq!(res["status"], 200);
    assert_eq!(res["body"]["total"], 2);
    assert_eq!(res["body"]["records"].as_array().unwrap().len(), 1);

    // DELETE with a body, answered 204: no body in the result, still ok.
    let (t, res) = api(
        app,
        &r.write,
        "DELETE",
        &format!("/api/tables/{table}/records"),
        Value::Null,
        json!({"ids": [rec2]}),
    )
    .await;
    t.ok();
    assert_eq!(res["status"], 204);
    assert_eq!(res["ok"], true);
    assert!(res.get("body").is_none());
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        &format!("/api/tables/{table}/records/{rec2}"),
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 404, "deleted records are gone for readers");
    // DELETE of the table, then it is gone from the schema.
    let (_, res) = api(
        app,
        &r.write,
        "DELETE",
        &format!("/api/tables/{table}"),
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 200);
    assert_eq!(res["body"], json!({"ok": true}));
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        &format!("/api/bases/{}", r.base()),
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["body"]["tables"].as_array().unwrap().len(), 1);

    // Live updates reached subscribers, attributed to the token's user.
    let mut kinds = Vec::new();
    while let Ok(env) = rx.try_recv() {
        assert_eq!(env.user_id.as_deref(), r.p.f.owner.user_id.as_deref());
        kinds.push(match &env.event {
            BaseEvent::RecordsChanged { .. } => "records",
            BaseEvent::SchemaChanged { .. } => "schema",
            _ => "other",
        });
    }
    assert!(
        kinds.contains(&"records") && kinds.contains(&"schema"),
        "{kinds:?}"
    );
    // History names the token's user.
    let hist = r.p.f.history(&rec);
    assert_eq!(hist[0].2, r.p.f.owner.user_id);
}

#[tokio::test]
async fn api_request_reaches_the_airtable_api_with_all_its_methods() {
    let r = rig().await;
    let app = r.app();
    let rec = r.p.ids[3].clone();
    let base = format!("/api/v1/{}/Table%201", r.base());
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        "/api/v1/meta/bases",
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["body"]["bases"][0]["id"], r.base());
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &base,
        Value::Null,
        json!({"fields": {"Name": "Frank"}}),
    )
    .await;
    assert_eq!(res["status"], 200, "{res}");
    let id = res["body"]["id"].as_str().unwrap().to_string();
    let (_, res) = api(
        app,
        &r.write,
        "PATCH",
        &format!("{base}/{id}"),
        Value::Null,
        json!({"fields": {"Age": 44}}),
    )
    .await;
    assert_eq!(res["body"]["fields"]["Age"], 44);
    let (_, res) = api(
        app,
        &r.write,
        "PUT",
        &format!("{base}/{id}"),
        Value::Null,
        json!({"fields": {"Name": "Frank II"}}),
    )
    .await;
    assert_eq!(
        res["body"]["fields"],
        json!({"Name": "Frank II"}),
        "PUT replaced the record"
    );
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        &base,
        json!({"filterByFormula": "{Name}='dave'", "fields": ["Name"]}),
        Value::Null,
    )
    .await;
    assert_eq!(res["body"]["records"][0]["id"], rec.as_str());
    let (_, res) = api(
        app,
        &r.write,
        "DELETE",
        &format!("{base}/{id}"),
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["body"], json!({"id": id, "deleted": true}));
}

#[tokio::test]
async fn api_request_imports_csv_through_multipart() {
    let r = rig().await;
    let app = r.app();
    // Into an existing table (columns matched by name).
    let (t, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/tables/{}/import", r.table()),
        Value::Null,
        json!({"multipart": {"file": {"filename": "more.csv", "text": "Name,Age\nZoe,22\nYuri,33\n", "content_type": "text/csv"}}}),
    )
    .await;
    t.ok();
    assert_eq!(res["status"], 200, "{res}");
    assert_eq!(res["body"]["created"], 2);
    let t = tool(
        app,
        &r.write,
        "search_records",
        json!({"base_id": r.base(), "table": "Table 1", "query": "Yuri"}),
    )
    .await;
    assert_eq!(t.ok()["records"][0]["fields"]["Age"], 33);

    // As a new table, with the other multipart fields.
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/bases/{}/import", r.base()),
        Value::Null,
        json!({"multipart": {
            "file": {"filename": "x.csv", "text": "City;Pop\nOslo;700000\nBergen;285000\n"},
            "name": "Cities",
            "has_header": true,
        }}),
    )
    .await;
    assert_eq!(res["status"], 201, "{res}");
    assert_eq!(res["body"]["created"], 2);
    let t = tool(
        app,
        &r.write,
        "list_records",
        json!({"base_id": r.base(), "table": "Cities"}),
    )
    .await;
    assert_eq!(t.ok()["count"], 2);

    // Errors come back as errors, and a bad multipart spec is explained before anything is sent.
    let (t, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/tables/{}/import", r.table()),
        Value::Null,
        json!({"multipart": {"name": "no file"}}),
    )
    .await;
    assert!(t.is_error, "{res}");
    let t = tool(
        app,
        &r.write,
        "api_request",
        json!({"method": "POST", "path": format!("/api/tables/{}/import", r.table()),
               "body": {"multipart": {"file": {"filename": "a.csv"}}}}),
    )
    .await;
    assert!(t.err().contains("content_base64"), "{}", t.text);
    // The read-only token cannot import.
    let (t, res) = api(
        app,
        &r.read,
        "POST",
        &format!("/api/tables/{}/import", r.table()),
        Value::Null,
        json!({"multipart": {"file": {"filename": "a.csv", "text": "Name\nX\n"}}}),
    )
    .await;
    assert!(t.is_error);
    assert_eq!(res["status"], 403);
}

#[tokio::test]
async fn api_request_uploads_downloads_and_attaches_files() {
    let r = rig().await;
    let app = r.app();
    let f = &r.p.f;
    let files = f
        .add_field(
            r.table(),
            json!({"name": "Files", "type": "attachment", "options": {}}),
        )
        .await;
    assert_eq!(files["name"], "Files");
    let bytes: Vec<u8> = (0..=255u8).collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let (t, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/bases/{}/attachments", r.base()),
        Value::Null,
        json!({"multipart": {"file": {"filename": "bytes.bin", "content_base64": b64, "content_type": "application/octet-stream"}}}),
    )
    .await;
    t.ok();
    assert_eq!(res["status"], 200, "{res}");
    let att = res["body"]["id"].as_str().unwrap().to_string();
    assert_eq!(res["body"]["size"], 256);

    // Attach it with the curated tool, then download it with the escape hatch.
    let t = tool(
        app,
        &r.write,
        "update_records",
        json!({"base_id": r.base(), "table": "Table 1", "records": [{"id": r.p.ids[0], "fields": {"Files": [{"id": att}]}}]}),
    )
    .await;
    let attached = &t.ok()["updated"][0]["fields"]["Files"][0];
    assert_eq!(attached["filename"], "bytes.bin");
    let (_, res) = api(
        app,
        &r.read,
        "GET",
        &format!("/api/attachments/{att}/bytes.bin"),
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 200, "{res}");
    let got = base64::engine::general_purpose::STANDARD
        .decode(res["body_base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        got, bytes,
        "binary downloads come back base64-encoded, byte for byte"
    );

    // Large files are described, not returned.
    let big = base64::engine::general_purpose::STANDARD.encode(vec![7u8; 200_000]);
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/bases/{}/attachments", r.base()),
        Value::Null,
        json!({"multipart": {"file": {"filename": "big.bin", "content_base64": big}}}),
    )
    .await;
    let big_id = res["body"]["id"].as_str().unwrap().to_string();
    let (t, res) = api(
        app,
        &r.read,
        "GET",
        &format!("/api/attachments/{big_id}/big.bin"),
        Value::Null,
        Value::Null,
    )
    .await;
    t.ok();
    assert!(res.get("body_base64").is_none());
    assert_eq!(res["truncated"], true);
    assert!(
        res["note"]
            .as_str()
            .unwrap()
            .contains("not returned through MCP")
    );
}

// ------------------------------------------------------------------ refusals

#[tokio::test]
async fn api_request_refuses_paths_agents_must_not_call() {
    let r = rig().await;
    let app = r.app();
    let tokens_before = app.query_i64("SELECT count(*) FROM api_tokens", &[]);
    let sessions_before = app.query_i64("SELECT count(*) FROM sessions", &[]);
    for (method, path, expect) in [
        // No recursion into /mcp, no escapes out of /api.
        ("POST", "/mcp", "must start with /api/"),
        ("POST", "/api/../mcp", "path segments"),
        ("POST", "/api/%2e%2e/mcp", "path segments"),
        ("GET", "/", "must start with /api/"),
        ("GET", "/assets/index.js", "must start with /api/"),
        ("GET", "api/health", "must start with /api/"),
        ("GET", "/api/bases/x?y=1", "query"),
        ("GET", "/api//bases", "empty segment"),
        // Credentials, sessions and tokens.
        ("POST", "/api/auth/password", "not available through MCP"),
        ("POST", "/api/auth/2fa/setup", "not available through MCP"),
        ("POST", "/api/auth/2fa/disable", "not available through MCP"),
        ("GET", "/api/auth/passkeys", "not available through MCP"),
        (
            "POST",
            "/api/auth/passkeys/register/start",
            "not available through MCP",
        ),
        (
            "PATCH",
            "/api/auth/passkeys/pkyX",
            "not available through MCP",
        ),
        (
            "DELETE",
            "/api/auth/passkeys/pkyX",
            "not available through MCP",
        ),
        (
            "DELETE",
            "/api/admin/users/usrX/passkeys",
            "not available through MCP",
        ),
        (
            "POST",
            "/api/auth/passkey-login/finish",
            "not available through MCP",
        ),
        ("GET", "/api/auth/sessions", "not available through MCP"),
        (
            "POST",
            "/api/auth/sessions/revoke-others",
            "not available through MCP",
        ),
        (
            "DELETE",
            "/api/auth/sessions/abc",
            "not available through MCP",
        ),
        ("GET", "/api/tokens", "not available through MCP"),
        ("POST", "/api/tokens", "not available through MCP"),
        ("DELETE", "/api/tokens/patX", "not available through MCP"),
        // Sign-in flows and the endless event stream.
        ("POST", "/api/auth/login", "not available through MCP"),
        ("POST", "/api/auth/signup", "not available through MCP"),
        (
            "POST",
            "/api/auth/password-reset/request",
            "not available through MCP",
        ),
        ("GET", "/api/bases/appX/events", "never ends"),
    ] {
        let t = tool(
            app,
            &r.manage,
            "api_request",
            json!({"method": method, "path": path, "body": if method == "POST" { json!({}) } else { Value::Null }}),
        )
        .await;
        let msg = t.err();
        assert!(msg.contains(expect), "{method} {path}: {msg}");
    }
    // Argument mistakes.
    for (args, expect) in [
        (
            json!({"method": "TRACE", "path": "/api/health"}),
            "method must be one of",
        ),
        (
            json!({"method": "GET", "path": "/api/health", "body": {"x": 1}}),
            "cannot have a body",
        ),
        (
            json!({"method": "GET", "path": "/api/health", "query": {"a": {"b": 1}}}),
            "query parameter",
        ),
        (
            json!({"method": "GET", "path": "/api/health", "query": "x=1"}),
            "must be an object",
        ),
        (json!({"method": "GET"}), "missing field `path`"),
        (
            json!({"method": "GET", "path": "/api/health", "extra": 1}),
            "unknown field",
        ),
    ] {
        let t = tool(app, &r.manage, "api_request", args).await;
        assert!(t.err().contains(expect), "{}", t.text);
    }
    assert_eq!(
        app.query_i64("SELECT count(*) FROM api_tokens", &[]),
        tokens_before
    );
    assert_eq!(
        app.query_i64("SELECT count(*) FROM sessions", &[]),
        sessions_before
    );
    // The one token endpoint agents may use says what the token can do.
    let (_, res) = api(
        app,
        &r.manage,
        "GET",
        "/api/tokens/whoami",
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["body"]["manage"], true);
    assert_eq!(res["body"]["via_token"], true);
}

#[tokio::test]
async fn the_servers_own_permission_errors_come_through_unchanged() {
    let r = rig().await;
    let app = r.app();
    // Read-only token: reads work, writes are refused by the server (not by MCP), nothing changes.
    let (t, res) = api(
        app,
        &r.read,
        "POST",
        &format!("/api/bases/{}/tables", r.base()),
        Value::Null,
        json!({"name": "Nope"}),
    )
    .await;
    assert!(t.is_error);
    assert_eq!(res["status"], 403);
    assert!(
        res["body"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("read-only")
    );
    assert_eq!(r.p.f.schema().await["tables"].as_array().unwrap().len(), 1);
    // A write token without manage: manage-gated endpoints name the permission.
    for (method, path, body) in [
        ("POST", "/api/workspaces".to_string(), json!({"name": "W"})),
        ("DELETE", format!("/api/bases/{}", r.base()), Value::Null),
        (
            "GET",
            format!("/api/bases/{}/members", r.base()),
            Value::Null,
        ),
        ("GET", "/api/admin/users".to_string(), Value::Null),
    ] {
        let (t, res) = api(app, &r.write, method, &path, Value::Null, body).await;
        assert!(t.is_error, "{method} {path}");
        assert_eq!(res["status"], 403, "{method} {path}: {res}");
        let msg = res["body"]["error"]["message"].as_str().unwrap();
        // (A non-administrator is told about administrators first.)
        assert!(
            msg.contains("'manage' permission")
                || (path.contains("/admin/") && msg.contains("administrator")),
            "{method} {path}: {res}"
        );
    }
    assert_eq!(
        app.query_i64("SELECT count(*) FROM workspaces WHERE name = 'W'", &[]),
        0
    );
    // Unknown things are the server's usual 404 with the standard error envelope.
    let (t, res) = api(
        app,
        &r.write,
        "GET",
        "/api/bases/appNope",
        Value::Null,
        Value::Null,
    )
    .await;
    assert!(t.is_error);
    assert_eq!(res["status"], 404);
    assert_eq!(res["ok"], false);
    assert_eq!(res["body"]["error"]["code"], "not_found");
    let (_, res) = api(
        app,
        &r.write,
        "GET",
        "/api/no/such/route",
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 404);
    let (_, res) = api(
        app,
        &r.write,
        "PATCH",
        "/api/health",
        Value::Null,
        json!({}),
    )
    .await;
    assert_eq!(res["status"], 405);
    let (_, res) = api(
        app,
        &r.write,
        "POST",
        &format!("/api/bases/{}/tables", r.base()),
        Value::Null,
        json!({"nme": 1}),
    )
    .await;
    assert_eq!(res["status"], 400, "validation errors pass through");
}

#[tokio::test]
async fn base_limited_tokens_cannot_see_other_bases_through_any_tool() {
    let r = rig().await;
    let app = r.app();
    let f = &r.p.f;
    // A second base the owner can reach, with a record only the owner's other token may see.
    let (ws2, other) = app.workspace_with_base(&f.owner, "Secret HQ");
    let other_table = app
        .post(
            &f.owner,
            &format!("/api/bases/{other}/tables"),
            json!({"name": "Plans"}),
        )
        .await;
    other_table.assert_status(201);
    let other_table_id = id_of(&other_table.body);
    let primary = other_table.body["primary_field_id"]
        .as_str()
        .unwrap()
        .to_string();
    let secret = app
        .post(
            &f.owner,
            &records_url(&other_table_id),
            json!({"records": [{"values": {&primary: "launch codes"}}]}),
        )
        .await;
    secret.assert_status(201);
    let secret_rec = id_of(&secret.body["records"][0]);
    let other_view = other_table.body["views"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    for (label, scope) in [
        (
            "read",
            json!({"name": "l1", "write": false, "base_ids": [r.base()]}),
        ),
        (
            "write",
            json!({"name": "l2", "write": true, "base_ids": [r.base()]}),
        ),
        (
            "manage",
            json!({"name": "l3", "write": true, "manage": true, "base_ids": [r.base()]}),
        ),
    ] {
        let t = app.api_token(&f.owner, scope).await;
        // Curated tools.
        let listed = tool(app, &t, "list_bases", json!({})).await;
        assert!(
            !listed.text.contains(&other) && !listed.text.contains("Secret HQ"),
            "{label}: {}",
            listed.text
        );
        let schema = tool(app, &t, "get_base_schema", json!({"base_id": other})).await;
        assert!(schema.is_error && !schema.text.contains("Plans"), "{label}");
        let recs = tool(
            app,
            &t,
            "list_records",
            json!({"base_id": other, "table": "Plans"}),
        )
        .await;
        assert!(
            recs.is_error && !recs.text.contains("launch"),
            "{label}: {}",
            recs.text
        );
        let comments = tool(app, &t, "list_comments", json!({"record_id": secret_rec})).await;
        assert!(comments.is_error, "{label}");

        // api_request, every way of asking for it.
        let mut probes: Vec<(&str, String, Value)> = vec![
            ("GET", format!("/api/bases/{other}"), Value::Null),
            (
                "GET",
                format!("/api/bases/{other}/collaborators"),
                Value::Null,
            ),
            ("GET", format!("/api/bases/{other}/trash"), Value::Null),
            (
                "GET",
                format!("/api/bases/{other}/automations"),
                Value::Null,
            ),
            (
                "GET",
                format!("/api/tables/{other_table_id}/records/{secret_rec}"),
                Value::Null,
            ),
            (
                "GET",
                format!("/api/tables/{other_table_id}/records/lookup"),
                Value::Null,
            ),
            ("POST", format!("/api/views/{other_view}/query"), json!({})),
            (
                "GET",
                format!("/api/views/{other_view}/export.csv"),
                Value::Null,
            ),
            (
                "GET",
                format!("/api/records/{secret_rec}/history"),
                Value::Null,
            ),
            (
                "GET",
                format!("/api/records/{secret_rec}/comments"),
                Value::Null,
            ),
            (
                "GET",
                format!("/api/v1/meta/bases/{other}/tables"),
                Value::Null,
            ),
            ("GET", format!("/api/v1/{other}/Plans"), Value::Null),
            (
                "GET",
                format!("/api/v1/{other}/{other_table_id}/{secret_rec}"),
                Value::Null,
            ),
        ];
        if label != "read" {
            probes.extend([
                (
                    "POST",
                    format!("/api/bases/{other}/tables"),
                    json!({"name": "Planted"}),
                ),
                (
                    "POST",
                    format!("/api/tables/{other_table_id}/records"),
                    json!({"records": [{"values": {&primary: "planted"}}]}),
                ),
                (
                    "PATCH",
                    format!("/api/bases/{other}"),
                    json!({"name": "Hijacked"}),
                ),
                (
                    "POST",
                    format!("/api/bases/{other}/attachments"),
                    json!({"multipart": {"file": {"filename": "x", "text": "x"}}}),
                ),
                (
                    "POST",
                    format!("/api/v1/{other}/Plans"),
                    json!({"fields": {"Name": "planted"}}),
                ),
            ]);
        }
        if label == "manage" {
            probes.extend([
                ("DELETE", format!("/api/bases/{other}"), Value::Null),
                ("GET", format!("/api/bases/{other}/members"), Value::Null),
                (
                    "POST",
                    format!("/api/bases/{other}/invites"),
                    json!({"role": "viewer"}),
                ),
                ("POST", format!("/api/bases/{other}/duplicate"), json!({})),
                ("GET", format!("/api/workspaces/{ws2}/members"), Value::Null),
                ("DELETE", format!("/api/workspaces/{ws2}"), Value::Null),
                (
                    "POST",
                    format!("/api/workspaces/{ws2}/invites"),
                    json!({"role": "viewer"}),
                ),
            ]);
        }
        for (method, path, body) in probes {
            let (t, res) = api(app, &t, method, &path, Value::Null, body).await;
            let status = res["status"].as_u64().unwrap();
            assert!(
                matches!(status, 403 | 404),
                "{label}: {method} {path} -> {status} {res}"
            );
            assert!(t.is_error, "{label}: {method} {path}");
            assert!(
                !res.to_string().contains("launch codes"),
                "{label}: {method} {path} leaked"
            );
        }
        // Listings are filtered, not refused.
        let (_, res) = api(app, &t, "GET", "/api/workspaces", Value::Null, Value::Null).await;
        let listing = res["body"].to_string();
        assert!(
            !listing.contains(&other) && !listing.contains("Secret HQ"),
            "{label}: {listing}"
        );
        let (_, res) = api(
            app,
            &t,
            "GET",
            "/api/v1/meta/bases",
            Value::Null,
            Value::Null,
        )
        .await;
        assert_eq!(res["body"]["bases"].as_array().unwrap().len(), 1, "{label}");
    }
    // Nothing happened to the other base.
    let other_name: i64 = app.query_i64("SELECT count(*) FROM bases WHERE id = ?1 AND name = 'Secret HQ base' AND deleted_at IS NULL", &[&other]);
    assert_eq!(other_name, 1);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM tables WHERE base_id = ?1", &[&other]),
        1
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM records WHERE table_id = ?1",
            &[&other_table_id]
        ),
        1
    );
}

// ----------------------------------------------------------------- manage tools

#[tokio::test]
async fn manage_tools_manage_workspaces_members_and_invites() {
    let r = rig().await;
    let app = r.app();
    let t = tool(
        app,
        &r.manage,
        "create_workspace",
        json!({"name": "Agent HQ"}),
    )
    .await;
    let ws = t.ok()["workspace"]["id"].as_str().unwrap().to_string();
    assert_eq!(t.ok()["workspace"]["role"], "owner");
    // The owner is the only member until someone joins.
    let ed = app.user("ed@example.com", "Ed");
    app.grant_workspace_role(&ed, &ws, "editor");
    let t = tool(
        app,
        &r.manage,
        "list_members",
        json!({"scope": "workspace", "id": ws}),
    )
    .await;
    let members = t.ok()["members"].as_array().unwrap().clone();
    assert_eq!(members.len(), 2);
    let ed_id = ed.user_id.clone().unwrap();
    let t = tool(
        app,
        &r.manage,
        "set_member_role",
        json!({"scope": "workspace", "id": ws, "user_id": ed_id, "role": "viewer"}),
    )
    .await;
    t.ok();
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM workspace_members WHERE workspace_id = ?1 AND role = 'viewer'",
            &[&ws]
        ),
        1
    );
    let t = tool(
        app,
        &r.manage,
        "create_invite",
        json!({"scope": "workspace", "id": ws, "role": "commenter"}),
    )
    .await;
    let invite = t.ok();
    assert!(invite["url"].as_str().unwrap().contains("/invite/"));
    assert_eq!(invite["info"]["role"], "commenter");
    // Base-level: members of a base, invites for a base.
    let t = tool(
        app,
        &r.manage,
        "list_members",
        json!({"scope": "base", "id": r.base()}),
    )
    .await;
    t.ok();
    let t = tool(
        app,
        &r.manage,
        "create_invite",
        json!({"scope": "base", "id": r.base(), "role": "viewer", "email": "new@example.com"}),
    )
    .await;
    assert_eq!(t.ok()["info"]["email"], "new@example.com");
    // Errors from the server arrive as tool errors with its message.
    let t = tool(
        app,
        &r.manage,
        "set_member_role",
        json!({"scope": "workspace", "id": ws, "user_id": ed_id, "role": "emperor"}),
    )
    .await;
    assert!(t.err().contains("unknown role"), "{}", t.text);
    let t = tool(
        app,
        &r.manage,
        "list_members",
        json!({"scope": "workspace", "id": "wspNope"}),
    )
    .await;
    assert!(t.err().contains("not found"), "{}", t.text);
    let t = tool(
        app,
        &r.manage,
        "list_members",
        json!({"scope": "planet", "id": ws}),
    )
    .await;
    assert!(t.err().contains("Invalid arguments"), "{}", t.text);
    // A manage token of a user who is only an editor is refused by the role check.
    let editor_token = app
        .api_token(&ed, json!({"name": "e", "write": true, "manage": true}))
        .await;
    app.grant_workspace_role(&ed, &ws, "editor");
    let t = tool(
        app,
        &editor_token,
        "create_invite",
        json!({"scope": "workspace", "id": ws, "role": "viewer"}),
    )
    .await;
    assert!(t.err().contains("requires the owner role"), "{}", t.text);
}

#[tokio::test]
async fn admin_endpoints_work_for_an_administrators_manage_token_and_are_audited() {
    let app = common::TestApp::new();
    let admin = app.admin("root@example.com", "Root");
    let plain = app.user("plain@example.com", "Plain");
    let admin_token = app
        .api_token(&admin, json!({"name": "a", "write": true, "manage": true}))
        .await;
    let plain_token = app
        .api_token(&plain, json!({"name": "p", "write": true, "manage": true}))
        .await;
    let (_, res) = api(
        &app,
        &admin_token,
        "GET",
        "/api/admin/stats",
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["status"], 200, "{res}");
    assert_eq!(res["body"]["users"], 2);
    let (_, res) = api(
        &app,
        &admin_token,
        "GET",
        "/api/admin/users",
        Value::Null,
        Value::Null,
    )
    .await;
    assert_eq!(res["body"].as_array().unwrap().len(), 2);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM audit_log WHERE action = 'admin_token_use' AND user_id IS NOT NULL", &[]),
        2
    );
    let (t, res) = api(
        &app,
        &plain_token,
        "GET",
        "/api/admin/stats",
        Value::Null,
        Value::Null,
    )
    .await;
    assert!(t.is_error);
    assert_eq!(res["status"], 403);
}

// ------------------------------------------------------------------- big results

#[tokio::test]
async fn huge_results_are_truncated_with_a_note() {
    let r = rig().await;
    let app = r.app();
    let f = &r.p.f;
    let name = r.p.name.clone();
    let rows: Vec<Value> = (0..150)
        .map(|i| json!({"values": {&name: format!("{i:03}-{}", "x".repeat(1_000))}}))
        .collect();
    app.post(&f.owner, &records_url(r.table()), json!({"records": rows}))
        .await
        .assert_status(201);

    let (t, res) = api(
        app,
        &r.read,
        "POST",
        &format!("/api/views/{}/query", f.view_id),
        Value::Null,
        json!({"limit": 1000}),
    )
    .await;
    assert!(!t.is_error);
    assert_eq!(
        res,
        Value::Null,
        "no structured content for a truncated result"
    );
    assert!(t.text.len() < 101_000, "{} bytes", t.text.len());
    assert!(t.text.contains("[truncated"), "the text says it was cut");

    // The curated tool is capped the same way; asking for less works.
    let t = tool(
        app,
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1", "max_records": 200}),
    )
    .await;
    assert!(!t.is_error);
    assert!(t.text.len() < 101_000);
    assert!(t.text.contains("[truncated"));
    let t = tool(
        app,
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1", "max_records": 5, "fields": ["Age"]}),
    )
    .await;
    assert_eq!(t.ok()["count"], 5);
}
