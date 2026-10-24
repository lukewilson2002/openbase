//! View configuration through MCP: kanban stack order (names, the Uncategorized stack, people and
//! checkboxes), fields of the wrong type refused, and a date range for `query_view`.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

/// The saved config of a view as the web app reads it (ids).
async fn raw_view(r: &Rig, view_id: &str) -> Value {
    let schema = r
        .agent
        .call(
            "api_request",
            json!({"method": "GET", "path": format!("/api/bases/{}", r.base)}),
        )
        .await;
    for t in schema["body"]["tables"].as_array().unwrap() {
        for v in t["views"].as_array().unwrap() {
            if v["id"] == view_id {
                return v.clone();
            }
        }
    }
    panic!("view {view_id} not found");
}

fn choice_ids(field: &Value) -> Vec<String> {
    field["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn kanban_stack_order_round_trips_with_uncategorized() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    let status = r
        .field(
            "Tasks",
            "Status",
            "single_select",
            json!({"choices": ["Todo", "Doing", "Done"]}),
        )
        .await;
    let ids = choice_ids(&status);

    let made = a
        .call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": "Board", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Status",
                                         "stack_order": ["Done", "Uncategorized", "Todo"]}}}),
        )
        .await;
    let view_id = made["view"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        made["view"]["config"]["kanban"]["stack_order"],
        json!(["Done", "Uncategorized", "Todo"])
    );
    // Saved the way the web app saves it: the choice ids and "" for Uncategorized.
    let raw = raw_view(&r, &view_id).await;
    assert_eq!(
        raw["config"]["kanban"]["stack_order"],
        json!([ids[2], "", ids[0]])
    );

    // The web app moves a stack: ids and "" written by the UI.
    let mut config = raw["config"].clone();
    config["kanban"]["stack_order"] = json!([ids[0], "", ids[1], ids[2]]);
    let patched = a
        .call(
            "api_request",
            json!({"method": "PATCH", "path": format!("/api/views/{view_id}"),
                   "body": {"config": config}}),
        )
        .await;
    assert_eq!(patched["status"], 200, "{patched}");

    // get_view then update_view with the order read back is accepted unchanged.
    let got = a
        .call("get_view", json!({"project_id": b, "view": view_id}))
        .await;
    let order = got["view"]["config"]["kanban"]["stack_order"].clone();
    assert_eq!(order, json!(["Todo", "Uncategorized", "Doing", "Done"]));
    // The order alone, without stack_field_id, is read against the view's own stack field.
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id,
               "config": {"kanban": {"stack_order": ["Uncategorized", "Done", "Todo", "Doing"]}}}),
    )
    .await;
    assert_eq!(
        raw_view(&r, &view_id).await["config"]["kanban"]["stack_order"],
        json!(["", ids[2], ids[0], ids[1]])
    );
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id, "config": {"kanban": {"stack_order": order}}}),
    )
    .await;
    assert_eq!(
        raw_view(&r, &view_id).await["config"]["kanban"]["stack_order"],
        json!([ids[0], "", ids[1], ids[2]])
    );
    // The empty string itself, and loose spelling, are accepted too.
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id,
               "config": {"kanban": {"stack_order": ["", "done", "UNCATEGORIZED"]}}}),
    )
    .await;

    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"kanban": {"stack_order": ["Nowhere"]}}}),
        )
        .await;
    assert!(
        e.contains("not a choice of field 'Status'") && e.contains("Uncategorized"),
        "{e}"
    );
}

