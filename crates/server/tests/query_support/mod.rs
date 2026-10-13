//! Helpers for the read-path tests (view queries, aggregations, lookup):
//! configure the fixture's grid view through the API, run queries and pull
//! ids and cells out of the responses.
#![allow(dead_code)]

use serde_json::{Value, json};

pub use crate::records_support::*;

/// A table with one field of each common type and five records.
pub struct People {
    pub f: Fixture,
    pub name: String,
    pub age: String,
    pub status: String,
    pub tags: String,
    pub due: String,
    pub done: String,
    /// Record ids in creation (manual) order: Alice, bob, Carol, dave, Eve.
    pub ids: Vec<String>,
}

impl People {
    pub fn view(&self) -> &str {
        &self.f.view_id
    }
}

/// Alice 30 Todo [a] 2026-03-01; bob 25 Doing [a,b] 2026-03-10; Carol 41
/// Done [] 2026-03-20 (checked); dave (nothing but a name); Eve 30 Todo [b]
/// (no date).
pub async fn people() -> People {
    people_with(|_| {}).await
}

/// [`people`] on an app with a tweaked configuration.
pub async fn people_with(config: impl FnOnce(&mut openbase::config::Config)) -> People {
    let f = Fixture::with_config(config).await;
    let t = f.table_id.clone();
    let name = f.primary_id.clone();
    let age = id_of(&f.number(&t, "Age").await);
    let status = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Status", "type": "single_select",
                    "options": { "choices": [
                        { "name": "Todo" }, { "name": "Doing" }, { "name": "Done" } ] } }),
        )
        .await,
    );
    let tags = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Tags", "type": "multiple_select",
                    "options": { "choices": [ { "name": "a" }, { "name": "b" } ] } }),
        )
        .await,
    );
    let due = id_of(
        &f.add_field(&t, json!({ "name": "Due", "type": "date", "options": {} }))
            .await,
    );
    let done = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Done", "type": "checkbox", "options": {} }),
        )
        .await,
    );
    let rows = [
        json!({ &name: "Alice", &age: 30, &status: "Todo", &tags: ["a"], &due: "2026-03-01" }),
        json!({ &name: "bob", &age: 25, &status: "Doing", &tags: ["a", "b"], &due: "2026-03-10" }),
        json!({ &name: "Carol", &age: 41, &status: "Done", &due: "2026-03-20", &done: true }),
        json!({ &name: "dave" }),
        json!({ &name: "Eve", &age: 30, &status: "Todo", &tags: ["b"] }),
    ];
    let r = f
        .app
        .post(
            &f.owner,
            &records_url(&t),
            json!({ "records": rows.iter().map(|v| json!({ "values": v })).collect::<Vec<_>>() }),
        )
        .await;
    r.assert_status(201);
    let ids = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(id_of)
        .collect();
    People {
        f,
        name,
        age,
        status,
        tags,
        due,
        done,
        ids,
    }
}

impl Fixture {
    /// Replace the config of the fixture's default grid view.
    pub async fn configure(&self, config: Value) {
        self.configure_view(&self.view_id, config).await;
    }

    pub async fn configure_view(&self, view_id: &str, config: Value) {
        let r = self
            .app
            .patch(
                &self.owner,
                &format!("/api/views/{view_id}"),
                json!({ "config": config }),
            )
            .await;
        r.assert_status(200);
    }

    /// Create a shared grid view with `config`; returns its id.
    pub async fn new_view(&self, table_id: &str, name: &str, config: Value) -> String {
        let r = self
            .app
            .post(
                &self.owner,
                &format!("/api/tables/{table_id}/views"),
                json!({ "name": name, "type": "grid", "config": config }),
            )
            .await;
        r.assert_status(201);
        id_of(&r.body)
    }

    /// Query the default view as the owner; asserts 200.
    pub async fn query(&self, body: Value) -> Value {
        self.query_view(&self.view_id, body).await
    }

    pub async fn query_view(&self, view_id: &str, body: Value) -> Value {
        let r = self.query_as(&self.owner, view_id, body).await;
        r.assert_status(200);
        r.body.clone()
    }

    pub async fn query_as(
        &self,
        c: &crate::common::Client,
        view_id: &str,
        body: Value,
    ) -> crate::common::Response {
        self.app
            .post(c, &format!("/api/views/{view_id}/query"), body)
            .await
    }

    pub async fn aggregations(&self, view_id: &str) -> Value {
        let r = self
            .app
            .get(&self.owner, &format!("/api/views/{view_id}/aggregations"))
            .await;
        r.assert_status(200);
        r.body["values"].clone()
    }

    /// The `{id,name}` of choice `name` in a select field.
    pub async fn choice_id(&self, table_id: &str, field_name: &str, choice: &str) -> String {
        let field = self.field(table_id, field_name).await;
        field["options"]["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == choice)
            .map(|c| id_str(&c["id"]))
            .unwrap_or_else(|| panic!("no choice {choice}"))
    }
}

pub fn id_str(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

/// Record ids of a query response, in order.
pub fn rec_ids(resp: &Value) -> Vec<String> {
    resp["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| id_str(&r["id"]))
        .collect()
}

/// The values of one field across the records of a query response.
pub fn column(resp: &Value, field_id: &str) -> Vec<Value> {
    resp["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["values"][field_id].clone())
        .collect()
}

/// The primary names of a query response, in order.
pub fn names(p: &People, resp: &Value) -> Vec<String> {
    column(resp, &p.name)
        .iter()
        .map(|v| v.as_str().unwrap_or("").to_string())
        .collect()
}

/// Names of the records matching `filter` in the default view.
pub async fn filtered(p: &People, filter: Value) -> Vec<String> {
    p.f.configure(json!({ "filter": filter })).await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["total"], resp["records"].as_array().unwrap().len());
    names(p, &resp)
}

pub fn cond(field: &str, op: &str, value: Value) -> Value {
    json!({ "field_id": field, "op": op, "value": value })
}

pub fn and(items: Vec<Value>) -> Value {
    json!({ "conjunction": "and", "items": items })
}

pub fn or(items: Vec<Value>) -> Value {
    json!({ "conjunction": "or", "items": items })
}
