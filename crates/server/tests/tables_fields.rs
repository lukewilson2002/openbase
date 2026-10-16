//! `POST /api/bases/{id}/tables` with `fields`: a whole table in one call, all or nothing.

mod common;
mod schema_support;

use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn tables_url(f: &Fixture) -> String {
    format!("/api/bases/{}/tables", f.base_id)
}

fn field_of<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("no field {name}"))
}

#[tokio::test]
async fn create_table_with_fields_builds_the_whole_table_in_one_call() {
    let f = Fixture::new().await;
    let r = f
        .app
        .post(
            &f.owner,
            &tables_url(&f),
            json!({
                "name": "Roadmap",
                "icon": "map",
                "fields": [
                    { "name": "Status", "type": "single_select",
                      "options": { "choices": [{ "name": "Todo" }, { "name": "Done" }] },
                      "description": "Where it stands" },
                    { "name": "Points", "type": "number", "options": { "precision": 1 } },
                    { "name": "Due", "type": "date" },
                    { "name": "Double", "type": "formula",
                      "options": { "expression": "{Points} * 2" } },
                    { "name": "Parent", "type": "link",
                      "options": { "linked_table_id": f.table_id },
                      "inverse_name": "Roadmap items" },
                    { "name": "Parent notes", "type": "lookup",
                      "options": { "link_field_id": "parent", "target_field_id": f.notes_id } },
                    { "name": "Edited", "type": "last_modified_time",
                      "options": { "fields": ["points", "Name"] } }
                ]
            }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["icon"], "map");
    // Name first (the primary field), then exactly the listed fields in order: no Notes.
    assert_eq!(
        Fixture::field_names(&r.body),
        [
            "Name",
            "Status",
            "Points",
            "Due",
            "Double",
            "Parent",
            "Parent notes",
            "Edited"
        ]
    );
    assert_eq!(r.body["fields"][0]["id"], r.body["primary_field_id"]);
    let status = field_of(&r.body, "Status");
    assert_eq!(status["description"], "Where it stands");
    assert_eq!(status["options"]["choices"].as_array().unwrap().len(), 2);
    // A reference by name inside the same request resolves to the new field's id.
    let parent = field_of(&r.body, "Parent");
    assert_eq!(
        field_of(&r.body, "Parent notes")["options"]["link_field_id"],
        parent["id"]
    );
    assert_eq!(
        field_of(&r.body, "Edited")["options"]["fields"],
        json!([
            field_of(&r.body, "Points")["id"],
            r.body["primary_field_id"]
        ])
    );
    // The link's inverse exists in the other table, and the schema agrees with the response.
    let s = f.schema().await;
    let table = |id: &Value| {
        s["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == *id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        field_of(&table(&json!(f.table_id)), "Roadmap items")["type"],
        "link"
    );
    assert_eq!(
        Fixture::field_names(&table(&r.body["id"])),
        Fixture::field_names(&r.body)
    );
}

#[tokio::test]
async fn create_table_with_a_bad_field_creates_nothing() {
    let f = Fixture::new().await;
    let before = f.schema().await;
    let good = json!({ "name": "Qty", "type": "number" });
    // (the bad second field, the status it earns, a text the message must contain)
    let cases = [
        (
            json!({ "name": "X", "type": "no_such_type" }),
            400,
            "fields[1] 'X'",
        ),
        (json!({ "type": "number" }), 400, "fields[1]"),
        (
            json!({ "name": "Qty", "type": "number" }),
            409,
            "fields[1] 'Qty'",
        ),
        (
            json!({ "name": "qty", "type": "number" }),
            409,
            "fields[1] 'qty'",
        ),
        (
            json!({ "name": "Name", "type": "number" }),
            409,
            "fields[1] 'Name'",
        ),
        (json!({ "name": " ", "type": "number" }), 400, "fields[1]"),
        (
            json!({ "name": "Bad link", "type": "link",
                    "options": { "linked_table_id": "tblNOPE" } }),
            400,
            "fields[1] 'Bad link'",
        ),
        (
            json!({ "name": "Bad formula", "type": "formula",
                    "options": { "expression": "{Nope} + " } }),
            400,
            "fields[1] 'Bad formula'",
        ),
        (
            json!({ "name": "Loose", "type": "lookup",
                    "options": { "link_field_id": "nothing" } }),
            400,
            "fields[1] 'Loose'",
        ),
    ];
    for (bad, status, needle) in cases {
        let r = f
            .app
            .post(
                &f.owner,
                &tables_url(&f),
                json!({ "name": "Atomic", "fields": [good.clone(), bad.clone()] }),
            )
            .await;
        r.assert_status(status);
        let msg = r.body["error"]["message"].as_str().unwrap();
        assert!(msg.contains(needle), "{bad}: {msg}");
        // not even a half-built table: the schema is untouched
        assert_eq!(f.schema().await, before, "{bad}");
    }
    // a non-array `fields` and a non-object entry are plain bad requests
    for bad in [json!("Qty"), json!(["Qty"]), json!([null])] {
        f.app
            .post(
                &f.owner,
                &tables_url(&f),
                json!({ "name": "Atomic", "fields": bad }),
            )
            .await
            .assert_status(400);
    }
    assert_eq!(f.schema().await, before);
    // and the table name is still free
    f.app
        .post(
            &f.owner,
            &tables_url(&f),
            json!({ "name": "Atomic", "fields": [good] }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn create_table_fields_respect_roles_and_the_field_limit() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    f.app
        .post(
            &editor,
            &tables_url(&f),
            json!({ "name": "Nope", "fields": [{ "name": "Qty", "type": "number" }] }),
        )
        .await
        .assert_status(403);
    // at most 500 fields per table, the primary field included
    let many = |n: usize| -> Vec<Value> {
        (0..n)
            .map(|i| json!({ "name": format!("F{i}"), "type": "number" }))
            .collect()
    };
    let r = f
        .app
        .post(
            &f.owner,
            &tables_url(&f),
            json!({ "name": "Wide", "fields": many(500) }),
        )
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("500"));
    let r = f
        .app
        .post(
            &f.owner,
            &tables_url(&f),
            json!({ "name": "Wide", "fields": many(499) }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["fields"].as_array().unwrap().len(), 500);
}
