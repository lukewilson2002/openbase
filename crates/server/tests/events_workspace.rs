//! `GET /api/workspaces/{id}/events`: one stream for every project of a
//! workspace the caller can open. It routes by the envelope's `base_id`, picks
//! up projects created or granted after it opened, drops the ones the caller
//! loses, and never counts as presence.

mod common;
mod records_support;
mod schema_support;
mod sse_support;

use std::time::Duration;

use axum::http::StatusCode;
use openbase::perm::Role;
use records_support::*;
use serde_json::{Value, json};
use sse_support::*;

const QUIET: Duration = Duration::from_millis(500);

/// A second project in the fixture's workspace: (base id, table id, primary field id).
async fn second_project(f: &Fixture, name: &str) -> (String, String, String) {
    let b = base(&f.app, &f.owner, &f.ws, name).await;
    (
        b["id"].as_str().unwrap().to_string(),
        id_str(&b["tables"][0]["id"]).to_string(),
        id_str(&b["tables"][0]["primary_field_id"]).to_string(),
    )
}

async fn write(f: &Fixture, table: &str, primary: &str, text: &str) {
    f.app
        .post(
            &f.owner,
            &records_url(table),
            json!({ "records": [ { "values": { primary: text } } ] }),
        )
        .await
        .assert_status(201);
}

/// The next event, asserting its name and project.
async fn expect(s: &mut Stream, name: &str, base_id: &str) -> Value {
    let (got, data) = s.next_event().await;
    assert_eq!(got, name, "{data}");
    assert_eq!(data["base_id"], base_id, "{data}");
    data
}

#[tokio::test]
async fn relays_every_project_with_its_id_and_nothing_from_other_workspaces() {
    let f = Fixture::new().await;
    let (other, other_table, other_primary) = second_project(&f, "Second").await;
    let elsewhere = workspace(&f.app, &f.owner, "Elsewhere").await;
    let foreign = base(&f.app, &f.owner, &elsewhere, "Foreign").await;
    let mut s = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    let greeting = s.next_msg(SOON).await.unwrap().unwrap();
    assert_eq!(greeting.comment.as_deref(), Some("connected"));

    f.app
        .post(
            &f.owner,
            &records_url(id_str(&foreign["tables"][0]["id"])),
            json!({ "records": [ { "values": { id_str(&foreign["tables"][0]["primary_field_id"]): "nope" } } ] }),
        )
        .await
        .assert_status(201);
    let id = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "a" })).await["id"]).to_string();
    let data = expect(&mut s, "records_changed", &f.base_id).await;
    assert_eq!(data["event"]["created"], json!([id]));
    write(&f, &other_table, &other_primary, "b").await;
    expect(&mut s, "records_changed", &other).await;
    // Schema changes and comments travel too, each with its own project.
    f.number(&f.table_id, "Qty").await;
    expect(&mut s, "schema_changed", &f.base_id).await;
    f.app
        .post(
            &f.owner,
            &format!("/api/records/{id}/comments"),
            json!({ "body": "hi" }),
        )
        .await
        .assert_status(201);
    expect(&mut s, "comments_changed", &f.base_id).await;
    // Nothing of the other workspace came through in between.
    s.expect_quiet(QUIET).await;
}

#[tokio::test]
async fn another_workspaces_project_changes_cost_no_reads_once_its_workspace_is_known() {
    let f = Fixture::new().await;
    let (other, _, _) = second_project(&f, "Second").await;
    let elsewhere = workspace(&f.app, &f.owner, "Elsewhere").await;
    let mut foreign = Vec::new();
    for n in 0..4 {
        let b = base(&f.app, &f.owner, &elsewhere, &format!("Foreign {n}")).await;
        foreign.push(b["id"].as_str().unwrap().to_string());
    }
    let member = f.member("member@example.com", Role::Viewer);
    let mut streams = vec![
        open_workspace(&f.app, &f.owner, &f.ws).await.stream(),
        open_workspace(&f.app, &member, &f.ws).await.stream(),
    ];
    let reorder = |ws: String, ids: Vec<String>| {
        let (app, owner) = (&f.app, &f.owner);
        async move {
            app.post(
                owner,
                &format!("/api/workspaces/{ws}/bases/reorder"),
                json!({ "ids": ids }),
            )
            .await
            .assert_status(200);
        }
    };
    // Each reorder publishes one base_changed per project. The first asks the database once
    // per project, for every stream together; repeating it asks nothing.
    let backwards: Vec<String> = foreign.iter().rev().cloned().collect();
    reorder(elsewhere.clone(), backwards.clone()).await;
    for s in &mut streams {
        s.expect_quiet(QUIET).await;
    }
    assert_eq!(f.app.state.events.workspace_loads(), 4);
    // Back and forth: an unchanged order publishes nothing, so each call really swaps.
    for ids in [&foreign, &backwards, &foreign] {
        reorder(elsewhere.clone(), ids.clone()).await;
    }
    for s in &mut streams {
        s.expect_quiet(QUIET).await;
    }
    assert_eq!(f.app.state.events.workspace_loads(), 4);

    // The workspace's own projects still come through, and are asked about once too.
    reorder(f.ws.clone(), vec![other.clone(), f.base_id.clone()]).await;
    for s in &mut streams {
        expect(s, "base_changed", &other).await;
        expect(s, "base_changed", &f.base_id).await;
    }
    assert_eq!(f.app.state.events.workspace_loads(), 6);
}

