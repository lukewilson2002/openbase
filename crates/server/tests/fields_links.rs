//! Link fields: paired inverse creation, self links, deletion and restoration
//! of pairs, conversions to and from link, table-delete cascades.

mod common;
mod schema_support;

use schema_support::*;
use serde_json::{Value, json};

fn field<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no field named {name} in {:?}", Fixture::field_names(table)))
}

fn has_field(table: &Value, name: &str) -> bool {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["name"] == name)
}

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn restore(f: &Fixture, kind: &str, id: &str) -> common::Response {
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": kind, "id": id }),
        )
        .await
}

#[tokio::test]
async fn link_field_creates_a_paired_inverse_in_the_linked_table() {
    let f = Fixture::new().await;
    let orders = f.add_table("Orders").await;
    let oid = sid(&orders["id"]);
    let link = f
        .add_field(
            &f.table_id,
            json!({ "name": "Orders", "type": "link",
                    "options": { "linked_table_id": oid, "inverse_field_id": "fldBOGUS", "single": true } }),
        )
        .await;
    let inverse = &link["inverse"];
    assert_eq!(link["options"]["linked_table_id"], oid);
    assert_eq!(link["options"]["single"], true);
    assert_eq!(
        link["options"]["inverse_field_id"], inverse["id"],
        "client-sent inverse id is ignored"
    );
    assert_ne!(sid(&link["options"]["inverse_field_id"]), "fldBOGUS");

    assert_eq!(inverse["table_id"], oid);
    assert_eq!(inverse["name"], "Table 1", "named after the source table");
    assert_eq!(inverse["type"], "link");
    assert_eq!(inverse["options"]["linked_table_id"], f.table_id.as_str());
    assert_eq!(inverse["options"]["inverse_field_id"], link["id"]);
    assert_eq!(inverse["options"]["single"], false);

    // both sides are visible in the schema
    let t1 = f.table(&f.table_id).await;
    let t2 = f.table(oid).await;
    assert_eq!(field(&t1, "Orders")["id"], link["id"]);
    assert_eq!(field(&t2, "Table 1")["id"], inverse["id"]);
    assert_eq!(field(&t2, "Table 1")["options"], inverse["options"]);
}

#[tokio::test]
async fn inverse_names_are_taken_from_the_request_and_made_unique() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let mk = |name: &'static str, inv: Option<&'static str>| {
        let mut body =
            json!({ "name": name, "type": "link", "options": { "linked_table_id": t2id } });
        if let Some(i) = inv {
            body["inverse_name"] = json!(i);
        }
        body
    };
    let a = f.add_field(&f.table_id, mk("A", Some("Customer"))).await;
    assert_eq!(a["inverse"]["name"], "Customer");
    let b = f.add_field(&f.table_id, mk("B", Some(" customer "))).await;
    assert_eq!(b["inverse"]["name"], "customer 2");
    let c = f.add_field(&f.table_id, mk("C", None)).await;
    assert_eq!(c["inverse"]["name"], "Table 1");
    let d = f.add_field(&f.table_id, mk("D", Some(""))).await;
    assert_eq!(d["inverse"]["name"], "Table 1 2");
    // an explicit but invalid inverse name is an error
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{}/fields", f.table_id),
            mk("E", Some("bad\nname")),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn self_link_creates_the_inverse_in_the_same_table() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let link = f.add_link(&f.table_id, "Parent", &f.table_id).await;
    let inv = &link["inverse"];
    assert_eq!(inv["table_id"], f.table_id.as_str());
    assert_eq!(inv["name"], "Table 1");
    assert_eq!(inv["options"]["linked_table_id"], f.table_id.as_str());
    assert_eq!(inv["options"]["inverse_field_id"], link["id"]);
    assert_eq!(link["options"]["inverse_field_id"], inv["id"]);
    let t = f.table(&f.table_id).await;
    assert_eq!(
        Fixture::field_names(&t),
        ["Name", "Notes", "Parent", "Table 1"]
    );
    // one table touched => a precise event
    let env = rx.try_recv().unwrap();
    assert_eq!(
        env.event,
        og_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(f.table_id.clone())
        }
    );

    // the inverse's default name must be unique among all the table's fields,
    // including the link just created
    let second = f.add_link(&f.table_id, "Table 1 2", &f.table_id).await;
    assert_eq!(second["inverse"]["name"], "Table 1 3");
}

#[tokio::test]
async fn linking_across_tables_publishes_an_event_for_the_whole_base() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    f.add_link(&f.table_id, "Orders", sid(&t2["id"])).await;
    let env = rx.try_recv().unwrap();
    assert_eq!(
        env.event,
        og_core::api::events::BaseEvent::SchemaChanged { table_id: None }
    );
}

