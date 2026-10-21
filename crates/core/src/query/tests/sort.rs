//! Sorting, grouping, group spans and sort/group validation.

use std::cmp::Ordering;

use chrono_tz::Tz;
use serde_json::{Value as Json, json};

use super::*;
use crate::limits::{MAX_GROUPS, MAX_SORTS};
use crate::query::{
    EMPTY_GROUP_LABEL, NO_DATE_GROUP_LABEL, OwnedRow, Row, compare, group_key, group_spans,
    period_start, sort_rows, sort_rows_with_groups, validate_groups, validate_sorts,
};
use crate::view::{DateGranularity, Direction, Group, Sort};

fn asc(field: &str) -> Sort {
    Sort {
        field_id: field.into(),
        direction: Direction::Asc,
    }
}

fn desc(field: &str) -> Sort {
    Sort {
        field_id: field.into(),
        direction: Direction::Desc,
    }
}

fn group(field: &str, direction: Direction, granularity: Option<DateGranularity>) -> Group {
    Group {
        field_id: field.into(),
        direction,
        granularity,
    }
}

fn gasc(field: &str) -> Group {
    group(field, Direction::Asc, None)
}

fn gdesc(field: &str) -> Group {
    group(field, Direction::Desc, None)
}

/// Rows `r0..rN` with `field` set to each value (null = absent).
fn rows_of(field: &str, values: &[Json]) -> Vec<OwnedRow> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            if v.is_null() {
                row(&format!("r{i}"), json!({}))
            } else {
                row(&format!("r{i}"), json!({ field: v }))
            }
        })
        .collect()
}

fn ids(rows: &[OwnedRow]) -> Vec<&str> {
    rows.iter().map(|r| r.id()).collect()
}

fn sorted(field: &str, values: &[Json], dir: Direction) -> Vec<String> {
    let mut rows = rows_of(field, values);
    sort_rows(
        &mut rows,
        &[Sort {
            field_id: field.into(),
            direction: dir,
        }],
        &table(),
        &names(),
        Tz::UTC,
    );
    rows.into_iter().map(|r| r.id).collect()
}

fn cmp(field: &str, a: Json, b: Json) -> Ordering {
    let t = table();
    let an = (!a.is_null()).then_some(&a);
    let bn = (!b.is_null()).then_some(&b);
    compare(&t[field], an, bn, &names(), Tz::UTC)
}

#[test]
fn text_natural_case_insensitive() {
    let v = [
        json!("item 10"),
        json!("Item 2"),
        json!("apple"),
        Json::Null,
        json!("Banana"),
        json!("item 1"),
        json!(""),
    ];
    assert_eq!(
        sorted("fldText", &v, Direction::Asc),
        ["r3", "r6", "r2", "r4", "r5", "r1", "r0"]
    );
    assert_eq!(
        sorted("fldText", &v, Direction::Desc),
        ["r0", "r1", "r5", "r4", "r2", "r3", "r6"]
    );
    assert_eq!(cmp("fldText", json!("z2"), json!("z11")), Ordering::Less);
    assert_eq!(cmp("fldText", json!("a"), json!("B")), Ordering::Less);
    assert_eq!(cmp("fldText", json!("abc"), json!("ABC")), Ordering::Equal);
    assert_eq!(
        cmp("fldText", json!("x007"), json!("x7")),
        Ordering::Equal,
        "leading zeros"
    );
    assert_eq!(
        cmp("fldText", json!("2"), json!("a")),
        Ordering::Less,
        "digits before letters"
    );
    assert_eq!(cmp("fldText", json!("ab"), json!("abc")), Ordering::Less);
    assert_eq!(
        cmp(
            "fldText",
            json!("99999999999999999999999"),
            json!("100000000000000000000000")
        ),
        Ordering::Less,
        "huge digit runs"
    );
}

