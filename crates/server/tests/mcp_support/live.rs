//! A real OpenGrid on a TCP port, and an agent that talks to it the way an MCP client does:
//! JSON-RPC over HTTP with a bearer token. Used by the end-to-end agent tests.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use opengrid::automations::runner::{Runner, RunnerOpts};
use opengrid::config::Config;
use serde_json::{Value, json};

use crate::common::TestApp;

pub struct LiveApp {
    pub app: TestApp,
    /// `http://127.0.0.1:<port>`: also the configured public URL.
    pub url: String,
}

impl LiveApp {
    pub async fn start() -> LiveApp {
        Self::start_with(|_| {}).await
    }

    pub async fn start_with(tweak: impl FnOnce(&mut Config)) -> LiveApp {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let public = url.clone();
        let app = TestApp::with_config(move |c| {
            c.public_url = public;
            tweak(c);
        });
        let router = app.router.clone();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .ok();
        });
        LiveApp { app, url }
    }

    /// Run automations in the background, as the server does (without retry delays).
    pub fn run_automations(&self) {
        let runner = Arc::new(Runner::new(
            self.app.state.clone(),
            RunnerOpts {
                retry_delays: [Duration::ZERO, Duration::ZERO],
                concurrency: 1,
                poll: Duration::from_millis(20),
            },
        ));
        tokio::spawn(runner.run_forever());
    }

    pub fn agent(&self, token: &str) -> Agent {
        Agent::new(&self.url, token)
    }
}

/// An MCP client in miniature: initializes, lists tools and calls them over real HTTP.
pub struct Agent {
    http: reqwest::Client,
    url: String,
    token: String,
}

impl Agent {
    pub fn new(base_url: &str, token: &str) -> Agent {
        Agent {
            http: reqwest::Client::new(),
            url: format!("{base_url}/mcp"),
            token: token.to_string(),
        }
    }

    /// One JSON-RPC request; returns (HTTP status, body).
    pub async fn rpc(&self, method: &str, params: Value) -> (u16, Value) {
        let res = self
            .http
            .post(&self.url)
            .bearer_auth(&self.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .expect("the server is reachable");
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    pub async fn initialize(&self) -> Value {
        let (status, body) = self
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "agent-test", "version": "1" },
                }),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body["result"].clone()
    }

    pub async fn tool_names(&self) -> Vec<String> {
        let (status, body) = self.rpc("tools/list", json!({})).await;
        assert_eq!(status, 200, "{body}");
        body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// Raw `tools/call` result: `(isError, text, structuredContent)`.
    pub async fn raw(&self, name: &str, args: Value) -> (bool, String, Value) {
        let (status, body) = self
            .rpc("tools/call", json!({ "name": name, "arguments": args }))
            .await;
        assert_eq!(status, 200, "tools/call {name}: {body}");
        assert!(body.get("error").is_none(), "{name}: protocol error {body}");
        let r = &body["result"];
        (
            r["isError"].as_bool().unwrap_or(false),
            r["content"][0]["text"].as_str().unwrap_or("").to_string(),
            r["structuredContent"].clone(),
        )
    }

    /// Call a tool that must succeed; returns its structured result.
    pub async fn call(&self, name: &str, args: Value) -> Value {
        let (is_error, text, structured) = self.raw(name, args).await;
        assert!(!is_error, "{name} failed: {text}");
        structured
    }

    /// Call a tool that must fail; returns the error text.
    pub async fn fails(&self, name: &str, args: Value) -> String {
        let (is_error, text, _) = self.raw(name, args).await;
        assert!(is_error, "{name} unexpectedly succeeded: {text}");
        text
    }

    /// Call a tool that must succeed; returns its text (for tools that return text).
    pub async fn text(&self, name: &str, args: Value) -> String {
        let (is_error, text, _) = self.raw(name, args).await;
        assert!(!is_error, "{name} failed: {text}");
        text
    }
}
