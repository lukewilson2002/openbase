//! Bases, tables, fields and views through MCP tools: all 28 field types, names instead of ids,
//! type changes that warn first, partial view updates, and the error messages a model needs.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

// --------------------------------------------------------------------------------- bases

#[tokio::test]
async fn bases_and_tables_can_be_renamed_duplicated_deleted_and_restored() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();

    let renamed = a
        .call(
            "rename_base",
            json!({"base_id": b, "name": "Renamed", "color": "red"}),
        )
        .await;
    assert_eq!(renamed["base"]["name"], "Renamed");
    assert_eq!(renamed["base"]["color"], "red");
    assert!(
        a.fails("rename_base", json!({"base_id": b}))
            .await
            .contains("name, colour or icon")
    );

    // Tables
    let t = r.table("People").await;
    assert_eq!(t["primary_field"], "Name");
    assert_eq!(t["views"][0]["type"], "grid");
    r.records("People", json!([{"fields": {"Name": "Ada"}}]))
        .await;
    let copy = a
        .call(
            "duplicate_table",
            json!({"base_id": b, "table": "People", "name": "People copy"}),
        )
        .await;
    assert_eq!(copy["table"]["name"], "People copy");
    let rows = a
        .call(
            "list_records",
            json!({"base_id": b, "table": "People copy"}),
        )
        .await;
    assert_eq!(rows["count"], 1, "records are copied by default");
    let empty = a
        .call(
            "duplicate_table",
            json!({"base_id": b, "table": "People", "name": "Shell", "include_records": false}),
        )
        .await;
    assert_eq!(empty["table"]["name"], "Shell");
    assert_eq!(
        a.call("list_records", json!({"base_id": b, "table": "Shell"}))
            .await["count"],
        0
    );

    let t2 = a
        .call(
            "rename_table",
            json!({"base_id": b, "table": "People copy", "name": "Staff", "description": "Everyone"}),
        )
        .await;
    assert_eq!(t2["table"]["name"], "Staff");
    assert_eq!(t2["table"]["description"], "Everyone");

    // Delete a table: it moves to the trash and comes back with its records.
    let del = a
        .call("delete_table", json!({"base_id": b, "table": "Staff"}))
        .await;
    let table_id = del["deleted"]["id"].as_str().unwrap().to_string();
    assert!(del["note"].as_str().unwrap().contains("restore_from_trash"));
    let err = a
        .fails("list_records", json!({"base_id": b, "table": "Staff"}))
        .await;
    assert!(err.contains("Tables in this project"), "{err}");
    let trash = a.call("list_trash", json!({"base_id": b})).await;
    assert!(
        trash["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "table" && i["id"] == table_id),
        "{trash}"
    );
    a.call(
        "restore_from_trash",
        json!({"kind": "table", "id": table_id}),
    )
    .await;
    assert_eq!(
        a.call("list_records", json!({"base_id": b, "table": "Staff"}))
            .await["count"],
        1
    );

    // Bases: duplicate, delete, restore.
    let dup = a
        .call(
            "duplicate_base",
            json!({"base_id": b, "name": "Base copy", "include_records": true}),
        )
        .await;
    let dup_id = dup["base"]["id"].as_str().unwrap().to_string();
    assert_eq!(dup["base"]["name"], "Base copy");
    assert!(dup["base"]["tables"].as_array().unwrap().len() >= 3);
    let listed = a.call("list_bases", json!({})).await;
    assert_eq!(
        listed["workspaces"][0]["bases"].as_array().unwrap().len(),
        2
    );
    a.call("delete_base", json!({"base_id": dup_id})).await;
    assert!(
        a.fails("get_base_schema", json!({"base_id": dup_id}))
            .await
            .contains("not found")
    );
    let ws_trash = a.call("list_trash", json!({"workspace_id": r.ws})).await;
    assert!(
        ws_trash["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "base" && i["id"] == dup_id),
        "{ws_trash}"
    );
    a.call("restore_from_trash", json!({"kind": "base", "id": dup_id}))
        .await;
    assert_eq!(
        a.call("get_base_schema", json!({"base_id": dup_id})).await["name"],
        "Base copy"
    );
}

// -------------------------------------------------------------------------------- fields

/// One field of every type, created through `create_field` with the options the help
/// documents. Returns the table name that holds them.
async fn every_field_type(r: &Rig) -> &'static str {
    r.table("Everything").await;
    r.table("Friends").await;
    r.field("Friends", "Mood", "single_line_text", json!({}))
        .await;
    let cases: Vec<(&str, &str, Value)> = vec![
        ("Text", "single_line_text", json!({"default": "n/a"})),
        ("Memo", "long_text", json!({"rich": true})),
        (
            "Amount",
            "number",
            json!({"precision": 2, "allow_negative": false}),
        ),
        (
            "Price",
            "currency",
            json!({"symbol": "EUR ", "precision": 2}),
        ),
        ("Share", "percent", json!({"precision": 1})),
        ("Spent", "duration", json!({"format": "h_mm_ss"})),
        (
            "Stars",
            "rating",
            json!({"max": 7, "icon": "heart", "color": "red"}),
        ),
        (
            "Done",
            "checkbox",
            json!({"icon": "check", "color": "green"}),
        ),
        (
            "Phase",
            "single_select",
            json!({"choices": ["Plan", {"name": "Build", "color": "orange"}]}),
        ),
        (
            "Labels",
            "multiple_select",
            json!({"choices": ["a", "b", "c"]}),
        ),
        (
            "When",
            "date",
            json!({"include_time": true, "date_format": "european", "time_format": "h24", "timezone": "Europe/Berlin"}),
        ),
        ("Mail", "email", json!({})),
        ("Site", "url", json!({})),
        ("Phone", "phone", json!({})),
        ("Files", "attachment", json!({})),
        (
            "Friend",
            "link",
            json!({"linked_table": "Friends", "single": true}),
        ),
        ("Owner", "user", json!({"multiple": false, "notify": false})),
        ("Doubled", "formula", json!({"expression": "{Amount} * 2"})),
        (
            "Friend mood",
            "lookup",
            json!({"link_field": "Friend", "target_field": "Mood"}),
        ),
        (
            "Moods",
            "rollup",
            json!({"link_field": "Friend", "target_field": "Mood", "expression": "ARRAYJOIN(values, \", \")"}),
        ),
        ("Friends count", "count", json!({"link_field": "Friend"})),
        ("Created", "created_time", json!({"include_time": true})),
        (
            "Edited",
            "last_modified_time",
            json!({"fields": ["Text", "Amount"]}),
        ),
        ("Creator", "created_by", json!({})),
        ("Editor", "last_modified_by", json!({})),
        ("No.", "autonumber", json!({})),
        ("Code", "barcode", json!({})),
        (
            "Open",
            "button",
            json!({"label": "Open site", "url_formula": "{Site}"}),
        ),
    ];
    assert_eq!(cases.len(), 28, "one case per field type");
    for (name, ty, options) in &cases {
        let f = r.field("Everything", name, ty, options.clone()).await;
        assert_eq!(f["type"], *ty, "{name}: {f}");
        assert_eq!(f["name"], *name);
    }
    "Everything"
}

