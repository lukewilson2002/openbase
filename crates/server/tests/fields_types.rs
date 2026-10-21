//! Changing a field's type or options: stored values are converted (through
//! the integration point), select choices are cleaned up, and the whole
//! change is atomic.

mod common;
mod schema_support;

use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[tokio::test]
async fn same_type_option_changes_keep_values_and_type_changes_convert_them() {
    let f = Fixture::new().await;
    let num = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let nid = sid(&num["id"]).to_string();
    let other = f
        .add_field(
            &f.table_id,
            json!({ "name": "Other", "type": "number", "options": {} }),
        )
        .await;
    let oid = sid(&other["id"]).to_string();
    let r1 = f.insert_record(
        &f.table_id,
        json!({ &nid: 12.5, &oid: 1, &f.primary_id: "a" }),
    );
    let r2 = f.insert_record(&f.table_id, json!({ &oid: 2 }));

    // number -> number with a new precision: values stay
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "number", "options": { "precision": 3 } }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        f.record_data(&r1),
        json!({ &nid: 12.5, &oid: 1, &f.primary_id: "a" })
    );

    // number -> text: the value becomes its display text (3 decimals now)
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "text", "options": {} }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        f.record_data(&r1),
        json!({ &nid: "12.500", &oid: 1, &f.primary_id: "a" })
    );
    assert_eq!(
        f.record_data(&r2),
        json!({ &oid: 2 }),
        "other fields and records are untouched"
    );
}

#[tokio::test]
async fn trashed_records_are_converted_too() {
    let f = Fixture::new().await;
    let num = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let nid = sid(&num["id"]).to_string();
    let live = f.insert_record(&f.table_id, json!({ &nid: 1 }));
    let dead = f.insert_record(&f.table_id, json!({ &nid: 2 }));
    trash_record(&f.app, &dead, 5);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "checkbox", "options": {} }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.record_data(&live), json!({ &nid: true }));
    assert_eq!(
        f.record_data(&dead),
        json!({ &nid: true }),
        "restoring a record later must not resurrect a stale value"
    );
}

#[tokio::test]
async fn conversion_handles_more_rows_than_one_chunk() {
    let f = Fixture::new().await;
    let num = f
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
    let (nid, kid) = (sid(&num["id"]).to_string(), sid(&keep["id"]).to_string());
    let table = f.table_id.clone();
    let total = 4500;
    {
        let (nid, kid) = (nid.clone(), kid.clone());
        sql(&f.app, move |tx| {
            for i in 0..total {
                let data = if i % 3 == 0 {
                    json!({ &kid: i })
                } else {
                    json!({ &nid: i, &kid: i })
                };
                tx.execute(
                    "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?4, 1, 1, ?5)",
                    rusqlite::params![format!("recbulk{i:06}"), table, data.to_string(), i, if i % 10 == 0 { Some(9) } else { None::<i64> }],
                )?;
            }
            Ok(())
        });
    }
    let with_key = |field: &str| {
        count(
            &f.app,
            &format!(
                "SELECT count(*) FROM records WHERE table_id = ?1 AND json_type(data, '$.\"{field}\"') IS NOT NULL"
            ),
            &f.table_id,
        )
    };
    assert_eq!(with_key(&nid), 3000);
    assert_eq!(with_key(&kid), 4500);

    // same-type change keeps all 3000
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "number", "options": { "precision": 2 } }),
        )
        .await
        .assert_status(200);
    assert_eq!(with_key(&nid), 3000);

    // cross-type change clears all 3000, across chunk boundaries, and nothing else
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "email", "options": {} }),
        )
        .await
        .assert_status(200);
    assert_eq!(with_key(&nid), 0);
    assert_eq!(with_key(&kid), 4500);
}

