//! "Project" names in MCP (the web app calls bases projects): the project tools are listed, the
//! old base tools and `base_id` keep working as unlisted aliases, and workspaces take a colour.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::{Value, json};

const RENAMED: [(&str, &str); 6] = [
    ("list_bases", "list_projects"),
    ("get_base_schema", "get_project_schema"),
    ("create_base", "create_project"),
    ("rename_base", "rename_project"),
    ("delete_base", "delete_project"),
    ("duplicate_base", "duplicate_project"),
];

#[tokio::test]
async fn tools_list_has_the_project_names_only() {
    let r = Rig::new().await;
    let (status, body) = r.agent.rpc("tools/list", json!({})).await;
    assert_eq!(status, 200, "{body}");
    let tools = body["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for (old, new) in RENAMED {
        assert!(names.contains(&new), "{new} is not listed");
        assert!(!names.contains(&old), "{old} is still listed");
    }
    // No listed schema or description talks about bases any more.
    for t in tools {
        let schema = t["inputSchema"]["properties"].as_object().unwrap();
        assert!(!schema.contains_key("base_id"), "{}", t["name"]);
        assert!(!schema.contains_key("base_ids"), "{}", t["name"]);
        let text = format!("{} {}", t["title"], t["description"]);
        assert!(
            !text.contains("list_bases") && !text.contains("get_base_schema"),
            "{}: {text}",
            t["name"]
        );
    }
    let get = tools
        .iter()
        .find(|t| t["name"] == "get_project_schema")
        .unwrap();
    assert_eq!(get["inputSchema"]["required"], json!(["project_id"]));
    assert!(
        get["inputSchema"]["properties"]["project_id"]["description"]
            .as_str()
            .unwrap()
            .contains("called base in the REST API")
    );
    // The server's own instructions explain the naming.
    let init = r.agent.initialize().await;
    let text = init["instructions"].as_str().unwrap();
    assert!(text.contains("Start with list_projects"), "{text}");
    assert!(text.contains("called a base in the REST API"), "{text}");
    assert!(!text.contains("Start with list_bases"));
}