#[tokio::test]
async fn link_targets_are_validated() {
    let f = Fixture::new().await;
    let url = format!("/api/tables/{}/fields", f.table_id);
    let other_base = base(&f.app, &f.owner, &f.ws, "Elsewhere").await;
    let foreign = sid(&other_base["tables"][0]["id"]).to_string();
    let doomed = f.add_table("Doomed").await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", sid(&doomed["id"])))
        .await
        .assert_status(200);
    for target in [foreign.as_str(), "tblNOPE", sid(&doomed["id"])] {
        let r = f
            .app
            .post(
                &f.owner,
                &url,
                json!({ "name": "L", "type": "link", "options": { "linked_table_id": target } }),
            )
            .await;
        r.assert_status(400);
    }
    // nothing was created by the failed attempts
    assert_eq!(
        Fixture::field_names(&f.table(&f.table_id).await),
        ["Name", "Notes"]
    );
}

#[tokio::test]
async fn picker_view_must_be_a_shared_view_of_the_linked_table() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let shared_view = sid(&t2["views"][0]["id"]);
    let own_view = &f.view_id;
    let url = format!("/api/tables/{}/fields", f.table_id);
    let body = |view: &str| json!({ "name": format!("L-{view}"), "type": "link", "options": { "linked_table_id": t2id, "picker_view_id": view } });
    f.app
        .post(&f.owner, &url, body(shared_view))
        .await
        .assert_status(201);
    f.app
        .post(&f.owner, &url, body(own_view))
        .await
        .assert_status(400); // belongs to another table
    f.app
        .post(&f.owner, &url, body("viwNOPE"))
        .await
        .assert_status(400);
    // a personal view cannot be a picker
    let personal = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{t2id}/views"),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    personal.assert_status(201);
    f.app
        .post(&f.owner, &url, body(sid(&personal.body["id"])))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn the_linked_tables_field_limit_is_enforced_atomically() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Full").await;
    let t2id = sid(&t2["id"]).to_string();
    sql(&f.app, |tx| {
        for i in 0..(og_core::limits::MAX_FIELDS_PER_TABLE - 1) {
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, ?3, 'number', '{}', ?4, 1)",
                rusqlite::params![
                    format!("fldfull{i}"),
                    t2id,
                    format!("F{i}"),
                    10.0 + i as f64
                ],
            )?;
        }
        Ok(())
    });
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/fields", f.table_id),
            json!({ "name": "L", "type": "link", "options": { "linked_table_id": sid(&t2["id"]) } }),
        )
        .await;
    r.assert_status(400);
    assert_eq!(
        Fixture::field_names(&f.table(&f.table_id).await),
        ["Name", "Notes"],
        "no half-created pair"
    );
}

#[tokio::test]
async fn deleting_a_link_field_removes_the_inverse_and_restoring_brings_both_back() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let link = f.add_link(&f.table_id, "Orders", t2id).await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );

    let r = f.app.delete(&f.owner, &format!("/api/fields/{lid}")).await;
    r.assert_status(200);
    let mut deleted: Vec<String> = r.body["deleted_field_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| sid(v).to_string())
        .collect();
    deleted.sort();
    let mut expect = vec![lid.clone(), iid.clone()];
    expect.sort();
    assert_eq!(deleted, expect);
    assert!(!has_field(&f.table(&f.table_id).await, "Orders"));
    assert!(!has_field(&f.table(t2id).await, "Table 1"));

    // the trash lists the pair once
    let trash = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/trash", f.base_id))
        .await;
    let fields: Vec<&Value> = trash.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "field")
        .collect();
    assert_eq!(fields.len(), 1);

    // restoring either side restores both
    let r = restore(&f, "field", &iid).await;
    r.assert_status(200);
    let mut restored: Vec<String> = r.body["restored_field_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| sid(v).to_string())
        .collect();
    restored.sort();
    assert_eq!(restored, expect);
    let t1 = f.table(&f.table_id).await;
    let t2 = f.table(t2id).await;
    assert_eq!(
        field(&t1, "Orders")["options"]["inverse_field_id"],
        iid.as_str()
    );
    assert_eq!(
        field(&t2, "Table 1")["options"]["inverse_field_id"],
        lid.as_str()
    );

    // restoring something that is not in the trash is a conflict
    restore(&f, "field", &lid).await.assert_status(409);
}

#[tokio::test]
async fn restoring_a_field_with_a_taken_name_adds_a_suffix() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let link = f.add_link(&f.table_id, "Orders", t2id).await;
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&link["id"])))
        .await
        .assert_status(200);
    // the names "Orders" (in T1) and "Table 1" (in T2) get taken meanwhile
    f.add_field(
        &f.table_id,
        json!({ "name": "orders", "type": "number", "options": {} }),
    )
    .await;
    f.add_field(
        t2id,
        json!({ "name": "Table 1", "type": "number", "options": {} }),
    )
    .await;
    restore(&f, "field", sid(&link["id"]))
        .await
        .assert_status(200);
    assert!(has_field(&f.table(&f.table_id).await, "Orders (restored)"));
    assert!(has_field(&f.table(t2id).await, "Table 1 (restored)"));
    // a second delete/restore round keeps counting
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&link["id"])))
        .await
        .assert_status(200);
    restore(&f, "field", sid(&link["id"]))
        .await
        .assert_status(200);
    assert!(has_field(&f.table(&f.table_id).await, "Orders (restored)"));
}

