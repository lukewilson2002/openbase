//! The inbox: a user's private quick-capture drafts (`/api/inbox`): CRUD, ownership (everyone
//! else gets 404), uploads that belong to no base yet, and filing a draft into a table.

mod common;
mod records_support;
mod schema_support;

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, Response, TestApp};
use openbase::perm::Role;
use records_support::*;
use serde_json::{Value, json};

const BOUNDARY: &str = "----inbox-test-boundary";

async fn upload(app: &TestApp, who: &Client, filename: &str, data: &[u8]) -> Response {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let mut req = Request::builder()
        .method("POST")
        .uri("/api/inbox/attachments");
    if let Some(c) = &who.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", openbase::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &who.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let req = req
        .header(openbase::http::CSRF_HEADER, "1")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .unwrap();
    app.send(req).await
}

async fn add(app: &TestApp, who: &Client, body: &str) -> Value {
    let r = app.post(who, "/api/inbox", json!({ "body": body })).await;
    r.assert_status(201);
    r.body.clone()
}

fn message(r: &Response) -> String {
    r.body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn ids(list: &Response) -> Vec<String> {
    list.body
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn drafts_can_be_added_listed_changed_and_deleted() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let first = add(&app, &me, "first note").await;
    assert!(first["id"].as_str().unwrap().starts_with("inb"));
    assert_eq!(first["body"], "first note");
    assert_eq!(first["attachments"], json!([]));
    assert!(first["created_at"].as_i64().unwrap() > 0);
    let second = add(&app, &me, "second note").await;

    // Newest first.
    let list = app.get(&me, "/api/inbox").await;
    list.assert_status(200);
    assert_eq!(
        ids(&list),
        [
            second["id"].as_str().unwrap().to_string(),
            first["id"].as_str().unwrap().to_string()
        ]
    );

    // Editing moves a draft to the top and keeps what was not given.
    let id = first["id"].as_str().unwrap();
    let r = app
        .patch(
            &me,
            &format!("/api/inbox/{id}"),
            json!({ "body": "edited" }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["body"], "edited");
    assert_eq!(r.body["attachments"], json!([]));
    assert!(r.body["updated_at"].as_i64() >= first["updated_at"].as_i64());
    let list = app.get(&me, "/api/inbox").await;
    assert_eq!(ids(&list)[0], id);

    // An empty note is fine (a draft may be files only).
    app.post(&me, "/api/inbox", json!({}))
        .await
        .assert_status(201);

    app.delete(&me, &format!("/api/inbox/{id}"))
        .await
        .assert_status(204);
    app.delete(&me, &format!("/api/inbox/{id}"))
        .await
        .assert_status(404);
    assert!(!ids(&app.get(&me, "/api/inbox").await).contains(&id.to_string()));
}

#[tokio::test]
async fn drafts_are_private_to_their_owner() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let other = app.user("other@example.com", "Other");
    let mine = add(&app, &me, "secret").await;
    let id = mine["id"].as_str().unwrap();

    assert_eq!(app.get(&other, "/api/inbox").await.body, json!([]));
    app.patch(&other, &format!("/api/inbox/{id}"), json!({ "body": "x" }))
        .await
        .assert_status(404);
    app.delete(&other, &format!("/api/inbox/{id}"))
        .await
        .assert_status(404);
    app.post(
        &other,
        &format!("/api/inbox/{id}/file"),
        json!({ "table_id": "tblNope", "fields": {} }),
    )
    .await
    .assert_status(404);
    // Nothing changed for the owner, and strangers have to sign in.
    let list = app.get(&me, "/api/inbox").await;
    assert_eq!(list.body[0]["body"], "secret");
    app.get(&app.anon(), "/api/inbox").await.assert_status(401);
}

#[tokio::test]
async fn limits_and_validation() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let long = "x".repeat(ob_core::limits::MAX_TEXT_CELL_LEN + 1);
    app.post(&me, "/api/inbox", json!({ "body": long }))
        .await
        .assert_status(400);
    let ok = "x".repeat(ob_core::limits::MAX_TEXT_CELL_LEN);
    add(&app, &me, &ok).await;
    // A file that was never uploaded.
    app.post(
        &me,
        "/api/inbox",
        json!({ "body": "", "attachments": [
            { "id": "attNoSuchFile12345", "filename": "a.txt", "mime": "text/plain", "size": 1 }
        ] }),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn read_only_tokens_can_list_but_not_write() {
    let f = Fixture::new().await;
    add(&f.app, &f.owner, "mine").await;
    let ro = token_client(&f.app, &f.owner, false);
    let rw = token_client(&f.app, &f.owner, true);
    f.app.get(&ro, "/api/inbox").await.assert_status(200);
    f.app
        .post(&ro, "/api/inbox", json!({ "body": "x" }))
        .await
        .assert_status(403);
    // A write token is the same person: it sees and adds to the same inbox.
    f.app
        .post(&rw, "/api/inbox", json!({ "body": "from a token" }))
        .await
        .assert_status(201);
    assert_eq!(
        f.app
            .get(&f.owner, "/api/inbox")
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn uploads_belong_to_the_uploader_until_the_draft_is_filed() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let other = app.user("other@example.com", "Other");
    let up = upload(&app, &me, "note.txt", b"hello inbox").await;
    up.assert_status(200);
    let file = up.body.clone();
    let att = file["id"].as_str().unwrap();
    assert!(att.starts_with("att"));
    assert_eq!(file["filename"], "note.txt");
    assert_eq!(file["size"], 11);

    // Only the uploader can download it.
    let dl = app
        .get(&me, &format!("/api/attachments/{att}/note.txt"))
        .await;
    dl.assert_status(200);
    assert_eq!(dl.bytes, b"hello inbox");
    app.get(&other, &format!("/api/attachments/{att}/note.txt"))
        .await
        .assert_status(404);
    app.get(&app.anon(), &format!("/api/attachments/{att}/note.txt"))
        .await
        .assert_status(404);

    // A draft keeps the reference; somebody else's upload cannot be put in it.
    let r = app
        .post(
            &me,
            "/api/inbox",
            json!({ "body": "see file", "attachments": [file.clone()] }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["attachments"][0]["id"], att);
    app.post(
        &other,
        "/api/inbox",
        json!({ "attachments": [file.clone()] }),
    )
    .await
    .assert_status(400);

    // Replacing the list with nothing detaches it.
    let id = r.body["id"].as_str().unwrap();
    let r = app
        .patch(
            &me,
            &format!("/api/inbox/{id}"),
            json!({ "attachments": [] }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["attachments"], json!([]));
}

#[tokio::test]
async fn files_of_drafts_survive_the_attachment_cleanup() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let kept = upload(&app, &me, "kept.txt", b"kept").await.body.clone();
    let lost = upload(&app, &me, "lost.txt", b"lost").await.body.clone();
    app.post(&me, "/api/inbox", json!({ "attachments": [kept.clone()] }))
        .await
        .assert_status(201);
    // Everything older than "the far future" is a candidate for deletion.
    let far = openbase::db::now_ms() + 10_000_000;
    let deleted = schema_support::sql(&app, |tx| {
        Ok(openbase::store::attachments::delete_unreferenced(tx, far, far).unwrap())
    });
    assert_eq!(deleted.len(), 1);
    let exists =
        |id: &str| app.query_i64("SELECT count(*) FROM attachments WHERE id = ?1", &[id]) == 1;
    assert!(exists(kept["id"].as_str().unwrap()));
    assert!(!exists(lost["id"].as_str().unwrap()));
}

#[tokio::test]
async fn filing_creates_the_record_and_removes_the_draft() {
    let f = Fixture::new().await;
    let item = add(&f.app, &f.owner, "Call the plumber").await;
    let id = item["id"].as_str().unwrap();

    // Field names and ids both work as keys.
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Name": "Plumber",
                f.notes_id.as_str(): "Call the plumber",
            } }),
        )
        .await;
    r.assert_status(201);
    let rec = r.body.clone();
    assert_eq!(rec["table_id"], f.table_id);
    assert_eq!(rec["values"][&f.primary_id], "Plumber");
    assert_eq!(rec["values"][&f.notes_id], "Call the plumber");
    assert_eq!(rec["created_by"], f.owner.user_id.clone().unwrap());

    // The record is really there, and the draft is gone.
    let got = f.get(&f.table_id, rec["id"].as_str().unwrap()).await;
    assert_eq!(got["values"][&f.primary_id], "Plumber");
    assert!(
        f.app
            .get(&f.owner, "/api/inbox")
            .await
            .body
            .as_array()
            .unwrap()
            .is_empty()
    );
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{id}"),
            json!({ "body": "x" }),
        )
        .await
        .assert_status(404);
    // History records the creation like any other.
    f.app
        .get(
            &f.owner,
            &format!("/api/records/{}/history", rec["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn filing_can_add_the_note_as_the_records_first_comment() {
    let f = Fixture::new().await;
    let item = add(&f.app, &f.owner, "Ask about **Tuesday**").await;
    let id = item["id"].as_str().unwrap();
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": { "Name": "Plumber" }, "note_as_comment": true }),
        )
        .await;
    r.assert_status(201);
    let rec = r.body["id"].as_str().unwrap().to_string();
    // The note is not in any field, but in the one comment, by the person who filed it.
    assert!(r.body["values"].get(&f.notes_id).is_none());
    let comments = f
        .app
        .get(&f.owner, &format!("/api/records/{rec}/comments"))
        .await;
    comments.assert_status(200);
    let list = comments.body.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["body"], "Ask about **Tuesday**");
    assert_eq!(list[0]["user_id"], f.owner.user_id.clone().unwrap());
    assert!(
        f.app
            .get(&f.owner, "/api/inbox")
            .await
            .body
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_note_too_long_for_a_comment_files_nothing() {
    let f = Fixture::new().await;
    let item = add(&f.app, &f.owner, &"x".repeat(10_001)).await;
    let id = item["id"].as_str().unwrap();
    let live = "SELECT count(*) FROM records WHERE table_id = ?1 AND deleted_at IS NULL";
    let before = f.app.query_i64(live, &[f.table_id.as_str()]);
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": { "Name": "Long" }, "note_as_comment": true }),
        )
        .await;
    r.assert_status(400);
    // Neither the record nor the comment exists, and the draft is still there.
    assert_eq!(f.app.query_i64(live, &[f.table_id.as_str()]), before);
    assert_eq!(
        f.app
            .get(&f.owner, "/api/inbox")
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn filing_publishes_the_record_event() {
    use ob_core::api::events::BaseEvent;
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let item = add(&f.app, &f.owner, "x").await;
    f.app
        .post(
            &f.owner,
            &format!("/api/inbox/{}/file", item["id"].as_str().unwrap()),
            json!({ "table_id": f.table_id, "fields": { "Name": "evt" } }),
        )
        .await
        .assert_status(201);
    let env = rx.recv().await.unwrap();
    assert!(matches!(&env.event, BaseEvent::RecordsChanged { created, .. } if created.len() == 1));
}

#[tokio::test]
async fn filing_moves_the_files_into_the_tables_base() {
    let f = Fixture::new().await;
    let files = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let viewer = f.member("viewer@example.com", Role::Viewer);
    let file = upload(&f.app, &f.owner, "plan.txt", b"the plan")
        .await
        .body
        .clone();
    let att = file["id"].as_str().unwrap();
    let item = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "body": "with a file", "attachments": [file] }),
        )
        .await;
    item.assert_status(201);

    // Before filing nobody else can read it.
    f.app
        .get(&viewer, &format!("/api/attachments/{att}/plan.txt"))
        .await
        .assert_status(404);

    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{}/file", item.body["id"].as_str().unwrap()),
            json!({ "table_id": f.table_id, "fields": {
                "Name": "Plan", "Files": [ { "id": att } ] } }),
        )
        .await;
    r.assert_status(201);
    let cell = &r.body["values"][files["id"].as_str().unwrap()];
    assert_eq!(cell[0]["id"], att);
    assert_eq!(cell[0]["filename"], "plan.txt");

    // Now it is an attachment of the base: viewers of the base can download it.
    let dl = f
        .app
        .get(&viewer, &format!("/api/attachments/{att}/plan.txt"))
        .await;
    dl.assert_status(200);
    assert_eq!(dl.bytes, b"the plan");
}