#[test]
fn blanks_first_ascending_last_descending() {
    let v = [json!(3), Json::Null, json!(1)];
    assert_eq!(sorted("fldNum", &v, Direction::Asc), ["r1", "r2", "r0"]);
    assert_eq!(sorted("fldNum", &v, Direction::Desc), ["r0", "r2", "r1"]);
    assert_eq!(cmp("fldNum", Json::Null, json!(-1e300)), Ordering::Less);
    assert_eq!(
        cmp("fldDate", Json::Null, json!("1000-01-01")),
        Ordering::Less
    );
    assert_eq!(cmp("fldSel", Json::Null, json!("selRed")), Ordering::Less);
}

#[test]
fn numbers() {
    let v = [json!(10), json!(-2.5), json!(2), json!(0), json!(1e9)];
    assert_eq!(
        sorted("fldNum", &v, Direction::Asc),
        ["r1", "r3", "r2", "r0", "r4"]
    );
    assert_eq!(cmp("fldPct", json!(0.5), json!(0.25)), Ordering::Greater);
    assert_eq!(cmp("fldDur", json!(60), json!(3600)), Ordering::Less);
    assert_eq!(cmp("fldRating", json!(5), json!(5)), Ordering::Equal);
    assert_eq!(
        cmp("fldFNum", json!(2), json!(10)),
        Ordering::Less,
        "formula numbers, not text"
    );
    assert_eq!(
        cmp("fldFNum", json!({"error": "x"}), json!(1)),
        Ordering::Less,
        "errors sort as blanks"
    );
    assert_eq!(cmp("fldAuto", json!(9), json!(10)), Ordering::Less);
}

#[test]
fn dates_chronological() {
    let v = [
        json!("2026-10-12"),
        json!("2025-01-01"),
        Json::Null,
        json!("2026-10-11"),
    ];
    assert_eq!(
        sorted("fldDate", &v, Direction::Asc),
        ["r2", "r1", "r3", "r0"]
    );
    let v = [
        json!("2026-10-12T10:00:00.000Z"),
        json!("2026-10-12T09:59:59.999Z"),
        json!("2026-10-12"),
    ];
    assert_eq!(
        sorted("fldDt", &v, Direction::Asc),
        ["r2", "r1", "r0"],
        "date-only = midnight"
    );
    assert_eq!(
        cmp(
            "fldCreated",
            json!("2026-10-12T10:00:00.000Z"),
            json!("2026-10-12T10:00:00.001Z")
        ),
        Ordering::Less
    );
    assert_eq!(
        cmp("fldFDate", json!("2026-01-02"), json!("2026-01-01")),
        Ordering::Greater
    );
}

#[test]
fn selects_by_choice_order() {
    // Options order: Red, Green, Blue, "Red, dark".
    let v = [
        json!("selBlue"),
        json!("selRed"),
        Json::Null,
        json!("selDark"),
        json!("selGreen"),
        json!("selGone"),
    ];
    assert_eq!(
        sorted("fldSel", &v, Direction::Asc),
        ["r2", "r5", "r1", "r4", "r0", "r3"]
    );
    let v = [
        json!(["selBlue"]),
        json!(["selRed", "selBlue"]),
        json!(["selRed"]),
        json!(["selGreen", "selRed"]),
        Json::Null,
    ];
    // First choice's order, then count.
    assert_eq!(
        sorted("fldMulti", &v, Direction::Asc),
        ["r4", "r2", "r1", "r3", "r0"]
    );
}

#[test]
fn checkbox_false_before_true() {
    let v = [json!(true), Json::Null, json!(true), Json::Null];
    assert_eq!(
        sorted("fldCheck", &v, Direction::Asc),
        ["r1", "r3", "r0", "r2"]
    );
    assert_eq!(
        sorted("fldCheck", &v, Direction::Desc),
        ["r0", "r2", "r1", "r3"]
    );
    assert_eq!(cmp("fldFBool", json!(false), json!(true)), Ordering::Less);
}

