//! BE-6: repeated edits of one text or rich text cell by one person fold into a single
//! history row (first `old` kept, `new` replaced, time moved to the latest edit) while the
//! row is under ten minutes old. Everything else still adds a row.
//!
//! The window tests drive the write engine with explicit clocks; the rest of the behaviour is
//! checked through the API.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use chrono::{DateTime, Duration, Utc};
use ob_core::api::records::RecordPatch;
use openbase::engine::write::{self, WriteCtx, WriteSource};
use openbase::perm::Role;
use query_support::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const WINDOW_MS: i64 = 10 * 60 * 1000;

/// Patch `record` as `user_id` at `at`, through the engine.
fn edit_at(
    f: &Fixture,
    user_id: &str,
    source: WriteSource,
    at: DateTime<Utc>,
    record: &str,
    values: Value,
) {
    let table = f.table_id.clone();
    let patch = RecordPatch {
        id: record.to_string(),
        values: values
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<BTreeMap<_, _>>(),
    };
    let ctx = WriteCtx::new(Some(user_id), source).at(at);
    f.app
        .state
        .db
        .write_sync(move |tx| {
            write::update_records(tx, &ctx, &table, vec![patch])?;
            Ok(())
        })
        .unwrap();
}

fn api_edit(f: &Fixture, user_id: &str, at: DateTime<Utc>, record: &str, values: Value) {
    edit_at(f, user_id, WriteSource::Api, at, record, values);
}

