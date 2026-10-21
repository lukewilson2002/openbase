//! Shared test fixtures for cell and query tests.

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Value as Json, json};

use crate::cell::{CellCtx, NameResolver};
use crate::field::*;
use crate::value::ResultType;

/// A fixed "now": Monday 2026-10-12 15:00 UTC.
pub(crate) fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 12, 15, 0, 0).unwrap()
}

pub(crate) fn ctx() -> CellCtx {
    CellCtx::utc(now())
}

pub(crate) fn tc() -> CellCtx {
    CellCtx::utc(now()).with_typecast(true)
}

pub(crate) fn ctx_in(zone: &str) -> CellCtx {
    CellCtx::new(now(), zone.parse::<Tz>().unwrap())
}

pub(crate) fn field(kind: FieldKind) -> Field {
    field_id("fldX", kind)
}

pub(crate) fn field_id(id: &str, kind: FieldKind) -> Field {
    Field {
        id: id.into(),
        table_id: "tbl1".into(),
        name: format!("Field {id}"),
        description: None,
        kind,
    }
}

pub(crate) fn choice(id: &str, name: &str, color: &str) -> SelectChoice {
    SelectChoice {
        id: id.into(),
        name: name.into(),
        color: color.into(),
    }
}

/// Red, Green, Blue, "Red, dark" (in that order).
pub(crate) fn select_options() -> SelectOptions {
    SelectOptions {
        choices: vec![
            choice("selRed", "Red", "red"),
            choice("selGreen", "Green", "green"),
            choice("selBlue", "Blue", "blue"),
            choice("selDark", "Red, dark", "red_dark"),
        ],
    }
}

pub(crate) fn single_select() -> Field {
    field(FieldKind::SingleSelect(select_options()))
}

pub(crate) fn multi_select() -> Field {
    field(FieldKind::MultipleSelect(select_options()))
}

pub(crate) fn date_field(include_time: bool, format: DateFormat, tz: Option<&str>) -> Field {
    field(FieldKind::Date(DateOptions {
        include_time,
        date_format: format,
        time_format: TimeFormat::H12,
        timezone: tz.map(str::to_string),
    }))
}

pub(crate) fn link_field(single: bool) -> Field {
    field(FieldKind::Link(LinkOptions {
        linked_table_id: "tbl2".into(),
        inverse_field_id: "fldInv".into(),
        single,
        picker_view_id: None,
    }))
}

pub(crate) fn user_field(multiple: bool) -> Field {
    field(FieldKind::User(UserOptions {
        multiple,
        notify: false,
    }))
}

pub(crate) fn formula(rt: ResultType, format: Option<ValueFormat>) -> Field {
    field(FieldKind::Formula(FormulaOptions {
        expression: "1".into(),
        format,
        result_type: rt,
    }))
}

pub(crate) fn lookup(rt: ResultType) -> Field {
    field(FieldKind::Lookup(LookupOptions {
        link_field_id: "fldL".into(),
        target_field_id: "fldT".into(),
        result_type: rt,
    }))
}