#[test]
fn links_users_attachments_by_display_name() {
    // recA = Alpha, recB = Beta, recC = "Gamma, Inc".
    let v = [
        json!(["recC"]),
        json!(["recB"]),
        json!(["recA", "recC"]),
        Json::Null,
    ];
    assert_eq!(
        sorted("fldLink", &v, Direction::Asc),
        ["r3", "r2", "r1", "r0"]
    );
    let v = [json!(["usr2"]), json!(["usr1"])];
    assert_eq!(
        sorted("fldOwner", &v, Direction::Asc),
        ["r1", "r0"],
        "Ada before Grace"
    );
    assert_eq!(
        cmp("fldCreatedBy", json!("usr2"), json!("usr1")),
        Ordering::Greater
    );
    let a = json!([{"id": "attA", "filename": "b.png", "mime": "image/png", "size": 1}]);
    let b = json!([{"id": "attB", "filename": "A.png", "mime": "image/png", "size": 1}]);
    assert_eq!(cmp("fldAtt", a, b), Ordering::Greater);
    assert_eq!(
        cmp("fldLookup", json!(["a", "b"]), json!(["a", "c"])),
        Ordering::Less
    );
    assert_eq!(cmp("fldLookupNum", json!([2]), json!([10])), Ordering::Less);
}

#[test]
fn stable_ties_and_multi_level() {
    let mut rows = vec![
        row("r0", json!({"fldSel": "selBlue", "fldNum": 1})),
        row("r1", json!({"fldSel": "selRed", "fldNum": 5})),
        row("r2", json!({"fldSel": "selBlue", "fldNum": 3})),
        row("r3", json!({"fldSel": "selRed", "fldNum": 5})),
        row("r4", json!({"fldNum": 2})),
    ];
    sort_rows(
        &mut rows,
        &[asc("fldSel"), desc("fldNum")],
        &table(),
        &names(),
        Tz::UTC,
    );
    assert_eq!(
        ids(&rows),
        ["r4", "r1", "r3", "r2", "r0"],
        "r1/r3 tie keeps input order"
    );
    // No sorts: untouched. Unknown sort fields are skipped.
    let before = ids(&rows).iter().map(|s| s.to_string()).collect::<Vec<_>>();
    sort_rows(&mut rows, &[], &table(), &names(), Tz::UTC);
    sort_rows(&mut rows, &[asc("fldMissing")], &table(), &names(), Tz::UTC);
    assert_eq!(ids(&rows), before);
}

#[test]
fn sort_works_on_borrowed_rows() {
    let owned = rows_of("fldNum", &[json!(3), json!(1), json!(2)]);
    let mut refs: Vec<&OwnedRow> = owned.iter().collect();
    sort_rows(&mut refs, &[asc("fldNum")], &table(), &names(), Tz::UTC);
    assert_eq!(
        refs.iter().map(|r| r.id()).collect::<Vec<_>>(),
        ["r1", "r2", "r0"]
    );
}

#[test]
fn sort_in_viewer_zone_uses_display_for_text_kinds() {
    // Date-time sorting is by instant regardless of zone.
    let v = [
        json!("2026-10-12T23:00:00.000Z"),
        json!("2026-10-12T01:00:00.000Z"),
    ];
    let mut rows = rows_of("fldDt", &v);
    sort_rows(
        &mut rows,
        &[asc("fldDt")],
        &table(),
        &names(),
        "Pacific/Auckland".parse().unwrap(),
    );
    assert_eq!(ids(&rows), ["r1", "r0"]);
}

fn gk(field: &str, v: Json) -> crate::query::GroupKey {
    let t = table();
    let stored = (!v.is_null()).then_some(&v);
    group_key(&t[field], stored, &names(), Tz::UTC, None)
}