#[tokio::test]
async fn removing_select_choices_clears_their_values() {
    let f = Fixture::new().await;
    let single = f
        .add_field(
            &f.table_id,
            json!({ "name": "Status", "type": "single_select",
                    "options": { "choices": [ { "name": "Todo" }, { "name": "Doing" }, { "name": "Done" } ] } }),
        )
        .await;
    let multi = f
        .add_field(
            &f.table_id,
            json!({ "name": "Tags", "type": "multiple_select",
                    "options": { "choices": [ { "name": "a" }, { "name": "b" }, { "name": "c" } ] } }),
        )
        .await;
    let ch = |field: &Value, i: usize| sid(&field["options"]["choices"][i]["id"]).to_string();
    let (sid_, mid) = (
        sid(&single["id"]).to_string(),
        sid(&multi["id"]).to_string(),
    );
    let (todo, doing, done) = (ch(&single, 0), ch(&single, 1), ch(&single, 2));
    let (a, b, c) = (ch(&multi, 0), ch(&multi, 1), ch(&multi, 2));
    let r1 = f.insert_record(&f.table_id, json!({ &sid_: todo, &mid: [a, b] }));
    let r2 = f.insert_record(&f.table_id, json!({ &sid_: doing, &mid: [b] }));
    let r3 = f.insert_record(&f.table_id, json!({ &sid_: done, &mid: [c] }));

    // keep Todo (renamed), drop Doing, keep Done by id, add a brand new choice without an id
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{sid_}"),
            json!({ "type": "single_select", "options": { "choices": [
                { "id": todo, "name": "To do", "color": "blue" },
                { "id": done, "name": "Done", "color": "green" },
                { "name": "Blocked" } ] } }),
        )
        .await;
    r.assert_status(200);
    let choices = r.body["options"]["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 3);
    assert_eq!(choices[0]["id"], todo.as_str());
    assert_eq!(choices[0]["name"], "To do");
    assert!(choices[2]["id"].as_str().unwrap().starts_with("sel"));
    assert_ne!(choices[2]["id"], doing.as_str());

    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{mid}"),
            json!({ "type": "multiple_select", "options": { "choices": [
                { "id": a, "name": "a", "color": "red" }, { "id": c, "name": "c", "color": "red" } ] } }),
        )
        .await;
    r.assert_status(200);

    assert_eq!(
        f.record_data(&r1),
        json!({ &sid_: todo, &mid: [a] }),
        "renamed choice keeps its values"
    );
    assert_eq!(
        f.record_data(&r2),
        json!({}),
        "removed single choice and emptied multi cell are gone"
    );
    assert_eq!(f.record_data(&r3), json!({ &sid_: done, &mid: [c] }));
}

#[tokio::test]
async fn changing_to_a_computed_type_clears_stored_values() {
    let f = Fixture::new().await;
    let num = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let nid = sid(&num["id"]).to_string();
    let rec = f.insert_record(&f.table_id, json!({ &nid: 5, &f.primary_id: "x" }));
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "formula", "options": { "expression": "1" } }),
        )
        .await
        .assert_status(200);
    // the old number is gone; the formula's value is materialized in its place
    assert_eq!(f.record_data(&rec), json!({ &nid: 1, &f.primary_id: "x" }));
    // and back to an editable type: nothing to carry over
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "number", "options": {} }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["type"], "number");
}

#[tokio::test]
async fn a_rejected_type_change_leaves_data_and_schema_untouched() {
    let f = Fixture::new().await;
    let orders = f.add_table("Orders").await;
    let oid = sid(&orders["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &oid).await;
    let x = f
        .add_field(
            &f.table_id,
            json!({ "name": "X", "type": "number", "options": {} }),
        )
        .await;
    let xid = sid(&x["id"]).to_string();
    let rec = f.insert_record(&f.table_id, json!({ &xid: 7 }));
    // Orders.lkB looks up T1.X through the inverse link
    let lk_b = f
        .add_field(
            &oid,
            json!({ "name": "lkB", "type": "lookup",
                    "options": { "link_field_id": link["inverse"]["id"], "target_field_id": x["id"] } }),
        )
        .await;
    // X -> lookup(link, lkB) would close the circle X -> lkB -> X
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{xid}"),
            json!({ "type": "lookup", "options": { "link_field_id": link["id"], "target_field_id": lk_b["id"] } }),
        )
        .await;
    r.assert_status(400);
    assert_eq!(
        f.record_data(&rec),
        json!({ &xid: 7 }),
        "the stored value survives the failed change"
    );
    let t = f.table(&f.table_id).await;
    let now = t["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == xid.as_str())
        .unwrap();
    assert_eq!(now["type"], "number");
}

#[tokio::test]
async fn metadata_only_updates_never_touch_records() {
    let f = Fixture::new().await;
    let num = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let nid = sid(&num["id"]).to_string();
    let rec = f.insert_record(&f.table_id, json!({ &nid: 5 }));
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "name": "Quantity", "description": "d", "position": 0.5 }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.record_data(&rec), json!({ &nid: 5 }));
}

#[tokio::test]
async fn date_option_changes_keep_values() {
    let f = Fixture::new().await;
    let d = f
        .add_field(
            &f.table_id,
            json!({ "name": "When", "type": "date", "options": {} }),
        )
        .await;
    let did = sid(&d["id"]).to_string();
    let rec = f.insert_record(&f.table_id, json!({ &did: "2026-10-12" }));
    let r = f
        .app
        .patch(&f.owner, &format!("/api/fields/{did}"), json!({ "type": "date", "options": { "timezone": "Asia/Tokyo", "date_format": "iso" } }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["options"]["timezone"], "Asia/Tokyo");
    assert_eq!(f.record_data(&rec), json!({ &did: "2026-10-12" }));
}

#[tokio::test]
async fn rest_select_choices_keep_given_colors_and_default_by_name() {
    let f = Fixture::new().await;
    let field = f
        .add_field(
            &f.table_id,
            json!({ "name": "Severity", "type": "single_select",
                    "options": { "choices": [
                        { "name": "Critical" }, { "name": "Low" },
                        { "name": "Custom", "color": "pink" }, { "name": "Other" } ] } }),
        )
        .await;
    let colors: Vec<&str> = field["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["red", "green", "pink", "green"]);
}