#[tokio::test]
async fn a_limited_member_sees_only_the_projects_they_can_open() {
    let f = Fixture::new().await;
    let (_, other_table, other_primary) = second_project(&f, "Second").await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let mut s = open_workspace(&f.app, &guest, &f.ws).await.stream();
    write(&f, &other_table, &other_primary, "hidden").await;
    f.create(&f.table_id, json!({ &f.primary_id: "visible" }))
        .await;
    // Only the permitted project arrives; the hidden project's event came first and is absent.
    expect(&mut s, "records_changed", &f.base_id).await;
    s.expect_quiet(QUIET).await;
}

#[tokio::test]
async fn who_may_open_it() {
    let f = Fixture::new().await;
    for role in [Role::Viewer, Role::Editor, Role::Owner] {
        let u = f.member(&format!("{}-user@example.com", role.as_str()), role);
        let o = open_workspace(&f.app, &u, &f.ws).await;
        assert_eq!(o.status, StatusCode::OK, "{role:?}");
    }
    let stranger = f.app.user("stranger@example.com", "Stranger");
    let o = open_workspace(&f.app, &stranger, &f.ws).await;
    assert_eq!(o.status, StatusCode::NOT_FOUND);
    assert_eq!(o.error["error"]["code"], "not_found");
    let o = open_workspace(&f.app, &f.app.anon(), &f.ws).await;
    assert_eq!(o.status, StatusCode::UNAUTHORIZED);
    let o = open_workspace(&f.app, &f.owner, "wspNope").await;
    assert_eq!(o.status, StatusCode::NOT_FOUND);
    // A token works for the workspace; one limited to other projects does not see it.
    let ro = token_client(&f.app, &f.owner, false);
    assert_eq!(
        open_workspace(&f.app, &ro, &f.ws).await.status,
        StatusCode::OK
    );
    let uid = f.owner.user_id.clone().unwrap();
    let token = "pat_ws_events_scoped";
    let hash = openbase::ids::hash_token(token);
    let scopes = json!({ "write": true, "base_ids": ["bseOther"] }).to_string();
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES ('patWs', ?1, 't', ?2, ?3, 1)",
            rusqlite::params![uid, hash, scopes],
        )
    });
    let scoped = common::Client {
        cookie: None,
        bearer: Some(token.into()),
        user_id: Some(uid),
    };
    assert_eq!(
        open_workspace(&f.app, &scoped, &f.ws).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn a_token_limited_to_one_project_gets_only_that_one() {
    let f = Fixture::new().await;
    let (_, other_table, other_primary) = second_project(&f, "Second").await;
    let uid = f.owner.user_id.clone().unwrap();
    let token = "pat_ws_events_one";
    let hash = openbase::ids::hash_token(token);
    let scopes = json!({ "write": true, "base_ids": [f.base_id] }).to_string();
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES ('patOne', ?1, 't', ?2, ?3, 1)",
            rusqlite::params![uid, hash, scopes],
        )
    });
    let scoped = common::Client {
        cookie: None,
        bearer: Some(token.into()),
        user_id: Some(uid),
    };
    let mut s = open_workspace(&f.app, &scoped, &f.ws).await.stream();
    write(&f, &other_table, &other_primary, "out of scope").await;
    f.create(&f.table_id, json!({ &f.primary_id: "in scope" }))
        .await;
    expect(&mut s, "records_changed", &f.base_id).await;
    s.expect_quiet(QUIET).await;
}

