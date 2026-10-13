//! Trash: listing and restoring tables, fields, views, records, bases and
//! workspaces, with the permission rules for each.

mod common;
mod schema_support;

use opengrid::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn trash(f: &Fixture, c: &common::Client) -> common::Response {
    f.app
        .get(c, &format!("/api/bases/{}/trash", f.base_id))
        .await
}

async fn restore(f: &Fixture, c: &common::Client, kind: &str, id: &str) -> common::Response {
    f.app
        .post(c, "/api/trash/restore", json!({ "kind": kind, "id": id }))
        .await
}

fn items(r: &common::Response) -> Vec<(String, String, String)> {
    r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                sid(&i["kind"]).to_string(),
                sid(&i["id"]).to_string(),
                sid(&i["name"]).to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn trash_lists_tables_fields_views_and_records_newest_first() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = sid(&t2["id"]).to_string();
    let field = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let view = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Board", "type": "kanban" }),
        )
        .await;
    view.assert_status(201);
    let rec_text = f.insert_record(&f.table_id, json!({ &f.primary_id: "Alice" }));
    let rec_num = f.insert_record(&f.table_id, json!({ &f.primary_id: 42 }));
    let rec_none = f.insert_record(&f.table_id, json!({}));

    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&field["id"])))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/views/{}", sid(&view.body["id"])))
        .await
        .assert_status(200);
    for r in [&rec_text, &rec_num, &rec_none] {
        trash_record(&f.app, r, 1);
    }
    // deterministic ordering regardless of timer resolution
    set_deleted_at(&f.app, "tables", &t2id, 5_000);
    set_deleted_at(&f.app, "fields", sid(&field["id"]), 4_000);
    set_deleted_at(&f.app, "views", sid(&view.body["id"]), 3_000);
    set_deleted_at(&f.app, "records", &rec_text, 2_000);
    set_deleted_at(&f.app, "records", &rec_num, 1_500);
    set_deleted_at(&f.app, "records", &rec_none, 1_000);

    let r = trash(&f, &f.owner).await;
    r.assert_status(200);
    assert_eq!(
        items(&r),
        [
            ("table".to_string(), t2id.clone(), "Second".to_string()),
            (
                "field".to_string(),
                sid(&field["id"]).to_string(),
                "Qty".to_string()
            ),
            (
                "view".to_string(),
                sid(&view.body["id"]).to_string(),
                "Board".to_string()
            ),
            ("record".to_string(), rec_text.clone(), "Alice".to_string()),
            ("record".to_string(), rec_num.clone(), "42".to_string()),
            ("record".to_string(), rec_none.clone(), String::new()),
        ]
    );
    let first = &r.body["items"][0];
    assert!(first["table_id"].is_null());
    assert_eq!(first["deleted_at"], 5_000);
    assert_eq!(r.body["items"][1]["table_id"], f.table_id.as_str());
    assert_eq!(r.body["items"][3]["table_id"], f.table_id.as_str());
}

#[tokio::test]
async fn trash_hides_other_peoples_personal_views_and_records_of_trashed_tables() {
    let f = Fixture::new().await;
    let ed = f.member("ed@example.com", Role::Editor);
    let mine = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    let theirs = f
        .app
        .post(
            &ed,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Theirs", "type": "grid", "personal": true }),
        )
        .await;
    f.app
        .delete(&f.owner, &format!("/api/views/{}", sid(&mine.body["id"])))
        .await
        .assert_status(200);
    f.app
        .delete(&ed, &format!("/api/views/{}", sid(&theirs.body["id"])))
        .await
        .assert_status(200);
    let names: Vec<String> = items(&trash(&f, &f.owner).await)
        .into_iter()
        .map(|i| i.2)
        .collect();
    assert_eq!(names, ["Mine"]);

    // records of a trashed table are covered by the table entry, not listed separately
    let t2 = f.add_table("Second").await;
    let t2id = sid(&t2["id"]).to_string();
    let rec = f.insert_record(&t2id, json!({}));
    trash_record(&f.app, &rec, 1);
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    let kinds: Vec<String> = items(&trash(&f, &f.owner).await)
        .into_iter()
        .map(|i| i.0)
        .collect();
    assert!(!kinds.contains(&"record".to_string()));
}

