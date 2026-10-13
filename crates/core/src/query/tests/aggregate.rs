//! Summary-bar aggregations.

use chrono_tz::Tz;
use serde_json::{Value as Json, json};

use super::*;
use crate::cell::tests::fixtures::sample_field;
use crate::query::{aggregate, aggregations_for};
use crate::view::Aggregation::{self, *};

const ALL: [Aggregation; 21] = [
    None,
    Empty,
    Filled,
    Unique,
    PercentEmpty,
    PercentFilled,
    PercentUnique,
    Sum,
    Average,
    Median,
    Min,
    Max,
    Range,
    StdDev,
    Checked,
    Unchecked,
    PercentChecked,
    PercentUnchecked,
    EarliestDate,
    LatestDate,
    DateRangeDays,
];

fn agg(a: Aggregation, field: &str, values: &[Json]) -> Json {
    let t = table();
    let refs: Vec<Option<&Json>> = values.iter().map(|v| (!v.is_null()).then_some(v)).collect();
    aggregate(a, &t[field], &refs, Tz::UTC)
}

fn approx(j: &Json, want: f64) -> bool {
    j.as_f64().is_some_and(|v| (v - want).abs() < 1e-9)
}

#[test]
fn offered_aggregations_per_type() {
    let offered = |t| aggregations_for(&sample_field(t));
    let counts = [
        None,
        Empty,
        Filled,
        PercentEmpty,
        PercentFilled,
        Unique,
        PercentUnique,
    ];
    assert_eq!(offered(FieldType::SingleLineText), counts.to_vec());
    let mut num = counts.to_vec();
    num.extend([Sum, Average, Median, Min, Max, Range, StdDev]);
    for t in [
        FieldType::Number,
        FieldType::Currency,
        FieldType::Percent,
        FieldType::Duration,
        FieldType::Rating,
        FieldType::Count,
        FieldType::Autonumber,
        FieldType::Formula,
        FieldType::Rollup,
    ] {
        assert_eq!(offered(t), num, "{t:?}");
    }
    let mut date = counts.to_vec();
    date.extend([EarliestDate, LatestDate, DateRangeDays]);
    for t in [
        FieldType::Date,
        FieldType::CreatedTime,
        FieldType::LastModifiedTime,
    ] {
        assert_eq!(offered(t), date, "{t:?}");
    }
    assert_eq!(
        offered(FieldType::Checkbox),
        vec![None, Checked, Unchecked, PercentChecked, PercentUnchecked]
    );
    assert_eq!(
        offered(FieldType::Attachment),
        vec![None, Empty, Filled, PercentEmpty, PercentFilled]
    );
    assert_eq!(offered(FieldType::Button), vec![None]);
    for t in FieldType::ALL {
        assert_eq!(offered(t)[0], None, "{t:?}");
    }
}

#[test]
fn every_type_and_aggregation_is_total() {
    for t in FieldType::ALL {
        let f = sample_field(t);
        let samples = crate::cell::tests::fixtures::sample_values(t);
        let mut refs: Vec<Option<&Json>> = samples.iter().map(Some).collect();
        refs.push(Option::None);
        let offered = aggregations_for(&f);
        for a in ALL {
            let out = aggregate(a, &f, &refs, Tz::UTC);
            if !offered.contains(&a) || a == None {
                assert_eq!(out, Json::Null, "{t:?} {a:?} not offered");
            }
            let _ = aggregate(a, &f, &[], Tz::UTC);
        }
    }
}

#[test]
fn counts_and_percentages() {
    let v = [json!("a"), Json::Null, json!(""), json!("b"), json!("a")];
    assert_eq!(agg(Empty, "fldText", &v), json!(2));
    assert_eq!(agg(Filled, "fldText", &v), json!(3));
    assert!(approx(&agg(PercentEmpty, "fldText", &v), 0.4));
    assert!(approx(&agg(PercentFilled, "fldText", &v), 0.6));
    assert_eq!(agg(Unique, "fldText", &v), json!(2));
    assert!(approx(&agg(PercentUnique, "fldText", &v), 0.4));
    assert_eq!(agg(PercentEmpty, "fldText", &[]), json!(0), "no rows => 0");
    assert_eq!(agg(Empty, "fldText", &[]), json!(0));
    assert_eq!(agg(None, "fldText", &v), Json::Null);
    // Multi select unique by combination regardless of order.
    let m = [
        json!(["selRed", "selBlue"]),
        json!(["selBlue", "selRed"]),
        json!(["selRed"]),
    ];
    assert_eq!(agg(Unique, "fldMulti", &m), json!(2));
    // Numbers unique by value (5 and 5.0 are one).
    assert_eq!(
        agg(Unique, "fldNum", &[json!(5), json!(5.0), json!(6)]),
        json!(2)
    );
    // Links by ids.
    assert_eq!(
        agg(
            Unique,
            "fldLink",
            &[json!(["recA"]), json!(["recA"]), json!(["recB"])]
        ),
        json!(2)
    );
    assert_eq!(
        agg(
            Filled,
            "fldAtt",
            &[
                json!([]),
                json!([{"id": "attA", "filename": "a", "mime": "a/b", "size": 1}])
            ]
        ),
        json!(1)
    );
}

