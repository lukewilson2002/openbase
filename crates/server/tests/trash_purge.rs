//! Permanently purging expired trash: what goes, what stays, and the cleanup
//! of link arrays and record data on the other side.

mod common;
mod schema_support;

use openbase::store::trash::{PurgeStats, purge_expired};
use schema_support::*;
use serde_json::{Value, json};

const OLD: i64 = 1_000;
const CUTOFF: i64 = 5_000;
const RECENT: i64 = 9_000;

fn purge(f: &Fixture) -> PurgeStats {
    f.app
        .state
        .db
        .write_sync(|tx| purge_expired(tx, CUTOFF))
        .unwrap()
}

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn exists(f: &Fixture, table: &str, id: &str) -> bool {
    count(
        &f.app,
        &format!("SELECT count(*) FROM {table} WHERE id = ?1"),
        id,
    ) > 0
}

fn fk_violations(f: &Fixture) -> i64 {
    sql(&f.app, |tx| {
        tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
    })
}

#[tokio::test]
async fn only_items_deleted_before_the_cutoff_are_purged() {
    let f = Fixture::new().await;
    let old_rec = f.insert_record(&f.table_id, json!({}));
    let new_rec = f.insert_record(&f.table_id, json!({}));
    let live_rec = f.insert_record(&f.table_id, json!({}));
    trash_record(&f.app, &old_rec, OLD);
    trash_record(&f.app, &new_rec, RECENT);

    let old_field = f
        .add_field(
            &f.table_id,
            json!({ "name": "Old", "type": "number", "options": {} }),
        )
        .await;
    let new_field = f
        .add_field(
            &f.table_id,
            json!({ "name": "New", "type": "number", "options": {} }),
        )
        .await;
    let v1 = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "A", "type": "grid" }),
        )
        .await;
    let v2 = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "B", "type": "grid" }),
        )
        .await;
    let old_t = f.add_table("OldT").await;
    let new_t = f.add_table("NewT").await;
    for (kind, id) in [
        ("fields", sid(&old_field["id"])),
        ("views", sid(&v1.body["id"])),
        ("tables", sid(&old_t["id"])),
    ] {
        let path = match kind {
            "fields" => format!("/api/fields/{id}"),
            "views" => format!("/api/views/{id}"),
            _ => format!("/api/tables/{id}"),
        };
        f.app.delete(&f.owner, &path).await.assert_status(200);
        set_deleted_at(&f.app, kind, id, OLD);
    }
    for (kind, id) in [
        ("fields", sid(&new_field["id"])),
        ("views", sid(&v2.body["id"])),
        ("tables", sid(&new_t["id"])),
    ] {
        let path = match kind {
            "fields" => format!("/api/fields/{id}"),
            "views" => format!("/api/views/{id}"),
            _ => format!("/api/tables/{id}"),
        };
        f.app.delete(&f.owner, &path).await.assert_status(200);
        set_deleted_at(&f.app, kind, id, RECENT);
    }

    let stats = purge(&f);
    assert_eq!(stats.records, 1, "only the old record (OldT has none)");
    assert_eq!(
        stats.fields,
        1 + 1,
        "the old field and OldT's primary field"
    );
    assert_eq!(stats.views, 1 + 1, "the old view and OldT's grid view");
    assert_eq!(stats.tables, 1);
    assert_eq!((stats.bases, stats.workspaces), (0, 0));

    assert!(!exists(&f, "records", &old_rec));
    assert!(exists(&f, "records", &new_rec));
    assert!(exists(&f, "records", &live_rec));
    assert!(!exists(&f, "fields", sid(&old_field["id"])));
    assert!(exists(&f, "fields", sid(&new_field["id"])));
    assert!(!exists(&f, "views", sid(&v1.body["id"])));
    assert!(exists(&f, "views", sid(&v2.body["id"])));
    assert!(!exists(&f, "tables", sid(&old_t["id"])));
    assert!(exists(&f, "tables", sid(&new_t["id"])));
    assert_eq!(fk_violations(&f), 0);

    // purging again finds nothing
    assert_eq!(purge(&f), PurgeStats::default());
    // and the live schema is intact
    assert_eq!(
        Fixture::field_names(&f.table(&f.table_id).await),
        ["Name", "Notes"]
    );
}