#[tokio::test]
async fn at_most_a_thousand_trashed_records_are_listed() {
    let f = Fixture::new().await;
    let table = f.table_id.clone();
    sql(&f.app, |tx| {
        for i in 0..1100 {
            tx.execute(
                "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at, deleted_at)
                 VALUES (?1, ?2, '{}', ?3, ?3, 1, 1, ?3)",
                rusqlite::params![format!("recdead{i:05}"), table, i],
            )?;
        }
        Ok(())
    });
    let r = trash(&f, &f.owner).await;
    assert_eq!(r.body["items"].as_array().unwrap().len(), 1000);
    assert_eq!(r.body["items"][0]["id"], "recdead01099", "newest first");
}

#[tokio::test]
async fn listing_the_trash_requires_creator() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.base_guest("g@example.com", role);
        let r = trash(&f, &u).await;
        assert_eq!(
            r.status.as_u16(),
            if role >= Role::Creator { 200 } else { 403 },
            "{role:?}"
        );
    }
    let f = Fixture::new().await;
    let outsider = f.app.user("o@example.com", "O");
    trash(&f, &outsider).await.assert_status(404);
}

#[tokio::test]
async fn restoring_a_table_brings_back_its_fields_views_and_data() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = sid(&t2["id"]).to_string();
    let extra = f
        .add_field(
            &t2id,
            json!({ "name": "Extra", "type": "number", "options": {} }),
        )
        .await;
    let rec = f.insert_record(&t2id, json!({ sid(&extra["id"]): 9 }));
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    assert_eq!(f.schema().await["tables"].as_array().unwrap().len(), 1);

    let r = restore(&f, &f.owner, "table", &t2id).await;
    r.assert_status(200);
    let t = f.table(&t2id).await;
    assert_eq!(Fixture::field_names(&t), ["Name", "Extra"]);
    assert_eq!(t["views"].as_array().unwrap().len(), 1);
    assert_eq!(f.record_data(&rec), json!({ sid(&extra["id"]): 9 }));
    assert!(items(&trash(&f, &f.owner).await).is_empty());
    // not in the trash any more
    restore(&f, &f.owner, "table", &t2id)
        .await
        .assert_status(409);
}

#[tokio::test]
async fn restoring_a_table_whose_name_was_reused_adds_a_suffix() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = sid(&t2["id"]).to_string();
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    f.add_table("second").await;
    restore(&f, &f.owner, "table", &t2id)
        .await
        .assert_status(200);
    let names: Vec<String> = f.schema().await["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| sid(&t["name"]).to_string())
        .collect();
    assert_eq!(names.len(), 3);
    assert!(
        names.contains(&"Second (restored)".to_string()),
        "{names:?}"
    );
}

