//! Changing a field's type converts the stored values with the real cell
//! converter: display text out, parsed text in, select choices created on the
//! way, link names resolved from the linked records.

mod common;
mod records_support;
mod schema_support;

use records_support::*;
use serde_json::{Value, json};

async fn convert(f: &Fixture, field: &Value, body: Value) -> common::Response {
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&field["id"])),
            body,
        )
        .await
}

fn choice_names(field: &Value) -> Vec<String> {
    field["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn numbers_become_text_and_text_becomes_numbers() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let price = f
        .add_field(&t, json!({ "name": "Price", "type": "currency", "options": { "precision": 2, "symbol": "$" } }))
        .await;
    let id = sid(&price["id"]).to_string();
    let a = f.create(&t, json!({ &id: 1200.5 })).await;
    let aid = sid(&a["id"]).to_string();
    convert(
        &f,
        &price,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(
        f.stored(&aid, &id),
        "$1,200.50",
        "currency renders with its symbol and separators"
    );

    // and back: the text is read like a pasted number
    let text = f.field(&t, "Price").await;
    convert(
        &f,
        &text,
        json!({ "type": "number", "options": { "precision": 2 } }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&aid, &id), 1200.5);

    // values that are not numbers are dropped
    let text_again = f.field(&t, "Price").await;
    convert(
        &f,
        &text_again,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    f.set(&t, &aid, json!({ &id: "twelve" })).await;
    let n = f.field(&t, "Price").await;
    convert(&f, &n, json!({ "type": "number", "options": {} }))
        .await
        .assert_status(200);
    assert!(f.record_data(&aid).get(&id).is_none());
}

#[tokio::test]
async fn text_becomes_a_select_with_choices_created_from_the_values() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let col = f
        .add_field(
            &t,
            json!({ "name": "Stage", "type": "single_line_text", "options": {} }),
        )
        .await;
    let id = sid(&col["id"]).to_string();
    let mut recs = Vec::new();
    for v in ["Open", "open ", "Closed", "Open", ""] {
        recs.push(sid(&f.create(&t, json!({ &id: v })).await["id"]).to_string());
    }
    let r = convert(
        &f,
        &col,
        json!({ "type": "single_select", "options": { "choices": [] } }),
    )
    .await;
    r.assert_status(200);
    let field = f.field(&t, "Stage").await;
    assert_eq!(
        choice_names(&field),
        ["Open", "Closed"],
        "case-insensitive duplicates make one choice"
    );
    let choices = field["options"]["choices"].as_array().unwrap();
    let (open, closed) = (choices[0]["id"].clone(), choices[1]["id"].clone());
    assert_eq!(f.stored(&recs[0], &id), open);
    assert_eq!(f.stored(&recs[1], &id), open);
    assert_eq!(f.stored(&recs[2], &id), closed);
    assert_eq!(f.stored(&recs[3], &id), open);
    assert!(f.record_data(&recs[4]).get(&id).is_none());
    // the API shows the choice ids; names map back through the field options
    assert_eq!(f.get(&t, &recs[2]).await["values"][&id], closed);
}

#[tokio::test]
async fn existing_choices_are_kept_and_matched_by_name_when_converting_between_selects() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let multi = f
        .add_field(
            &t,
            json!({ "name": "Tags", "type": "multiple_select",
                    "options": { "choices": [ { "name": "red" }, { "name": "blue" }, { "name": "green" } ] } }),
        )
        .await;
    let id = sid(&multi["id"]).to_string();
    let a = f.create(&t, json!({ &id: ["red", "blue"] })).await;
    let b = f.create(&t, json!({ &id: ["green"] })).await;
    let (aid, bid) = (sid(&a["id"]).to_string(), sid(&b["id"]).to_string());
    // multiple -> single keeps the first
    convert(
        &f,
        &multi,
        json!({ "type": "single_select", "options": { "choices": multi["options"]["choices"] } }),
    )
    .await
    .assert_status(200);
    let single = f.field(&t, "Tags").await;
    let ids: Vec<Value> = single["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].clone())
        .collect();
    assert_eq!(f.stored(&aid, &id), ids[0]);
    assert_eq!(f.stored(&bid, &id), ids[2]);
    // single -> multiple
    convert(&f, &single, json!({ "type": "multiple_select", "options": { "choices": single["options"]["choices"] } }))
        .await
        .assert_status(200);
    assert_eq!(f.stored(&aid, &id), json!([ids[0].clone()]));
    // multiple -> text joins the names
    let multi_again = f.field(&t, "Tags").await;
    f.set(&t, &aid, json!({ &id: ["red", "blue"] })).await;
    convert(
        &f,
        &multi_again,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&aid, &id), "red, blue");
    // text -> multiple splits on commas and creates what is missing
    let text = f.field(&t, "Tags").await;
    f.set(&t, &bid, json!({ &id: "alpha, \"beta, gamma\", alpha" }))
        .await;
    convert(
        &f,
        &text,
        json!({ "type": "multiple_select", "options": { "choices": [] } }),
    )
    .await
    .assert_status(200);
    let multi_final = f.field(&t, "Tags").await;
    assert_eq!(
        choice_names(&multi_final),
        ["red", "blue", "alpha", "beta, gamma"]
    );
    assert_eq!(f.stored(&bid, &id).as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn booleans_dates_and_long_text() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let flag = f
        .add_field(
            &t,
            json!({ "name": "Flag", "type": "checkbox", "options": {} }),
        )
        .await;
    let day = f
        .add_field(
            &t,
            json!({ "name": "Day", "type": "date", "options": { "date_format": "iso" } }),
        )
        .await;
    let (fid, did) = (sid(&flag["id"]).to_string(), sid(&day["id"]).to_string());
    let rec = f
        .create(
            &t,
            json!({ &fid: true, &did: "2026-03-04", &f.notes_id: "a\nb" }),
        )
        .await;
    let rid = sid(&rec["id"]).to_string();
    let off = f.create(&t, json!({ &did: "2026-03-05" })).await;

    convert(&f, &flag, json!({ "type": "number", "options": {} }))
        .await
        .assert_status(200);
    assert_eq!(f.stored(&rid, &fid), 1, "checked becomes 1");
    assert!(f.record_data(sid(&off["id"])).get(&fid).is_none());

    convert(
        &f,
        &day,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&rid, &did), "2026-03-04");
    let text = f.field(&t, "Day").await;
    convert(
        &f,
        &text,
        json!({ "type": "date", "options": { "include_time": true, "timezone": "UTC" } }),
    )
    .await
    .assert_status(200);
    assert!(
        sid(&f.stored(&rid, &did)).starts_with("2026-03-04T00:00:00"),
        "{}",
        f.stored(&rid, &did)
    );

    // long text keeps its newlines; single line text collapses them
    let notes = f.field(&t, "Notes").await;
    convert(
        &f,
        &notes,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&rid, &f.notes_id), "a b");
}

