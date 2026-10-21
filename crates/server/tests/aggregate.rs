//! `POST /api/tables/{id}/aggregate`: count, sum, avg, min and max per group over a table's
//! records, the group values per field type, the filters (view and formula), ordering and
//! limits, the errors for combinations that make no sense, permissions, and correctness on a
//! table with thousands of records.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use std::collections::BTreeMap;

use common::Response;
use openbase::perm::Role;
use query_support::*;
use serde_json::{Value, json};

fn approx(v: &Value, expected: f64) {
    let got = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((got - expected).abs() < 1e-9, "{got} != {expected}");
}

async fn aggregate(f: &Fixture, body: Value) -> Response {
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{}/aggregate", f.table_id),
            body,
        )
        .await
}

async fn ok(f: &Fixture, body: Value) -> Value {
    let r = aggregate(f, body).await;
    r.assert_status(200);
    r.body.clone()
}

/// The error message of a 400 answer.
async fn bad(f: &Fixture, body: Value) -> String {
    let r = aggregate(f, body).await;
    r.assert_status(400);
    r.body["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("no message in {}", r.body))
        .to_string()
}

fn groups(resp: &Value) -> &Vec<Value> {
    resp["groups"].as_array().unwrap()
}

/// The group whose `field` value is `value`.
fn group<'a>(resp: &'a Value, field: &str, value: Value) -> &'a Value {
    groups(resp)
        .iter()
        .find(|g| g["group"][field] == value)
        .unwrap_or_else(|| panic!("no group {field}={value} in {resp}"))
}

fn aggs(group: &Value) -> &Value {
    &group["aggregates"]
}

#[tokio::test]
async fn without_group_by_one_row_of_totals() {
    let p = people().await;
    // Age: 30, 25, 41, (blank), 30; Done: only Carol; Due: 03-01, 03-10, 03-20, -, -.
    let resp = ok(
        &p.f,
        json!({ "aggregates": [
            { "function": "count" },
            { "function": "count", "field": "Age" },
            { "function": "count", "field": "Done" },
            { "function": "sum", "field": "Age" },
            { "function": "avg", "field": "Age" },
            { "function": "min", "field": "Age" },
            { "function": "max", "field": "Age" },
            { "function": "min", "field": "Due" },
            { "function": "max", "field": "Due" },
        ] }),
    )
    .await;
    assert_eq!(resp["group_by"], json!([]));
    assert_eq!(resp["record_count"], 5);
    assert_eq!(resp["total_groups"], 1);
    assert_eq!(resp["truncated"], false);
    let a = aggs(&groups(&resp)[0]);
    assert_eq!(groups(&resp)[0]["group"], json!({}));
    assert_eq!(a["count"], 5);
    assert_eq!(a["count_Age"], 4);
    assert_eq!(a["count_Done"], 1);
    assert_eq!(a["sum_Age"], 126);
    approx(&a["avg_Age"], 31.5);
    assert_eq!(a["min_Age"], 25);
    assert_eq!(a["max_Age"], 41);
    assert_eq!(a["min_Due"], "2026-03-01");
    assert_eq!(a["max_Due"], "2026-03-20");
}

#[tokio::test]
async fn default_is_one_count_and_aliases_rename() {
    let p = people().await;
    let resp = ok(&p.f, json!({})).await;
    assert_eq!(aggs(&groups(&resp)[0]), &json!({ "count": 5 }));
    let resp = ok(
        &p.f,
        json!({ "aggregates": [
            { "function": "sum", "field": &p.age, "alias": "total age" },
            { "function": "count", "alias": "n" },
        ] }),
    )
    .await;
    assert_eq!(
        aggs(&groups(&resp)[0]),
        &json!({ "total age": 126, "n": 5 })
    );
}

