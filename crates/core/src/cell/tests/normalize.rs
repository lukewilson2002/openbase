//! `normalize` and `missing_choices`.

use serde_json::{Value as Json, json};

use super::fixtures::*;
use crate::cell::{CellCtx, CellError, missing_choices, normalize};
use crate::field::*;
use crate::limits::{MAX_LINKS_PER_CELL, MAX_TEXT_CELL_LEN};

fn strict(f: &Field, v: Json) -> Option<Json> {
    normalize(f, &v, &ctx()).unwrap_or_else(|e| panic!("{v} rejected: {e}"))
}

fn lenient(f: &Field, v: Json) -> Option<Json> {
    normalize(f, &v, &tc()).unwrap_or_else(|e| panic!("{v} rejected: {e}"))
}

fn strict_err(f: &Field, v: Json) -> CellError {
    normalize(f, &v, &ctx()).expect_err(&format!("{v} should be rejected"))
}

fn lenient_err(f: &Field, v: Json) -> CellError {
    normalize(f, &v, &tc()).expect_err(&format!("{v} should be rejected"))
}

fn kind(t: FieldType) -> Field {
    sample_field(t)
}

#[test]
fn null_clears_every_editable_type() {
    for t in FieldType::ALL {
        let f = sample_field(t);
        let r = normalize(&f, &Json::Null, &ctx());
        if t.is_computed() {
            assert_eq!(r, Err(CellError::ComputedField), "{t:?}");
        } else {
            assert_eq!(r, Ok(None), "{t:?}");
        }
    }
}

#[test]
fn computed_types_are_rejected() {
    for t in FieldType::ALL.into_iter().filter(|t| t.is_computed()) {
        let f = sample_field(t);
        assert_eq!(
            normalize(&f, &json!("x"), &tc()),
            Err(CellError::ComputedField),
            "{t:?}"
        );
        assert_eq!(
            normalize(&f, &json!(1), &ctx()),
            Err(CellError::ComputedField),
            "{t:?}"
        );
    }
}

#[test]
fn canonical_samples_are_fixed_points() {
    for t in FieldType::ALL.into_iter().filter(|t| !t.is_computed()) {
        let f = sample_field(t);
        for v in sample_values(t) {
            assert_eq!(
                normalize(&f, &v, &ctx()),
                Ok(Some(v.clone())),
                "{t:?} strict {v}"
            );
            assert_eq!(
                normalize(&f, &v, &tc()),
                Ok(Some(v.clone())),
                "{t:?} typecast {v}"
            );
        }
    }
}

#[test]
fn text() {
    let f = kind(FieldType::Text);
    assert_eq!(strict(&f, json!("hi")), Some(json!("hi")));
    assert_eq!(strict(&f, json!("a\nb\r\nc")), Some(json!("a b c")));
    assert_eq!(strict(&f, json!("")), None);
    assert_eq!(strict(&f, json!("   ")), None);
    assert_eq!(strict(&f, json!(" padded ")), Some(json!(" padded ")));
    assert_eq!(strict(&f, json!("bell\u{7}")), Some(json!("bell")));
    assert!(matches!(strict_err(&f, json!(5)), CellError::Invalid(_)));
    assert!(matches!(strict_err(&f, json!(true)), CellError::Invalid(_)));
    assert!(matches!(
        strict_err(&f, json!({"a": 1})),
        CellError::Invalid(_)
    ));
    assert_eq!(lenient(&f, json!(5)), Some(json!("5")));
    assert_eq!(lenient(&f, json!(2.5)), Some(json!("2.5")));
    assert_eq!(lenient(&f, json!(false)), Some(json!("false")));
    assert_eq!(
        lenient(&f, json!(["a", 1, true])),
        Some(json!("a, 1, true"))
    );
    assert!(matches!(
        lenient_err(&f, json!({"a": 1})),
        CellError::Invalid(_)
    ));
}

#[test]
fn text_length_limit() {
    let f = kind(FieldType::RichText);
    let max = "é".repeat(MAX_TEXT_CELL_LEN);
    assert_eq!(strict(&f, json!(max.clone())), Some(json!(max)));
    let over = "a".repeat(MAX_TEXT_CELL_LEN + 1);
    assert_eq!(
        strict_err(&f, json!(over)),
        CellError::TooLong {
            max: MAX_TEXT_CELL_LEN
        }
    );
}