#[tokio::test]
async fn all_28_field_types_can_be_created_with_options() {
    let r = Rig::new().await;
    let table = every_field_type(&r).await;
    let schema = r.schema().await;
    let t = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == table)
        .unwrap();
    let fields = t["fields"].as_array().unwrap();
    let field = |name: &str| fields.iter().find(|f| f["name"] == name).unwrap();
    // 28 created + the primary field (a new table has nothing else)
    assert_eq!(fields.len(), 29);
    let mut types: Vec<&str> = fields
        .iter()
        .skip(1)
        .map(|f| f["type"].as_str().unwrap())
        .collect();
    types.sort();
    types.dedup();
    assert_eq!(types.len(), 28, "every type exactly once: {types:?}");
    // Options arrive normalized, with names turned into ids where the API wants ids.
    assert_eq!(field("Amount")["options"]["precision"], 2);
    assert_eq!(field("Amount")["options"]["allow_negative"], false);
    assert_eq!(field("Stars")["options"]["max"], 7);
    assert_eq!(field("Phase")["options"]["choices"][1]["name"], "Build");
    assert_eq!(field("Phase")["options"]["choices"][1]["color"], "orange");
    assert!(
        field("Phase")["options"]["choices"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("sel")
    );
    assert_eq!(field("Friend")["options"]["single"], true);
    let friends = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Friends")
        .unwrap();
    assert_eq!(
        field("Friend")["options"]["linked_table_id"],
        friends["id"],
        "the link points at the table given by name"
    );
    assert_eq!(field("Doubled")["options"]["expression"], "{Amount} * 2");
    assert_eq!(field("Doubled")["options"]["result_type"], "number");
    assert_eq!(
        field("Moods")["options"]["expression"],
        "ARRAYJOIN(values, \", \")"
    );
    assert!(
        field("Friend mood")["options"]["target_field_id"]
            .as_str()
            .unwrap()
            .starts_with("fld")
    );
    // The inverse of the link was created in the other table.
    assert!(
        friends["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["type"] == "link")
    );

    // Records can be written to the editable ones, computed ones come back.
    let rec = r
        .records(
            "Everything",
            json!([{"fields": {
                "Name": "row", "Amount": 21, "Phase": "Build", "Labels": ["a", "c"],
                "Done": true, "Stars": 4, "Mail": "x@example.com", "Share": 0.5
            }}]),
        )
        .await;
    assert_eq!(rec[0]["fields"]["Doubled"], 42);
    assert_eq!(rec[0]["fields"]["Phase"], "Build");
    assert_eq!(rec[0]["fields"]["Labels"], json!(["a", "c"]));
    assert_eq!(rec[0]["fields"]["No."], 1);
}

#[tokio::test]
async fn field_types_help_documents_every_type() {
    let r = Rig::new().await;
    let a = &r.agent;
    let overview = a.call("field_types", json!({})).await;
    let types: Vec<&str> = overview["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["type"].as_str().unwrap())
        .collect();
    assert_eq!(types.len(), 28);
    // Each documented example is something create_field accepts (links and computed fields
    // need the setup of a real table, so they are covered above).
    for ty in &types {
        let d = a.call("field_types", json!({"type": ty})).await;
        assert_eq!(d["type"], *ty);
        assert!(d["options"].is_string() && d["value"].is_string(), "{d}");
        assert_eq!(d["example"]["tool"], "create_field");
    }
    let err = a.fails("field_types", json!({"type": "numbr"})).await;
    assert!(
        err.contains("Unknown field type") && err.contains("single_select"),
        "{err}"
    );
}

#[tokio::test]
async fn select_choices_take_colors_or_get_meaningful_defaults() {
    let r = Rig::new().await;
    let a = &r.agent;
    r.table("T").await;
    // Explicit {name, color} choices are kept; plain names get a colour from their meaning.
    let f = r
        .field(
            "T",
            "Priority",
            "single_select",
            json!({"choices": ["Critical", "High", "Medium", "Low",
                               {"name": "Someday", "color": "purple"}, "Billing"]}),
        )
        .await;
    let colors: Vec<&str> = f["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["color"].as_str().unwrap())
        .collect();
    // "Billing" is not a known word: it cycles by position (index 5).
    assert_eq!(
        colors,
        ["red", "orange", "yellow", "green", "purple", "orange"]
    );

    let status = r
        .field(
            "T",
            "Status",
            "single_select",
            json!({"choices": ["Open", "In Progress", "Done"]}),
        )
        .await;
    let names_colors: Vec<(&str, &str)> = status["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), c["color"].as_str().unwrap()))
        .collect();
    assert_eq!(
        names_colors,
        [
            ("Open", "blue"),
            ("In Progress", "yellow"),
            ("Done", "green")
        ]
    );

    // A choice created by typecast on a record gets the same treatment.
    r.records("T", json!([{"fields": {"Priority": "Urgent"}}]))
        .await;
    let schema = r.schema().await;
    let t = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "T")
        .unwrap();
    let pri = t["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Priority")
        .unwrap();
    let urgent = pri["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Urgent")
        .unwrap();
    assert_eq!(urgent["color"], "red");

    // field_types tells a model about both.
    let d = a
        .call("field_types", json!({"type": "single_select"}))
        .await;
    let opts = d["options"].as_str().unwrap();
    assert!(
        opts.contains("{name, color?}") && opts.contains("Critical"),
        "{opts}"
    );
}

#[tokio::test]
async fn field_creation_errors_say_what_to_fix() {
    let r = Rig::new().await;
    let a = &r.agent;
    r.table("T").await;
    r.field("T", "Plain", "single_line_text", json!({})).await;
    let b = r.base.as_str();
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "X", "type": "numbr"}),
        )
        .await;
    assert!(
        e.contains("Unknown field type 'numbr'") && e.contains("field_types"),
        "{e}"
    );
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "Nope", "name": "X", "type": "number"}),
        )
        .await;
    assert!(
        e.contains("Table 'Nope' not found") && e.contains("'T'"),
        "{e}"
    );
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "L", "type": "link", "options": {"linked_table": "Missing"}}),
        )
        .await;
    assert!(e.contains("Table 'Missing' not found"), "{e}");
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "R", "type": "rollup",
                   "options": {"link_field": "Plain", "target_field": "Name", "expression": "SUM(values)"}}),
        )
        .await;
    assert!(e.contains("'Plain' is not a link field"), "{e}");
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "R", "type": "lookup", "options": {"link_field": "Nope", "target_field": "x"}}),
        )
        .await;
    assert!(
        e.contains("Field 'Nope' not found") && e.contains("'Plain'"),
        "{e}"
    );
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "Plain", "type": "number"}),
        )
        .await;
    assert!(
        e.to_lowercase().contains("already"),
        "duplicate names are refused: {e}"
    );
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "F", "type": "formula", "options": {"expression": "{Missing} + 1"}}),
        )
        .await;
    assert!(e.contains("Missing"), "{e}");
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "S", "type": "single_select", "options": {"choices": ["a", "A"]}}),
        )
        .await;
    assert!(e.contains("duplicate choice"), "{e}");
    let e = a
        .fails("create_field", json!({"base_id": b, "table": "T", "name": "S", "type": "number", "options": {"precision": 12}}))
        .await;
    assert!(e.contains("precision"), "{e}");
    // Unknown arguments are refused, not ignored.
    let e = a
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "S", "type": "number", "typ": "x"}),
        )
        .await;
    assert!(e.contains("Invalid arguments") && e.contains("typ"), "{e}");
}