#[tokio::test]
async fn an_empty_table_still_has_one_row_of_totals_but_no_groups() {
    let p = people().await;
    let t = p.f.add_table("Empty").await;
    let tid = id_of(&t);
    p.f.number(&tid, "Qty").await;
    let url = format!("/api/tables/{tid}/aggregate");
    let r = p
        .f
        .app
        .post(
            &p.f.owner,
            &url,
            json!({ "aggregates": [{ "function": "count" }, { "function": "sum", "field": "Qty" },
                                   { "function": "avg", "field": "Qty" }, { "function": "min", "field": "Qty" }] }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(
        aggs(&groups(&r.body)[0]),
        &json!({ "count": 0, "sum_Qty": 0, "avg_Qty": null, "min_Qty": null })
    );
    let r =
        p.f.app
            .post(&p.f.owner, &url, json!({ "group_by": ["Qty"] }))
            .await;
    r.assert_status(200);
    assert_eq!(r.body["groups"], json!([]));
    assert_eq!(r.body["record_count"], 0);
}

#[tokio::test]
async fn single_select_groups_use_choice_names_in_choice_order_blank_first() {
    let p = people().await;
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Status"], "aggregates": [
            { "function": "count" }, { "function": "sum", "field": "Age" },
            { "function": "avg", "field": "Age" } ] }),
    )
    .await;
    assert_eq!(resp["group_by"], json!(["Status"]));
    let order: Vec<&Value> = groups(&resp)
        .iter()
        .map(|g| &g["group"]["Status"])
        .collect();
    assert_eq!(
        order,
        [
            &json!(null),
            &json!("Todo"),
            &json!("Doing"),
            &json!("Done")
        ]
    );
    let todo = aggs(group(&resp, "Status", json!("Todo")));
    assert_eq!(todo["count"], 2);
    assert_eq!(todo["sum_Age"], 60);
    assert_eq!(todo["avg_Age"], 30);
    // The empty group: dave, who has no age at all.
    let empty = aggs(group(&resp, "Status", Value::Null));
    assert_eq!(empty["count"], 1);
    assert_eq!(empty["sum_Age"], 0);
    assert_eq!(empty["avg_Age"], Value::Null);
    // No ids anywhere.
    let choice = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    assert!(!resp.to_string().contains(&choice));
    assert_eq!(resp["record_count"], 5);
}

#[tokio::test]
async fn multiple_select_groups_by_exact_combination_as_names() {
    let p = people().await;
    let resp = ok(&p.f, json!({ "group_by": ["Tags"] })).await;
    assert_eq!(groups(&resp).len(), 4);
    assert_eq!(aggs(group(&resp, "Tags", Value::Null))["count"], 2);
    assert_eq!(aggs(group(&resp, "Tags", json!(["a"])))["count"], 1);
    assert_eq!(aggs(group(&resp, "Tags", json!(["a", "b"])))["count"], 1);
    assert_eq!(aggs(group(&resp, "Tags", json!(["b"])))["count"], 1);
}

#[tokio::test]
async fn date_checkbox_number_and_text_groups() {
    let p = people().await;
    // Dates: calendar day, empty = null.
    let resp = ok(&p.f, json!({ "group_by": ["Due"] })).await;
    let days: Vec<&Value> = groups(&resp).iter().map(|g| &g["group"]["Due"]).collect();
    assert_eq!(
        days,
        [
            &json!(null),
            &json!("2026-03-01"),
            &json!("2026-03-10"),
            &json!("2026-03-20")
        ]
    );
    assert_eq!(aggs(group(&resp, "Due", Value::Null))["count"], 2);
    // Checkbox: booleans.
    let resp = ok(&p.f, json!({ "group_by": ["Done"] })).await;
    assert_eq!(aggs(group(&resp, "Done", json!(false)))["count"], 4);
    assert_eq!(aggs(group(&resp, "Done", json!(true)))["count"], 1);
    // Numbers stay numbers; blank is null.
    let resp = ok(&p.f, json!({ "group_by": ["Age"] })).await;
    let ages: Vec<&Value> = groups(&resp).iter().map(|g| &g["group"]["Age"]).collect();
    assert_eq!(ages, [&json!(null), &json!(25), &json!(30), &json!(41)]);
    assert_eq!(aggs(group(&resp, "Age", json!(30)))["count"], 2);
    // Text: the exact text.
    let resp = ok(&p.f, json!({ "group_by": [&p.name] })).await;
    assert_eq!(groups(&resp).len(), 5);
    assert_eq!(resp["group_by"], json!(["Name"]));
    assert_eq!(aggs(group(&resp, "Name", json!("Alice")))["count"], 1);
}

