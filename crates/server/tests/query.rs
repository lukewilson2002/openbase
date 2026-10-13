//! `POST /api/views/{id}/query`: filters per field type, sorts, groups,
//! search, date ranges, "me", relative dates, paging, link names, row colours,
//! the cache and permissions, all through the real router.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use opengrid::perm::Role;
use query_support::*;
use serde_json::{Value, json};

// ------------------------------------------------------------------ paging

#[tokio::test]
async fn returns_live_records_in_manual_order_with_the_full_value_map() {
    let p = people().await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["total"], 5);
    assert_eq!(resp["offset"], 0);
    assert_eq!(rec_ids(&resp), p.ids);
    assert_eq!(resp["groups"], json!([]));
    assert_eq!(resp["colors"], json!({}));
    let alice = &resp["records"][0];
    assert_eq!(alice["table_id"], p.f.table_id);
    assert_eq!(alice["autonumber"], 1);
    assert_eq!(alice["values"][&p.name], "Alice");
    assert_eq!(alice["values"][&p.age], 30);
    assert_eq!(alice["values"][&p.due], "2026-03-01");
    // Empty cells are absent, as everywhere else.
    assert!(resp["records"][3]["values"].get(&p.age).is_none());
    // The record is the same one GET returns.
    assert_eq!(*alice, p.f.get(&p.f.table_id, &p.ids[0]).await);

    // Trashed records disappear from queries and totals.
    p.f.delete_records(&p.f.table_id, &[&p.ids[1]])
        .await
        .assert_status(200);
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["total"], 4);
    assert!(!rec_ids(&resp).contains(&p.ids[1]));
}

#[tokio::test]
async fn manual_order_follows_moves() {
    let p = people().await;
    p.f.app
        .post(
            &p.f.owner,
            &format!("{}/move", records_url(&p.f.table_id)),
            json!({ "ids": [p.ids[4]], "before_id": p.ids[0] }),
        )
        .await
        .assert_status(200);
    let resp = p.f.query(json!({})).await;
    assert_eq!(names(&p, &resp), ["Eve", "Alice", "bob", "Carol", "dave"]);
}

#[tokio::test]
async fn paging_offsets_totals_and_limits() {
    let p = people().await;
    let page = p.f.query(json!({ "offset": 1, "limit": 2 })).await;
    assert_eq!(page["total"], 5);
    assert_eq!(page["offset"], 1);
    assert_eq!(rec_ids(&page), p.ids[1..3]);
    let last = p.f.query(json!({ "offset": 4, "limit": 10 })).await;
    assert_eq!(rec_ids(&last), p.ids[4..]);
    // Past the end: nothing, but the total stays.
    let beyond = p.f.query(json!({ "offset": 99 })).await;
    assert_eq!(beyond["total"], 5);
    assert_eq!(beyond["records"], json!([]));
    // limit 0 is a count-only request.
    let count = p.f.query(json!({ "limit": 0 })).await;
    assert_eq!(count["total"], 5);
    assert_eq!(count["records"], json!([]));
}

#[tokio::test]
async fn default_page_is_100_and_the_limit_is_capped_at_the_maximum() {
    let f = Fixture::new().await;
    for i in 0..1_050 {
        f.insert_record(&f.table_id, json!({ &f.primary_id: format!("r{i}") }));
    }
    let resp = f.query(json!({})).await;
    assert_eq!(resp["total"], 1_050);
    assert_eq!(resp["records"].as_array().unwrap().len(), 100);
    let resp = f.query(json!({ "limit": 5_000 })).await;
    assert_eq!(
        resp["records"].as_array().unwrap().len(),
        og_core::limits::MAX_PAGE_SIZE
    );
    // Manual order is position order: r0 first.
    assert_eq!(resp["records"][0]["values"][&f.primary_id], "r0");
}

#[tokio::test]
async fn bad_requests_are_rejected_with_the_error_envelope() {
    let p = people().await;
    let r =
        p.f.query_as(&p.f.owner, p.view(), json!({ "timezone": "Mars/Base" }))
            .await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
    let r =
        p.f.query_as(&p.f.owner, p.view(), json!({ "offset": "x" }))
            .await;
    r.assert_status(400);
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "range": { "field_id": p.due, "from": "yesterday", "to": "2026-01-01" } }),
        )
        .await;
    r.assert_status(400);
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "range": { "field_id": p.age, "from": "2026-01-01", "to": "2026-01-02" } }),
        )
        .await;
    r.assert_status(400);
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "range": { "field_id": "fldNope", "from": "2026-01-01", "to": "2026-01-02" } }),
        )
        .await;
    r.assert_status(400);
    let r =
        p.f.query_as(
            &p.f.owner,
            p.view(),
            json!({ "range": { "field_id": p.due, "from": "2026-02-01", "to": "2026-01-02" } }),
        )
        .await;
    r.assert_status(400);
    p.f.query_as(&p.f.owner, "viwDoesNotExist", json!({}))
        .await
        .assert_status(404);
}

// ----------------------------------------------------------------- filters

#[tokio::test]
async fn text_filters() {
    let p = people().await;
    let n = &p.name;
    assert_eq!(
        filtered(&p, and(vec![cond(n, "contains", json!("a"))])).await,
        ["Alice", "Carol", "dave"]
    );
    // Case-insensitive.
    assert_eq!(
        filtered(&p, and(vec![cond(n, "contains", json!("CAROL"))])).await,
        ["Carol"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(n, "does_not_contain", json!("a"))])).await,
        ["bob", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(n, "is", json!("bob"))])).await,
        ["bob"]
    );
    // "is" is an exact comparison; the other text operators ignore case.
    assert!(
        filtered(&p, and(vec![cond(n, "is", json!("BOB"))]))
            .await
            .is_empty()
    );
    assert_eq!(
        filtered(&p, and(vec![cond(n, "is_not", json!("bob"))])).await,
        ["Alice", "Carol", "dave", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(n, "starts_with", json!("c"))])).await,
        ["Carol"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(n, "ends_with", json!("e"))])).await,
        ["Alice", "dave", "Eve"]
    );
    // An empty operand is ignored (matches everything).
    assert_eq!(
        filtered(&p, and(vec![cond(n, "contains", json!(""))]))
            .await
            .len(),
        5
    );
    // Empty / not empty on an optional text-like field.
    let notes = p.f.notes_id.clone();
    assert_eq!(
        filtered(&p, and(vec![cond(&notes, "is_empty", Value::Null)]))
            .await
            .len(),
        5
    );
    assert!(
        filtered(&p, and(vec![cond(&notes, "is_not_empty", Value::Null)]))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn number_filters() {
    let p = people().await;
    let a = &p.age;
    assert_eq!(
        filtered(&p, and(vec![cond(a, "is", json!(30))])).await,
        ["Alice", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "is_not", json!(30))])).await,
        ["bob", "Carol", "dave"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "gt", json!(30))])).await,
        ["Carol"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "gte", json!(30))])).await,
        ["Alice", "Carol", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "lt", json!(30))])).await,
        ["bob"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "lte", json!(30))])).await,
        ["Alice", "bob", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "is_empty", Value::Null)])).await,
        ["dave"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(a, "is_not_empty", Value::Null)]))
            .await
            .len(),
        4
    );
}

