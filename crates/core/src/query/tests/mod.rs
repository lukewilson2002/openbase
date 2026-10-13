//! Query tests and their shared table fixture.

mod aggregate;
mod dates;
mod filter;
mod search_color;
mod sort;

use serde_json::{Map, Value as Json, json};

use super::{FieldMap, OwnedRow, QueryCtx};
use crate::cell::tests::fixtures::{self, Names, field_id, select_options};
use crate::field::*;
use crate::value::ResultType;
use crate::view::{Conjunction, Filter, FilterItem, FilterOp};

/// A table with one field of every interesting shape, keyed by id.
pub(crate) fn table() -> FieldMap {
    let fields = vec![
        field_id("fldText", FieldKind::SingleLineText(TextOptions::default())),
        field_id("fldLong", FieldKind::LongText(LongTextOptions::default())),
        field_id(
            "fldNum",
            FieldKind::Number(NumberOptions {
                precision: 2,
                ..NumberOptions::default()
            }),
        ),
        field_id("fldPct", FieldKind::Percent(NumberOptions::default())),
        field_id("fldDur", FieldKind::Duration(DurationOptions::default())),
        field_id("fldRating", FieldKind::Rating(RatingOptions::default())),
        field_id("fldCheck", FieldKind::Checkbox(CheckboxOptions::default())),
        field_id("fldSel", FieldKind::SingleSelect(select_options())),
        field_id("fldMulti", FieldKind::MultipleSelect(select_options())),
        field_id("fldDate", FieldKind::Date(DateOptions::default())),
        field_id(
            "fldDt",
            FieldKind::Date(DateOptions {
                include_time: true,
                ..DateOptions::default()
            }),
        ),
        field_id(
            "fldDtTokyo",
            FieldKind::Date(DateOptions {
                include_time: true,
                timezone: Some("Asia/Tokyo".into()),
                ..DateOptions::default()
            }),
        ),
        field_id("fldEmail", FieldKind::Email(Empty {})),
        field_id("fldAtt", FieldKind::Attachment(Empty {})),
        field_id("fldLink", fixtures::link_field(false).kind),
        field_id("fldUsers", fixtures::user_field(true).kind),
        field_id("fldOwner", fixtures::user_field(false).kind),
        field_id("fldFNum", fixtures::formula(ResultType::Number, None).kind),
        field_id("fldFText", fixtures::formula(ResultType::Text, None).kind),
        field_id("fldFBool", fixtures::formula(ResultType::Bool, None).kind),
        field_id("fldFDate", fixtures::formula(ResultType::Date, None).kind),
        field_id(
            "fldLookup",
            fixtures::lookup(ResultType::Array(Box::new(ResultType::Text))).kind,
        ),
        field_id(
            "fldLookupNum",
            fixtures::lookup(ResultType::Array(Box::new(ResultType::Number))).kind,
        ),
        field_id(
            "fldCount",
            FieldKind::Count(CountOptions {
                link_field_id: "fldLink".into(),
            }),
        ),
        field_id(
            "fldCreated",
            FieldKind::CreatedTime(DateOptions {
                include_time: true,
                ..DateOptions::default()
            }),
        ),
        field_id("fldCreatedBy", FieldKind::CreatedBy(Empty {})),
        field_id("fldAuto", FieldKind::Autonumber(Empty {})),
        field_id(
            "fldButton",
            FieldKind::Button(ButtonOptions {
                label: "Go".into(),
                url_formula: "\"https://x.y\"".into(),
            }),
        ),
    ];
    fields.into_iter().map(|f| (f.id.clone(), f)).collect()
}

pub(crate) fn row(id: &str, cells: Json) -> OwnedRow {
    let data: Map<String, Json> = match cells {
        Json::Object(m) => m,
        _ => Map::new(),
    };
    OwnedRow {
        id: id.into(),
        data,
    }
}

pub(crate) fn qctx() -> QueryCtx {
    QueryCtx::new(fixtures::now(), chrono_tz::Tz::UTC).with_user("usr1")
}

pub(crate) fn qctx_in(zone: &str, now: chrono::DateTime<chrono::Utc>) -> QueryCtx {
    QueryCtx::new(now, zone.parse().unwrap()).with_user("usr1")
}

pub(crate) fn cond(field: &str, op: FilterOp, value: Json) -> Filter {
    Filter {
        conjunction: Conjunction::And,
        items: vec![FilterItem::Condition(crate::view::Condition {
            field_id: field.into(),
            op,
            value,
        })],
    }
}

pub(crate) fn names() -> Names {
    Names
}

#[test]
fn row_impls() {
    use super::{MapRow, Row};
    let r = row("rec1", json!({"fldText": "a"}));
    assert_eq!(r.id(), "rec1");
    assert_eq!(r.get("fldText"), Some(&json!("a")));
    assert_eq!(r.get("nope"), None);
    let m = MapRow {
        id: "rec2",
        data: &r.data,
    };
    assert_eq!(m.id(), "rec2");
    assert_eq!(m.get("fldText"), Some(&json!("a")));
    let by_ref: &dyn Row = &&r;
    assert_eq!(by_ref.get("fldText"), Some(&json!("a")));
}

#[test]
fn field_lookup_impls() {
    use super::FieldLookup;
    let t = table();
    let v: Vec<Field> = t.values().cloned().collect();
    let refs: Vec<&Field> = v.iter().collect();
    let by_ref: std::collections::HashMap<String, &Field> =
        v.iter().map(|f| (f.id.clone(), f)).collect();
    assert!(t.field("fldText").is_some());
    assert!(v.field("fldText").is_some());
    assert!(v.as_slice().field("fldNum").is_some());
    assert!(refs.field("fldNum").is_some());
    assert!(refs.as_slice().field("fldSel").is_some());
    assert!(by_ref.field("fldSel").is_some());
    assert!(t.field("missing").is_none());
    assert!(v.field("missing").is_none());
}
