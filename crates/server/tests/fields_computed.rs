//! Computed fields (formula, lookup, rollup, count, button): validation,
//! result types, cycle detection, cascades when what they depend on goes away.

mod common;
mod schema_support;

use og_core::value::ResultType;
use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn array_of(t: ResultType) -> Value {
    serde_json::to_value(ResultType::Array(Box::new(t))).unwrap()
}

fn fields_url(table: &str) -> String {
    format!("/api/tables/{table}/fields")
}

/// T1 (fixture table) linked to a new table "Orders" holding a number field "Price".
struct Linked {
    f: Fixture,
    orders: String,
    link: Value,
    price: Value,
}

async fn linked() -> Linked {
    let f = Fixture::new().await;
    let orders = f.add_table("Orders").await;
    let oid = sid(&orders["id"]).to_string();
    let link = f.add_link(&f.table_id, "Orders", &oid).await;
    let price = f
        .add_field(
            &oid,
            json!({ "name": "Price", "type": "number", "options": {} }),
        )
        .await;
    Linked {
        f,
        orders: oid,
        link,
        price,
    }
}

fn lookup_body(name: &str, link: &Value, target: &Value) -> Value {
    json!({ "name": name, "type": "lookup", "options": { "link_field_id": link["id"], "target_field_id": target["id"] } })
}

#[tokio::test]
async fn lookup_result_type_is_an_array_of_the_targets_type() {
    let l = linked().await;
    let r =
        l.f.app
            .post(
                &l.f.owner,
                &fields_url(&l.f.table_id),
                lookup_body("Prices", &l.link, &l.price),
            )
            .await;
    r.assert_status(201);
    assert_eq!(
        r.body["options"]["result_type"],
        array_of(ResultType::Number)
    );
    assert_eq!(r.body["options"]["link_field_id"], l.link["id"]);

    let cases = [
        (
            json!({ "type": "checkbox", "options": {} }),
            ResultType::Bool,
        ),
        (
            json!({ "type": "date", "options": { "include_time": true } }),
            ResultType::DateTime,
        ),
        (json!({ "type": "date", "options": {} }), ResultType::Date),
        (json!({ "type": "email", "options": {} }), ResultType::Text),
        (
            json!({ "type": "created_time", "options": {} }),
            ResultType::DateTime,
        ),
    ];
    for (i, (kind, expected)) in cases.into_iter().enumerate() {
        let mut body = kind;
        body["name"] = json!(format!("target{i}"));
        let target = l.f.add_field(&l.orders, body).await;
        let r =
            l.f.app
                .post(
                    &l.f.owner,
                    &fields_url(&l.f.table_id),
                    lookup_body(&format!("lk{i}"), &l.link, &target),
                )
                .await;
        r.assert_status(201);
        assert_eq!(
            r.body["options"]["result_type"],
            array_of(expected),
            "case {i}"
        );
    }
}

#[tokio::test]
async fn a_client_cannot_set_the_result_type() {
    let l = linked().await;
    let mut body = lookup_body("Prices", &l.link, &l.price);
    body["options"]["result_type"] = json!("text");
    let r =
        l.f.app
            .post(&l.f.owner, &fields_url(&l.f.table_id), body)
            .await;
    r.assert_status(201);
    assert_eq!(
        r.body["options"]["result_type"],
        array_of(ResultType::Number)
    );
}

#[tokio::test]
async fn lookup_references_are_validated() {
    let l = linked().await;
    let url = fields_url(&l.f.table_id);
    let own_field = json!({ "id": l.f.notes_id });
    let not_a_link = json!({ "id": l.f.notes_id });
    let cases = [
        (
            "link is not a link field",
            lookup_body("a", &not_a_link, &l.price),
        ),
        (
            "unknown link",
            lookup_body("b", &json!({ "id": "fldNOPE" }), &l.price),
        ),
        ("target in own table", lookup_body("c", &l.link, &own_field)),
        (
            "unknown target",
            lookup_body("d", &l.link, &json!({ "id": "fldNOPE" })),
        ),
        (
            "link in the wrong table",
            lookup_body("e", &l.link["inverse"], &l.price),
        ),
    ];
    for (what, body) in cases {
        let r = l.f.app.post(&l.f.owner, &url, body).await;
        assert_eq!(r.status.as_u16(), 400, "{what}: {}", r.body);
    }
    // count needs a link too
    let r = l
        .f
        .app
        .post(
            &l.f.owner,
            &url,
            json!({ "name": "n", "type": "count", "options": { "link_field_id": l.f.notes_id } }),
        )
        .await;
    r.assert_status(400);
    // the failures left no fields behind
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes", "Orders"]
    );
}

