//! Agent access in the UX overhaul (AGT-1, AGT-3, AGT-4): who may create and delete workspaces
//! and projects through MCP, the top level an agent gets with a new workspace, and what a
//! delete tells the agent about the trash. The OAuth side and the TypeScript contract tests
//! (AGT-6) come later.

mod common;
mod mcp_support;

use chrono::{DateTime, SecondsFormat};
use mcp_support::*;
use serde_json::{Value, json};

/// The listed description of a tool, as a client sees it.
async fn description(a: &Agent, name: &str) -> String {
    let (_, body) = a.rpc("tools/list", json!({})).await;
    body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("no tool {name}"))["description"]
        .as_str()
        .unwrap()
        .to_string()
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

// ------------------------------------------------------------------------------------ AGT-1

#[tokio::test]
async fn creating_a_workspace_needs_full_access_and_nothing_more() {
    let r = Rig::new().await;
    // Write without manage: refused, and the error names the missing permission.
    let writer = r.agent_with(json!({"write": true})).await;
    let e = writer
        .fails("create_workspace", json!({"name": "Nope"}))
        .await;
    assert!(e.contains("'manage' permission"), "{e}");
    // Full access (write and manage) is enough; no role is involved because the caller becomes
    // the owner.
    let made = r
        .agent
        .call("create_workspace", json!({"name": "Yes"}))
        .await;
    assert_eq!(made["workspace"]["role"], "owner");
}

#[tokio::test]
async fn creating_a_folder_needs_the_creator_role_and_deleting_needs_the_owner() {
    let r = Rig::new().await;
    let side = |name: &str| json!({"workspace_id": r.ws, "name": name});

    // An editor cannot create a folder, even with full access.
    let (_, editor) = r
        .teammate(
            "ed@example.com",
            "editor",
            json!({"write": true, "manage": true}),
        )
        .await;
    let e = editor.fails("create_project", side("Editors")).await;
    assert!(e.to_lowercase().contains("creator"), "{e}");

    // A creator can create one with write access alone, but cannot delete it: that is for the
    // workspace owner, and so is deleting the workspace.
    let (_, creator) = r
        .teammate(
            "cr@example.com",
            "creator",
            json!({"write": true, "manage": true}),
        )
        .await;
    let made = creator.call("create_project", side("Creators")).await;
    let folder = made["base"]["id"].as_str().unwrap().to_string();
    let e = creator
        .fails("delete_project", json!({"project_id": folder}))
        .await;
    assert!(e.to_lowercase().contains("owner"), "{e}");
    let e = creator
        .fails("delete_workspace", json!({"workspace_id": r.ws}))
        .await;
    assert!(e.to_lowercase().contains("owner"), "{e}");

    // The owner needs full access to delete: write alone is not offered the tools and is told
    // which permission is missing.
    let writer = r.agent_with(json!({"write": true})).await;
    let w = writer.create_project_named(&r.ws, "Writers").await;
    let e = writer
        .fails("delete_project", json!({"project_id": w}))
        .await;
    assert!(e.contains("'manage' permission"), "{e}");
    let e = writer
        .fails("delete_workspace", json!({"workspace_id": r.ws}))
        .await;
    assert!(e.contains("'manage' permission"), "{e}");

    // With full access the owner deletes both kinds.
    r.agent
        .call("delete_project", json!({"project_id": folder}))
        .await;
    r.agent
        .call("delete_project", json!({"project_id": w}))
        .await;
    r.agent
        .call("delete_workspace", json!({"workspace_id": r.ws}))
        .await;
}

trait CreateProject {
    async fn create_project_named(&self, workspace: &str, name: &str) -> String;
}

