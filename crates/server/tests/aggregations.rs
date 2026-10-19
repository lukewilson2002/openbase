//! `GET /api/views/{id}/aggregations`: summary-bar values per field type over
//! the view's filtered records, and the link picker lookup that shares the
//! scan code.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use openbase::perm::Role;
use query_support::*;
use serde_json::{Value, json};

fn approx(v: &Value, expected: f64) {
    let got = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((got - expected).abs() < 1e-9, "{got} != {expected}");
}

async fn summarize(p: &People, summaries: Value) -> Value {
    p.f.configure(json!({ "summaries": summaries })).await;
    p.f.aggregations(p.view()).await
}

#[tokio::test]
async fn number_statistics() {
    let p = people().await;
    // Age: 30, 25, 41, (blank), 30
    let agg = |name: &str| json!({ &p.age: name });
    assert_eq!(summarize(&p, agg("sum")).await[&p.age], 126);
    approx(&summarize(&p, agg("average")).await[&p.age], 31.5);
    assert_eq!(summarize(&p, agg("median")).await[&p.age], 30);
    assert_eq!(summarize(&p, agg("min")).await[&p.age], 25);
    assert_eq!(summarize(&p, agg("max")).await[&p.age], 41);
    assert_eq!(summarize(&p, agg("range")).await[&p.age], 16);
    approx(
        &summarize(&p, agg("std_dev")).await[&p.age],
        (137.0f64 / 3.0).sqrt(),
    );
}

#[tokio::test]
async fn counts_and_percentages_of_filled_and_unique_cells() {
    let p = people().await;
    let agg = |name: &str| json!({ &p.age: name });
    assert_eq!(summarize(&p, agg("empty")).await[&p.age], 1);
    assert_eq!(summarize(&p, agg("filled")).await[&p.age], 4);
    approx(&summarize(&p, agg("percent_empty")).await[&p.age], 0.2);
    approx(&summarize(&p, agg("percent_filled")).await[&p.age], 0.8);
    assert_eq!(summarize(&p, agg("unique")).await[&p.age], 3);
    approx(&summarize(&p, agg("percent_unique")).await[&p.age], 0.6);
}

#[tokio::test]
async fn several_fields_are_summarized_at_once() {
    let p = people().await;
    let values = summarize(
        &p,
        json!({
            &p.name: "unique",
            &p.age: "sum",
            &p.status: "filled",
            &p.tags: "empty",
            &p.done: "checked",
            &p.due: "earliest_date",
        }),
    )
    .await;
    assert_eq!(values[&p.name], 5);
    assert_eq!(values[&p.age], 126);
    assert_eq!(values[&p.status], 4);
    assert_eq!(values[&p.tags], 2);
    assert_eq!(values[&p.done], 1);
    assert_eq!(values[&p.due], "2026-03-01");
    assert_eq!(values.as_object().unwrap().len(), 6);
}

#[tokio::test]
async fn checkbox_and_date_aggregations() {
    let p = people().await;
    let agg = |f: &str, name: &str| json!({ f: name });
    let done = &p.done;
    assert_eq!(summarize(&p, agg(done, "checked")).await[done], 1);
    assert_eq!(summarize(&p, agg(done, "unchecked")).await[done], 4);
    approx(
        &summarize(&p, agg(done, "percent_checked")).await[done],
        0.2,
    );
    approx(
        &summarize(&p, agg(done, "percent_unchecked")).await[done],
        0.8,
    );
    let due = &p.due;
    assert_eq!(
        summarize(&p, agg(due, "earliest_date")).await[due],
        "2026-03-01"
    );
    assert_eq!(
        summarize(&p, agg(due, "latest_date")).await[due],
        "2026-03-20"
    );
    assert_eq!(summarize(&p, agg(due, "date_range_days")).await[due], 19);
}

#[tokio::test]
async fn select_and_multiple_select_unique_counts() {
    let p = people().await;
    // Status: Todo, Doing, Done, -, Todo -> 3 unique of 4 filled.
    let v = summarize(&p, json!({ &p.status: "unique", &p.tags: "unique" })).await;
    assert_eq!(v[&p.status], 3);
    // Tags: [a], [a,b], -, -, [b] -> three distinct combinations.
    assert_eq!(v[&p.tags], 3);
}