#[tokio::test]
async fn old_and_new_names_do_the_same_thing() {
    let r = Rig::new().await;
    let a = &r.agent;
    let old = a.call("list_bases", json!({})).await;
    let new = a.call("list_projects", json!({})).await;
    assert_eq!(old, new);
    let ws = new["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == r.ws)
        .unwrap();
    assert_eq!(ws["bases"][0]["id"], r.base);

    // project_id and base_id are the same argument.
    let by_project = a
        .call("get_project_schema", json!({"project_id": r.base}))
        .await;
    let by_base = a
        .call("get_project_schema", json!({"base_id": r.base}))
        .await;
    let by_old_tool = a.call("get_base_schema", json!({"base_id": r.base})).await;
    assert_eq!(by_project, by_base);
    assert_eq!(by_project, by_old_tool);
    assert_eq!(by_project["id"], r.base);
    // Giving both is an error, not a silent pick.
    a.fails(
        "get_project_schema",
        json!({"project_id": r.base, "base_id": r.base}),
    )
    .await;

    // The whole lifecycle through the new names.
    let made = a
        .call(
            "create_project",
            json!({"workspace_id": r.ws, "name": "Fresh", "color": "green"}),
        )
        .await;
    let id = made["base"]["id"].as_str().unwrap().to_string();
    assert_eq!(made["base"]["name"], "Fresh");
    let renamed = a
        .call(
            "rename_project",
            json!({"project_id": id, "name": "Fresher"}),
        )
        .await;
    assert_eq!(renamed["base"]["name"], "Fresher");
    let copy = a
        .call(
            "duplicate_project",
            json!({"project_id": id, "name": "Twin"}),
        )
        .await;
    assert_eq!(copy["base"]["name"], "Twin");
    let copy_id = copy["base"]["id"].as_str().unwrap().to_string();
    a.call("delete_project", json!({"project_id": copy_id}))
        .await;
    // ... and the old names still work on the same things.
    let old_made = a
        .call(
            "create_base",
            json!({"workspace_id": r.ws, "name": "Legacy"}),
        )
        .await;
    let old_id = old_made["base"]["id"].as_str().unwrap().to_string();
    a.call(
        "rename_base",
        json!({"base_id": old_id, "name": "Legacy 2"}),
    )
    .await;
    a.call("delete_base", json!({"base_id": old_id})).await;
    a.call("delete_project", json!({"project_id": id})).await;

    // Projects restore from the trash under either kind.
    a.call("restore_from_trash", json!({"kind": "project", "id": id}))
        .await;
    a.call("delete_project", json!({"project_id": id})).await;
    a.call("restore_from_trash", json!({"kind": "base", "id": id}))
        .await;
}

#[tokio::test]
async fn errors_and_other_tools_say_project() {
    let r = Rig::new().await;
    let a = &r.agent;
    let e = a
        .fails(
            "get_project_schema",
            json!({"project_id": "appNoSuchProject"}),
        )
        .await;
    assert!(e.contains("Project 'appNoSuchProject' not found"), "{e}");
    assert!(e.contains("list_projects"), "{e}");
    let e = a.fails("get_project_schema", json!({})).await;
    assert!(e.contains("project_id"), "{e}");
    // The old name reports the same problem.
    let e = a
        .fails("get_base_schema", json!({"base_id": "appNo"}))
        .await;
    assert!(e.contains("Project 'appNo' not found"), "{e}");
    // Tools of a project take project_id too.
    let t = r.table("People").await;
    let listed = a
        .call(
            "list_records",
            json!({"project_id": r.base, "table": t["id"]}),
        )
        .await;
    assert_eq!(listed["records"], json!([]));
    // Member scopes accept 'project' (and the old 'base').
    for scope in ["project", "base"] {
        a.call("list_members", json!({"scope": scope, "id": r.base}))
            .await;
    }
}

#[tokio::test]
async fn workspaces_take_a_colour_through_mcp() {
    let r = Rig::new().await;
    let a = &r.agent;
    let made = a
        .call(
            "create_workspace",
            json!({"name": "Painted", "color": "purple"}),
        )
        .await;
    assert_eq!(made["workspace"]["color"], "purple");
    let id = made["workspace"]["id"].as_str().unwrap().to_string();
    // Without a colour the next default one is picked, like in the web app.
    let plain = a.call("create_workspace", json!({"name": "Plain"})).await;
    assert!(
        plain["workspace"]["color"]
            .as_str()
            .is_some_and(|c| !c.is_empty())
    );

    let recolored = a
        .call(
            "rename_workspace",
            json!({"workspace_id": id, "color": "red"}),
        )
        .await;
    assert_eq!(recolored["workspace"]["color"], "red");
    assert_eq!(recolored["workspace"]["name"], "Painted");
    // Colour and name together; the colour alone is enough for a call.
    let both = a
        .call(
            "rename_workspace",
            json!({"workspace_id": id, "name": "Painted 2", "color": "blue"}),
        )
        .await;
    assert_eq!(both["workspace"]["color"], "blue");
    assert_eq!(both["workspace"]["name"], "Painted 2");

    // The same validation as the project colour and the REST API.
    let bad_ws = a
        .fails(
            "create_workspace",
            json!({"name": "Bad", "color": "not-a-colour"}),
        )
        .await;
    let bad_project = a
        .fails(
            "create_project",
            json!({"workspace_id": r.ws, "name": "Bad", "color": "not-a-colour"}),
        )
        .await;
    assert_eq!(bad_ws, bad_project);
    let bad_rename = a
        .fails(
            "rename_workspace",
            json!({"workspace_id": id, "color": "not-a-colour"}),
        )
        .await;
    assert_eq!(bad_rename, bad_ws);
    let still: Value = a.call("list_workspaces", json!({})).await;
    let ws = still["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == id)
        .unwrap();
    assert_eq!(ws["color"], "blue");
    a.fails("rename_workspace", json!({"workspace_id": id}))
        .await;
}
