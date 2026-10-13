//! `parse_text`: pasted and CSV text.

use serde_json::{Value as Json, json};

use super::fixtures::*;
use crate::cell::{CellError, parse_text};
use crate::field::*;

fn p(f: &Field, s: &str) -> Option<Json> {
    parse_text(f, s, &ctx()).unwrap_or_else(|e| panic!("{s:?} rejected: {e}"))
}

fn perr(f: &Field, s: &str) -> CellError {
    parse_text(f, s, &ctx()).expect_err(&format!("{s:?} should be rejected"))
}

#[test]
fn blank_text_clears_every_editable_type() {
    for t in FieldType::ALL.into_iter().filter(|t| !t.is_computed()) {
        let f = sample_field(t);
        assert_eq!(parse_text(&f, "", &ctx()), Ok(None), "{t:?}");
        assert_eq!(parse_text(&f, "   ", &ctx()), Ok(None), "{t:?}");
    }
}

#[test]
fn computed_types_are_rejected() {
    for t in FieldType::ALL.into_iter().filter(|t| t.is_computed()) {
        assert_eq!(
            parse_text(&sample_field(t), "1", &ctx()),
            Err(CellError::ComputedField),
            "{t:?}"
        );
    }
}

#[test]
fn text_types() {
    let s = sample_field(FieldType::SingleLineText);
    assert_eq!(p(&s, "hello"), Some(json!("hello")));
    assert_eq!(p(&s, "two\nlines"), Some(json!("two lines")));
    let l = sample_field(FieldType::LongText);
    assert_eq!(p(&l, "two\r\nlines"), Some(json!("two\nlines")));
    let b = sample_field(FieldType::Barcode);
    assert_eq!(p(&b, "0042"), Some(json!("0042")), "leading zeros kept");
}

#[test]
fn numbers() {
    let n = sample_field(FieldType::Number); // precision 2
    assert_eq!(p(&n, "1,234.567"), Some(json!(1234.57)));
    assert_eq!(p(&n, "-7"), Some(json!(-7)));
    assert_eq!(p(&n, "(7)"), Some(json!(-7)));
    assert!(matches!(perr(&n, "seven"), CellError::Invalid(_)));
    let c = sample_field(FieldType::Currency);
    assert_eq!(p(&c, "$1,234.50"), Some(json!(1234.5)));
    assert_eq!(p(&c, "€12"), Some(json!(12)));
    let pc = sample_field(FieldType::Percent);
    assert_eq!(p(&pc, "50%"), Some(json!(0.5)));
    assert_eq!(p(&pc, "50"), Some(json!(0.5)));
    assert_eq!(p(&pc, "-5%"), Some(json!(-0.05)));
    let d = sample_field(FieldType::Duration);
    assert_eq!(p(&d, "1:30"), Some(json!(5400)));
    assert_eq!(p(&d, "45"), Some(json!(45)));
    assert_eq!(p(&d, "1h"), Some(json!(3600)));
    assert!(matches!(perr(&d, "soon"), CellError::Invalid(_)));
    let r = sample_field(FieldType::Rating);
    assert_eq!(p(&r, "4"), Some(json!(4)));
    assert_eq!(p(&r, "★★"), Some(json!(2)));
    assert_eq!(p(&r, "11"), Some(json!(5)), "clamped");
    assert_eq!(p(&r, "0"), None);
}

#[test]
fn checkbox_words() {
    let f = sample_field(FieldType::Checkbox);
    assert_eq!(p(&f, "checked"), Some(json!(true)));
    assert_eq!(p(&f, "Yes"), Some(json!(true)));
    assert_eq!(p(&f, "TRUE"), Some(json!(true)));
    assert_eq!(p(&f, "1"), Some(json!(true)));
    assert_eq!(p(&f, "no"), None);
    assert_eq!(p(&f, "false"), None);
    assert!(matches!(perr(&f, "sometimes"), CellError::Invalid(_)));
}

