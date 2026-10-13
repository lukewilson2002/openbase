//! Helpers for the MCP tests: JSON-RPC calls to `/mcp` in both protocol eras, tool-call
//! shortcuts and result accessors. Everything goes through the real router.
#![allow(dead_code)]

use serde_json::{Value, json};

mod live;
#[allow(unused_imports)]
pub use live::*;

mod rig;
#[allow(unused_imports)]
pub use rig::*;

use crate::common::{Client, Response, TestApp};

pub const LEGACY: &str = "2025-06-18";
pub const MODERN: &str = "2026-07-28";

pub fn rpc_message(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

const ACCEPT: (&str, &str) = ("accept", "application/json, text/event-stream");

/// POST a JSON-RPC request as the bearer `client`, handshake-era style (no `_meta`).
pub async fn legacy(app: &TestApp, client: &Client, method: &str, params: Value) -> Response {
    app.request_with(
        client,
        "POST",
        "/mcp",
        Some(rpc_message(1, method, params)),
        &[ACCEPT, ("mcp-protocol-version", LEGACY)],
        false,
        None,
    )
    .await
}

/// A stateless-era request: `_meta` with the protocol version, plus the mirrored headers.
pub async fn modern(app: &TestApp, client: &Client, method: &str, params: Value) -> Response {
    let mut params = params;
    if params.is_null() {
        params = json!({});
    }
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    let name = params["name"].as_str().map(str::to_string);
    let mut headers = vec![
        ACCEPT,
        ("mcp-protocol-version", MODERN),
        ("mcp-method", method),
    ];
    if let Some(n) = name.as_deref().filter(|_| method == "tools/call") {
        headers.push(("mcp-name", n));
    }
    app.request_with(
        client,
        "POST",
        "/mcp",
        Some(rpc_message(1, method, params)),
        &headers,
        false,
        None,
    )
    .await
}

/// The outcome of `tools/call`.
pub struct Tool {
    pub raw: Response,
    pub is_error: bool,
    pub text: String,
    pub structured: Value,
}

impl Tool {
    /// The structured result; panics with the text when the call failed.
    #[track_caller]
    pub fn ok(&self) -> &Value {
        assert!(!self.is_error, "tool failed: {}", self.text);
        &self.structured
    }

    #[track_caller]
    pub fn err(&self) -> &str {
        assert!(self.is_error, "tool unexpectedly succeeded: {}", self.text);
        &self.text
    }
}

pub async fn tool(app: &TestApp, client: &Client, name: &str, args: Value) -> Tool {
    let res = legacy(
        app,
        client,
        "tools/call",
        json!({ "name": name, "arguments": args }),
    )
    .await;
    assert_eq!(res.status, 200, "tools/call {name}: {}", res.body);
    assert!(
        res.body.get("error").is_none(),
        "tools/call {name} was a protocol error: {}",
        res.body
    );
    let result = &res.body["result"];
    Tool {
        is_error: result["isError"].as_bool().unwrap_or(false),
        text: result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        structured: result["structuredContent"].clone(),
        raw: res,
    }
}

/// Names of the tools `client` is offered.
pub async fn tool_names(app: &TestApp, client: &Client) -> Vec<String> {
    let res = legacy(app, client, "tools/list", json!({})).await;
    assert_eq!(res.status, 200, "{}", res.body);
    res.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

/// `api_request` through the tool: returns the tool and the inner `{status, ok, body, ...}`.
pub async fn api(
    app: &TestApp,
    client: &Client,
    method: &str,
    path: &str,
    query: Value,
    body: Value,
) -> (Tool, Value) {
    let mut args = json!({ "method": method, "path": path });
    if !query.is_null() {
        args["query"] = query;
    }
    if !body.is_null() {
        args["body"] = body;
    }
    let t = tool(app, client, "api_request", args).await;
    let inner = t.structured.clone();
    (t, inner)
}