#[tokio::test]
async fn lookup_target_must_be_live() {
    let l = linked().await;
    l.f.app
        .delete(&l.f.owner, &format!("/api/fields/{}", sid(&l.price["id"])))
        .await
        .assert_status(200);
    l.f.app
        .post(
            &l.f.owner,
            &fields_url(&l.f.table_id),
            lookup_body("Prices", &l.link, &l.price),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn rollup_and_count_are_created_with_inferred_types() {
    let l = linked().await;
    let url = fields_url(&l.f.table_id);
    let roll = l
        .f
        .app
        .post(
            &l.f.owner,
            &url,
            json!({ "name": "Total", "type": "rollup",
                    "options": { "link_field_id": l.link["id"], "target_field_id": l.price["id"], "expression": "SUM(values)" } }),
        )
        .await;
    roll.assert_status(201);
    assert_eq!(roll.body["options"]["expression"], "SUM(values)");
    assert_eq!(roll.body["options"]["result_type"], "number");
    let count = l
        .f
        .app
        .post(
            &l.f.owner,
            &url,
            json!({ "name": "N", "type": "count", "options": { "link_field_id": l.link["id"] } }),
        )
        .await;
    count.assert_status(201);

    // a rollup only sees the linked values, not other fields
    let r = l
        .f
        .app
        .post(
            &l.f.owner,
            &url,
            json!({ "name": "Bad", "type": "rollup",
                    "options": { "link_field_id": l.link["id"], "target_field_id": l.price["id"], "expression": "SUM({Price})" } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("rollup")
    );
}

#[tokio::test]
async fn formula_and_button_use_the_formula_integration_point() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    let ok = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Two", "type": "formula", "options": { "expression": "1 + 1" } }),
        )
        .await;
    ok.assert_status(201);
    assert_eq!(ok.body["options"]["expression"], "1 + 1");
    assert_eq!(ok.body["options"]["result_type"], "number");
    // references are resolved by name and stored by id
    let r = f.app.post(&f.owner, &url, json!({ "name": "Ref", "type": "formula", "options": { "expression": "{Name} & \"x\"" } })).await;
    r.assert_status(201);
    assert_eq!(r.body["options"]["expression"], "{Name} & \"x\"");
    assert_eq!(r.body["options"]["result_type"], "text");
    // unknown references are rejected with the formula error
    let r = f.app.post(&f.owner, &url, json!({ "name": "Bad", "type": "formula", "options": { "expression": "{Nope} & \"x\"" } })).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Nope")
    );
    f.app
        .post(&f.owner, &url, json!({ "name": "Long", "type": "formula", "options": { "expression": "1".repeat(10_001) } }))
        .await
        .assert_status(400);

    let btn = f
        .app
        .post(&f.owner, &url, json!({ "name": "Open", "type": "button", "options": { "label": " Go ", "url_formula": "\"https://example.com\"" } }))
        .await;
    btn.assert_status(201);
    assert_eq!(btn.body["options"]["label"], "Go");
    f.app
        .post(&f.owner, &url, json!({ "name": "B2", "type": "button", "options": { "label": "  ", "url_formula": "\"x\"" } }))
        .await
        .assert_status(400);
    f.app
        .post(&f.owner, &url, json!({ "name": "B3", "type": "button", "options": { "label": "Go", "url_formula": "{Name}" } }))
        .await
        .assert_status(201);
    f.app
        .post(&f.owner, &url, json!({ "name": "B4", "type": "button", "options": { "label": "Go", "url_formula": "{Missing}" } }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn a_lookup_cycle_across_two_tables_is_rejected() {
    let l = linked().await;
    let inverse = &l.link["inverse"]; // Orders -> Table 1
    // lkA (in Table 1) looks up Orders.Price; lkB (in Orders) looks up lkA
    let lk_a =
        l.f.add_field(&l.f.table_id, lookup_body("lkA", &l.link, &l.price))
            .await;
    let lk_b =
        l.f.add_field(&l.orders, lookup_body("lkB", inverse, &lk_a))
            .await;
    // no cycle so far. Now make lkA look up lkB: lkA -> lkB -> lkA
    let r = l
        .f
        .app
        .patch(
            &l.f.owner,
            &format!("/api/fields/{}", sid(&lk_a["id"])),
            json!({ "type": "lookup", "options": { "link_field_id": l.link["id"], "target_field_id": lk_b["id"] } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("circular"),
        "{}",
        r.body
    );
    // unchanged
    let t1 = l.f.table(&l.f.table_id).await;
    let lk_a_now = t1["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "lkA")
        .unwrap();
    assert_eq!(lk_a_now["options"]["target_field_id"], l.price["id"]);
}

#[tokio::test]
async fn a_lookup_that_reaches_itself_through_a_self_link_is_rejected() {
    let f = Fixture::new().await;
    let link = f.add_link(&f.table_id, "Parent", &f.table_id).await;
    let primary = json!({ "id": f.primary_id });
    let lk = f
        .add_field(&f.table_id, lookup_body("ParentName", &link, &primary))
        .await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&lk["id"])),
            json!({ "type": "lookup", "options": { "link_field_id": link["id"], "target_field_id": lk["id"] } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("circular")
    );
}

#[tokio::test]
async fn the_cycle_check_follows_formula_references_in_stored_form() {
    // The placeholder formula integration rejects references, so build
    // formulas with `{fldX}` references directly in the database (what the
    // real engine will store) and run the check the API runs on every change.
    let f = Fixture::new().await;
    let table = f.table_id.clone();
    let insert = |id: &str, expr: &str| {
        let (id, table, expr) = (id.to_string(), table.clone(), expr.to_string());
        sql(&f.app, move |tx| {
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, ?1, 'formula', ?3, 50, 1)",
                rusqlite::params![
                    id,
                    table,
                    json!({ "expression": expr, "result_type": "text" }).to_string()
                ],
            )
        })
    };
    insert("fldAAA", "{fldBBB} + 1");
    insert("fldBBB", "{fldPrimary} + 1");
    let base = f.base_id.clone();
    let check = |base: String| {
        f.app
            .state
            .db
            .write_sync(move |tx| opengrid::store::schema::check_base_acyclic(tx, &base))
    };
    assert!(check(base.clone()).is_ok(), "A -> B -> primary is acyclic");
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE fields SET options = ?1 WHERE id = 'fldBBB'",
            [json!({ "expression": "{fldAAA}", "result_type": "text" }).to_string()],
        )
    });
    let err = check(base).unwrap_err().to_string();
    assert!(err.contains("circular"), "{err}");
    assert!(err.contains("fldAAA") || err.contains("fldBBB"));
}

#[tokio::test]
async fn deleting_a_link_field_trashes_what_is_built_on_it_and_restore_brings_it_back() {
    let l = linked().await;
    let url = fields_url(&l.f.table_id);
    let lk =
        l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
            .await;
    let count =
        l.f.add_field(
            &l.f.table_id,
            json!({ "name": "N", "type": "count", "options": { "link_field_id": l.link["id"] } }),
        )
        .await;
    let r =
        l.f.app
            .delete(&l.f.owner, &format!("/api/fields/{}", sid(&l.link["id"])))
            .await;
    r.assert_status(200);
    let deleted: Vec<&str> = r.body["deleted_field_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(sid)
        .collect();
    for expect in [
        sid(&l.link["id"]),
        sid(&l.link["inverse"]["id"]),
        sid(&lk["id"]),
        sid(&count["id"]),
    ] {
        assert!(
            deleted.contains(&expect),
            "{expect} should be deleted: {deleted:?}"
        );
    }
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes"]
    );

    // a dependent cannot come back before what it is built on
    let r =
        l.f.app
            .post(
                &l.f.owner,
                "/api/trash/restore",
                json!({ "kind": "field", "id": lk["id"] }),
            )
            .await;
    r.assert_status(409);

    let r =
        l.f.app
            .post(
                &l.f.owner,
                "/api/trash/restore",
                json!({ "kind": "field", "id": l.link["id"] }),
            )
            .await;
    r.assert_status(200);
    assert_eq!(r.body["restored_field_ids"].as_array().unwrap().len(), 4);
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes", "Orders", "Prices", "N"]
    );
    let _ = url;
}