#[test]
fn multiline_text_keeps_newlines() {
    let f = field(FieldKind::Text(TextOptions {
        multiline: true,
        default: None,
    }));
    assert_eq!(
        strict(&f, json!("a\r\nb\rc\n\nd")),
        Some(json!("a\nb\nc\n\nd"))
    );
    assert_eq!(
        strict(&f, json!("**not bold**")),
        Some(json!("**not bold**"))
    );
}

#[test]
fn rich_text_keeps_newlines() {
    let f = kind(FieldType::RichText);
    assert_eq!(
        strict(&f, json!("a\r\nb\rc\n\nd")),
        Some(json!("a\nb\nc\n\nd"))
    );
    assert_eq!(strict(&f, json!("\n\n")), None);
    assert_eq!(strict(&f, json!("tab\there")), Some(json!("tab\there")));
}

#[test]
fn barcode() {
    let f = kind(FieldType::Barcode);
    assert_eq!(strict(&f, json!("0123")), Some(json!("0123")));
    assert_eq!(
        strict(&f, json!({"text": "9876", "type": "upce"})),
        Some(json!("9876"))
    );
    assert_eq!(lenient(&f, json!(12345)), Some(json!("12345")));
    assert!(matches!(
        strict_err(&f, json!({"type": "x"})),
        CellError::Invalid(_)
    ));
}

#[test]
fn number_strict_and_lenient() {
    let f = field(FieldKind::Number(NumberOptions::default()));
    assert_eq!(strict(&f, json!(5)), Some(json!(5)));
    assert_eq!(strict(&f, json!(5.0)), Some(json!(5)));
    assert_eq!(strict(&f, json!(5.4)), Some(json!(5)), "precision 0 rounds");
    assert_eq!(
        strict(&f, json!(-2.5)),
        Some(json!(-3)),
        "round half away from zero"
    );
    assert_eq!(strict(&f, json!(-0.0)), Some(json!(0)));
    assert!(matches!(strict_err(&f, json!("5")), CellError::Invalid(_)));
    assert!(matches!(strict_err(&f, json!(true)), CellError::Invalid(_)));
    assert!(matches!(strict_err(&f, json!([1])), CellError::Invalid(_)));
    assert_eq!(lenient(&f, json!("5")), Some(json!(5)));
    assert_eq!(lenient(&f, json!(" 1,234 ")), Some(json!(1234)));
    assert_eq!(lenient(&f, json!("$99")), Some(json!(99)));
    assert_eq!(lenient(&f, json!("")), None);
    assert_eq!(lenient(&f, json!("  ")), None);
    let e = lenient_err(&f, json!("abc"));
    assert_eq!(e, CellError::Invalid("\"abc\" is not a number".into()));
    assert!(matches!(
        lenient_err(&f, json!(true)),
        CellError::Invalid(_)
    ));
}

#[test]
fn number_precision_and_sign() {
    let f = field(FieldKind::Number(NumberOptions {
        precision: 2,
        allow_negative: false,
        default: None,
    }));
    assert_eq!(
        strict(&f, json!(1.005)),
        Some(json!(1)),
        "binary 1.005 is below half"
    );
    assert_eq!(strict(&f, json!(1.236)), Some(json!(1.24)));
    assert_eq!(strict(&f, json!(0.1)), Some(json!(0.1)));
    assert_eq!(
        strict(&f, json!(-0.001)),
        Some(json!(0)),
        "rounds to zero first"
    );
    assert!(matches!(strict_err(&f, json!(-1)), CellError::Invalid(_)));
    assert!(matches!(
        lenient_err(&f, json!("(5)")),
        CellError::Invalid(_)
    ));
    assert_eq!(
        strict(&f, json!(1e300)),
        Some(json!(1e300)),
        "huge numbers stay finite"
    );
    let pct = lenient(&f, json!("50%"));
    assert_eq!(pct, Some(json!(0.5)), "a % sign divides by 100");
}

#[test]
fn currency() {
    let f = field(FieldKind::Currency(CurrencyOptions {
        precision: 2,
        symbol: "CHF".into(),
        allow_negative: true,
    }));
    assert_eq!(strict(&f, json!(10.555)), Some(json!(10.56)));
    assert_eq!(lenient(&f, json!("CHF 1,200.10")), Some(json!(1200.1)));
    assert_eq!(lenient(&f, json!("-$3")), Some(json!(-3)));
    assert_eq!(lenient(&f, json!("(4.50)")), Some(json!(-4.5)));
    assert!(matches!(strict_err(&f, json!("1")), CellError::Invalid(_)));
}