#[test]
fn group_keys() {
    let e = gk("fldText", Json::Null);
    assert!(e.empty);
    assert_eq!((e.key.as_str(), e.label.as_str()), ("", EMPTY_GROUP_LABEL));
    assert_eq!(gk("fldText", json!("")).key, "");
    let t = gk("fldText", json!("Apple"));
    assert_eq!(
        (t.key.as_str(), t.label.as_str(), t.empty),
        ("Apple", "Apple", false)
    );
    assert_ne!(
        gk("fldText", json!("apple")).key,
        t.key,
        "text groups are exact"
    );
    let s = gk("fldSel", json!("selBlue"));
    assert_eq!(
        (s.key.as_str(), s.label.as_str(), s.color.as_deref()),
        ("selBlue", "Blue", Some("blue"))
    );
    assert!(
        gk("fldSel", json!("selGone")).empty,
        "deleted choices group as empty"
    );
    // Multi select: exact combination, order-insensitive.
    let a = gk("fldMulti", json!(["selBlue", "selRed"]));
    let b = gk("fldMulti", json!(["selRed", "selBlue"]));
    assert_eq!(a.key, b.key);
    assert_eq!(a.key, "selRed,selBlue");
    assert_eq!(a.label, "Red, Blue");
    assert_ne!(gk("fldMulti", json!(["selRed"])).key, a.key);
    // Checkbox: checked / unchecked, never empty.
    let c = gk("fldCheck", json!(true));
    assert_eq!((c.key.as_str(), c.label.as_str()), ("true", "Checked"));
    let u = gk("fldCheck", Json::Null);
    assert_eq!(
        (u.key.as_str(), u.label.as_str(), u.empty),
        ("false", "Unchecked", false)
    );
    // Numbers by canonical value, labelled with the format.
    let n = gk("fldNum", json!(2));
    assert_eq!((n.key.as_str(), n.label.as_str()), ("2", "2.00"));
    assert_eq!(gk("fldNum", json!(2.0)).key, n.key);
    // Date-times group by day in the zone.
    let d1 = gk("fldDt", json!("2026-10-12T01:00:00.000Z"));
    let d2 = gk("fldDt", json!("2026-10-12T23:00:00.000Z"));
    assert_eq!(d1.key, "2026-10-12");
    assert_eq!(d1.key, d2.key);
    assert_eq!(d1.label, "October 12, 2026");
    let t = table();
    let akl = group_key(
        &t["fldDt"],
        Some(&json!("2026-10-12T23:00:00.000Z")),
        &names(),
        "Pacific/Auckland".parse().unwrap(),
        None,
    );
    assert_eq!(akl.key, "2026-10-13");
    // Links and users: by ids in stored order, labelled with names.
    let l = gk("fldLink", json!(["recA", "recB"]));
    assert_eq!(
        (l.key.as_str(), l.label.as_str()),
        ("recA,recB", "Alpha, Beta")
    );
    assert_eq!(gk("fldOwner", json!(["usr1"])).label, "Ada Lovelace");
    assert_eq!(gk("fldCreatedBy", json!("usr2")).key, "usr2");
    let att = gk(
        "fldAtt",
        json!([{"id": "attA", "filename": "a.png", "mime": "image/png", "size": 1}]),
    );
    assert_eq!((att.key.as_str(), att.label.as_str()), ("attA", "a.png"));
    assert_eq!(gk("fldLookup", json!(["x", "y"])).label, "x, y");
    assert!(gk("fldButton", json!("https://x.y")).empty);
    assert!(!gk("fldFNum", json!({"error": "#ERROR"})).empty);
}