#[tokio::test]
async fn single_and_multiple_select_filters() {
    let p = people().await;
    let t = &p.f.table_id;
    let todo = p.f.choice_id(t, "Status", "Todo").await;
    let doing = p.f.choice_id(t, "Status", "Doing").await;
    let s = &p.status;
    assert_eq!(
        filtered(&p, and(vec![cond(s, "is", json!(todo))])).await,
        ["Alice", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(s, "is_any_of", json!([todo, doing]))])).await,
        ["Alice", "bob", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(s, "is_none_of", json!([todo, doing]))])).await,
        ["Carol", "dave"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(s, "is_empty", Value::Null)])).await,
        ["dave"]
    );

    let a = p.f.choice_id(t, "Tags", "a").await;
    let b = p.f.choice_id(t, "Tags", "b").await;
    let g = &p.tags;
    assert_eq!(
        filtered(&p, and(vec![cond(g, "has_any_of", json!([a]))])).await,
        ["Alice", "bob"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(g, "has_all_of", json!([a, b]))])).await,
        ["bob"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(g, "has_none_of", json!([a]))])).await,
        ["Carol", "dave", "Eve"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(g, "is_exactly", json!([a]))])).await,
        ["Alice"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(g, "is_empty", Value::Null)])).await,
        ["Carol", "dave"]
    );
}

#[tokio::test]
async fn date_and_checkbox_filters() {
    let p = people().await;
    let d = &p.due;
    let exact = |s: &str| json!({ "mode": "exact_date", "date": s });
    assert_eq!(
        filtered(&p, and(vec![cond(d, "is", exact("2026-03-10"))])).await,
        ["bob"]
    );
    // A plain date string is an exact date.
    assert_eq!(
        filtered(&p, and(vec![cond(d, "is", json!("2026-03-10"))])).await,
        ["bob"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(d, "is_before", exact("2026-03-10"))])).await,
        ["Alice"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(d, "is_after", exact("2026-03-10"))])).await,
        ["Carol"]
    );
    assert_eq!(
        filtered(
            &p,
            and(vec![cond(d, "is_on_or_before", exact("2026-03-10"))])
        )
        .await,
        ["Alice", "bob"]
    );
    assert_eq!(
        filtered(
            &p,
            and(vec![cond(d, "is_on_or_after", exact("2026-03-10"))])
        )
        .await,
        ["bob", "Carol"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(d, "is_empty", Value::Null)])).await,
        ["dave", "Eve"]
    );
    // Checkbox: checked only.
    assert_eq!(
        filtered(&p, and(vec![cond(&p.done, "is", json!(true))])).await,
        ["Carol"]
    );
    assert_eq!(
        filtered(&p, and(vec![cond(&p.done, "is", json!(false))])).await,
        ["Alice", "bob", "dave", "Eve"]
    );
}

#[tokio::test]
async fn nested_groups_and_or_conjunctions() {
    let p = people().await;
    let todo = p.f.choice_id(&p.f.table_id, "Status", "Todo").await;
    // (status = Todo AND age > 30) OR name = bob  -> nothing from Todo, plus bob
    let f = or(vec![
        and(vec![
            cond(&p.status, "is", json!(todo)),
            cond(&p.age, "gt", json!(30)),
        ]),
        cond(&p.name, "is", json!("bob")),
    ]);
    assert_eq!(filtered(&p, f).await, ["bob"]);
    // status = Todo AND (age < 30 OR age > 30) -> none (both Todos are 30).
    let f = and(vec![
        cond(&p.status, "is", json!(todo)),
        or(vec![
            cond(&p.age, "lt", json!(30)),
            cond(&p.age, "gt", json!(30)),
        ]),
    ]);
    assert!(filtered(&p, f).await.is_empty());
    // OR at the top level.
    let f = or(vec![
        cond(&p.name, "is", json!("dave")),
        cond(&p.name, "is", json!("Eve")),
    ]);
    assert_eq!(filtered(&p, f).await, ["dave", "Eve"]);
    // No filter at all, and an empty filter group: everything.
    assert_eq!(filtered(&p, and(vec![])).await.len(), 5);
}

#[tokio::test]
async fn conditions_on_deleted_fields_are_ignored() {
    let p = people().await;
    p.f.configure(json!({ "filter": and(vec![
        cond(&p.age, "gt", json!(30)),
        cond(&p.name, "contains", json!("a")),
    ]) }))
    .await;
    assert_eq!(names(&p, &p.f.query(json!({})).await), ["Carol"]);
    // Delete the Age field: its condition drops out, the other one stays.
    p.f.app
        .delete(&p.f.owner, &format!("/api/fields/{}", p.age))
        .await
        .assert_status(200);
    let resp = p.f.query(json!({})).await;
    assert_eq!(names(&p, &resp), ["Alice", "Carol", "dave"]);
    // The deleted field's values are not in the response either.
    assert!(resp["records"][0]["values"].get(&p.age).is_none());
}

#[tokio::test]
async fn a_condition_that_no_longer_fits_its_field_type_is_ignored() {
    let p = people().await;
    p.f.configure(json!({ "filter": and(vec![cond(&p.age, "gt", json!(30))]) }))
        .await;
    assert_eq!(names(&p, &p.f.query(json!({})).await), ["Carol"]);
    // Age becomes a single line of text: "greater than" does not exist for
    // text any more; the view keeps working with the condition dropped.
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/fields/{}", p.age),
            json!({ "type": "single_line_text", "options": {} }),
        )
        .await
        .assert_status(200);
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["total"], 5);
}

