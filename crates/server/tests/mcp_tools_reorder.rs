//! The reorder tools: workspaces (your own order), projects, tables and views, by name or id.
//! The listed ones take the places they held; the others stay.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap().to_string())
        .collect()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn reorder_workspaces_by_name_or_id() {
    let r = Rig::new().await;
    let a = &r.agent;
    let mut ids = vec![r.ws.clone()];
    for n in ["Second", "Third"] {
        let ws = a.call("create_workspace", json!({"name": n})).await;
        ids.push(ws["workspace"]["id"].as_str().unwrap().to_string());
    }

    let all = a
        .call(
            "reorder_workspaces",
            json!({"workspaces": ["Third", ids[1], "workspace"]}),
        )
        .await;
    assert_eq!(
        names(&all["workspaces"]),
        strings(&["Third", "Second", "Workspace"])
    );
    assert_eq!(all["workspaces"][0]["id"], ids[2].as_str());

    // two of three: they swap, the one left out stays in the middle
    let part = a
        .call(
            "reorder_workspaces",
            json!({"workspaces": ["Workspace", "Third"]}),
        )
        .await;
    assert_eq!(
        names(&part["workspaces"]),
        strings(&["Workspace", "Second", "Third"])
    );
    // the same list again changes nothing
    let again = a
        .call(
            "reorder_workspaces",
            json!({"workspaces": ["Workspace", "Third"]}),
        )
        .await;
    assert_eq!(again["workspaces"], part["workspaces"]);

    // list_projects shows the same order
    let listed = a.call("list_projects", json!({})).await;
    assert_eq!(
        names(&listed["workspaces"]),
        strings(&["Workspace", "Second", "Third"])
    );

    let e = a
        .fails("reorder_workspaces", json!({"workspaces": ["Nope"]}))
        .await;
    assert!(
        e.contains("workspace 'Nope' not found") && e.contains("'Second'"),
        "{e}"
    );
    let e = a
        .fails("reorder_workspaces", json!({"workspaces": []}))
        .await;
    assert!(e.contains("at least one workspace"), "{e}");
    let e = a
        .fails(
            "reorder_workspaces",
            json!({"workspaces": ["Second", &ids[1]]}),
        )
        .await;
    assert!(e.contains("listed twice"), "{e}");
}

#[tokio::test]
async fn reorder_workspaces_needs_write_access_but_not_manage() {
    let r = Rig::new().await;
    let second = r
        .agent
        .call("create_workspace", json!({"name": "Second"}))
        .await;
    let second = second["workspace"]["id"].as_str().unwrap().to_string();

    let read = r.agent_with(json!({"write": false})).await;
    assert!(
        !read
            .tool_names()
            .await
            .contains(&"reorder_workspaces".to_string())
    );
    let write = r.agent_with(json!({"write": true, "manage": false})).await;
    let tools = write.tool_names().await;
    for t in [
        "reorder_workspaces",
        "reorder_projects",
        "reorder_tables",
        "reorder_views",
    ] {
        assert!(tools.contains(&t.to_string()), "{t}");
    }
    let out = write
        .call(
            "reorder_workspaces",
            json!({"workspaces": [second, "Workspace"]}),
        )
        .await;
    assert_eq!(names(&out["workspaces"]), strings(&["Second", "Workspace"]));
}

#[tokio::test]
async fn reorder_projects_in_a_workspace() {
    let r = Rig::new().await;
    let a = &r.agent;
    for n in ["Two", "Three"] {
        a.call("create_base", json!({"workspace_id": r.ws, "name": n}))
            .await;
    }
    let all = a
        .call(
            "reorder_projects",
            json!({"workspace": "Workspace", "projects": ["Three", "Two", "Base"]}),
        )
        .await;
    assert_eq!(all["workspace"]["name"], "Workspace");
    assert_eq!(names(&all["projects"]), strings(&["Three", "Two", "Base"]));

    let part = a
        .call(
            "reorder_projects",
            json!({"workspace": r.ws, "projects": ["Base", "three"]}),
        )
        .await;
    assert_eq!(names(&part["projects"]), strings(&["Base", "Two", "Three"]));

    let e = a
        .fails(
            "reorder_projects",
            json!({"workspace": "Workspace", "projects": ["Nope"]}),
        )
        .await;
    assert!(
        e.contains("project 'Nope' not found in workspace 'Workspace'") && e.contains("'Two'"),
        "{e}"
    );
    let e = a
        .fails(
            "reorder_projects",
            json!({"workspace": "Nowhere", "projects": ["Base"]}),
        )
        .await;
    assert!(e.contains("workspace 'Nowhere' not found"), "{e}");

    // editors may not
    let (_, editor) = r
        .teammate("ed@example.com", "editor", json!({"write": true}))
        .await;
    let e = editor
        .fails(
            "reorder_projects",
            json!({"workspace": "Workspace", "projects": ["Two", "Base"]}),
        )
        .await;
    assert!(e.contains("creator"), "{e}");
}

