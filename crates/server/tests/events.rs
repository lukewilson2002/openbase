//! `GET /api/bases/{id}/events`: the Server-Sent Events stream, exercised with
//! real streaming requests through the router (frames are read from the
//! response body as they arrive).

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod sse_support;

use std::time::Duration;

use axum::http::{StatusCode, header};
use common::Client;
use ob_core::api::events::BaseEvent;
use openbase::perm::Role;
use query_support::*;
use serde_json::{Value, json};
use sse_support::*;

// ------------------------------------------------------------------ basics

#[tokio::test]
async fn opens_an_event_stream_with_the_right_headers() {
    let f = Fixture::new().await;
    let o = open(&f.app, &f.owner, &f.base_id).await;
    assert_eq!(o.status, StatusCode::OK);
    let ct = o
        .headers
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ct.starts_with("text/event-stream"), "{ct}");
    assert_eq!(o.headers.get(header::CACHE_CONTROL).unwrap(), "no-cache");
    let mut s = o.stream();
    // A greeting comment arrives straight away so proxies flush the headers.
    let first = s.next_msg(SOON).await.unwrap().unwrap();
    assert_eq!(first.comment.as_deref(), Some("connected"));
    assert!(first.event.is_none());
}

#[tokio::test]
async fn keep_alive_comments_arrive_while_idle() {
    let f = Fixture::new().await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    s.next_msg(SOON).await.unwrap().unwrap(); // greeting
    let ka = s.next_msg(SOON).await.unwrap().unwrap();
    assert!(ka.event.is_none() && ka.comment.is_some(), "{ka:?}");
}

#[tokio::test]
async fn a_write_by_another_client_is_delivered_with_its_envelope() {
    let f = Fixture::new().await;
    let editor = f.member("editor-user@example.com", Role::Editor);
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    let r = f
        .app
        .request_with(
            &editor,
            "POST",
            &records_url(&f.table_id),
            Some(json!({ "records": [ { "values": { &f.primary_id: "from the editor" } } ] })),
            &[("x-client-id", "tab-42")],
            true,
            None,
        )
        .await;
    r.assert_status(201);
    let created = id_str(&r.body["records"][0]["id"]);
    let (name, data) = s.next_event().await;
    assert_eq!(name, "records_changed");
    assert_eq!(data["base_id"], f.base_id);
    assert_eq!(data["client_id"], "tab-42");
    assert_eq!(data["user_id"], editor.user_id.clone().unwrap());
    assert_eq!(data["event"]["kind"], "records_changed");
    assert_eq!(data["event"]["table_id"], f.table_id);
    assert_eq!(data["event"]["created"], json!([created]));
    // The data parses back into the shared DTO.
    let env: ob_core::api::events::EventEnvelope = serde_json::from_value(data).unwrap();
    assert!(matches!(env.event, BaseEvent::RecordsChanged { .. }));
}

#[tokio::test]
async fn updates_and_deletes_are_reported_per_table() {
    let f = Fixture::new().await;
    let id = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "a" })).await["id"]);
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    f.set(&f.table_id, &id, json!({ &f.primary_id: "b" })).await;
    let (name, data) = s.next_event().await;
    assert_eq!(name, "records_changed");
    assert_eq!(data["event"]["updated"], json!([id]));
    f.delete_records(&f.table_id, &[&id])
        .await
        .assert_status(204);
    let (_, data) = s.next_event().await;
    assert_eq!(data["event"]["deleted"], json!([id]));
}

#[tokio::test]
async fn schema_comment_and_base_events_have_their_own_names() {
    let f = Fixture::new().await;
    let id = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "a" })).await["id"]);
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    // schema_changed
    f.number(&f.table_id, "Qty").await;
    let (name, data) = s.next_event().await;
    assert_eq!(name, "schema_changed");
    assert_eq!(data["event"]["table_id"], f.table_id);
    // comments_changed
    f.app
        .post(
            &f.owner,
            &format!("/api/records/{id}/comments"),
            json!({ "body": "hi" }),
        )
        .await
        .assert_status(201);
    let (name, data) = s.next_event().await;
    assert_eq!(name, "comments_changed");
    assert_eq!(data["event"]["record_id"], id);
    // base_changed (rename)
    f.app
        .patch(
            &f.owner,
            &format!("/api/bases/{}", f.base_id),
            json!({ "name": "Renamed" }),
        )
        .await
        .assert_status(200);
    let (name, data) = s.next_event().await;
    assert_eq!(name, "base_changed");
    assert_eq!(data["event"]["kind"], "base_changed");
}