#[test]
fn selects() {
    let s = single_select();
    assert_eq!(p(&s, "green"), Some(json!("selGreen")));
    assert_eq!(
        p(&s, "Red, dark"),
        Some(json!("selDark")),
        "single select keeps commas"
    );
    assert_eq!(perr(&s, "Teal"), CellError::UnknownChoice("Teal".into()));
    let m = multi_select();
    assert_eq!(p(&m, "Red, Blue"), Some(json!(["selRed", "selBlue"])));
    assert_eq!(
        p(&m, "\"Red, dark\",Blue"),
        Some(json!(["selDark", "selBlue"]))
    );
    assert_eq!(p(&m, "Red,,red"), Some(json!(["selRed"])));
    assert_eq!(
        perr(&m, "Red, Teal"),
        CellError::UnknownChoice("Teal".into())
    );
}

#[test]
fn dates() {
    let f = date_field(false, DateFormat::Us, None);
    assert_eq!(p(&f, "10/12/2026"), Some(json!("2026-10-12")));
    assert_eq!(p(&f, "October 12, 2026"), Some(json!("2026-10-12")));
    let eu = date_field(false, DateFormat::European, None);
    assert_eq!(p(&eu, "10/12/2026"), Some(json!("2026-12-10")));
    let dt = date_field(true, DateFormat::Us, Some("Europe/Paris"));
    assert_eq!(
        p(&dt, "10/12/2026 2:30pm"),
        Some(json!("2026-10-12T12:30:00.000Z"))
    );
    assert!(matches!(perr(&f, "someday"), CellError::Invalid(_)));
}

#[test]
fn non_ascii_digits_in_dates_are_rejected_without_panicking() {
    // Arabic-Indic and fullwidth digits used to satisfy `\d` in the date
    // patterns, and the multi-byte fraction digits panicked a byte slice.
    let f = date_field(true, DateFormat::Us, None);
    let zeros = "\u{660}".repeat(9);
    for s in [
        format!("2026-10-12 10:30:00.{zeros}"),
        format!("2026-10-12 10:30:00,{zeros}"),
        format!("10/12/2026 10:30:00.{zeros}"),
        format!("October 12, 2026 10:30:00.{zeros}"),
        format!("12 October 2026 10:30:00.{zeros}"),
        "\u{661}\u{662}/\u{661}\u{662}/\u{662}\u{660}\u{662}\u{666}".to_string(),
        "\u{ff12}\u{ff10}\u{ff12}\u{ff16}-\u{ff11}\u{ff10}-\u{ff11}\u{ff12}".to_string(),
    ] {
        assert!(matches!(perr(&f, &s), CellError::Invalid(_)), "{s:?}");
    }
    // The ASCII equivalent still parses, with the fraction kept.
    assert_eq!(
        p(&f, "2026-10-12 10:30:00.5"),
        Some(json!("2026-10-12T10:30:00.500Z"))
    );
}

#[test]
fn contact_types() {
    assert_eq!(
        p(&sample_field(FieldType::Email), " a@b.co "),
        Some(json!("a@b.co"))
    );
    assert!(matches!(
        perr(&sample_field(FieldType::Email), "nope"),
        CellError::Invalid(_)
    ));
    assert_eq!(
        p(&sample_field(FieldType::Url), "example.com"),
        Some(json!("https://example.com"))
    );
    assert!(matches!(
        perr(&sample_field(FieldType::Url), "javascript:alert(1)"),
        CellError::Invalid(_)
    ));
    assert_eq!(
        p(&sample_field(FieldType::Phone), "555 0100"),
        Some(json!("555 0100"))
    );
}

#[test]
fn links_and_users_by_id_list() {
    let l = link_field(false);
    assert_eq!(p(&l, "recA, recB"), Some(json!(["recA", "recB"])));
    assert_eq!(p(&l, "recA recB\nrecA"), Some(json!(["recA", "recB"])));
    assert!(
        matches!(perr(&l, "Alpha, Beta"), CellError::Invalid(_)),
        "names are resolved by the server"
    );
    assert!(matches!(
        perr(&link_field(true), "recA, recB"),
        CellError::Invalid(_)
    ));
    let u = user_field(true);
    assert_eq!(p(&u, "usr1,usr2"), Some(json!(["usr1", "usr2"])));
    assert!(matches!(
        perr(&user_field(false), "usr1,usr2"),
        CellError::Invalid(_)
    ));
}

#[test]
fn attachments_cannot_come_from_text() {
    let f = sample_field(FieldType::Attachment);
    assert!(matches!(perr(&f, "photo.png"), CellError::Invalid(_)));
}
