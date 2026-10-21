//! Grouping by a date with a granularity (day, week, month, quarter, year): group headers, order,
//! the "No date" group, the viewer's time zone and validation, through the REST API and MCP.

mod common;
mod mcp_support;
mod query_support;
mod records_support;
mod schema_support;

use query_support::*;
use serde_json::{Value, json};

/// (label, count) of each group header.
fn headers(resp: &Value) -> Vec<(String, u64)> {
    resp["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["label"].as_str().unwrap().to_string(),
                g["count"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn pairs(list: &[(&str, u64)]) -> Vec<(String, u64)> {
    list.iter().map(|(l, c)| (l.to_string(), *c)).collect()
}

/// [`people`] plus two records dated in other months and years: Frank 2025-12-31 and Gina
/// 2026-04-02 (Alice, bob and Carol are in March 2026; dave and Eve have no date).
async fn dated() -> People {
    let p = people().await;
    let r =
        p.f.app
            .post(
                &p.f.owner,
                &records_url(&p.f.table_id),
                json!({ "records": [
                { "values": { &p.name: "Frank", &p.due: "2025-12-31" } },
                { "values": { &p.name: "Gina", &p.due: "2026-04-02" } },
            ] }),
            )
            .await;
    r.assert_status(201);
    p
}

#[tokio::test]
async fn date_groups_bucket_by_month_and_year_in_order() {
    let p = dated().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.due, "granularity": "month" } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(
        headers(&resp),
        pairs(&[
            ("No date", 2),
            ("December 2025", 1),
            ("March 2026", 3),
            ("April 2026", 1)
        ])
    );
    let g = &resp["groups"][2];
    assert_eq!(g["key"], "2026-03");
    // A record added to the group starts on the month's first day.
    assert_eq!(g["value"], "2026-03-01");
    assert_eq!(resp["groups"][0]["value"], Value::Null);

    // Descending puts the latest period first and "No date" last.
    p.f.configure(json!({ "groups": [
        { "field_id": p.due, "direction": "desc", "granularity": "year" } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(
        headers(&resp),
        pairs(&[("2026", 4), ("2025", 1), ("No date", 2)])
    );
    assert_eq!(resp["groups"][0]["value"], "2026-01-01");

    // The saved config keeps the granularity.
    let saved = p
        .f
        .app
        .patch(
            &p.f.owner,
            &format!("/api/views/{}", p.view()),
            json!({ "config": { "groups": [ { "field_id": p.due, "granularity": "quarter" } ] } }),
        )
        .await;
    saved.assert_status(200);
    assert_eq!(saved.body["config"]["groups"][0]["granularity"], "quarter");

    // Day reads as a full date; weeks start on Monday.
    p.f.configure(json!({ "groups": [ { "field_id": p.due } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["groups"][1]["label"], "December 31, 2025");
    p.f.configure(json!({ "groups": [ { "field_id": p.due, "granularity": "week" } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    let labels: Vec<String> = headers(&resp).into_iter().map(|(l, _)| l).collect();
    assert_eq!(
        labels,
        [
            "No date",
            "Week of December 29, 2025",
            "Week of February 23, 2026",
            "Week of March 9, 2026",
            "Week of March 16, 2026",
            "Week of March 30, 2026"
        ]
    );
}

#[tokio::test]
async fn a_transient_override_can_change_the_granularity() {
    let p = dated().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.due } ] }))
        .await;
    let resp =
        p.f.query(json!({ "transient": { "groups": [
            { "field_id": p.due, "granularity": "quarter" } ] } }))
            .await;
    assert_eq!(
        headers(&resp),
        pairs(&[
            ("No date", 2),
            ("Q4 2025", 1),
            ("Q1 2026", 3),
            ("Q2 2026", 1)
        ])
    );
}

#[tokio::test]
async fn date_times_fall_into_the_viewers_period() {
    let p = people().await;
    let t = &p.f.table_id;
    let at = id_of(
        &p.f.add_field(
            t,
            json!({ "name": "At", "type": "date", "options": { "include_time": true } }),
        )
        .await,
    );
    // 31 December 23:30 UTC is already New Year's Day in Auckland.
    let r =
        p.f.app
            .post(
                &p.f.owner,
                &records_url(t),
                json!({ "records": [ { "values": { &at: "2026-12-31T23:30:00.000Z" } } ] }),
            )
            .await;
    r.assert_status(201);
    p.f.configure(json!({ "groups": [ { "field_id": at, "granularity": "year" } ] }))
        .await;
    let utc = p.f.query(json!({ "timezone": "UTC" })).await;
    assert_eq!(utc["groups"][1]["label"], "2026");
    let akl = p.f.query(json!({ "timezone": "Pacific/Auckland" })).await;
    assert_eq!(akl["groups"][1]["label"], "2027");
}

#[tokio::test]
async fn a_granularity_needs_a_date_field() {
    let p = people().await;
    let r = p
        .f
        .app
        .patch(
            &p.f.owner,
            &format!("/api/views/{}", p.view()),
            json!({ "config": { "groups": [ { "field_id": p.age, "granularity": "month" } ] } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body.to_string().contains("needs a date field"),
        "{}",
        r.body
    );
    let r = p
        .f
        .app
        .patch(
            &p.f.owner,
            &format!("/api/views/{}", p.view()),
            json!({ "config": { "groups": [ { "field_id": p.due, "granularity": "fortnight" } ] } }),
        )
        .await;
    assert_eq!(r.status.as_u16(), 400, "{}", r.body);
}

#[tokio::test]
async fn agents_group_by_month_through_mcp() {
    use mcp_support::Rig;
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Due", "date", json!({})).await;
    a.call(
        "create_records",
        json!({"base_id": b, "table": "Tasks", "records": [
            {"fields": {"Name": "a", "Due": "2026-10-21"}},
            {"fields": {"Name": "b", "Due": "2026-10-02"}},
            {"fields": {"Name": "c", "Due": "2026-09-30"}},
            {"fields": {"Name": "d"}},
        ]}),
    )
    .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "By month", "type": "grid"}),
    )
    .await;
    let v = a
        .call(
            "update_view",
            json!({"base_id": b, "view": "By month", "config": {
                "groups": [{"field_id": "Due", "direction": "desc", "granularity": "month"}]}}),
        )
        .await;
    assert_eq!(
        v["view"]["config"]["groups"],
        json!([{"field_id": "Due", "direction": "desc", "granularity": "month"}])
    );
    let q = a
        .call("query_view", json!({"base_id": b, "view": "By month"}))
        .await;
    let got: Vec<(&str, u64)> = q["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| (g["label"].as_str().unwrap(), g["count"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        got,
        [("October 2026", 2), ("September 2026", 1), ("No date", 1)]
    );
    let e = a
        .fails(
            "update_view",
            json!({"base_id": b, "view": "By month", "config": {
                "groups": [{"field_id": "Name", "granularity": "year"}]}}),
        )
        .await;
    assert!(e.contains("needs a date field"), "{e}");
    let e = a
        .fails(
            "update_view",
            json!({"base_id": b, "view": "By month", "config": {
                "sorts": [{"field_id": "Due", "granularity": "year"}]}}),
        )
        .await;
    assert!(e.contains("unknown key 'granularity'"), "{e}");
}

#[tokio::test]
async fn a_date_field_retyped_to_text_keeps_the_view_working() {
    let p = dated().await;
    let config = json!({ "groups": [ { "field_id": p.due, "granularity": "month" } ] });
    p.f.configure(config.clone()).await;
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/fields/{}", p.due),
            json!({ "type": "single_line_text", "options": {} }),
        )
        .await
        .assert_status(200);
    // The text groups by exact value; the leftover granularity is ignored and
    // a client may send the saved config back unchanged.
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["groups"][0]["label"], "(Empty)");
    assert_eq!(resp["groups"].as_array().unwrap().len(), 6);
    p.f.configure(config).await;
}