#[test]
fn numeric_statistics() {
    let v = [
        json!(2),
        json!(4),
        json!(4),
        json!(4),
        json!(5),
        json!(5),
        json!(7),
        json!(9),
        Json::Null,
    ];
    assert_eq!(agg(Sum, "fldNum", &v), json!(40));
    assert_eq!(agg(Average, "fldNum", &v), json!(5));
    assert_eq!(agg(Median, "fldNum", &v), json!(4.5));
    assert_eq!(agg(Min, "fldNum", &v), json!(2));
    assert_eq!(agg(Max, "fldNum", &v), json!(9));
    assert_eq!(agg(Range, "fldNum", &v), json!(7));
    // Sample standard deviation: sqrt(32 / 7).
    assert!(approx(&agg(StdDev, "fldNum", &v), (32.0f64 / 7.0).sqrt()));
    assert_eq!(
        agg(Median, "fldNum", &[json!(3), json!(1), json!(2)]),
        json!(2)
    );
    assert_eq!(agg(StdDev, "fldNum", &[json!(3)]), json!(0));
    assert_eq!(
        agg(Sum, "fldNum", &[Json::Null]),
        json!(0),
        "sum of nothing is 0"
    );
    for a in [Average, Median, Min, Max, Range, StdDev] {
        assert_eq!(
            agg(a, "fldNum", &[Json::Null]),
            Json::Null,
            "{a:?} of nothing"
        );
    }
    assert!(
        approx(&agg(Sum, "fldPct", &[json!(0.1), json!(0.2)]), 0.3),
        "percent sums stay fractions"
    );
    assert_eq!(
        agg(
            Average,
            "fldFNum",
            &[json!(1), json!({"error": "#ERR"}), json!(3)]
        ),
        json!(2),
        "errors skipped"
    );
    assert_eq!(agg(Sum, "fldNum", &[json!(-1.5), json!(1.5)]), json!(0));
    assert_eq!(
        agg(Sum, "fldText", &[json!("1")]),
        Json::Null,
        "not offered for text"
    );
}

#[test]
fn checkbox_counts() {
    let v = [json!(true), Json::Null, json!(true), Json::Null, Json::Null];
    assert_eq!(agg(Checked, "fldCheck", &v), json!(2));
    assert_eq!(agg(Unchecked, "fldCheck", &v), json!(3));
    assert!(approx(&agg(PercentChecked, "fldCheck", &v), 0.4));
    assert!(approx(&agg(PercentUnchecked, "fldCheck", &v), 0.6));
    assert_eq!(agg(PercentChecked, "fldCheck", &[]), json!(0));
    assert_eq!(
        agg(Empty, "fldCheck", &v),
        Json::Null,
        "checkbox offers checked counts only"
    );
    assert_eq!(
        agg(Checked, "fldFBool", &[json!(true), json!(false)]),
        json!(1)
    );
}

#[test]
fn date_statistics() {
    let v = [
        json!("2026-10-12"),
        json!("2026-01-05"),
        Json::Null,
        json!("2026-03-01"),
    ];
    assert_eq!(agg(EarliestDate, "fldDate", &v), json!("2026-01-05"));
    assert_eq!(agg(LatestDate, "fldDate", &v), json!("2026-10-12"));
    assert_eq!(agg(DateRangeDays, "fldDate", &v), json!(280));
    assert_eq!(agg(EarliestDate, "fldDate", &[Json::Null]), Json::Null);
    assert_eq!(
        agg(DateRangeDays, "fldDate", &[json!("2026-10-12")]),
        json!(0)
    );
    let dt = [
        json!("2026-10-12T23:00:00.000Z"),
        json!("2026-10-10T01:00:00.000Z"),
    ];
    assert_eq!(
        agg(EarliestDate, "fldDt", &dt),
        json!("2026-10-10T01:00:00.000Z")
    );
    assert_eq!(
        agg(LatestDate, "fldDt", &dt),
        json!("2026-10-12T23:00:00.000Z")
    );
    assert_eq!(
        agg(DateRangeDays, "fldDt", &dt),
        json!(2),
        "calendar days, not 46 hours"
    );
    // In Auckland those instants fall on Oct 10 and Oct 13.
    let t = table();
    let refs: Vec<Option<&Json>> = dt.iter().map(Some).collect();
    assert_eq!(
        aggregate(
            DateRangeDays,
            &t["fldDt"],
            &refs,
            "Pacific/Auckland".parse().unwrap()
        ),
        json!(3)
    );
    assert_eq!(
        agg(
            LatestDate,
            "fldCreated",
            &[json!("2026-10-12T09:00:00.000Z")]
        ),
        json!("2026-10-12T09:00:00.000Z")
    );
    assert_eq!(
        agg(
            EarliestDate,
            "fldFDate",
            &[json!("2026-02-01"), json!("2026-01-01")]
        ),
        json!("2026-01-01")
    );
    assert_eq!(agg(Unique, "fldDt", &dt), json!(2));
}
