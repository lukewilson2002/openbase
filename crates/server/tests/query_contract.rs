//! Response contracts the web client relies on (plan section 3.1): group
//! headers on every page, system fields in `values`, the aggregations
//! `search` parameter and the request-scoped `transient` override of a view's
//! filter / sorts / groups.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use opengrid::perm::Role;
use query_support::*;
use serde_json::{Value, json};

/// Percent-encode everything except unreserved characters.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn aggregations_with(p: &People, view: &str, query: &str) -> common::Response {
    p.f.app
        .get(
            &p.f.owner,
            &format!("/api/views/{view}/aggregations?{query}"),
        )
        .await
}

// --------------------------------------------------------- group headers

#[tokio::test]
async fn group_headers_are_complete_on_every_page() {
    let p = people().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.status } ] }))
        .await;
    let full = p.f.query(json!({})).await;
    let headers = full["groups"].clone();
    assert_eq!(headers.as_array().unwrap().len(), 4);

    // Every page, including ones that show records of a single group only
    // and ones past the end, carries the complete list; `start` and `count`
    // always refer to the full ordered result, never to the page.
    for (offset, limit) in [(0, 1), (1, 1), (2, 2), (4, 1), (3, 100), (99, 10), (0, 0)] {
        let page = p.f.query(json!({ "offset": offset, "limit": limit })).await;
        assert_eq!(page["groups"], headers, "offset {offset} limit {limit}");
        assert_eq!(page["total"], 5);
    }
    let starts: Vec<u64> = headers
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["start"].as_u64().unwrap())
        .collect();
    assert_eq!(starts, [0, 1, 3, 4]);
    let counts: u64 = headers
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["count"].as_u64().unwrap())
        .sum();
    assert_eq!(counts, 5, "the counts add up to the total");

    // Nested groups too, and a search narrows the headers with the result.
    p.f.configure(json!({ "groups": [
        { "field_id": p.status }, { "field_id": p.age } ] }))
        .await;
    let all = p.f.query(json!({})).await;
    let page = p.f.query(json!({ "offset": 4, "limit": 1 })).await;
    assert_eq!(page["groups"], all["groups"]);
    assert!(
        all["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["depth"] == 1)
    );
    let searched = p.f.query(json!({ "search": "Alice", "limit": 1 })).await;
    assert_eq!(searched["total"], 1);
    assert_eq!(searched["groups"].as_array().unwrap().len(), 2);

    // Ungrouped views have none.
    p.f.configure(json!({})).await;
    assert_eq!(p.f.query(json!({ "offset": 2 })).await["groups"], json!([]));
}

// ---------------------------------------------------------- system fields

#[tokio::test]
async fn system_fields_appear_in_values_under_their_field_ids() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let mut sys = Vec::new();
    for (name, ty) in [
        ("No", "autonumber"),
        ("Created", "created_time"),
        ("Created by", "created_by"),
        ("Edited", "last_modified_time"),
        ("Edited by", "last_modified_by"),
    ] {
        let field = f
            .add_field(&t, json!({ "name": name, "type": ty, "options": {} }))
            .await;
        sys.push((ty, id_of(&field)));
    }
    let owner = f.owner.user_id.clone().unwrap();
    let created = f.create(&t, json!({ &f.primary_id: "first" })).await;
    let id = id_str(&created["id"]);

    let check = |rec: &Value, label: &str| {
        let v = &rec["values"];
        assert_eq!(v[&sys[0].1], 1, "{label}: autonumber");
        assert!(v[&sys[1].1].as_str().unwrap().ends_with('Z'), "{label}");
        assert_eq!(v[&sys[2].1], owner.as_str(), "{label}: created by");
        assert!(v[&sys[3].1].as_str().unwrap().ends_with('Z'), "{label}");
        assert_eq!(v[&sys[4].1], owner.as_str(), "{label}: edited by");
    };
    check(&created, "create response");
    check(&f.get(&t, &id).await, "get");
    let page = f.query(json!({})).await;
    check(&page["records"][0], "view query");
    let edited = f.set(&t, &id, json!({ &f.primary_id: "renamed" })).await;
    check(&edited, "update response");
    // The columns are mirrored by the top-level record fields.
    assert_eq!(page["records"][0]["autonumber"], 1);
    assert_eq!(page["records"][0]["created_by"], owner.as_str());
}