#[tokio::test]
async fn date_groups_use_the_requested_time_zone() {
    let p = people().await;
    let t = &p.f.table_id;
    p.f.add_field(
        t,
        json!({ "name": "At", "type": "date", "options": { "include_time": true } }),
    )
    .await;
    p.f.insert_record(
        t,
        json!({ &p.name: "late", &id_of(&p.f.field(t, "At").await): "2026-03-01T23:30:00.000Z" }),
    );
    let by = |tz: &str| json!({ "group_by": ["At"], "timezone": tz, "filter_by_formula": "{Name}='late'" });
    let utc = ok(&p.f, by("UTC")).await;
    assert_eq!(groups(&utc)[0]["group"]["At"], "2026-03-01");
    let tokyo = ok(&p.f, by("Asia/Tokyo")).await;
    assert_eq!(groups(&tokyo)[0]["group"]["At"], "2026-03-02");
    assert!(
        bad(&p.f, json!({ "timezone": "Mars/Base" }))
            .await
            .contains("time zone")
    );
}

#[tokio::test]
async fn two_levels_and_ordering_by_an_aggregate() {
    let p = people().await;
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Status", "Age"], "aggregates": [{ "function": "count" }] }),
    )
    .await;
    // (none, none) dave; (Todo, 30) x2; (Doing, 25); (Done, 41).
    assert_eq!(groups(&resp).len(), 4);
    let todo = groups(&resp)
        .iter()
        .find(|g| g["group"] == json!({ "Status": "Todo", "Age": 30 }))
        .unwrap();
    assert_eq!(aggs(todo)["count"], 2);

    // Biggest groups first; ties fall back to the group order.
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Status"], "sort": [{ "by": "count", "direction": "desc" }] }),
    )
    .await;
    let order: Vec<&Value> = groups(&resp)
        .iter()
        .map(|g| &g["group"]["Status"])
        .collect();
    assert_eq!(
        order,
        [
            &json!("Todo"),
            &json!(null),
            &json!("Doing"),
            &json!("Done")
        ]
    );
    // By a group field, descending.
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Age"], "sort": [{ "by": "Age", "direction": "desc" }] }),
    )
    .await;
    let ages: Vec<&Value> = groups(&resp).iter().map(|g| &g["group"]["Age"]).collect();
    assert_eq!(ages, [&json!(41), &json!(30), &json!(25), &json!(null)]);
    // Sorting by an average puts nulls last when descending.
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Status"],
                "aggregates": [{ "function": "avg", "field": "Age", "alias": "mean" }],
                "sort": [{ "by": "mean", "direction": "desc" }] }),
    )
    .await;
    let order: Vec<&Value> = groups(&resp)
        .iter()
        .map(|g| &g["group"]["Status"])
        .collect();
    assert_eq!(
        order,
        [
            &json!("Done"),
            &json!("Todo"),
            &json!("Doing"),
            &json!(null)
        ]
    );
}