#[tokio::test]
async fn restoring_views_and_records() {
    let f = Fixture::new().await;
    let v = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Board", "type": "kanban" }),
        )
        .await;
    let vid = sid(&v.body["id"]).to_string();
    f.app
        .delete(&f.owner, &format!("/api/views/{vid}"))
        .await
        .assert_status(200);
    assert_eq!(
        f.table(&f.table_id).await["views"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    restore(&f, &f.owner, "view", &vid).await.assert_status(200);
    assert_eq!(
        f.table(&f.table_id).await["views"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    restore(&f, &f.owner, "view", &vid).await.assert_status(409);

    let rec = f.insert_record(&f.table_id, json!({ &f.primary_id: "x" }));
    restore(&f, &f.owner, "record", &rec)
        .await
        .assert_status(409); // not deleted
    trash_record(&f.app, &rec, 7);
    restore(&f, &f.owner, "record", &rec)
        .await
        .assert_status(200);
    let deleted: Option<i64> = sql(&f.app, |tx| {
        tx.query_row(
            "SELECT deleted_at FROM records WHERE id = ?1",
            [&rec],
            |r| r.get(0),
        )
    });
    assert_eq!(deleted, None);
    assert_eq!(f.record_data(&rec), json!({ &f.primary_id: "x" }));
}

#[tokio::test]
async fn items_inside_a_trashed_table_cannot_be_restored_on_their_own() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = sid(&t2["id"]).to_string();
    let field = f
        .add_field(
            &t2id,
            json!({ "name": "Extra", "type": "number", "options": {} }),
        )
        .await;
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&field["id"])))
        .await
        .assert_status(200);
    let v = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{t2id}/views"),
            json!({ "name": "Board", "type": "grid" }),
        )
        .await;
    f.app
        .delete(&f.owner, &format!("/api/views/{}", sid(&v.body["id"])))
        .await
        .assert_status(200);
    let rec = f.insert_record(&t2id, json!({}));
    trash_record(&f.app, &rec, 7);
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);

    restore(&f, &f.owner, "field", sid(&field["id"]))
        .await
        .assert_status(409);
    restore(&f, &f.owner, "view", sid(&v.body["id"]))
        .await
        .assert_status(409);
    restore(&f, &f.owner, "record", &rec)
        .await
        .assert_status(409);
    restore(&f, &f.owner, "table", &t2id)
        .await
        .assert_status(200);
    restore(&f, &f.owner, "field", sid(&field["id"]))
        .await
        .assert_status(200);
    restore(&f, &f.owner, "view", sid(&v.body["id"]))
        .await
        .assert_status(200);
    restore(&f, &f.owner, "record", &rec)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn bases_and_workspaces_restore_in_order() {
    let f = Fixture::new().await;
    let base_path = format!("/api/bases/{}", f.base_id);
    f.app.delete(&f.owner, &base_path).await.assert_status(200);

    // workspace trash lists the base
    let wt = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/trash", f.ws))
        .await;
    wt.assert_status(200);
    assert_eq!(
        items(&wt),
        [("base".to_string(), f.base_id.clone(), "CRM".to_string())]
    );

    // delete the workspace too: the base cannot come back first
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
        .await
        .assert_status(200);
    let r = restore(&f, &f.owner, "base", &f.base_id).await;
    r.assert_status(409);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("workspace")
    );
    restore(&f, &f.owner, "workspace", &f.ws)
        .await
        .assert_status(200);
    restore(&f, &f.owner, "workspace", &f.ws)
        .await
        .assert_status(409);
    restore(&f, &f.owner, "base", &f.base_id)
        .await
        .assert_status(200);
    f.app.get(&f.owner, &base_path).await.assert_status(200);
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    assert_eq!(list.body[0]["bases"][0]["id"], f.base_id.as_str());
    // everything inside came back untouched
    assert_eq!(
        Fixture::field_names(&f.table(&f.table_id).await),
        ["Name", "Notes"]
    );
}

#[tokio::test]
async fn restore_publishes_events() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", sid(&t2["id"])))
        .await
        .assert_status(200);
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    restore(&f, &f.owner, "table", sid(&t2["id"]))
        .await
        .assert_status(200);
    assert_eq!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(sid(&t2["id"]).to_string())
        }
    );
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    let _ = rx.try_recv();
    restore(&f, &f.owner, "base", &f.base_id)
        .await
        .assert_status(200);
    assert_eq!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::BaseChanged
    );
}

#[tokio::test]
async fn restore_request_validation() {
    let f = Fixture::new().await;
    restore(&f, &f.owner, "gizmo", "x").await.assert_status(400);
    restore(&f, &f.owner, "table", "tblNOPE")
        .await
        .assert_status(404);
    restore(&f, &f.owner, "field", "fldNOPE")
        .await
        .assert_status(404);
    restore(&f, &f.owner, "view", "viwNOPE")
        .await
        .assert_status(404);
    restore(&f, &f.owner, "record", "recNOPE")
        .await
        .assert_status(404);
    restore(&f, &f.owner, "base", "appNOPE")
        .await
        .assert_status(404);
    restore(&f, &f.owner, "workspace", "wspNOPE")
        .await
        .assert_status(404);
    f.app
        .post(&f.owner, "/api/trash/restore", json!({ "kind": "table" }))
        .await
        .assert_status(400);
    // live items are not in the trash
    restore(&f, &f.owner, "table", &f.table_id)
        .await
        .assert_status(409);
    restore(&f, &f.owner, "field", &f.notes_id)
        .await
        .assert_status(409);
    restore(&f, &f.owner, "base", &f.base_id)
        .await
        .assert_status(409);
    restore(&f, &f.owner, "workspace", &f.ws)
        .await
        .assert_status(409);
}

