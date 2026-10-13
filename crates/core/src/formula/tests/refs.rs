//! Field reference extraction and display/storage rewriting.

use crate::formula::{parse, referenced_fields, to_display, to_storage};

fn resolve(name: &str) -> Option<String> {
    match name {
        "Price" => Some("fldPrice".into()),
        "Qty" => Some("fldQty".into()),
        "Unit Price" => Some("fldUnit".into()),
        "a}b" => Some("fldBrace".into()),
        "Name" => Some("fldName".into()),
        _ => None,
    }
}

fn name_of(id: &str) -> Option<String> {
    match id {
        "fldPrice" => Some("Price".into()),
        "fldQty" => Some("Qty".into()),
        "fldUnit" => Some("Unit Price".into()),
        "fldBrace" => Some("a}b".into()),
        "fldName" => Some("Name".into()),
        _ => None,
    }
}

#[test]
fn referenced_fields_in_order_without_duplicates() {
    let e = parse("IF({Qty} > 0, {Price} * {Qty}, Name & {Unit Price})").unwrap();
    assert_eq!(
        referenced_fields(&e),
        vec!["Qty", "Price", "Name", "Unit Price"]
    );
    assert!(referenced_fields(&parse("1 + 2").unwrap()).is_empty());
    assert!(referenced_fields(&parse("SUM(values)").unwrap()).is_empty());
    assert_eq!(
        referenced_fields(&parse("LAST_MODIFIED_TIME({Name})").unwrap()),
        vec!["Name"]
    );
}

#[test]
fn to_storage_rewrites_braced_and_bare_refs() {
    assert_eq!(
        to_storage("{Price} * Qty", &resolve).unwrap(),
        "{fldPrice} * {fldQty}"
    );
    assert_eq!(
        to_storage("ROUND({Unit Price},2)", &resolve).unwrap(),
        "ROUND({fldUnit},2)"
    );
    assert_eq!(
        to_storage(r"{a\}b} & 'x'", &resolve).unwrap(),
        "{fldBrace} & 'x'"
    );
}

#[test]
fn to_storage_keeps_everything_else_byte_for_byte() {
    let src = "IF( {Price}  >  10 ,\n  \"{Price} costs\" ,'Qty' )";
    assert_eq!(
        to_storage(src, &resolve).unwrap(),
        "IF( {fldPrice}  >  10 ,\n  \"{Price} costs\" ,'Qty' )"
    );
}

#[test]
fn to_storage_does_not_touch_function_names_or_values() {
    assert_eq!(
        to_storage("SUM(values) + Price", &resolve).unwrap(),
        "SUM(values) + {fldPrice}"
    );
    assert_eq!(
        to_storage("TRUE & false", &resolve).unwrap(),
        "TRUE & false"
    );
}

#[test]
fn to_storage_unknown_field_names_it_with_position() {
    let e = to_storage("{Price} + {Missing}", &resolve).unwrap_err();
    assert!(e.message.contains("'Missing'"));
    assert_eq!(e.pos, Some(10));
    let e = to_storage("Price + Bogus", &resolve).unwrap_err();
    assert!(e.message.contains("'Bogus'"));
    assert_eq!(e.pos, Some(8));
}

#[test]
fn to_storage_reports_syntax_errors() {
    let e = to_storage("{Price} +", &resolve).unwrap_err();
    assert_eq!(e.pos, Some(9));
}

#[test]
fn to_display_rewrites_ids_to_names() {
    assert_eq!(
        to_display("{fldPrice} * {fldQty}", &name_of),
        "{Price} * {Qty}"
    );
    assert_eq!(to_display("{fldBrace}", &name_of), r"{a\}b}");
    assert_eq!(
        to_display("{fldUnit}&\"{fldUnit}\"", &name_of),
        "{Unit Price}&\"{fldUnit}\""
    );
}

#[test]
fn to_display_keeps_unknown_ids_and_broken_formulas() {
    assert_eq!(to_display("{fldGone} + 1", &name_of), "{fldGone} + 1");
    assert_eq!(to_display("{fldPrice} +", &name_of), "{fldPrice} +");
}

#[test]
fn display_storage_round_trip() {
    for src in [
        "{Price} * {Qty}",
        "IF({Unit Price} > 0, {Name} & \" ok\", BLANK())",
        r"{a\}b} & {Name}",
        "SUM(values)",
        "1+2",
    ] {
        let stored = to_storage(src, &resolve).unwrap();
        assert_eq!(to_display(&stored, &name_of), src);
    }
    // Bare references come back braced.
    let stored = to_storage("Price * 2", &resolve).unwrap();
    assert_eq!(to_display(&stored, &name_of), "{Price} * 2");
}

#[test]
fn names_needing_escapes_round_trip() {
    let resolve_odd = |n: &str| match n {
        "back\\slash}" => Some("fldOdd".to_string()),
        _ => None,
    };
    let name_odd = |id: &str| (id == "fldOdd").then(|| "back\\slash}".to_string());
    let src = r"{back\\slash\}} + 1";
    let stored = to_storage(src, &resolve_odd).unwrap();
    assert_eq!(stored, "{fldOdd} + 1");
    assert_eq!(to_display(&stored, &name_odd), src);
}