#[tokio::test]
async fn purging_a_record_removes_its_id_from_linked_records() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let o1 = f.insert_record(&t2id, json!({}));
    let o2 = f.insert_record(&t2id, json!({}));
    let c1 = f.insert_record(
        &f.table_id,
        json!({ &lid: [o1, o2], &f.primary_id: "keep" }),
    );
    let c2 = f.insert_record(&f.table_id, json!({ &lid: [o1] }));
    set_data(&f.app, &o1, json!({ &iid: [c1, c2] }));
    set_data(&f.app, &o2, json!({ &iid: [c1] }));

    trash_record(&f.app, &o1, OLD);
    let stats = purge(&f);
    assert_eq!(stats.records, 1);
    assert_eq!(
        f.record_data(&c1),
        json!({ &lid: [o2], &f.primary_id: "keep" }),
        "only the purged id is removed"
    );
    assert_eq!(
        f.record_data(&c2),
        json!({}),
        "an emptied link cell disappears"
    );
    assert_eq!(f.record_data(&o2), json!({ &iid: [c1] }));

    // purging from the other side works the same way
    trash_record(&f.app, &c1, OLD);
    purge(&f);
    assert_eq!(f.record_data(&o2), json!({}));
}

#[tokio::test]
async fn purging_a_record_cleans_up_through_trashed_link_fields_and_self_links() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let o1 = f.insert_record(&t2id, json!({}));
    let c1 = f.insert_record(&f.table_id, json!({ &lid: [o1] }));
    set_data(&f.app, &o1, json!({ &iid: [c1] }));
    // the link pair is in the trash (not expired yet); restoring it later must not find dangling ids
    f.app
        .delete(&f.owner, &format!("/api/fields/{lid}"))
        .await
        .assert_status(200);
    trash_record(&f.app, &o1, OLD);
    purge(&f);
    assert_eq!(f.record_data(&c1), json!({}));
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "field", "id": lid }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        f.record_data(&c1),
        json!({}),
        "no dangling reference after the restore"
    );

    // self links
    let sl = f.add_link(&f.table_id, "Parent", &f.table_id).await;
    let (pid, pinv) = (
        sid(&sl["id"]).to_string(),
        sid(&sl["inverse"]["id"]).to_string(),
    );
    let a = f.insert_record(&f.table_id, json!({}));
    let b = f.insert_record(&f.table_id, json!({}));
    set_data(&f.app, &a, json!({ &pid: [b] }));
    set_data(&f.app, &b, json!({ &pinv: [a] }));
    trash_record(&f.app, &a, OLD);
    purge(&f);
    assert_eq!(f.record_data(&b), json!({}));
}

#[tokio::test]
async fn purging_a_field_removes_its_key_from_every_record_including_trashed_ones() {
    let f = Fixture::new().await;
    let qty = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let keep = f
        .add_field(
            &f.table_id,
            json!({ "name": "Keep", "type": "number", "options": {} }),
        )
        .await;
    let (q, k) = (sid(&qty["id"]).to_string(), sid(&keep["id"]).to_string());
    let a = f.insert_record(&f.table_id, json!({ &q: 1, &k: 10 }));
    let b = f.insert_record(&f.table_id, json!({ &k: 20 }));
    let dead = f.insert_record(&f.table_id, json!({ &q: 3, &k: 30 }));
    trash_record(&f.app, &dead, RECENT);

    f.app
        .delete(&f.owner, &format!("/api/fields/{q}"))
        .await
        .assert_status(200);
    // not expired yet: data stays so a restore finds it
    purge(&f);
    assert_eq!(f.record_data(&a), json!({ &q: 1, &k: 10 }));

    set_deleted_at(&f.app, "fields", &q, OLD);
    let stats = purge(&f);
    assert_eq!(stats.fields, 1);
    assert_eq!(f.record_data(&a), json!({ &k: 10 }));
    assert_eq!(f.record_data(&b), json!({ &k: 20 }));
    assert_eq!(f.record_data(&dead), json!({ &k: 30 }));
    assert!(!exists(&f, "fields", &q));
    assert_eq!(fk_violations(&f), 0);
}

