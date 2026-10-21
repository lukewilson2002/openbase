//! Keeping views in step with their table through MCP: new tables and new fields tell the model
//! which views to consider, and deleting or retyping a field lists the views that used it.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

fn views_note(v: &Value) -> &str {
    v["views_note"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn a_new_table_asks_for_the_views_its_purpose_calls_for() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    let t = a
        .call("create_table", json!({"base_id": b, "name": "Contacts"}))
        .await;
    assert!(
        views_note(&t).contains("create_view") && views_note(&t).contains("query_view"),
        "{t}"
    );

    let imported = a
        .call(
            "import_csv",
            json!({"base_id": b, "new_table_name": "Leads", "csv_text": "Name,Company\nAda,Acme\n"}),
        )
        .await;
    assert!(views_note(&imported).contains("create_view"), "{imported}");

    // Rows added to an existing table change no structure: no views note.
    let rows = a
        .call(
            "import_csv",
            json!({"base_id": b, "table": "Leads", "csv_text": "Name,Company\nBo,Initech\n"}),
        )
        .await;
    assert!(rows.get("views_note").is_none(), "{rows}");
}

#[tokio::test]
async fn a_new_field_names_the_views_it_may_concern() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;

    let due = a
        .call(
            "create_field",
            json!({"base_id": b, "table": "Tasks", "name": "Due", "type": "date"}),
        )
        .await;
    assert!(views_note(&due).contains("calendar"), "{due}");
    assert!(!views_note(&due).contains("form"), "no form yet: {due}");

    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "New task", "type": "form"}),
    )
    .await;
    let status = a
        .call(
            "create_field",
            json!({"base_id": b, "table": "Tasks", "name": "Status", "type": "single_select",
                   "options": {"choices": ["Todo", "Done"]}}),
        )
        .await;
    let note = views_note(&status);
    assert!(note.contains("kanban"), "{status}");
    assert!(note.contains("'New task'"), "the form is named: {status}");

    // A computed field is never a form question.
    let n = a
        .call(
            "create_field",
            json!({"base_id": b, "table": "Tasks", "name": "No", "type": "autonumber"}),
        )
        .await;
    assert!(!views_note(&n).contains("New task"), "{n}");
}

#[tokio::test]
async fn deleting_a_field_lists_the_views_that_used_it() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Due", "date", json!({})).await;
    r.field("Tasks", "Notes", "rich_text", json!({})).await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Schedule", "type": "calendar",
               "config": {"calendar": {"date_field_id": "Due"}}}),
    )
    .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Upcoming", "type": "grid",
               "config": {"sorts": [{"field_id": "Due", "direction": "asc"}],
                          "filter": {"conjunction": "and", "items": [
                              {"field_id": "Due", "op": "is_on_or_after", "value": {"mode": "today"}}]}}}),
    )
    .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Wide", "type": "grid",
               "config": {"field_widths": {"Due": 300}}}),
    )
    .await;

    // A field no view depends on: nothing to check.
    let notes = a
        .call(
            "delete_field",
            json!({"base_id": b, "table": "Tasks", "field": "Notes"}),
        )
        .await;
    assert!(notes.get("views_to_check").is_none(), "{notes}");

    let del = a
        .call(
            "delete_field",
            json!({"base_id": b, "table": "Tasks", "field": "Due"}),
        )
        .await;
    let list = del["views_to_check"].as_array().unwrap();
    let by_name = |n: &str| list.iter().find(|v| v["view"] == n).cloned();
    let schedule = by_name("Schedule").expect("the calendar is listed");
    assert_eq!(schedule["type"], "calendar");
    assert_eq!(schedule["table"], "Tasks");
    assert_eq!(schedule["uses"], json!(["calendar date field"]));
    assert_eq!(
        by_name("Upcoming").unwrap()["uses"],
        json!(["filter", "sort"])
    );
    assert!(
        by_name("Wide").is_none(),
        "a column width needs no fixing: {del}"
    );
    assert!(views_note(&del).contains("update_view"), "{del}");
}

#[tokio::test]
async fn a_type_change_lists_the_views_that_use_the_field() {
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
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Board", "type": "kanban",
               "config": {"kanban": {"stack_field_id": "Status"}}}),
    )
    .await;
    let changed = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "Tasks", "field": "Status",
                   "type": "text", "confirm_conversion": true}),
        )
        .await;
    assert_eq!(
        changed["views_to_check"],
        json!([{"view": "Board", "type": "kanban", "uses": ["kanban stack field"]}]),
        "{changed}"
    );

    // A rename converts nothing and lists nothing.
    let renamed = a
        .call(
            "update_field",
            json!({"base_id": b, "table": "Tasks", "field": "Status", "name": "State"}),
        )
        .await;
    assert!(renamed.get("views_to_check").is_none(), "{renamed}");
}

#[tokio::test]
async fn a_description_field_given_inside_a_view_type_moves_to_the_view() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Posts").await;
    r.field(
        "Posts",
        "Stage",
        "single_select",
        json!({"choices": ["Idea", "Draft"]}),
    )
    .await;
    r.field("Posts", "Summary", "rich_text", json!({})).await;
    r.field("Posts", "Hook", "text", json!({})).await;

    // Where 0.4.0 kept it, and where the app shows it: under the board's settings.
    let v = a
        .call(
            "create_view",
            json!({"base_id": b, "table": "Posts", "name": "Pipeline", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Stage", "description_field_id": "Summary"}}}),
        )
        .await;
    assert_eq!(
        v["view"]["config"]["description_field_id"], "Summary",
        "{v}"
    );
    assert!(
        v["view"]["config"]["kanban"]
            .get("description_field_id")
            .is_none(),
        "{v}"
    );

    let v = a
        .call(
            "update_view",
            json!({"base_id": b, "view": "Pipeline",
                   "config": {"kanban": {"description_field_id": "Hook"}}}),
        )
        .await;
    assert_eq!(v["view"]["config"]["description_field_id"], "Hook", "{v}");
    assert_eq!(
        v["view"]["config"]["kanban"]["stack_field_id"], "Stage",
        "{v}"
    );

    let e = a
        .fails(
            "update_view",
            json!({"base_id": b, "view": "Pipeline",
                   "config": {"description_field_id": "Summary", "kanban": {"description_field_id": "Hook"}}}),
        )
        .await;
    assert!(e.contains("given twice"), "{e}");
}
