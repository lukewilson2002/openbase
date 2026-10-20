//! Reordering siblings: workspaces (a personal order), projects of a workspace, tables of a
//! project and views of a table. The listed items take the places they held, in the given order;
//! every other sibling stays where it is.

mod common;
mod schema_support;

use common::{Client, TestApp};
use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn names_of(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap().to_string())
        .collect()
}

/// A body naming `ids`.
fn ids(v: &[&str]) -> Value {
    json!({ "ids": v })
}

fn error_text(r: &common::Response) -> String {
    r.body["error"]["message"]
        .as_str()
        .or_else(|| r.body["error"].as_str())
        .unwrap_or_default()
        .to_string()
}

// ------------------------------------------------------------------------- workspaces

/// The workspaces `c` sees, by name, in their own order.
async fn workspace_names(app: &TestApp, c: &Client) -> Vec<String> {
    let r = app.get(c, "/api/workspaces").await;
    r.assert_status(200);
    names_of(&r.body)
}

/// Create workspaces named `names` (one at a time) and return their ids.
async fn workspaces_named(app: &TestApp, c: &Client, names: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for n in names {
        out.push(workspace(app, c, n).await);
    }
    out
}

#[tokio::test]
async fn workspaces_full_partial_and_repeated_reorder() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let w = workspaces_named(&app, &alice, &["A", "B", "C", "D"]).await;
    let (a, b, c, d) = (&w[0], &w[1], &w[2], &w[3]);

    // everything: the whole order
    let r = app
        .post(&alice, "/api/workspaces/reorder", ids(&[d, c, b, a]))
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["D", "C", "B", "A"])
    );

    // a part: B and D swap places, C and A stay where they are
    app.post(&alice, "/api/workspaces/reorder", ids(&[b, d]))
        .await
        .assert_status(200);
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["B", "C", "D", "A"])
    );

    // doing it again changes nothing
    app.post(&alice, "/api/workspaces/reorder", ids(&[b, d]))
        .await
        .assert_status(200);
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["B", "C", "D", "A"])
    );

    // one id is a no-op
    app.post(&alice, "/api/workspaces/reorder", ids(&[c]))
        .await
        .assert_status(200);
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["B", "C", "D", "A"])
    );

    // a workspace created later lands at the end
    workspace(&app, &alice, "E").await;
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["B", "C", "D", "A", "E"])
    );
}

#[tokio::test]
async fn workspace_order_is_per_member() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let bob = app.user("bob@example.com", "Bob");
    let w = workspaces_named(&app, &alice, &["A", "B", "C"]).await;
    for id in &w {
        add_ws_member(&app, id, &bob, Role::Editor);
    }
    let (a, b, c) = (&w[0], &w[1], &w[2]);
    app.post(&bob, "/api/workspaces/reorder", ids(&[a, b, c]))
        .await
        .assert_status(200);
    app.post(&alice, "/api/workspaces/reorder", ids(&[c, b, a]))
        .await
        .assert_status(200);
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["C", "B", "A"])
    );
    assert_eq!(workspace_names(&app, &bob).await, strings(&["A", "B", "C"]));

    // and the other way round
    app.post(&bob, "/api/workspaces/reorder", ids(&[b, a]))
        .await
        .assert_status(200);
    assert_eq!(workspace_names(&app, &bob).await, strings(&["B", "A", "C"]));
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["C", "B", "A"])
    );

    // a workspace Bob joins after ordering comes last for him
    let d = workspace(&app, &alice, "D").await;
    add_ws_member(&app, &d, &bob, Role::Viewer);
    assert_eq!(
        workspace_names(&app, &bob).await,
        strings(&["B", "A", "C", "D"])
    );
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["C", "B", "A", "D"])
    );
}

#[tokio::test]
async fn a_viewer_can_order_their_own_workspaces() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let bob = app.user("bob@example.com", "Bob");
    let w = workspaces_named(&app, &alice, &["A", "B"]).await;
    add_ws_member(&app, &w[0], &bob, Role::Viewer);
    add_ws_member(&app, &w[1], &bob, Role::Viewer);
    app.post(&bob, "/api/workspaces/reorder", ids(&[&w[1], &w[0]]))
        .await
        .assert_status(200);
    assert_eq!(workspace_names(&app, &bob).await, strings(&["B", "A"]));
}