#[tokio::test]
async fn kanban_stack_order_by_person_and_checkbox_uses_names() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Owner", "user", json!({})).await;
    r.field("Tasks", "Done", "checkbox", json!({})).await;
    let people = a.call("list_collaborators", json!({"project_id": b})).await;
    let me = &people["collaborators"][0];
    let (my_id, my_name) = (
        me["id"].as_str().unwrap().to_string(),
        me["name"].as_str().unwrap().to_string(),
    );

    let made = a
        .call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": "By owner", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Owner",
                                         "stack_order": ["Uncategorized", my_name]}}}),
        )
        .await;
    let view_id = made["view"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        raw_view(&r, &view_id).await["config"]["kanban"]["stack_order"],
        json!(["", my_id])
    );
    let got = a
        .call("get_view", json!({"project_id": b, "view": view_id}))
        .await;
    assert_eq!(
        got["view"]["config"]["kanban"]["stack_order"],
        json!(["Uncategorized", my_name])
    );
    // Email and user id work as well.
    let email = me["email"].as_str().unwrap();
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id,
               "config": {"kanban": {"stack_order": [email, my_id.as_str()]}}}),
    )
    .await;
    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"kanban": {"stack_order": ["Nobody Here"]}}}),
        )
        .await;
    assert!(e.contains("not a person of this project"), "{e}");

    let made = a
        .call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": "By done", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Done",
                                         "stack_order": ["Checked", "Unchecked"]}}}),
        )
        .await;
    let view_id = made["view"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        raw_view(&r, &view_id).await["config"]["kanban"]["stack_order"],
        json!(["true", "false"])
    );
    assert_eq!(
        made["view"]["config"]["kanban"]["stack_order"],
        json!(["Checked", "Unchecked"])
    );
    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"kanban": {"stack_order": ["Maybe"]}}}),
        )
        .await;
    assert!(e.contains("'Checked', 'Unchecked'"), "{e}");
}

#[tokio::test]
async fn fields_of_the_wrong_type_are_refused_with_a_clear_message() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Start", "date", json!({})).await;
    r.field("Tasks", "End", "date", json!({})).await;
    r.field("Tasks", "Owners", "user", json!({"multiple": true}))
        .await;
    r.field(
        "Tasks",
        "Status",
        "single_select",
        json!({"choices": ["A"]}),
    )
    .await;
    r.field("Tasks", "Blocks", "link", json!({"linked_table": "Tasks"}))
        .await;
    r.table("Other").await;
    r.field("Tasks", "Other", "link", json!({"linked_table": "Other"}))
        .await;

    let make = |kind: &str, config: Value| json!({"project_id": b, "table": "Tasks", "name": "V", "type": kind, "config": config});
    let e = a
        .fails(
            "create_view",
            make("timeline", json!({"timeline": {"start_field_id": "Name"}})),
        )
        .await;
    assert!(
        e.contains("timeline start field must be a date field")
            && e.contains("'Name' is a Text field"),
        "{e}"
    );
    let e = a
        .fails(
            "create_view",
            make(
                "timeline",
                json!({"timeline": {"start_field_id": "Start", "end_field_id": "Status"}}),
            ),
        )
        .await;
    assert!(e.contains("timeline end field must be a date field"), "{e}");
    let e = a
        .fails(
            "create_view",
            make(
                "timeline",
                json!({"timeline": {"start_field_id": "Start", "end_field_id": "Start"}}),
            ),
        )
        .await;
    assert!(e.contains("different field from the start"), "{e}");
    let e = a
        .fails(
            "create_view",
            make(
                "timeline",
                json!({"timeline": {"start_field_id": "Start", "dependency_field_id": "Name"}}),
            ),
        )
        .await;
    assert!(e.contains("link field to records of the same table"), "{e}");
    let e = a
        .fails(
            "create_view",
            make(
                "timeline",
                json!({"timeline": {"start_field_id": "Start", "dependency_field_id": "Other"}}),
            ),
        )
        .await;
    assert!(e.contains("same table"), "{e}");
    let e = a
        .fails(
            "create_view",
            make("calendar", json!({"calendar": {"date_field_id": "Status"}})),
        )
        .await;
    assert!(
        e.contains("calendar date field must be a date field"),
        "{e}"
    );
    for bad in ["Name", "Owners"] {
        let e = a
            .fails(
                "create_view",
                make("kanban", json!({"kanban": {"stack_field_id": bad}})),
            )
            .await;
        assert!(
            e.contains("kanban stack field must be a single select"),
            "{bad}: {e}"
        );
    }

    let ok = a
        .call(
            "create_view",
            make(
                "timeline",
                json!({"timeline": {"start_field_id": "Start", "end_field_id": "End",
                                    "dependency_field_id": "Blocks"}}),
            ),
        )
        .await;
    let view_id = ok["view"]["id"].as_str().unwrap().to_string();
    // update_view refuses the same mistakes and leaves the view alone.
    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"timeline": {"start_field_id": "Name"}}}),
        )
        .await;
    assert!(
        e.contains("timeline start field must be a date field"),
        "{e}"
    );
    let got = a
        .call("get_view", json!({"project_id": b, "view": view_id}))
        .await;
    assert_eq!(got["view"]["config"]["timeline"]["start_field_id"], "Start");
    a.call(
        "create_view",
        json!({"project_id": b, "table": "Tasks", "name": "Cal", "type": "calendar",
               "config": {"calendar": {"date_field_id": "Start", "end_field_id": "End"}}}),
    )
    .await;
    a.call(
        "create_view",
        json!({"project_id": b, "table": "Tasks", "name": "Board", "type": "kanban",
               "config": {"kanban": {"stack_field_id": "Status"}}}),
    )
    .await;
}