#[tokio::test]
async fn deleting_a_table_hides_links_pointing_at_it_and_restore_brings_them_back() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &t2id).await;
    let count = f
        .add_field(&f.table_id, json!({ "name": "How many", "type": "count", "options": { "link_field_id": link["id"] } }))
        .await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);

    let t1 = f.table(&f.table_id).await;
    assert!(
        !has_field(&t1, "Orders"),
        "link to a trashed table is trashed with it"
    );
    assert!(!has_field(&t1, "How many"), "and so are fields built on it");
    assert_eq!(Fixture::field_names(&t1), ["Name", "Notes"]);

    // restoring the dangling link alone is refused: the table comes first
    restore(&f, "field", sid(&link["id"]))
        .await
        .assert_status(409);

    restore(&f, "table", &t2id).await.assert_status(200);
    let t1 = f.table(&f.table_id).await;
    assert_eq!(
        Fixture::field_names(&t1),
        ["Name", "Notes", "Orders", "How many"]
    );
    assert_eq!(field(&t1, "How many")["id"], count["id"]);
    let t2 = f.table(&t2id).await;
    assert_eq!(
        field(&t2, "Table 1")["options"]["inverse_field_id"],
        link["id"]
    );
}

#[tokio::test]
async fn converting_a_link_to_another_type_removes_the_inverse() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let link = f.add_link(&f.table_id, "Orders", t2id).await;
    let iid = sid(&link["inverse"]["id"]).to_string();
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&link["id"])),
            json!({ "type": "single_line_text", "options": {} }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["type"], "single_line_text");
    assert_eq!(r.body["removed_field_ids"], json!([iid]));
    assert!(!has_field(&f.table(t2id).await, "Table 1"));
    assert_eq!(
        field(&f.table(&f.table_id).await, "Orders")["type"],
        "single_line_text"
    );

    // the orphaned inverse is not offered in the trash and cannot be restored
    let trash = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/trash", f.base_id))
        .await;
    assert!(
        trash.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["id"] != iid.as_str())
    );
    restore(&f, "field", &iid).await.assert_status(409);
}

#[tokio::test]
async fn converting_a_field_to_a_link_drops_its_values_and_creates_the_inverse() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let text = f
        .add_field(
            &f.table_id,
            json!({ "name": "Ref", "type": "single_line_text", "options": {} }),
        )
        .await;
    let tid = sid(&text["id"]);
    let rec = f.insert_record(&f.table_id, json!({ tid: "ORD-1", &f.primary_id: "a" }));
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{tid}"),
            json!({ "type": "link", "options": { "linked_table_id": t2id } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["type"], "link");
    assert_eq!(r.body["options"]["linked_table_id"], t2id);
    let inv = &r.body["inverse"];
    assert_eq!(inv["table_id"], t2id);
    assert_eq!(inv["options"]["inverse_field_id"], tid);
    assert_eq!(r.body["options"]["inverse_field_id"], inv["id"]);
    assert_eq!(
        f.record_data(&rec),
        json!({ &f.primary_id: "a" }),
        "text values do not survive"
    );
    assert!(has_field(&f.table(t2id).await, "Table 1"));
}

#[tokio::test]
async fn relinking_to_another_table_replaces_the_inverse() {
    let f = Fixture::new().await;
    let a = f.add_table("A").await;
    let b = f.add_table("B").await;
    let (aid, bid) = (sid(&a["id"]), sid(&b["id"]));
    let link = f.add_link(&f.table_id, "Rel", aid).await;
    let old_inverse = sid(&link["inverse"]["id"]).to_string();
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&link["id"])),
            json!({ "type": "link", "options": { "linked_table_id": bid } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["removed_field_ids"], json!([old_inverse]));
    assert_eq!(r.body["inverse"]["table_id"], bid);
    assert_ne!(r.body["inverse"]["id"], old_inverse.as_str());
    assert!(!has_field(&f.table(aid).await, "Table 1"));
    assert!(has_field(&f.table(bid).await, "Table 1"));
}

#[tokio::test]
async fn editing_link_options_keeps_the_pair() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let link = f.add_link(&f.table_id, "Orders", t2id).await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&link["id"])),
            json!({ "type": "link", "options": { "linked_table_id": t2id, "single": true, "inverse_field_id": "fldIGNORED" } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["options"]["single"], true);
    assert_eq!(r.body["options"]["inverse_field_id"], link["inverse"]["id"]);
    assert_eq!(r.body["inverse"]["id"], link["inverse"]["id"]);
    assert!(r.body.get("removed_field_ids").is_none());
}

#[tokio::test]
async fn renaming_a_link_field_does_not_touch_its_inverse() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Orders").await;
    let t2id = sid(&t2["id"]);
    let link = f.add_link(&f.table_id, "Orders", t2id).await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&link["id"])),
            json!({ "name": "Purchases" }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["inverse"]["name"], "Table 1");
    assert_eq!(r.body["options"]["inverse_field_id"], link["inverse"]["id"]);
}