#[tokio::test]
async fn workspace_reorder_refuses_bad_lists_and_changes_nothing() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let bob = app.user("bob@example.com", "Bob");
    let w = workspaces_named(&app, &alice, &["A", "B", "C"]).await;
    let theirs = workspace(&app, &bob, "Bobs").await;
    app.post(
        &alice,
        "/api/workspaces/reorder",
        ids(&[&w[0], &w[1], &w[2]]),
    )
    .await
    .assert_status(200);
    let before = workspace_names(&app, &alice).await;

    let empty = app
        .post(&alice, "/api/workspaces/reorder", json!({ "ids": [] }))
        .await;
    empty.assert_status(400);
    let dup = app
        .post(
            &alice,
            "/api/workspaces/reorder",
            ids(&[&w[0], &w[1], &w[0]]),
        )
        .await;
    dup.assert_status(400);
    assert!(error_text(&dup).contains(&w[0]), "{:?}", dup.body);
    let unknown = app
        .post(&alice, "/api/workspaces/reorder", ids(&[&w[2], "wspnope"]))
        .await;
    unknown.assert_status(404);
    assert!(
        error_text(&unknown).contains("wspnope"),
        "{:?}",
        unknown.body
    );
    // someone else's workspace is as good as unknown
    let foreign = app
        .post(&alice, "/api/workspaces/reorder", ids(&[&w[2], &theirs]))
        .await;
    foreign.assert_status(404);
    assert!(error_text(&foreign).contains(&theirs));
    // a trashed workspace too
    app.delete(&alice, &format!("/api/workspaces/{}", w[1]))
        .await
        .assert_status(200);
    app.post(&alice, "/api/workspaces/reorder", ids(&[&w[1], &w[0]]))
        .await
        .assert_status(404);
    app.post(&alice, "/api/workspaces/reorder", json!({}))
        .await
        .assert_status(400);
    app.post(&app.anon(), "/api/workspaces/reorder", ids(&[&w[0]]))
        .await
        .assert_status(401);

    let after = workspace_names(&app, &alice).await;
    assert_eq!(
        after,
        before.into_iter().filter(|n| n != "B").collect::<Vec<_>>()
    );
    assert_eq!(workspace_names(&app, &bob).await, strings(&["Bobs"]));
}

#[tokio::test]
async fn tokens_reorder_only_the_workspaces_they_can_see() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let w = workspaces_named(&app, &alice, &["A", "B", "C"]).await;
    let b1 = base(&app, &alice, &w[0], "One").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b3 = base(&app, &alice, &w[2], "Three").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.post(
        &alice,
        "/api/workspaces/reorder",
        ids(&[&w[0], &w[1], &w[2]]),
    )
    .await
    .assert_status(200);

    // read-only: refused
    let read_only = token_client(&app, &alice, false);
    app.post(&read_only, "/api/workspaces/reorder", ids(&[&w[1], &w[0]]))
        .await
        .assert_status(403);

    // limited to two bases: the workspaces holding them can be named, the others cannot
    let limited = app.raw_token(&alice, json!({ "write": true, "base_ids": [b1, b3] }));
    let hidden = app
        .post(&limited, "/api/workspaces/reorder", ids(&[&w[1], &w[0]]))
        .await;
    hidden.assert_status(404);
    assert!(error_text(&hidden).contains(&w[1]));
    app.post(&limited, "/api/workspaces/reorder", ids(&[&w[2], &w[0]]))
        .await
        .assert_status(200);
    // the hidden workspace keeps its place between them
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["C", "B", "A"])
    );

    // an unrestricted write token may order all of them
    let write = token_client(&app, &alice, true);
    app.post(
        &write,
        "/api/workspaces/reorder",
        ids(&[&w[1], &w[0], &w[2]]),
    )
    .await
    .assert_status(200);
    assert_eq!(
        workspace_names(&app, &alice).await,
        strings(&["B", "A", "C"])
    );
}

// ----------------------------------------------------------------------------- projects