#[tokio::test]
async fn update_field_renames_merges_options_and_keeps_select_values() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("T").await;
    r.field(
        "T",
        "Amount",
        "number",
        json!({"precision": 0, "allow_negative": false}),
    )
    .await;
    r.field(
        "T",
        "Phase",
        "single_select",
        json!({"choices": ["Plan", "Build"]}),
    )
    .await;
    let rows = r
        .records(
            "T",
            json!([{"fields": {"Name": "x", "Amount": 5, "Phase": "Build"}}]),
        )
        .await;
    let rec = rows[0]["id"].as_str().unwrap().to_string();

    // Options are merged into the current ones.
    let f = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Amount", "options": {"precision": 3}, "description": "How many"}),
        )
        .await;
    assert_eq!(f["field"]["options"]["precision"], 3);
    assert_eq!(
        f["field"]["options"]["allow_negative"], false,
        "untouched options stay"
    );
    assert_eq!(f["field"]["description"], "How many");
    assert!(f.get("conversion").is_none());

    // Rename; formulas that mention the field follow.
    r.field(
        "T",
        "Twice",
        "formula",
        json!({"expression": "{Amount} * 2"}),
    )
    .await;
    a.call(
        "update_field",
        json!({"base_id": b, "table": "T", "field": "Amount", "name": "Quantity"}),
    )
    .await;
    let schema = r.schema().await;
    let twice = schema["tables"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Twice")
        .unwrap();
    assert_eq!(twice["options"]["expression"], "{Quantity} * 2");

    // Add a select choice by name: the choices already used keep their values.
    let f = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Phase",
                   "options": {"choices": ["Plan", "Build", {"name": "Ship", "color": "green"}]}}),
        )
        .await;
    assert_eq!(
        f["field"]["options"]["choices"].as_array().unwrap().len(),
        3
    );
    let got = a
        .call(
            "get_record",
            json!({"base_id": b, "table": "T", "record_id": rec}),
        )
        .await;
    assert_eq!(
        got["fields"]["Phase"], "Build",
        "values survive adding a choice"
    );

    // Nothing to change / unknown field
    assert!(
        a.fails(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Phase"})
        )
        .await
        .contains("Give something to change")
    );
    let e = a
        .fails(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Zzz", "name": "x"}),
        )
        .await;
    assert!(
        e.contains("Field 'Zzz' not found") && e.contains("'Quantity'"),
        "{e}"
    );
}