/// The update rows of a record, oldest first: `(user_id, changes, created_at)`.
fn updates(f: &Fixture, record: &str) -> Vec<(Option<String>, Value, i64)> {
    let record = record.to_string();
    sql(&f.app, |tx| {
        let mut stmt = tx.prepare(
            "SELECT user_id, changes, created_at FROM record_history
             WHERE record_id = ?1 AND kind = 'update' ORDER BY id",
        )?;
        let rows = stmt
            .query_map([&record], |r| {
                let raw: String = r.get(1)?;
                Ok((r.get(0)?, serde_json::from_str(&raw).unwrap(), r.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn uid(c: &common::Client) -> String {
    c.user_id.clone().unwrap()
}

async fn new_record(f: &Fixture) -> String {
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "v0" })).await;
    id_str(&rec["id"]).to_string()
}

/// Two edits of the Name cell `gap_ms` apart: the update rows left behind.
async fn two_edits(gap_ms: i64) -> (Fixture, Vec<(Option<String>, Value, i64)>) {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    api_edit(&f, &owner, t0, &id, json!({ &f.primary_id: "v1" }));
    api_edit(
        &f,
        &owner,
        t0 + Duration::milliseconds(gap_ms),
        &id,
        json!({ &f.primary_id: "v2" }),
    );
    let rows = updates(&f, &id);
    (f, rows)
}

#[tokio::test]
async fn an_edit_just_under_ten_minutes_after_the_last_folds_into_it() {
    let (f, rows) = two_edits(WINDOW_MS - 1).await;
    assert_eq!(rows.len(), 1);
    let change = &rows[0].1[&f.primary_id];
    assert_eq!(change, &json!({ "old": "v0", "new": "v2" }));
}

#[tokio::test]
async fn an_edit_exactly_ten_minutes_after_the_last_adds_a_row() {
    let (f, rows) = two_edits(WINDOW_MS).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].1[&f.primary_id],
        json!({ "old": "v0", "new": "v1" })
    );
    assert_eq!(
        rows[1].1[&f.primary_id],
        json!({ "old": "v1", "new": "v2" })
    );
}

#[tokio::test]
async fn an_edit_over_ten_minutes_after_the_last_adds_a_row() {
    let (_, rows) = two_edits(WINDOW_MS + 1).await;
    assert_eq!(rows.len(), 2);
}

#[tokio::test]
async fn the_folded_row_moves_to_the_latest_edit_so_the_window_slides() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    // Each edit is nine minutes after the one before, far over ten minutes after the first.
    for (i, text) in ["a", "ab", "abc"].iter().enumerate() {
        api_edit(
            &f,
            &owner,
            t0 + Duration::minutes(9 * i as i64),
            &id,
            json!({ &f.notes_id: text }),
        );
    }
    let rows = updates(&f, &id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1[&f.notes_id], json!({ "old": null, "new": "abc" }));
    assert_eq!(
        rows[0].2,
        (t0 + Duration::minutes(18)).timestamp_millis(),
        "the row carries the time of the latest edit"
    );
}

#[tokio::test]
async fn an_edit_dated_before_the_last_row_does_not_fold() {
    // A clock that went backwards must not rewrite history into the past.
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(10);
    api_edit(&f, &owner, t0, &id, json!({ &f.primary_id: "v1" }));
    api_edit(
        &f,
        &owner,
        t0 - Duration::seconds(5),
        &id,
        json!({ &f.primary_id: "v2" }),
    );
    assert_eq!(updates(&f, &id).len(), 2);
}

#[tokio::test]
async fn two_people_taking_turns_each_get_their_own_rows() {
    let f = Fixture::new().await;
    let ann = f.member("ann@example.com", Role::Editor);
    let id = new_record(&f).await;
    let (owner, ann_id) = (uid(&f.owner), uid(&ann));
    let t0 = Utc::now() + Duration::seconds(1);
    let at = |s: i64| t0 + Duration::seconds(s);
    api_edit(&f, &owner, at(0), &id, json!({ &f.notes_id: "o1" }));
    api_edit(&f, &ann_id, at(5), &id, json!({ &f.notes_id: "a1" }));
    api_edit(&f, &owner, at(10), &id, json!({ &f.notes_id: "o2" }));
    api_edit(&f, &owner, at(15), &id, json!({ &f.notes_id: "o3" }));
    api_edit(&f, &ann_id, at(20), &id, json!({ &f.notes_id: "a2" }));
    api_edit(&f, &ann_id, at(25), &id, json!({ &f.notes_id: "a3" }));

    let rows = updates(&f, &id);
    let seen: Vec<(String, Value)> = rows
        .iter()
        .map(|(u, c, _)| (u.clone().unwrap(), c[&f.notes_id].clone()))
        .collect();
    assert_eq!(
        seen,
        [
            (owner.clone(), json!({ "old": null, "new": "o1" })),
            (ann_id.clone(), json!({ "old": "o1", "new": "a1" })),
            (owner.clone(), json!({ "old": "a1", "new": "o3" })),
            (ann_id.clone(), json!({ "old": "o3", "new": "a3" })),
        ]
    );
}

#[tokio::test]
async fn a_row_that_changed_two_fields_is_never_folded_into() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    let at = |s: i64| t0 + Duration::seconds(s);
    // Two fields at once, then one of them alone: a new row.
    api_edit(
        &f,
        &owner,
        at(0),
        &id,
        json!({ &f.primary_id: "v1", &f.notes_id: "n1" }),
    );
    api_edit(&f, &owner, at(1), &id, json!({ &f.notes_id: "n2" }));
    assert_eq!(updates(&f, &id).len(), 2);
    // A single-field row, then an edit of two fields: also a new row.
    api_edit(&f, &owner, at(2), &id, json!({ &f.notes_id: "n3" }));
    api_edit(
        &f,
        &owner,
        at(3),
        &id,
        json!({ &f.primary_id: "v2", &f.notes_id: "n4" }),
    );
    let rows = updates(&f, &id);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].1[&f.notes_id], json!({ "old": "n1", "new": "n3" }));
    assert_eq!(rows[2].1.as_object().unwrap().len(), 2);
}

#[tokio::test]
async fn edits_of_different_fields_stay_separate_rows() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    api_edit(&f, &owner, t0, &id, json!({ &f.primary_id: "v1" }));
    api_edit(
        &f,
        &owner,
        t0 + Duration::seconds(1),
        &id,
        json!({ &f.notes_id: "n1" }),
    );
    assert_eq!(updates(&f, &id).len(), 2);
}

#[tokio::test]
async fn non_text_fields_log_every_edit() {
    let f = Fixture::new().await;
    let qty = f.number(&f.table_id, "Qty").await;
    let qty = qty["id"].as_str().unwrap().to_string();
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    for (i, n) in [1, 2, 3].iter().enumerate() {
        api_edit(
            &f,
            &owner,
            t0 + Duration::seconds(i as i64),
            &id,
            json!({ &qty: n }),
        );
    }
    assert_eq!(updates(&f, &id).len(), 3);
}