#[tokio::test]
async fn query_view_takes_a_date_range_with_overlap_semantics() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Events").await;
    r.field("Events", "Start", "date", json!({})).await;
    r.field("Events", "End", "date", json!({})).await;
    r.records(
        "Events",
        json!([
            {"fields": {"Name": "Spans", "Start": "2026-01-01", "End": "2026-01-03"}},
            {"fields": {"Name": "One day", "Start": "2026-01-05"}},
            {"fields": {"Name": "Long", "Start": "2026-01-10", "End": "2026-01-20"}},
            {"fields": {"Name": "Undated"}}
        ]),
    )
    .await;
    a.call(
        "create_view",
        json!({"project_id": b, "table": "Events", "name": "Calendar", "type": "calendar",
               "config": {"calendar": {"date_field_id": "Start", "end_field_id": "End"}}}),
    )
    .await;
    let names = |out: &Value| -> Vec<String> {
        out["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["fields"]["Name"].as_str().unwrap().to_string())
            .collect()
    };
    let query = |extra: Value| {
        let mut args = json!({"project_id": b, "view": "Calendar"});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        args
    };

    let all = a.call("query_view", query(json!({}))).await;
    assert_eq!(names(&all).len(), 4);
    let week = a
        .call(
            "query_view",
            query(json!({"from": "2026-01-02", "to": "2026-01-05"})),
        )
        .await;
    assert_eq!(names(&week), vec!["Spans", "One day"], "{week}");
    assert_eq!(week["total"], 2);
    assert_eq!(week["range"]["date_field"], "Start");
    assert_eq!(week["range"]["end_field"], "End");
    let day = a
        .call(
            "query_view",
            query(json!({"from": "2026-01-15", "to": "2026-01-15"})),
        )
        .await;
    assert_eq!(names(&day), vec!["Long"]);
    let none = a
        .call(
            "query_view",
            query(json!({"from": "2026-02-01", "to": "2026-02-28"})),
        )
        .await;
    assert_eq!(none["total"], 0);

    // Another view type needs the date field named.
    a.call(
        "create_view",
        json!({"project_id": b, "table": "Events", "name": "All", "type": "grid"}),
    )
    .await;
    let e = a
        .fails(
            "query_view",
            json!({"project_id": b, "view": "All", "from": "2026-01-01", "to": "2026-01-02"}),
        )
        .await;
    assert!(e.contains("give `date_field`"), "{e}");
    let grid = a
        .call(
            "query_view",
            json!({"project_id": b, "view": "All", "from": "2026-01-04", "to": "2026-01-06",
                   "date_field": "Start"}),
        )
        .await;
    assert_eq!(names(&grid), vec!["One day"]);
    let grid = a
        .call(
            "query_view",
            json!({"project_id": b, "view": "All", "from": "2026-01-04", "to": "2026-01-12",
                   "date_field": "Start", "end_field": "End"}),
        )
        .await;
    assert_eq!(names(&grid), vec!["One day", "Long"]);

    let e = a
        .fails("query_view", query(json!({"from": "2026-01-01"})))
        .await;
    assert!(e.contains("both `from` and `to`"), "{e}");
    let e = a
        .fails("query_view", query(json!({"from": "soon", "to": "later"})))
        .await;
    assert!(e.contains("2026-03-31"), "{e}");
    let e = a
        .fails(
            "query_view",
            query(json!({"from": "2026-01-05", "to": "2026-01-01"})),
        )
        .await;
    assert!(e.contains("before"), "{e}");
    let e = a
        .fails(
            "query_view",
            query(json!({"from": "2026-01-01", "to": "2026-01-02", "date_field": "Name"})),
        )
        .await;
    assert!(e.contains("not a date field"), "{e}");
    let e = a
        .fails("query_view", query(json!({"date_field": "Start"})))
        .await;
    assert!(e.contains("need a date range"), "{e}");
}

