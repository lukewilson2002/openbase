//! Helpers for the record write-path tests: create/patch/delete through the
//! real API and read stored data back. Builds on `schema_support`.
#![allow(dead_code)]

use serde_json::{Value, json};

use crate::common::{Client, Response};
pub use crate::schema_support::*;

pub fn sid(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

pub fn records_url(table_id: &str) -> String {
    format!("/api/tables/{table_id}/records")
}

impl Fixture {
    /// POST one record as the owner; asserts 201 and returns the record.
    pub async fn create(&self, table_id: &str, values: Value) -> Value {
        let r = self.create_as(&self.owner, table_id, values).await;
        r.assert_status(201);
        r.body["records"][0].clone()
    }

    pub async fn create_as(&self, c: &Client, table_id: &str, values: Value) -> Response {
        self.app
            .post(
                c,
                &records_url(table_id),
                json!({ "records": [ { "values": values } ] }),
            )
            .await
    }

    pub async fn create_typecast(&self, table_id: &str, values: Value) -> Response {
        self.app
            .post(
                &self.owner,
                &records_url(table_id),
                json!({ "records": [ { "values": values } ], "typecast": true }),
            )
            .await
    }

    /// PATCH one record as the owner; asserts 200 and returns the record.
    pub async fn set(&self, table_id: &str, id: &str, values: Value) -> Value {
        let r = self.patch_as(&self.owner, table_id, id, values).await;
        r.assert_status(200);
        r.body["records"][0].clone()
    }

    pub async fn patch_as(&self, c: &Client, table_id: &str, id: &str, values: Value) -> Response {
        self.app
            .patch(
                c,
                &records_url(table_id),
                json!({ "records": [ { "id": id, "values": values } ] }),
            )
            .await
    }

    pub async fn delete_records(&self, table_id: &str, ids: &[&str]) -> Response {
        self.app
            .request(
                &self.owner,
                "DELETE",
                &records_url(table_id),
                Some(json!({ "ids": ids })),
            )
            .await
    }

    pub async fn restore_records(&self, table_id: &str, ids: &[&str]) -> Response {
        self.app
            .post(
                &self.owner,
                &format!("{}/restore", records_url(table_id)),
                json!({ "ids": ids }),
            )
            .await
    }

    /// GET a record as the owner (asserts 200).
    pub async fn get(&self, table_id: &str, id: &str) -> Value {
        let r = self
            .app
            .get(&self.owner, &format!("{}/{id}", records_url(table_id)))
            .await;
        r.assert_status(200);
        r.body.clone()
    }

    /// `values[field_id]` of a record read through the API.
    pub async fn value(&self, table_id: &str, id: &str, field_id: &str) -> Value {
        self.get(table_id, id).await["values"][field_id].clone()
    }

    /// Stored `data[field_id]` read straight from the database.
    pub fn stored(&self, record_id: &str, field_id: &str) -> Value {
        self.record_data(record_id)[field_id].clone()
    }

    pub async fn field(&self, table_id: &str, name: &str) -> Value {
        self.table(table_id).await["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("no field named {name}"))
    }

    pub async fn number(&self, table_id: &str, name: &str) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "number", "options": {} }),
        )
        .await
    }

    pub async fn formula(&self, table_id: &str, name: &str, expression: &str) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "formula", "options": { "expression": expression } }),
        )
        .await
    }

    pub async fn lookup(&self, table_id: &str, name: &str, link: &Value, target: &Value) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "lookup",
                    "options": { "link_field_id": link["id"], "target_field_id": target["id"] } }),
        )
        .await
    }

    pub async fn rollup(
        &self,
        table_id: &str,
        name: &str,
        link: &Value,
        target: &Value,
        expression: &str,
    ) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "rollup",
                    "options": { "link_field_id": link["id"], "target_field_id": target["id"],
                                 "expression": expression } }),
        )
        .await
    }

    pub async fn count(&self, table_id: &str, name: &str, link: &Value) -> Value {
        self.add_field(
            table_id,
            json!({ "name": name, "type": "count", "options": { "link_field_id": link["id"] } }),
        )
        .await
    }

    /// History rows of a record, oldest first: (kind, changes, user_id).
    pub fn history(&self, record_id: &str) -> Vec<(String, Value, Option<String>)> {
        let rid = record_id.to_string();
        sql(&self.app, |tx| {
            let mut stmt = tx.prepare(
                "SELECT kind, changes, user_id FROM record_history WHERE record_id = ?1 ORDER BY id",
            )?;
            let rows = stmt
                .query_map([&rid], |r| {
                    let c: String = r.get(1)?;
                    Ok((r.get(0)?, serde_json::from_str(&c).unwrap(), r.get(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// (position, autonumber, updated_at, updated_by, deleted_at) columns.
    pub fn columns(&self, record_id: &str) -> (f64, i64, i64, Option<String>, Option<i64>) {
        let rid = record_id.to_string();
        sql(&self.app, |tx| {
            tx.query_row(
                "SELECT position, autonumber, updated_at, updated_by, deleted_at FROM records WHERE id = ?1",
                [&rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
        })
    }

    /// Record ids of a table in manual order (live only).
    pub fn order(&self, table_id: &str) -> Vec<String> {
        let tid = table_id.to_string();
        sql(&self.app, |tx| {
            let mut stmt = tx.prepare(
                "SELECT id FROM records WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
            )?;
            let rows = stmt
                .query_map([&tid], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
    }
}

/// Link ids stored in a record's data for `field_id`.
pub fn stored_ids(f: &Fixture, record_id: &str, field_id: &str) -> Vec<String> {
    f.record_data(record_id)[field_id]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

/// Ids in a link value as returned by the API (`[{id, name}]`).
pub fn link_ids_of(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| x["id"].as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

pub fn link_names(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| x["name"].as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

/// Two tables "Table 1" (fixture) and "Orders" linked by `Orders` / `Customer`
/// (inverse), with a number `Price` on Orders.
pub struct Linked {
    pub f: Fixture,
    pub t1: String,
    pub t2: String,
    /// The link field in Table 1 (`Orders`).
    pub link: Value,
    /// Its inverse in Orders (`Table 1`).
    pub inverse: Value,
    pub price: Value,
}

pub async fn linked() -> Linked {
    let f = Fixture::new().await;
    let t1 = f.table_id.clone();
    let t2tbl = f.add_table("Orders").await;
    let t2 = id_of(&t2tbl);
    let link = f.add_link(&t1, "Orders", &t2).await;
    let inverse = link["inverse"].clone();
    let price = f.number(&t2, "Price").await;
    Linked {
        f,
        t1,
        t2,
        link,
        inverse,
        price,
    }
}
