//! Interoperability with a real MCP client: the official Rust SDK (`rmcp`) connects to a real
//! TCP listener over Streamable HTTP, in both protocol eras (the stateless `server/discover`
//! lifecycle and the `initialize` handshake), lists the tools and calls several of them. If the
//! SDK and this server disagree about the protocol, this is the test that fails.

mod common;
mod mcp_support;

use mcp_support::*;
use rmcp::ClientLifecycleMode;
use rmcp::ClientServiceExt;
use rmcp::model::{CallToolRequestParams, ClientConfig, ProtocolVersion};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::{Value, json};

fn args(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

/// What a tool result says, as JSON: the structured content, or the text parsed as JSON.
fn structured(result: &rmcp::model::CallToolResult) -> Value {
    if let Some(s) = &result.structured_content {
        return s.clone();
    }
    serde_json::to_value(&result.content).unwrap()
}

async fn exercise(mode: ClientLifecycleMode, expect_era: &str) {
    let r = Rig::new().await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{}/mcp", r.live.url))
            .auth_header(r.token.clone()),
    );
    let client = ClientConfig::default()
        .serve_with_lifecycle(transport, mode)
        .await
        .unwrap_or_else(|e| panic!("the {expect_era} handshake with {} failed: {e}", r.live.url));

    // The server introduces itself.
    let info = client.peer_info().expect("the server answered");
    assert_eq!(
        serde_json::to_value(&info).unwrap()["serverInfo"]["name"],
        "openbase",
        "{expect_era}"
    );

    // tools/list
    let tools = client.list_all_tools().await.expect("tools/list");
    let names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    for expected in [
        "list_projects",
        "get_project_schema",
        "create_records",
        "create_table",
        "create_field",
        "create_view",
        "query_view",
        "create_workspace",
        "admin_stats",
    ] {
        assert!(
            names.iter().any(|n| n == expected),
            "{expected} in {names:?}"
        );
    }
    assert!(names.len() > 60, "{} tools", names.len());
    let create_field = tools.iter().find(|t| t.name == "create_field").unwrap();
    assert!(
        create_field
            .description
            .as_deref()
            .unwrap()
            .contains("28 types"),
        "descriptions survive the trip"
    );
    assert_eq!(
        create_field.input_schema.get("type"),
        Some(&json!("object")),
        "input schemas survive the trip"
    );

    // tools/call: reads, writes, a computed field, a view query and an error.
    let res = client
        .call_tool(CallToolRequestParams::new("list_bases"))
        .await
        .expect("list_bases");
    assert_ne!(res.is_error, Some(true));
    let bases = structured(&res);
    assert_eq!(bases["workspaces"][0]["bases"][0]["id"], r.base.as_str());

    let created = client
        .call_tool(
            CallToolRequestParams::new("create_table")
                .with_arguments(args(json!({"base_id": r.base, "name": "Orders"}))),
        )
        .await
        .expect("create_table");
    assert_ne!(created.is_error, Some(true), "{created:?}");
    for (name, ty, options) in [
        ("Qty", "number", json!({})),
        ("Price", "number", json!({"precision": 2})),
        ("Total", "formula", json!({"expression": "{Qty} * {Price}"})),
    ] {
        let f = client
            .call_tool(CallToolRequestParams::new("create_field").with_arguments(args(
                json!({"base_id": r.base, "table": "Orders", "name": name, "type": ty, "options": options}),
            )))
            .await
            .expect("create_field");
        assert_ne!(f.is_error, Some(true), "{name}: {f:?}");
    }
    let recs = client
        .call_tool(
            CallToolRequestParams::new("create_records").with_arguments(args(
                json!({"base_id": r.base, "table": "Orders", "records": [
                    {"fields": {"Name": "a", "Qty": 3, "Price": 2.5}},
                    {"fields": {"Name": "b", "Qty": 1, "Price": 10}},
                ]}),
            )),
        )
        .await
        .expect("create_records");
    assert_eq!(structured(&recs)["created"][0]["fields"]["Total"], 7.5);

    let q = client
        .call_tool(
            CallToolRequestParams::new("query_view").with_arguments(args(
                json!({"base_id": r.base, "table": "Orders", "view": "Default grid"}),
            )),
        )
        .await
        .expect("query_view");
    let q = structured(&q);
    assert_eq!(q["total"], 2);
    assert_eq!(q["records"][1]["fields"]["Total"], 10);

    // Errors are tool results the model can read, not transport failures.
    let bad = client
        .call_tool(
            CallToolRequestParams::new("get_base_schema")
                .with_arguments(args(json!({"base_id": "appNope"}))),
        )
        .await
        .expect("a tool error is still a result");
    assert_eq!(bad.is_error, Some(true));
    let text = serde_json::to_string(&bad.content).unwrap();
    assert!(text.contains("not found"), "{text}");
    // An unknown tool is a protocol error.
    assert!(
        client
            .call_tool(CallToolRequestParams::new("no_such_tool"))
            .await
            .is_err()
    );

    client.cancel().await.expect("clean shutdown");
}

#[tokio::test]
async fn the_official_rust_client_works_with_the_stateless_lifecycle() {
    exercise(
        ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        },
        "stateless (server/discover)",
    )
    .await;
}

#[tokio::test]
async fn the_official_rust_client_works_with_the_initialize_handshake() {
    exercise(ClientLifecycleMode::Initialize, "initialize handshake").await;
}

#[tokio::test]
async fn the_client_negotiates_automatically() {
    exercise(
        ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            legacy_version: None,
        },
        "auto",
    )
    .await;
}

#[tokio::test]
async fn a_wrong_token_is_refused_at_the_handshake() {
    let r = Rig::new().await;
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{}/mcp", r.live.url))
            .auth_header("pat_not_a_real_token"),
    );
    let started = ClientConfig::default()
        .serve_with_lifecycle(transport, ClientLifecycleMode::Initialize)
        .await;
    assert!(started.is_err(), "an invalid token cannot start a session");
}