#[tokio::test]
async fn kanban_hidden_stacks_and_card_settings_round_trip() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    let status = r
        .field(
            "Tasks",
            "Status",
            "single_select",
            json!({"choices": ["Todo", "Doing", "Done"]}),
        )
        .await;
    let ids = choice_ids(&status);

    let made = a
        .call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": "Board", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Status",
                                         "hidden_stacks": ["Done", "Uncategorized"],
                                         "card_field_limit": 10, "cover_fit": true,
                                         "show_all_people": true}}}),
        )
        .await;
    let view_id = made["view"]["id"].as_str().unwrap().to_string();
    // Names for the model, ids (and "" for Uncategorized) as the web app saves them.
    assert_eq!(
        made["view"]["config"]["kanban"]["hidden_stacks"],
        json!(["Done", "Uncategorized"])
    );
    let raw = raw_view(&r, &view_id).await;
    assert_eq!(
        raw["config"]["kanban"]["hidden_stacks"],
        json!([ids[2], ""])
    );
    assert_eq!(raw["config"]["kanban"]["card_field_limit"], 10);
    assert_eq!(raw["config"]["kanban"]["cover_fit"], true);
    assert_eq!(raw["config"]["kanban"]["show_all_people"], true);

    // Hidden stacks alone are read against the view's saved stack field.
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id,
               "config": {"kanban": {"hidden_stacks": ["Doing"]}}}),
    )
    .await;
    assert_eq!(
        raw_view(&r, &view_id).await["config"]["kanban"]["hidden_stacks"],
        json!([ids[1]])
    );

    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"kanban": {"hidden_stacks": ["Nowhere"]}}}),
        )
        .await;
    assert!(e.contains("not a choice of field 'Status'"), "{e}");
}

#[tokio::test]
async fn list_prefix_and_parent_fields_are_set_by_name() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Done", "checkbox", json!({})).await;
    r.field("Tasks", "Parent", "link", json!({"linked_table": "Tasks"}))
        .await;

    // A new list with no list settings prefixes its rows with the first checkbox field.
    let made = a
        .call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": "To do", "type": "list"}),
        )
        .await;
    assert_eq!(made["view"]["config"]["list"]["prefix_field_id"], "Done");
    let view_id = made["view"]["id"].as_str().unwrap().to_string();

    let updated = a
        .call(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"list": {"parent_field_id": "Parent"}}}),
        )
        .await;
    assert_eq!(
        updated["view"]["config"]["list"]["parent_field_id"],
        "Parent"
    );
    assert_eq!(updated["view"]["config"]["list"]["prefix_field_id"], "Done");
    let saved = raw_view(&r, &view_id).await;
    assert!(
        saved["config"]["list"]["parent_field_id"]
            .as_str()
            .unwrap()
            .starts_with("fld")
    );

    // null clears one setting; the wrong kinds of field are refused by name.
    a.call(
        "update_view",
        json!({"project_id": b, "view": view_id, "config": {"list": {"prefix_field_id": null}}}),
    )
    .await;
    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"list": {"parent_field_id": "Done"}}}),
        )
        .await;
    assert!(e.contains("list parent field must be a link field"), "{e}");
    let e = a
        .fails(
            "update_view",
            json!({"project_id": b, "view": view_id,
                   "config": {"list": {"prefix_field_id": "Parent"}}}),
        )
        .await;
    assert!(e.contains("list prefix field must be a checkbox"), "{e}");
}