#[tokio::test]
async fn update_field_keeps_links_lookups_and_rollups_working() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Orders").await;
    r.table("Customers").await;
    r.field("Orders", "Total", "number", json!({})).await;
    r.field(
        "Orders",
        "Customer",
        "link",
        json!({"linked_table": "Customers"}),
    )
    .await;
    r.field(
        "Customers",
        "Spend",
        "rollup",
        json!({"link_field": "Orders", "target_field": "Total", "expression": "SUM(values)"}),
    )
    .await;
    let rows = r
        .records("Customers", json!([{"fields": {"Name": "Ada"}}]))
        .await;
    let ada = rows[0]["id"].as_str().unwrap().to_string();
    r.records(
        "Orders",
        json!([
            {"fields": {"Name": "o1", "Customer": [ada], "Total": 10}},
            {"fields": {"Name": "o2", "Customer": [ada], "Total": 30}},
        ]),
    )
    .await;
    let spend = |v: &Value| v["fields"]["Spend"].clone();
    let got = a
        .call(
            "get_record",
            json!({"base_id": b, "table": "Customers", "record_id": ada}),
        )
        .await;
    assert_eq!(spend(&got), 40);

    // Change the rollup's expression: the link and target stay as they were.
    let f = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "Customers", "field": "Spend", "options": {"expression": "MAX(values)"}}),
        )
        .await;
    assert_eq!(f["field"]["options"]["expression"], "MAX(values)");
    let got = a
        .call(
            "get_record",
            json!({"base_id": b, "table": "Customers", "record_id": ada}),
        )
        .await;
    assert_eq!(spend(&got), 30);
    // ...or repoint it by name.
    r.field("Orders", "Qty", "number", json!({})).await;
    a.call(
        "update_field",
        json!({"base_id": b, "table": "Customers", "field": "Spend", "options": {"target_field": "Total", "expression": "COUNTA(values)"}}),
    )
    .await;
    assert_eq!(
        spend(
            &a.call(
                "get_record",
                json!({"base_id": b, "table": "Customers", "record_id": ada})
            )
            .await
        ),
        2
    );

    // A link can become single-record without losing its inverse.
    let l = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "Orders", "field": "Customer", "options": {"single": true}}),
        )
        .await;
    assert_eq!(l["field"]["options"]["single"], true);
    assert!(
        l["field"]["options"]["inverse_field_id"]
            .as_str()
            .unwrap()
            .starts_with("fld")
    );
}

