//! The collection settings of the UX overhaul through MCP (BE-2, BE-4, BE-5): colours on
//! `create_table` and `rename_table`, `update_table_settings`, `set_page_field`,
//! `set_top_level_project`, and the same endpoints through `api_request`.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

fn field<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no field {name} in {table}"))
}

async fn schema_table(r: &Rig, name: &str) -> Value {
    let s = r
        .agent
        .call("get_project_schema", json!({"project_id": r.base}))
        .await;
    s["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .cloned()
        .unwrap_or_else(|| panic!("no table {name} in {s}"))
}

#[tokio::test]
async fn tables_take_a_colour_when_created_and_renamed_and_the_icon_still_works() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    let t = a
        .call(
            "create_table",
            json!({"project_id": b, "name": "Clients", "color": "teal", "icon": "users"}),
        )
        .await["table"]
        .clone();
    assert_eq!(t["color"], "teal");
    assert_eq!(t["icon"], "users");
    assert_eq!(t["record_count"], 0);
    assert_eq!(t["page_field"], "Page");

    let t = a
        .call(
            "rename_table",
            json!({"project_id": b, "table": "Clients", "color": "pink"}),
        )
        .await["table"]
        .clone();
    assert_eq!(t["color"], "pink");
    assert_eq!(t["icon"], "users", "the icon stays");

    let bad = a
        .fails(
            "create_table",
            json!({"project_id": b, "name": "Bad", "color": "mauve"}),
        )
        .await;
    assert!(bad.contains("mauve"), "{bad}");
    let bad = a
        .fails(
            "rename_table",
            json!({"project_id": b, "table": "Clients", "color": "mauve"}),
        )
        .await;
    assert!(bad.contains("mauve"), "{bad}");
}

#[tokio::test]
async fn update_table_settings_sets_names_and_resolves_fields_by_name() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Jobs").await;
    r.field("Jobs", "Due", "date", json!({})).await;
    r.field("Jobs", "Shipped", "checkbox", json!({})).await;
    r.field("Jobs", "Cost", "number", json!({"precision": 0}))
        .await;

    let t = a
        .call(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs", "color": "orange",
                   "description": "Work to do", "record_noun": "job",
                   "home_date_field": "Due", "done_field": "Shipped"}),
        )
        .await["table"]
        .clone();
    assert_eq!(t["color"], "orange");
    assert_eq!(t["description"], "Work to do");
    assert_eq!(t["record_noun"], "job");
    assert_eq!(t["home_date_field"], "Due");
    assert_eq!(t["done_field"], "Shipped");

    // The project schema says the same, with the record count.
    let seen = schema_table(&r, "Jobs").await;
    assert_eq!(seen["home_date_field"], "Due");
    assert_eq!(seen["done_field"], "Shipped");
    assert_eq!(seen["page_field"], "Page");
    assert_eq!(seen["record_noun"], "job");
    assert_eq!(seen["record_count"], 0);
    r.records(
        "Jobs",
        json!([{"fields": {"Name": "a"}}, {"fields": {"Name": "b"}}]),
    )
    .await;
    assert_eq!(schema_table(&r, "Jobs").await["record_count"], 2);

    // Wrong types and unknown fields are refused with a message that names the fix.
    let e = a
        .fails(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs", "home_date_field": "Cost"}),
        )
        .await;
    assert!(e.contains("Home date"), "{e}");
    let e = a
        .fails(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs", "done_field": "Cost"}),
        )
        .await;
    assert!(e.contains("checkbox"), "{e}");
    let e = a
        .fails(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs", "done_field": "Nope"}),
        )
        .await;
    assert!(e.contains("Nope") && e.contains("Fields:"), "{e}");
    let e = a
        .fails(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs"}),
        )
        .await;
    assert!(e.contains("at least one setting"), "{e}");

    // null removes a field setting, and an empty record name resets it.
    let t = a
        .call(
            "update_table_settings",
            json!({"project_id": b, "table": "Jobs", "home_date_field": null,
                   "done_field": null, "record_noun": ""}),
        )
        .await["table"]
        .clone();
    assert!(t.get("home_date_field").is_none() && t.get("done_field").is_none());
    assert!(t.get("record_noun").is_none());
}