#[tokio::test]
async fn reorder_tables_in_a_project() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    for n in ["Customers", "Orders", "Invoices"] {
        r.table(n).await;
    }
    let all = a
        .call(
            "reorder_tables",
            json!({"project_id": b, "tables": ["Invoices", "Orders", "Customers"]}),
        )
        .await;
    assert_eq!(all["project"]["name"], "Base");
    assert_eq!(
        names(&all["tables"]),
        strings(&["Invoices", "Orders", "Customers"])
    );
    let part = a
        .call(
            "reorder_tables",
            json!({"project_id": b, "tables": ["Customers", "invoices"]}),
        )
        .await;
    assert_eq!(
        names(&part["tables"]),
        strings(&["Customers", "Orders", "Invoices"])
    );
    // get_project_schema agrees
    let schema = r.schema().await;
    assert_eq!(
        names(&schema["tables"]),
        strings(&["Customers", "Orders", "Invoices"])
    );

    let e = a
        .fails(
            "reorder_tables",
            json!({"project_id": b, "tables": ["Nope"]}),
        )
        .await;
    assert!(
        e.contains("table 'Nope' not found in project 'Base'") && e.contains("'Orders'"),
        "{e}"
    );
    let e = a
        .fails("reorder_tables", json!({"project_id": b, "tables": []}))
        .await;
    assert!(e.contains("at least one table"), "{e}");

    let (_, editor) = r
        .teammate("ed@example.com", "editor", json!({"write": true}))
        .await;
    let e = editor
        .fails(
            "reorder_tables",
            json!({"project_id": b, "tables": ["Orders", "Customers"]}),
        )
        .await;
    assert!(e.contains("creator"), "{e}");
}

#[tokio::test]
async fn reorder_views_in_a_table() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    for n in ["Open", "Done", "Mine"] {
        a.call(
            "create_view",
            json!({"project_id": b, "table": "Tasks", "name": n, "type": "grid"}),
        )
        .await;
    }
    let all = a
        .call(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Mine", "Done", "Open"]}),
        )
        .await;
    assert_eq!(all["table"]["name"], "Tasks");
    assert_eq!(names(&all["views"]), strings(&["Mine", "Done", "Open"]));
    assert_eq!(all["views"][0]["personal"], false);
    assert!(all["note"].as_str().unwrap().contains("default grid"));

    let part = a
        .call(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Open", "mine"]}),
        )
        .await;
    assert_eq!(names(&part["views"]), strings(&["Open", "Done", "Mine"]));
    // the schema lists the default grid first, then the views in that order
    let schema = r.schema().await;
    let table = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Tasks")
        .unwrap();
    assert_eq!(
        names(&table["views"]),
        strings(&["Default grid", "Open", "Done", "Mine"])
    );

    // the default grid is not a view you can place
    let e = a
        .fails(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Default grid", "Open"]}),
        )
        .await;
    assert!(
        e.contains("default grid") && e.contains("Leave it out"),
        "{e}"
    );
    let e = a
        .fails(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Nope"]}),
        )
        .await;
    assert!(e.contains("view 'Nope' not found in table 'Tasks'"), "{e}");
    let e = a
        .fails(
            "reorder_views",
            json!({"project_id": b, "table": "Nope", "views": ["Open"]}),
        )
        .await;
    assert!(e.contains("Table 'Nope' not found"), "{e}");

    // an editor: shared views are for creators, their own personal views are theirs to order
    let (_, editor) = r
        .teammate("ed@example.com", "editor", json!({"write": true}))
        .await;
    let e = editor
        .fails(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Done", "Open"]}),
        )
        .await;
    assert!(e.contains("creator"), "{e}");
    for n in ["P1", "P2"] {
        editor
            .call(
                "create_view",
                json!({"project_id": b, "table": "Tasks", "name": n, "type": "grid", "personal": true}),
            )
            .await;
    }
    let mine = editor
        .call(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["P2", "P1"]}),
        )
        .await;
    assert_eq!(
        names(&mine["views"]),
        strings(&["Open", "Done", "Mine", "P2", "P1"])
    );
    assert_eq!(mine["views"][3]["personal"], true);
    // the creator does not see them and the shared order is untouched
    let after = a
        .call(
            "reorder_views",
            json!({"project_id": b, "table": "Tasks", "views": ["Open"]}),
        )
        .await;
    assert_eq!(names(&after["views"]), strings(&["Open", "Done", "Mine"]));
}