#[tokio::test]
async fn changing_a_field_type_warns_first_then_converts() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("T").await;
    r.field("T", "Value", "single_line_text", json!({})).await;
    let rows = r
        .records(
            "T",
            json!([{"fields": {"Name": "a", "Value": "12"}}, {"fields": {"Name": "b", "Value": "oops"}}]),
        )
        .await;
    let (a_id, b_id) = (
        rows[0]["id"].as_str().unwrap().to_string(),
        rows[1]["id"].as_str().unwrap().to_string(),
    );

    // The first attempt only explains.
    let warning = a
        .fails(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Value", "type": "number", "options": {"precision": 0}}),
        )
        .await;
    assert!(
        warning.contains("single_line_text to number")
            && warning.contains("converts every existing value")
            && warning.contains("confirm_conversion=true"),
        "{warning}"
    );
    let schema = r.schema().await;
    let value_field = schema["tables"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Value")
        .unwrap()
        .clone();
    assert_eq!(
        value_field["type"], "single_line_text",
        "nothing changed yet"
    );

    // Confirmed: converted, with a note in the result.
    let done = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "Value", "type": "number",
                   "options": {"precision": 0}, "confirm_conversion": true}),
        )
        .await;
    assert_eq!(done["field"]["type"], "number");
    assert_eq!(done["conversion"]["from"], "single_line_text");
    assert_eq!(done["conversion"]["to"], "number");
    let ra = a
        .call(
            "get_record",
            json!({"base_id": b, "table": "T", "record_id": a_id}),
        )
        .await;
    assert_eq!(
        ra["fields"]["Value"], 12,
        "convertible values are converted"
    );
    let rb = a
        .call(
            "get_record",
            json!({"base_id": b, "table": "T", "record_id": b_id}),
        )
        .await;
    assert!(
        rb["fields"].get("Value").is_none(),
        "the rest is cleared: {rb}"
    );
}

#[tokio::test]
async fn fields_can_be_deleted_restored_and_made_primary() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("T").await;
    r.field("T", "Code", "single_line_text", json!({})).await;
    r.field("T", "Qty", "number", json!({})).await;
    r.field("T", "Double", "formula", json!({"expression": "{Qty} * 2"}))
        .await;

    let del = a
        .call(
            "delete_field",
            json!({"base_id": b, "table": "T", "field": "Qty"}),
        )
        .await;
    let ids = del["deleted_field_ids"].as_array().unwrap().clone();
    assert!(!ids.is_empty(), "{del}");
    let names: Vec<String> = r.schema().await["tables"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!names.contains(&"Qty".to_string()), "{names:?}");
    let qty_id = ids[0].as_str().unwrap();
    let back = a
        .call("restore_from_trash", json!({"kind": "field", "id": qty_id}))
        .await;
    assert!(
        back["restored_field_ids"]
            .as_array()
            .is_some_and(|l| !l.is_empty()),
        "{back}"
    );
    let names: Vec<String> = r.schema().await["tables"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap().to_string())
        .collect();
    assert!(
        names.contains(&"Qty".to_string()) && names.contains(&"Double".to_string()),
        "{names:?}"
    );

    // Primary field
    let p = a
        .call(
            "set_primary_field",
            json!({"base_id": b, "table": "T", "field": "Code"}),
        )
        .await;
    assert_eq!(p["primary_field"], "Code");
    assert_eq!(r.schema().await["tables"][0]["primary_field"], "Code");
    r.field("T", "Flag", "checkbox", json!({})).await;
    let e = a
        .fails(
            "set_primary_field",
            json!({"base_id": b, "table": "T", "field": "Flag"}),
        )
        .await;
    assert!(
        e.to_lowercase().contains("primary"),
        "a checkbox cannot be the primary field: {e}"
    );
}