#[tokio::test]
async fn set_page_field_chooses_creates_or_clears_the_page() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Notes").await;
    r.field("Notes", "Body", "rich_text", json!({})).await;
    r.field("Notes", "Code", "text", json!({})).await;

    let out = a
        .call(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "field": "Body"}),
        )
        .await;
    assert_eq!(out["page_field"], "Body");
    assert_eq!(schema_table(&r, "Notes").await["page_field"], "Body");

    let e = a
        .fails(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "field": "Code"}),
        )
        .await;
    assert!(e.contains("rich text"), "{e}");
    let e = a
        .fails(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "field": "Name"}),
        )
        .await;
    assert!(e.contains("rich text"), "{e}");

    let out = a
        .call(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "clear": true}),
        )
        .await;
    assert!(out["page_field"].is_null());
    // Create adds "Page 2" (the first Page is still there), and does nothing the second time.
    let out = a
        .call(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "create": true}),
        )
        .await;
    assert_eq!(out["page_field"], "Page 2");
    let again = a
        .call(
            "set_page_field",
            json!({"project_id": b, "table": "Notes", "create": true}),
        )
        .await;
    assert_eq!(again["page_field"], "Page 2");

    // Exactly one of field, create, clear.
    for args in [
        json!({"project_id": b, "table": "Notes"}),
        json!({"project_id": b, "table": "Notes", "create": true, "clear": true}),
        json!({"project_id": b, "table": "Notes", "field": "Body", "create": true}),
    ] {
        let e = a.fails("set_page_field", args).await;
        assert!(e.contains("exactly one"), "{e}");
    }
}

#[tokio::test]
async fn deleting_the_page_field_through_mcp_leaves_the_table_without_one() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Notes").await;
    a.call(
        "delete_field",
        json!({"project_id": b, "table": "Notes", "field": "Page"}),
    )
    .await;
    let t = schema_table(&r, "Notes").await;
    assert!(t.get("page_field").is_none() || t["page_field"].is_null());
    assert!(
        t["fields"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["name"] != "Page")
    );
}

#[tokio::test]
async fn the_top_level_is_listed_chosen_and_protected_from_deletion() {
    let r = Rig::new().await;
    let a = &r.agent;
    let side = a
        .call(
            "create_project",
            json!({"workspace_id": r.ws, "name": "Side"}),
        )
        .await["base"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        a.call("get_project_schema", json!({"project_id": r.base}))
            .await["is_top_level"],
        true
    );

    let listed = a.call("list_projects", json!({})).await;
    let ws = &listed["workspaces"][0];
    assert_eq!(ws["top_level_project"], r.base.as_str());
    let flags: Vec<(String, bool)> = ws["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["id"].as_str().unwrap().to_string(),
                b["is_top_level"].as_bool().unwrap(),
            )
        })
        .collect();
    assert!(flags.contains(&(r.base.clone(), true)));
    assert!(flags.contains(&(side.clone(), false)));

    // The top level cannot be deleted; the message names the fix.
    let e = a
        .fails("delete_project", json!({"project_id": r.base}))
        .await;
    assert!(e.contains("Make another folder the top level first"), "{e}");
    assert!(e.contains("delete the workspace"), "{e}");

    let out = a
        .call(
            "set_top_level_project",
            json!({"workspace_id": r.ws, "project_id": side}),
        )
        .await;
    assert_eq!(out["top_level_project"], side.as_str());
    assert_eq!(
        a.call("list_projects", json!({})).await["workspaces"][0]["top_level_project"],
        side.as_str()
    );
    a.call("delete_project", json!({"project_id": r.base}))
        .await;
    let e = a.fails("delete_project", json!({"project_id": side})).await;
    assert!(e.contains("top-level"), "{e}");

    // A project of another workspace, or one that does not exist, cannot be chosen.
    let other = a.call("create_workspace", json!({"name": "Other"})).await["workspace"]["bases"][0]
        ["id"]
        .as_str()
        .unwrap()
        .to_string();
    let e = a
        .fails(
            "set_top_level_project",
            json!({"workspace_id": r.ws, "project_id": other}),
        )
        .await;
    assert!(e.contains("not a base of this workspace"), "{e}");
}