#[tokio::test]
async fn role_matrix_for_restoring_items_inside_a_base() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let t2 = f.add_table("Second").await;
        let t2id = sid(&t2["id"]).to_string();
        let field = f
            .add_field(
                &f.table_id,
                json!({ "name": "Qty", "type": "number", "options": {} }),
            )
            .await;
        f.app
            .delete(&f.owner, &format!("/api/tables/{t2id}"))
            .await
            .assert_status(200);
        f.app
            .delete(&f.owner, &format!("/api/fields/{}", sid(&field["id"])))
            .await
            .assert_status(200);
        let u = f.base_guest("g@example.com", role);
        let expect = if role >= Role::Creator { 200 } else { 403 };
        assert_eq!(
            restore(&f, &u, "table", &t2id).await.status.as_u16(),
            expect,
            "table {role:?}"
        );
        assert_eq!(
            restore(&f, &u, "field", sid(&field["id"]))
                .await
                .status
                .as_u16(),
            expect,
            "field {role:?}"
        );
    }
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", sid(&t2["id"])))
        .await
        .assert_status(200);
    let outsider = f.app.user("o@example.com", "O");
    restore(&f, &outsider, "table", sid(&t2["id"]))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn base_and_workspace_restore_need_owner_and_a_session() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.member("m@example.com", role);
        f.app
            .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
            .await
            .assert_status(200);
        let expect = if role == Role::Owner { 200 } else { 403 };
        assert_eq!(
            restore(&f, &u, "base", &f.base_id).await.status.as_u16(),
            expect,
            "base {role:?}"
        );
        f.app
            .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
            .await
            .assert_status(200);
        assert_eq!(
            restore(&f, &u, "workspace", &f.ws).await.status.as_u16(),
            expect,
            "workspace {role:?}"
        );
    }
    let f = Fixture::new().await;
    // a base-level owner may restore the base but not touch the workspace
    let guest = f.base_guest("guest@example.com", Role::Owner);
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    restore(&f, &guest, "base", &f.base_id)
        .await
        .assert_status(200);
    // tokens cannot restore bases or workspaces
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    let token = token_client(&f.app, &f.owner, true);
    restore(&f, &token, "base", &f.base_id)
        .await
        .assert_status(403);
    restore(&f, &token, "workspace", &f.ws)
        .await
        .assert_status(403);
    // outsiders learn nothing
    let outsider = f.app.user("o@example.com", "O");
    restore(&f, &outsider, "base", &f.base_id)
        .await
        .assert_status(404);
    restore(&f, &outsider, "workspace", &f.ws)
        .await
        .assert_status(404);
    f.app
        .get(&outsider, &format!("/api/workspaces/{}/trash", f.ws))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn workspace_trash_requires_owner() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.member("m@example.com", role);
        let r = f
            .app
            .get(&u, &format!("/api/workspaces/{}/trash", f.ws))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if role == Role::Owner { 200 } else { 403 },
            "{role:?}"
        );
    }
}

#[tokio::test]
async fn personal_views_are_restored_by_their_owner_only() {
    let f = Fixture::new().await;
    let ed = f.member("ed@example.com", Role::Editor);
    let ed2 = f.member("ed2@example.com", Role::Editor);
    let v = f
        .app
        .post(
            &ed,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    let vid = sid(&v.body["id"]).to_string();
    f.app
        .delete(&ed, &format!("/api/views/{vid}"))
        .await
        .assert_status(200);
    restore(&f, &ed2, "view", &vid).await.assert_status(404);
    restore(&f, &f.owner, "view", &vid).await.assert_status(404);
    restore(&f, &ed, "view", &vid).await.assert_status(200);
    // and it is still theirs alone
    let names: Vec<String> = f.table(&f.table_id).await["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| sid(&v["name"]).to_string())
        .collect();
    assert_eq!(
        names,
        ["Grid view"],
        "the owner's schema view does not show another user's personal view"
    );
}