#[tokio::test]
async fn dependents_deleted_earlier_stay_deleted_when_the_link_is_restored() {
    let l = linked().await;
    let lk =
        l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
            .await;
    l.f.app
        .delete(&l.f.owner, &format!("/api/fields/{}", sid(&lk["id"])))
        .await
        .assert_status(200);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    l.f.app
        .delete(&l.f.owner, &format!("/api/fields/{}", sid(&l.link["id"])))
        .await
        .assert_status(200);
    let r =
        l.f.app
            .post(
                &l.f.owner,
                "/api/trash/restore",
                json!({ "kind": "field", "id": l.link["id"] }),
            )
            .await;
    r.assert_status(200);
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes", "Orders"]
    );
    // and the lookup can be restored on its own now
    l.f.app
        .post(
            &l.f.owner,
            "/api/trash/restore",
            json!({ "kind": "field", "id": lk["id"] }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes", "Orders", "Prices"]
    );
}

#[tokio::test]
async fn deleting_a_lookup_target_trashes_the_lookup() {
    let l = linked().await;
    let lk =
        l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
            .await;
    let r =
        l.f.app
            .delete(&l.f.owner, &format!("/api/fields/{}", sid(&l.price["id"])))
            .await;
    r.assert_status(200);
    let deleted: Vec<&str> = r.body["deleted_field_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(sid)
        .collect();
    assert!(deleted.contains(&sid(&lk["id"])));
    assert!(deleted.contains(&sid(&l.price["id"])));
    assert!(
        !deleted.contains(&sid(&l.link["id"])),
        "the link itself stays"
    );
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes", "Orders"]
    );
}

