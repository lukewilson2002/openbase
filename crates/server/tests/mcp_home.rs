//! `get_home` (BE-3): a workspace's Home for agents, through the live MCP endpoint. The data and
//! the access rules are `GET /api/workspaces/{id}/home`'s own (tests/home.rs); this checks the
//! tool's words, its workspace argument and the REST route through `api_request`.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

async fn tasks(r: &Rig) {
    r.table("Tasks").await;
    r.field("Tasks", "Due", "date", json!({})).await;
    r.field("Tasks", "Done", "checkbox", json!({})).await;
    r.agent
        .call(
            "update_table_settings",
            json!({"project_id": r.base, "table": "Tasks",
                   "home_date_field": "Due", "done_field": "Done"}),
        )
        .await;
}

#[tokio::test]
async fn get_home_lists_what_is_due_what_changed_and_the_drafts() {
    let r = Rig::new().await;
    tasks(&r).await;
    let today = chrono::Utc::now().date_naive();
    let yesterday = today.pred_opt().unwrap().to_string();
    r.records(
        "Tasks",
        json!([
            {"fields": {"Name": "Pay rent", "Due": yesterday}},
            {"fields": {"Name": "Call mum", "Due": today.to_string()}},
            {"fields": {"Name": "Already done", "Due": today.to_string(), "Done": true}},
            {"fields": {"Name": "Someday"}},
        ]),
    )
    .await;
    r.agent
        .call("add_to_inbox", json!({"title": "stamps", "body": ""}))
        .await;

    // One workspace: no argument needed, and a name works as well as an id.
    let by_default = r.agent.call("get_home", json!({})).await;
    let by_name = r
        .agent
        .call("get_home", json!({"workspace": "Workspace"}))
        .await;
    assert_eq!(by_default["due"], by_name["due"]);
    let home = by_default;
    assert_eq!(home["workspace"], "Workspace");
    assert_eq!(home["workspace_id"], r.ws.as_str());
    assert_eq!(home["truncated"], false);
    assert!(home.get("hint").is_none());

    let due = home["due"].as_array().unwrap();
    let titles: Vec<&str> = due.iter().map(|d| d["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Pay rent", "Call mum"]);
    assert_eq!(due[0]["overdue"], true);
    assert_eq!(due[0]["table"], "Tasks");
    assert_eq!(due[0]["project"], "Base");
    assert_eq!(due[0]["project_id"], r.base.as_str());
    assert_eq!(due[0]["can_edit"], true);
    assert!(due[0]["done_field_id"].is_string());
    assert!(due[0].get("time").is_none(), "a date has no time");
    assert!(due[0].get("base_id").is_none(), "tools say project");

    let recent = home["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 4);
    assert_eq!(recent[0]["kind"], "create");
    assert!(recent[0]["at"].as_i64().unwrap() > 0);
    assert_eq!(home["drafts"][0]["title"], "stamps");
}

#[tokio::test]
async fn get_home_asks_which_workspace_when_there_are_several() {
    let r = Rig::new().await;
    r.agent
        .call("create_workspace", json!({"name": "Second"}))
        .await;
    let e = r.agent.fails("get_home", json!({})).await;
    assert!(
        e.contains("Several workspaces") && e.contains("'Second'"),
        "{e}"
    );
    let e = r
        .agent
        .fails("get_home", json!({"workspace": "Nope"}))
        .await;
    assert!(e.contains("not found"), "{e}");
    let ok = r
        .agent
        .call("get_home", json!({"workspace": "Second"}))
        .await;
    assert_eq!(ok["due"], json!([]));
    assert_eq!(ok["workspace"], "Second");
}

#[tokio::test]
async fn get_home_works_for_a_read_token_and_api_request_reaches_the_route() {
    let r = Rig::new().await;
    tasks(&r).await;
    let today = chrono::Utc::now().date_naive().to_string();
    r.records(
        "Tasks",
        json!([{"fields": {"Name": "Read me", "Due": today}}]),
    )
    .await;
    let read = r.agent_with(json!({"write": false})).await;
    let home = read.call("get_home", json!({})).await;
    assert_eq!(home["due"][0]["title"], "Read me");
    assert_eq!(
        home["due"][0]["can_edit"], false,
        "a read-only token cannot edit"
    );

    let raw = r
        .agent
        .call(
            "api_request",
            json!({"method": "GET", "path": format!("/api/workspaces/{}/home", r.ws)}),
        )
        .await;
    assert_eq!(raw["status"], 200, "{raw}");
    assert_eq!(raw["body"]["due"][0]["title"], "Read me");
    let listed: Value = r
        .agent
        .call("api_reference", json!({"area": "workspaces"}))
        .await;
    assert!(listed.to_string().contains("/api/workspaces/{id}/home"));
}
