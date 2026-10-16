//! Helpers for the schema-plane integration tests (workspaces, bases, tables,
//! fields, views, trash): build fixtures through the real API, set roles by
//! inserting membership rows, and poke the database directly where the API
//! for it does not exist yet (records).
#![allow(dead_code)]

use openbase::config::Config;
use openbase::perm::Role;
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
        .write_sync(|tx| f(tx).map_err(openbase::error::AppError::from))
        .unwrap()
}

/// Make `user` a member of `ws` with `role` and every base.
pub fn add_ws_member(app: &TestApp, ws: &str, user: &Client, role: Role) {
    let (ws, uid, role) = (ws.to_string(), user.user_id.clone().unwrap(), role.as_str());
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role, all_bases, created_at)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role, all_bases = 1",
            params![ws, uid, role, openbase::db::now_ms()],
        )
    });
}

/// Make `user` a member of the base's workspace with `role`, limited to this
/// base (added to their list if they are already limited to others).
pub fn add_base_member(app: &TestApp, base: &str, user: &Client, role: Role) {
    let (base, uid, role) = (
        base.to_string(),
        user.user_id.clone().unwrap(),
        role.as_str(),
    );
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role, all_bases, created_at)
             SELECT workspace_id, ?2, ?3, 0, ?4 FROM bases WHERE id = ?1
             ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role",
            params![base, uid, role, openbase::db::now_ms()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO workspace_member_bases (workspace_id, user_id, base_id)
             SELECT workspace_id, ?2, id FROM bases WHERE id = ?1",
            params![base, uid],
        )
    });
}