// ---------------------------------------------------------- search limits

#[tokio::test]
async fn search_text_is_length_capped_and_case_insensitive() {
    let p = people().await;
    // Matching is case-insensitive (the needle is lower-cased once).
    let upper = p.f.query(json!({ "search": "ALICE" })).await;
    assert_eq!(upper["total"], 1);

    // 500 characters are fine; 501 are refused, on the query and on the
    // aggregations endpoint alike.
    let ok = "a".repeat(500);
    assert_eq!(p.f.query(json!({ "search": ok })).await["total"], 0);
    let long = "a".repeat(501);
    let r =
        p.f.query_as(&p.f.owner, p.view(), json!({ "search": long }))
            .await;
    r.assert_status(400);
    let view = p.view().to_string();
    aggregations_with(&p, &view, &format!("search={long}"))
        .await
        .assert_status(400);
}

// ----------------------------------------------------- aggregations search

#[tokio::test]
async fn aggregations_accept_the_same_search_as_the_query() {
    let p = people().await;
    p.f.configure(json!({ "summaries": { &p.age: "sum", &p.name: "filled" } }))
        .await;
    let view = p.view().to_string();

    let all = aggregations_with(&p, &view, "").await;
    all.assert_status(200);
    assert_eq!(all.body["values"][&p.age], 126);
    assert_eq!(all.body["values"][&p.name], 5);

    // Alice (30) only; the query for the same search agrees.
    let one = aggregations_with(&p, &view, "search=alice").await;
    one.assert_status(200);
    assert_eq!(one.body["values"][&p.age], 30);
    assert_eq!(one.body["values"][&p.name], 1);
    assert_eq!(p.f.query(json!({ "search": "alice" })).await["total"], 1);

    // Search matches any visible field (the status "Done" is Carol's).
    let done = aggregations_with(&p, &view, "search=Done").await;
    assert_eq!(done.body["values"][&p.age], 41);

    // Percent-encoding, spaces and an empty search behave.
    assert_eq!(
        aggregations_with(&p, &view, "search=%20alice%20")
            .await
            .body["values"][&p.age],
        30
    );
    assert_eq!(
        aggregations_with(&p, &view, "search=").await.body["values"][&p.age],
        126
    );
    // No match: the aggregations of nothing.
    let none = aggregations_with(&p, &view, "search=zzzz").await;
    none.assert_status(200);
    assert_eq!(none.body["values"][&p.name], 0);

    // Search and the saved filter combine (Age >= 30 and "e": Alice, Eve).
    p.f.configure(json!({
        "filter": and(vec![cond(&p.age, "gte", json!(30))]),
        "summaries": { &p.age: "sum", &p.name: "filled" } }))
        .await;
    let both = aggregations_with(&p, &view, "search=e").await;
    let q = p.f.query(json!({ "search": "e" })).await;
    assert_eq!(
        both.body["values"][&p.name].as_u64().unwrap() as usize,
        q["total"].as_u64().unwrap() as usize
    );
    assert_eq!(
        aggregations_with(&p, &view, "search=zzzz").await.body["values"][&p.name],
        0
    );

    // Hidden fields are not searched, as in the grid.
    p.f.configure(json!({ "hidden_fields": [p.status],
                          "summaries": { &p.age: "sum" } }))
        .await;
    assert_eq!(
        aggregations_with(&p, &view, "search=Doing").await.body["values"][&p.age],
        0,
        "bob's status is hidden: no match"
    );
}

// -------------------------------------------------------------- transient

