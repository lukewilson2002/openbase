//! `to_value` and `display_text`.

use chrono::{NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Value as Json, json};

use super::fixtures::*;
use crate::cell::{NoNames, display_text, to_value};
use crate::field::*;
use crate::value::{ResultType, Value};

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn texts(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| text(s)).collect())
}

fn show(f: &Field, v: Json) -> String {
    display_text(f, Some(&v), &Names, Tz::UTC)
}

fn show_in(f: &Field, v: Json, tz: &str) -> String {
    display_text(f, Some(&v), &Names, tz.parse().unwrap())
}

#[test]
fn absent_values() {
    for t in FieldType::ALL {
        let f = sample_field(t);
        let expected = if t == FieldType::Checkbox {
            Value::Bool(false)
        } else {
            Value::Null
        };
        assert_eq!(to_value(&f, None, &Names), expected, "{t:?}");
        assert_eq!(to_value(&f, Some(&Json::Null), &Names), expected, "{t:?}");
        assert_eq!(display_text(&f, None, &Names, Tz::UTC), "", "{t:?}");
    }
}

#[test]
fn malformed_stored_json_never_panics() {
    let junk = [
        json!({}),
        json!({"error": 5}),
        json!([{}, 1, null, [true]]),
        json!("not-a-date"),
        json!(-1e308),
        json!(true),
        json!([]),
        json!(""),
    ];
    for t in FieldType::ALL {
        let f = sample_field(t);
        for j in &junk {
            let _ = to_value(&f, Some(j), &Names);
            let _ = display_text(&f, Some(j), &Names, Tz::UTC);
        }
    }
}

#[test]
fn every_sample_value_reads_non_blank() {
    for t in FieldType::ALL {
        let f = sample_field(t);
        for v in sample_values(t) {
            assert!(!to_value(&f, Some(&v), &Names).is_blank(), "{t:?} {v}");
            assert!(
                !display_text(&f, Some(&v), &Names, Tz::UTC).is_empty(),
                "{t:?} {v}"
            );
        }
    }
}

#[test]
fn to_value_per_type() {
    let s = |t: FieldType, v: Json| to_value(&sample_field(t), Some(&v), &Names);
    assert_eq!(s(FieldType::SingleLineText, json!("hi")), text("hi"));
    assert_eq!(s(FieldType::SingleLineText, json!("")), Value::Null);
    assert_eq!(s(FieldType::Number, json!(2.5)), Value::Number(2.5));
    assert_eq!(
        s(FieldType::Number, json!("2.5")),
        Value::Number(2.5),
        "lenient on bad storage"
    );
    assert_eq!(s(FieldType::Percent, json!(0.5)), Value::Number(0.5));
    assert_eq!(s(FieldType::Duration, json!(90)), Value::Number(90.0));
    assert_eq!(s(FieldType::Rating, json!(4)), Value::Number(4.0));
    assert_eq!(s(FieldType::Autonumber, json!(7)), Value::Number(7.0));
    assert_eq!(s(FieldType::Count, json!(3)), Value::Number(3.0));
    assert_eq!(s(FieldType::Checkbox, json!(true)), Value::Bool(true));
    assert_eq!(s(FieldType::Checkbox, json!("true")), Value::Bool(false));
    assert_eq!(s(FieldType::SingleSelect, json!("selBlue")), text("Blue"));
    assert_eq!(s(FieldType::SingleSelect, json!("selGone")), Value::Null);
    assert_eq!(
        s(
            FieldType::MultipleSelect,
            json!(["selBlue", "selGone", "selRed"])
        ),
        texts(&["Blue", "Red"])
    );
    assert_eq!(
        s(FieldType::MultipleSelect, json!(["selGone"])),
        Value::Null
    );
    assert_eq!(
        s(FieldType::Date, json!("2026-10-12")),
        Value::Date(NaiveDate::from_ymd_opt(2026, 10, 12).unwrap())
    );
    assert_eq!(
        s(FieldType::Date, json!("2026-10-12T14:30:00.000Z")),
        Value::DateTime(Utc.with_ymd_and_hms(2026, 10, 12, 14, 30, 0).unwrap())
    );
    assert_eq!(
        s(FieldType::CreatedTime, json!("2026-10-12T14:30:00.000Z")),
        Value::DateTime(Utc.with_ymd_and_hms(2026, 10, 12, 14, 30, 0).unwrap())
    );
    assert_eq!(
        s(
            FieldType::Attachment,
            sample_values(FieldType::Attachment)[0].clone()
        ),
        texts(&["photo.png", "notes.txt"])
    );
    assert_eq!(
        s(FieldType::Link, json!(["recA", "recZ"])),
        texts(&["Alpha", "recZ"]),
        "falls back to id"
    );
    assert_eq!(
        s(FieldType::User, json!(["usr1", "usrQ"])),
        texts(&["Ada Lovelace", "usrQ"])
    );
    assert_eq!(
        to_value(&user_field(false), Some(&json!(["usr2"])), &Names),
        text("Grace Hopper")
    );
    assert_eq!(s(FieldType::CreatedBy, json!("usr1")), text("Ada Lovelace"));
    assert_eq!(
        s(FieldType::LastModifiedBy, json!(["usr2"])),
        text("Grace Hopper")
    );
    assert_eq!(s(FieldType::Email, json!("a@b.co")), text("a@b.co"));
    assert_eq!(
        s(FieldType::Button, json!("https://x.y")),
        text("https://x.y")
    );
    assert_eq!(
        to_value(&link_field(false), Some(&json!(["recA"])), &NoNames),
        texts(&["recA"])
    );
}