/// A bearer-token client for `user` (API token, full write scope).
pub fn token_client(app: &TestApp, user: &Client, write: bool) -> Client {
    let token = format!("pat_test_{}", openbase::ids::new_id("x"));
    let hash = openbase::ids::hash_token(&token);
    let uid = user.user_id.clone().unwrap();
    let scopes = json!({ "write": write, "base_ids": null }).to_string();
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES (?1, ?2, 't', ?3, ?4, 1)",
            params![openbase::ids::new_id("pat"), uid, hash, scopes],
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

    /// A new user with `role` in the fixture's workspace, limited to its base.
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
    let id = openbase::ids::new_id("rec");
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

// ---------------------------------------------------------------------------
// A base exercising everything duplication has to remap.
// ---------------------------------------------------------------------------

pub struct Rich {
    pub f: Fixture,
    pub t1: String,
    pub t2: String,
    pub status: Value,
    pub tags: Value,
    pub qty: Value,
    pub files: Value,
    pub orders: Value,
    pub price: Value,
    pub prices: Value,
    pub parent: Value,
    pub double_id: String,
    pub att_id: String,
    pub r1: String,
    pub r2: String,
    pub o1: String,
    pub o2: String,
    pub o3_trashed: String,
}

pub fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

/// T1 "Table 1": Name, Notes, Status (single select), Tags (multi select), Qty,
/// Files (attachment), Orders (link to T2), Prices (lookup), N (count), Total
/// (rollup). T2 "Orders": Name, Price, Table 1 (inverse), Parent + inverse
/// (self link), Double (a stored formula `{Price} * 2`). Views with ids in
/// their configs, a personal view of the owner and one of someone else, and
/// records on both sides including a trashed one.
pub async fn rich_base() -> Rich {
    let f = Fixture::new().await;
    let t1 = f.table_id.clone();
    let t2tbl = f.add_table("Orders").await;
    let t2 = id_of(&t2tbl);
    let status = f
        .add_field(
            &t1,
            json!({ "name": "Status", "type": "single_select",
                "options": { "choices": [ { "name": "Todo" }, { "name": "Done" } ] } }),
        )
        .await;
    let tags = f
        .add_field(
            &t1,
            json!({ "name": "Tags", "type": "multiple_select",
                "options": { "choices": [ { "name": "a" }, { "name": "b" } ] } }),
        )
        .await;
    let qty = f
        .add_field(
            &t1,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let files = f
        .add_field(
            &t1,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let orders = f.add_link(&t1, "Orders", &t2).await;
    let price = f
        .add_field(
            &t2,
            json!({ "name": "Price", "type": "number", "options": {} }),
        )
        .await;
    let prices = f
        .add_field(
            &t1,
            json!({ "name": "Prices", "type": "lookup",
                "options": { "link_field_id": orders["id"], "target_field_id": price["id"] } }),
        )
        .await;
    let count = f
        .add_field(
            &t1,
            json!({ "name": "N", "type": "count", "options": { "link_field_id": orders["id"] } }),
        )
        .await;
    f.add_field(
        &t1,
        json!({ "name": "Total", "type": "rollup",
            "options": { "link_field_id": orders["id"], "target_field_id": price["id"], "expression": "SUM(values)" } }),
    )
    .await;
    let parent = f.add_link(&t2, "Parent", &t2).await;

    // A formula in stored form: the placeholder API cannot make one, the real engine will.
    let double_id = openbase::ids::new_id("fld");
    {
        let (did, t2c, expr) = (
            double_id.clone(),
            t2.clone(),
            format!("{{{}}} * 2", id_of(&price)),
        );
        sql(&f.app, move |tx| {
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, 'Double', 'formula', ?3, 99, 1)",
                params![
                    did,
                    t2c,
                    json!({ "expression": expr, "result_type": "number" }).to_string()
                ],
            )
        });
    }

    // Views.
    let todo = status["options"]["choices"][0]["id"].clone();
    let grid_id = f.view_id.clone();
    f.app
        .patch(
            &f.owner,
            &format!("/api/views/{grid_id}"),
            json!({ "config": {
                "filter": { "items": [ { "field_id": status["id"], "op": "is_any_of", "value": [todo] } ] },
                "sorts": [ { "field_id": qty["id"], "direction": "desc" } ],
                "hidden_fields": [tags["id"]],
                "field_widths": { (id_of(&qty)): 120 },
                "summaries": { (id_of(&qty)): "sum" } } }),
        )
        .await
        .assert_status(200);
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{t1}/views"),
            json!({ "name": "Board", "type": "kanban",
                "config": { "kanban": { "stack_field_id": status["id"], "stack_order": [todo] } } }),
        )
        .await
        .assert_status(201);
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{t1}/views"),
            json!({ "name": "Intake", "type": "form" }),
        )
        .await
        .assert_status(201);
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{t1}/views"),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await
        .assert_status(201);
    let other = f.member("other-editor@example.com", Role::Editor);
    f.app
        .post(
            &other,
            &format!("/api/tables/{t1}/views"),
            json!({ "name": "Theirs", "type": "grid", "personal": true }),
        )
        .await
        .assert_status(201);

    // Attachment and records.
    let att_id = openbase::ids::new_id("att");
    {
        let (aid, base) = (att_id.clone(), f.base_id.clone());
        sql(&f.app, move |tx| {
            tx.execute(
                "INSERT INTO attachments (id, sha256, filename, mime, size, base_id, created_at)
                 VALUES (?1, 'abc123', 'doc.pdf', 'application/pdf', 10, ?2, 1)",
                params![aid, base],
            )
        });
    }
    let pid = f.primary_id.clone();
    let t2_primary = id_of(&f.table(&t2).await["fields"][0]);
    let inverse_of_orders = id_of(&orders["inverse"]);
    let parent_inv = id_of(&parent["inverse"]);
    let choice = |field: &Value, i: usize| field["options"]["choices"][i]["id"].clone();

    let o1 = insert_record(&f.app, &t2, json!({}));
    let o2 = insert_record(&f.app, &t2, json!({}));
    let o3 = insert_record(&f.app, &t2, json!({}));
    let r1 = insert_record(&f.app, &t1, json!({}));
    let r2 = insert_record(&f.app, &t1, json!({}));
    set_data(
        &f.app,
        &r1,
        json!({
            &pid: "Alice", id_of(&status): choice(&status, 0), id_of(&tags): [choice(&tags, 0), choice(&tags, 1)],
            id_of(&qty): 3, id_of(&files): [ { "id": att_id, "filename": "doc.pdf", "mime": "application/pdf", "size": 10 } ],
            id_of(&orders): [o1, o2], id_of(&prices): [10, 20], id_of(&count): 2 }),
    );
    set_data(
        &f.app,
        &r2,
        json!({ &pid: "Bob", id_of(&status): choice(&status, 1), id_of(&orders): [o3] }),
    );
    set_data(
        &f.app,
        &o1,
        json!({ &t2_primary: "Order 1", id_of(&price): 10, &inverse_of_orders: [r1], id_of(&parent): [o2] }),
    );
    set_data(
        &f.app,
        &o2,
        json!({ &t2_primary: "Order 2", id_of(&price): 20, &inverse_of_orders: [r1], &parent_inv: [o1] }),
    );
    set_data(
        &f.app,
        &o3,
        json!({ &t2_primary: "Order 3", &inverse_of_orders: [r2] }),
    );
    trash_record(&f.app, &o3, 5);

    Rich {
        f,
        t1,
        t2,
        status,
        tags,
        qty,
        files,
        orders,
        price,
        prices,
        parent,
        double_id,
        att_id,
        r1,
        r2,
        o1,
        o2,
        o3_trashed: o3,
    }
}