#[tokio::test]
async fn a_transient_override_replaces_the_saved_filter_for_one_request() {
    let p = people().await;
    let saved = and(vec![cond(&p.age, "gt", json!(26))]);
    p.f.configure(json!({ "filter": saved })).await;
    let before = p.f.query(json!({})).await;
    assert_eq!(names(&p, &before), ["Alice", "Carol", "Eve"]);

    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    let resp = p
        .f
        .query(json!({ "transient": { "filter": and(vec![cond(&p.status, "is", json!(todo))]) } }))
        .await;
    assert_eq!(names(&p, &resp), ["Alice", "Eve"]);
    assert_eq!(resp["total"], 2);

    // Nothing was saved: the view config and the plain query are unchanged.
    let after = p.f.query(json!({})).await;
    assert_eq!(names(&p, &after), ["Alice", "Carol", "Eve"]);
    let schema =
        p.f.app
            .get(&p.f.owner, &format!("/api/bases/{}", p.f.base_id))
            .await;
    let view = schema.body["tables"][0]["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == p.view())
        .unwrap()
        .clone();
    assert_eq!(view["config"]["filter"], saved_filter_json(&p));

    // An empty filter drops the saved one.
    let everything =
        p.f.query(json!({ "transient": { "filter": { "conjunction": "and", "items": [] } } }))
            .await;
    assert_eq!(everything["total"], 5);
    // A transient without a filter keeps the saved one.
    let keeps = p
        .f
        .query(json!({ "transient": { "sorts": [ { "field_id": p.name, "direction": "desc" } ] } }))
        .await;
    assert_eq!(names(&p, &keeps), ["Eve", "Carol", "Alice"]);
    // It combines with search and paging.
    let paged =
        p.f.query(
            json!({ "transient": { "filter": { "conjunction": "and", "items": [] },
                                      "sorts": [ { "field_id": p.name, "direction": "asc" } ] },
                       "search": "a", "offset": 1, "limit": 2 }),
        )
        .await;
    assert_eq!(paged["records"].as_array().unwrap().len(), 2);
}

fn saved_filter_json(p: &People) -> Value {
    json!({ "conjunction": "and", "items": [
        { "field_id": p.age, "op": "gt", "value": 26 } ] })
}

#[tokio::test]
async fn transient_sorts_and_groups_override_the_saved_ones() {
    let p = people().await;
    p.f.configure(json!({ "sorts": [ { "field_id": p.name, "direction": "asc" } ] }))
        .await;
    let by_age = p
        .f
        .query(json!({ "transient": { "sorts": [ { "field_id": p.age, "direction": "desc" } ] } }))
        .await;
    assert_eq!(by_age["records"][0]["values"][&p.age], 41);
    assert_eq!(by_age["groups"], json!([]));

    let grouped =
        p.f.query(json!({ "transient": { "groups": [ { "field_id": p.status } ] } }))
            .await;
    assert_eq!(grouped["groups"].as_array().unwrap().len(), 4);
    // Saved config still has no groups, and its own sort.
    let plain = p.f.query(json!({})).await;
    assert_eq!(plain["groups"], json!([]));
    assert_eq!(names(&p, &plain)[0], "Alice");

    // Empty lists clear the saved ones.
    let unsorted = p.f.query(json!({ "transient": { "sorts": [] } })).await;
    assert_eq!(
        names(&p, &unsorted),
        ["Alice", "bob", "Carol", "dave", "Eve"]
    );
}

/// The message of the 400 a bad transient override produces.
async fn bad(p: &People, t: Value) -> String {
    let r =
        p.f.query_as(&p.f.owner, p.view(), json!({ "transient": t }))
            .await;
    assert_eq!(r.status.as_u16(), 400, "{}", r.body);
    assert_eq!(r.body["error"]["code"], "bad_request");
    r.body["error"]["message"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn transient_overrides_are_validated_like_saved_configs() {
    let p = people().await;
    let msg = bad(
        &p,
        json!({ "filter": and(vec![cond("fldNOPE", "is", json!(1))]) }),
    )
    .await;
    assert!(msg.contains("unknown field"), "{msg}");
    assert!(msg.starts_with("transient"), "{msg}");
    // An operator that does not suit the field's type.
    bad(
        &p,
        json!({ "filter": and(vec![cond(&p.age, "contains", json!("x"))]) }),
    )
    .await;
    bad(
        &p,
        json!({ "sorts": [ { "field_id": "fldNOPE", "direction": "asc" } ] }),
    )
    .await;
    bad(&p, json!({ "groups": [ { "field_id": "fldNOPE" } ] })).await;
    // Level limits.
    let many: Vec<Value> = (0..20)
        .map(|_| json!({ "field_id": p.name, "direction": "asc" }))
        .collect();
    bad(&p, json!({ "sorts": many })).await;
    let groups: Vec<Value> = (0..4).map(|_| json!({ "field_id": p.name })).collect();
    bad(&p, json!({ "groups": groups })).await;
    // Wrong shape: the extractor's envelope.
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "transient": { "filter": 5 } }),
        )
        .await;
    assert_eq!(r.status.as_u16(), 400);
    // Nothing leaked into the saved config by the failed attempts.
    assert_eq!(p.f.query(json!({})).await["total"], 5);

    // Stale references in the *saved* config do not break a valid override.
    p.f.configure(json!({ "filter": and(vec![cond(&p.due, "is_after", json!("2000-01-01"))]) }))
        .await;
    p.f.app
        .delete(&p.f.owner, &format!("/api/fields/{}", p.due))
        .await
        .assert_status(200);
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "transient": { "sorts": [ { "field_id": p.name, "direction": "asc" } ] } }),
        )
        .await;
    r.assert_status(200);
}

