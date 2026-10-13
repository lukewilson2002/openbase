//! Formula fields through the API: name resolution, type inference, the
//! formula check endpoint and the roles that may use it.

mod common;
mod records_support;
mod schema_support;

use openbase::perm::Role;
use records_support::*;
use serde_json::{Value, json};

fn check_url(table_id: &str) -> String {
    format!("/api/tables/{table_id}/formula/check")
}

async fn check(f: &Fixture, table_id: &str, body: Value) -> common::Response {
    f.app.post(&f.owner, &check_url(table_id), body).await
}

#[tokio::test]
async fn check_reports_type_and_previews_the_first_record() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let price = f.number(&t, "Price").await;
    f.create(&t, json!({ sid(&price["id"]): 21, &f.primary_id: "first" }))
        .await;
    f.create(&t, json!({ sid(&price["id"]): 100 })).await;

    let r = check(&f, &t, json!({ "expression": "{Price} * 2" })).await;
    r.assert_status(200);
    assert_eq!(r.body["ok"], true);
    assert_eq!(r.body["result_type"], "number");
    assert_eq!(r.body["preview"], 42);
    assert!(r.body["error"].is_null());

    let r = check(&f, &t, json!({ "expression": "UPPER({Name}) & \"!\"" })).await;
    assert_eq!(r.body["result_type"], "text");
    assert_eq!(r.body["preview"], "FIRST!");

    // evaluate against a chosen record
    let second = f.order(&t)[1].clone();
    let r = check(
        &f,
        &t,
        json!({ "expression": "{Price} + 1", "record_id": second }),
    )
    .await;
    assert_eq!(r.body["preview"], 101);

    // other result types
    for (expr, ty) in [
        ("{Price} > 50", "bool"),
        ("TODAY()", "date"),
        ("{Name} & {Price}", "text"),
    ] {
        let r = check(&f, &t, json!({ "expression": expr })).await;
        assert_eq!(r.body["ok"], true, "{expr}: {}", r.body);
        assert_eq!(r.body["result_type"], ty, "{expr}");
    }
    let r = check(&f, &t, json!({ "expression": "{Price}" })).await;
    assert_eq!(r.body["result_type"], "number");
}

#[tokio::test]
async fn check_reports_errors_with_a_position() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    f.number(&t, "Price").await;
    for (expr, needle) in [
        ("{Nope} + 1", "Nope"),
        ("{Price} +", ""),
        ("NOSUCHFN(1)", "NOSUCHFN"),
        ("SUM(values)", "values"),
        ("IF({Price}", ""),
        ("", ""),
    ] {
        let r = check(&f, &t, json!({ "expression": expr })).await;
        r.assert_status(200);
        assert_eq!(r.body["ok"], false, "{expr}");
        let msg = r.body["error"]["message"].as_str().unwrap();
        assert!(msg.contains(needle), "{expr}: {msg}");
        assert!(r.body["result_type"].is_null());
        assert!(r.body["preview"].is_null());
    }
    let r = check(&f, &t, json!({ "expression": "{Price} + {Nope}" })).await;
    assert_eq!(
        r.body["error"]["pos"], 10,
        "byte offset of the unknown field"
    );
    let r = check(&f, &t, json!({ "expression": "1".repeat(10_001) })).await;
    assert_eq!(r.body["ok"], false);
}

#[tokio::test]
async fn check_previews_errors_and_handles_empty_tables() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    // no records: valid formula, no preview
    let r = check(&f, &t, json!({ "expression": "{N} + 1" })).await;
    assert_eq!(r.body["ok"], true);
    assert!(r.body["preview"].is_null());
    f.create(&t, json!({ sid(&n["id"]): 0 })).await;
    let r = check(&f, &t, json!({ "expression": "1 / {N}" })).await;
    assert_eq!(r.body["ok"], true, "a runtime error is not a syntax error");
    assert!(
        r.body["preview"]["error"]
            .as_str()
            .unwrap()
            .contains("ERROR")
    );
}

#[tokio::test]
async fn check_changes_nothing() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let rec = f.create(&t, json!({ sid(&n["id"]): 1 })).await;
    let fields_before = f.table(&t).await["fields"].clone();
    let data_before = f.record_data(sid(&rec["id"]));
    let history_before = f.history(sid(&rec["id"])).len();
    check(&f, &t, json!({ "expression": "{N} + 1" }))
        .await
        .assert_status(200);
    assert_eq!(f.table(&t).await["fields"], fields_before);
    assert_eq!(f.record_data(sid(&rec["id"])), data_before);
    assert_eq!(f.history(sid(&rec["id"])).len(), history_before);
}

