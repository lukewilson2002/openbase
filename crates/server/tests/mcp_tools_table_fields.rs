//! `create_table` with a `fields` list through MCP: one call per table, names instead of ids,
//! all or nothing, and the same starting fields as a new base's first table.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

fn names(table: &Value) -> Vec<&str> {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn a_table_is_set_up_in_one_call() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    a.call(
        "create_table",
        json!({"base_id": b, "name": "Customers",
               "fields": [{"name": "Email", "type": "email"}]}),
    )
    .await;
    let t = a
        .call(
            "create_table",
            json!({"base_id": b, "name": "Roadmap", "icon": "map", "fields": [
                {"name": "Status", "type": "single_select",
                 "options": {"choices": ["Todo", {"name": "Done", "color": "green"}]}},
                {"name": "Points", "type": "number", "options": {"precision": 1}},
                {"name": "Owner", "type": "link", "options": {"linked_table": "Customers"},
                 "inverse_name": "Roadmap"},
                {"name": "Owner email", "type": "lookup",
                 "options": {"link_field": "Owner", "target_field": "Email"}},
                {"name": "Owners", "type": "count", "options": {"link_field": "Owner"}},
                {"name": "Double", "type": "formula", "options": {"expression": "{Points} * 2"}},
                {"name": "Touched", "type": "last_modified_time",
                 "options": {"fields": ["Points", "Name"]}}
            ]}),
        )
        .await["table"]
        .clone();
    assert_eq!(t["icon"], "map");
    assert_eq!(t["primary_field"], "Name");
    assert_eq!(
        names(&t),
        [
            "Name",
            "Status",
            "Points",
            "Owner",
            "Owner email",
            "Owners",
            "Double",
            "Touched"
        ]
    );
    let status = &t["fields"][1];
    assert_eq!(status["type"], "single_select");
    assert_eq!(status["options"]["choices"].as_array().unwrap().len(), 2);

    // The table works: a record can use the new fields, and the inverse link is in Customers.
    let ada = r
        .records(
            "Customers",
            json!([{"fields": {"Name": "Ada", "Email": "ada@example.com"}}]),
        )
        .await[0]["id"]
        .clone();
    r.records(
        "Roadmap",
        json!([{"fields": {"Name": "Ship", "Status": "Todo", "Points": 3, "Owner": [ada]}}]),
    )
    .await;
    let rows = a
        .call("list_records", json!({"base_id": b, "table": "Roadmap"}))
        .await;
    let fields = &rows["records"][0]["fields"];
    assert_eq!(fields["Double"], 6);
    assert_eq!(fields["Owner email"], json!(["ada@example.com"]));
    assert_eq!(fields["Owners"], 1);
    let schema = r.schema().await;
    let customers = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Customers")
        .unwrap();
    assert_eq!(names(customers), ["Name", "Email", "Roadmap"]);
}

#[tokio::test]
async fn a_bad_field_fails_the_call_and_creates_nothing() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    let before = r.schema().await;
    let good = json!({"name": "Qty", "type": "number"});
    for (bad, needle) in [
        (
            json!({"name": "X", "type": "wat"}),
            "Unknown field type 'wat'",
        ),
        (json!({"name": "Qty", "type": "number"}), "Qty"),
        (json!({"name": "Name", "type": "text"}), "Name"),
        (
            json!({"name": "Link", "type": "link", "options": {"linked_table": "Nowhere"}}),
            "Nowhere",
        ),
        (
            json!({"name": "Look", "type": "lookup",
                   "options": {"link_field": "Qty", "target_field": "Name"}}),
            "not a link field",
        ),
        (
            json!({"name": "Look", "type": "count"}),
            "options.link_field",
        ),
        (
            json!({"name": "Formula", "type": "formula", "options": {"expression": "{Nope}"}}),
            "Formula",
        ),
    ] {
        let e = a
            .fails(
                "create_table",
                json!({"base_id": b, "name": "Atomic", "fields": [good.clone(), bad.clone()]}),
            )
            .await;
        assert!(e.contains("fields[1]") && e.contains(needle), "{bad}: {e}");
        assert_eq!(r.schema().await, before, "{bad}");
    }
    // unknown keys in an entry are refused like create_field's
    let e = a
        .fails(
            "create_table",
            json!({"base_id": b, "name": "Atomic",
                   "fields": [{"name": "A", "type": "number", "table": "x"}]}),
        )
        .await;
    assert!(e.contains("Invalid arguments"), "{e}");
    assert_eq!(r.schema().await, before);
    // with the problem fixed the same name works
    a.call(
        "create_table",
        json!({"base_id": b, "name": "Atomic", "fields": [good]}),
    )
    .await;
}

#[tokio::test]
async fn every_new_table_starts_the_same_way() {
    let r = Rig::new().await;
    let a = &r.agent;
    // The first table of a new base and a table added later have the same fields.
    let created = a
        .call(
            "create_base",
            json!({"workspace_id": r.ws, "name": "Another"}),
        )
        .await;
    let first = names(&created["base"]["tables"][0]).join(",");
    let later = a
        .call(
            "create_table",
            json!({"base_id": created["base"]["id"], "name": "Later"}),
        )
        .await;
    assert_eq!(first, "Name");
    assert_eq!(names(&later["table"]).join(","), first);
    // An empty list adds nothing; a list adds exactly what it names, never Notes.
    let none = a
        .call(
            "create_table",
            json!({"base_id": r.base, "name": "None", "fields": []}),
        )
        .await;
    assert_eq!(names(&none["table"]), ["Name"]);
    let some = a
        .call(
            "create_table",
            json!({"base_id": r.base, "name": "Some",
                   "fields": [{"name": "Qty", "type": "number"}]}),
        )
        .await;
    assert_eq!(names(&some["table"]), ["Name", "Qty"]);
    // The tool says so.
    let (_, listing) = a.rpc("tools/list", json!({})).await;
    let ct = listing["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "create_table")
        .expect("create_table is listed");
    let text = ct["description"].as_str().unwrap();
    assert!(text.contains("just the primary text field"), "{text}");
    assert!(ct["inputSchema"]["properties"]["fields"].is_object());
}