#[test]
fn computed_values_follow_result_type() {
    let v = |rt: ResultType, j: Json| to_value(&formula(rt, None), Some(&j), &Names);
    assert_eq!(v(ResultType::Number, json!(3)), Value::Number(3.0));
    assert_eq!(v(ResultType::Text, json!("x")), text("x"));
    assert_eq!(v(ResultType::Text, json!(3)), text("3"));
    assert_eq!(v(ResultType::Bool, json!(true)), Value::Bool(true));
    assert_eq!(v(ResultType::Bool, json!(0)), Value::Bool(false));
    assert_eq!(
        v(ResultType::Date, json!("2026-01-02")),
        Value::Date(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap())
    );
    assert_eq!(
        v(ResultType::DateTime, json!("2026-01-02T03:04:05.000Z")),
        Value::DateTime(Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap())
    );
    assert_eq!(
        v(ResultType::Number, json!({"error": "#ERROR!"})),
        Value::Error("#ERROR!".into())
    );
    assert_eq!(v(ResultType::Number, json!("oops")), Value::Null);
    let arr = ResultType::Array(Box::new(ResultType::Number));
    assert_eq!(
        v(arr.clone(), json!([1, 2])),
        Value::Array(vec![Value::Number(1.0), Value::Number(2.0)])
    );
    assert_eq!(
        v(arr.clone(), json!(5)),
        Value::Array(vec![Value::Number(5.0)])
    );
    assert_eq!(v(arr, json!([])), Value::Null);
    let lk = lookup(ResultType::Array(Box::new(ResultType::Date)));
    assert_eq!(
        to_value(&lk, Some(&json!(["2026-01-02"])), &Names),
        Value::Array(vec![Value::Date(
            NaiveDate::from_ymd_opt(2026, 1, 2).unwrap()
        )])
    );
}

#[test]
fn display_numbers() {
    let n = |precision: u8| {
        field(FieldKind::Number(NumberOptions {
            precision,
            ..NumberOptions::default()
        }))
    };
    assert_eq!(show(&n(0), json!(1234.5)), "1235");
    assert_eq!(show(&n(2), json!(1234.5)), "1234.50");
    assert_eq!(show(&n(2), json!(-0.001)), "0.00", "no negative zero");
    assert_eq!(show(&n(8), json!(0.1)), "0.10000000");
    let cur = |symbol: &str, precision: u8| {
        field(FieldKind::Currency(CurrencyOptions {
            precision,
            symbol: symbol.into(),
            allow_negative: true,
        }))
    };
    assert_eq!(show(&cur("$", 2), json!(1234567.891)), "$1,234,567.89");
    assert_eq!(show(&cur("$", 2), json!(-5)), "-$5.00");
    assert_eq!(show(&cur("€", 0), json!(999)), "€999");
    assert_eq!(show(&cur("$", 0), json!(1000)), "$1,000");
    assert_eq!(show(&cur("kr ", 2), json!(0.5)), "kr 0.50");
    let pct = |precision: u8| {
        field(FieldKind::Percent(NumberOptions {
            precision,
            ..NumberOptions::default()
        }))
    };
    assert_eq!(show(&pct(0), json!(0.5)), "50%");
    assert_eq!(show(&pct(1), json!(0.1234)), "12.3%");
    assert_eq!(show(&pct(0), json!(0.07)), "7%");
    assert_eq!(show(&pct(0), json!(-1.5)), "-150%");
    assert_eq!(show(&sample_field(FieldType::Rating), json!(4)), "4");
    assert_eq!(show(&sample_field(FieldType::Autonumber), json!(12)), "12");
    assert_eq!(show(&sample_field(FieldType::Count), json!(0)), "0");
}