#[tokio::test]
async fn the_cache_key_includes_the_transient_override() {
    let p = people().await;
    let cache = &p.f.app.state.query_cache;
    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    let doing = p.f.choice_id(&p.f.table_id, "Status", "Doing").await;
    let t_todo = json!({ "filter": and(vec![cond(&p.status, "is", json!(todo))]) });
    let t_doing = json!({ "filter": and(vec![cond(&p.status, "is", json!(doing))]) });

    let plain = p.f.query(json!({})).await;
    assert_eq!((cache.scans(), cache.hits()), (1, 0));
    let a = p.f.query(json!({ "transient": t_todo })).await;
    assert_eq!(cache.scans(), 2, "a different effective config scans again");
    let a2 = p.f.query(json!({ "transient": t_todo })).await;
    assert_eq!((cache.scans(), cache.hits()), (2, 1), "same override hits");
    assert_eq!(rec_ids(&a), rec_ids(&a2));
    let b = p.f.query(json!({ "transient": t_doing })).await;
    assert_eq!(cache.scans(), 3);
    assert_ne!(rec_ids(&a), rec_ids(&b));
    // The plain query still gets its own, unfiltered, entry.
    let plain2 = p.f.query(json!({})).await;
    assert_eq!(rec_ids(&plain), rec_ids(&plain2));
    assert_eq!(plain2["total"], 5);
    assert_eq!(cache.scans(), 3);
    // A write invalidates the overridden entries too.
    p.f.set(&p.f.table_id, &p.ids[3], json!({ &p.status: "Todo" }))
        .await;
    let a3 = p.f.query(json!({ "transient": t_todo })).await;
    assert_eq!(a3["total"], 3);
}