/// A representative field of every type.
pub(crate) fn sample_field(t: FieldType) -> Field {
    let kind = match t {
        FieldType::Number => FieldKind::Number(NumberOptions {
            precision: 2,
            ..NumberOptions::default()
        }),
        FieldType::Percent => FieldKind::Percent(NumberOptions::default()),
        FieldType::SingleSelect => FieldKind::SingleSelect(select_options()),
        FieldType::MultipleSelect => FieldKind::MultipleSelect(select_options()),
        FieldType::Date => FieldKind::Date(DateOptions::default()),
        FieldType::Link => link_field(false).kind,
        FieldType::User => user_field(true).kind,
        FieldType::Formula => FieldKind::Formula(FormulaOptions {
            expression: "{fldA} * 2".into(),
            format: None,
            result_type: ResultType::Number,
        }),
        FieldType::Lookup => FieldKind::Lookup(LookupOptions {
            link_field_id: "fldL".into(),
            target_field_id: "fldT".into(),
            result_type: ResultType::Array(Box::new(ResultType::Text)),
        }),
        FieldType::Rollup => FieldKind::Rollup(RollupOptions {
            link_field_id: "fldL".into(),
            target_field_id: "fldT".into(),
            expression: "SUM(values)".into(),
            format: Some(ValueFormat::Currency {
                precision: 2,
                symbol: "$".into(),
            }),
            result_type: ResultType::Number,
        }),
        FieldType::Count => FieldKind::Count(CountOptions {
            link_field_id: "fldL".into(),
        }),
        FieldType::CreatedTime => FieldKind::CreatedTime(DateOptions {
            include_time: true,
            ..DateOptions::default()
        }),
        FieldType::Button => FieldKind::Button(ButtonOptions {
            label: "Open".into(),
            url_formula: "\"https://example.com\"".into(),
        }),
        other => FieldKind::default_for(other).expect("default options"),
    };
    field(kind)
}

/// Canonical stored samples for each type (non-empty).
pub(crate) fn sample_values(t: FieldType) -> Vec<Json> {
    match t {
        FieldType::Text => vec![json!("hello"), json!("42"), json!("Red"), json!("yes")],
        FieldType::RichText => vec![json!("line one\nline two"), json!("3.5")],
        FieldType::Number => vec![json!(42), json!(-3.25), json!(0)],
        FieldType::Currency => vec![json!(1234.5), json!(-5)],
        FieldType::Percent => vec![json!(0.5), json!(1.25)],
        FieldType::Duration => vec![json!(5400), json!(90)],
        FieldType::Rating => vec![json!(3), json!(5)],
        FieldType::Checkbox => vec![json!(true)],
        FieldType::SingleSelect => vec![json!("selRed"), json!("selDark")],
        FieldType::MultipleSelect => vec![json!(["selRed", "selBlue"]), json!(["selDark"])],
        FieldType::Date => vec![json!("2026-10-12"), json!("2026-03-08")],
        FieldType::Email => vec![json!("ada@example.com")],
        FieldType::Url => vec![json!("https://example.com/a?b=c")],
        FieldType::Phone => vec![json!("+1 (555) 010-9999")],
        FieldType::Attachment => vec![json!([
            {"id": "attA1", "filename": "photo.png", "mime": "image/png", "size": 1024, "width": 10, "height": 20},
            {"id": "attB2", "filename": "notes.txt", "mime": "text/plain", "size": 5}
        ])],
        FieldType::Link => vec![json!(["recA", "recB"]), json!(["recC"])],
        FieldType::User => vec![json!(["usr1", "usr2"]), json!(["usr1"])],
        FieldType::Formula => vec![json!(84), json!({"error": "#ERROR: division by zero"})],
        FieldType::Lookup => vec![json!(["Alpha", "Beta"])],
        FieldType::Rollup => vec![json!(99.5)],
        FieldType::Count => vec![json!(2)],
        FieldType::CreatedTime | FieldType::LastModifiedTime => {
            vec![json!("2026-10-12T14:30:00.000Z")]
        }
        FieldType::CreatedBy | FieldType::LastModifiedBy => vec![json!("usr1")],
        FieldType::Autonumber => vec![json!(7)],
        FieldType::Barcode => vec![json!("012345678905")],
        FieldType::Button => vec![json!("https://example.com")],
    }
}

/// Names for recA/recB/recC and usr1/usr2.
pub(crate) struct Names;

impl NameResolver for Names {
    fn record_name(&self, id: &str) -> Option<String> {
        match id {
            "recA" => Some("Alpha".into()),
            "recB" => Some("Beta".into()),
            "recC" => Some("Gamma, Inc".into()),
            _ => None,
        }
    }
    fn user_name(&self, id: &str) -> Option<String> {
        match id {
            "usr1" => Some("Ada Lovelace".into()),
            "usr2" => Some("Grace Hopper".into()),
            _ => None,
        }
    }
}
