//! Helpers for the schema-plane integration tests (workspaces, bases, tables,
//! fields, views, trash): build fixtures through the real API, set roles by
//! inserting membership rows, and poke the database directly where the API
//! for it does not exist yet (records).
#![allow(dead_code)]

use opengrid::config::Config;
use opengrid::perm::Role;
use rusqlite::params;
use serde_json::{Value, json};

use crate::common::{Client, TestApp};

pub const ALL_ROLES: [Role; 5] = [
    Role::Viewer,
    Role::Commenter,
    Role::Editor,
    Role::Creator,
    Role::Owner,
];

pub fn new_app() -> TestApp {
    TestApp::new()
}

/// Run SQL against the writer connection.
pub fn sql<T>(app: &TestApp, f: impl FnOnce(&rusqlite::Transaction) -> rusqlite::Result<T>) -> T {
    app.state
        .db
        .write_sync(|tx| f(tx).map_err(opengrid::error::AppError::from))
        .unwrap()
}

pub fn add_ws_member(app: &TestApp, ws: &str, user: &Client, role: Role) {
    let (ws, uid, role) = (ws.to_string(), user.user_id.clone().unwrap(), role.as_str());
    sql(app, |tx| {
        tx.execute(
            "INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role, created_at)
             VALUES (?1, ?2, ?3, 1)",
            params![ws, uid, role],
        )
    });
}

pub fn add_base_member(app: &TestApp, base: &str, user: &Client, role: Role) {
    let (base, uid, role) = (
        base.to_string(),
        user.user_id.clone().unwrap(),
        role.as_str(),
    );
    sql(app, |tx| {
        tx.execute(
            "INSERT OR REPLACE INTO base_members (base_id, user_id, role, created_at)
             VALUES (?1, ?2, ?3, 1)",
            params![base, uid, role],
        )
    });
}

/// A bearer-token client for `user` (API token, full write scope).
pub fn token_client(app: &TestApp, user: &Client, write: bool) -> Client {
    let token = format!("pat_test_{}", opengrid::ids::new_id("x"));
    let hash = opengrid::ids::hash_token(&token);
    let uid = user.user_id.clone().unwrap();
    let scopes = json!({ "write": write, "base_ids": null }).to_string();
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES (?1, ?2, 't', ?3, ?4, 1)",
            params![opengrid::ids::new_id("pat"), uid, hash, scopes],
        )
    });
    Client {
        cookie: None,
        bearer: Some(token),
        user_id: user.user_id.clone(),
    }
}

/// Create a workspace as `c`; returns its id.
pub async fn workspace(app: &TestApp, c: &Client, name: &str) -> String {
    let r = app
        .post(c, "/api/workspaces", json!({ "name": name }))
        .await;
    r.assert_status(201);
    r.body["id"].as_str().unwrap().to_string()
}

/// Create a base in `ws` as `c`; returns its full schema JSON.
pub async fn base(app: &TestApp, c: &Client, ws: &str, name: &str) -> Value {
    let r = app
        .post(
            c,
            &format!("/api/workspaces/{ws}/bases"),
            json!({ "name": name }),
        )
        .await;
    r.assert_status(201);
    r.body.clone()
}

/// A workspace with an owner and one base (starter table "Table 1").
pub struct Fixture {
    pub app: TestApp,
    pub owner: Client,
    pub ws: String,
    pub base_id: String,
    pub table_id: String,
    pub primary_id: String,
    pub notes_id: String,
    pub view_id: String,
}

impl Fixture {
    pub async fn new() -> Fixture {
        Self::with_app(TestApp::new()).await
    }

    pub async fn with_config(f: impl FnOnce(&mut Config)) -> Fixture {
        Self::with_app(TestApp::with_config(f)).await
    }

    async fn with_app(app: TestApp) -> Fixture {
        let owner = app.user("owner@example.com", "Owner");
        let ws = workspace(&app, &owner, "Acme").await;
        let b = base(&app, &owner, &ws, "CRM").await;
        let t = &b["tables"][0];
        Fixture {
            base_id: b["id"].as_str().unwrap().into(),
            table_id: t["id"].as_str().unwrap().into(),
            primary_id: t["primary_field_id"].as_str().unwrap().into(),
            notes_id: t["fields"][1]["id"].as_str().unwrap().into(),
            view_id: t["views"][0]["id"].as_str().unwrap().into(),
            app,
            owner,
            ws,
        }
    }

    /// A new user with `role` on the fixture's workspace.
    pub fn member(&self, email: &str, role: Role) -> Client {
        let u = self.app.user(email, email);
        add_ws_member(&self.app, &self.ws, &u, role);
        u
    }