#[test]
fn percent() {
    let f = kind(FieldType::Percent);
    assert_eq!(
        strict(&f, json!(0.5)),
        Some(json!(0.5)),
        "numbers are fractions"
    );
    assert_eq!(strict(&f, json!(1.5)), Some(json!(1.5)));
    assert_eq!(
        strict(&f, json!(0.123)),
        Some(json!(0.12)),
        "precision 0 => 2 fraction decimals"
    );
    assert_eq!(lenient(&f, json!("50%")), Some(json!(0.5)));
    assert_eq!(
        lenient(&f, json!("50")),
        Some(json!(0.5)),
        "strings are percentage points"
    );
    assert_eq!(lenient(&f, json!("12.5 %")), Some(json!(0.13)));
    assert_eq!(lenient(&f, json!(0.5)), Some(json!(0.5)));
    let precise = field(FieldKind::Percent(NumberOptions {
        precision: 1,
        ..NumberOptions::default()
    }));
    assert_eq!(lenient(&precise, json!("12.5%")), Some(json!(0.125)));
    assert!(matches!(
        strict_err(&f, json!("50%")),
        CellError::Invalid(_)
    ));
}

#[test]
fn duration() {
    let f = kind(FieldType::Duration);
    assert_eq!(strict(&f, json!(90)), Some(json!(90)));
    assert_eq!(strict(&f, json!(90.4)), Some(json!(90)));
    assert_eq!(strict(&f, json!(-60)), Some(json!(-60)));
    assert!(matches!(
        strict_err(&f, json!("1:30")),
        CellError::Invalid(_)
    ));
    assert_eq!(lenient(&f, json!("1:30")), Some(json!(5400)));
    assert_eq!(lenient(&f, json!("1:30:15")), Some(json!(5415)));
    assert_eq!(lenient(&f, json!("75")), Some(json!(75)));
    assert_eq!(lenient(&f, json!("2h 5m")), Some(json!(7500)));
    assert_eq!(lenient(&f, json!("")), None);
    assert!(matches!(
        lenient_err(&f, json!("1:99")),
        CellError::Invalid(_)
    ));
    let millis = field(FieldKind::Duration(DurationOptions {
        format: DurationFormat::HMmSsSss,
    }));
    assert_eq!(lenient(&millis, json!("0:00:01.2345")), Some(json!(1.235)));
    let tenths = field(FieldKind::Duration(DurationOptions {
        format: DurationFormat::HMmSsS,
    }));
    assert_eq!(strict(&tenths, json!(1.25)), Some(json!(1.3)));
}

#[test]
fn rating() {
    let f = kind(FieldType::Rating); // max 5
    assert_eq!(strict(&f, json!(1)), Some(json!(1)));
    assert_eq!(strict(&f, json!(5)), Some(json!(5)));
    assert_eq!(strict(&f, json!(0)), None, "zero is empty");
    assert_eq!(strict(&f, json!(2.6)), Some(json!(3)));
    assert!(matches!(strict_err(&f, json!(6)), CellError::Invalid(_)));
    assert!(matches!(strict_err(&f, json!(-1)), CellError::Invalid(_)));
    assert!(matches!(strict_err(&f, json!("3")), CellError::Invalid(_)));
    assert_eq!(lenient(&f, json!(9)), Some(json!(5)), "typecast clamps");
    assert_eq!(lenient(&f, json!("3")), Some(json!(3)));
    assert_eq!(lenient(&f, json!("★★★")), Some(json!(3)));
    assert_eq!(lenient(&f, json!("★★☆☆☆")), Some(json!(2)));
    assert!(matches!(lenient_err(&f, json!(-2)), CellError::Invalid(_)));
    assert!(matches!(
        lenient_err(&f, json!("lots")),
        CellError::Invalid(_)
    ));
    let ten = field(FieldKind::Rating(RatingOptions {
        max: 10,
        ..RatingOptions::default()
    }));
    assert_eq!(strict(&ten, json!(10)), Some(json!(10)));
    let broken = field(FieldKind::Rating(RatingOptions {
        max: 0,
        ..RatingOptions::default()
    }));
    assert_eq!(
        lenient(&broken, json!(4)),
        Some(json!(1)),
        "max is clamped to 1..=10"
    );
}