#[tokio::test]
async fn setting_the_top_level_needs_manage_and_the_owner_role() {
    let r = Rig::new().await;
    let side = r
        .agent
        .call(
            "create_project",
            json!({"workspace_id": r.ws, "name": "Side"}),
        )
        .await["base"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let args = json!({"workspace_id": r.ws, "project_id": side});

    // A write token without manage is not even offered the tool.
    let writer = r.agent_with(json!({"write": true})).await;
    assert!(
        !writer
            .tool_names()
            .await
            .contains(&"set_top_level_project".to_string())
    );
    let e = writer.fails("set_top_level_project", args.clone()).await;
    assert!(e.to_lowercase().contains("manage"), "{e}");

    // The tool is listed for manage tokens, and an editor with one is refused by the role.
    assert!(
        r.agent
            .tool_names()
            .await
            .contains(&"set_top_level_project".to_string())
    );
    let (_, editor) = r
        .teammate(
            "ed@example.com",
            "editor",
            json!({"write": true, "manage": true}),
        )
        .await;
    let e = editor.fails("set_top_level_project", args).await;
    assert!(
        e.to_lowercase().contains("owner") || e.to_lowercase().contains("permission"),
        "{e}"
    );
}

#[tokio::test]
async fn api_request_reaches_the_new_endpoints() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    let t = r.table("Journal").await;
    let table_id = t["id"].as_str().unwrap().to_string();
    let rec = r
        .records("Journal", json!([{"fields": {"Name": "Day one"}}]))
        .await;
    let rec_id = rec[0]["id"].as_str().unwrap().to_string();

    let docs = a.call("api_reference", json!({"area": "tables"})).await;
    let paths: Vec<&str> = docs["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"/api/tables/{id}"));
    let fields = a.call("api_reference", json!({"area": "fields"})).await;
    assert!(
        fields["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["path"] == "/api/tables/{id}/body-field")
    );

    // Table settings through PATCH.
    let res = a
        .call(
            "api_request",
            json!({"method": "PATCH", "path": format!("/api/tables/{table_id}"),
                   "body": {"color": "cyan", "record_noun": "entry"}}),
        )
        .await;
    assert_eq!(res["status"], 200, "{res}");
    assert_eq!(res["body"]["color"], "cyan");
    assert_eq!(res["body"]["record_noun"], "entry");

    // The page endpoints.
    let res = a
        .call(
            "api_request",
            json!({"method": "POST", "path": format!("/api/tables/{table_id}/body-field"),
                   "body": {"field_id": null}}),
        )
        .await;
    assert_eq!(res["status"], 200, "{res}");
    let res = a
        .call(
            "api_request",
            json!({"method": "PUT",
                   "path": format!("/api/tables/{table_id}/records/{rec_id}/page"),
                   "body": {"text": "Dear diary"}}),
        )
        .await;
    assert_eq!(res["status"], 200, "{res}");
    assert_eq!(res["body"]["created"], true);
    let page = res["body"]["field_id"].as_str().unwrap();
    assert_eq!(res["body"]["record"]["values"][page], "Dear diary");
    // And it is the field MCP's own record tools read.
    let got = a
        .call(
            "get_record",
            json!({"project_id": b, "table": "Journal", "record_id": rec_id}),
        )
        .await;
    assert_eq!(got["fields"]["Page 2"], "Dear diary", "{got}");
    let t = schema_table(&r, "Journal").await;
    let _ = field(&t, "Page 2");

    // The top level.
    let side = a
        .call(
            "create_project",
            json!({"workspace_id": r.ws, "name": "Side"}),
        )
        .await["base"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let res = a
        .call(
            "api_request",
            json!({"method": "POST", "path": format!("/api/workspaces/{}/top-level", r.ws),
                   "body": {"base_id": side}}),
        )
        .await;
    assert_eq!(res["status"], 200, "{res}");
    assert_eq!(res["body"]["root_base_id"], side.as_str());
}