#[tokio::test]
async fn events_arrive_in_order() {
    let f = Fixture::new().await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(id_str(
            &f.create(&f.table_id, json!({ &f.primary_id: format!("r{i}") }))
                .await["id"],
        ));
    }
    for id in &ids {
        let (_, data) = s.next_event().await;
        assert_eq!(data["event"]["created"], json!([id]));
    }
}

#[tokio::test]
async fn only_the_requested_bases_events_are_delivered() {
    let f = Fixture::new().await;
    let other_ws = workspace(&f.app, &f.owner, "Other").await;
    let other = base(&f.app, &f.owner, &other_ws, "Other base").await;
    let other_table = id_str(&other["tables"][0]["id"]);
    let other_primary = id_str(&other["tables"][0]["primary_field_id"]);
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    f.app
        .post(
            &f.owner,
            &records_url(&other_table),
            json!({ "records": [ { "values": { &other_primary: "elsewhere" } } ] }),
        )
        .await
        .assert_status(201);
    s.expect_quiet(Duration::from_millis(300)).await;
    // The subscribed base still delivers.
    f.create(&f.table_id, json!({ &f.primary_id: "here" }))
        .await;
    let (name, _) = s.next_event().await;
    assert_eq!(name, "records_changed");
}

#[tokio::test]
async fn volatile_refreshes_reach_subscribers() {
    let f = Fixture::new().await;
    f.formula(&f.table_id, "Now", "NOW()").await;
    f.create(&f.table_id, json!({ &f.primary_id: "a" })).await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    let later = chrono::Utc::now() + chrono::Duration::minutes(10);
    let changed = openbase::tasks::refresh_volatile_formulas(&f.app.state, later).unwrap();
    assert!(changed > 0);
    let (name, data) = s.next_event().await;
    assert_eq!(name, "records_changed");
    assert_eq!(data["client_id"], Value::Null);
}

#[tokio::test]
async fn many_subscribers_each_get_every_event() {
    let f = Fixture::new().await;
    let mut streams = Vec::new();
    for _ in 0..5 {
        streams.push(open(&f.app, &f.owner, &f.base_id).await.stream());
    }
    f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    for s in &mut streams {
        assert_eq!(s.next_event().await.0, "records_changed");
    }
}

// ------------------------------------------------------------------ access