#[test]
fn checkbox() {
    let f = kind(FieldType::Checkbox);
    assert_eq!(strict(&f, json!(true)), Some(json!(true)));
    assert_eq!(strict(&f, json!(false)), None);
    assert!(matches!(
        strict_err(&f, json!("true")),
        CellError::Invalid(_)
    ));
    assert!(matches!(strict_err(&f, json!(1)), CellError::Invalid(_)));
    for t in ["true", "yes", "checked", "1", "X", "on"] {
        assert_eq!(lenient(&f, json!(t)), Some(json!(true)), "{t}");
    }
    for t in ["false", "no", "unchecked", "0", "", "off"] {
        assert_eq!(lenient(&f, json!(t)), None, "{t}");
    }
    assert_eq!(lenient(&f, json!(1)), Some(json!(true)));
    assert_eq!(lenient(&f, json!(0)), None);
    assert_eq!(lenient(&f, json!(-2.5)), Some(json!(true)));
    assert!(matches!(
        lenient_err(&f, json!("perhaps")),
        CellError::Invalid(_)
    ));
    assert!(matches!(
        lenient_err(&f, json!([true])),
        CellError::Invalid(_)
    ));
}

#[test]
fn single_select_by_id_and_name() {
    let f = single_select();
    assert_eq!(strict(&f, json!("selRed")), Some(json!("selRed")));
    assert_eq!(strict(&f, json!("Green")), Some(json!("selGreen")));
    assert_eq!(
        strict(&f, json!("  blue ")),
        Some(json!("selBlue")),
        "trim + case-insensitive"
    );
    assert_eq!(strict(&f, json!("RED, DARK")), Some(json!("selDark")));
    assert_eq!(strict(&f, json!("")), None);
    assert_eq!(
        strict_err(&f, json!("Purple")),
        CellError::UnknownChoice("Purple".into())
    );
    assert_eq!(
        strict_err(&f, json!(" Purple ")),
        CellError::UnknownChoice("Purple".into())
    );
    assert!(matches!(
        strict_err(&f, json!(["Red"])),
        CellError::Invalid(_)
    ));
    assert!(matches!(strict_err(&f, json!(1)), CellError::Invalid(_)));
    assert_eq!(lenient(&f, json!(["Red"])), Some(json!("selRed")));
    assert_eq!(lenient(&f, json!([])), None);
    assert!(matches!(
        lenient_err(&f, json!(["Red", "Blue"])),
        CellError::Invalid(_)
    ));
}

#[test]
fn exact_name_beats_case_insensitive_match() {
    let f = field(FieldKind::SingleSelect(SelectOptions {
        choices: vec![
            choice("selA", "apple", "red"),
            choice("selB", "Apple", "green"),
        ],
    }));
    assert_eq!(strict(&f, json!("Apple")), Some(json!("selB")));
    assert_eq!(strict(&f, json!("apple")), Some(json!("selA")));
    assert_eq!(
        strict(&f, json!("APPLE")),
        Some(json!("selA")),
        "first ci match"
    );
}

#[test]
fn select_choice_id_wins_over_name() {
    // A choice literally named like another choice's id.
    let f = field(FieldKind::SingleSelect(SelectOptions {
        choices: vec![choice("selA", "selB", "red"), choice("selB", "B", "green")],
    }));
    assert_eq!(
        strict(&f, json!("selB")),
        Some(json!("selA")),
        "first exact id-or-name match"
    );
}

#[test]
fn multi_select_names_and_ids() {
    let f = multi_select();
    assert_eq!(
        strict(&f, json!(["Red", "selBlue"])),
        Some(json!(["selRed", "selBlue"]))
    );
    assert_eq!(
        strict(&f, json!(["red", "Red", "selRed"])),
        Some(json!(["selRed"])),
        "dedupe"
    );
    assert_eq!(strict(&f, json!([])), None);
    assert_eq!(strict(&f, json!(["", " "])), None);
    assert_eq!(
        strict_err(&f, json!(["Red", "Teal"])),
        CellError::UnknownChoice("Teal".into())
    );
    assert!(matches!(
        strict_err(&f, json!("Red")),
        CellError::Invalid(_)
    ));
    assert!(matches!(strict_err(&f, json!([1])), CellError::Invalid(_)));
    assert_eq!(
        lenient(&f, json!("Red, Blue")),
        Some(json!(["selRed", "selBlue"]))
    );
    assert_eq!(
        lenient(&f, json!("\"Red, dark\", green")),
        Some(json!(["selDark", "selGreen"]))
    );
    assert_eq!(lenient(&f, json!("")), None);
}

