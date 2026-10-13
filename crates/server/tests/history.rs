//! `GET /api/records/{id}/history`: newest first, paged by entry id, with the
//! names of the users who made the changes.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use opengrid::perm::Role;
use query_support::*;
use serde_json::{Value, json};

fn url(record_id: &str) -> String {
    format!("/api/records/{record_id}/history")
}

async fn history_of(f: &Fixture, record_id: &str, query: &str) -> Vec<Value> {
    let r = f
        .app
        .get(&f.owner, &format!("{}{query}", url(record_id)))
        .await;
    r.assert_status(200);
    r.body.as_array().unwrap().clone()
}

#[tokio::test]
async fn lists_changes_newest_first_with_user_names() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "v1" })).await;
    let id = id_str(&rec["id"]);
    f.set(&f.table_id, &id, json!({ &f.primary_id: "v2" }))
        .await;
    f.set(
        &f.table_id,
        &id,
        json!({ &f.primary_id: "v3", &f.notes_id: "hello" }),
    )
    .await;
    let h = history_of(&f, &id, "").await;
    assert_eq!(h.len(), 3);
    let kinds: Vec<&str> = h.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["update", "update", "create"]);
    // Newest first: ids and times never increase going down.
    let ids: Vec<i64> = h.iter().map(|e| e["id"].as_i64().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] > w[1]));
    assert!(h[0]["created_at"].as_i64().unwrap() >= h[2]["created_at"].as_i64().unwrap());
    assert_eq!(h[0]["user_id"], f.owner.user_id.clone().unwrap());
    assert_eq!(h[0]["user_name"], "Owner");
    assert_eq!(
        h[0]["changes"][&f.primary_id],
        json!({ "old": "v2", "new": "v3" })
    );
    assert_eq!(
        h[0]["changes"][&f.notes_id],
        json!({ "old": null, "new": "hello" })
    );
    assert_eq!(h[2]["changes"][&f.primary_id]["new"], "v1");
}

#[tokio::test]
async fn delete_and_restore_are_part_of_the_history() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    let id = id_str(&rec["id"]);
    f.delete_records(&f.table_id, &[&id])
        .await
        .assert_status(204);
    // A trashed record's history stays readable (you can see why it was deleted).
    let h = history_of(&f, &id, "").await;
    assert_eq!(h[0]["kind"], "delete");
    f.restore_records(&f.table_id, &[&id])
        .await
        .assert_status(200);
    let kinds: Vec<String> = history_of(&f, &id, "")
        .await
        .iter()
        .map(|e| e["kind"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(kinds, ["restore", "delete", "create"]);
}

#[tokio::test]
async fn deleted_users_leave_entries_without_a_name() {
    let f = Fixture::new().await;
    let editor = f.member("editor-user@example.com", Role::Editor);
    let rec = f
        .create_as(&editor, &f.table_id, json!({ &f.primary_id: "x" }))
        .await;
    rec.assert_status(201);
    let id = id_str(&rec.body["records"][0]["id"]);
    let h = history_of(&f, &id, "").await;
    assert_eq!(h[0]["user_name"], "editor-user@example.com");
    let uid = editor.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE record_history SET user_id = NULL WHERE user_id = ?1",
            [&uid],
        )
    });
    let h = history_of(&f, &id, "").await;
    assert_eq!(h[0]["user_id"], Value::Null);
    assert_eq!(h[0]["user_name"], Value::Null);
}

#[tokio::test]
async fn pages_with_before_and_limit() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "0" })).await;
    let id = id_str(&rec["id"]);
    for i in 1..=9 {
        f.set(&f.table_id, &id, json!({ &f.primary_id: i.to_string() }))
            .await;
    }
    // 10 entries in all: "9" down to "0" (create).
    let page1 = history_of(&f, &id, "?limit=4").await;
    assert_eq!(page1.len(), 4);
    assert_eq!(page1[0]["changes"][&f.primary_id]["new"], "9");
    let cursor = page1[3]["id"].as_i64().unwrap();
    let page2 = history_of(&f, &id, &format!("?limit=4&before={cursor}")).await;
    assert_eq!(page2.len(), 4);
    assert_eq!(page2[0]["changes"][&f.primary_id]["new"], "5");
    let cursor = page2[3]["id"].as_i64().unwrap();
    let page3 = history_of(&f, &id, &format!("?limit=4&before={cursor}")).await;
    assert_eq!(page3.len(), 2);
    assert_eq!(page3[1]["kind"], "create");
    let cursor = page3[1]["id"].as_i64().unwrap();
    assert!(
        history_of(&f, &id, &format!("?before={cursor}"))
            .await
            .is_empty()
    );
    // No page repeats an entry.
    let mut all: Vec<i64> = [page1, page2, page3]
        .concat()
        .iter()
        .map(|e| e["id"].as_i64().unwrap())
        .collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), 10);
}

#[tokio::test]
async fn default_and_maximum_page_sizes() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "0" })).await;
    let id = id_str(&rec["id"]);
    // Cheap bulk history: insert rows directly.
    let rid = id.clone();
    let tid = f.table_id.clone();
    sql(&f.app, |tx| {
        for i in 0..250 {
            tx.execute(
                "INSERT INTO record_history (record_id, table_id, kind, changes, created_at)
                 VALUES (?1, ?2, 'update', '{}', ?3)",
                rusqlite::params![rid, tid, i],
            )?;
        }
        Ok(())
    });
    assert_eq!(history_of(&f, &id, "").await.len(), 50);
    assert_eq!(history_of(&f, &id, "?limit=120").await.len(), 120);
    assert_eq!(history_of(&f, &id, "?limit=100000").await.len(), 200);
    // A zero limit is raised to one rather than returning nothing forever.
    assert_eq!(history_of(&f, &id, "?limit=0").await.len(), 1);
}