// ----------------------------------------------------------------------------------- views

#[tokio::test]
async fn views_of_every_type_accept_names_in_their_config() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field(
        "Tasks",
        "Status",
        "single_select",
        json!({"choices": ["Todo", "Doing", "Done"]}),
    )
    .await;
    r.field("Tasks", "Start", "date", json!({})).await;
    r.field("Tasks", "End", "date", json!({})).await;
    r.field("Tasks", "Cover", "attachment", json!({})).await;
    r.field("Tasks", "Points", "number", json!({})).await;
    r.field("Tasks", "Needs", "link", json!({"linked_table": "Tasks"}))
        .await;
    r.field("Tasks", "Notes", "long_text", json!({})).await;

    let configs = [
        (
            "grid",
            json!({"sorts": [{"field_id": "Points", "direction": "desc"}], "frozen_columns": 1, "row_height": "tall",
                        "summaries": {"Points": "sum"}, "field_widths": {"Status": 240},
                        "row_color": {"mode": "by_select", "field_id": "Status"}}),
        ),
        (
            "kanban",
            json!({"description_field_id": "Notes", "kanban": {"stack_field_id": "Status", "stack_order": ["Doing", "Todo", "Done"], "hide_empty_stacks": true}}),
        ),
        (
            "calendar",
            json!({"calendar": {"date_field_id": "Start", "end_field_id": "End"}}),
        ),
        (
            "gallery",
            json!({"gallery": {"cover_field_id": "Cover", "cover_crop": true}}),
        ),
        (
            "timeline",
            json!({"timeline": {"start_field_id": "Start", "end_field_id": "End", "group_field_id": "Status",
                                         "dependency_field_id": "Needs", "scale": "month"}}),
        ),
        (
            "list",
            json!({"filter": {"items": [{"field_id": "Points", "op": "is_not_empty"}]}}),
        ),
        (
            "form",
            json!({"form": {"title": "Intake", "description": "Tell us", "submit_label": "Send",
                                 "fields": [{"field_id": "Name", "required": true, "help": "Short"}, {"field": "Points"}]}}),
        ),
    ];
    for (ty, config) in configs {
        let created = a
            .call(
                "create_view",
                json!({"base_id": b, "table": "Tasks", "name": format!("{ty} view"), "type": ty, "config": config}),
            )
            .await;
        assert_eq!(created["view"]["type"], ty);
        let back = a
            .call(
                "get_view",
                json!({"base_id": b, "view": format!("{ty} view")}),
            )
            .await;
        assert_eq!(
            back["view"]["config"], created["view"]["config"],
            "{ty} reads back as written"
        );
    }

    // Spot checks of the translation in both directions.
    let kanban = a
        .call("get_view", json!({"base_id": b, "view": "kanban view"}))
        .await;
    assert_eq!(
        kanban["view"]["config"]["kanban"]["stack_field_id"],
        "Status"
    );
    assert_eq!(
        kanban["view"]["config"]["kanban"]["stack_order"],
        json!(["Doing", "Todo", "Done"]),
        "choice names in, choice names out"
    );
    assert_eq!(kanban["view"]["config"]["description_field_id"], "Notes");
    let schema = r.schema().await;
    let tasks = &schema["tables"][0];
    let views = tasks["views"].as_array().unwrap();
    assert_eq!(views.len(), 8, "the default grid and seven new views");
    // What the server stored is ids: read the raw view through the REST API.
    let status_id = tasks["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Status")
        .unwrap()["id"]
        .clone();
    let kanban_id = views.iter().find(|v| v["name"] == "kanban view").unwrap()["id"].clone();
    let (_, raw) = api(
        r.app(),
        &common::TestApp::bearer(&r.token),
        "GET",
        &format!("/api/bases/{b}"),
        Value::Null,
        Value::Null,
    )
    .await;
    let raw_view = raw["body"]["tables"][0]["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == kanban_id)
        .unwrap()
        .clone();
    assert_eq!(raw_view["config"]["kanban"]["stack_field_id"], status_id);
    let notes_id = tasks["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Notes")
        .unwrap()["id"]
        .clone();
    assert_eq!(raw_view["config"]["description_field_id"], notes_id);
    assert!(
        raw_view["config"]["kanban"]["stack_order"][0]
            .as_str()
            .unwrap()
            .starts_with("sel")
    );
}