#[tokio::test]
async fn limit_cuts_the_groups_and_says_so() {
    let p = people().await;
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Name"], "sort": [{ "by": "Name" }], "limit": 2 }),
    )
    .await;
    assert_eq!(groups(&resp).len(), 2);
    assert_eq!(resp["total_groups"], 5);
    assert_eq!(resp["truncated"], true);
    assert_eq!(resp["record_count"], 5);
    assert_eq!(groups(&resp)[0]["group"]["Name"], "Alice");
    let resp = ok(&p.f, json!({ "group_by": ["Name"], "limit": 5 })).await;
    assert_eq!(resp["truncated"], false);
    assert!(bad(&p.f, json!({ "limit": 0 })).await.contains("limit"));
    assert!(bad(&p.f, json!({ "limit": 10001 })).await.contains("limit"));
}

#[tokio::test]
async fn views_and_formulas_narrow_the_records_like_listing() {
    let p = people().await;
    let by_status = json!({ "group_by": ["Status"] });
    // A view's filter.
    let senior =
        p.f.new_view(
            &p.f.table_id,
            "Senior",
            json!({ "filter": and(vec![cond(&p.age, "gt", json!(26))]) }),
        )
        .await;
    let mut body = by_status.clone();
    body["view"] = json!("Senior");
    let resp = ok(&p.f, body.clone()).await;
    assert_eq!(resp["record_count"], 3);
    assert_eq!(aggs(group(&resp, "Status", json!("Todo")))["count"], 2);
    assert_eq!(aggs(group(&resp, "Status", json!("Done")))["count"], 1);
    body["view"] = json!(senior);
    assert_eq!(ok(&p.f, body).await["record_count"], 3);
    // A formula.
    let mut body = by_status.clone();
    body["filter_by_formula"] = json!("{Age}=30");
    let resp = ok(&p.f, body.clone()).await;
    assert_eq!(resp["record_count"], 2);
    assert_eq!(groups(&resp).len(), 1);
    // Both: the view first, then the formula.
    body["view"] = json!("Senior");
    body["filter_by_formula"] = json!("{Status}='Done'");
    let resp = ok(&p.f, body).await;
    assert_eq!(resp["record_count"], 1);
    assert_eq!(groups(&resp)[0]["group"]["Status"], "Done");
    // Blank formula = no formula.
    let mut body = by_status;
    body["filter_by_formula"] = json!("  ");
    assert_eq!(ok(&p.f, body).await["record_count"], 5);
}

#[tokio::test]
async fn trashed_records_and_later_edits_are_reflected() {
    let p = people().await;
    let total = |resp: &Value| aggs(&groups(resp)[0])["sum_Age"].clone();
    let body = json!({ "aggregates": [{ "function": "sum", "field": "Age" }] });
    assert_eq!(total(&ok(&p.f, body.clone()).await), 126);
    p.f.delete_records(&p.f.table_id, &[&p.ids[2]])
        .await
        .assert_status(204);
    assert_eq!(total(&ok(&p.f, body.clone()).await), 85);
    p.f.set(&p.f.table_id, &p.ids[0], json!({ &p.age: 100 }))
        .await;
    assert_eq!(total(&ok(&p.f, body.clone()).await), 155);
    // Also through a view (the cached id list of a view must not go stale).
    let mut with_view = body.clone();
    with_view["view"] = json!("Grid view");
    let first = total(&ok(&p.f, with_view.clone()).await);
    assert_eq!(first, 155);
    p.f.set(&p.f.table_id, &p.ids[0], json!({ &p.age: 30 }))
        .await;
    assert_eq!(total(&ok(&p.f, with_view).await), 85);
}

#[tokio::test]
async fn computed_fields_group_and_sum() {
    let p = people().await;
    let t = &p.f.table_id;
    p.f.formula(t, "Double", "{Age} * 2").await;
    p.f.formula(t, "Band", "IF({Age} >= 30, \"senior\", \"junior\")")
        .await;
    let resp = ok(
        &p.f,
        json!({ "group_by": ["Band"], "aggregates": [
            { "function": "sum", "field": "Double" }, { "function": "max", "field": "Double" } ] }),
    )
    .await;
    let senior = aggs(group(&resp, "Band", json!("senior")));
    assert_eq!(senior["sum_Double"], 202);
    assert_eq!(senior["max_Double"], 82);
    assert_eq!(
        aggs(group(&resp, "Band", json!("junior")))["sum_Double"],
        50
    );
}