#[test]
fn missing_choices_lists_unknown_names() {
    let s = single_select();
    assert_eq!(missing_choices(&s, &json!("Purple")), vec!["Purple"]);
    assert_eq!(missing_choices(&s, &json!(" red ")), Vec::<String>::new());
    assert_eq!(missing_choices(&s, &json!("selRed")), Vec::<String>::new());
    assert_eq!(missing_choices(&s, &json!("")), Vec::<String>::new());
    assert_eq!(missing_choices(&s, &json!(7)), vec!["7"]);
    assert_eq!(missing_choices(&s, &json!(["Teal"])), vec!["Teal"]);
    let m = multi_select();
    assert_eq!(
        missing_choices(&m, &json!(["Teal", "Red", "teal", " Navy "])),
        vec!["Teal", "Navy"]
    );
    assert_eq!(
        missing_choices(&m, &json!("Teal, \"A, B\", red")),
        vec!["Teal", "A, B"]
    );
    assert_eq!(missing_choices(&m, &json!({"x": 1})), Vec::<String>::new());
    let text = sample_field(FieldType::Text);
    assert!(missing_choices(&text, &json!("x")).is_empty());
}

#[test]
fn missing_choices_then_normalize_succeeds() {
    let mut m = multi_select();
    let input = json!("Teal, Red");
    let missing = missing_choices(&m, &input);
    if let FieldKind::MultipleSelect(o) = &mut m.kind {
        for (i, name) in missing.iter().enumerate() {
            o.choices.push(choice(&format!("selNew{i}"), name, "teal"));
        }
    }
    assert_eq!(lenient(&m, input), Some(json!(["selNew0", "selRed"])));
}

#[test]
fn date_only_formats() {
    let us = date_field(false, DateFormat::Us, None);
    let eu = date_field(false, DateFormat::European, None);
    let cases = [
        ("2026-10-12", "2026-10-12"),
        ("10/12/2026", "2026-10-12"),
        ("October 12, 2026", "2026-10-12"),
        ("Oct 12, 2026", "2026-10-12"),
        ("12 Oct 2026", "2026-10-12"),
        ("2026-10-12T23:30:00Z", "2026-10-12"),
        ("2026-10-12 08:00", "2026-10-12"),
        (" 2026-1-5 ", "2026-01-05"),
    ];
    for (input, want) in cases {
        assert_eq!(strict(&us, json!(input)), Some(json!(want)), "{input}");
    }
    assert_eq!(strict(&eu, json!("10/12/2026")), Some(json!("2026-12-10")));
    assert_eq!(strict(&eu, json!("31/01/2026")), Some(json!("2026-01-31")));
    assert!(matches!(
        strict_err(&us, json!("31/01/2026")),
        CellError::Invalid(_)
    ));
    assert_eq!(strict(&us, json!("")), None);
    assert!(matches!(
        strict_err(&us, json!("not a date")),
        CellError::Invalid(_)
    ));
    assert!(matches!(
        strict_err(&us, json!(20261012)),
        CellError::Invalid(_)
    ));
    assert!(matches!(
        strict_err(&us, json!("2026-02-29")),
        CellError::Invalid(_)
    ));
    assert_eq!(strict(&us, json!("2028-02-29")), Some(json!("2028-02-29")));
}

#[test]
fn date_only_instant_input_uses_field_or_ctx_zone() {
    // 2026-10-12T23:30Z is already Oct 13 in Auckland and still Oct 12 in New York.
    let floating = date_field(false, DateFormat::Iso, None);
    let input = json!("2026-10-12T23:30:00Z");
    assert_eq!(
        normalize(&floating, &input, &ctx_in("Pacific/Auckland")),
        Ok(Some(json!("2026-10-13")))
    );
    assert_eq!(
        normalize(&floating, &input, &ctx_in("America/New_York")),
        Ok(Some(json!("2026-10-12")))
    );
    let fixed = date_field(false, DateFormat::Iso, Some("Pacific/Auckland"));
    assert_eq!(
        normalize(&fixed, &input, &ctx_in("America/New_York")),
        Ok(Some(json!("2026-10-13")))
    );
}

