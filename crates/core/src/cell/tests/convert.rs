//! `convert` (the full type-pair matrix) and `choices_needed_for_conversion`.

use chrono_tz::Tz;
use serde_json::{Value as Json, json};

use super::fixtures::*;
use crate::cell::{choices_needed_for_conversion, convert, normalize};
use crate::field::*;
use crate::limits::{MAX_CHOICES_PER_FIELD, MAX_TEXT_CELL_LEN};
use crate::value::ResultType;

fn conv(from: &Field, to: &Field, v: Json) -> Option<Json> {
    convert(from, to, Some(&v), &ctx(), &Names)
}

/// Every ordered pair of types × every sample value: no panic, computed
/// targets give `None`, and every produced value is canonical for the target
/// (normalizing it again in strict mode returns it unchanged).
#[test]
fn matrix_all_type_pairs_produce_canonical_values() {
    let mut pairs = 0;
    let mut produced = 0;
    for from_t in FieldType::ALL {
        let from = sample_field(from_t);
        for to_t in FieldType::ALL {
            let to = sample_field(to_t);
            pairs += 1;
            assert_eq!(
                convert(&from, &to, None, &ctx(), &Names),
                None,
                "{from_t:?}->{to_t:?} empty"
            );
            for v in sample_values(from_t) {
                let out = convert(&from, &to, Some(&v), &ctx(), &Names);
                if to_t.is_computed() {
                    assert_eq!(out, None, "{from_t:?}->{to_t:?}");
                    continue;
                }
                if let Some(out) = out {
                    produced += 1;
                    assert_eq!(
                        normalize(&to, &out, &ctx()),
                        Ok(Some(out.clone())),
                        "{from_t:?}->{to_t:?}: {v} -> {out} is not canonical"
                    );
                }
            }
        }
    }
    assert_eq!(pairs, 28 * 28);
    assert!(
        produced > 250,
        "only {produced} conversions produced a value"
    );
}

/// Converting to the same definition is the identity for editable types.
#[test]
fn matrix_same_type_is_identity() {
    for t in FieldType::ALL.into_iter().filter(|t| !t.is_computed()) {
        let f = sample_field(t);
        for v in sample_values(t) {
            assert_eq!(conv(&f, &f, v.clone()), Some(v.clone()), "{t:?}");
        }
    }
}

/// Every type converts to text as its display text, in every zone.
#[test]
fn matrix_anything_to_text_is_display_text() {
    let text = sample_field(FieldType::Text);
    let long = sample_field(FieldType::RichText);
    for t in FieldType::ALL {
        let f = sample_field(t);
        for v in sample_values(t) {
            let shown = crate::cell::display_text(&f, Some(&v), &Names, Tz::UTC);
            assert_eq!(conv(&f, &long, v.clone()), Some(json!(shown)), "{t:?}");
            let single_line = shown.replace('\n', " ");
            assert_eq!(
                conv(&f, &text, v.clone()),
                Some(json!(single_line)),
                "{t:?}"
            );
        }
    }
}