#[tokio::test]
async fn linked_records_group_by_name_but_stay_distinct_by_record() {
    let l = linked().await;
    let name_field = l.f.primary_id.clone();
    // Two customers with the same name, one with another; orders link to them.
    let c1 = l.f.create(&l.t1, json!({ &name_field: "Acme" })).await;
    let c2 = l.f.create(&l.t1, json!({ &name_field: "Acme" })).await;
    let c3 = l.f.create(&l.t1, json!({ &name_field: "Zed" })).await;
    let customer = l.inverse["id"].as_str().unwrap().to_string();
    let price_id = l.price["id"].as_str().unwrap().to_string();
    for (cust, price) in [(&c1, 10), (&c1, 5), (&c2, 7), (&c3, 100)] {
        l.f.create(&l.t2, json!({ &price_id: price, &customer: [id_of(cust)] }))
            .await;
    }
    l.f.create(&l.t2, json!({ &price_id: 1 })).await;
    let r =
        l.f.app
            .post(
                &l.f.owner,
                &format!("/api/tables/{}/aggregate", l.t2),
                json!({ "group_by": [l.inverse["name"]],
                    "aggregates": [{ "function": "sum", "field": "Price" }] }),
            )
            .await;
    r.assert_status(200);
    let key = l.inverse["name"].as_str().unwrap();
    let g = groups(&r.body);
    // (none) 1, [Acme] 15, [Acme] 7 (another record), [Zed] 100: four groups, names only.
    assert_eq!(g.len(), 4, "{}", r.body);
    let sums: Vec<(Value, Value)> = g
        .iter()
        .map(|x| (x["group"][key].clone(), aggs(x)["sum_Price"].clone()))
        .collect();
    assert!(sums.contains(&(Value::Null, json!(1))), "{sums:?}");
    assert!(sums.contains(&(json!(["Acme"]), json!(15))), "{sums:?}");
    assert!(sums.contains(&(json!(["Acme"]), json!(7))), "{sums:?}");
    assert!(sums.contains(&(json!(["Zed"]), json!(100))), "{sums:?}");
    assert!(!r.body.to_string().contains(&id_of(&c1)));
    // A trashed customer no longer names the group.
    l.f.delete_records(&l.t1, &[&id_of(&c3)])
        .await
        .assert_status(204);
    let r =
        l.f.app
            .post(
                &l.f.owner,
                &format!("/api/tables/{}/aggregate", l.t2),
                json!({ "group_by": [key] }),
            )
            .await;
    r.assert_status(200);
    assert!(
        groups(&r.body)
            .iter()
            .all(|x| x["group"][key] != json!(["Zed"]))
    );
    assert_eq!(aggs(group(&r.body, key, Value::Null))["count"], 2);
}