pub fn set_data(app: &TestApp, record_id: &str, data: Value) {
    let (rid, d) = (record_id.to_string(), data.to_string());
    sql(app, |tx| {
        tx.execute(
            "UPDATE records SET data = ?2 WHERE id = ?1",
            params![rid, d],
        )
    });
}

pub type RecordDump = std::collections::BTreeMap<String, (String, Value, Option<i64>)>;

/// All records (live and trashed) of every table of a base: id -> (table id, data, deleted_at).
pub fn dump_records(app: &TestApp, base_id: &str) -> RecordDump {
    let b = base_id.to_string();
    sql(app, |tx| {
        let mut stmt = tx.prepare(
            "SELECT r.id, r.table_id, r.data, r.deleted_at FROM records r
             JOIN tables t ON t.id = r.table_id WHERE t.base_id = ?1",
        )?;
        let rows = stmt
            .query_map([&b], |r| {
                let data: String = r.get(2)?;
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, String>(1)?,
                        serde_json::from_str(&data).unwrap(),
                        r.get(3)?,
                    ),
                ))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    })
}

pub fn id_str(v: &Value) -> &str {
    v.as_str().unwrap()
}

/// Link pairs agree on both sides in the schema.
pub fn assert_link_pairs_consistent(schema: &Value) -> usize {
    let tables = schema["tables"].as_array().unwrap();
    let find = |id: &str| {
        tables
            .iter()
            .flat_map(|t| t["fields"].as_array().unwrap().iter())
            .find(|f| f["id"] == id)
    };
    let mut links = 0;
    for t in tables {
        for f in t["fields"].as_array().unwrap() {
            if f["type"] != "link" {
                continue;
            }
            links += 1;
            let inv = find(id_str(&f["options"]["inverse_field_id"]))
                .expect("inverse exists in the copy");
            assert_eq!(inv["type"], "link");
            assert_eq!(
                inv["options"]["inverse_field_id"], f["id"],
                "inverse points back"
            );
            assert_eq!(inv["table_id"], f["options"]["linked_table_id"]);
            assert_eq!(f["table_id"], inv["options"]["linked_table_id"]);
        }
    }
    links
}

/// Both sides of every link array agree.
pub fn assert_link_arrays_consistent(schema: &Value, records: &RecordDump) -> usize {
    let mut checked = 0;
    for t in schema["tables"].as_array().unwrap() {
        for f in t["fields"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "link")
        {
            let (lid, inv) = (id_str(&f["id"]), id_str(&f["options"]["inverse_field_id"]));
            for (rid, (table_id, data, _)) in records {
                if table_id != id_str(&t["id"]) {
                    continue;
                }
                for other in data
                    .get(lid)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let (other_table, other_data, _) = records
                        .get(id_str(other))
                        .unwrap_or_else(|| panic!("dangling link {other}"));
                    assert_eq!(other_table, id_str(&f["options"]["linked_table_id"]));
                    let back = other_data
                        .get(inv)
                        .and_then(Value::as_array)
                        .unwrap_or_else(|| panic!("no inverse array on {other}"));
                    assert!(
                        back.iter().any(|v| v == rid.as_str()),
                        "{other}.{inv} should contain {rid}"
                    );
                    checked += 1;
                }
            }
        }
    }
    checked
}