#[tokio::test]
async fn filing_into_a_table_you_cannot_write_to_changes_nothing() {
    let f = Fixture::new().await;
    let viewer = f.member("viewer@example.com", Role::Viewer);
    let stranger = f.app.user("stranger@example.com", "Stranger");
    for (who, status) in [(&viewer, 403), (&stranger, 404)] {
        let file = upload(&f.app, who, "a.txt", b"a").await.body.clone();
        let item = f
            .app
            .post(
                who,
                "/api/inbox",
                json!({ "body": "mine", "attachments": [file] }),
            )
            .await;
        item.assert_status(201);
        let id = item.body["id"].as_str().unwrap();
        f.app
            .post(
                who,
                &format!("/api/inbox/{id}/file"),
                json!({ "table_id": f.table_id, "fields": { "Name": "nope" } }),
            )
            .await
            .assert_status(status);
        // The draft and its file are untouched, and no record was made.
        let list = f.app.get(who, "/api/inbox").await;
        assert_eq!(list.body.as_array().unwrap().len(), 1);
        assert_eq!(list.body[0]["attachments"].as_array().unwrap().len(), 1);
    }
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM records WHERE table_id = ?1",
            &[&f.table_id]
        ),
        0
    );
}

#[tokio::test]
async fn a_failed_filing_keeps_the_draft_and_its_files_private() {
    let f = Fixture::new().await;
    let files = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let file = upload(&f.app, &f.owner, "a.txt", b"a").await.body.clone();
    let att = file["id"].as_str().unwrap();
    let item = f
        .app
        .post(&f.owner, "/api/inbox", json!({ "attachments": [file] }))
        .await;
    let id = item.body["id"].as_str().unwrap();
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Files": [ { "id": att } ], "No such field": 1 } }),
        )
        .await;
    assert!(r.status.is_client_error(), "{}", r.status);
    assert_eq!(
        f.app
            .get(&f.owner, "/api/inbox")
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // The file did not move into the base: the rolled-back write left it unattached.
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id IS NULL",
            &[att]
        ),
        1
    );
    let _ = files;
}

