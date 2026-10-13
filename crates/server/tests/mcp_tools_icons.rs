//! Icons through MCP tools: an agent sets, changes, keeps and clears the icon of a workspace, a
//! base and a table and reads them back; names are checked against the Lucide list with
//! suggestions; `list_icons` searches. (The REST API itself validates the format only; see
//! `icons.rs`.)

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::json;

#[tokio::test]
async fn an_agent_sets_changes_keeps_and_clears_icons_on_workspace_base_and_table() {
    let r = Rig::new().await;
    let a = &r.agent;

    // ---- workspace: create with an icon, read it back from both listings, change, keep, clear
    let ws = a
        .call(
            "create_workspace",
            json!({"name": "Icons", "icon": "briefcase"}),
        )
        .await;
    assert_eq!(ws["workspace"]["icon"], "briefcase");
    let ws_id = ws["workspace"]["id"].as_str().unwrap().to_string();
    let listed = |v: &serde_json::Value, id: &str| {
        v["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        listed(&a.call("list_workspaces", json!({})).await, &ws_id)["icon"],
        "briefcase"
    );
    assert_eq!(
        listed(&a.call("list_bases", json!({})).await, &ws_id)["icon"],
        "briefcase"
    );
    // a workspace without an icon has none in list_bases (left out, not an empty string)
    let plain = listed(&a.call("list_bases", json!({})).await, &r.ws);
    assert!(plain.get("icon").is_none(), "{plain}");

    // renaming alone keeps the icon
    let renamed = a
        .call(
            "rename_workspace",
            json!({"workspace_id": ws_id, "name": "Icons 2"}),
        )
        .await;
    assert_eq!(renamed["workspace"]["name"], "Icons 2");
    assert_eq!(renamed["workspace"]["icon"], "briefcase");
    // change the icon without touching the name
    let changed = a
        .call(
            "rename_workspace",
            json!({"workspace_id": ws_id, "icon": "users"}),
        )
        .await;
    assert_eq!(changed["workspace"]["icon"], "users");
    assert_eq!(changed["workspace"]["name"], "Icons 2");
    // null clears
    let cleared = a
        .call(
            "rename_workspace",
            json!({"workspace_id": ws_id, "icon": null}),
        )
        .await;
    assert!(cleared["workspace"]["icon"].is_null(), "{cleared}");
    assert!(
        listed(&a.call("list_bases", json!({})).await, &ws_id)
            .get("icon")
            .is_none()
    );
    // nothing to change
    let err = a
        .fails("rename_workspace", json!({"workspace_id": ws_id}))
        .await;
    assert!(err.contains("name and/or icon"), "{err}");

    // ---- base: create with an icon, schema and listings show it, change, keep, clear
    let base = a
        .call(
            "create_base",
            json!({"workspace_id": ws_id, "name": "CRM", "icon": "store"}),
        )
        .await;
    assert_eq!(base["base"]["icon"], "store");
    let base_id = base["base"]["id"].as_str().unwrap().to_string();
    let schema = a.call("get_base_schema", json!({"base_id": base_id})).await;
    assert_eq!(schema["icon"], "store");
    let in_list = listed(&a.call("list_bases", json!({})).await, &ws_id)["bases"][0].clone();
    assert_eq!(in_list["icon"], "store");

    let kept = a
        .call("rename_base", json!({"base_id": base_id, "color": "green"}))
        .await;
    assert_eq!(kept["base"]["icon"], "store", "absent = unchanged");
    let changed = a
        .call(
            "rename_base",
            json!({"base_id": base_id, "icon": "package"}),
        )
        .await;
    assert_eq!(changed["base"]["icon"], "package");
    let cleared = a
        .call("rename_base", json!({"base_id": base_id, "icon": null}))
        .await;
    assert!(cleared["base"].get("icon").is_none(), "{cleared}");
    assert!(a.call("get_base_schema", json!({"base_id": base_id})).await["icon"].is_null());

    // ---- table
    let table = a
        .call(
            "create_table",
            json!({"base_id": base_id, "name": "Orders", "icon": "shopping-cart"}),
        )
        .await;
    assert_eq!(table["table"]["icon"], "shopping-cart");
    let table_icon = |schema: &serde_json::Value, name: &str| {
        schema["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()["icon"]
            .clone()
    };
    let schema = a.call("get_base_schema", json!({"base_id": base_id})).await;
    assert_eq!(table_icon(&schema, "Orders"), "shopping-cart");
    assert!(
        table_icon(&schema, "Table 1").is_null(),
        "tables without an icon have none"
    );

    let kept = a
        .call(
            "rename_table",
            json!({"base_id": base_id, "table": "Orders", "description": "Open orders"}),
        )
        .await;
    assert_eq!(kept["table"]["icon"], "shopping-cart");
    let changed = a
        .call(
            "rename_table",
            json!({"base_id": base_id, "table": "Orders", "icon": "truck"}),
        )
        .await;
    assert_eq!(changed["table"]["icon"], "truck");
    // a duplicate keeps the icon
    let copy = a
        .call(
            "duplicate_table",
            json!({"base_id": base_id, "table": "Orders", "name": "Orders copy"}),
        )
        .await;
    assert_eq!(copy["table"]["icon"], "truck");
    let cleared = a
        .call(
            "rename_table",
            json!({"base_id": base_id, "table": "Orders", "icon": null}),
        )
        .await;
    assert!(cleared["table"].get("icon").is_none(), "{cleared}");
    let schema = a.call("get_base_schema", json!({"base_id": base_id})).await;
    assert!(table_icon(&schema, "Orders").is_null());
    assert_eq!(table_icon(&schema, "Orders copy"), "truck");
    let err = a
        .fails(
            "rename_table",
            json!({"base_id": base_id, "table": "Orders"}),
        )
        .await;
    assert!(err.contains("name, description and/or icon"), "{err}");

    // ---- the REST API sees the same values (and keeps its own, format-only validation)
    let rest = r
        .app()
        .get(&r.admin, &format!("/api/bases/{base_id}"))
        .await;
    rest.assert_status(200);
    assert!(rest.body["icon"].is_null());
    assert_eq!(
        rest.body["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Orders copy")
            .unwrap()["icon"],
        "truck"
    );
}

#[tokio::test]
async fn unknown_icons_are_refused_with_suggestions_and_aliases_are_canonicalised() {
    let r = Rig::new().await;
    let a = &r.agent;

    // typo -> did you mean
    let err = a
        .fails(
            "create_base",
            json!({"workspace_id": r.ws, "name": "X", "icon": "shoping-cart"}),
        )
        .await;
    assert!(err.contains("not a known icon"), "{err}");
    assert!(
        err.contains("Did you mean") && err.contains("shopping-cart"),
        "{err}"
    );
    assert!(err.contains("list_icons"), "{err}");
    // nothing was created by the failed call
    let bases = a.call("list_bases", json!({})).await;
    assert_eq!(bases["workspaces"][0]["bases"].as_array().unwrap().len(), 1);

    // a description of what is wanted instead of a name still gets help
    let err = a
        .fails(
            "rename_workspace",
            json!({"workspace_id": r.ws, "icon": "money"}),
        )
        .await;
    assert!(err.contains("Did you mean"), "{err}");
    let err = a
        .fails(
            "create_workspace",
            json!({"name": "W", "icon": "zzzzqqqqzzzz"}),
        )
        .await;
    assert!(
        err.contains("not a known icon") && !err.contains("Did you mean"),
        "{err}"
    );
    let err = a
        .fails(
            "create_table",
            json!({"base_id": r.base, "name": "T", "icon": ""}),
        )
        .await;
    assert!(err.contains("not a known icon"), "{err}");
    // wrong type
    let err = a
        .fails("rename_base", json!({"base_id": r.base, "icon": 5}))
        .await;
    assert!(err.contains("Invalid arguments"), "{err}");

    // the unchanged state is intact
    let s = r.schema().await;
    assert!(s["icon"].is_null());

    // an alias ("home" is the old name of "house") and loose spelling are stored canonically
    let ws = a
        .call("create_workspace", json!({"name": "Alias", "icon": "home"}))
        .await;
    assert_eq!(ws["workspace"]["icon"], "house");
    assert!(ws["note"].as_str().unwrap().contains("'house'"), "{ws}");
    let base = a
        .call(
            "rename_base",
            json!({"base_id": r.base, "icon": "Chart Column"}),
        )
        .await;
    assert_eq!(base["base"]["icon"], "chart-column");
    assert!(base["note"].is_string());
    // a canonical name has no note
    let table = a
        .call(
            "create_table",
            json!({"base_id": r.base, "name": "Plain", "icon": "folder"}),
        )
        .await;
    assert!(table.get("note").is_none(), "{table}");

    // the REST API only checks the format: a well-formed name that is not in the list works there
    let rest = r
        .app()
        .patch(
            &r.admin,
            &format!("/api/bases/{}", r.base),
            json!({"icon": "brand-new-icon"}),
        )
        .await;
    rest.assert_status(200);
    assert_eq!(rest.body["icon"], "brand-new-icon");
    // and the agent can still read it and clear it
    assert_eq!(r.schema().await["icon"], "brand-new-icon");
    a.call("rename_base", json!({"base_id": r.base, "icon": null}))
        .await;
    assert!(r.schema().await["icon"].is_null());
}

#[tokio::test]
async fn list_icons_searches_the_lucide_names() {
    let r = Rig::new().await;
    let a = &r.agent;

    let cart = a
        .call("list_icons", json!({"query": "shopping cart"}))
        .await;
    assert_eq!(cart["icons"][0], "shopping-cart");
    assert!(cart["total_icons"].as_u64().unwrap() > 1500);
    assert!(cart["matches"].as_u64().unwrap() >= 1);

    // old names find the icon that replaced them
    assert_eq!(
        a.call("list_icons", json!({"query": "home"})).await["icons"][0],
        "house"
    );

    // the 20 icons of the web picker are all there
    for name in [
        "briefcase",
        "users",
        "house",
        "building",
        "store",
        "shopping-cart",
        "package",
        "truck",
        "calendar",
        "clipboard-list",
        "list-checks",
        "file-text",
        "folder",
        "wallet",
        "chart-column",
        "target",
        "star",
        "heart",
        "megaphone",
        "wrench",
    ] {
        let found = a
            .call("list_icons", json!({"query": name, "limit": 5}))
            .await;
        assert_eq!(found["icons"][0], name, "searching {name}: {found}");
    }

    // limits and the note about more matches
    let few = a
        .call("list_icons", json!({"query": "arrow", "limit": 3}))
        .await;
    assert_eq!(few["icons"].as_array().unwrap().len(), 3);
    assert!(few["matches"].as_u64().unwrap() > 3);
    assert!(few["note"].as_str().unwrap().contains("narrow the query"));
    let first = a.call("list_icons", json!({})).await;
    assert_eq!(
        first["icons"].as_array().unwrap().len(),
        40,
        "default limit"
    );
    let max = a.call("list_icons", json!({"limit": 200})).await;
    assert_eq!(max["icons"].as_array().unwrap().len(), 200);
    let none = a.call("list_icons", json!({"query": "zzzzqqq"})).await;
    assert_eq!(none["icons"].as_array().unwrap().len(), 0);
    assert!(none["note"].is_string());

    // bad arguments
    // a limit below 1 is raised to 1
    assert_eq!(
        a.call("list_icons", json!({"limit": 0})).await["icons"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        a.fails("list_icons", json!({"nope": 1}))
            .await
            .contains("Invalid arguments")
    );
}

#[tokio::test]
async fn icon_tools_respect_the_token_scope_and_roles() {
    let r = Rig::new().await;
    // read-only and write-only tokens: list_icons is a read tool, rename_workspace needs manage
    let read = r.agent_with(json!({"write": false})).await;
    assert!(read.tool_names().await.contains(&"list_icons".to_string()));
    let write = r.agent_with(json!({"write": true})).await;
    let err = write
        .fails(
            "rename_workspace",
            json!({"workspace_id": r.ws, "icon": "star"}),
        )
        .await;
    assert!(err.contains("manage"), "{err}");
    let err = write
        .fails("create_workspace", json!({"name": "N", "icon": "star"}))
        .await;
    assert!(err.contains("manage"), "{err}");
    // a write token (no manage) may restyle bases and tables, a read-only one may not
    write
        .call("rename_base", json!({"base_id": r.base, "icon": "star"}))
        .await;
    let err = read
        .fails("rename_base", json!({"base_id": r.base, "icon": "heart"}))
        .await;
    assert!(
        err.contains("read-only") || err.contains("viewer") || err.contains("role"),
        "{err}"
    );
    assert_eq!(r.schema().await["icon"], "star");

    // an editor cannot change icons (creator role), and the refusal says why
    let (_editor, editor_agent) = r
        .teammate("ed@example.com", "editor", json!({"write": true}))
        .await;
    let err = editor_agent
        .fails("rename_base", json!({"base_id": r.base, "icon": "heart"}))
        .await;
    assert!(err.contains("creator"), "{err}");
    assert_eq!(r.schema().await["icon"], "star");
}