#[tokio::test]
async fn who_may_subscribe() {
    let f = Fixture::new().await;
    for role in ALL_ROLES {
        let u = f.member(&format!("{}-user@example.com", role.as_str()), role);
        let o = open(&f.app, &u, &f.base_id).await;
        assert_eq!(o.status, StatusCode::OK, "{role:?}");
    }
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    assert_eq!(
        open(&f.app, &guest, &f.base_id).await.status,
        StatusCode::OK
    );
    let stranger = f.app.user("stranger@example.com", "Stranger");
    let o = open(&f.app, &stranger, &f.base_id).await;
    assert_eq!(o.status, StatusCode::NOT_FOUND);
    assert_eq!(o.error["error"]["code"], "not_found");
    let o = open(&f.app, &f.app.anon(), &f.base_id).await;
    assert_eq!(o.status, StatusCode::UNAUTHORIZED);
    assert_eq!(o.error["error"]["code"], "unauthorized");
    let o = open(&f.app, &f.owner, "bseNope").await;
    assert_eq!(o.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn refused_subscriptions_do_not_create_channels() {
    let f = Fixture::new().await;
    let stranger = f.app.user("stranger@example.com", "Stranger");
    open(&f.app, &stranger, &f.base_id).await;
    open(&f.app, &f.owner, "bseNope").await;
    assert_eq!(f.app.state.events.active_channels(), 0);
}

#[tokio::test]
async fn api_tokens_can_subscribe_within_their_scope() {
    let f = Fixture::new().await;
    let ro = token_client(&f.app, &f.owner, false);
    let mut s = open(&f.app, &ro, &f.base_id).await.stream();
    f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    assert_eq!(s.next_event().await.0, "records_changed");
    // A token restricted to other bases is refused with a 404.
    let uid = f.owner.user_id.clone().unwrap();
    let token = "pat_events_scoped";
    let hash = openbase::ids::hash_token(token);
    let scopes = json!({ "write": true, "base_ids": ["bseOther"] }).to_string();
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES ('patX', ?1, 't', ?2, ?3, 1)",
            rusqlite::params![uid, hash, scopes],
        )
    });
    let scoped = Client {
        cookie: None,
        bearer: Some(token.into()),
        user_id: Some(uid),
    };
    assert_eq!(
        open(&f.app, &scoped, &f.base_id).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn removing_a_workspace_member_closes_their_stream() {
    let f = Fixture::new().await;
    let editor = f.member("editor-user@example.com", Role::Editor);
    let editor_id = editor.user_id.clone().unwrap();
    let mut theirs = open(&f.app, &editor, &f.base_id).await.stream();
    let mut mine = open(&f.app, &f.owner, &f.base_id).await.stream();
    f.app
        .delete(
            &f.owner,
            &format!("/api/workspaces/{}/members/{editor_id}", f.ws),
        )
        .await
        .assert_status(200);
    // The revoked user's stream ends once the base_changed event is seen ...
    theirs.expect_closed(SOON).await;
    // ... while the owner's stream gets the event and stays open.
    let (name, _) = mine.next_event().await;
    assert_eq!(name, "base_changed");
    f.create(&f.table_id, json!({ &f.primary_id: "after" }))
        .await;
    assert_eq!(mine.next_event().await.0, "records_changed");
}

#[tokio::test]
async fn taking_a_base_off_a_members_list_closes_their_stream() {
    let f = Fixture::new().await;
    let other = schema_support::base(&f.app, &f.owner, &f.ws, "Other").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    schema_support::add_base_member(&f.app, &other_id, &guest, Role::Viewer);
    let guest_id = guest.user_id.clone().unwrap();
    let mut s = open(&f.app, &guest, &f.base_id).await.stream();
    f.app
        .delete(
            &f.owner,
            &format!("/api/bases/{}/members/{guest_id}", f.base_id),
        )
        .await
        .assert_status(200);
    s.expect_closed(SOON).await;
}

#[tokio::test]
async fn a_limited_member_streams_only_their_bases_and_loses_one_taken_away() {
    let f = Fixture::new().await;
    let other = schema_support::base(&f.app, &f.owner, &f.ws, "Other").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let guest_id = guest.user_id.clone().unwrap();
    // A base not on their list is refused like a base that does not exist.
    let o = open(&f.app, &guest, &other_id).await;
    assert_eq!(o.status, StatusCode::NOT_FOUND);
    // Moving them to the other base on the members page closes the stream.
    let mut s = open(&f.app, &guest, &f.base_id).await.stream();
    f.app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}/members/{guest_id}", f.ws),
            json!({ "base_ids": [other_id] }),
        )
        .await
        .assert_status(200);
    s.expect_closed(SOON).await;
    assert_eq!(open(&f.app, &guest, &other_id).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_member_who_keeps_access_keeps_the_stream_after_base_changed() {
    let f = Fixture::new().await;
    let viewer = f.member("viewer-user@example.com", Role::Viewer);
    let viewer_id = viewer.user_id.clone().unwrap();
    let mut s = open(&f.app, &viewer, &f.base_id).await.stream();
    // A role change keeps access.
    f.app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}/members/{viewer_id}", f.ws),
            json!({ "role": "commenter" }),
        )
        .await
        .assert_status(200);
    assert_eq!(s.next_event().await.0, "base_changed");
    f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    assert_eq!(s.next_event().await.0, "records_changed");
}

#[tokio::test]
async fn deleting_the_base_closes_every_stream() {
    let f = Fixture::new().await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    s.expect_closed(SOON).await;
}

#[tokio::test]
async fn access_is_rechecked_periodically_even_without_events() {
    let f = Fixture::new().await;
    let editor = f.member("editor-user@example.com", Role::Editor);
    let editor_id = editor.user_id.clone().unwrap();
    let ws = f.ws.clone();
    let mut s = open(&f.app, &editor, &f.base_id).await.stream();
    // Revoke behind the server's back: no event is published.
    sql(&f.app, |tx| {
        tx.execute(
            "DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            [&ws, &editor_id],
        )
    });
    s.expect_closed(SOON).await;
}