#[test]
fn display_durations() {
    let d = |format| field(FieldKind::Duration(DurationOptions { format }));
    assert_eq!(show(&d(DurationFormat::HMm), json!(5400)), "1:30");
    assert_eq!(show(&d(DurationFormat::HMm), json!(89)), "0:01");
    assert_eq!(show(&d(DurationFormat::HMm), json!(0)), "0:00");
    assert_eq!(show(&d(DurationFormat::HMm), json!(-3600)), "-1:00");
    assert_eq!(show(&d(DurationFormat::HMm), json!(360000)), "100:00");
    assert_eq!(show(&d(DurationFormat::HMmSs), json!(5415)), "1:30:15");
    assert_eq!(show(&d(DurationFormat::HMmSsS), json!(1.25)), "0:00:01.3");
    assert_eq!(show(&d(DurationFormat::HMmSsSs), json!(61.5)), "0:01:01.50");
    assert_eq!(
        show(&d(DurationFormat::HMmSsSss), json!(3599.9996)),
        "1:00:00.000"
    );
    assert_eq!(
        show(&d(DurationFormat::HMmSs), json!(-0.2)),
        "0:00:00",
        "no negative zero"
    );
}

#[test]
fn display_dates() {
    let us = date_field(false, DateFormat::Us, None);
    assert_eq!(show(&us, json!("2026-01-05")), "1/5/2026");
    assert_eq!(
        show(
            &date_field(false, DateFormat::European, None),
            json!("2026-01-05")
        ),
        "5/1/2026"
    );
    assert_eq!(
        show(
            &date_field(false, DateFormat::Iso, None),
            json!("2026-01-05")
        ),
        "2026-01-05"
    );
    assert_eq!(
        show(
            &date_field(false, DateFormat::Friendly, None),
            json!("2026-01-05")
        ),
        "January 5, 2026"
    );
    // Date-only values never shift with the viewer zone.
    assert_eq!(
        show_in(&us, json!("2026-01-05"), "Pacific/Auckland"),
        "1/5/2026"
    );
    // Date-time in the viewer zone (no fixed field zone).
    let dt = date_field(true, DateFormat::Us, None);
    let v = json!("2026-10-12T23:30:00.000Z");
    assert_eq!(show(&dt, v.clone()), "10/12/2026 11:30pm");
    assert_eq!(
        show_in(&dt, v.clone(), "Pacific/Auckland"),
        "10/13/2026 12:30pm"
    );
    assert_eq!(
        show_in(&dt, v.clone(), "America/Los_Angeles"),
        "10/12/2026 4:30pm"
    );
    // Fixed field zone beats the viewer zone.
    let fixed = date_field(true, DateFormat::Iso, Some("Asia/Kolkata"));
    assert_eq!(
        show_in(&fixed, v.clone(), "America/Los_Angeles"),
        "2026-10-13 5:00am"
    );
    let h24 = field(FieldKind::Date(DateOptions {
        include_time: true,
        date_format: DateFormat::Iso,
        time_format: TimeFormat::H24,
        timezone: None,
    }));
    assert_eq!(show(&h24, v.clone()), "2026-10-12 23:30");
    assert_eq!(
        show(&h24, json!("2026-10-12T00:05:00.000Z")),
        "2026-10-12 00:05"
    );
    // A date-only field holding an instant shows the day in the zone.
    assert_eq!(show_in(&us, v.clone(), "Pacific/Auckland"), "10/13/2026");
    // A date-time field holding a date-only value shows just the date.
    assert_eq!(show(&dt, json!("2026-10-12")), "10/12/2026");
    // Noon/midnight in 12-hour format.
    assert_eq!(
        show(&dt, json!("2026-10-12T12:00:00.000Z")),
        "10/12/2026 12:00pm"
    );
    assert_eq!(
        show(&dt, json!("2026-10-12T00:00:00.000Z")),
        "10/12/2026 12:00am"
    );
    // Created time uses its own date options.
    let ct = sample_field(FieldType::CreatedTime);
    assert_eq!(
        show(&ct, json!("2026-10-12T14:30:00.000Z")),
        "10/12/2026 2:30pm"
    );
    let lm = field(FieldKind::LastModifiedTime(LastModifiedOptions::default()));
    assert_eq!(show(&lm, json!("2026-10-12T14:30:00.000Z")), "10/12/2026");
}