#[tokio::test]
async fn bad_view_configs_are_explained() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field(
        "Tasks",
        "Status",
        "single_select",
        json!({"choices": ["Todo", "Done"]}),
    )
    .await;
    let create = |config: Value| json!({"base_id": b, "table": "Tasks", "name": "v", "type": "grid", "config": config});
    let e = a.fails("create_view", create(json!({"sort": []}))).await;
    assert!(
        e.contains("unknown key 'sort'") && e.contains("sorts"),
        "{e}"
    );
    let e = a
        .fails(
            "create_view",
            create(json!({"sorts": [{"field_id": "Nope"}]})),
        )
        .await;
    assert!(
        e.contains("Field 'Nope' not found") && e.contains("'Status'"),
        "{e}"
    );
    let e = a
        .fails(
            "create_view",
            create(json!({"filter": {"items": [{"field_id": "Status", "op": "is", "value": "Later"}]}})),
        )
        .await;
    assert!(
        e.contains("not a choice") && e.contains("'Todo'") && e.contains("'Done'"),
        "{e}"
    );
    let e = a
        .fails(
            "create_view",
            create(json!({"filter": {"items": [{"field_id": "Status", "op": "contains", "value": "x"}]}})),
        )
        .await;
    assert!(
        !e.is_empty(),
        "an operator that does not suit the field is refused by the server: {e}"
    );
    let e = a
        .fails(
            "create_view",
            json!({"base_id": b, "table": "Tasks", "name": "v", "type": "spreadsheet"}),
        )
        .await;
    assert!(
        e.contains("Unknown view type") && e.contains("kanban"),
        "{e}"
    );
    let e = a
        .fails("get_view", json!({"base_id": b, "view": "Nope"}))
        .await;
    assert!(
        e.contains("View 'Nope' not found") && e.contains("Grid view"),
        "{e}"
    );
    let e = a
        .fails(
            "create_view",
            json!({"base_id": b, "table": "Tasks", "name": "k", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Status", "stack_order": ["Nope"]}}}),
        )
        .await;
    assert!(e.contains("not a choice") && e.contains("'Todo'"), "{e}");
}

#[tokio::test]
async fn update_view_changes_only_what_is_given() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field(
        "Tasks",
        "Status",
        "single_select",
        json!({"choices": ["Todo", "Done"]}),
    )
    .await;
    r.field("Tasks", "Points", "number", json!({})).await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Work", "type": "kanban",
        "config": {
            "filter": {"items": [{"field_id": "Points", "op": "gt", "value": 1}]},
            "sorts": [{"field_id": "Points"}],
            "kanban": {"stack_field_id": "Status", "hide_empty_stacks": true}
        }}),
    )
    .await;

    // Sorts are replaced; the filter and the kanban settings stay.
    let v = a
        .call(
            "update_view",
            json!({"base_id": b, "view": "Work", "config": {"sorts": [{"field_id": "Name", "direction": "desc"}]}}),
        )
        .await;
    let c = &v["view"]["config"];
    assert_eq!(
        c["sorts"],
        json!([{"field_id": "Name", "direction": "desc"}])
    );
    assert_eq!(c["filter"]["items"][0]["field_id"], "Points");
    assert_eq!(c["kanban"]["stack_field_id"], "Status");

    // A settings section merges key by key; null resets a part.
    let v = a
        .call(
            "update_view",
            json!({"base_id": b, "view": "Work",
                   "config": {"kanban": {"stack_order": ["Done", "Todo"]}, "filter": null}}),
        )
        .await;
    let c = &v["view"]["config"];
    assert_eq!(
        c["kanban"]["stack_field_id"], "Status",
        "other kanban keys stay"
    );
    assert_eq!(c["kanban"]["stack_order"], json!(["Done", "Todo"]));
    assert!(c.get("filter").is_none(), "null cleared the filter: {c}");

    // Rename and lock; viewers of the lock are covered by the role tests.
    let v = a
        .call(
            "update_view",
            json!({"base_id": b, "view": "Work", "name": "Sprint", "locked": true}),
        )
        .await;
    assert_eq!(v["view"]["name"], "Sprint");
    assert_eq!(v["view"]["locked"], true);
    assert!(
        a.fails("update_view", json!({"base_id": b, "view": "Sprint"}))
            .await
            .contains("Give something to change")
    );
    let e = a
        .fails(
            "update_view",
            json!({"base_id": b, "view": "Sprint", "config": {"sorts": [{"field_id": "Nope"}]}}),
        )
        .await;
    assert!(e.contains("Field 'Nope' not found"), "{e}");
    let after = a
        .call("get_view", json!({"base_id": b, "view": "Sprint"}))
        .await;
    assert_eq!(
        after["view"]["config"]["kanban"]["stack_order"],
        json!(["Done", "Todo"]),
        "a failed update changes nothing"
    );
}