    /// A new user with `role` on the fixture's base only (base sharing).
    pub fn base_guest(&self, email: &str, role: Role) -> Client {
        let u = self.app.user(email, email);
        add_base_member(&self.app, &self.base_id, &u, role);
        u
    }

    pub async fn schema(&self) -> Value {
        let r = self
            .app
            .get(&self.owner, &format!("/api/bases/{}", self.base_id))
            .await;
        r.assert_status(200);
        r.body.clone()
    }

    pub async fn table(&self, table_id: &str) -> Value {
        let s = self.schema().await;
        s["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == table_id)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub async fn add_table(&self, name: &str) -> Value {
        let r = self
            .app
            .post(
                &self.owner,
                &format!("/api/bases/{}/tables", self.base_id),
                json!({ "name": name }),
            )
            .await;
        r.assert_status(201);
        r.body.clone()
    }

    pub async fn add_field(&self, table_id: &str, body: Value) -> Value {
        let r = self
            .app
            .post(&self.owner, &format!("/api/tables/{table_id}/fields"), body)
            .await;
        r.assert_status(201);
        r.body.clone()
    }

    /// Link field `name` in `from` to table `to`; returns the response (with `inverse`).
    pub async fn add_link(&self, from: &str, name: &str, to: &str) -> Value {
        self.add_field(
            from,
            json!({ "name": name, "type": "link", "options": { "linked_table_id": to } }),
        )
        .await
    }

    /// Insert a record directly (the records API belongs to a later workstream).
    pub fn insert_record(&self, table_id: &str, data: Value) -> String {
        insert_record(&self.app, table_id, data)
    }

    pub fn record_data(&self, record_id: &str) -> Value {
        record_data(&self.app, record_id)
    }

    pub fn field_ids(table: &Value) -> Vec<String> {
        table["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap().to_string())
            .collect()
    }

    pub fn field_names(table: &Value) -> Vec<String> {
        table["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap().to_string())
            .collect()
    }
}

pub fn insert_record(app: &TestApp, table_id: &str, data: Value) -> String {
    let id = opengrid::ids::new_id("rec");
    let (rid, tid, data) = (id.clone(), table_id.to_string(), data.to_string());
    sql(app, |tx| {
        let pos: f64 = tx.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM records WHERE table_id = ?1",
            [&tid],
            |r| r.get(0),
        )?;
        let auto: i64 = tx.query_row(
            "SELECT next_autonumber FROM tables WHERE id = ?1",
            [&tid],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE tables SET next_autonumber = next_autonumber + 1 WHERE id = ?1",
            [&tid],
        )?;
        tx.execute(
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1000, 1000)",
            params![rid, tid, data, pos, auto],
        )
    });
    id
}

pub fn record_data(app: &TestApp, record_id: &str) -> Value {
    let rid = record_id.to_string();
    let s: String = sql(app, |tx| {
        tx.query_row("SELECT data FROM records WHERE id = ?1", [&rid], |r| {
            r.get(0)
        })
    });
    serde_json::from_str(&s).unwrap()
}

pub fn record_exists(app: &TestApp, record_id: &str) -> bool {
    let rid = record_id.to_string();
    sql(app, |tx| {
        tx.query_row("SELECT count(*) FROM records WHERE id = ?1", [&rid], |r| {
            r.get::<_, i64>(0)
        })
    }) > 0
}

/// Mark a record deleted at `at` (what the records API will do).
pub fn trash_record(app: &TestApp, record_id: &str, at: i64) {
    let rid = record_id.to_string();
    sql(app, |tx| {
        tx.execute(
            "UPDATE records SET deleted_at = ?2 WHERE id = ?1",
            params![rid, at],
        )
    });
}

/// Rewind a trashed item's `deleted_at` (kind: tables|fields|views|bases|workspaces|records).
pub fn set_deleted_at(app: &TestApp, kind: &str, id: &str, at: i64) {
    let sql_text = format!("UPDATE {kind} SET deleted_at = ?2 WHERE id = ?1");
    let id = id.to_string();
    sql(app, |tx| tx.execute(&sql_text, params![id, at]));
}

pub fn count(app: &TestApp, sql_text: &str, arg: &str) -> i64 {
    let (q, a) = (sql_text.to_string(), arg.to_string());
    sql(app, |tx| tx.query_row(&q, [&a], |r| r.get(0)))
}

pub fn ids_in(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| ids_in(x, out)),
        Value::Object(o) => o.values().for_each(|x| ids_in(x, out)),
        _ => {}
    }
}