#[test]
fn grouped_sort_and_spans() {
    let mut rows = vec![
        row(
            "r0",
            json!({"fldSel": "selBlue", "fldCheck": true, "fldNum": 2}),
        ),
        row("r1", json!({"fldSel": "selRed", "fldNum": 9})),
        row("r2", json!({"fldNum": 4})),
        row("r3", json!({"fldSel": "selBlue", "fldNum": 1})),
        row(
            "r4",
            json!({"fldSel": "selRed", "fldCheck": true, "fldNum": 3}),
        ),
        row(
            "r5",
            json!({"fldSel": "selBlue", "fldCheck": true, "fldNum": 7}),
        ),
    ];
    let groups = [gasc("fldSel"), gdesc("fldCheck")];
    let t = table();
    sort_rows_with_groups(&mut rows, &groups, &[asc("fldNum")], &t, &names(), Tz::UTC);
    assert_eq!(ids(&rows), ["r2", "r4", "r1", "r0", "r5", "r3"]);
    let spans = group_spans(&rows, &groups, &t, &names(), Tz::UTC);
    let summary: Vec<(usize, &str, usize, usize)> = spans
        .iter()
        .map(|s| (s.level, s.key.label.as_str(), s.start, s.count))
        .collect();
    assert_eq!(
        summary,
        vec![
            (0, EMPTY_GROUP_LABEL, 0, 1),
            (1, "Unchecked", 0, 1),
            (0, "Red", 1, 2),
            (1, "Checked", 1, 1),
            (1, "Unchecked", 2, 1),
            (0, "Blue", 3, 3),
            (1, "Checked", 3, 2),
            (1, "Unchecked", 5, 1),
        ]
    );
    assert_eq!(
        spans[3].path,
        vec!["selRed".to_string(), "true".to_string()]
    );
    // Descending group direction puts the empty group last.
    let mut rows2 = rows.clone();
    sort_rows_with_groups(&mut rows2, &[gdesc("fldSel")], &[], &t, &names(), Tz::UTC);
    let spans = group_spans(&rows2, &[gdesc("fldSel")], &t, &names(), Tz::UTC);
    let labels: Vec<&str> = spans.iter().map(|s| s.key.label.as_str()).collect();
    assert_eq!(labels, ["Blue", "Red", EMPTY_GROUP_LABEL]);
    assert_eq!(spans.iter().map(|s| s.count).sum::<usize>(), rows2.len());
    // No groups: no spans; no rows: no spans.
    assert!(group_spans(&rows, &[], &t, &names(), Tz::UTC).is_empty());
    let empty: Vec<OwnedRow> = vec![];
    assert!(group_spans(&empty, &groups, &t, &names(), Tz::UTC).is_empty());
}

#[test]
fn grouping_datetimes_by_day_then_sorting_within() {
    let mut rows = rows_of(
        "fldDt",
        &[
            json!("2026-10-12T20:00:00.000Z"),
            json!("2026-10-11T09:00:00.000Z"),
            json!("2026-10-12T08:00:00.000Z"),
        ],
    );
    let t = table();
    sort_rows_with_groups(
        &mut rows,
        &[gasc("fldDt")],
        &[desc("fldDt")],
        &t,
        &names(),
        Tz::UTC,
    );
    assert_eq!(ids(&rows), ["r1", "r0", "r2"]);
    let spans = group_spans(&rows, &[gasc("fldDt")], &t, &names(), Tz::UTC);
    assert_eq!(spans.len(), 2);
    assert_eq!(
        (spans[1].key.key.as_str(), spans[1].count),
        ("2026-10-12", 2)
    );
}

#[test]
fn period_starts() {
    let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
    let day = d("2026-10-21"); // a Wednesday
    let cases = [
        (DateGranularity::Day, "2026-10-21"),
        (DateGranularity::Week, "2026-10-19"),
        (DateGranularity::Month, "2026-10-01"),
        (DateGranularity::Quarter, "2026-10-01"),
        (DateGranularity::Year, "2026-01-01"),
    ];
    for (g, want) in cases {
        assert_eq!(period_start(day, g), d(want), "{g:?}");
    }
    // A Monday starts its own week; a Sunday belongs to the week before.
    assert_eq!(
        period_start(d("2026-10-19"), DateGranularity::Week),
        d("2026-10-19")
    );
    assert_eq!(
        period_start(d("2026-10-25"), DateGranularity::Week),
        d("2026-10-19")
    );
    // Weeks cross month and year boundaries.
    assert_eq!(
        period_start(d("2027-01-01"), DateGranularity::Week),
        d("2026-12-28")
    );
    assert_eq!(
        period_start(d("2026-05-31"), DateGranularity::Quarter),
        d("2026-04-01")
    );
}

fn gk_at(field: &str, v: Json, g: DateGranularity, tz: Tz) -> (String, String) {
    let t = table();
    let k = group_key(&t[field], Some(&v), &names(), tz, Some(g));
    (k.key, k.label)
}

