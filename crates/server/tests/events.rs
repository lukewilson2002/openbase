//! `GET /api/bases/{id}/events`: the Server-Sent Events stream, exercised with
//! real streaming requests through the router (frames are read from the
//! response body as they arrive).

mod common;
mod query_support;
mod records_support;
mod schema_support;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{Client, TestApp};
use http_body_util::BodyExt;
use og_core::api::events::BaseEvent;
use opengrid::perm::Role;
use query_support::*;
use serde_json::{Value, json};
use tower::ServiceExt;

/// Short keep-alive and access re-check intervals for every test here.
fn fast() {
    opengrid::api::events::set_timing_for_tests(
        Duration::from_millis(200),
        Duration::from_millis(150),
    );
}

struct Opened {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    error: Value,
    stream: Option<Stream>,
}

/// One parsed SSE message.
#[derive(Debug, Clone, PartialEq)]
struct Msg {
    comment: Option<String>,
    event: Option<String>,
    data: Option<String>,
}

struct Stream {
    body: Body,
    buf: String,
}

async fn open(app: &TestApp, client: &Client, base_id: &str) -> Opened {
    fast();
    let mut req = Request::builder()
        .method("GET")
        .uri(format!("/api/bases/{base_id}/events"))
        .header(header::ACCEPT, "text/event-stream");
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &client.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let res = app
        .router
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    if status != StatusCode::OK {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        return Opened {
            status,
            headers,
            error: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            stream: None,
        };
    }
    Opened {
        status,
        headers,
        error: Value::Null,
        stream: Some(Stream {
            body: res.into_body(),
            buf: String::new(),
        }),
    }
}

impl Opened {
    fn stream(self) -> Stream {
        assert_eq!(self.status, StatusCode::OK, "{}", self.error);
        self.stream.expect("stream")
    }
}

fn parse(block: &str) -> Msg {
    let mut msg = Msg {
        comment: None,
        event: None,
        data: None,
    };
    for line in block.lines() {
        if let Some(c) = line.strip_prefix(':') {
            msg.comment = Some(c.trim().to_string());
        } else if let Some(e) = line.strip_prefix("event:") {
            msg.event = Some(e.trim().to_string());
        } else if let Some(d) = line.strip_prefix("data:") {
            msg.data = Some(d.trim().to_string());
        }
    }
    msg
}

impl Stream {
    /// The next message, or None when the stream ended; Err on timeout.
    async fn next_msg(&mut self, within: Duration) -> Result<Option<Msg>, ()> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..i + 2).collect();
                return Ok(Some(parse(&block)));
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, self.body.frame()).await {
                Err(_) => return Err(()),
                Ok(None) => return Ok(None),
                Ok(Some(Err(e))) => panic!("body error: {e}"),
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        self.buf.push_str(std::str::from_utf8(&data).unwrap());
                    }
                }
            }
        }
    }

    /// The next real event (comments skipped): (event name, data JSON).
    async fn next_event(&mut self) -> (String, Value) {
        self.try_event(Duration::from_secs(5))
            .await
            .expect("an event within 5s")
    }

    async fn try_event(&mut self, within: Duration) -> Option<(String, Value)> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next_msg(left).await {
                Err(()) => return None,
                Ok(None) => panic!("stream ended while waiting for an event"),
                Ok(Some(m)) if m.event.is_some() => {
                    let data: Value = serde_json::from_str(m.data.as_ref().unwrap()).unwrap();
                    return Some((m.event.unwrap(), data));
                }
                Ok(Some(_)) => {}
            }
        }
    }

    /// Wait until the server closes the stream (skipping any events and comments).
    async fn expect_closed(&mut self, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next_msg(left).await {
                Err(()) => panic!("stream stayed open"),
                Ok(None) => return,
                Ok(Some(_)) => {}
            }
        }
    }

    /// Assert that no event (comments aside) arrives for `quiet`.
    async fn expect_quiet(&mut self, quiet: Duration) {
        if let Some(ev) = self.try_event(quiet).await {
            panic!("unexpected event {ev:?}");
        }
    }
}

const SOON: Duration = Duration::from_secs(5);

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
    let env: og_core::api::events::EventEnvelope = serde_json::from_value(data).unwrap();
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
        .assert_status(200);
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
    let changed = opengrid::tasks::refresh_volatile_formulas(&f.app.state, later).unwrap();
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
    let hash = opengrid::ids::hash_token(token);
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
async fn removing_a_base_level_member_closes_their_stream() {
    let f = Fixture::new().await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
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