impl CreateProject for Agent {
    async fn create_project_named(&self, workspace: &str, name: &str) -> String {
        self.call(
            "create_project",
            json!({"workspace_id": workspace, "name": name}),
        )
        .await["base"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

// ------------------------------------------------------------------------------------ AGT-3

#[tokio::test]
async fn create_workspace_returns_the_workspace_and_its_top_level_project() {
    let r = Rig::new().await;
    let a = &r.agent;
    let made = a.call("create_workspace", json!({"name": "Acme Co"})).await;
    let ws = text(&made["workspace_id"]);
    let top = text(&made["top_level_project"]);
    assert!(!ws.is_empty(), "{made}");
    assert!(!top.is_empty() && top != ws, "{made}");
    // The unchanged summary is still there, and names the same two ids.
    assert_eq!(made["workspace"]["id"], ws.as_str());
    assert_eq!(made["workspace"]["root_base_id"], top.as_str());
    assert_eq!(made["workspace"]["bases"][0]["id"], top.as_str());
    assert_eq!(made["workspace"]["bases"][0]["name"], "Acme Co");

    // The project works at once: a table goes straight into it.
    a.call(
        "create_table",
        json!({"project_id": top, "name": "Contacts"}),
    )
    .await;

    // list_projects agrees on which project is the top level.
    let listed = a.call("list_projects", json!({})).await;
    let entry = listed["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == ws.as_str())
        .unwrap();
    assert_eq!(entry["top_level_project"], top.as_str());
    assert_eq!(entry["bases"][0]["is_top_level"], true);

    // The REST endpoint behind it answers the same, through api_request too.
    let rest = a
        .call(
            "api_request",
            json!({"method": "POST", "path": "/api/workspaces", "body": {"name": "Rest Co"}}),
        )
        .await;
    assert_eq!(rest["status"], 201, "{rest}");
    assert_eq!(
        rest["body"]["root_base_id"], rest["body"]["bases"][0]["id"],
        "{rest}"
    );
}

#[tokio::test]
async fn project_tools_say_a_project_is_a_folder_in_the_app() {
    let r = Rig::new().await;
    for tool in [
        "list_projects",
        "get_project_schema",
        "create_project",
        "rename_project",
        "duplicate_project",
        "delete_project",
        "set_top_level_project",
    ] {
        let d = description(&r.agent, tool).await;
        assert!(d.contains("folder"), "{tool}: {d}");
    }
    let d = description(&r.agent, "create_workspace").await;
    assert!(
        d.contains("top-level project") && d.contains("top_level_project"),
        "{d}"
    );
    let d = description(&r.agent, "delete_project").await;
    assert!(
        d.contains("set_top_level_project") && d.contains("delete the workspace"),
        "{d}"
    );
}

#[tokio::test]
async fn deleting_the_top_level_project_is_refused_with_the_fix() {
    let r = Rig::new().await;
    let e = r
        .agent
        .fails("delete_project", json!({"project_id": r.base}))
        .await;
    assert!(
        e.contains("Make another folder the top level first, or delete the workspace"),
        "{e}"
    );
    // Nothing moved: the project is still live and still the top level.
    let listed = r.agent.call("list_projects", json!({})).await;
    assert_eq!(
        listed["workspaces"][0]["top_level_project"],
        r.base.as_str()
    );
    // The old alias takes the same road.
    let e = r
        .agent
        .fails("delete_base", json!({"base_id": r.base}))
        .await;
    assert!(e.contains("top level"), "{e}");
}

// ------------------------------------------------------------------------------------ AGT-4

/// The date the purge will erase a trashed workspace or project, from the database.
fn purge_date(r: &Rig, table: &str, id: &str) -> String {
    let deleted_at = r.app().query_i64(
        &format!("SELECT deleted_at FROM {table} WHERE id = ?1"),
        &[id],
    );
    let days = i64::from(r.app().state.config.trash_days);
    DateTime::from_timestamp_millis(deleted_at + days * 24 * 3600 * 1000)
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[tokio::test]
async fn delete_project_says_what_moved_how_to_restore_it_and_when_it_is_purged() {
    let r = Rig::new().await;
    let a = &r.agent;
    let side = a.create_project_named(&r.ws, "Side").await;
    a.call("create_table", json!({"project_id": side, "name": "One"}))
        .await;
    a.call("create_table", json!({"project_id": side, "name": "Two"}))
        .await;

    let out = a.call("delete_project", json!({"project_id": side})).await;
    assert_eq!(out["deleted"], side.as_str(), "the old key stays");
    assert_eq!(out["trashed"]["kind"], "project");
    assert_eq!(out["trashed"]["id"], side.as_str());
    assert_eq!(out["trashed"]["name"], "Side");
    // A new project starts with "Table 1".
    assert_eq!(out["trashed"]["tables"], 3);
    assert_eq!(out["restore_with"]["tool"], "restore_from_trash");
    assert_eq!(
        out["restore_with"]["arguments"],
        json!({"kind": "project", "id": side})
    );
    assert_eq!(out["retention_days"], 30);
    let purge = text(&out["purge_after"]);
    assert_eq!(purge, purge_date(&r, "bases", &side));
    let note = text(&out["note"]);
    assert!(note.contains("trash, not erased"), "{note}");
    assert!(note.contains("restore_from_trash"), "{note}");
    assert!(note.contains(&purge), "{note}");
    assert!(note.contains("'Side'"), "{note}");

    // The listed trash shows it, and the restore recipe in the result works as written.
    let trash = a.call("list_trash", json!({"workspace_id": r.ws})).await;
    assert!(
        trash["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == side.as_str()),
        "{trash}"
    );
    a.call(
        &text(&out["restore_with"]["tool"]),
        out["restore_with"]["arguments"].clone(),
    )
    .await;
    let schema = a
        .call("get_project_schema", json!({"project_id": side}))
        .await;
    assert_eq!(schema["tables"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn delete_workspace_says_what_moved_how_to_restore_it_and_when_it_is_purged() {
    let r = Rig::new().await;
    let a = &r.agent;
    let made = a.call("create_workspace", json!({"name": "Doomed"})).await;
    let ws = text(&made["workspace_id"]);
    let top = text(&made["top_level_project"]);
    a.call("create_table", json!({"project_id": top, "name": "Notes"}))
        .await;
    let side = a.create_project_named(&ws, "Side").await;

    let out = a
        .call("delete_workspace", json!({"workspace_id": ws}))
        .await;
    assert_eq!(out["deleted"], ws.as_str(), "the old key stays");
    assert_eq!(out["trashed"]["kind"], "workspace");
    assert_eq!(out["trashed"]["id"], ws.as_str());
    assert_eq!(out["trashed"]["name"], "Doomed");
    let projects: Vec<(String, i64)> = out["trashed"]["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (text(&p["id"]), p["tables"].as_i64().unwrap()))
        .collect();
    assert!(projects.contains(&(top.clone(), 1)), "{out}");
    assert!(projects.contains(&(side.clone(), 1)), "{out}");
    assert_eq!(out["restore_with"]["tool"], "restore_from_trash");
    assert_eq!(
        out["restore_with"]["arguments"],
        json!({"kind": "workspace", "id": ws})
    );
    let purge = text(&out["purge_after"]);
    assert_eq!(purge, purge_date(&r, "workspaces", &ws));
    let note = text(&out["note"]);
    assert!(
        note.contains("'Doomed'") && note.contains("2 projects"),
        "{note}"
    );
    assert!(note.contains(&purge), "{note}");

    // It is gone from the listing and back after the restore the result describes.
    let names = |v: &Value| -> Vec<String> {
        v["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| text(&w["id"]))
            .collect()
    };
    assert!(!names(&a.call("list_projects", json!({})).await).contains(&ws));
    a.call(
        &text(&out["restore_with"]["tool"]),
        out["restore_with"]["arguments"].clone(),
    )
    .await;
    let after = a.call("list_projects", json!({})).await;
    assert!(names(&after).contains(&ws));
    let entry = after["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == ws.as_str())
        .unwrap();
    assert_eq!(entry["top_level_project"], top.as_str());
}

#[tokio::test]
async fn no_tool_or_endpoint_erases_a_workspace_or_project_for_good() {
    let r = Rig::new().await;
    let a = &r.agent;
    for name in a.tool_names().await {
        for word in ["purge", "erase", "empty_trash", "destroy", "wipe"] {
            assert!(!name.contains(word), "{name} looks like a permanent delete");
        }
    }
    // The REST catalogue has no way to erase trash items: restoring is the only trash write.
    let reference = a.text("api_reference", json!({"area": "trash"})).await;
    assert!(reference.contains("/api/trash/restore"), "{reference}");
    assert!(!reference.contains("DELETE"), "{reference}");
    for path in ["/api/trash", "/api/trash/purge", "/api/trash/workspaces"] {
        // Refused or not found; either way the tool reports the HTTP status as an error.
        let (is_error, body, _) = a
            .raw("api_request", json!({"method": "DELETE", "path": path}))
            .await;
        assert!(
            is_error && (body.contains("\"status\":404") || body.contains("\"status\":405")),
            "DELETE {path}: {body}"
        );
    }

    // Deleting twice does not erase either: the second delete finds nothing live, and the row
    // is still in the database, marked deleted.
    let side = a.create_project_named(&r.ws, "Side").await;
    a.call("delete_project", json!({"project_id": side})).await;
    a.fails("delete_project", json!({"project_id": side})).await;
    assert_eq!(
        r.app().query_i64(
            "SELECT COUNT(*) FROM bases WHERE id = ?1 AND deleted_at IS NOT NULL",
            &[&side]
        ),
        1
    );
    let made = a.call("create_workspace", json!({"name": "Gone"})).await;
    let ws = text(&made["workspace_id"]);
    a.call("delete_workspace", json!({"workspace_id": ws}))
        .await;
    assert_eq!(
        r.app().query_i64(
            "SELECT COUNT(*) FROM workspaces WHERE id = ?1 AND deleted_at IS NOT NULL",
            &[&ws]
        ),
        1
    );
}