/// Expected results for the meaningful pairs.
#[test]
fn meaningful_pairs() {
    use FieldType::*;
    let s = sample_field;
    let cases: Vec<(FieldType, FieldType, Json, Option<Json>)> = vec![
        // numeric family keeps the raw number
        (Number, Currency, json!(-3.25), Some(json!(-3.25))),
        (Number, Percent, json!(42), Some(json!(42))),
        (Percent, Number, json!(0.5), Some(json!(0.5))),
        (Currency, Number, json!(1234.5), Some(json!(1234.5))),
        (Number, Duration, json!(42), Some(json!(42))),
        (Duration, Number, json!(5400), Some(json!(5400))),
        (Number, Rating, json!(42), Some(json!(5))),
        (Number, Rating, json!(0), None),
        (Number, Rating, json!(-3.25), None),
        (Rating, Number, json!(3), Some(json!(3))),
        (Count, Number, json!(2), Some(json!(2))),
        (Autonumber, Number, json!(7), Some(json!(7))),
        (Formula, Number, json!(84), Some(json!(84))),
        (Formula, Number, json!({"error": "#ERROR"}), None),
        (Rollup, Currency, json!(99.5), Some(json!(99.5))),
        // checkbox
        (Checkbox, Number, json!(true), Some(json!(1))),
        (Number, Checkbox, json!(42), Some(json!(true))),
        (Number, Checkbox, json!(0), None),
        (Text, Checkbox, json!("yes"), Some(json!(true))),
        (Text, Checkbox, json!("hello"), None),
        (Checkbox, Text, json!(true), Some(json!("checked"))),
        // text -> typed
        (Text, Number, json!("42"), Some(json!(42))),
        (Text, Number, json!("hello"), None),
        (RichText, Number, json!("3.5"), Some(json!(3.5))),
        (Text, SingleSelect, json!("Red"), Some(json!("selRed"))),
        (Text, SingleSelect, json!("hello"), None),
        (Text, Email, json!("hello"), None),
        (
            Email,
            Text,
            json!("ada@example.com"),
            Some(json!("ada@example.com")),
        ),
        (Email, Url, json!("ada@example.com"), None),
        (
            Url,
            Text,
            json!("https://example.com/a?b=c"),
            Some(json!("https://example.com/a?b=c")),
        ),
        (
            Barcode,
            Number,
            json!("012345678905"),
            Some(json!(12345678905_i64)),
        ),
        (Number, Barcode, json!(42), Some(json!("42.00"))),
        (Number, Text, json!(42), Some(json!("42.00"))),
        (Currency, Text, json!(1234.5), Some(json!("$1,234.50"))),
        (Currency, Percent, json!(1234.5), Some(json!(1234.5))),
        (Percent, Text, json!(0.5), Some(json!("50%"))),
        (Duration, Text, json!(5400), Some(json!("1:30"))),
        (Text, Phone, json!("42"), None),
        // selects
        (
            SingleSelect,
            MultipleSelect,
            json!("selDark"),
            Some(json!(["selDark"])),
        ),
        (
            MultipleSelect,
            SingleSelect,
            json!(["selRed", "selBlue"]),
            Some(json!("selRed")),
        ),
        (
            MultipleSelect,
            Text,
            json!(["selRed", "selBlue"]),
            Some(json!("Red, Blue")),
        ),
        (
            SingleSelect,
            Text,
            json!("selDark"),
            Some(json!("Red, dark")),
        ),
        (SingleSelect, Number, json!("selRed"), None),
        // dates
        (Date, Text, json!("2026-10-12"), Some(json!("10/12/2026"))),
        (
            CreatedTime,
            Date,
            json!("2026-10-12T14:30:00.000Z"),
            Some(json!("2026-10-12")),
        ),
        (
            LastModifiedTime,
            Date,
            json!("2026-10-12T14:30:00.000Z"),
            Some(json!("2026-10-12")),
        ),
        (
            CreatedTime,
            Text,
            json!("2026-10-12T14:30:00.000Z"),
            Some(json!("10/12/2026 2:30pm")),
        ),
        (Date, Number, json!("2026-10-12"), None),
        (Number, Date, json!(42), None),
        // links / users / attachments
        (
            Link,
            Text,
            json!(["recA", "recB"]),
            Some(json!("Alpha, Beta")),
        ),
        (Link, MultipleSelect, json!(["recA"]), None),
        (Text, Link, json!("recA"), None),
        (
            User,
            Text,
            json!(["usr1", "usr2"]),
            Some(json!("Ada Lovelace, Grace Hopper")),
        ),
        (CreatedBy, User, json!("usr1"), Some(json!(["usr1"]))),
        (LastModifiedBy, User, json!("usr2"), Some(json!(["usr2"]))),
        (CreatedBy, Text, json!("usr1"), Some(json!("Ada Lovelace"))),
        (
            Attachment,
            Text,
            sample_values(Attachment)[0].clone(),
            Some(json!("photo.png, notes.txt")),
        ),
        (Text, Attachment, json!("photo.png"), None),
        (
            Lookup,
            Text,
            json!(["Alpha", "Beta"]),
            Some(json!("Alpha, Beta")),
        ),
        (
            Button,
            Text,
            json!("https://example.com"),
            Some(json!("Open")),
        ),
        (Button, Url, json!("https://example.com"), None),
        // anything into computed
        (Number, Formula, json!(42), None),
        (Text, Autonumber, json!("1"), None),
    ];
    for (from_t, to_t, input, want) in cases {
        assert_eq!(
            conv(&s(from_t), &s(to_t), input.clone()),
            want,
            "{from_t:?} -> {to_t:?} for {input}"
        );
    }
}

#[test]
fn text_to_date_and_back() {
    let text = sample_field(FieldType::Text);
    let date = date_field(false, DateFormat::Us, None);
    assert_eq!(
        conv(&text, &date, json!("10/12/2026")),
        Some(json!("2026-10-12"))
    );
    assert_eq!(conv(&text, &date, json!("someday")), None);
    let eu = date_field(false, DateFormat::European, None);
    assert_eq!(
        conv(&text, &eu, json!("10/12/2026")),
        Some(json!("2026-12-10"))
    );
    // Round trip through text keeps the day for every display format.
    for fmt in [
        DateFormat::Us,
        DateFormat::European,
        DateFormat::Iso,
        DateFormat::Friendly,
    ] {
        let d = date_field(false, fmt, None);
        let t = conv(&d, &text, json!("2026-03-09")).unwrap();
        assert_eq!(conv(&text, &d, t), Some(json!("2026-03-09")), "{fmt:?}");
    }
    // Date-time round trip at minute precision in a fixed zone.
    let dt = date_field(true, DateFormat::Us, Some("America/New_York"));
    let t = conv(&dt, &text, json!("2026-07-04T16:45:00.000Z")).unwrap();
    assert_eq!(t, json!("7/4/2026 12:45pm"));
    assert_eq!(conv(&text, &dt, t), Some(json!("2026-07-04T16:45:00.000Z")));
}

