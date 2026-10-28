//! `POST /api/tables/{id}/records/{rid}/discard`: taking back a record nobody touched, for good
//! and without a trace.

mod common;
mod records_support;
mod schema_support;

use ob_core::api::events::BaseEvent;
use openbase::perm::Role;
use records_support::*;
use serde_json::{Value, json};

fn discard_url(table_id: &str, id: &str) -> String {
    format!("/api/tables/{table_id}/records/{id}/discard")
}

async fn discard(f: &Fixture, c: &common::Client, id: &str) -> common::Response {
    f.app
        .post(c, &discard_url(&f.table_id, id), json!({}))
        .await
}

fn rows(f: &Fixture, sql_text: &'static str, id: &str) -> i64 {
    let id = id.to_string();
    f.app.query_i64(sql_text, &[id.as_str()])
}

fn nothing_left(f: &Fixture, id: &str) {
    assert_eq!(rows(f, "SELECT COUNT(*) FROM records WHERE id = ?1", id), 0);
    assert_eq!(
        rows(
            f,
            "SELECT COUNT(*) FROM record_history WHERE record_id = ?1",
            id
        ),
        0
    );
}

#[tokio::test]
async fn an_untouched_new_record_is_removed_without_a_trace() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    let mut rx = f.app.state.events.subscribe(&f.base_id);

    let r = discard(&f, &f.owner, &id).await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "discarded": true }));
    nothing_left(&f, &id);

    // not in the trash either
    let t = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/trash", f.base_id))
        .await;
    t.assert_status(200);
    assert!(!t.body.to_string().contains(&id), "{}", t.body);
    f.app
        .get(
            &f.owner,
            &format!("/api/tables/{}/records/{id}", f.table_id),
        )
        .await
        .assert_status(404);

    // other clients drop the row
    assert!(matches!(
        rx.try_recv().unwrap().event,
        BaseEvent::RecordsChanged { ref deleted, .. } if deleted.as_slice() == std::slice::from_ref(&id)
    ));
}

#[tokio::test]
async fn an_edited_record_stays() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    f.set(&f.table_id, &id, json!({ &f.primary_id: "x" })).await;
    let r = discard(&f, &f.owner, &id).await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "discarded": false }));
    assert_eq!(f.get(&f.table_id, &id).await["values"][&f.primary_id], "x");
    assert_eq!(f.history(&id).len(), 2);
}

#[tokio::test]
async fn another_users_record_stays() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    let r = discard(&f, &editor, &id).await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "discarded": false }));
    assert_eq!(f.history(&id).len(), 1);
    f.get(&f.table_id, &id).await;
}

#[tokio::test]
async fn viewers_cannot_discard() {
    let f = Fixture::new().await;
    let viewer = f.member("viewer@example.com", Role::Viewer);
    let rec = f.create(&f.table_id, json!({})).await;
    discard(&f, &viewer, sid(&rec["id"]))
        .await
        .assert_status(403);
}

#[tokio::test]
async fn a_commented_record_stays() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    f.app
        .post(
            &f.owner,
            &format!("/api/records/{id}/comments"),
            json!({ "body": "hi" }),
        )
        .await
        .assert_status(201);
    assert_eq!(
        discard(&f, &f.owner, &id).await.body,
        json!({ "discarded": false })
    );
    assert_eq!(
        rows(&f, "SELECT COUNT(*) FROM records WHERE id = ?1", &id),
        1
    );
}

#[tokio::test]
async fn an_old_record_stays() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    let old = chrono::Utc::now().timestamp_millis() - 25 * 60 * 60 * 1000;
    schema_support::sql(&f.app, |tx| {
        tx.execute(
            "UPDATE records SET created_at = ?2, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![id, old],
        )?;
        Ok(())
    });
    assert_eq!(
        discard(&f, &f.owner, &id).await.body,
        json!({ "discarded": false })
    );
    assert_eq!(
        rows(&f, "SELECT COUNT(*) FROM records WHERE id = ?1", &id),
        1
    );
}

#[tokio::test]
async fn a_deleted_record_is_not_found() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let id = sid(&rec["id"]).to_string();
    f.delete_records(&f.table_id, &[&id])
        .await
        .assert_status(204);
    discard(&f, &f.owner, &id).await.assert_status(404);
}

#[tokio::test]
async fn a_record_with_links_either_way_stays() {
    let l = linked().await;
    let f = &l.f;
    let order = f.create(&l.t2, json!({})).await;
    let oid = sid(&order["id"]).to_string();
    let cust = f.create(&l.t1, json!({ sid(&l.link["id"]): [&oid] })).await;
    // something links to the order
    let url = discard_url(&l.t2, &oid);
    let r = f.app.post(&f.owner, &url, json!({})).await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "discarded": false }));
    assert_eq!(
        rows(f, "SELECT COUNT(*) FROM records WHERE id = ?1", &oid),
        1
    );

    // a new record created already linking to another one
    let cid = sid(&cust["id"]).to_string();
    let order2 = f
        .create(&l.t2, json!({ sid(&l.inverse["id"]): [&cid] }))
        .await;
    let o2 = sid(&order2["id"]).to_string();
    let r = f
        .app
        .post(&f.owner, &discard_url(&l.t2, &o2), json!({}))
        .await;
    assert_eq!(r.body, json!({ "discarded": false }));
    assert_eq!(
        rows(f, "SELECT COUNT(*) FROM records WHERE id = ?1", &o2),
        1
    );
    let _: Value = f.get(&l.t1, &cid).await;
}