#[tokio::test]
async fn purging_a_link_pair_strips_both_sides() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let o = f.insert_record(&t2id, json!({}));
    let c = f.insert_record(&f.table_id, json!({ &lid: [o], &f.primary_id: "c" }));
    set_data(&f.app, &o, json!({ &iid: [c] }));
    f.app
        .delete(&f.owner, &format!("/api/fields/{lid}"))
        .await
        .assert_status(200);
    set_deleted_at(&f.app, "fields", &lid, OLD);
    set_deleted_at(&f.app, "fields", &iid, OLD);
    let stats = purge(&f);
    assert_eq!(stats.fields, 2);
    assert_eq!(f.record_data(&c), json!({ &f.primary_id: "c" }));
    assert_eq!(f.record_data(&o), json!({}));
}

#[tokio::test]
async fn purging_a_table_cascades_and_strips_links_pointing_at_it() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let lid = sid(&link["id"]).to_string();
    let o = f.insert_record(&t2id, json!({}));
    let c = f.insert_record(&f.table_id, json!({ &lid: [o], &f.primary_id: "c" }));
    set_data(&f.app, &o, json!({ sid(&link["inverse"]["id"]): [c] }));

    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    // everything trashed by that delete expires together
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE tables SET deleted_at = ?1 WHERE deleted_at IS NOT NULL",
            [OLD],
        )
    });
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE fields SET deleted_at = ?1 WHERE deleted_at IS NOT NULL",
            [OLD],
        )
    });
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO record_history (record_id, table_id, kind, changes, created_at) VALUES (?1, ?2, 'create', '{}', 1)",
            [&o, &t2id],
        )
    });

    let stats = purge(&f);
    assert_eq!(stats.tables, 1);
    assert_eq!(stats.records, 1);
    assert!(!exists(&f, "records", &o));
    assert_eq!(
        count(
            &f.app,
            "SELECT count(*) FROM record_history WHERE table_id = ?1",
            &t2id
        ),
        0
    );
    assert_eq!(
        count(
            &f.app,
            "SELECT count(*) FROM fields WHERE table_id = ?1",
            &t2id
        ),
        0
    );
    assert_eq!(
        count(
            &f.app,
            "SELECT count(*) FROM views WHERE table_id = ?1",
            &t2id
        ),
        0
    );
    // the link field in the surviving table is gone and so are its ids in records
    assert!(!exists(&f, "fields", &lid));
    assert_eq!(f.record_data(&c), json!({ &f.primary_id: "c" }));
    assert_eq!(fk_violations(&f), 0);
}

#[tokio::test]
async fn purging_a_base_and_a_workspace_cascades_everything() {
    let f = Fixture::new().await;
    let rec = f.insert_record(&f.table_id, json!({}));
    f.base_guest("g@example.com", openbase::perm::Role::Viewer);
    sql(&f.app, |tx| {
        tx.execute("INSERT INTO record_history (record_id, table_id, kind, changes, created_at) VALUES (?1, ?2, 'create', '{}', 1)", [&rec, &f.table_id])?;
        tx.execute(
            "INSERT INTO comments (id, record_id, body, created_at, updated_at) VALUES ('comX', ?1, 'hi', 1, 1)",
            [&rec],
        )
        .map(|_| ())
    });

    // a second, surviving workspace must be unaffected
    let other = f.app.user("other@example.com", "Other");
    let ows = workspace(&f.app, &other, "Theirs").await;
    let obase = base(&f.app, &other, &ows, "Theirs base").await;

    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    set_deleted_at(&f.app, "bases", &f.base_id, OLD);
    let stats = purge(&f);
    assert_eq!(stats.bases, 1);
    assert_eq!(stats.tables, 1);
    assert_eq!(stats.records, 1);
    for (table, col) in [
        ("tables", "base_id"),
        ("workspace_member_bases", "base_id"),
        ("invite_bases", "base_id"),
    ] {
        assert_eq!(
            count(
                &f.app,
                &format!("SELECT count(*) FROM {table} WHERE {col} = ?1"),
                &f.base_id
            ),
            0,
            "{table}"
        );
    }
    let comments: i64 = sql(&f.app, |tx| {
        tx.query_row("SELECT count(*) FROM comments WHERE id = 'comX'", [], |r| {
            r.get(0)
        })
    });
    assert_eq!(comments, 0);
    assert_eq!(
        count(
            &f.app,
            "SELECT count(*) FROM record_history WHERE record_id = ?1",
            &rec
        ),
        0
    );
    assert!(exists(&f, "workspaces", &f.ws), "the workspace stays");

    // now the whole workspace
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
        .await
        .assert_status(200);
    set_deleted_at(&f.app, "workspaces", &f.ws, OLD);
    let stats = purge(&f);
    assert_eq!(stats.workspaces, 1);
    assert_eq!(
        count(
            &f.app,
            "SELECT count(*) FROM workspace_members WHERE workspace_id = ?1",
            &f.ws
        ),
        0
    );
    // the unrelated workspace and base are untouched
    assert!(exists(&f, "workspaces", &ows));
    assert!(exists(&f, "bases", sid(&obase["id"])));
    assert_eq!(fk_violations(&f), 0);
}