#[test]
fn date_group_keys_by_granularity() {
    let v = json!("2026-10-21");
    let cases = [
        (DateGranularity::Day, "2026-10-21", "October 21, 2026"),
        (
            DateGranularity::Week,
            "2026-W43",
            "Week of October 19, 2026",
        ),
        (DateGranularity::Month, "2026-10", "October 2026"),
        (DateGranularity::Quarter, "2026-Q4", "Q4 2026"),
        (DateGranularity::Year, "2026", "2026"),
    ];
    for (g, key, label) in cases {
        assert_eq!(
            gk_at("fldDate", v.clone(), g, Tz::UTC),
            (key.to_string(), label.to_string())
        );
    }
    // The ISO week year of a week starting in December is the next year's.
    assert_eq!(
        gk_at(
            "fldDate",
            json!("2026-12-30"),
            DateGranularity::Week,
            Tz::UTC
        )
        .0,
        "2026-W53"
    );
    assert_eq!(
        gk_at(
            "fldDate",
            json!("2025-12-30"),
            DateGranularity::Week,
            Tz::UTC
        )
        .0,
        "2026-W01"
    );
    // Date-times bucket in the viewer's zone: 31 Dec 23:00 UTC is already the
    // new year in Auckland.
    let late = json!("2026-12-31T23:00:00.000Z");
    let akl: Tz = "Pacific/Auckland".parse().unwrap();
    assert_eq!(
        gk_at("fldDt", late.clone(), DateGranularity::Year, Tz::UTC).0,
        "2026"
    );
    assert_eq!(
        gk_at("fldDt", late.clone(), DateGranularity::Year, akl).0,
        "2027"
    );
    assert_eq!(
        gk_at("fldDt", late, DateGranularity::Month, akl).1,
        "January 2027"
    );
    // ...and in the field's own zone when it has one (Tokyo is UTC+9).
    assert_eq!(
        gk_at(
            "fldDtTokyo",
            json!("2026-09-30T16:00:00.000Z"),
            DateGranularity::Month,
            Tz::UTC
        )
        .1,
        "October 2026"
    );
    // Created time and date formulas are dates too.
    assert_eq!(
        gk_at(
            "fldCreated",
            json!("2026-03-05T10:00:00.000Z"),
            DateGranularity::Quarter,
            Tz::UTC
        )
        .1,
        "Q1 2026"
    );
    assert_eq!(
        gk_at(
            "fldFDate",
            json!("2026-03-05"),
            DateGranularity::Month,
            Tz::UTC
        )
        .1,
        "March 2026"
    );
    // Records without a date form one "No date" group.
    let t = table();
    let none = group_key(
        &t["fldDate"],
        None,
        &names(),
        Tz::UTC,
        Some(DateGranularity::Month),
    );
    assert!(none.empty);
    assert_eq!(
        (none.key.as_str(), none.label.as_str()),
        ("", NO_DATE_GROUP_LABEL)
    );
    // A granularity on a field that is not a date is ignored.
    let txt = group_key(
        &t["fldText"],
        Some(&json!("2026-10-21")),
        &names(),
        Tz::UTC,
        Some(DateGranularity::Year),
    );
    assert_eq!(txt.key, "2026-10-21");
    assert_eq!(gk("fldText", Json::Null).label, EMPTY_GROUP_LABEL);
}