#[tokio::test]
async fn system_fields_are_filterable_and_sortable() {
    let p = people().await;
    let auto = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "No", "type": "autonumber", "options": {} }),
        )
        .await,
    );
    let created = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "Created", "type": "created_time", "options": {} }),
        )
        .await,
    );
    assert_eq!(
        filtered(&p, and(vec![cond(&auto, "gt", json!(3))])).await,
        ["dave", "Eve"]
    );
    // Created in the future: nothing; in the past: everything.
    assert!(
        filtered(
            &p,
            and(vec![cond(&created, "is_after", json!("2999-01-01"))])
        )
        .await
        .is_empty()
    );
    assert_eq!(
        filtered(
            &p,
            and(vec![cond(&created, "is_after", json!("2000-01-01"))])
        )
        .await
        .len(),
        5
    );
    p.f.configure(json!({ "sorts": [ { "field_id": auto, "direction": "desc" } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    assert_eq!(names(&p, &resp), ["Eve", "dave", "Carol", "bob", "Alice"]);
    // The synthesized cells appear in the values.
    assert_eq!(resp["records"][0]["values"][&auto], 5);
    assert!(
        resp["records"][0]["values"][&created]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
}

#[tokio::test]
async fn formula_filters_use_the_materialized_value() {
    let p = people().await;
    let double = id_of(
        &p.f.formula(&p.f.table_id, "Double", &format!("{{Age}} * 2"))
            .await,
    );
    assert_eq!(
        filtered(&p, and(vec![cond(&double, "gt", json!(59))])).await,
        ["Alice", "Carol", "Eve"]
    );
    // Editing a record changes what the formula filter sees (recomputed on write).
    p.f.set(&p.f.table_id, &p.ids[0], json!({ &p.age: 1 }))
        .await;
    assert_eq!(
        filtered(&p, and(vec![cond(&double, "gt", json!(59))])).await,
        ["Carol", "Eve"]
    );
}

// ------------------------------------------------------------------- sorts

#[tokio::test]
async fn sorts_by_type_with_blanks_first_ascending() {
    let p = people().await;
    // Text: case-insensitive.
    p.f.configure(json!({ "sorts": [ { "field_id": p.name } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["Alice", "bob", "Carol", "dave", "Eve"]
    );
    p.f.configure(json!({ "sorts": [ { "field_id": p.name, "direction": "desc" } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["Eve", "dave", "Carol", "bob", "Alice"]
    );
    // Number: blanks first ascending, last descending; ties keep manual order.
    p.f.configure(json!({ "sorts": [ { "field_id": p.age } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["dave", "bob", "Alice", "Eve", "Carol"]
    );
    p.f.configure(json!({ "sorts": [ { "field_id": p.age, "direction": "desc" } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["Carol", "Alice", "Eve", "bob", "dave"]
    );
    // Date.
    p.f.configure(json!({ "sorts": [ { "field_id": p.due } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["dave", "Eve", "Alice", "bob", "Carol"]
    );
    // Single select sorts by choice order (Todo < Doing < Done), blanks first.
    p.f.configure(json!({ "sorts": [ { "field_id": p.status } ] }))
        .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["dave", "Alice", "Eve", "bob", "Carol"]
    );
    // Checkbox: unchecked before checked.
    p.f.configure(json!({ "sorts": [ { "field_id": p.done, "direction": "desc" } ] }))
        .await;
    assert_eq!(names(&p, &p.f.query(json!({})).await)[0], "Carol");
}

#[tokio::test]
async fn multiple_sorts_break_ties_in_order() {
    let p = people().await;
    p.f.configure(json!({ "sorts": [
        { "field_id": p.age, "direction": "desc" },
        { "field_id": p.name, "direction": "desc" },
    ] }))
    .await;
    assert_eq!(
        names(&p, &p.f.query(json!({})).await),
        ["Carol", "Eve", "Alice", "bob", "dave"]
    );
}

#[tokio::test]
async fn sorts_and_filters_work_together_with_paging() {
    let p = people().await;
    p.f.configure(json!({
        "filter": and(vec![cond(&p.age, "is_not_empty", Value::Null)]),
        "sorts": [ { "field_id": p.age } ],
    }))
    .await;
    let first = p.f.query(json!({ "limit": 2 })).await;
    assert_eq!(first["total"], 4);
    assert_eq!(names(&p, &first), ["bob", "Alice"]);
    let second = p.f.query(json!({ "offset": 2, "limit": 2 })).await;
    assert_eq!(names(&p, &second), ["Eve", "Carol"]);
}

// ------------------------------------------------------------------ groups

#[tokio::test]
async fn groups_come_with_headers_in_display_order() {
    let p = people().await;
    let t = &p.f.table_id;
    let todo = p.f.choice_id(t, "Status", "Todo").await;
    let doing = p.f.choice_id(t, "Status", "Doing").await;
    let done = p.f.choice_id(t, "Status", "Done").await;
    p.f.configure(json!({ "groups": [ { "field_id": p.status } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    // Choice order, with the empty group first (blanks first ascending).
    assert_eq!(names(&p, &resp), ["dave", "Alice", "Eve", "bob", "Carol"]);
    let groups = resp["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 4);
    let summary: Vec<(String, u64, u64, u64)> = groups
        .iter()
        .map(|g| {
            (
                g["label"].as_str().unwrap().to_string(),
                g["depth"].as_u64().unwrap(),
                g["start"].as_u64().unwrap(),
                g["count"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("(Empty)".to_string(), 0, 0, 1),
            ("Todo".to_string(), 0, 1, 2),
            ("Doing".to_string(), 0, 3, 1),
            ("Done".to_string(), 0, 4, 1),
        ]
    );
    // key = choice id; value = what to write into the field to join the group.
    assert_eq!(groups[1]["key"], json!(todo));
    assert_eq!(groups[1]["value"], json!(todo));
    assert_eq!(groups[2]["value"], json!(doing));
    assert_eq!(groups[3]["value"], json!(done));
    assert_eq!(groups[0]["key"], "");
    assert_eq!(groups[0]["value"], Value::Null);
    assert_eq!(groups[0]["field_id"], p.status);
}

#[tokio::test]
async fn descending_groups_reverse_the_group_order() {
    let p = people().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.status, "direction": "desc" } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    let labels: Vec<&str> = resp["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["Done", "Doing", "Todo", "(Empty)"]);
}

#[tokio::test]
async fn three_group_levels_nest_depth_first() {
    let p = people().await;
    p.f.configure(json!({
        "groups": [ { "field_id": p.status }, { "field_id": p.age }, { "field_id": p.done } ],
        "sorts": [ { "field_id": p.name } ],
    }))
    .await;
    let resp = p.f.query(json!({})).await;
    let groups = resp["groups"].as_array().unwrap();
    // Pre-order: each group is listed before its sub-groups.
    let shape: Vec<(u64, String, u64, u64)> = groups
        .iter()
        .map(|g| {
            (
                g["depth"].as_u64().unwrap(),
                g["label"].as_str().unwrap().to_string(),
                g["start"].as_u64().unwrap(),
                g["count"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        [
            // dave: no status
            (0, "(Empty)".into(), 0, 1),
            (1, "(Empty)".into(), 0, 1),
            (2, "Unchecked".into(), 0, 1),
            // Alice + Eve: Todo, age 30
            (0, "Todo".into(), 1, 2),
            (1, "30".into(), 1, 2),
            (2, "Unchecked".into(), 1, 2),
            // bob: Doing, 25
            (0, "Doing".into(), 3, 1),
            (1, "25".into(), 3, 1),
            (2, "Unchecked".into(), 3, 1),
            // Carol: Done, 41, checked
            (0, "Done".into(), 4, 1),
            (1, "41".into(), 4, 1),
            (2, "Checked".into(), 4, 1),
        ]
    );
    // Level 1 groups write the number, level 2 the boolean.
    assert_eq!(groups[4]["value"], json!(30));
    assert_eq!(groups[5]["value"], json!(false));
    assert_eq!(groups[11]["value"], json!(true));
    // Within a group, the sort applies: Alice before Eve.
    assert_eq!(names(&p, &resp)[1..3], ["Alice", "Eve"]);
    // Every record is covered exactly once at each depth.
    for depth in 0..3 {
        let covered: u64 = groups
            .iter()
            .filter(|g| g["depth"] == depth)
            .map(|g| g["count"].as_u64().unwrap())
            .sum();
        assert_eq!(covered, 5, "depth {depth}");
    }
}

#[tokio::test]
async fn multiple_select_groups_by_combination_and_date_groups_by_day() {
    let p = people().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.tags } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    let labels: Vec<String> = resp["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["label"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(labels, ["(Empty)", "a", "a, b", "b"]);
    // The value of a multi-select group is the array to write.
    let a = p.f.choice_id(&p.f.table_id, "Tags", "a").await;
    assert_eq!(resp["groups"][1]["value"], json!([a]));
    p.f.configure(json!({ "groups": [ { "field_id": p.due } ] }))
        .await;
    let resp = p.f.query(json!({})).await;
    let keys: Vec<&str> = resp["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["", "2026-03-01", "2026-03-10", "2026-03-20"]);
    assert_eq!(resp["groups"][2]["value"], "2026-03-10");
}

#[tokio::test]
async fn groups_cover_the_whole_result_not_just_the_page() {
    let p = people().await;
    p.f.configure(json!({ "groups": [ { "field_id": p.status } ] }))
        .await;
    let page = p.f.query(json!({ "offset": 3, "limit": 1 })).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    // start/count index the full ordered result, so a client can lay out the
    // whole list from any page.
    assert_eq!(page["groups"].as_array().unwrap().len(), 4);
    assert_eq!(page["groups"][3]["start"], 4);
}

// ------------------------------------------------------------------ search

#[tokio::test]
async fn search_matches_display_text_of_visible_fields() {
    let p = people().await;
    let by = |q: &str| json!({ "search": q });
    assert_eq!(names(&p, &p.f.query(by("ali")).await), ["Alice"]);
    // Case-insensitive, trimmed.
    assert_eq!(names(&p, &p.f.query(by("  ALI  ")).await), ["Alice"]);
    // Select names, numbers and dates are searchable through their text.
    assert_eq!(names(&p, &p.f.query(by("doing")).await), ["bob"]);
    assert_eq!(names(&p, &p.f.query(by("41")).await), ["Carol"]);
    // Dates are searched as displayed (US format by default).
    assert_eq!(names(&p, &p.f.query(by("3/10/2026")).await), ["bob"]);
    assert_eq!(names(&p, &p.f.query(by("zzz")).await).len(), 0);
    // An empty search matches everything.
    assert_eq!(p.f.query(by("   ")).await["total"], 5);
    // Search and filter combine; the total counts both.
    p.f.configure(json!({ "filter": and(vec![cond(&p.age, "is", json!(30))]) }))
        .await;
    let resp = p.f.query(by("e")).await;
    assert_eq!(names(&p, &resp), ["Alice", "Eve"]);
    assert_eq!(resp["total"], 2);
    assert_eq!(names(&p, &p.f.query(by("eve")).await), ["Eve"]);
}

#[tokio::test]
async fn search_skips_hidden_fields() {
    let p = people().await;
    assert_eq!(
        names(&p, &p.f.query(json!({ "search": "doing" })).await),
        ["bob"]
    );
    p.f.configure(json!({ "hidden_fields": [ p.status ] }))
        .await;
    assert!(names(&p, &p.f.query(json!({ "search": "doing" })).await).is_empty());
    // Other fields still match.
    assert_eq!(
        names(&p, &p.f.query(json!({ "search": "bob" })).await),
        ["bob"]
    );
}

// ------------------------------------------------------------- date ranges

async fn events() -> (People, String, String) {
    let p = people().await;
    let start = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "Start", "type": "date", "options": {} }),
        )
        .await,
    );
    let end = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "End", "type": "date", "options": {} }),
        )
        .await,
    );
    let spans = [
        ("2026-03-01", Some("2026-03-04")), // Alice: before the range
        ("2026-03-08", Some("2026-03-12")), // bob: straddles the start
        ("2026-03-14", None),               // Carol: single day inside
        ("2026-03-18", Some("2026-03-25")), // dave: straddles the end
        ("2026-02-01", Some("2026-04-01")), // Eve: covers the range
    ];
    for (id, (s, e)) in p.ids.iter().zip(spans) {
        let mut v = json!({ &start: s });
        if let Some(e) = e {
            v[&end] = json!(e);
        }
        p.f.set(&p.f.table_id, id, v).await;
    }
    (p, start, end)
}

#[tokio::test]
async fn date_range_matches_records_whose_span_overlaps() {
    let (p, start, end) = events().await;
    let range = |end_field: Option<&str>| {
        let mut r = json!({ "field_id": start, "from": "2026-03-10", "to": "2026-03-20" });
        if let Some(e) = end_field {
            r["end_field_id"] = json!(e);
        }
        json!({ "range": r })
    };
    // With the end field: spans overlap.
    let resp = p.f.query(range(Some(&end))).await;
    assert_eq!(names(&p, &resp), ["bob", "Carol", "dave", "Eve"]);
    assert_eq!(resp["total"], 4);
    // Without it only the start day counts.
    let resp = p.f.query(range(None)).await;
    assert_eq!(names(&p, &resp), ["Carol", "dave"]);
    // Edge days are inclusive.
    let resp =
        p.f.query(json!({ "range": { "field_id": start, "end_field_id": end,
                                  "from": "2026-03-04", "to": "2026-03-04" } }))
            .await;
    assert_eq!(names(&p, &resp), ["Alice", "Eve"]);
    // Records without any date never match; the range combines with the filter.
    p.f.configure(json!({ "filter": and(vec![cond(&p.name, "contains", json!("o"))]) }))
        .await;
    let resp = p.f.query(range(Some(&end))).await;
    assert_eq!(names(&p, &resp), ["bob", "Carol"]);
}

#[tokio::test]
async fn date_range_reads_instants_in_the_request_timezone() {
    let p = people().await;
    let at = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "At", "type": "date", "options": { "include_time": true } }),
        )
        .await,
    );
    // 23:30 UTC on March 10 is already March 11 in Tokyo.
    p.f.set(
        &p.f.table_id,
        &p.ids[0],
        json!({ &at: "2026-03-10T23:30:00.000Z" }),
    )
    .await;
    let q = |tz: &str| {
        json!({ "timezone": tz,
                "range": { "field_id": at, "from": "2026-03-11", "to": "2026-03-11" } })
    };
    assert_eq!(names(&p, &p.f.query(q("Asia/Tokyo")).await), ["Alice"]);
    assert!(names(&p, &p.f.query(q("UTC")).await).is_empty());
    assert_eq!(
        names(
            &p,
            &p.f.query(json!({ "timezone": "America/Los_Angeles",
                "range": { "field_id": at, "from": "2026-03-10", "to": "2026-03-10" } }))
                .await
        ),
        ["Alice"]
    );
}

#[tokio::test]
async fn the_profile_timezone_is_used_when_the_request_names_none() {
    let p = people().await;
    let at = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "At", "type": "date", "options": { "include_time": true } }),
        )
        .await,
    );
    p.f.set(
        &p.f.table_id,
        &p.ids[0],
        json!({ &at: "2026-03-10T23:30:00.000Z" }),
    )
    .await;
    let uid = p.f.owner.user_id.clone().unwrap();
    sql(&p.f.app, |tx| {
        tx.execute(
            "UPDATE users SET timezone = 'Asia/Tokyo' WHERE id = ?1",
            [&uid],
        )
    });
    let body = json!({ "range": { "field_id": at, "from": "2026-03-11", "to": "2026-03-11" } });
    assert_eq!(names(&p, &p.f.query(body.clone()).await), ["Alice"]);
    // An explicit zone wins over the profile.
    let mut utc = body.clone();
    utc["timezone"] = json!("UTC");
    assert!(names(&p, &p.f.query(utc).await).is_empty());
}

// ------------------------------------------------------------- me & dates

#[tokio::test]
async fn me_resolves_to_the_calling_user() {
    let p = people().await;
    let owner = p.f.owner.user_id.clone().unwrap();
    let other = p.f.member("editor@example.com", Role::Editor);
    let other_id = other.user_id.clone().unwrap();
    let owner_field = id_of(
        &p.f.add_field(
            &p.f.table_id,
            json!({ "name": "Owner", "type": "user", "options": { "multiple": true } }),
        )
        .await,
    );
    p.f.set(&p.f.table_id, &p.ids[0], json!({ &owner_field: [owner] }))
        .await;
    p.f.set(
        &p.f.table_id,
        &p.ids[1],
        json!({ &owner_field: [other_id] }),
    )
    .await;
    p.f.set(
        &p.f.table_id,
        &p.ids[2],
        json!({ &owner_field: [owner, other_id] }),
    )
    .await;
    p.f.configure(json!({ "filter": and(vec![cond(&owner_field, "has_any_of", json!(["me"]))]) }))
        .await;
    // The same view, two callers, two answers (the cache keys on the user).
    let mine = p.f.query(json!({})).await;
    assert_eq!(names(&p, &mine), ["Alice", "Carol"]);
    let theirs = p.f.query_as(&other, p.view(), json!({})).await;
    theirs.assert_status(200);
    assert_eq!(names(&p, &theirs.body), ["bob", "Carol"]);
    // And again, now from the cache.
    assert_eq!(names(&p, &p.f.query(json!({})).await), ["Alice", "Carol"]);
    let theirs = p.f.query_as(&other, p.view(), json!({})).await;
    assert_eq!(names(&p, &theirs.body), ["bob", "Carol"]);
}

fn today_in(tz: &str) -> chrono::NaiveDate {
    use chrono::Utc;
    Utc::now()
        .with_timezone(&tz.parse::<chrono_tz::Tz>().unwrap())
        .date_naive()
}

#[tokio::test]
async fn relative_dates_use_the_request_timezone() {
    let p = people().await;
    // UTC+14 and UTC-11 are 25 hours apart: their calendar days always differ.
    let (east, west) = ("Pacific/Kiritimati", "Pacific/Pago_Pago");
    let (east_today, west_today) = (today_in(east), today_in(west));
    assert_ne!(east_today, west_today);
    p.f.set(
        &p.f.table_id,
        &p.ids[0],
        json!({ &p.due: east_today.to_string() }),
    )
    .await;
    p.f.set(
        &p.f.table_id,
        &p.ids[1],
        json!({ &p.due: west_today.to_string() }),
    )
    .await;
    p.f.configure(json!({ "filter": and(vec![cond(&p.due, "is", json!({ "mode": "today" }))]) }))
        .await;
    let in_tz = |tz: &str| json!({ "timezone": tz });
    assert_eq!(names(&p, &p.f.query(in_tz(east)).await), ["Alice"]);
    assert_eq!(names(&p, &p.f.query(in_tz(west)).await), ["bob"]);
    // Tomorrow / yesterday / within shift with the zone's day too.
    p.f.configure(
        json!({ "filter": and(vec![cond(&p.due, "is", json!({ "mode": "yesterday" }))]) }),
    )
    .await;
    let day_after_west = west_today.succ_opt().unwrap();
    let expect_bob_yesterday_in_east = east_today == day_after_west;
    let got = names(&p, &p.f.query(in_tz(east)).await);
    assert_eq!(
        got.contains(&"bob".to_string()),
        expect_bob_yesterday_in_east
    );
    p.f.configure(json!({ "filter": and(vec![cond(
        &p.due,
        "is_within",
        json!({ "mode": "past_number_of_days", "days": 7 }),
    )]) }))
    .await;
    let got = names(&p, &p.f.query(in_tz(east)).await);
    assert!(got.contains(&"Alice".to_string()) && got.contains(&"bob".to_string()));
    // Dates far in the past are outside the window.
    assert!(!got.contains(&"Carol".to_string()));
    p.f.configure(json!({ "filter": and(vec![cond(
        &p.due,
        "is_before",
        json!({ "mode": "number_of_days_ago", "days": 30 }),
    )]) }))
    .await;
    assert_eq!(names(&p, &p.f.query(in_tz(east)).await), ["Carol"]);
}

#[tokio::test]
async fn relative_date_results_are_cached_per_zone() {
    let p = people().await;
    p.f.configure(
        json!({ "filter": and(vec![cond(&p.due, "is_before", json!({ "mode": "today" }))]) }),
    )
    .await;
    let cache = &p.f.app.state.query_cache;
    let a = p.f.query(json!({ "timezone": "Pacific/Kiritimati" })).await;
    let b = p.f.query(json!({ "timezone": "Pacific/Pago_Pago" })).await;
    assert_eq!(
        cache.scans(),
        2,
        "different zones must not share a cache entry"
    );
    p.f.query(json!({ "timezone": "Pacific/Kiritimati" })).await;
    assert_eq!(cache.scans(), 2);
    assert_eq!(a["total"], b["total"]);
}

// ------------------------------------------------------------------- cache

#[tokio::test]
async fn a_repeated_query_is_served_from_the_cache_until_a_write() {
    let p = people().await;
    p.f.configure(json!({ "sorts": [ { "field_id": p.name } ] }))
        .await;
    let cache = &p.f.app.state.query_cache;
    let first = p.f.query(json!({ "limit": 2 })).await;
    assert_eq!((cache.scans(), cache.hits()), (1, 0));
    // Other pages of the same query do not rescan.
    let second = p.f.query(json!({ "offset": 2, "limit": 2 })).await;
    assert_eq!((cache.scans(), cache.hits()), (1, 1));
    let again = p.f.query(json!({ "limit": 2 })).await;
    assert_eq!((cache.scans(), cache.hits()), (1, 2));
    assert_eq!(first, again);
    assert_eq!(names(&p, &second), ["Carol", "dave"]);

    // A different search is a different query.
    p.f.query(json!({ "search": "a" })).await;
    assert_eq!(cache.scans(), 2);

    // Any write bumps the base version: the next query rescans and sees it.
    p.f.set(&p.f.table_id, &p.ids[4], json!({ &p.name: "Aaron" }))
        .await;
    let after = p.f.query(json!({ "limit": 2 })).await;
    assert_eq!(cache.scans(), 3);
    assert_eq!(names(&p, &after), ["Aaron", "Alice"]);
    // ... and caches again.
    p.f.query(json!({ "limit": 2 })).await;
    assert_eq!(cache.scans(), 3);
}

#[tokio::test]
async fn cached_pages_reflect_edits_made_to_the_records_themselves() {
    let p = people().await;
    // No sort, so the ordered ids do not depend on values; the page is always
    // loaded fresh by id anyway.
    let cache = &p.f.app.state.query_cache;
    p.f.query(json!({})).await;
    // Edit through the DB without publishing: the cache still serves the old
    // ids, but the page's cells are loaded from the database.
    let id = p.ids[0].clone();
    let name = p.name.clone();
    sql(&p.f.app, |tx| {
        tx.execute(
            "UPDATE records SET data = json_set(data, '$.' || ?2, 'Zed') WHERE id = ?1",
            [&id, &name],
        )
    });
    let resp = p.f.query(json!({})).await;
    assert_eq!(cache.scans(), 1);
    assert_eq!(names(&p, &resp)[0], "Zed");
}

#[tokio::test]
async fn schema_changes_invalidate_the_cache() {
    let p = people().await;
    let cache = &p.f.app.state.query_cache;
    p.f.configure(json!({ "filter": and(vec![cond(&p.age, "gt", json!(26))]) }))
        .await;
    assert_eq!(p.f.query(json!({})).await["total"], 3);
    assert_eq!(cache.scans(), 1);
    // Changing the view's config is a different query (config hash + version).
    p.f.configure(json!({ "filter": and(vec![cond(&p.age, "gt", json!(0))]) }))
        .await;
    assert_eq!(p.f.query(json!({})).await["total"], 4);
    assert_eq!(cache.scans(), 2);
    // Deleting the field behind the filter changes the answer.
    p.f.app
        .delete(&p.f.owner, &format!("/api/fields/{}", p.age))
        .await
        .assert_status(200);
    assert_eq!(p.f.query(json!({})).await["total"], 5);
    assert_eq!(cache.scans(), 3);
}

#[tokio::test]
async fn trashing_and_restoring_records_invalidates_the_cache() {
    let p = people().await;
    let cache = &p.f.app.state.query_cache;
    assert_eq!(p.f.query(json!({})).await["total"], 5);
    p.f.delete_records(&p.f.table_id, &[&p.ids[0]])
        .await
        .assert_status(200);
    assert_eq!(p.f.query(json!({})).await["total"], 4);
    p.f.restore_records(&p.f.table_id, &[&p.ids[0]])
        .await
        .assert_status(200);
    assert_eq!(p.f.query(json!({})).await["total"], 5);
    assert_eq!(cache.scans(), 3);
}

#[tokio::test]
async fn writes_in_one_base_do_not_invalidate_another_bases_cache() {
    let p = people().await;
    let other_ws = workspace(&p.f.app, &p.f.owner, "Other").await;
    let other = base(&p.f.app, &p.f.owner, &other_ws, "Other base").await;
    let other_table = id_str(&other["tables"][0]["id"]);
    let other_primary = id_str(&other["tables"][0]["primary_field_id"]);
    let cache = &p.f.app.state.query_cache;
    p.f.query(json!({})).await;
    assert_eq!(cache.scans(), 1);
    p.f.app
        .post(
            &p.f.owner,
            &records_url(&other_table),
            json!({ "records": [ { "values": { &other_primary: "x" } } ] }),
        )
        .await
        .assert_status(201);
    p.f.query(json!({})).await;
    assert_eq!(
        cache.scans(),
        1,
        "an unrelated base's write must not rescan"
    );
}

// ------------------------------------------------------------ links & names

struct Crm {
    f: Fixture,
    customers: String,
    orders: String,
    /// Link field in Orders to Customers, and its inverse in Customers.
    customer: Value,
    inverse: Value,
    order_ids: Vec<String>,
    customer_ids: Vec<String>,
}

async fn crm() -> Crm {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders_tbl = f.add_table("Orders").await;
    let orders = id_of(&orders_tbl);
    let customer = f.add_link(&orders, "Customer", &customers).await;
    let inverse = customer["inverse"].clone();
    let c1 = f.create(&customers, json!({ &f.primary_id: "Acme" })).await;
    let c2 = f
        .create(&customers, json!({ &f.primary_id: "Globex" }))
        .await;
    let o_primary = id_str(&orders_tbl["primary_field_id"]);
    let mut order_ids = Vec::new();
    for (name, links) in [
        ("order-1", vec![c1["id"].clone()]),
        ("order-2", vec![c1["id"].clone(), c2["id"].clone()]),
        ("order-3", vec![]),
    ] {
        let rec = f
            .create(
                &orders,
                json!({ &o_primary: name, customer["id"].as_str().unwrap(): links }),
            )
            .await;
        order_ids.push(id_str(&rec["id"]));
    }
    let customer_ids = vec![id_str(&c1["id"]), id_str(&c2["id"])];
    Crm {
        f,
        customers,
        orders,
        customer,
        inverse,
        order_ids,
        customer_ids,
    }
}

#[tokio::test]
async fn link_values_are_id_and_name_pairs() {
    let c = crm().await;
    let view = c.f.new_view(&c.orders, "All orders", json!({})).await;
    let resp = c.f.query_view(&view, json!({})).await;
    let link = c.customer["id"].as_str().unwrap();
    assert_eq!(
        resp["records"][0]["values"][link],
        json!([{ "id": c.customer_ids[0], "name": "Acme" }])
    );
    assert_eq!(
        resp["records"][1]["values"][link],
        json!([
            { "id": c.customer_ids[0], "name": "Acme" },
            { "id": c.customer_ids[1], "name": "Globex" },
        ])
    );
    // No links: the cell is absent.
    assert!(resp["records"][2]["values"].get(link).is_none());
    // The inverse side reads the same pairs.
    let cust_view = c.f.new_view(&c.customers, "All customers", json!({})).await;
    let resp = c.f.query_view(&cust_view, json!({})).await;
    let inv = c.inverse["id"].as_str().unwrap();
    assert_eq!(
        resp["records"][0]["values"][inv],
        json!([
            { "id": c.order_ids[0], "name": "order-1" },
            { "id": c.order_ids[1], "name": "order-2" },
        ])
    );
}

#[tokio::test]
async fn trashed_linked_records_are_hidden_from_values_and_filters() {
    let c = crm().await;
    let link = c.customer["id"].as_str().unwrap().to_string();
    let view =
        c.f.new_view(
            &c.orders,
            "Globex orders",
            json!({ "filter": and(vec![cond(&link, "has_any_of", json!([c.customer_ids[1]]))]) }),
        )
        .await;
    let resp = c.f.query_view(&view, json!({})).await;
    assert_eq!(rec_ids(&resp), [c.order_ids[1].clone()]);
    // Trash Globex: order-2 keeps only Acme, and no longer matches the filter.
    c.f.delete_records(&c.customers, &[&c.customer_ids[1]])
        .await
        .assert_status(200);
    let resp = c.f.query_view(&view, json!({})).await;
    assert_eq!(resp["total"], 0);
    let all = c.f.new_view(&c.orders, "All", json!({})).await;
    let resp = c.f.query_view(&all, json!({})).await;
    assert_eq!(
        resp["records"][1]["values"][&link],
        json!([{ "id": c.customer_ids[0], "name": "Acme" }])
    );
    // Restoring brings the link back.
    c.f.restore_records(&c.customers, &[&c.customer_ids[1]])
        .await
        .assert_status(200);
    let resp = c.f.query_view(&view, json!({})).await;
    assert_eq!(rec_ids(&resp), [c.order_ids[1].clone()]);
}

#[tokio::test]
async fn link_cells_filter_sort_and_group_by_linked_names() {
    let c = crm().await;
    let link = c.customer["id"].as_str().unwrap().to_string();
    // Text search inside link names.
    let view =
        c.f.new_view(
            &c.orders,
            "by name",
            json!({ "filter": and(vec![cond(&link, "contains", json!("glob"))]) }),
        )
        .await;
    assert_eq!(
        rec_ids(&c.f.query_view(&view, json!({})).await),
        [c.order_ids[1].clone()]
    );
    // Sort by the linked name (blank first), then group.
    let view =
        c.f.new_view(
            &c.orders,
            "sorted",
            json!({ "sorts": [ { "field_id": link, "direction": "desc" } ] }),
        )
        .await;
    let resp = c.f.query_view(&view, json!({})).await;
    // "Acme, Globex" > "Acme" > blank.
    assert_eq!(
        rec_ids(&resp),
        [
            c.order_ids[1].clone(),
            c.order_ids[0].clone(),
            c.order_ids[2].clone()
        ]
    );
    let view =
        c.f.new_view(
            &c.orders,
            "grouped",
            json!({ "groups": [ { "field_id": link } ] }),
        )
        .await;
    let resp = c.f.query_view(&view, json!({})).await;
    let labels: Vec<&str> = resp["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["(Empty)", "Acme", "Acme, Globex"]);
    // The value to write when dragging into a link group is the id array.
    assert_eq!(resp["groups"][1]["value"], json!([c.customer_ids[0]]));
}

#[tokio::test]
async fn linked_names_update_when_the_linked_record_is_renamed() {
    let c = crm().await;
    let link = c.customer["id"].as_str().unwrap().to_string();
    let view = c.f.new_view(&c.orders, "All", json!({})).await;
    c.f.query_view(&view, json!({})).await;
    c.f.set(
        &c.customers,
        &c.customer_ids[0],
        json!({ &c.f.primary_id: "Acme Inc" }),
    )
    .await;
    let resp = c.f.query_view(&view, json!({})).await;
    assert_eq!(resp["records"][0]["values"][&link][0]["name"], "Acme Inc");
}

#[tokio::test]
async fn lookup_rollup_and_count_cells_are_returned_as_stored() {
    let c = crm().await;
    let price = c.f.number(&c.orders, "Price").await;
    let o_primary = c.f.table(&c.orders).await["primary_field_id"].clone();
    let _ = o_primary;
    for (i, v) in [10, 20, 30].iter().enumerate() {
        c.f.set(
            &c.orders,
            &c.order_ids[i],
            json!({ price["id"].as_str().unwrap(): v }),
        )
        .await;
    }
    let total =
        c.f.rollup(&c.customers, "Total", &c.inverse, &price, "SUM(values)")
            .await;
    let n = c.f.count(&c.customers, "N", &c.inverse).await;
    let prices = c.f.lookup(&c.customers, "Prices", &c.inverse, &price).await;
    let view =
        c.f.new_view(
            &c.customers,
            "Customers",
            json!({ "sorts": [ { "field_id": total["id"], "direction": "desc" } ] }),
        )
        .await;
    let resp = c.f.query_view(&view, json!({})).await;
    // Acme: orders 1+2 = 10+20; Globex: order 2 = 20.
    assert_eq!(
        resp["records"][0]["values"][total["id"].as_str().unwrap()],
        30
    );
    assert_eq!(resp["records"][0]["values"][n["id"].as_str().unwrap()], 2);
    assert_eq!(
        resp["records"][0]["values"][prices["id"].as_str().unwrap()],
        json!([10, 20])
    );
    assert_eq!(
        resp["records"][1]["values"][total["id"].as_str().unwrap()],
        20
    );
}

// ------------------------------------------------------------- row colours

#[tokio::test]
async fn row_colours_by_select_and_by_conditions_for_the_page_only() {
    let p = people().await;
    let todo_colour = {
        let field = p.f.field(&p.f.table_id, "Status").await;
        field["options"]["choices"][0]["color"]
            .as_str()
            .unwrap()
            .to_string()
    };
    p.f.configure(json!({ "row_color": { "mode": "by_select", "field_id": p.status } }))
        .await;
    let resp = p.f.query(json!({})).await;
    let colors = resp["colors"].as_object().unwrap();
    // dave has no status: no colour. Alice and Eve share Todo's colour.
    assert_eq!(colors.len(), 4);
    assert_eq!(colors[&p.ids[0]], todo_colour);
    assert_eq!(colors[&p.ids[4]], todo_colour);
    assert!(!colors.contains_key(&p.ids[3]));
    // Only the returned page is coloured.
    let page = p.f.query(json!({ "offset": 0, "limit": 1 })).await;
    assert_eq!(page["colors"].as_object().unwrap().len(), 1);

    p.f.configure(json!({ "row_color": { "mode": "by_conditions", "rules": [
        { "color": "red", "filter": and(vec![cond(&p.age, "gt", json!(35))]) },
        { "color": "blue", "filter": and(vec![cond(&p.age, "gt", json!(26))]) },
    ] } }))
    .await;
    let resp = p.f.query(json!({})).await;
    let colors = resp["colors"].as_object().unwrap();
    // First matching rule wins: Carol (41) red, Alice and Eve (30) blue, bob (25) none.
    assert_eq!(colors[&p.ids[2]], "red");
    assert_eq!(colors[&p.ids[0]], "blue");
    assert_eq!(colors[&p.ids[4]], "blue");
    assert_eq!(colors.len(), 3);
}

#[tokio::test]
async fn row_colours_follow_edits_without_a_rescan() {
    let p = people().await;
    p.f.configure(json!({ "row_color": { "mode": "by_conditions", "rules": [
        { "color": "red", "filter": and(vec![cond(&p.age, "gt", json!(35))]) },
    ] } }))
    .await;
    let cache = &p.f.app.state.query_cache;
    let resp = p.f.query(json!({})).await;
    assert_eq!(resp["colors"].as_object().unwrap().len(), 1);
    // Bypass the event bus: colours are computed per request from fresh rows.
    let (id, age) = (p.ids[1].clone(), p.age.clone());
    sql(&p.f.app, |tx| {
        tx.execute(
            "UPDATE records SET data = json_set(data, '$.' || ?2, 99) WHERE id = ?1",
            [&id, &age],
        )
    });
    let resp = p.f.query(json!({})).await;
    assert_eq!(cache.scans(), 1);
    assert_eq!(resp["colors"].as_object().unwrap().len(), 2);
}

// ------------------------------------------------------------- permissions

#[tokio::test]
async fn query_permissions() {
    let p = people().await;
    // Any role on the base may read.
    for role in ALL_ROLES {
        let u =
            p.f.member(&format!("{}-user@example.com", role.as_str()), role);
        p.f.query_as(&u, p.view(), json!({}))
            .await
            .assert_status(200);
    }
    let guest = p.f.base_guest("guest@example.com", Role::Viewer);
    p.f.query_as(&guest, p.view(), json!({}))
        .await
        .assert_status(200);
    // Strangers and anonymous callers get 404 / 401, never data.
    let stranger = p.f.app.user("stranger@example.com", "Stranger");
    p.f.query_as(&stranger, p.view(), json!({}))
        .await
        .assert_status(404);
    p.f.query_as(&p.f.app.anon(), p.view(), json!({}))
        .await
        .assert_status(401);
    // API tokens work, read-only ones too.
    let ro = token_client(&p.f.app, &p.f.owner, false);
    let resp = p.f.query_as(&ro, p.view(), json!({})).await;
    resp.assert_status(200);
    assert_eq!(resp.body["total"], 5);
    // A token limited to other bases cannot read this one.
    let uid = p.f.owner.user_id.clone().unwrap();
    let scopes = json!({ "write": true, "base_ids": ["bseOther"] }).to_string();
    let token = "pat_scoped_token";
    let hash = opengrid::ids::hash_token(token);
    sql(&p.f.app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES ('pat1', ?1, 't', ?2, ?3, 1)",
            rusqlite::params![uid, hash, scopes],
        )
    });
    let scoped = crate::common::Client {
        cookie: None,
        bearer: Some(token.into()),
        user_id: Some(uid),
    };
    p.f.query_as(&scoped, p.view(), json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn personal_views_can_only_be_queried_by_their_owner() {
    let p = people().await;
    let editor = p.f.member("editor@example.com", Role::Editor);
    let r =
        p.f.app
            .post(
                &editor,
                &format!("/api/tables/{}/views", p.f.table_id),
                json!({ "name": "Mine", "type": "grid", "personal": true,
                    "config": { "filter": and(vec![cond(&p.age, "gt", json!(30))]) } }),
            )
            .await;
    r.assert_status(201);
    let view = id_of(&r.body);
    let resp = p.f.query_as(&editor, &view, json!({})).await;
    resp.assert_status(200);
    assert_eq!(names(&p, &resp.body), ["Carol"]);
    // The base owner cannot see someone else's personal view.
    p.f.query_as(&p.f.owner, &view, json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn trashed_views_and_tables_cannot_be_queried() {
    let p = people().await;
    let v = p.f.new_view(&p.f.table_id, "Extra", json!({})).await;
    p.f.app
        .delete(&p.f.owner, &format!("/api/views/{v}"))
        .await
        .assert_status(200);
    p.f.query_as(&p.f.owner, &v, json!({}))
        .await
        .assert_status(404);
}