#[tokio::test]
async fn aggregations_cover_the_view_filter_but_not_search_or_paging() {
    let p = people().await;
    p.f.configure(json!({
        "filter": and(vec![cond(&p.age, "gt", json!(26))]),
        "summaries": { &p.age: "sum", &p.name: "filled" },
    }))
    .await;
    // Alice 30 + Carol 41 + Eve 30.
    let v = p.f.aggregations(p.view()).await;
    assert_eq!(v[&p.age], 101);
    assert_eq!(v[&p.name], 3);
    // The same view queried with a search or a small page does not change it.
    p.f.query(json!({ "search": "alice", "limit": 1 })).await;
    assert_eq!(p.f.aggregations(p.view()).await[&p.age], 101);
}

#[tokio::test]
async fn aggregations_ignore_trashed_records_and_follow_edits() {
    let p = people().await;
    p.f.configure(json!({ "summaries": { &p.age: "sum" } }))
        .await;
    assert_eq!(p.f.aggregations(p.view()).await[&p.age], 126);
    p.f.delete_records(&p.f.table_id, &[&p.ids[2]])
        .await
        .assert_status(204);
    assert_eq!(p.f.aggregations(p.view()).await[&p.age], 85);
    p.f.set(&p.f.table_id, &p.ids[0], json!({ &p.age: 100 }))
        .await;
    assert_eq!(p.f.aggregations(p.view()).await[&p.age], 155);
}

#[tokio::test]
async fn computed_and_system_fields_can_be_summarized() {
    let p = people().await;
    let double = id_of(&p.f.formula(&p.f.table_id, "Double", "{Age} * 2").await);
    let auto = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "No", "type": "autonumber", "options": {} }),
        )
        .await,
    );
    let v = summarize(&p, json!({ &double: "sum", &auto: "max" })).await;
    assert_eq!(v[&double], 252);
    assert_eq!(v[&auto], 5);
}

#[tokio::test]
async fn link_cells_count_live_links_only() {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&orders, "Customer", &customers).await;
    let link_id = link["id"].as_str().unwrap().to_string();
    let c1 = id_str(&f.create(&customers, json!({ &f.primary_id: "Acme" })).await["id"]);
    let o_primary = id_str(&f.table(&orders).await["primary_field_id"]);
    f.create(&orders, json!({ &o_primary: "o1", &link_id: [c1] }))
        .await;
    f.create(&orders, json!({ &o_primary: "o2" })).await;
    let view = f
        .new_view(
            &orders,
            "All",
            json!({ "summaries": { &link_id: "filled" } }),
        )
        .await;
    assert_eq!(f.aggregations(&view).await[&link_id], 1);
    // Trashing the only linked customer leaves no live link on o1.
    f.delete_records(&customers, &[&c1])
        .await
        .assert_status(204);
    assert_eq!(f.aggregations(&view).await[&link_id], 0);
}

#[tokio::test]
async fn empty_selections_give_neutral_values() {
    let p = people().await;
    p.f.configure(json!({
        "filter": and(vec![cond(&p.name, "is", json!("nobody"))]),
        "summaries": { &p.age: "sum", &p.name: "filled", &p.due: "earliest_date" },
    }))
    .await;
    let v = p.f.aggregations(p.view()).await;
    assert_eq!(v[&p.age], 0);
    assert_eq!(v[&p.name], 0);
    assert_eq!(v[&p.due], Value::Null);
    p.f.configure(json!({
        "filter": and(vec![cond(&p.name, "is", json!("nobody"))]),
        "summaries": { &p.age: "average", &p.done: "percent_checked" },
    }))
    .await;
    let v = p.f.aggregations(p.view()).await;
    assert_eq!(v[&p.age], Value::Null);
    assert_eq!(v[&p.done], 0);
}

#[tokio::test]
async fn views_without_summaries_and_unusable_summaries_return_nothing_for_them() {
    let p = people().await;
    assert_eq!(p.f.aggregations(p.view()).await, json!({}));
    // `none` is not an aggregation to compute.
    assert_eq!(summarize(&p, json!({ &p.age: "none" })).await, json!({}));
    // A summary for a field that was deleted afterwards is skipped.
    p.f.configure(json!({ "summaries": { &p.age: "sum", &p.name: "filled" } }))
        .await;
    p.f.app
        .delete(&p.f.owner, &format!("/api/fields/{}", p.age))
        .await
        .assert_status(200);
    assert_eq!(p.f.aggregations(p.view()).await, json!({ &p.name: 5 }));
}