#[test]
fn datetime_storage_is_utc_millis() {
    let f = date_field(true, DateFormat::Us, None);
    assert_eq!(
        strict(&f, json!("2026-10-12T14:30:00Z")),
        Some(json!("2026-10-12T14:30:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("2026-10-12T16:30:00+02:00")),
        Some(json!("2026-10-12T14:30:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("2026-10-12 14:30")),
        Some(json!("2026-10-12T14:30:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("2026-10-12")),
        Some(json!("2026-10-12T00:00:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("10/12/2026 2:30pm")),
        Some(json!("2026-10-12T14:30:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("October 12, 2026 9:05 AM")),
        Some(json!("2026-10-12T09:05:00.000Z"))
    );
    assert_eq!(
        strict(&f, json!("2026-10-12T14:30:00.1234Z")),
        Some(json!("2026-10-12T14:30:00.123Z"))
    );
}

#[test]
fn datetime_local_input_in_zones() {
    let f = date_field(true, DateFormat::Iso, None);
    let ny = ctx_in("America/New_York");
    assert_eq!(
        normalize(&f, &json!("2026-10-12 09:00"), &ny),
        Ok(Some(json!("2026-10-12T13:00:00.000Z")))
    );
    assert_eq!(
        normalize(&f, &json!("2026-01-12 09:00"), &ny),
        Ok(Some(json!("2026-01-12T14:00:00.000Z")))
    );
    assert_eq!(
        normalize(&f, &json!("2026-10-12"), &ny),
        Ok(Some(json!("2026-10-12T04:00:00.000Z")))
    );
    // Explicit offsets ignore the zone.
    assert_eq!(
        normalize(&f, &json!("2026-10-12T09:00:00Z"), &ny),
        Ok(Some(json!("2026-10-12T09:00:00.000Z")))
    );
    // Field zone beats ctx zone.
    let tokyo = date_field(true, DateFormat::Iso, Some("Asia/Tokyo"));
    assert_eq!(
        normalize(&tokyo, &json!("2026-10-12 09:00"), &ny),
        Ok(Some(json!("2026-10-12T00:00:00.000Z")))
    );
    // An unknown field zone falls back to the ctx zone.
    let bogus = date_field(true, DateFormat::Iso, Some("Mars/Olympus"));
    assert_eq!(
        normalize(&bogus, &json!("2026-10-12 09:00"), &ny),
        Ok(Some(json!("2026-10-12T13:00:00.000Z")))
    );
}

#[test]
fn datetime_dst_edges() {
    let f = date_field(true, DateFormat::Iso, Some("America/New_York"));
    // Spring forward: 02:30 does not exist on 2026-03-08 -> 03:30 EDT.
    assert_eq!(
        strict(&f, json!("2026-03-08 02:30")),
        Some(json!("2026-03-08T07:30:00.000Z"))
    );
    // Midnight of the DST day exists (EST).
    assert_eq!(
        strict(&f, json!("2026-03-08")),
        Some(json!("2026-03-08T05:00:00.000Z"))
    );
    // Fall back: 01:30 happens twice on 2026-11-01; the first (EDT) wins.
    assert_eq!(
        strict(&f, json!("2026-11-01 01:30")),
        Some(json!("2026-11-01T05:30:00.000Z"))
    );
    let london = date_field(true, DateFormat::Iso, Some("Europe/London"));
    assert_eq!(
        strict(&london, json!("2026-03-29 01:30")),
        Some(json!("2026-03-29T01:30:00.000Z"))
    );
    assert_eq!(
        strict(&london, json!("2026-07-01 12:00")),
        Some(json!("2026-07-01T11:00:00.000Z"))
    );
}

#[test]
fn email() {
    let f = kind(FieldType::Email);
    assert_eq!(
        strict(&f, json!(" ada@example.com ")),
        Some(json!("ada@example.com"))
    );
    assert_eq!(
        strict(&f, json!("first.last+tag@sub.example.co.uk")),
        Some(json!("first.last+tag@sub.example.co.uk"))
    );
    assert_eq!(strict(&f, json!("")), None);
    for bad in [
        "ada",
        "ada@",
        "@example.com",
        "ada@example",
        "ada@exa mple.com",
        "a@b@c.com",
        "ada@-x.com",
        "ada@x..com",
        "ada@exa\nmple.com",
    ] {
        assert!(
            matches!(strict_err(&f, json!(bad)), CellError::Invalid(_)),
            "{bad:?}"
        );
    }
    let long = format!("{}@example.com", "a".repeat(250));
    assert!(matches!(strict_err(&f, json!(long)), CellError::Invalid(_)));
    assert!(matches!(lenient_err(&f, json!(5)), CellError::Invalid(_)));
}

#[test]
fn url() {
    let f = kind(FieldType::Url);
    let ok = [
        ("https://example.com", "https://example.com"),
        ("http://example.com/a?b=c#d", "http://example.com/a?b=c#d"),
        ("HTTPS://Example.com", "https://Example.com"),
        ("mailto:ada@example.com", "mailto:ada@example.com"),
        ("example.com", "https://example.com"),
        (
            "www.example.com/path?q=a:b",
            "https://www.example.com/path?q=a:b",
        ),
        ("localhost:8080/x", "https://localhost:8080/x"),
        ("example.com:8443", "https://example.com:8443"),
        ("//cdn.example.com/x.js", "https://cdn.example.com/x.js"),
        ("  https://example.com  ", "https://example.com"),
    ];
    for (input, want) in ok {
        assert_eq!(strict(&f, json!(input)), Some(json!(want)), "{input}");
    }
    assert_eq!(strict(&f, json!("")), None);
    for bad in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<script>",
        "vbscript:x",
        "file:///etc/passwd",
        "ftp://example.com",
        "javascript:1",
        "https://",
        "https:example.com",
        "http://@evil",
        "not a url",
        "word",
        "exa mple.com",
        "example.com:port",
        "mailto:",
        ".example.com",
        "a@b.com",
    ] {
        assert!(
            matches!(strict_err(&f, json!(bad)), CellError::Invalid(_)),
            "{bad:?}"
        );
    }
    let long = format!("https://example.com/{}", "a".repeat(3000));
    assert!(matches!(
        strict_err(&f, json!(long)),
        CellError::TooLong { .. }
    ));
}

#[test]
fn phone() {
    let f = kind(FieldType::Phone);
    for good in [
        "+1 (555) 010-9999",
        "555-0100",
        "+44 20 7946 0958",
        "555.010.9999 ext. 12",
        "555 0100 x7",
    ] {
        assert_eq!(strict(&f, json!(good)), Some(json!(good)), "{good}");
    }
    assert_eq!(strict(&f, json!("  555-0100 ")), Some(json!("555-0100")));
    for bad in ["call me", "12", "555-CALL-NOW", "<script>"] {
        assert!(
            matches!(strict_err(&f, json!(bad)), CellError::Invalid(_)),
            "{bad:?}"
        );
    }
    assert!(matches!(
        strict_err(&f, json!(5550100)),
        CellError::Invalid(_)
    ));
    assert_eq!(lenient(&f, json!(5550100)), Some(json!("5550100")));
    assert!(matches!(
        strict_err(&f, json!("1".repeat(70))),
        CellError::Invalid(_)
    ));
}

#[test]
fn attachments() {
    let f = kind(FieldType::Attachment);
    let a = json!({"id": "attA1", "filename": "a.png", "mime": "image/png", "size": 3});
    let b = json!({"id": "attB2", "filename": "b.pdf", "mime": "application/pdf", "size": 9, "extra": "dropped"});
    assert_eq!(
        strict(&f, json!([a.clone(), b, a.clone()])),
        Some(
            json!([a.clone(), {"id": "attB2", "filename": "b.pdf", "mime": "application/pdf", "size": 9}])
        )
    );
    assert_eq!(strict(&f, json!([])), None);
    assert!(
        matches!(strict_err(&f, a.clone()), CellError::Invalid(_)),
        "single object needs typecast"
    );
    assert_eq!(lenient(&f, a.clone()), Some(json!([a])));
    for bad in [
        json!([{"id": "attA1"}]),
        json!([{"id": "nope1", "filename": "a", "mime": "a/b", "size": 1}]),
        json!([{"id": "attA1", "filename": "", "mime": "a/b", "size": 1}]),
        json!([{"id": "attA1", "filename": "a\u{0}b", "mime": "a/b", "size": 1}]),
        json!([{"id": "attA1", "filename": "a", "mime": "nonsense", "size": 1}]),
        json!([{"id": "attA1", "filename": "a", "mime": "a/b", "size": -1}]),
        json!([{"id": "attA1", "filename": "a", "mime": "a/b", "size": "1"}]),
        json!(["attA1"]),
        json!("https://example.com/x.png"),
        json!(5),
    ] {
        assert!(
            matches!(lenient_err(&f, bad.clone()), CellError::Invalid(_)),
            "{bad}"
        );
    }
    let many: Vec<Json> = (0..1001)
        .map(|i| json!({"id": format!("att{i}"), "filename": "f", "mime": "a/b", "size": 1}))
        .collect();
    assert!(matches!(
        strict_err(&f, Json::Array(many)),
        CellError::TooMany { .. }
    ));
}

#[test]
fn links_accept_documented_shapes() {
    let f = link_field(false);
    assert_eq!(strict(&f, json!("recA")), Some(json!(["recA"])));
    assert_eq!(
        strict(&f, json!(["recA", "recB"])),
        Some(json!(["recA", "recB"]))
    );
    assert_eq!(
        strict(&f, json!([{"id": "recA"}, {"id": "recB", "name": "Beta"}])),
        Some(json!(["recA", "recB"]))
    );
    assert_eq!(strict(&f, json!({"id": "recA"})), Some(json!(["recA"])));
    assert_eq!(
        strict(&f, json!("recA, recB recC")),
        Some(json!(["recA", "recB", "recC"]))
    );
    assert_eq!(
        strict(&f, json!(["recB", "recA", "recB"])),
        Some(json!(["recB", "recA"])),
        "dedupe keeps order"
    );
    assert_eq!(strict(&f, json!([])), None);
    assert_eq!(strict(&f, json!("")), None);
    for bad in [
        json!("Alpha"),
        json!(["usr1"]),
        json!(["rec"]),
        json!(["rec!x"]),
        json!([1]),
        json!([{"name": "x"}]),
        json!(5),
        json!(true),
    ] {
        assert!(
            matches!(strict_err(&f, bad.clone()), CellError::Invalid(_)),
            "{bad}"
        );
    }
}

#[test]
fn links_single_and_limit() {
    let f = link_field(true);
    assert_eq!(strict(&f, json!(["recA"])), Some(json!(["recA"])));
    assert_eq!(strict(&f, json!(["recA", "recA"])), Some(json!(["recA"])));
    assert_eq!(
        strict_err(&f, json!(["recA", "recB"])),
        CellError::Invalid("this field links to a single record".into())
    );
    let many: Vec<Json> = (0..=MAX_LINKS_PER_CELL)
        .map(|i| json!(format!("rec{i}")))
        .collect();
    assert_eq!(
        strict_err(&link_field(false), Json::Array(many)),
        CellError::TooMany {
            max: MAX_LINKS_PER_CELL
        }
    );
}

#[test]
fn users() {
    let single = user_field(false);
    let multi = user_field(true);
    assert_eq!(strict(&single, json!("usr1")), Some(json!(["usr1"])));
    assert_eq!(
        strict(&single, json!({"id": "usr1", "email": "a@b.c"})),
        Some(json!(["usr1"]))
    );
    assert!(matches!(
        strict_err(&single, json!(["usr1", "usr2"])),
        CellError::Invalid(_)
    ));
    assert_eq!(
        strict(&multi, json!(["usr1", "usr2", "usr1"])),
        Some(json!(["usr1", "usr2"]))
    );
    assert_eq!(strict(&multi, json!([])), None);
    assert!(matches!(
        strict_err(&multi, json!(["recA"])),
        CellError::Invalid(_)
    ));
    assert!(matches!(
        strict_err(&multi, json!("Ada Lovelace")),
        CellError::Invalid(_)
    ));
}

#[test]
fn error_codes_and_messages() {
    assert_eq!(CellError::ComputedField.code(), "computed_field");
    assert_eq!(
        CellError::UnknownChoice("x".into()).code(),
        "unknown_choice"
    );
    assert_eq!(CellError::TooLong { max: 1 }.code(), "too_long");
    assert_eq!(CellError::TooMany { max: 1 }.code(), "too_many");
    assert_eq!(CellError::Invalid("x".into()).code(), "invalid_value");
    assert_eq!(
        CellError::UnknownChoice("Teal".into()).to_string(),
        "unknown option \"Teal\""
    );
    assert_eq!(
        CellError::TooLong { max: 5 }.to_string(),
        "text is too long (maximum 5 characters)"
    );
}

#[test]
fn ctx_helpers() {
    let c = CellCtx::utc(now());
    assert!(!c.typecast);
    assert!(c.with_typecast(true).typecast);
    assert_eq!(c.timezone, chrono_tz::Tz::UTC);
    assert_eq!(ctx_in("Asia/Tokyo").timezone, chrono_tz::Tz::Asia__Tokyo);
}