#[tokio::test]
async fn deactivated_users_and_ended_sessions_lose_the_stream() {
    let f = Fixture::new().await;
    let deactivated = f.member("deactivated@example.com", Role::Viewer);
    let mut a = open(&f.app, &deactivated, &f.base_id).await.stream();
    let uid = deactivated.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&uid])
    });
    a.expect_closed(SOON).await;

    let leaving = f.member("leaving@example.com", Role::Viewer);
    let mut b = open(&f.app, &leaving, &f.base_id).await.stream();
    let uid = leaving.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&uid])
    });
    b.expect_closed(SOON).await;
}

#[tokio::test]
async fn revoked_or_expired_tokens_lose_their_stream() {
    let f = Fixture::new().await;
    let revoked = token_client(&f.app, &f.owner, true);
    let mut a = open(&f.app, &revoked, &f.base_id).await.stream();
    // Expiry first: a second token for the same user, expired behind the back.
    let expiring = token_client(&f.app, &f.owner, false);
    let mut b = open(&f.app, &expiring, &f.base_id).await.stream();
    let hash = openbase::ids::hash_token(expiring.bearer.as_deref().unwrap());
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE api_tokens SET expires_at = 1 WHERE token_hash = ?1",
            [&hash],
        )
    });
    b.expect_closed(SOON).await;

    // Deleting the token closes its stream too, while the user's session
    // and other streams are unaffected.
    let hash = openbase::ids::hash_token(revoked.bearer.as_deref().unwrap());
    sql(&f.app, |tx| {
        tx.execute("DELETE FROM api_tokens WHERE token_hash = ?1", [&hash])
    });
    a.expect_closed(SOON).await;
    let mut session = open(&f.app, &f.owner, &f.base_id).await.stream();
    f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    assert_eq!(session.next_event().await.0, "records_changed");
}

// -------------------------------------------------------------------- lag

#[tokio::test]
async fn a_lagging_subscriber_is_told_to_refetch_everything() {
    let f = Fixture::new().await;
    let mut s = open(&f.app, &f.owner, &f.base_id).await.stream();
    let greeting = s.next_msg(SOON).await.unwrap().unwrap();
    assert_eq!(greeting.comment.as_deref(), Some("connected"));
    // Flood the bounded channel while nobody reads.
    for i in 0..400 {
        f.app.state.events.publish(
            &f.base_id,
            None,
            None,
            BaseEvent::RecordsChanged {
                table_id: f.table_id.clone(),
                created: vec![format!("rec{i}")],
                updated: vec![],
                deleted: vec![],
            },
        );
    }
    let (name, data) = s.next_event().await;
    assert_eq!(name, "base_changed", "lag is reported as base_changed");
    assert_eq!(data["base_id"], f.base_id);
    assert_eq!(data["client_id"], Value::Null);
    // After the notice the stream continues with the newest buffered events.
    let (name, _) = s.next_event().await;
    assert_eq!(name, "records_changed");
}

#[tokio::test]
async fn dropping_the_stream_releases_the_channel() {
    let f = Fixture::new().await;
    let s = open(&f.app, &f.owner, &f.base_id).await.stream();
    assert_eq!(f.app.state.events.active_channels(), 1);
    drop(s);
    // The channel goes away with the next publish that finds no receivers.
    f.app
        .state
        .events
        .publish(&f.base_id, None, None, BaseEvent::BaseChanged);
    assert_eq!(f.app.state.events.active_channels(), 0);
}

#[tokio::test]
async fn shutdown_ends_open_streams_so_graceful_shutdown_can_finish() {
    let f = Fixture::new().await;
    let mut a = open(&f.app, &f.owner, &f.base_id).await.stream();
    let mut b = open(&f.app, &f.owner, &f.base_id).await.stream();
    a.next_msg(SOON).await.unwrap().unwrap(); // greeting
    f.create(&f.table_id, json!({ &f.primary_id: "before" }))
        .await;
    assert_eq!(a.next_event().await.0, "records_changed");
    f.app.state.events.begin_shutdown();
    // Both end promptly, including the one that never read its greeting.
    a.expect_closed(SOON).await;
    b.expect_closed(SOON).await;
    // Streams opened after the signal end at once too.
    let mut late = open(&f.app, &f.owner, &f.base_id).await.stream();
    late.expect_closed(SOON).await;
}