#[tokio::test]
async fn aggregation_permissions_and_errors() {
    let p = people().await;
    p.f.configure(json!({ "summaries": { &p.age: "sum" } }))
        .await;
    let url = format!("/api/views/{}/aggregations", p.view());
    let viewer = p.f.member("viewer-user@example.com", Role::Viewer);
    p.f.app.get(&viewer, &url).await.assert_status(200);
    let stranger = p.f.app.user("stranger@example.com", "Stranger");
    p.f.app.get(&stranger, &url).await.assert_status(404);
    p.f.app.get(&p.f.app.anon(), &url).await.assert_status(401);
    p.f.app
        .get(&p.f.owner, "/api/views/viwNope/aggregations")
        .await
        .assert_status(404);
    p.f.app
        .get(&p.f.owner, &format!("{url}?timezone=Mars/Base"))
        .await
        .assert_status(400);
    p.f.app
        .get(&p.f.owner, &format!("{url}?timezone=Asia/Tokyo"))
        .await
        .assert_status(200);
    // Someone else's personal view is invisible.
    let editor = p.f.member("editor-user@example.com", Role::Editor);
    let r =
        p.f.app
            .post(
                &editor,
                &format!("/api/tables/{}/views", p.f.table_id),
                json!({ "name": "Mine", "type": "grid", "personal": true }),
            )
            .await;
    r.assert_status(201);
    let personal = format!("/api/views/{}/aggregations", id_of(&r.body));
    p.f.app.get(&editor, &personal).await.assert_status(200);
    p.f.app.get(&p.f.owner, &personal).await.assert_status(404);
}

#[tokio::test]
async fn relative_date_filters_in_aggregations_use_the_requested_zone() {
    let p = people().await;
    let today = |tz: &str| {
        chrono::Utc::now()
            .with_timezone(&tz.parse::<chrono_tz::Tz>().unwrap())
            .date_naive()
            .to_string()
    };
    p.f.set(
        &p.f.table_id,
        &p.ids[0],
        json!({ &p.due: today("Pacific/Kiritimati") }),
    )
    .await;
    p.f.set(
        &p.f.table_id,
        &p.ids[1],
        json!({ &p.due: today("Pacific/Pago_Pago") }),
    )
    .await;
    p.f.configure(json!({
        "filter": and(vec![cond(&p.due, "is", json!({ "mode": "today" }))]),
        "summaries": { &p.name: "filled" },
    }))
    .await;
    for tz in ["Pacific/Kiritimati", "Pacific/Pago_Pago"] {
        let r =
            p.f.app
                .get(
                    &p.f.owner,
                    &format!("/api/views/{}/aggregations?timezone={tz}", p.view()),
                )
                .await;
        r.assert_status(200);
        assert_eq!(r.body["values"][&p.name], 1, "{tz}");
    }
}

// ------------------------------------------------------------ link lookup

async fn lookup(p: &People, query: &str) -> Value {
    let r =
        p.f.app
            .get(
                &p.f.owner,
                &format!("/api/tables/{}/records/lookup{query}", p.f.table_id),
            )
            .await;
    r.assert_status(200);
    r.body
}