#[tokio::test]
async fn history_of_other_records_is_not_mixed_in() {
    let f = Fixture::new().await;
    let a = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "a" })).await["id"]);
    let b = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "b" })).await["id"]);
    f.set(&f.table_id, &a, json!({ &f.primary_id: "a2" })).await;
    assert_eq!(history_of(&f, &a, "").await.len(), 2);
    assert_eq!(history_of(&f, &b, "").await.len(), 1);
}

#[tokio::test]
async fn history_permissions_and_errors() {
    let f = Fixture::new().await;
    let id = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "a" })).await["id"]);
    let viewer = f.member("viewer-user@example.com", Role::Viewer);
    f.app.get(&viewer, &url(&id)).await.assert_status(200);
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    f.app.get(&guest, &url(&id)).await.assert_status(200);
    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app.get(&stranger, &url(&id)).await.assert_status(404);
    f.app.get(&f.app.anon(), &url(&id)).await.assert_status(401);
    f.app
        .get(&f.owner, &url("recNope"))
        .await
        .assert_status(404);
    let r = f
        .app
        .get(&f.owner, &format!("{}?before=abc", url(&id)))
        .await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
    // Read-only API tokens may read history.
    let ro = token_client(&f.app, &f.owner, false);
    f.app.get(&ro, &url(&id)).await.assert_status(200);
}

#[tokio::test]
async fn link_changes_show_up_on_both_records() {
    let f = Fixture::new().await;
    let other = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&f.table_id, "Orders", &other).await;
    let link_id = link["id"].as_str().unwrap().to_string();
    let inverse = link["inverse"]["id"].as_str().unwrap().to_string();
    let o_primary = id_str(&f.table(&other).await["primary_field_id"]);
    let order = id_str(&f.create(&other, json!({ &o_primary: "o1" })).await["id"]);
    let cust = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "c1" })).await["id"]);
    f.set(&f.table_id, &cust, json!({ &link_id: [order] }))
        .await;
    let h = history_of(&f, &cust, "").await;
    assert_eq!(
        h[0]["changes"][&link_id]["new"],
        json!([{ "id": order, "name": "o1" }])
    );
    assert_eq!(h[0]["changes"][&link_id]["old"], Value::Null);
    let h = history_of(&f, &order, "").await;
    assert_eq!(h[0]["kind"], "update");
    assert_eq!(
        h[0]["changes"][&inverse]["new"],
        json!([{ "id": cust, "name": "c1" }])
    );
}

#[tokio::test]
async fn link_values_in_history_carry_names_resolved_when_read() {
    let f = Fixture::new().await;
    let other = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&f.table_id, "Orders", &other).await;
    let link_id = link["id"].as_str().unwrap().to_string();
    let o_primary = id_str(&f.table(&other).await["primary_field_id"]);
    let o1 = id_str(&f.create(&other, json!({ &o_primary: "o1" })).await["id"]);
    let o2 = id_str(&f.create(&other, json!({ &o_primary: "o2" })).await["id"]);
    let cust = id_str(&f.create(&f.table_id, json!({ &f.primary_id: "c1" })).await["id"]);
    f.set(&f.table_id, &cust, json!({ &link_id: [o1] })).await;
    f.set(
        &f.table_id,
        &cust,
        json!({ &link_id: [o1, o2], &f.notes_id: "n" }),
    )
    .await;
    f.set(&f.table_id, &cust, json!({ &link_id: [o2] })).await;

    let h = history_of(&f, &cust, "").await;
    assert_eq!(h.len(), 4, "create + 3 updates");
    // Newest first: [o1, o2] -> [o2]; both sides are lists of {id, name}.
    assert_eq!(
        h[0]["changes"][&link_id],
        json!({ "old": [{ "id": o1, "name": "o1" }, { "id": o2, "name": "o2" }],
                "new": [{ "id": o2, "name": "o2" }] })
    );
    // Non-link fields keep their stored value.
    assert_eq!(h[1]["changes"][&f.notes_id]["new"], "n");
    // The oldest entry (the create) has no link change.
    assert!(h[3]["changes"].get(&link_id).is_none());

    // Names are the *current* primary text of the linked record.
    f.set(&other, &o1, json!({ &o_primary: "renamed" })).await;
    let h = history_of(&f, &cust, "").await;
    assert_eq!(h[0]["changes"][&link_id]["old"][0]["name"], "renamed");
    assert_eq!(h[2]["changes"][&link_id]["new"][0]["name"], "renamed");

    // A trashed linked record is shown by id.
    f.delete_records(&other, &[&o1]).await.assert_status(204);
    let h = history_of(&f, &cust, "").await;
    assert_eq!(
        h[0]["changes"][&link_id]["old"],
        json!([{ "id": o1, "name": o1 }, { "id": o2, "name": "o2" }])
    );
    // ... and so is one that was purged for good.
    schema_support::sql(&f.app, |tx| {
        tx.execute("DELETE FROM records WHERE id = ?1", [&o1])
    });
    let h = history_of(&f, &cust, "").await;
    assert_eq!(
        h[0]["changes"][&link_id]["old"][0],
        json!({ "id": o1, "name": o1 })
    );

    // Paging resolves too.
    let page = history_of(&f, &cust, "?limit=1").await;
    assert_eq!(page.len(), 1);
    assert_eq!(
        page[0]["changes"][&link_id]["new"],
        json!([{ "id": o2, "name": "o2" }])
    );
}