#[tokio::test]
async fn a_project_created_after_it_opened_is_relayed() {
    let f = Fixture::new().await;
    let mut s = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    let (fresh, table, primary) = second_project(&f, "Fresh").await;
    // Creating announces itself so Home refetches its list.
    expect(&mut s, "base_changed", &fresh).await;
    write(&f, &table, &primary, "first").await;
    expect(&mut s, "records_changed", &fresh).await;
    // So does a duplicate.
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{fresh}/duplicate"),
            json!({}),
        )
        .await;
    r.assert_status(201);
    let copy = r.body["id"].as_str().unwrap().to_string();
    expect(&mut s, "base_changed", &copy).await;
    let copy_table = id_str(&r.body["tables"][0]["id"]).to_string();
    let copy_primary = id_str(&r.body["tables"][0]["primary_field_id"]).to_string();
    write(&f, &copy_table, &copy_primary, "in the copy").await;
    expect(&mut s, "records_changed", &copy).await;
}

#[tokio::test]
async fn a_project_granted_after_it_opened_is_relayed() {
    let f = Fixture::new().await;
    let (other, other_table, other_primary) = second_project(&f, "Second").await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let guest_id = guest.user_id.clone().unwrap();
    let mut s = open_workspace(&f.app, &guest, &f.ws).await.stream();
    write(&f, &other_table, &other_primary, "before").await;
    s.expect_quiet(QUIET).await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}/members/{guest_id}", f.ws),
            json!({ "base_ids": [f.base_id, other] }),
        )
        .await
        .assert_status(200);
    // base_changed for every project of the workspace passes; the new one is among them.
    let mut seen = Vec::new();
    for _ in 0..2 {
        let (name, data) = s.next_event().await;
        assert_eq!(name, "base_changed");
        seen.push(data["base_id"].as_str().unwrap().to_string());
    }
    seen.sort();
    let mut want = vec![f.base_id.clone(), other.clone()];
    want.sort();
    assert_eq!(seen, want);
    write(&f, &other_table, &other_primary, "after").await;
    expect(&mut s, "records_changed", &other).await;
}

#[tokio::test]
async fn a_project_taken_off_the_list_stops_being_relayed() {
    let f = Fixture::new().await;
    let (other, other_table, other_primary) = second_project(&f, "Second").await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    add_base_member(&f.app, &other, &guest, Role::Viewer);
    let guest_id = guest.user_id.clone().unwrap();
    let mut s = open_workspace(&f.app, &guest, &f.ws).await.stream();
    write(&f, &other_table, &other_primary, "while allowed").await;
    expect(&mut s, "records_changed", &other).await;
    // Move them to the first project only.
    f.app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}/members/{guest_id}", f.ws),
            json!({ "base_ids": [f.base_id] }),
        )
        .await
        .assert_status(200);
    // The lost project is announced once (the client drops it) ...
    let mut seen = Vec::new();
    for _ in 0..2 {
        let (name, data) = s.next_event().await;
        assert_eq!(name, "base_changed");
        seen.push(data["base_id"].as_str().unwrap().to_string());
    }
    assert!(seen.contains(&other));
    // ... and nothing more comes from it, while the other keeps flowing.
    write(&f, &other_table, &other_primary, "after revoke").await;
    f.create(&f.table_id, json!({ &f.primary_id: "still mine" }))
        .await;
    expect(&mut s, "records_changed", &f.base_id).await;
    s.expect_quiet(QUIET).await;
}

#[tokio::test]
async fn a_deleted_project_stops_being_relayed() {
    let f = Fixture::new().await;
    let (doomed, table, _) = second_project(&f, "Doomed").await;
    let mut s = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    f.app
        .delete(&f.owner, &format!("/api/bases/{doomed}"))
        .await
        .assert_status(200);
    expect(&mut s, "base_changed", &doomed).await;
    // Whatever still publishes for it (a late background job) is not relayed.
    f.app.state.events.publish(
        &doomed,
        None,
        None,
        ob_core::api::events::BaseEvent::RecordsChanged {
            table_id: table,
            created: vec![],
            updated: vec![],
            deleted: vec![],
        },
    );
    f.create(&f.table_id, json!({ &f.primary_id: "alive" }))
        .await;
    expect(&mut s, "records_changed", &f.base_id).await;
}