#[tokio::test]
async fn check_validates_the_record_and_the_table() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let other = id_of(&f.add_table("Other").await);
    let foreign = f.create(&other, json!({})).await;
    let r = check(
        &f,
        &t,
        json!({ "expression": "1", "record_id": foreign["id"] }),
    )
    .await;
    r.assert_status(404);
    let r = check(&f, &t, json!({ "expression": "1", "record_id": "recNOPE" })).await;
    r.assert_status(404);
    let mine = f.create(&t, json!({})).await;
    f.delete_records(&t, &[sid(&mine["id"])])
        .await
        .assert_status(204);
    let r = check(
        &f,
        &t,
        json!({ "expression": "1", "record_id": mine["id"] }),
    )
    .await;
    r.assert_status(404);
    check(&f, "tblNOPE", json!({ "expression": "1" }))
        .await
        .assert_status(404);
    f.app
        .post(&f.owner, &check_url(&t), json!({ "nope": 1 }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn check_needs_the_editor_role() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    for role in ALL_ROLES {
        let who = f.member(&format!("{}-check@example.com", role.as_str()), role);
        let r = f
            .app
            .post(&who, &check_url(&t), json!({ "expression": "1 + 1" }))
            .await;
        let expected = if role >= Role::Editor { 200 } else { 403 };
        assert_eq!(r.status.as_u16(), expected, "{role:?}");
    }
    let stranger = f.app.user("stranger@example.com", "S");
    f.app
        .post(&stranger, &check_url(&t), json!({ "expression": "1" }))
        .await
        .assert_status(404);
    f.app
        .post(&f.app.anon(), &check_url(&t), json!({ "expression": "1" }))
        .await
        .assert_status(401);
    // tokens: write tokens act as the user, read-only tokens are viewers
    let ro = token_client(&f.app, &f.owner, false);
    f.app
        .post(&ro, &check_url(&t), json!({ "expression": "1" }))
        .await
        .assert_status(403);
    let rw = token_client(&f.app, &f.owner, true);
    f.app
        .post(&rw, &check_url(&t), json!({ "expression": "1" }))
        .await
        .assert_status(200);
}

// ------------------------------------------------------ field definitions

#[tokio::test]
async fn references_resolve_by_exact_name_or_case_insensitively_and_are_stored_by_id() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let price = f.number(&t, "Price").await;
    let qty = f.number(&t, "Quantity").await;
    // field names are unique ignoring case, so a case-insensitive match is never ambiguous
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{t}/fields"),
            json!({ "name": "price", "type": "number", "options": {} }),
        )
        .await
        .assert_status(409);
    let exact = f.formula(&t, "A", "{Price} + 1").await;
    let folded = f.formula(&t, "B", "{quantity} + {PRICE}").await;
    // the client sees the expression as typed back in canonical names
    assert_eq!(exact["options"]["expression"], "{Price} + 1");
    assert_eq!(folded["options"]["expression"], "{Quantity} + {Price}");
    let stored_expr = |name: &str| -> String {
        let (tid, name) = (t.clone(), name.to_string());
        sql(&f.app, move |tx| {
            tx.query_row(
                "SELECT json_extract(options, '$.expression') FROM fields WHERE table_id = ?1 AND name = ?2",
                [&tid, &name],
                |r| r.get(0),
            )
        })
    };
    assert_eq!(stored_expr("A"), format!("{{{}}} + 1", sid(&price["id"])));
    assert_eq!(
        stored_expr("B"),
        format!("{{{}}} + {{{}}}", sid(&qty["id"]), sid(&price["id"]))
    );
}