#[test]
fn date_and_datetime_conversions_use_zones() {
    let date_only = date_field(false, DateFormat::Iso, None);
    let utc_dt = date_field(true, DateFormat::Iso, None);
    let tokyo_dt = date_field(true, DateFormat::Iso, Some("Asia/Tokyo"));
    // Date-only -> date-time: midnight in the target zone.
    assert_eq!(
        conv(&date_only, &utc_dt, json!("2026-10-12")),
        Some(json!("2026-10-12T00:00:00.000Z"))
    );
    assert_eq!(
        conv(&date_only, &tokyo_dt, json!("2026-10-12")),
        Some(json!("2026-10-11T15:00:00.000Z"))
    );
    // Date-time -> date-only: the day in the target's zone (ctx zone here).
    let v = json!("2026-10-12T23:30:00.000Z");
    assert_eq!(
        conv(&utc_dt, &date_only, v.clone()),
        Some(json!("2026-10-12"))
    );
    let ny = ctx_in("Pacific/Auckland");
    assert_eq!(
        convert(&utc_dt, &date_only, Some(&v), &ny, &Names),
        Some(json!("2026-10-13"))
    );
    // Date-time -> date-time keeps the instant.
    assert_eq!(conv(&utc_dt, &tokyo_dt, v.clone()), Some(v));
    // Computed dates convert too.
    let f = formula(ResultType::Date, None);
    assert_eq!(
        conv(&f, &date_only, json!("2026-01-02")),
        Some(json!("2026-01-02"))
    );
}

#[test]
fn link_and_user_cardinality() {
    let multi = link_field(false);
    let single = link_field(true);
    assert_eq!(
        conv(&multi, &single, json!(["recA", "recB"])),
        Some(json!(["recA"]))
    );
    assert_eq!(
        conv(&single, &multi, json!(["recA"])),
        Some(json!(["recA"]))
    );
    let mut other_table = link_field(false);
    if let FieldKind::Link(o) = &mut other_table.kind {
        o.linked_table_id = "tbl9".into();
    }
    assert_eq!(conv(&multi, &other_table, json!(["recA"])), None);
    assert_eq!(
        conv(
            &user_field(true),
            &user_field(false),
            json!(["usr1", "usr2"])
        ),
        Some(json!(["usr1"]))
    );
    assert_eq!(
        conv(&user_field(false), &user_field(true), json!(["usr1"])),
        Some(json!(["usr1"]))
    );
}

#[test]
fn select_conversions_match_by_name() {
    // Target with the same names but different ids and order.
    let target = field(FieldKind::MultipleSelect(SelectOptions {
        choices: vec![choice("selX", "blue", "blue"), choice("selY", "RED", "red")],
    }));
    assert_eq!(
        conv(
            &multi_select(),
            &target,
            json!(["selRed", "selBlue", "selGreen"])
        ),
        None,
        "names missing from the target empty the cell (create them first)"
    );
    assert_eq!(
        conv(&multi_select(), &target, json!(["selRed", "selBlue"])),
        Some(json!(["selY", "selX"]))
    );
    assert_eq!(
        conv(&single_select(), &target, json!("selBlue")),
        Some(json!(["selX"]))
    );
}

#[test]
fn rich_text_to_text_is_truncated_not_rejected() {
    let long = sample_field(FieldType::RichText);
    let single = sample_field(FieldType::Text);
    let huge = "a\n".repeat(MAX_TEXT_CELL_LEN);
    let out = conv(&long, &single, json!(huge)).unwrap();
    let s = out.as_str().unwrap();
    assert_eq!(s.chars().count(), MAX_TEXT_CELL_LEN);
    assert!(!s.contains('\n'));
}

#[test]
fn text_losing_multiline_joins_its_lines() {
    let multi = field(FieldKind::Text(TextOptions {
        multiline: true,
        default: None,
    }));
    let single = sample_field(FieldType::Text);
    assert_eq!(
        conv(&multi, &single, json!("12 High St\n\n  Springfield \nUSA")),
        Some(json!("12 High St Springfield USA"))
    );
    // And back: nothing to undo, nothing lost.
    assert_eq!(
        conv(&single, &multi, json!("one line")),
        Some(json!("one line"))
    );
    assert_eq!(
        conv(&multi, &sample_field(FieldType::RichText), json!("a\nb")),
        Some(json!("a\nb"))
    );
}