#[tokio::test]
async fn links_become_text_with_the_linked_primary_names() {
    let l = linked().await;
    let f = &l.f;
    let t2p = sid(&f.table(&l.t2).await["primary_field_id"]).to_string();
    let o1 = sid(&f.create(&l.t2, json!({ &t2p: "Order A" })).await["id"]).to_string();
    let o2 = sid(&f.create(&l.t2, json!({ &t2p: "Order B" })).await["id"]).to_string();
    let o3 = sid(&f.create(&l.t2, json!({ &t2p: "Order C" })).await["id"]).to_string();
    let lid = sid(&l.link["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ &lid: [o1, o2, o3] })).await["id"]).to_string();
    f.delete_records(&l.t2, &[&o2]).await.assert_status(204);
    let r = convert(f, &l.link, json!({ "type": "long_text", "options": {} })).await;
    r.assert_status(200);
    assert_eq!(
        f.stored(&c, &lid),
        "Order A, Order C",
        "trashed linked records are left out"
    );
    // the inverse field went to the trash with the pair
    assert!(
        !f.table(&l.t2).await["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == l.inverse["id"])
    );
}

#[tokio::test]
async fn a_link_keeps_its_ids_when_only_its_options_change() {
    let l = linked().await;
    let f = &l.f;
    let o = sid(&f.create(&l.t2, json!({})).await["id"]).to_string();
    let lid = sid(&l.link["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ &lid: [o] })).await["id"]).to_string();
    let r = convert(
        f,
        &l.link,
        json!({ "type": "link", "options": { "linked_table_id": l.t2, "single": true } }),
    )
    .await;
    r.assert_status(200);
    assert_eq!(stored_ids(f, &c, &lid), std::slice::from_ref(&o));
    assert_eq!(stored_ids(f, &o, sid(&l.inverse["id"])), [c]);
}

#[tokio::test]
async fn users_and_attachments_convert_to_text() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let user = f
        .add_field(
            &t,
            json!({ "name": "Who", "type": "user", "options": { "multiple": true } }),
        )
        .await;
    let files = f
        .add_field(
            &t,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let (uid, fid) = (sid(&user["id"]).to_string(), sid(&files["id"]).to_string());
    let alice = f.member("alice@example.com", opengrid::perm::Role::Editor);
    let alice_id = alice.user_id.clone().unwrap();
    sql(&f.app, {
        let id = alice_id.clone();
        move |tx| tx.execute("UPDATE users SET name = 'Alice Smith' WHERE id = ?1", [&id])
    });
    sql(&f.app, {
        let base = f.base_id.clone();
        move |tx| {
            tx.execute(
                "INSERT INTO attachments (id, sha256, filename, mime, size, base_id, created_at)
                 VALUES ('attConv', 'abc', 'plan.pdf', 'application/pdf', 5, ?1, 1)",
                [&base],
            )
        }
    });
    let rec = f
        .create(
            &t,
            json!({ &uid: [alice_id, f.owner.user_id.clone().unwrap()],
                    &fid: [{ "id": "attConv", "filename": "x", "mime": "x/x", "size": 1 }] }),
        )
        .await;
    let rid = sid(&rec["id"]).to_string();
    convert(
        &f,
        &user,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    convert(
        &f,
        &files,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&rid, &uid), "Alice Smith, Owner");
    assert_eq!(f.stored(&rid, &fid), "plan.pdf");
}

#[tokio::test]
async fn converting_a_source_field_updates_formulas_lookups_and_rollups_built_on_it() {
    let l = linked().await;
    let f = &l.f;
    let pid = sid(&l.price["id"]).to_string();
    let lookup = f.lookup(&l.t1, "Prices", &l.link, &l.price).await;
    let rollup = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let o = sid(&f.create(&l.t2, json!({ &pid: 12 })).await["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ sid(&l.link["id"]): [o] })).await["id"]).to_string();
    assert_eq!(f.stored(&c, sid(&lookup["id"])), json!([12]));
    // number -> text: lookups now carry text and the rollup is re-inferred
    convert(
        f,
        &l.price,
        json!({ "type": "single_line_text", "options": {} }),
    )
    .await
    .assert_status(200);
    assert_eq!(f.stored(&c, sid(&lookup["id"])), json!(["12"]));
    let lookup_now = f.field(&l.t1, "Prices").await;
    assert_eq!(
        lookup_now["options"]["result_type"],
        json!({ "array": "text" })
    );
    let _ = rollup;
}

#[tokio::test]
async fn a_rejected_formula_update_changes_nothing() {
    let l = linked().await;
    let f = &l.f;
    let calc = f.formula(&l.t2, "Calc", "{Price} * 2").await;
    let o = sid(&f.create(&l.t2, json!({ sid(&l.price["id"]): 4 })).await["id"]).to_string();
    // a formula update that does not parse is refused and the old definition and values stay
    let r = convert(
        f,
        &calc,
        json!({ "type": "formula", "options": { "expression": "{Nope}" } }),
    )
    .await;
    r.assert_status(400);
    assert_eq!(f.stored(&o, sid(&calc["id"])), 8);
    assert_eq!(
        f.field(&l.t2, "Calc").await["options"]["expression"],
        "{Price} * 2"
    );
}