async fn base_names(f: &Fixture) -> Vec<String> {
    let r = f.app.get(&f.owner, "/api/workspaces").await;
    r.assert_status(200);
    let ws = r
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == f.ws.as_str())
        .unwrap()
        .clone();
    names_of(&ws["bases"])
}

fn reorder_bases_url(ws: &str) -> String {
    format!("/api/workspaces/{ws}/bases/reorder")
}

/// The fixture's workspace with bases CRM, P1, P2, P3 (in this order); returns the ids of the
/// last three.
async fn more_bases(f: &Fixture) -> Vec<String> {
    let mut out = Vec::new();
    for n in ["P1", "P2", "P3"] {
        out.push(
            base(&f.app, &f.owner, &f.ws, n).await["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    out
}

#[tokio::test]
async fn projects_full_partial_and_repeated_reorder() {
    let f = Fixture::new().await;
    let p = more_bases(&f).await;
    let crm = f.base_id.clone();
    assert_eq!(base_names(&f).await, strings(&["CRM", "P1", "P2", "P3"]));

    let r = f
        .app
        .post(
            &f.owner,
            &reorder_bases_url(&f.ws),
            ids(&[&p[2], &p[1], &p[0], &crm]),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert_eq!(base_names(&f).await, strings(&["P3", "P2", "P1", "CRM"]));

    // CRM and P2 swap; the others stay
    for _ in 0..2 {
        f.app
            .post(&f.owner, &reorder_bases_url(&f.ws), ids(&[&crm, &p[1]]))
            .await
            .assert_status(200);
        assert_eq!(base_names(&f).await, strings(&["P3", "CRM", "P1", "P2"]));
    }
    // a base made later comes last
    base(&f.app, &f.owner, &f.ws, "P4").await;
    assert_eq!(
        base_names(&f).await,
        strings(&["P3", "CRM", "P1", "P2", "P4"])
    );
}

#[tokio::test]
async fn project_reorder_refuses_bad_lists_and_other_roles() {
    let f = Fixture::new().await;
    let p = more_bases(&f).await;
    let url = reorder_bases_url(&f.ws);
    let before = base_names(&f).await;

    f.app
        .post(&f.owner, &url, json!({ "ids": [] }))
        .await
        .assert_status(400);
    let dup = f.app.post(&f.owner, &url, ids(&[&p[0], &p[0]])).await;
    dup.assert_status(400);
    assert!(error_text(&dup).contains(&p[0]));
    let unknown = f.app.post(&f.owner, &url, ids(&[&p[0], "appnope"])).await;
    unknown.assert_status(404);
    assert!(error_text(&unknown).contains("appnope"));

    // a base of another workspace is not a sibling
    let other_ws = workspace(&f.app, &f.owner, "Other").await;
    let elsewhere = base(&f.app, &f.owner, &other_ws, "Elsewhere").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let foreign = f.app.post(&f.owner, &url, ids(&[&p[0], &elsewhere])).await;
    foreign.assert_status(404);
    assert!(error_text(&foreign).contains(&elsewhere));
    // a trashed base is not either
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", p[2]))
        .await
        .assert_status(200);
    f.app
        .post(&f.owner, &url, ids(&[&p[0], &p[2]]))
        .await
        .assert_status(404);
    // a workspace the caller is not in
    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app
        .post(&stranger, &url, ids(&[&p[0]]))
        .await
        .assert_status(404);
    f.app
        .post(&f.app.anon(), &url, ids(&[&p[0]]))
        .await
        .assert_status(401);
    assert_eq!(
        base_names(&f).await,
        before.into_iter().filter(|n| n != "P3").collect::<Vec<_>>()
    );

    // roles: creators may, editors and below may not
    for (role, status) in [
        (Role::Viewer, 403),
        (Role::Commenter, 403),
        (Role::Editor, 403),
        (Role::Creator, 200),
    ] {
        let user = f.member(&format!("{}@example.com", role.as_str()), role);
        f.app
            .post(&user, &url, ids(&[&p[1], &p[0]]))
            .await
            .assert_status(status);
    }
    assert_eq!(base_names(&f).await, strings(&["CRM", "P2", "P1"]));
}

#[tokio::test]
async fn a_project_limited_creator_orders_the_projects_they_can_open() {
    let f = Fixture::new().await;
    let p = more_bases(&f).await;
    let guest = f.base_guest("guest@example.com", Role::Creator);
    add_base_member(&f.app, &p[1], &guest, Role::Creator);
    let url = reorder_bases_url(&f.ws);

    // the guest sees CRM and P2 only; P1 is as good as unknown to them
    let r = f.app.post(&guest, &url, ids(&[&p[1], &p[0]])).await;
    r.assert_status(404);
    assert!(error_text(&r).contains(&p[0]), "{:?}", r.body);
    f.app
        .post(&guest, &url, ids(&[&p[1], &f.base_id]))
        .await
        .assert_status(200);
    // swapped into each other's places; P1 and P3 did not move
    assert_eq!(base_names(&f).await, strings(&["P2", "P1", "CRM", "P3"]));
}

// ------------------------------------------------------------------------------ tables

fn reorder_tables_url(f: &Fixture) -> String {
    format!("/api/bases/{}/tables/reorder", f.base_id)
}

async fn table_names(f: &Fixture) -> Vec<String> {
    names_of(&f.schema().await["tables"])
}

/// Adds T1..T3 after the starter "Table 1"; returns [Table 1, T1, T2, T3] ids.
async fn more_tables(f: &Fixture) -> Vec<String> {
    let mut out = vec![f.table_id.clone()];
    for n in ["T1", "T2", "T3"] {
        out.push(f.add_table(n).await["id"].as_str().unwrap().to_string());
    }
    out
}

#[tokio::test]
async fn tables_full_partial_and_repeated_reorder() {
    let f = Fixture::new().await;
    let t = more_tables(&f).await;
    assert_eq!(
        table_names(&f).await,
        strings(&["Table 1", "T1", "T2", "T3"])
    );

    let r = f
        .app
        .post(
            &f.owner,
            &reorder_tables_url(&f),
            ids(&[&t[3], &t[2], &t[1], &t[0]]),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert_eq!(
        table_names(&f).await,
        strings(&["T3", "T2", "T1", "Table 1"])
    );

    for _ in 0..2 {
        f.app
            .post(&f.owner, &reorder_tables_url(&f), ids(&[&t[0], &t[2]]))
            .await
            .assert_status(200);
        assert_eq!(
            table_names(&f).await,
            strings(&["T3", "Table 1", "T1", "T2"])
        );
    }
    f.add_table("T4").await;
    assert_eq!(
        table_names(&f).await,
        strings(&["T3", "Table 1", "T1", "T2", "T4"])
    );
}

#[tokio::test]
async fn table_reorder_refuses_bad_lists_and_other_roles() {
    let f = Fixture::new().await;
    let t = more_tables(&f).await;
    let url = reorder_tables_url(&f);
    let before = table_names(&f).await;

    f.app
        .post(&f.owner, &url, json!({ "ids": [] }))
        .await
        .assert_status(400);
    let dup = f
        .app
        .post(&f.owner, &url, ids(&[&t[1], &t[2], &t[1]]))
        .await;
    dup.assert_status(400);
    assert!(error_text(&dup).contains(&t[1]));
    let unknown = f.app.post(&f.owner, &url, ids(&[&t[1], "tblnope"])).await;
    unknown.assert_status(404);
    assert!(error_text(&unknown).contains("tblnope"));

    // a table of another base
    let other = base(&f.app, &f.owner, &f.ws, "Other").await;
    let foreign_table = other["tables"][0]["id"].as_str().unwrap().to_string();
    let foreign = f
        .app
        .post(&f.owner, &url, ids(&[&t[1], &foreign_table]))
        .await;
    foreign.assert_status(404);
    assert!(error_text(&foreign).contains(&foreign_table));
    // a trashed table
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", t[3]))
        .await
        .assert_status(200);
    f.app
        .post(&f.owner, &url, ids(&[&t[1], &t[3]]))
        .await
        .assert_status(404);
    // a base the caller cannot open
    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app
        .post(&stranger, &url, ids(&[&t[1]]))
        .await
        .assert_status(404);
    assert_eq!(
        table_names(&f).await,
        before.into_iter().filter(|n| n != "T3").collect::<Vec<_>>()
    );

    for (role, status) in [
        (Role::Viewer, 403),
        (Role::Commenter, 403),
        (Role::Editor, 403),
        (Role::Creator, 200),
    ] {
        let user = f.member(&format!("{}@example.com", role.as_str()), role);
        f.app
            .post(&user, &url, ids(&[&t[2], &t[1]]))
            .await
            .assert_status(status);
    }
    assert_eq!(table_names(&f).await, strings(&["Table 1", "T2", "T1"]));
}

// ------------------------------------------------------------------------------- views

fn reorder_views_url(f: &Fixture) -> String {
    format!("/api/tables/{}/views/reorder", f.table_id)
}

async fn make_view(f: &Fixture, who: &Client, name: &str, personal: bool) -> String {
    let r = f
        .app
        .post(
            who,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": name, "type": "grid", "personal": personal }),
        )
        .await;
    r.assert_status(201);
    r.body["id"].as_str().unwrap().to_string()
}

/// Names of the views of the fixture's table as `who` sees them (default grid first).
async fn view_names(f: &Fixture, who: &Client) -> Vec<String> {
    let r = f.app.get(who, &format!("/api/bases/{}", f.base_id)).await;
    r.assert_status(200);
    let table = r.body["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == f.table_id.as_str())
        .unwrap()
        .clone();
    names_of(&table["views"])
}

async fn default_grid_id(f: &Fixture) -> String {
    f.table(&f.table_id).await["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["is_default"] == true)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn views_full_partial_and_repeated_reorder() {
    let f = Fixture::new().await;
    let grid = f.view_id.clone();
    let a = make_view(&f, &f.owner, "A", false).await;
    let b = make_view(&f, &f.owner, "B", false).await;
    let c = make_view(&f, &f.owner, "C", false).await;
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "Grid view", "A", "B", "C"])
    );

    let r = f
        .app
        .post(&f.owner, &reorder_views_url(&f), ids(&[&c, &b, &a, &grid]))
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "C", "B", "A", "Grid view"])
    );

    for _ in 0..2 {
        f.app
            .post(&f.owner, &reorder_views_url(&f), ids(&[&grid, &b]))
            .await
            .assert_status(200);
        assert_eq!(
            view_names(&f, &f.owner).await,
            strings(&["Default grid", "C", "Grid view", "A", "B"])
        );
    }
    make_view(&f, &f.owner, "D", false).await;
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "C", "Grid view", "A", "B", "D"])
    );
}