#[tokio::test]
async fn a_cell_changed_outside_the_log_starts_a_new_row() {
    // The folded row must continue from where its `new` left off.
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    api_edit(&f, &owner, t0, &id, json!({ &f.primary_id: "v1" }));
    set_data(&f.app, &id, json!({ &f.primary_id: "sneaky" }));
    api_edit(
        &f,
        &owner,
        t0 + Duration::seconds(1),
        &id,
        json!({ &f.primary_id: "v2" }),
    );
    let rows = updates(&f, &id);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[1].1[&f.primary_id],
        json!({ "old": "sneaky", "new": "v2" })
    );
}

#[tokio::test]
async fn automation_and_import_writes_never_fold() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    api_edit(&f, &owner, t0, &id, json!({ &f.primary_id: "v1" }));
    edit_at(
        &f,
        &owner,
        WriteSource::Automation,
        t0 + Duration::seconds(1),
        &id,
        json!({ &f.primary_id: "v2" }),
    );
    edit_at(
        &f,
        &owner,
        WriteSource::Import,
        t0 + Duration::seconds(2),
        &id,
        json!({ &f.primary_id: "v3" }),
    );
    assert_eq!(updates(&f, &id).len(), 3);
}

#[tokio::test]
async fn the_create_row_and_later_deletes_are_never_folded_into() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    f.set(&f.table_id, &id, json!({ &f.primary_id: "v1" }))
        .await;
    f.delete_records(&f.table_id, &[&id])
        .await
        .assert_status(204);
    f.restore_records(&f.table_id, &[&id])
        .await
        .assert_status(200);
    f.set(&f.table_id, &id, json!({ &f.primary_id: "v2" }))
        .await;
    let h = f
        .app
        .get(&f.owner, &format!("/api/records/{id}/history"))
        .await;
    let kinds: Vec<&str> = h
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["update", "restore", "delete", "update", "create"]);
}

// ------------------------------------------------- what reads the history

#[tokio::test]
async fn history_and_feed_show_one_entry_with_the_first_old_and_the_latest_new() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    for text in ["a", "ab", "abc"] {
        f.set(&f.table_id, &id, json!({ &f.notes_id: text })).await;
    }
    let h = f
        .app
        .get(&f.owner, &format!("/api/records/{id}/history"))
        .await;
    h.assert_status(200);
    let entries = h.body.as_array().unwrap();
    assert_eq!(entries.len(), 2, "create + one folded update");
    assert_eq!(
        entries[0]["changes"][&f.notes_id],
        json!({ "old": null, "new": "abc" })
    );

    let feed = f.app.get(&f.owner, "/api/history?kind=update").await;
    feed.assert_status(200);
    let items = feed.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["changes"][&f.notes_id],
        json!({ "old": null, "new": "abc" })
    );
    // The entry keeps its id, so a page cursor taken from it still works.
    assert_eq!(items[0]["kind"], "update");
}

#[tokio::test]
async fn a_mention_added_by_a_folded_edit_still_notifies() {
    let f = Fixture::new().await;
    let ann = f.member("ann@example.com", Role::Viewer);
    let id = new_record(&f).await;
    f.set(&f.table_id, &id, json!({ &f.notes_id: "see" })).await;
    f.set(
        &f.table_id,
        &id,
        json!({ &f.notes_id: format!("see @[Ann]({})", ann.user_id.as_ref().unwrap()) }),
    )
    .await;
    assert_eq!(updates(&f, &id).len(), 1);
    let n = count(
        &f.app,
        "SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND kind = 'mention'",
        ann.user_id.as_ref().unwrap(),
    );
    assert_eq!(n, 1);
}

#[tokio::test]
async fn last_modified_follows_the_folded_row() {
    let f = Fixture::new().await;
    let id = new_record(&f).await;
    let owner = uid(&f.owner);
    let t0 = Utc::now() + Duration::seconds(1);
    api_edit(&f, &owner, t0, &id, json!({ &f.notes_id: "a" }));
    let t1 = t0 + Duration::minutes(5);
    api_edit(&f, &owner, t1, &id, json!({ &f.notes_id: "ab" }));
    let fields = vec![f.notes_id.clone()];
    let record = id.clone();
    let last = sql(&f.app, |tx| {
        Ok(openbase::store::history::last_modified(tx, &record, &fields).unwrap())
    });
    assert_eq!(last, Some((t1.timestamp_millis(), Some(owner))));
}