#[tokio::test]
async fn unknown_references_are_rejected() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    f.number(&t, "Total").await;
    for expr in ["{Nothing}", "{Total} + {Missing}", "{Tota}"] {
        let r = f
            .app
            .post(
                &f.owner,
                &format!("/api/tables/{t}/fields"),
                json!({ "name": "Bad", "type": "formula", "options": { "expression": expr } }),
            )
            .await;
        r.assert_status(400);
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("position"),
            "{}",
            r.body
        );
    }
    // nothing was created
    assert_eq!(f.table(&t).await["fields"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn formulas_are_shown_with_current_names_and_survive_renames() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let price = f.number(&t, "Price").await;
    let calc = f.formula(&t, "Calc", "{Price} * {Name}").await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&price["id"])),
            json!({ "name": "Cost (USD)" }),
        )
        .await
        .assert_status(200);
    let shown = f.field(&t, "Calc").await;
    assert_eq!(shown["options"]["expression"], "{Cost (USD)} * {Name}");
    // the base schema shows display form everywhere
    let schema = f.schema().await;
    let in_schema = schema["tables"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == calc["id"])
        .unwrap()
        .clone();
    assert_eq!(in_schema["options"]["expression"], "{Cost (USD)} * {Name}");
    // and the display form can be sent back as is
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&calc["id"])),
            json!({ "type": "formula", "options": { "expression": "{Cost (USD)} * 3" } }),
        )
        .await
        .assert_status(200);
    let rec = f.create(&t, json!({ sid(&price["id"]): 2 })).await;
    assert_eq!(rec["values"][sid(&calc["id"])], 6);
}

#[tokio::test]
async fn a_client_supplied_result_type_is_ignored() {
    let f = Fixture::new().await;
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/fields", f.table_id),
            json!({ "name": "X", "type": "formula",
                    "options": { "expression": "1 + 1", "result_type": "bool" } }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["options"]["result_type"], "number");
}

#[tokio::test]
async fn rollup_types_follow_the_target_and_the_expression() {
    let l = linked().await;
    let f = &l.f;
    let date = f
        .add_field(
            &l.t2,
            json!({ "name": "Due", "type": "date", "options": {} }),
        )
        .await;
    let latest = f
        .rollup(&l.t1, "Latest", &l.link, &date, "MAX(values)")
        .await;
    let names = f
        .rollup(&l.t1, "All", &l.link, &date, "ARRAYJOIN(values)")
        .await;
    let sum = f
        .rollup(&l.t1, "Sum", &l.link, &l.price, "SUM(values)")
        .await;
    assert_eq!(latest["options"]["result_type"], "date");
    assert_eq!(names["options"]["result_type"], "text");
    assert_eq!(sum["options"]["result_type"], "number");
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/fields", l.t1),
            json!({ "name": "Broken", "type": "rollup",
                    "options": { "link_field_id": l.link["id"], "target_field_id": l.price["id"],
                                 "expression": "NOSUCH(values)" } }),
        )
        .await;
    r.assert_status(400);
}

#[tokio::test]
async fn button_url_formulas_may_reference_fields() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let b = f
        .add_field(
            &t,
            json!({ "name": "Mail", "type": "button",
                    "options": { "label": "Mail", "url_formula": "\"mailto:\" & {Name}" } }),
        )
        .await;
    assert_eq!(b["options"]["url_formula"], "\"mailto:\" & {Name}");
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.primary_id),
            json!({ "name": "Email address" }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        f.field(&t, "Mail").await["options"]["url_formula"],
        "\"mailto:\" & {Email address}"
    );
    let rec = f
        .create(&t, json!({ &f.primary_id: "a@example.com" }))
        .await;
    assert_eq!(rec["values"][sid(&b["id"])], "mailto:a@example.com");
}

#[tokio::test]
async fn date_formulas_use_the_zone_of_their_format() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let when = f
        .add_field(
            &t,
            json!({ "name": "When", "type": "date", "options": { "include_time": true, "timezone": "UTC" } }),
        )
        .await;
    let utc = f.formula(&t, "Day UTC", "DAY({When})").await;
    let tokyo = f
        .add_field(
            &t,
            json!({ "name": "Day Tokyo", "type": "formula",
                    "options": { "expression": "DAY({When})",
                                 "format": { "kind": "date", "include_time": false, "timezone": "Asia/Tokyo" } } }),
        )
        .await;
    let rec = f
        .create(&t, json!({ sid(&when["id"]): "2026-01-01T23:30:00Z" }))
        .await;
    assert_eq!(rec["values"][sid(&utc["id"])], 1);
    assert_eq!(
        rec["values"][sid(&tokyo["id"])],
        2,
        "08:30 on the 2nd in Tokyo"
    );
}

#[tokio::test]
async fn formula_text_results_are_bounded() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let big = f.formula(&t, "Big", "REPT(\"abcdefghij\", 50000)").await;
    let rec = f.create(&t, json!({})).await;
    let v = &rec["values"][sid(&big["id"])];
    assert!(v["error"].as_str().unwrap().contains("too long"), "{v}");
}