#[tokio::test]
async fn the_default_grid_cannot_be_reordered() {
    let f = Fixture::new().await;
    let default = default_grid_id(&f).await;
    let a = make_view(&f, &f.owner, "A", false).await;
    let r = f
        .app
        .post(&f.owner, &reorder_views_url(&f), ids(&[&a, &default]))
        .await;
    r.assert_status(400);
    let text = error_text(&r);
    assert!(
        text.contains(&default) && text.contains("default grid"),
        "{text}"
    );
    f.app
        .post(&f.owner, &reorder_views_url(&f), ids(&[&default]))
        .await
        .assert_status(400);
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "Grid view", "A"])
    );
}

#[tokio::test]
async fn view_reorder_refuses_bad_lists() {
    let f = Fixture::new().await;
    let a = make_view(&f, &f.owner, "A", false).await;
    let url = reorder_views_url(&f);
    let before = view_names(&f, &f.owner).await;

    f.app
        .post(&f.owner, &url, json!({ "ids": [] }))
        .await
        .assert_status(400);
    let dup = f.app.post(&f.owner, &url, ids(&[&a, &f.view_id, &a])).await;
    dup.assert_status(400);
    assert!(error_text(&dup).contains(&a));
    let unknown = f.app.post(&f.owner, &url, ids(&[&a, "viwnope"])).await;
    unknown.assert_status(404);
    assert!(error_text(&unknown).contains("viwnope"));

    // a view of another table
    let other = f.add_table("Other").await;
    let other_view = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", other["id"].as_str().unwrap()),
            json!({ "name": "Elsewhere", "type": "grid" }),
        )
        .await;
    other_view.assert_status(201);
    let other_view = other_view.body["id"].as_str().unwrap().to_string();
    let foreign = f.app.post(&f.owner, &url, ids(&[&a, &other_view])).await;
    foreign.assert_status(404);
    assert!(error_text(&foreign).contains(&other_view));
    // a deleted view
    f.app
        .delete(&f.owner, &format!("/api/views/{a}"))
        .await
        .assert_status(200);
    f.app
        .post(&f.owner, &url, ids(&[&a, &f.view_id]))
        .await
        .assert_status(404);
    // an unknown table, and a stranger
    f.app
        .post(
            &f.owner,
            "/api/tables/tblnope/views/reorder",
            ids(&[&f.view_id]),
        )
        .await
        .assert_status(404);
    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app
        .post(&stranger, &url, ids(&[&f.view_id]))
        .await
        .assert_status(404);
    assert_eq!(
        view_names(&f, &f.owner).await,
        before.into_iter().filter(|n| n != "A").collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn shared_views_need_creator_and_personal_views_need_editor() {
    let f = Fixture::new().await;
    let grid = f.view_id.clone();
    let a = make_view(&f, &f.owner, "A", false).await;
    let url = reorder_views_url(&f);
    let editor = f.member("editor@example.com", Role::Editor);
    let viewer = f.member("viewer@example.com", Role::Viewer);
    let creator = f.member("creator@example.com", Role::Creator);

    // shared views: creators only
    for who in [&viewer, &editor] {
        f.app
            .post(who, &url, ids(&[&a, &grid]))
            .await
            .assert_status(403);
    }
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "Grid view", "A"])
    );

    // an editor's personal views: they may order those, nobody else sees them
    let m1 = make_view(&f, &editor, "Mine 1", true).await;
    let m2 = make_view(&f, &editor, "Mine 2", true).await;
    assert_eq!(
        view_names(&f, &editor).await,
        strings(&["Default grid", "Grid view", "A", "Mine 1", "Mine 2"])
    );
    f.app
        .post(&editor, &url, ids(&[&m2, &m1]))
        .await
        .assert_status(200);
    assert_eq!(
        view_names(&f, &editor).await,
        strings(&["Default grid", "Grid view", "A", "Mine 2", "Mine 1"])
    );
    // a mix of shared and personal views is a change to the shared order: creators only
    f.app
        .post(&editor, &url, ids(&[&m1, &a]))
        .await
        .assert_status(403);
    // someone else's personal view does not exist for the caller
    for who in [&f.owner, &creator] {
        let r = f.app.post(who, &url, ids(&[&m1, &a])).await;
        r.assert_status(404);
        assert!(error_text(&r).contains(&m1));
    }
    // someone demoted to viewer keeps a personal view but may no longer reorder it
    let demoted = f.member("demoted@example.com", Role::Editor);
    let d1 = make_view(&f, &demoted, "Demoted's", true).await;
    add_ws_member(&f.app, &f.ws, &demoted, Role::Viewer);
    f.app
        .post(&demoted, &url, ids(&[&d1]))
        .await
        .assert_status(403);
    f.app
        .post(&viewer, &url, ids(&[&d1]))
        .await
        .assert_status(404);

    // creators order the shared views; the editor's personal views keep their places
    f.app
        .post(&creator, &url, ids(&[&a, &grid]))
        .await
        .assert_status(200);
    assert_eq!(
        view_names(&f, &f.owner).await,
        strings(&["Default grid", "A", "Grid view"])
    );
    assert_eq!(
        view_names(&f, &editor).await,
        strings(&["Default grid", "A", "Grid view", "Mine 2", "Mine 1"])
    );

    // a creator may mix their own personal views with shared ones
    let c1 = make_view(&f, &creator, "Creator's", true).await;
    f.app
        .post(&creator, &url, ids(&[&c1, &a]))
        .await
        .assert_status(200);
    assert_eq!(
        view_names(&f, &creator).await,
        strings(&["Default grid", "Creator's", "Grid view", "A"])
    );
}