#[tokio::test]
async fn a_base_limited_token_cannot_reach_the_inbox() {
    let f = Fixture::new().await;
    let file = upload(&f.app, &f.owner, "a.txt", b"private")
        .await
        .body
        .clone();
    let att = file["id"].as_str().unwrap().to_string();
    let item = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "body": "secret", "attachments": [file] }),
        )
        .await;
    item.assert_status(201);
    let id = item.body["id"].as_str().unwrap().to_string();

    let limited = f
        .app
        .raw_token(&f.owner, json!({ "write": true, "base_ids": [f.base_id] }));
    let read_only_limited = f
        .app
        .raw_token(&f.owner, json!({ "write": false, "base_ids": [f.base_id] }));
    for (who, said) in [(&limited, true), (&read_only_limited, false)] {
        let refused = [
            f.app.get(who, "/api/inbox").await,
            f.app.post(who, "/api/inbox", json!({ "body": "x" })).await,
            f.app
                .patch(who, &format!("/api/inbox/{id}"), json!({ "body": "x" }))
                .await,
            f.app.delete(who, &format!("/api/inbox/{id}")).await,
            upload(&f.app, who, "b.txt", b"new").await,
            // Even into a base the token may write to.
            f.app
                .post(
                    who,
                    &format!("/api/inbox/{id}/file"),
                    json!({ "table_id": f.table_id, "fields": { "Name": "no" } }),
                )
                .await,
            f.app
                .get(who, &format!("/api/attachments/{att}/a.txt"))
                .await,
            f.app
                .get(who, &format!("/api/attachments/{att}/thumb"))
                .await,
        ];
        for r in refused {
            r.assert_status(403);
            // A read-only token's writes are refused for that reason first.
            if said {
                assert!(
                    message(&r).contains("limited to specific bases"),
                    "{}",
                    message(&r)
                );
            }
        }
    }
    // Nothing changed: the draft, its text and its file are as they were.
    let list = f.app.get(&f.owner, "/api/inbox").await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert_eq!(list.body[0]["body"], "secret");
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE base_id IS NULL",
            &[]
        ),
        1
    );
    assert_eq!(
        f.app
            .get(&f.owner, &format!("/api/attachments/{att}/a.txt"))
            .await
            .bytes,
        b"private"
    );
    // The token still works on the base itself.
    f.app
        .get(&limited, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_token_without_a_base_limit_uses_the_whole_inbox() {
    let f = Fixture::new().await;
    let rw = token_client(&f.app, &f.owner, true);
    let file = upload(&f.app, &rw, "t.txt", b"from a token")
        .await
        .body
        .clone();
    let att = file["id"].as_str().unwrap().to_string();
    let item = f
        .app
        .post(
            &rw,
            "/api/inbox",
            json!({ "body": "via token", "attachments": [file] }),
        )
        .await;
    item.assert_status(201);
    let id = item.body["id"].as_str().unwrap();
    f.app
        .get(&rw, &format!("/api/attachments/{att}/t.txt"))
        .await
        .assert_status(200);
    f.app
        .patch(
            &rw,
            &format!("/api/inbox/{id}"),
            json!({ "body": "edited" }),
        )
        .await
        .assert_status(200);
    f.app
        .post(
            &rw,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": { "Name": "yes" } }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn inbox_uploads_are_capped_per_user() {
    // One megabyte of unattached files per user.
    let app = TestApp::with_config(|c| c.max_inbox_mb = 1);
    let me = app.user("me@example.com", "Me");
    let other = app.user("other@example.com", "Other");
    let chunk = vec![7u8; 600 * 1024];

    let first = upload(&app, &me, "one.bin", &chunk).await;
    first.assert_status(200);
    let r = upload(&app, &me, "two.bin", &chunk).await;
    r.assert_status(413);
    assert!(message(&r).contains("inbox"), "{}", message(&r));
    // The refused upload left no row behind.
    assert_eq!(app.query_i64("SELECT count(*) FROM attachments", &[]), 1);
    // Small files still fit, and the cap is per user.
    upload(&app, &me, "small.txt", b"tiny")
        .await
        .assert_status(200);
    upload(&app, &other, "two.bin", &chunk)
        .await
        .assert_status(200);

    // Uploads into a base are not part of the inbox quota.
    let owner = app.admin("owner@example.com", "Owner");
    let (_ws, base) = app.workspace_with_base(&owner, "Acme");
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&vec![1u8; 1200 * 1024]);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let mut req = Request::builder()
        .method("POST")
        .uri(format!("/api/bases/{base}/attachments"))
        .header(openbase::http::CSRF_HEADER, "1")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        );
    req = req.header(
        header::COOKIE,
        format!(
            "{}={}",
            openbase::auth::SESSION_COOKIE,
            owner.cookie.as_ref().unwrap()
        ),
    );
    app.send(req.body(Body::from(body)).unwrap())
        .await
        .assert_status(200);

    // Only files that are still in no base count: the user has two of them.
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM attachments WHERE base_id IS NULL AND created_by = ?1",
            &[me.user_id.as_ref().unwrap()]
        ),
        2
    );
}