#[tokio::test]
async fn invalid_requests_say_what_is_wrong_and_what_would_work() {
    let p = people().await;
    let f = &p.f;
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "sum", "field": "Name" }] }),
    )
    .await;
    assert!(m.contains("Cannot sum \"Name\""), "{m}");
    assert!(m.contains("text") && m.contains("\"Age\""), "{m}");
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "avg", "field": "Status" }] }),
    )
    .await;
    assert!(m.contains("single_select") && m.contains("number"), "{m}");
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "max", "field": "Tags" }] }),
    )
    .await;
    assert!(
        m.contains("multiple_select") && m.contains("\"Due\""),
        "{m}"
    );
    let m = bad(f, json!({ "aggregates": [{ "function": "sum" }] })).await;
    assert!(m.contains("needs a `field`"), "{m}");
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "sum", "field": "Nope" }] }),
    )
    .await;
    assert!(m.contains("Nope"), "{m}");
    let m = bad(f, json!({ "group_by": ["Nope"] })).await;
    assert!(m.contains("Nope"), "{m}");
    let m = bad(f, json!({ "group_by": ["Age", "Age"] })).await;
    assert!(m.contains("more than once"), "{m}");
    let m = bad(f, json!({ "group_by": ["Name", "Age", "Status", "Due"] })).await;
    assert!(m.contains("at most 3"), "{m}");
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "count" }, { "function": "count" }] }),
    )
    .await;
    assert!(m.contains("\"count\"") && m.contains("alias"), "{m}");
    let m = bad(f, json!({ "sort": [{ "by": "nothing" }] })).await;
    assert!(m.contains("nothing") && m.contains("\"count\""), "{m}");
    let m = bad(f, json!({ "view": "No such view" })).await;
    assert!(m.contains("No such view"), "{m}");
    let m = bad(f, json!({ "filter_by_formula": "{Age} =" })).await;
    assert!(m.contains("formula"), "{m}");
    // Malformed bodies are plain 400s too.
    for body in [
        json!({ "aggregates": [{ "function": "median", "field": "Age" }] }),
        json!({ "group_by": "Status" }),
        json!({ "whatever": 1 }),
    ] {
        aggregate(f, body).await.assert_status(400);
    }
    // Buttons cannot be grouped or counted.
    f.add_field(
        &f.table_id,
        json!({ "name": "Go", "type": "button", "options": { "label": "Go", "url_formula": "\"https://example.com\"" } }),
    )
    .await;
    let m = bad(f, json!({ "group_by": ["Go"] })).await;
    assert!(
        m.contains("Cannot group by \"Go\"") && m.contains("button"),
        "{m}"
    );
    let m = bad(
        f,
        json!({ "aggregates": [{ "function": "count", "field": "Go" }] }),
    )
    .await;
    assert!(m.contains("Cannot count"), "{m}");
}

#[tokio::test]
async fn permissions_follow_listing() {
    let p = people().await;
    let url = format!("/api/tables/{}/aggregate", p.f.table_id);
    let body = json!({ "group_by": ["Status"] });
    // Every role may aggregate, and so may a base guest.
    for role in ALL_ROLES {
        let u =
            p.f.member(&format!("{}-user@example.com", role.as_str()), role);
        p.f.app
            .post(&u, &url, body.clone())
            .await
            .assert_status(200);
    }
    let guest = p.f.base_guest("guest@example.com", Role::Viewer);
    p.f.app
        .post(&guest, &url, body.clone())
        .await
        .assert_status(200);
    // Strangers and anonymous callers get 404 / 401, never data.
    let stranger = p.f.app.user("stranger@example.com", "Stranger");
    p.f.app
        .post(&stranger, &url, body.clone())
        .await
        .assert_status(404);
    p.f.app
        .post(&p.f.app.anon(), &url, body.clone())
        .await
        .assert_status(401);
    p.f.app
        .post(&p.f.owner, "/api/tables/tblNope/aggregate", body.clone())
        .await
        .assert_status(404);
    // A read-only API token works: this POST only reads.
    let ro = token_client(&p.f.app, &p.f.owner, false);
    let r = p.f.app.post(&ro, &url, body.clone()).await;
    r.assert_status(200);
    assert_eq!(r.body["record_count"], 5);
    // Someone else's personal view is not found.
    let editor = p.f.member("someone@example.com", Role::Editor);
    let r =
        p.f.app
            .post(
                &editor,
                &format!("/api/tables/{}/views", p.f.table_id),
                json!({ "name": "Mine", "type": "grid", "personal": true }),
            )
            .await;
    r.assert_status(201);
    let r =
        p.f.app
            .post(&p.f.owner, &url, json!({ "view": "Mine" }))
            .await;
    r.assert_status(400);
}

// ------------------------------------------------------------------------- large tables

const ROWS: usize = 20_000;
const REGIONS: [&str; 4] = ["North", "South", "East", "West"];