#[test]
fn grouping_dates_by_month_orders_chronologically() {
    let values = [
        json!("2026-11-02"),
        json!("2025-12-31"),
        Json::Null,
        json!("2026-10-21"),
        json!("2026-11-30"),
        json!("2026-10-01"),
    ];
    let t = table();
    for (direction, want) in [
        (
            Direction::Asc,
            vec![
                (NO_DATE_GROUP_LABEL, 1),
                ("December 2025", 1),
                ("October 2026", 2),
                ("November 2026", 2),
            ],
        ),
        (
            Direction::Desc,
            vec![
                ("November 2026", 2),
                ("October 2026", 2),
                ("December 2025", 1),
                (NO_DATE_GROUP_LABEL, 1),
            ],
        ),
    ] {
        let groups = [group("fldDate", direction, Some(DateGranularity::Month))];
        let mut rows = rows_of("fldDate", &values);
        // Within a month, records follow the view's sort (newest first here).
        sort_rows_with_groups(
            &mut rows,
            &groups,
            &[desc("fldDate")],
            &t,
            &names(),
            Tz::UTC,
        );
        let spans = group_spans(&rows, &groups, &t, &names(), Tz::UTC);
        let got: Vec<(&str, usize)> = spans
            .iter()
            .map(|s| (s.key.label.as_str(), s.count))
            .collect();
        assert_eq!(got, want, "{direction:?}");
        if direction == Direction::Asc {
            assert_eq!(ids(&rows), ["r2", "r1", "r3", "r5", "r4", "r0"]);
        }
    }
    // A year level over a month level nests the months.
    let groups = [
        group("fldDate", Direction::Asc, Some(DateGranularity::Year)),
        group("fldDt", Direction::Asc, Some(DateGranularity::Month)),
    ];
    let mut rows = vec![
        row(
            "a",
            json!({"fldDate": "2026-01-01", "fldDt": "2026-02-10T00:00:00.000Z"}),
        ),
        row(
            "b",
            json!({"fldDate": "2026-07-07", "fldDt": "2026-01-10T00:00:00.000Z"}),
        ),
        row(
            "c",
            json!({"fldDate": "2025-07-07", "fldDt": "2026-02-11T00:00:00.000Z"}),
        ),
    ];
    sort_rows_with_groups(&mut rows, &groups, &[], &t, &names(), Tz::UTC);
    let spans = group_spans(&rows, &groups, &t, &names(), Tz::UTC);
    let got: Vec<(usize, &str)> = spans
        .iter()
        .map(|s| (s.level, s.key.label.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            (0, "2025"),
            (1, "February 2026"),
            (0, "2026"),
            (1, "January 2026"),
            (1, "February 2026"),
        ]
    );
    assert_eq!(spans[4].path, ["2026", "2026-02"]);
}

#[test]
fn validate_sorts_and_groups() {
    let t = table();
    assert!(validate_sorts(&[asc("fldText"), desc("fldNum")], &t).is_ok());
    assert!(validate_sorts(&[], &t).is_ok());
    assert!(
        validate_sorts(&[asc("fldNope")], &t)
            .unwrap_err()
            .contains("unknown field")
    );
    assert!(
        validate_sorts(&[asc("fldButton")], &t)
            .unwrap_err()
            .contains("cannot sort")
    );
    assert!(
        validate_sorts(&[asc("fldNum"), desc("fldNum")], &t)
            .unwrap_err()
            .contains("more than one")
    );
    let many: Vec<Sort> = t
        .keys()
        .filter(|k| *k != "fldButton")
        .take(MAX_SORTS + 1)
        .map(|k| asc(k))
        .collect();
    assert!(validate_sorts(&many[..MAX_SORTS], &t).is_ok());
    assert!(validate_sorts(&many, &t).unwrap_err().contains("at most"));
    assert!(validate_groups(&[gasc("fldSel"), gasc("fldCheck"), gasc("fldDate")], &t).is_ok());
    let over: Vec<Group> = many[..MAX_GROUPS + 1]
        .iter()
        .map(|s| gasc(&s.field_id))
        .collect();
    assert!(
        validate_groups(&over, &t)
            .unwrap_err()
            .contains("at most 3 groups")
    );
    assert!(
        validate_groups(&[gasc("fldButton")], &t)
            .unwrap_err()
            .contains("cannot group")
    );
    assert!(
        validate_groups(&[gasc("x")], &t)
            .unwrap_err()
            .contains("unknown field x")
    );
    // A granularity only on date fields.
    for f in ["fldDate", "fldDt", "fldCreated", "fldFDate"] {
        let g = group(f, Direction::Desc, Some(DateGranularity::Quarter));
        assert!(validate_groups(&[g], &t).is_ok(), "{f}");
    }
    let err = validate_groups(
        &[group("fldNum", Direction::Asc, Some(DateGranularity::Year))],
        &t,
    )
    .unwrap_err();
    assert!(err.contains("needs a date field"), "{err}");
}