#[tokio::test]
async fn changing_a_lookup_targets_type_refreshes_the_lookups_result_type() {
    let l = linked().await;
    let lk =
        l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
            .await;
    let lk2 =
        l.f.add_field(
            &l.orders,
            json!({ "name": "viaInverse", "type": "lookup",
        "options": { "link_field_id": l.link["inverse"]["id"], "target_field_id": lk["id"] } }),
        )
        .await;
    assert_eq!(lk["options"]["result_type"], array_of(ResultType::Number));
    l.f.app
        .patch(
            &l.f.owner,
            &format!("/api/fields/{}", sid(&l.price["id"])),
            json!({ "type": "checkbox", "options": {} }),
        )
        .await
        .assert_status(200);
    let t1 = l.f.table(&l.f.table_id).await;
    let now = t1["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == lk["id"])
        .unwrap();
    assert_eq!(now["options"]["result_type"], array_of(ResultType::Bool));
    // the lookup of the lookup follows (in topological order)
    let t2 = l.f.table(&l.orders).await;
    let now2 = t2["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == lk2["id"])
        .unwrap();
    assert_eq!(now2["options"]["result_type"], array_of(ResultType::Bool));
}

#[tokio::test]
async fn creating_computed_fields_materializes_them_and_keeps_editable_data() {
    let l = linked().await;
    let rec =
        l.f.insert_record(&l.f.table_id, json!({ &l.f.primary_id: "keep me" }));
    l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
        .await;
    let count =
        l.f.add_field(
            &l.f.table_id,
            json!({ "name": "N", "type": "count", "options": { "link_field_id": l.link["id"] } }),
        )
        .await;
    let formula =
        l.f.add_field(
            &l.f.table_id,
            json!({ "name": "F", "type": "formula", "options": { "expression": "1" } }),
        )
        .await;
    let data = l.f.record_data(&rec);
    // editable data untouched; count and formula materialized; the empty lookup is absent
    assert_eq!(data[&l.f.primary_id], "keep me");
    assert_eq!(data[sid(&count["id"])], 0);
    assert_eq!(data[sid(&formula["id"])], 1);
    assert_eq!(data.as_object().unwrap().len(), 3);
}

#[tokio::test]
async fn deleting_a_field_runs_the_recompute_hook_only_for_the_survivors() {
    // Smoke test: deleting something other fields reference must not error
    // even when dependents live in other tables.
    let l = linked().await;
    l.f.add_field(&l.f.table_id, lookup_body("Prices", &l.link, &l.price))
        .await;
    l.f.add_field(&l.orders, json!({ "name": "viaInv", "type": "count", "options": { "link_field_id": l.link["inverse"]["id"] } })).await;
    l.f.app
        .delete(
            &l.f.owner,
            &format!("/api/fields/{}", sid(&l.link["inverse"]["id"])),
        )
        .await
        .assert_status(200);
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.f.table_id).await),
        ["Name", "Notes"]
    );
    assert_eq!(
        Fixture::field_names(&l.f.table(&l.orders).await),
        ["Name", "Price"]
    );
}
