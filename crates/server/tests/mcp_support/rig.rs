//! A ready-made world for tool tests: a live server, an administrator with a `manage` token,
//! and a workspace and base created through MCP.
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use super::{Agent, LiveApp};
use crate::common::Client;

pub struct Rig {
    pub live: LiveApp,
    pub admin: Client,
    /// The manage-scoped agent of the administrator.
    pub agent: Agent,
    pub token: String,
    pub ws: String,
    pub base: String,
    /// The "Table 1" every new base comes with; the first `table()` call renames it.
    first_table: String,
    first_used: AtomicBool,
}

impl Rig {
    pub async fn new() -> Rig {
        Self::with(|_| {}).await
    }

    pub async fn with(tweak: impl FnOnce(&mut opengrid::config::Config)) -> Rig {
        let live = LiveApp::start_with(tweak).await;
        let (res, admin) = live
            .app
            .signup("admin@example.com", "correct horse battery staple", None)
            .await;
        res.assert_status(200);
        let tok = live
            .app
            .api_token(&admin, json!({"name": "agent", "write": true, "manage": true}))
            .await;
        let token = tok.bearer.clone().unwrap();
        let agent = live.agent(&token);
        let ws = agent
            .call("create_workspace", json!({"name": "Workspace"}))
            .await["workspace"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let created = agent
            .call("create_base", json!({"workspace_id": ws, "name": "Base"}))
            .await;
        let base = created["base"]["id"].as_str().unwrap().to_string();
        let first_table = created["base"]["tables"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        Rig {
            live,
            admin,
            agent,
            token,
            ws,
            base,
            first_table,
            first_used: AtomicBool::new(false),
        }
    }

    pub fn app(&self) -> &crate::common::TestApp {
        &self.live.app
    }

    /// An agent for a token created by the administrator with `scopes`
    /// (`write`, `manage`, `base_ids`, ...).
    pub async fn agent_with(&self, scopes: Value) -> Agent {
        let mut body = json!({"name": "t"});
        for (k, v) in scopes.as_object().unwrap() {
            body[k] = v.clone();
        }
        let tok = self.app().api_token(&self.admin, body).await;
        self.live.agent(tok.bearer.as_deref().unwrap())
    }

    /// A second user with `role` on the whole workspace, and an agent with a token for them.
    pub async fn teammate(&self, email: &str, role: &str, scopes: Value) -> (Client, Agent) {
        let user = self.app().user(email, "Teammate");
        self.app()
            .grant_workspace_role(&user, &self.ws, role);
        let mut body = json!({"name": "t"});
        for (k, v) in scopes.as_object().unwrap() {
            body[k] = v.clone();
        }
        let tok = self.app().api_token(&user, body).await;
        let agent = self.live.agent(tok.bearer.as_deref().unwrap());
        (user, agent)
    }

    pub async fn table(&self, name: &str) -> Value {
        // A base keeps at least one table: the first table of a test is the one it came with.
        if !self.first_used.swap(true, Ordering::SeqCst) {
            return self
                .agent
                .call(
                    "rename_table",
                    json!({"base_id": self.base, "table": self.first_table, "name": name}),
                )
                .await["table"]
                .clone();
        }
        self.agent
            .call("create_table", json!({"base_id": self.base, "name": name}))
            .await["table"]
            .clone()
    }

    pub async fn field(&self, table: &str, name: &str, ty: &str, options: Value) -> Value {
        self.agent
            .call(
                "create_field",
                json!({"base_id": self.base, "table": table, "name": name, "type": ty, "options": options}),
            )
            .await["field"]
            .clone()
    }

    pub async fn records(&self, table: &str, records: Value) -> Value {
        self.agent
            .call(
                "create_records",
                json!({"base_id": self.base, "table": table, "records": records}),
            )
            .await["created"]
            .clone()
    }

    pub async fn schema(&self) -> Value {
        self.agent
            .call("get_base_schema", json!({"base_id": self.base}))
            .await
    }
}
