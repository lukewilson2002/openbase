//! Presence: who has a base open right now. Every open `GET /api/bases/{id}/events`
//! stream counts its user as a viewer; a user's first stream and their last one
//! closing are announced as `presence_changed`, `GET /api/bases/{id}/presence`
//! answers the same list, and several tabs of one user count once.

mod common;
mod schema_support;
mod sse_support;

use std::time::Duration;

use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};
use sse_support::*;

async fn presence(f: &Fixture, who: &common::Client) -> Vec<String> {
    let r = f
        .app
        .get(who, &format!("/api/bases/{}/presence", f.base_id))
        .await;
    r.assert_status(200);
    r.body["viewers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn viewers(data: &Value) -> Vec<String> {
    assert_eq!(data["event"]["kind"], "presence_changed", "{data}");
    data["event"]["viewers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn uid(c: &common::Client) -> String {
    c.user_id.clone().unwrap()
}

#[tokio::test]
async fn nobody_is_viewing_until_a_stream_opens() {
    let f = Fixture::new().await;
    assert!(presence(&f, &f.owner).await.is_empty());
    let _s = open(&f.app, &f.owner, &f.base_id).await.stream();
    assert_eq!(presence(&f, &f.owner).await, [uid(&f.owner)]);
}

#[tokio::test]
async fn two_users_are_listed_and_the_one_who_leaves_is_announced() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let (owner_id, editor_id) = (uid(&f.owner), uid(&editor));

    let mut owner_stream = open(&f.app, &f.owner, &f.base_id).await.stream();
    // The greeting; a new stream is not told about its own arrival.
    owner_stream.next_msg(SOON).await.unwrap().unwrap();

    let editor_stream = open(&f.app, &editor, &f.base_id).await.stream();
    let (name, data) = owner_stream.next_event().await;
    assert_eq!(name, "presence_changed");
    assert_eq!(data["base_id"], f.base_id);
    assert_eq!(data["user_id"], editor_id);
    assert_eq!(viewers(&data), [owner_id.clone(), editor_id.clone()]);
    assert_eq!(
        presence(&f, &f.owner).await,
        [owner_id.clone(), editor_id.clone()]
    );
    assert_eq!(presence(&f, &editor).await, [owner_id.clone(), editor_id]);

    // The editor's client goes away.
    drop(editor_stream);
    let (name, data) = owner_stream.next_event().await;
    assert_eq!(name, "presence_changed");
    assert_eq!(viewers(&data), std::slice::from_ref(&owner_id));
    assert_eq!(presence(&f, &f.owner).await, [owner_id]);
}

#[tokio::test]
async fn several_tabs_of_one_user_count_once() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let (owner_id, editor_id) = (uid(&f.owner), uid(&editor));
    let mut watcher = open(&f.app, &f.owner, &f.base_id).await.stream();

    let tab1 = open(&f.app, &editor, &f.base_id).await.stream();
    let (_, data) = watcher.next_event().await;
    assert_eq!(viewers(&data), [owner_id.clone(), editor_id.clone()]);

    // A second tab announces nothing and does not duplicate the user.
    let tab2 = open(&f.app, &editor, &f.base_id).await.stream();
    watcher.expect_quiet(Duration::from_millis(300)).await;
    assert_eq!(
        presence(&f, &f.owner).await,
        [owner_id.clone(), editor_id.clone()]
    );

    // Closing one tab leaves them present; closing the last announces it.
    drop(tab1);
    watcher.expect_quiet(Duration::from_millis(300)).await;
    assert_eq!(
        presence(&f, &f.owner).await,
        [owner_id.clone(), editor_id.clone()]
    );
    drop(tab2);
    let (_, data) = watcher.next_event().await;
    assert_eq!(viewers(&data), std::slice::from_ref(&owner_id));
    assert_eq!(presence(&f, &f.owner).await, [owner_id]);
}

#[tokio::test]
async fn viewers_keep_the_order_they_arrived_in() {
    let f = Fixture::new().await;
    let a = f.member("a@example.com", Role::Viewer);
    let b = f.member("b@example.com", Role::Viewer);
    let _sb = open(&f.app, &b, &f.base_id).await.stream();
    let _so = open(&f.app, &f.owner, &f.base_id).await.stream();
    let _sa = open(&f.app, &a, &f.base_id).await.stream();
    assert_eq!(
        presence(&f, &f.owner).await,
        [uid(&b), uid(&f.owner), uid(&a)]
    );
}

#[tokio::test]
async fn presence_is_per_base_and_needs_access_to_the_base() {
    let f = Fixture::new().await;
    let other = base(&f.app, &f.owner, &f.ws, "Other").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let _s = open(&f.app, &f.owner, &f.base_id).await.stream();
    let r = f
        .app
        .get(&f.owner, &format!("/api/bases/{other_id}/presence"))
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "viewers": [] }));

    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app
        .get(&stranger, &format!("/api/bases/{}/presence", f.base_id))
        .await
        .assert_status(404);
    f.app
        .get(&f.app.anon(), &format!("/api/bases/{}/presence", f.base_id))
        .await
        .assert_status(401);
    // A read-only token may read it.
    let ro = token_client(&f.app, &f.owner, false);
    f.app
        .get(&ro, &format!("/api/bases/{}/presence", f.base_id))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_stream_ended_by_the_server_leaves_the_base() {
    let f = Fixture::new().await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    s.next_msg(SOON).await.unwrap().unwrap();
    assert_eq!(f.app.state.events.viewers(&f.base_id), [uid(&f.owner)]);
    f.app.state.events.begin_shutdown();
    s.expect_closed(SOON).await;
    assert!(f.app.state.events.viewers(&f.base_id).is_empty());
}

#[tokio::test]
async fn losing_access_ends_the_stream_and_the_presence() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let mut watcher = open(&f.app, &f.owner, &f.base_id).await.stream();
    let mut es = open(&f.app, &editor, &f.base_id).await.stream();
    let (_, joined) = watcher.next_event().await;
    assert_eq!(viewers(&joined).len(), 2);
    // Take the editor out of the workspace; the access re-check ends their stream.
    sql(&f.app, |tx| {
        tx.execute(
            "DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            rusqlite::params![f.ws, uid(&editor)],
        )
    });
    es.expect_closed(Duration::from_secs(5)).await;
    let mut left = None;
    while let Some((name, data)) = watcher.try_event(Duration::from_secs(2)).await {
        if name == "presence_changed" {
            left = Some(viewers(&data));
            break;
        }
    }
    assert_eq!(left, Some(vec![uid(&f.owner)]));
}