#[tokio::test]
async fn inbox_uploads_are_rate_limited_per_user() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    let other = app.user("other@example.com", "Other");
    for i in 0..60 {
        upload(&app, &me, &format!("f{i}.txt"), format!("{i}").as_bytes())
            .await
            .assert_status(200);
    }
    upload(&app, &me, "late.txt", b"late")
        .await
        .assert_status(429);
    upload(&app, &other, "fine.txt", b"fine")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_draft_holds_at_most_twenty_files() {
    let app = TestApp::new();
    let me = app.user("me@example.com", "Me");
    assert_eq!(ob_core::limits::MAX_INBOX_ATTACHMENTS, 20);
    let mut files = Vec::new();
    for i in 0..21 {
        files.push(
            upload(&app, &me, &format!("f{i}.txt"), format!("{i}").as_bytes())
                .await
                .body
                .clone(),
        );
    }
    app.post(&me, "/api/inbox", json!({ "attachments": files }))
        .await
        .assert_status(400);
    files.pop();
    app.post(&me, "/api/inbox", json!({ "attachments": files }))
        .await
        .assert_status(201);
}

#[tokio::test]
async fn a_file_can_be_in_only_one_draft_at_a_time() {
    let f = Fixture::new().await;
    let file = upload(&f.app, &f.owner, "once.txt", b"once")
        .await
        .body
        .clone();
    let a = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "body": "A", "attachments": [file.clone()] }),
        )
        .await;
    a.assert_status(201);
    let a_id = a.body["id"].as_str().unwrap().to_string();

    // A second draft cannot take it, on create or on update.
    let r = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "body": "B", "attachments": [file.clone()] }),
        )
        .await;
    r.assert_status(400);
    assert!(message(&r).contains("another draft"), "{}", message(&r));
    let b = add(&f.app, &f.owner, "B").await;
    let b_id = b["id"].as_str().unwrap().to_string();
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{b_id}"),
            json!({ "attachments": [file.clone()] }),
        )
        .await
        .assert_status(400);
    // Re-saving the draft that already has it is fine.
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{a_id}"),
            json!({ "body": "A2", "attachments": [file.clone()] }),
        )
        .await
        .assert_status(200);

    // Once the first draft lets go, the second can have it.
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{a_id}"),
            json!({ "attachments": [] }),
        )
        .await
        .assert_status(200);
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{b_id}"),
            json!({ "attachments": [file] }),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn filing_takes_the_moved_files_out_of_other_drafts() {
    let f = Fixture::new().await;
    let files = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let file = upload(&f.app, &f.owner, "shared.txt", b"shared")
        .await
        .body
        .clone();
    let att = file["id"].as_str().unwrap().to_string();
    let a = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "attachments": [file.clone()] }),
        )
        .await;
    let a_id = a.body["id"].as_str().unwrap().to_string();
    let b = add(&f.app, &f.owner, "B").await;
    let b_id = b["id"].as_str().unwrap().to_string();
    // Force the state the API refuses to create: the same file in a second draft.
    let stale = serde_json::to_string(&json!([file])).unwrap();
    schema_support::sql(&f.app, |tx| {
        tx.execute(
            "UPDATE inbox_items SET attachments = ?1 WHERE id = ?2",
            rusqlite::params![stale, b_id],
        )
    });

    f.app
        .post(
            &f.owner,
            &format!("/api/inbox/{a_id}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Name": "Shared", files["id"].as_str().unwrap(): [ { "id": att } ] } }),
        )
        .await
        .assert_status(201);
    // The other draft no longer points at a file that now belongs to a base.
    let list = f.app.get(&f.owner, "/api/inbox").await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert_eq!(list.body[0]["id"], b_id);
    assert_eq!(list.body[0]["attachments"], json!([]));
}

#[tokio::test]
async fn only_files_in_attachment_fields_move_into_the_base() {
    let f = Fixture::new().await;
    let files = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let files_id = files["id"].as_str().unwrap().to_string();
    let kept = upload(&f.app, &f.owner, "kept.txt", b"kept")
        .await
        .body
        .clone();
    let moved = upload(&f.app, &f.owner, "moved.txt", b"moved")
        .await
        .body
        .clone();
    let (kept_id, moved_id) = (
        kept["id"].as_str().unwrap().to_string(),
        moved["id"].as_str().unwrap().to_string(),
    );
    let item = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "attachments": [kept, moved] }),
        )
        .await;
    let id = item.body["id"].as_str().unwrap();
    // The first file is only named in a text field; the second is attached, by
    // field id this time.
    f.app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Name": format!("see {kept_id}"),
                files_id.as_str(): [ { "id": moved_id } ] } }),
        )
        .await
        .assert_status(201);
    let in_base = |att: &str| {
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id = ?2",
            &[att, &f.base_id],
        ) == 1
    };
    assert!(in_base(&moved_id));
    assert!(!in_base(&kept_id), "a mention in text must not move a file");
}