#[tokio::test]
async fn leaving_the_workspace_closes_the_stream() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let editor_id = editor.user_id.clone().unwrap();
    let mut theirs = open_workspace(&f.app, &editor, &f.ws).await.stream();
    let mut mine = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    f.app
        .delete(
            &f.owner,
            &format!("/api/workspaces/{}/members/{editor_id}", f.ws),
        )
        .await
        .assert_status(200);
    theirs.expect_closed(SOON).await;
    expect(&mut mine, "base_changed", &f.base_id).await;
    f.create(&f.table_id, json!({ &f.primary_id: "after" }))
        .await;
    expect(&mut mine, "records_changed", &f.base_id).await;
}

#[tokio::test]
async fn access_removed_behind_the_servers_back_is_noticed_by_the_recheck() {
    let f = Fixture::new().await;
    let (other, other_table, other_primary) = second_project(&f, "Second").await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    add_base_member(&f.app, &other, &guest, Role::Viewer);
    let guest_id = guest.user_id.clone().unwrap();
    let (ws, other_id) = (f.ws.clone(), other.clone());
    let mut s = open_workspace(&f.app, &guest, &f.ws).await.stream();
    // No event is published: only the periodic re-read can see this.
    sql(&f.app, |tx| {
        tx.execute(
            "DELETE FROM workspace_member_bases
             WHERE workspace_id = ?1 AND user_id = ?2 AND base_id = ?3",
            [&ws, &guest_id, &other_id],
        )
    });
    expect(&mut s, "base_changed", &other).await;
    write(&f, &other_table, &other_primary, "after").await;
    s.expect_quiet(QUIET).await;
    // Losing the workspace itself behind the back ends the stream.
    let (ws, guest_id) = (f.ws.clone(), guest.user_id.clone().unwrap());
    sql(&f.app, |tx| {
        tx.execute(
            "DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            [&ws, &guest_id],
        )
    });
    s.expect_closed(SOON).await;
}

#[tokio::test]
async fn it_never_counts_as_presence() {
    let f = Fixture::new().await;
    let mut ws_stream = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    let presence = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/presence", f.base_id))
        .await;
    presence.assert_status(200);
    assert_eq!(presence.body["viewers"], json!([]));
    // A project stream of someone else announces itself; the workspace stream
    // hears nothing of it, and its own user is still not a viewer.
    let editor = f.member("editor@example.com", Role::Editor);
    let mut project = open(&f.app, &editor, &f.base_id).await.stream();
    project.next_msg(SOON).await.unwrap().unwrap();
    let presence = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/presence", f.base_id))
        .await;
    assert_eq!(
        presence.body["viewers"],
        json!([editor.user_id.clone().unwrap()])
    );
    ws_stream.expect_quiet(QUIET).await;
    // Closing the workspace stream announces nothing to the project stream either.
    drop(ws_stream);
    project.expect_quiet(QUIET).await;
    // Data events still reach both kinds.
    f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    assert_eq!(project.next_event().await.0, "records_changed");
}

#[tokio::test]
async fn a_user_holds_a_limited_number_of_streams() {
    let f = Fixture::new().await;
    let mut held = Vec::new();
    for _ in 0..openbase::events::MAX_WORKSPACE_STREAMS_PER_USER {
        held.push(open_workspace(&f.app, &f.owner, &f.ws).await.stream());
    }
    let o = open_workspace(&f.app, &f.owner, &f.ws).await;
    assert_eq!(o.status, StatusCode::TOO_MANY_REQUESTS);
    // Someone else is not affected, and a slot frees up when a stream ends.
    let editor = f.member("editor@example.com", Role::Editor);
    assert_eq!(
        open_workspace(&f.app, &editor, &f.ws).await.status,
        StatusCode::OK
    );
    drop(held.pop());
    let o = open_workspace(&f.app, &f.owner, &f.ws).await;
    assert_eq!(o.status, StatusCode::OK);
}

#[tokio::test]
async fn shutdown_ends_the_stream() {
    let f = Fixture::new().await;
    let mut s = open_workspace(&f.app, &f.owner, &f.ws).await.stream();
    s.next_msg(SOON).await.unwrap().unwrap();
    f.app.state.events.begin_shutdown();
    s.expect_closed(SOON).await;
}