#[derive(Default, Clone)]
struct Expect {
    count: u64,
    filled: u64,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
}

impl Expect {
    fn add(&mut self, amount: Option<f64>) {
        self.count += 1;
        if let Some(a) = amount {
            self.filled += 1;
            self.sum += a;
            self.min = Some(self.min.map_or(a, |m| m.min(a)));
            self.max = Some(self.max.map_or(a, |m| m.max(a)));
        }
    }
    fn avg(&self) -> Option<f64> {
        (self.filled > 0).then(|| self.sum / self.filled as f64)
    }
}

/// Region (select), Amount (number, blank every 10th), Shipped (checkbox) and Day (date) of the
/// i-th record of the large table.
fn row(i: usize) -> (usize, Option<f64>, bool, String) {
    let amount = (i % 10 != 0).then_some((i % 97) as f64 + (i % 4) as f64 * 0.25);
    (
        i % 4,
        amount,
        i % 3 == 0,
        format!("2026-03-{:02}", i % 28 + 1),
    )
}

#[tokio::test]
async fn thousands_of_records_aggregate_correctly() {
    let f = Fixture::new().await;
    let t = id_of(&f.add_table("Orders").await);
    let region = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Region", "type": "single_select",
                    "options": { "choices": REGIONS.iter().map(|r| json!({ "name": r })).collect::<Vec<_>>() } }),
        )
        .await,
    );
    let amount = id_of(&f.number(&t, "Amount").await);
    let shipped = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Shipped", "type": "checkbox", "options": {} }),
        )
        .await,
    );
    let day = id_of(
        &f.add_field(&t, json!({ "name": "Day", "type": "date", "options": {} }))
            .await,
    );
    let mut choice = Vec::new();
    for r in REGIONS {
        choice.push(f.choice_id(&t, "Region", r).await);
    }
    schema_support::sql(&f.app, |tx| {
        let mut stmt = tx.prepare(
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1000, 1000)",
        )?;
        for i in 0..ROWS {
            let (r, a, s, d) = row(i);
            let mut data = json!({ &region: choice[r], &shipped: s, &day: d });
            if let Some(a) = a {
                data[&amount] = json!(a);
            }
            stmt.execute(rusqlite::params![
                openbase::ids::new_id("rec"),
                t,
                data.to_string(),
                i as f64 + 1.0,
                i as i64 + 1
            ])?;
        }
        Ok(())
    });
    let url = format!("/api/tables/{t}/aggregate");
    let run = |body: Value| {
        let (f, url) = (&f, &url);
        async move {
            let r = f.app.post(&f.owner, url, body).await;
            r.assert_status(200);
            r.body.clone()
        }
    };
    let measures = json!([
        { "function": "count" }, { "function": "count", "field": "Amount" },
        { "function": "sum", "field": "Amount" }, { "function": "avg", "field": "Amount" },
        { "function": "min", "field": "Amount" }, { "function": "max", "field": "Amount" },
    ]);
    let check = |g: &Value, e: &Expect| {
        let a = aggs(g);
        assert_eq!(a["count"], e.count);
        assert_eq!(a["count_Amount"], e.filled);
        approx(&a["sum_Amount"], e.sum);
        match e.avg() {
            Some(v) => approx(&a["avg_Amount"], v),
            None => assert_eq!(a["avg_Amount"], Value::Null),
        }
        approx(&a["min_Amount"], e.min.unwrap());
        approx(&a["max_Amount"], e.max.unwrap());
    };

    // Totals.
    let mut total = Expect::default();
    (0..ROWS).for_each(|i| total.add(row(i).1));
    let resp = run(json!({ "aggregates": measures })).await;
    assert_eq!(resp["record_count"], ROWS);
    check(&groups(&resp)[0], &total);

    // By region.
    let mut by_region = vec![Expect::default(); 4];
    (0..ROWS).for_each(|i| by_region[row(i).0].add(row(i).1));
    let resp = run(json!({ "group_by": ["Region"], "aggregates": measures })).await;
    assert_eq!(groups(&resp).len(), 4);
    for (r, e) in REGIONS.iter().zip(&by_region) {
        check(group(&resp, "Region", json!(r)), e);
    }
    assert_eq!(
        groups(&resp)
            .iter()
            .map(|g| aggs(g)["count"].as_u64().unwrap())
            .sum::<u64>(),
        ROWS as u64
    );

    // By day and shipped (28 x 2 groups), a date and a boolean key at once.
    let mut by_day: BTreeMap<(String, bool), Expect> = BTreeMap::new();
    for i in 0..ROWS {
        let (_, a, s, d) = row(i);
        by_day.entry((d, s)).or_default().add(a);
    }
    let resp =
        run(json!({ "group_by": ["Day", "Shipped"], "aggregates": measures, "limit": 100 })).await;
    assert_eq!(resp["total_groups"], by_day.len());
    assert_eq!(groups(&resp).len(), by_day.len());
    for g in groups(&resp) {
        let key = (
            g["group"]["Day"].as_str().unwrap().to_string(),
            g["group"]["Shipped"].as_bool().unwrap(),
        );
        check(g, &by_day[&key]);
    }
    // Default order: by day, then unshipped before shipped.
    let keys: Vec<(String, bool)> = groups(&resp)
        .iter()
        .map(|g| {
            (
                g["group"]["Day"].as_str().unwrap().into(),
                g["group"]["Shipped"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(keys, by_day.keys().cloned().collect::<Vec<_>>());

    // A formula over the whole table, grouped: the same numbers computed here.
    let mut hi = vec![Expect::default(); 4];
    for i in 0..ROWS {
        let (r, a, _, _) = row(i);
        if a.is_some_and(|a| a > 50.0) {
            hi[r].add(a);
        }
    }
    let resp = run(json!({ "group_by": ["Region"], "aggregates": measures,
                           "filter_by_formula": "{Amount} > 50" }))
    .await;
    assert_eq!(
        resp["record_count"],
        hi.iter().map(|e| e.count).sum::<u64>()
    );
    for (r, e) in REGIONS.iter().zip(&hi) {
        check(group(&resp, "Region", json!(r)), e);
    }

    // A view filter and a formula together.
    let shipped_only = f
        .new_view(
            &t,
            "Shipped",
            json!({ "filter": and(vec![cond(&shipped, "is", json!(true))]) }),
        )
        .await;
    let mut both = vec![Expect::default(); 4];
    for i in 0..ROWS {
        let (r, a, s, _) = row(i);
        if s && r < 2 {
            both[r].add(a);
        }
    }
    let resp = run(
        json!({ "view": shipped_only, "group_by": ["Region"], "aggregates": measures,
                           "filter_by_formula": "OR({Region}='North', {Region}='South')" }),
    )
    .await;
    assert_eq!(groups(&resp).len(), 2);
    for r in 0..2 {
        check(group(&resp, "Region", json!(REGIONS[r])), &both[r]);
    }

    // Top groups by sum.
    let resp = run(
        json!({ "group_by": ["Day"], "aggregates": [{ "function": "sum", "field": "Amount" }],
                           "sort": [{ "by": "sum_Amount", "direction": "desc" }], "limit": 3 }),
    )
    .await;
    let mut sums: BTreeMap<String, f64> = BTreeMap::new();
    for i in 0..ROWS {
        let (_, a, _, d) = row(i);
        *sums.entry(d).or_default() += a.unwrap_or(0.0);
    }
    let mut best: Vec<f64> = sums.values().copied().collect();
    best.sort_by(|a, b| b.total_cmp(a));
    assert_eq!(groups(&resp).len(), 3);
    assert_eq!(resp["truncated"], true);
    for (g, want) in groups(&resp).iter().zip(&best) {
        approx(&aggs(g)["sum_Amount"], *want);
    }
}