fn lookup_names(v: &Value) -> Vec<String> {
    v["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn lookup_finds_records_by_primary_text_in_manual_order() {
    let p = people().await;
    let all = lookup(&p, "").await;
    assert_eq!(lookup_names(&all), ["Alice", "bob", "Carol", "dave", "Eve"]);
    assert_eq!(all["records"][0]["id"], p.ids[0]);
    // Case-insensitive contains.
    assert_eq!(lookup_names(&lookup(&p, "?q=AL").await), ["Alice"]);
    assert_eq!(
        lookup_names(&lookup(&p, "?q=e").await),
        ["Alice", "dave", "Eve"]
    );
    assert_eq!(lookup_names(&lookup(&p, "?q=%20carol%20").await), ["Carol"]);
    assert!(lookup_names(&lookup(&p, "?q=zzz").await).is_empty());
    // Only the primary field is searched, not other cells.
    assert!(lookup_names(&lookup(&p, "?q=doing").await).is_empty());
}

#[tokio::test]
async fn lookup_also_matches_the_fields_the_picker_shows() {
    let p = people().await;
    // bob's Status is Doing; the primary field alone does not match it.
    let found = lookup(&p, &format!("?q=doing&fields={}", p.status)).await;
    assert_eq!(lookup_names(&found), ["bob"]);
    // Several fields, an unknown id and blanks are fine.
    let found = lookup(&p, &format!("?q=don&fields=fldNope,%20,{}", p.status)).await;
    assert_eq!(lookup_names(&found), ["Carol"]);
}

#[tokio::test]
async fn records_get_answers_live_records_in_the_order_asked() {
    let p = people().await;
    let url = format!("/api/tables/{}/records/get", p.f.table_id);
    let r =
        p.f.app
            .post(
                &p.f.owner,
                &url,
                json!({ "ids": [&p.ids[2], "recMissing", &p.ids[0]] }),
            )
            .await;
    r.assert_status(200);
    let names: Vec<_> = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rec| rec["values"][&p.name].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Carol", "Alice"]);

    let too_many: Vec<String> = (0..101).map(|i| format!("rec{i}")).collect();
    p.f.app
        .post(&p.f.owner, &url, json!({ "ids": too_many }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn lookup_limit_defaults_to_20_and_caps_at_100() {
    let f = Fixture::new().await;
    for i in 0..130 {
        f.insert_record(
            &f.table_id,
            json!({ &f.primary_id: format!("item {i:03}") }),
        );
    }
    let get = |q: String| {
        let url = format!("/api/tables/{}/records/lookup{q}", f.table_id);
        let f = &f;
        async move {
            let r = f.app.get(&f.owner, &url).await;
            r.assert_status(200);
            r.body["records"].as_array().unwrap().len()
        }
    };
    assert_eq!(get(String::new()).await, 20);
    assert_eq!(get("?limit=5".into()).await, 5);
    assert_eq!(get("?limit=100".into()).await, 100);
    assert_eq!(get("?limit=1000".into()).await, 100);
    assert_eq!(get("?limit=0".into()).await, 0);
    assert_eq!(get("?q=item%2012&limit=50".into()).await, 10);
}

#[tokio::test]
async fn lookup_can_be_restricted_by_a_views_filter() {
    let p = people().await;
    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    let view =
        p.f.new_view(
            &p.f.table_id,
            "Todo only",
            json!({ "filter": and(vec![cond(&p.status, "is", json!(todo))]) }),
        )
        .await;
    let restricted = lookup(&p, &format!("?view_id={view}")).await;
    assert_eq!(lookup_names(&restricted), ["Alice", "Eve"]);
    // The text query narrows within the view.
    assert_eq!(
        lookup_names(&lookup(&p, &format!("?view_id={view}&q=ev")).await),
        ["Eve"]
    );
    assert!(lookup_names(&lookup(&p, &format!("?view_id={view}&q=bob")).await).is_empty());
    // A view of another table is rejected.
    let other = id_of(&p.f.add_table("Other").await);
    let foreign = p.f.new_view(&other, "Foreign", json!({})).await;
    let r =
        p.f.app
            .get(
                &p.f.owner,
                &format!(
                    "/api/tables/{}/records/lookup?view_id={foreign}",
                    p.f.table_id
                ),
            )
            .await;
    r.assert_status(400);
    p.f.app
        .get(
            &p.f.owner,
            &format!(
                "/api/tables/{}/records/lookup?view_id=viwNope",
                p.f.table_id
            ),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn lookup_hides_trashed_records_and_checks_the_role() {
    let p = people().await;
    p.f.delete_records(&p.f.table_id, &[&p.ids[0]])
        .await
        .assert_status(204);
    assert_eq!(
        lookup_names(&lookup(&p, "").await),
        ["bob", "Carol", "dave", "Eve"]
    );
    let url = format!("/api/tables/{}/records/lookup", p.f.table_id);
    let viewer = p.f.member("viewer-user@example.com", Role::Viewer);
    p.f.app.get(&viewer, &url).await.assert_status(200);
    let stranger = p.f.app.user("stranger@example.com", "Stranger");
    p.f.app.get(&stranger, &url).await.assert_status(404);
    p.f.app.get(&p.f.app.anon(), &url).await.assert_status(401);
    p.f.app
        .get(&p.f.owner, "/api/tables/tblNope/records/lookup")
        .await
        .assert_status(404);
    // Bad query strings use the error envelope.
    let r = p.f.app.get(&p.f.owner, &format!("{url}?limit=abc")).await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn lookup_names_are_the_display_text_of_the_primary_field() {
    let f = Fixture::new().await;
    // Make the primary field a number so the display text is formatted.
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.primary_id),
            json!({ "type": "number", "options": { "precision": 2 } }),
        )
        .await
        .assert_status(200);
    f.create(&f.table_id, json!({ &f.primary_id: 3.5 })).await;
    let r = f
        .app
        .get(
            &f.owner,
            &format!("/api/tables/{}/records/lookup?q=3.5", f.table_id),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["records"][0]["name"], "3.50");
}