#[tokio::test]
async fn views_can_be_personal_deleted_and_restored() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Mine", "type": "grid", "personal": true}),
    )
    .await;
    // A teammate does not see the personal view.
    let (_, mate) = r
        .teammate("mate@example.com", "editor", json!({"write": true}))
        .await;
    let theirs = mate.call("get_base_schema", json!({"base_id": b})).await;
    let names: Vec<&str> = theirs["tables"][0]["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Grid view"]);
    // ...and an editor can make personal views but not shared ones.
    mate.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Theirs", "type": "grid", "personal": true}),
    )
    .await;
    let e = mate
        .fails(
            "create_view",
            json!({"base_id": b, "table": "Tasks", "name": "Shared", "type": "grid"}),
        )
        .await;
    assert!(
        e.to_lowercase().contains("creator") || e.to_lowercase().contains("shared"),
        "{e}"
    );

    let del = a
        .call("delete_view", json!({"base_id": b, "view": "Mine"}))
        .await;
    let id = del["deleted"]["id"].as_str().unwrap().to_string();
    assert!(
        a.fails("get_view", json!({"base_id": b, "view": "Mine"}))
            .await
            .contains("not found")
    );
    a.call("restore_from_trash", json!({"kind": "view", "id": id}))
        .await;
    assert_eq!(
        a.call("get_view", json!({"base_id": b, "view": "Mine"}))
            .await["view"]["personal"],
        true
    );
}

#[tokio::test]
async fn query_view_shows_people_and_choice_names() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Owner", "user", json!({})).await;
    r.field("Tasks", "Made by", "created_by", json!({})).await;
    r.field(
        "Tasks",
        "Tags",
        "multiple_select",
        json!({"choices": ["a", "b"]}),
    )
    .await;
    let me = r.admin.user_id.clone().unwrap();
    r.records(
        "Tasks",
        json!([{"fields": {"Name": "t1", "Owner": {"id": me}, "Tags": ["b"]}}]),
    )
    .await;
    let q = a
        .call("query_view", json!({"base_id": b, "view": "Grid view"}))
        .await;
    let row = &q["records"][0]["fields"];
    assert_eq!(row["Tags"], json!(["b"]));
    assert_eq!(row["Owner"][0]["email"], "admin@example.com", "{row}");
    assert_eq!(row["Made by"]["name"], "Test User", "{row}");
    assert!(
        a.fails("query_view", json!({"base_id": b, "view": "Nope"}))
            .await
            .contains("not found")
    );
}

fn day_in(tz: &str) -> String {
    chrono::Utc::now()
        .with_timezone(&tz.parse::<chrono_tz::Tz>().unwrap())
        .date_naive()
        .to_string()
}

#[tokio::test]
async fn query_view_resolves_relative_dates_in_the_timezone_argument() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Events").await;
    r.field("Events", "On", "date", json!({})).await;
    // UTC+14 and UTC-11: their calendar days always differ.
    let (east, west) = ("Pacific/Kiritimati", "Pacific/Pago_Pago");
    r.records(
        "Events",
        json!([
            {"fields": {"Name": "east", "On": day_in(east)}},
            {"fields": {"Name": "west", "On": day_in(west)}},
        ]),
    )
    .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Events", "name": "Today", "type": "grid",
               "config": {"filter": {"items": [{"field_id": "On", "op": "is", "value": {"mode": "today"}}]}}}),
    )
    .await;
    let names = |q: &serde_json::Value| -> Vec<String> {
        q["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rec| rec["fields"]["Name"].as_str().unwrap().to_string())
            .collect()
    };
    let q = |tz: &str| json!({"base_id": b, "view": "Today", "timezone": tz});
    assert_eq!(names(&a.call("query_view", q(east)).await), ["east"]);
    assert_eq!(names(&a.call("query_view", q(west)).await), ["west"]);
    assert!(
        a.fails("query_view", q("Mars/Base"))
            .await
            .contains("unknown timezone")
    );
}