#[test]
fn display_dst_offsets() {
    let dt = date_field(true, DateFormat::Iso, Some("America/New_York"));
    assert_eq!(
        show(&dt, json!("2026-03-08T06:59:00.000Z")),
        "2026-03-08 1:59am"
    );
    assert_eq!(
        show(&dt, json!("2026-03-08T07:00:00.000Z")),
        "2026-03-08 3:00am"
    );
    assert_eq!(
        show(&dt, json!("2026-11-01T05:30:00.000Z")),
        "2026-11-01 1:30am"
    );
    assert_eq!(
        show(&dt, json!("2026-11-01T06:30:00.000Z")),
        "2026-11-01 1:30am"
    );
}

#[test]
fn display_other_types() {
    assert_eq!(
        show(&sample_field(FieldType::Checkbox), json!(true)),
        "checked"
    );
    assert_eq!(show(&single_select(), json!("selDark")), "Red, dark");
    assert_eq!(
        show(&multi_select(), json!(["selRed", "selDark"])),
        "Red, \"Red, dark\""
    );
    assert_eq!(
        show(&link_field(false), json!(["recA", "recC", "recQ"])),
        "Alpha, \"Gamma, Inc\", recQ"
    );
    assert_eq!(
        show(&sample_field(FieldType::User), json!(["usr1", "usr2"])),
        "Ada Lovelace, Grace Hopper"
    );
    assert_eq!(
        show(&sample_field(FieldType::CreatedBy), json!("usr2")),
        "Grace Hopper"
    );
    assert_eq!(
        show(
            &sample_field(FieldType::Attachment),
            sample_values(FieldType::Attachment)[0].clone()
        ),
        "photo.png, notes.txt"
    );
    assert_eq!(
        show(&sample_field(FieldType::LongText), json!("a\nb")),
        "a\nb"
    );
    assert_eq!(
        show(&sample_field(FieldType::Button), json!("https://x.y")),
        "Open"
    );
}

#[test]
fn display_computed() {
    assert_eq!(show(&formula(ResultType::Number, None), json!(84)), "84");
    assert_eq!(
        show(&formula(ResultType::Number, None), json!(0.1 + 0.2)),
        "0.3"
    );
    assert_eq!(
        show(&formula(ResultType::Number, None), json!(-2.5)),
        "-2.5"
    );
    assert_eq!(
        show(
            &formula(
                ResultType::Number,
                Some(ValueFormat::Currency {
                    precision: 2,
                    symbol: "£".into()
                })
            ),
            json!(1500)
        ),
        "£1,500.00"
    );
    assert_eq!(
        show(
            &formula(
                ResultType::Number,
                Some(ValueFormat::Percent { precision: 0 })
            ),
            json!(0.25)
        ),
        "25%"
    );
    assert_eq!(
        show(
            &formula(
                ResultType::Number,
                Some(ValueFormat::Number { precision: 1 })
            ),
            json!(2)
        ),
        "2.0"
    );
    assert_eq!(
        show(
            &formula(
                ResultType::Number,
                Some(ValueFormat::Duration {
                    format: DurationFormat::HMm
                })
            ),
            json!(600)
        ),
        "0:10"
    );
    assert_eq!(show(&formula(ResultType::Text, None), json!("abc")), "abc");
    assert_eq!(show(&formula(ResultType::Bool, None), json!(true)), "true");
    assert_eq!(
        show(&formula(ResultType::Date, None), json!("2026-10-12")),
        "10/12/2026"
    );
    assert_eq!(
        show(
            &formula(ResultType::DateTime, None),
            json!("2026-10-12T14:30:00.000Z")
        ),
        "10/12/2026 2:30pm"
    );
    let fmt = ValueFormat::Date(DateOptions {
        include_time: false,
        date_format: DateFormat::Iso,
        ..DateOptions::default()
    });
    assert_eq!(
        show(
            &formula(ResultType::DateTime, Some(fmt)),
            json!("2026-10-12T14:30:00.000Z")
        ),
        "2026-10-12"
    );
    assert_eq!(
        show(
            &formula(ResultType::Number, None),
            json!({"error": "#ERROR: x"})
        ),
        "#ERROR: x"
    );
    assert_eq!(
        show(
            &lookup(ResultType::Array(Box::new(ResultType::Text))),
            json!(["a", "b, c", ""])
        ),
        "a, \"b, c\""
    );
    assert_eq!(
        show(
            &lookup(ResultType::Array(Box::new(ResultType::Number))),
            json!([1, 2.5])
        ),
        "1, 2.5"
    );
    assert_eq!(
        show(&sample_field(FieldType::Rollup), json!(99.5)),
        "$99.50"
    );
}