#[tokio::test]
async fn users_who_cannot_save_the_view_can_still_filter_it_transiently() {
    let p = people().await;
    let viewer = p.f.member("viewer@example.com", Role::Viewer);
    // The viewer cannot change the shared view...
    p.f.app
        .patch(
            &viewer,
            &format!("/api/views/{}", p.view()),
            json!({ "config": { "filter": and(vec![cond(&p.age, "gt", json!(26))]) } }),
        )
        .await
        .assert_status(403);
    // ... but can filter, sort and summarise it for themselves.
    let r =
        p.f.query_as(
            &viewer,
            p.view(),
            json!({ "transient": { "filter": and(vec![cond(&p.age, "gt", json!(26))]),
                                   "sorts": [ { "field_id": p.age, "direction": "desc" } ] } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(names(&p, &r.body), ["Carol", "Alice", "Eve"]);
    // Everyone else still sees the saved view.
    assert_eq!(p.f.query(json!({})).await["total"], 5);

    // Editors on a locked view (only creators may change it).
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/views/{}", p.view()),
            json!({ "locked": true }),
        )
        .await
        .assert_status(200);
    let editor = p.f.member("editor@example.com", Role::Editor);
    p.f.app
        .patch(
            &editor,
            &format!("/api/views/{}", p.view()),
            json!({ "config": { "sorts": [] } }),
        )
        .await
        .assert_status(403);
    let r =
        p.f.query_as(
            &editor,
            p.view(),
            json!({ "transient": { "filter": and(vec![cond(&p.age, "lt", json!(30))]) } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(names(&p, &r.body), ["bob"]);

    // Strangers and other people's personal views stay closed.
    let stranger = p.f.app.user("stranger@example.com", "Stranger");
    p.f.query_as(&stranger, p.view(), json!({ "transient": {} }))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn aggregations_take_a_transient_filter_and_search() {
    let p = people().await;
    let view = p.view().to_string();
    p.f.configure(json!({ "summaries": { &p.age: "sum" } }))
        .await;
    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    let t = json!({ "filter": and(vec![cond(&p.status, "is", json!(todo))]) });

    let r = aggregations_with(&p, &view, &format!("transient={}", enc(&t.to_string()))).await;
    r.assert_status(200);
    assert_eq!(r.body["values"][&p.age], 60, "Alice 30 + Eve 30");
    // Not persisted: without the parameter the saved (empty) filter applies.
    assert_eq!(p.f.aggregations(&view).await[&p.age], 126);

    // With search too.
    let r = aggregations_with(
        &p,
        &view,
        &format!("transient={}&search=eve", enc(&t.to_string())),
    )
    .await;
    assert_eq!(r.body["values"][&p.age], 30);

    // Sorts and groups in the override are accepted and irrelevant here.
    let t2 = json!({ "sorts": [ { "field_id": p.name, "direction": "asc" } ] });
    let r = aggregations_with(&p, &view, &format!("transient={}", enc(&t2.to_string()))).await;
    assert_eq!(r.body["values"][&p.age], 126);

    // Errors use the envelope.
    for query in [
        "transient=%7Bnot%20json".to_string(),
        format!(
            "transient={}",
            enc(&json!({ "filter": and(vec![cond("fldNOPE", "is", json!(1))]) }).to_string())
        ),
        format!("transient={}", enc(&json!({ "filter": 7 }).to_string())),
        format!("transient={}", enc(&"x".repeat(20_000))),
    ] {
        let r = aggregations_with(&p, &view, &query).await;
        assert_eq!(r.status.as_u16(), 400, "{query}: {}", r.body);
        assert_eq!(r.body["error"]["code"], "bad_request");
    }
    // An empty parameter is no override.
    assert_eq!(
        aggregations_with(&p, &view, "transient=").await.body["values"][&p.age],
        126
    );
    // Viewers may use it as well.
    let viewer = p.f.member("viewer2@example.com", Role::Viewer);
    let r =
        p.f.app
            .get(
                &viewer,
                &format!(
                    "/api/views/{view}/aggregations?transient={}",
                    enc(&t.to_string())
                ),
            )
            .await;
    r.assert_status(200);
    assert_eq!(r.body["values"][&p.age], 60);
}

// ---------------------------------------------------------------- buttons

#[tokio::test]
async fn button_values_are_the_materialized_urls() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let button = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Open", "type": "button",
                    "options": { "label": "Go", "url_formula": "\"https://example.com/?q=\" & {Name}" } }),
        )
        .await,
    );
    let rec = f.create(&t, json!({ &f.primary_id: "abc" })).await;
    let url = "https://example.com/?q=abc";
    assert_eq!(rec["values"][&button], url, "create response");
    assert_eq!(f.get(&t, &id_str(&rec["id"])).await["values"][&button], url);
    let page = f.query(json!({})).await;
    assert_eq!(page["records"][0]["values"][&button], url);
    // It follows edits of what the formula reads.
    let edited = f
        .set(&t, &id_str(&rec["id"]), json!({ &f.primary_id: "xyz" }))
        .await;
    assert_eq!(edited["values"][&button], "https://example.com/?q=xyz");
}