#[test]
fn convert_with_ctx_zone_for_text() {
    let dt = date_field(true, DateFormat::Iso, None);
    let text = sample_field(FieldType::Text);
    let v = json!("2026-10-12T23:30:00.000Z");
    assert_eq!(
        convert(&dt, &text, Some(&v), &ctx_in("Asia/Tokyo"), &Names),
        Some(json!("2026-10-13 8:30am"))
    );
}

#[test]
fn choices_needed() {
    use FieldType::*;
    let text = sample_field(Text);
    let target_single = single_select();
    let target_multi = multi_select();
    let values = [
        json!("Red"),
        json!("Teal"),
        json!("teal"),
        json!(" Navy , Red"),
        json!(""),
    ];
    let refs: Vec<Option<&Json>> = values.iter().map(Some).chain([None]).collect();
    assert_eq!(
        choices_needed_for_conversion(&text, &target_single, refs.clone(), &Names, Tz::UTC),
        vec!["Teal", "Navy , Red"]
    );
    assert_eq!(
        choices_needed_for_conversion(&text, &target_multi, refs, &Names, Tz::UTC),
        vec!["Teal", "Navy"]
    );
    // select -> select by name
    let empty_target = field(FieldKind::SingleSelect(SelectOptions::default()));
    let ms = [json!(["selDark", "selRed"]), json!(["selBlue"])];
    assert_eq!(
        choices_needed_for_conversion(
            &multi_select(),
            &empty_target,
            ms.iter().map(Some),
            &Names,
            Tz::UTC
        ),
        vec!["Red, dark", "Blue"],
        "single target only needs each cell's first choice"
    );
    let empty_multi = field(FieldKind::MultipleSelect(SelectOptions::default()));
    assert_eq!(
        choices_needed_for_conversion(
            &multi_select(),
            &empty_multi,
            ms.iter().map(Some),
            &Names,
            Tz::UTC
        ),
        vec!["Red, dark", "Red", "Blue"]
    );
    // numbers and links use display text
    let nums = [json!(1.5), json!(2)];
    assert_eq!(
        choices_needed_for_conversion(
            &sample_field(Number),
            &empty_target,
            nums.iter().map(Some),
            &Names,
            Tz::UTC
        ),
        vec!["1.50", "2.00"]
    );
    let links = [json!(["recA", "recC"])];
    assert_eq!(
        choices_needed_for_conversion(
            &link_field(false),
            &empty_multi,
            links.iter().map(Some),
            &Names,
            Tz::UTC
        ),
        vec!["Alpha", "Gamma, Inc"]
    );
    // non-select target
    assert!(
        choices_needed_for_conversion(&text, &text, values.iter().map(Some), &Names, Tz::UTC)
            .is_empty()
    );
}

#[test]
fn choices_needed_then_convert_round_trip() {
    let text = sample_field(FieldType::Text);
    let mut target = field(FieldKind::MultipleSelect(SelectOptions::default()));
    let values = [json!("a, b"), json!("B, c"), json!("\"d, e\"")];
    let names =
        choices_needed_for_conversion(&text, &target, values.iter().map(Some), &Names, Tz::UTC);
    assert_eq!(names, vec!["a", "b", "c", "d, e"]);
    if let FieldKind::MultipleSelect(o) = &mut target.kind {
        for (i, n) in names.iter().enumerate() {
            o.choices.push(choice(&format!("sel{i}"), n, "blue"));
        }
    }
    assert_eq!(
        conv(&text, &target, values[0].clone()),
        Some(json!(["sel0", "sel1"]))
    );
    assert_eq!(
        conv(&text, &target, values[1].clone()),
        Some(json!(["sel1", "sel2"]))
    );
    assert_eq!(
        conv(&text, &target, values[2].clone()),
        Some(json!(["sel3"]))
    );
}

#[test]
fn choices_needed_respects_limits() {
    let text = sample_field(FieldType::Text);
    let target = field(FieldKind::SingleSelect(SelectOptions::default()));
    let values: Vec<Json> = (0..MAX_CHOICES_PER_FIELD + 50)
        .map(|i| json!(format!("v{i}")))
        .collect();
    let names =
        choices_needed_for_conversion(&text, &target, values.iter().map(Some), &Names, Tz::UTC);
    assert_eq!(names.len(), MAX_CHOICES_PER_FIELD);
    let long = [json!("x".repeat(300)), json!("ok")];
    assert_eq!(
        choices_needed_for_conversion(&text, &target, long.iter().map(Some), &Names, Tz::UTC),
        vec!["ok"]
    );
}
