//! Duplicating a table inside its base: schema, views, records, and what
//! happens to links that point at other tables (new inverse fields over
//! there, with both sides of every record link kept in step).

mod common;
mod schema_support;

use std::collections::HashSet;

use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn table<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("no table {name}"))
}

fn field<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no field {name} in {:?}", Fixture::field_names(table)))
}

async fn duplicate_table(r: &Rich, table_id: &str, body: Value) -> common::Response {
    r.f.app
        .post(
            &r.f.owner,
            &format!("/api/tables/{table_id}/duplicate"),
            body,
        )
        .await
}

#[tokio::test]
async fn copy_of_a_table_with_links_gets_new_inverses_and_consistent_records() {
    let r = rich_base().await;
    let before_schema = r.f.schema().await;
    let before_records = dump_records(&r.f.app, &r.f.base_id);

    let res = duplicate_table(&r, &r.t1, json!({})).await;
    res.assert_status(201);
    let copy = &res.body;
    assert_eq!(copy["name"], "Table 1 copy");
    assert_eq!(copy["base_id"], r.f.base_id.as_str());
    assert_ne!(copy["id"], r.t1.as_str());

    // same fields, fresh ids, primary mapped
    let schema = r.f.schema().await;
    let t1 = table(&schema, "Table 1");
    assert_eq!(Fixture::field_names(copy), Fixture::field_names(t1));
    let old_ids: HashSet<&str> = t1["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| sid(&f["id"]))
        .collect();
    assert!(
        copy["fields"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| !old_ids.contains(sid(&f["id"])))
    );
    assert_eq!(copy["primary_field_id"], field(copy, "Name")["id"]);
    // select choices are fresh too
    assert_ne!(
        field(copy, "Status")["options"]["choices"][0]["id"],
        field(t1, "Status")["options"]["choices"][0]["id"]
    );
    // views are copied with remapped config
    let grid = copy["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "Grid view")
        .unwrap();
    assert_eq!(
        grid["config"]["sorts"][0]["field_id"],
        field(copy, "Qty")["id"]
    );
    assert_eq!(
        grid["config"]["filter"]["items"][0]["value"],
        json!([field(copy, "Status")["options"]["choices"][0]["id"]])
    );
    assert_eq!(
        copy["views"].as_array().unwrap().len(),
        t1["views"].as_array().unwrap().len()
    );

    // the link to Orders is duplicated with a NEW inverse in Orders, named after the copy
    let t2 = table(&schema, "Orders");
    let new_link = field(copy, "Orders");
    assert_eq!(new_link["options"]["linked_table_id"], t2["id"]);
    let new_inverse = field(t2, "Table 1 copy");
    assert_eq!(new_link["options"]["inverse_field_id"], new_inverse["id"]);
    assert_eq!(new_inverse["options"]["linked_table_id"], copy["id"]);
    assert_eq!(new_inverse["options"]["inverse_field_id"], new_link["id"]);
    // the original pair is untouched
    assert_eq!(
        field(t1, "Orders")["options"],
        field(table(&before_schema, "Table 1"), "Orders")["options"]
    );
    assert_eq!(
        field(t2, "Table 1")["options"]["linked_table_id"],
        r.t1.as_str()
    );
    // lookups/rollups/counts in the copy use the copy's link and the same target
    assert_eq!(
        field(copy, "Prices")["options"]["link_field_id"],
        new_link["id"]
    );
    assert_eq!(
        field(copy, "Prices")["options"]["target_field_id"],
        r.price["id"]
    );
    assert_eq!(field(copy, "N")["options"]["link_field_id"], new_link["id"]);
    assert_eq!(
        field(copy, "Total")["options"]["link_field_id"],
        new_link["id"]
    );
    assert_eq!(
        assert_link_pairs_consistent(&schema),
        6,
        "orders pair, parent pair, copy pair"
    );

    // records: both copies of the link array agree
    let records = dump_records(&r.f.app, &r.f.base_id);
    assert_eq!(
        records.len(),
        before_records.len() + 2,
        "r1 and r2 were copied"
    );
    let primary = sid(&copy["primary_field_id"]);
    let (r1c, r1c_data, _) = records
        .iter()
        .find(|(_, (t, d, _))| t == sid(&copy["id"]) && d[primary] == "Alice")
        .map(|(id, (_, d, del))| (id.clone(), d.clone(), *del))
        .unwrap();
    assert_eq!(r1c_data[sid(&new_link["id"])], json!([r.o1, r.o2]));
    assert_eq!(
        r1c_data[sid(&field(copy, "Status")["id"])],
        field(copy, "Status")["options"]["choices"][0]["id"]
    );
    let ni = sid(&new_inverse["id"]);
    assert_eq!(records[&r.o1].1[ni], json!([r1c]));
    assert_eq!(records[&r.o2].1[ni], json!([r1c]));
    assert!(
        records[&r.o3_trashed].1.get(ni).is_none(),
        "trashed records are left alone"
    );
    // the old inverse arrays are untouched
    let old_inv = sid(&field(t2, "Table 1")["id"]);
    assert_eq!(records[&r.o1].1[old_inv], json!([r.r1]));
    assert!(assert_link_arrays_consistent(&schema, &records) >= 10);

    // nothing else changed in the existing records
    for (id, (_, data, deleted)) in &before_records {
        let now = &records[id];
        assert_eq!(&now.2, deleted);
        let mut stripped = now.1.clone();
        stripped.as_object_mut().unwrap().remove(ni);
        assert_eq!(&stripped, data, "record {id}");
    }
}

#[tokio::test]
async fn copying_without_records_still_creates_the_link_pair_but_changes_no_data() {
    let r = rich_base().await;
    let before = dump_records(&r.f.app, &r.f.base_id);
    let res = duplicate_table(
        &r,
        &r.t1,
        json!({ "include_records": false, "name": "Fresh" }),
    )
    .await;
    res.assert_status(201);
    assert_eq!(res.body["name"], "Fresh");
    assert_eq!(dump_records(&r.f.app, &r.f.base_id), before);
    let schema = r.f.schema().await;
    assert_eq!(
        field(table(&schema, "Orders"), "Fresh")["options"]["linked_table_id"],
        res.body["id"]
    );
    assert_link_pairs_consistent(&schema);
}

#[tokio::test]
async fn self_links_in_the_copied_table_link_the_copy_to_itself() {
    let r = rich_base().await;
    let res = duplicate_table(&r, &r.t2, json!({})).await;
    res.assert_status(201);
    let copy = &res.body;
    assert_eq!(copy["name"], "Orders copy");
    let schema = r.f.schema().await;

    let parent = field(copy, "Parent");
    assert_eq!(
        parent["options"]["linked_table_id"], copy["id"],
        "self link stays within the copy"
    );
    let parent_inv = field(copy, "Orders");
    assert_eq!(parent["options"]["inverse_field_id"], parent_inv["id"]);
    assert_eq!(parent_inv["options"]["inverse_field_id"], parent["id"]);
    assert_eq!(parent_inv["table_id"], copy["id"]);

    // the copy's link back to Table 1 gets a new inverse in Table 1 named after the copy
    let t1 = table(&schema, "Table 1");
    let ext = field(copy, "Table 1");
    assert_eq!(ext["options"]["linked_table_id"], r.t1.as_str());
    let new_inv = field(t1, "Orders copy");
    assert_eq!(new_inv["options"]["linked_table_id"], copy["id"]);
    assert_eq!(ext["options"]["inverse_field_id"], new_inv["id"]);

    // stored formula keeps pointing at the copy's own Price
    let copy_id = sid(&copy["id"]).to_string();
    let opts: String = sql(&r.f.app, move |tx| {
        tx.query_row(
            "SELECT options FROM fields WHERE table_id = ?1 AND name = 'Double'",
            [&copy_id],
            |row| row.get(0),
        )
    });
    let expr = serde_json::from_str::<Value>(&opts).unwrap()["expression"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        expr,
        format!("{{{}}} * 2", sid(&field(copy, "Price")["id"]))
    );

    // records: Parent links point at the copied orders; the link to Table 1 reaches r1 and r1 sees the copies
    let records = dump_records(&r.f.app, &r.f.base_id);
    let primary = sid(&copy["primary_field_id"]);
    let named = |n: &str| {
        records
            .iter()
            .find(|(_, (t, d, _))| t == sid(&copy["id"]) && d[primary] == n)
            .map(|(id, _)| id.clone())
            .unwrap()
    };
    let (c1, c2) = (named("Order 1"), named("Order 2"));
    assert_eq!(records[&c1].1[sid(&parent["id"])], json!([c2]));
    assert_eq!(records[&c2].1[sid(&parent_inv["id"])], json!([c1]));
    assert_eq!(records[&c1].1[sid(&ext["id"])], json!([r.r1]));
    let seen_by_r1: HashSet<&str> = records[&r.r1].1[sid(&new_inv["id"])]
        .as_array()
        .unwrap()
        .iter()
        .map(sid)
        .collect();
    assert_eq!(seen_by_r1, HashSet::from([c1.as_str(), c2.as_str()]));
    assert!(assert_link_arrays_consistent(&schema, &records) >= 10);
}

#[tokio::test]
async fn names_of_copies_are_unique_and_validated() {
    let r = rich_base().await;
    let a = duplicate_table(&r, &r.t1, json!({ "include_records": false })).await;
    a.assert_status(201);
    let b = duplicate_table(&r, &r.t1, json!({ "include_records": false })).await;
    b.assert_status(201);
    assert_eq!(a.body["name"], "Table 1 copy");
    assert_eq!(b.body["name"], "Table 1 copy 2");
    duplicate_table(&r, &r.t1, json!({ "name": "table 1 COPY" }))
        .await
        .assert_status(409);
    duplicate_table(&r, &r.t1, json!({ "name": "  " }))
        .await
        .assert_status(400);
    // the body is optional
    let res =
        r.f.app
            .request(
                &r.f.owner,
                "POST",
                &format!("/api/tables/{}/duplicate", r.t2),
                None,
            )
            .await;
    res.assert_status(201);
    duplicate_table(&r, "tblNOPE", json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn tables_without_links_copy_in_isolation_and_announce_just_the_new_table() {
    let f = Fixture::new().await;
    let qty = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let rec = f.insert_record(
        &f.table_id,
        json!({ &f.primary_id: "x", sid(&qty["id"]): 4 }),
    );
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let res = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/duplicate", f.table_id),
            json!({}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(sid(&res.body["id"]).to_string())
        }
    );
    let records = dump_records(&f.app, &f.base_id);
    assert_eq!(records.len(), 2);
    let copy_rec = records.iter().find(|(id, _)| **id != rec).unwrap().1;
    assert_eq!(copy_rec.1[sid(&field(&res.body, "Qty")["id"])], 4);
    assert_eq!(copy_rec.1[sid(&res.body["primary_field_id"])], "x");
    assert_eq!(
        records[&rec].1,
        json!({ &f.primary_id: "x", sid(&qty["id"]): 4 }),
        "source record unchanged"
    );
}

#[tokio::test]
async fn attachments_stay_shared_when_copying_within_a_base() {
    let r = rich_base().await;
    let res = duplicate_table(&r, &r.t1, json!({})).await;
    res.assert_status(201);
    let records = dump_records(&r.f.app, &r.f.base_id);
    let copy = &res.body;
    let (_, data, _) = records
        .values()
        .find(|(t, d, _)| t == sid(&copy["id"]) && d[sid(&copy["primary_field_id"])] == "Alice")
        .unwrap();
    assert_eq!(
        data[sid(&field(copy, "Files")["id"])][0]["id"],
        r.att_id.as_str()
    );
    assert_eq!(
        count(
            &r.f.app,
            "SELECT count(*) FROM attachments WHERE base_id = ?1",
            &r.f.base_id
        ),
        1
    );
}

#[tokio::test]
async fn trashed_fields_are_not_copied() {
    let f = Fixture::new().await;
    let gone = f
        .add_field(
            &f.table_id,
            json!({ "name": "Gone", "type": "number", "options": {} }),
        )
        .await;
    f.insert_record(&f.table_id, json!({ sid(&gone["id"]): 1 }));
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&gone["id"])))
        .await
        .assert_status(200);
    let res = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/duplicate", f.table_id),
            json!({}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(Fixture::field_names(&res.body), ["Name", "Notes"]);
    let records = dump_records(&f.app, &f.base_id);
    let copy_rec = records
        .values()
        .find(|(t, _, _)| t == sid(&res.body["id"]))
        .unwrap();
    assert_eq!(copy_rec.1, json!({}));
}