#[tokio::test]
async fn purging_a_view_clears_link_pickers_that_pointed_at_it() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let v = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{t2id}/views"),
            json!({ "name": "Open", "type": "grid" }),
        )
        .await;
    let vid = sid(&v.body["id"]).to_string();
    let link = f
        .add_field(
            &f.table_id,
            json!({ "name": "Orders", "type": "link", "options": { "linked_table_id": t2id, "picker_view_id": vid } }),
        )
        .await;
    assert_eq!(link["options"]["picker_view_id"], vid.as_str());
    f.app
        .delete(&f.owner, &format!("/api/views/{vid}"))
        .await
        .assert_status(200);
    set_deleted_at(&f.app, "views", &vid, OLD);
    purge(&f);
    let t1 = f.table(&f.table_id).await;
    let now = t1["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "Orders")
        .unwrap();
    assert!(
        now["options"].get("picker_view_id").is_none()
            || now["options"]["picker_view_id"].is_null()
    );
    assert_eq!(now["options"]["linked_table_id"], t2id.as_str());
}

#[tokio::test]
async fn purging_many_records_spans_batches_and_cleans_a_hub_record() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let n = 2500;
    let ids: Vec<String> = (0..n).map(|i| format!("recbulk{i:05}")).collect();
    let hub = f.insert_record(&f.table_id, json!({ &lid: ids }));
    let keeper = f.insert_record(&t2id, json!({ &iid: [hub] }));
    set_data(
        &f.app,
        &hub,
        json!({ &lid: ids.iter().cloned().chain([keeper.clone()]).collect::<Vec<_>>() }),
    );
    {
        let (t2id, iid, hub, ids) = (t2id.clone(), iid.clone(), hub.clone(), ids.clone());
        sql(&f.app, move |tx| {
            for (i, id) in ids.iter().enumerate() {
                tx.execute(
                    "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?4, 1, 1, ?5)",
                    rusqlite::params![id, t2id, json!({ &iid: [hub] }).to_string(), i as i64, OLD],
                )?;
            }
            Ok(())
        });
    }
    let stats = purge(&f);
    assert_eq!(stats.records, n);
    assert_eq!(f.record_data(&hub), json!({ &lid: [keeper] }));
    assert!(exists(&f, "records", &keeper));
}

#[tokio::test]
async fn the_expiry_job_can_run_against_a_real_clock() {
    // The integrator wires purge_expired into the background task with
    // `now - trash_days`; make sure a plausible cutoff purges nothing fresh.
    let f = Fixture::new().await;
    let rec = f.insert_record(&f.table_id, json!({}));
    trash_record(&f.app, &rec, openbase::db::now_ms());
    let cutoff =
        openbase::db::now_ms() - i64::from(f.app.state.config.trash_days) * 24 * 3600 * 1000;
    let stats = f
        .app
        .state
        .db
        .write_sync(|tx| purge_expired(tx, cutoff))
        .unwrap();
    assert_eq!(stats, PurgeStats::default());
    assert!(exists(&f, "records", &rec));
}
