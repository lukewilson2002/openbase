//! Stored JSON → runtime [`Value`] ([`to_value`]) and → human text
//! ([`display_text`]), plus the number/date formatting they share.

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde_json::Value as Json;

use super::NameResolver;
use super::normalize::{field_zone, round_to};
use super::parse::{ParsedDate, join_list, parse_number, read_stored_date};
use crate::field::{
    DateFormat, DateOptions, DurationFormat, Field, FieldKind, TimeFormat, ValueFormat,
};
use crate::value::{ResultType, Value};

/// Convert stored cell JSON into a runtime [`Value`].
///
/// Links become `Array(Text(primary name or id))`, selects `Text(choice
/// name)` (unknown/deleted choices are dropped), attachments
/// `Array(Text(filename))`, users `Text(name)` or `Array(Text(name))` per
/// `multiple`, checkboxes `Bool` (absent = false), dates `Date` (date-only)
/// or `DateTime`, computed fields per their `result_type`. Missing or
/// malformed JSON reads as [`Value::Null`].
pub fn to_value(field: &Field, stored: Option<&Json>, names: &dyn NameResolver) -> Value {
    if let FieldKind::Checkbox(_) = field.kind {
        return Value::Bool(matches!(stored, Some(Json::Bool(true))));
    }
    let Some(json) = stored.filter(|j| !j.is_null()) else {
        return Value::Null;
    };
    match &field.kind {
        FieldKind::Text(_)
        | FieldKind::RichText(_)
        | FieldKind::Email(_)
        | FieldKind::Url(_)
        | FieldKind::Phone(_)
        | FieldKind::Barcode(_)
        | FieldKind::Button(_) => match json {
            Json::String(s) if !s.is_empty() => Value::Text(s.clone()),
            Json::Number(n) => Value::Text(n.to_string()),
            _ => Value::Null,
        },
        FieldKind::Number(_)
        | FieldKind::Currency(_)
        | FieldKind::Percent(_)
        | FieldKind::Duration(_)
        | FieldKind::Rating(_)
        | FieldKind::Autonumber(_)
        | FieldKind::Count(_) => json_number(json).map_or(Value::Null, Value::Number),
        FieldKind::Checkbox(_) => Value::Bool(matches!(json, Json::Bool(true))),
        FieldKind::SingleSelect(o) => match json {
            Json::String(id) => o
                .choices
                .iter()
                .find(|c| &c.id == id)
                .map_or(Value::Null, |c| Value::Text(c.name.clone())),
            _ => Value::Null,
        },
        FieldKind::MultipleSelect(o) => non_empty_array(
            string_items(json)
                .filter_map(|id| o.choices.iter().find(|c| c.id == id))
                .map(|c| Value::Text(c.name.clone()))
                .collect(),
        ),
        FieldKind::Date(_) | FieldKind::CreatedTime(_) | FieldKind::LastModifiedTime(_) => {
            match json {
                Json::String(s) => stored_date_value(s),
                _ => Value::Null,
            }
        }
        FieldKind::Attachment(_) => non_empty_array(
            attachment_names(json)
                .into_iter()
                .map(Value::Text)
                .collect(),
        ),
        FieldKind::Link(_) => non_empty_array(
            string_items(json)
                .map(|id| Value::Text(names.record_name(id).unwrap_or_else(|| id.to_string())))
                .collect(),
        ),
        FieldKind::User(o) => {
            let mut users: Vec<Value> = string_items(json)
                .map(|id| Value::Text(names.user_name(id).unwrap_or_else(|| id.to_string())))
                .collect();
            if o.multiple {
                non_empty_array(users)
            } else if users.is_empty() {
                Value::Null
            } else {
                users.swap_remove(0)
            }
        }
        FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_) => {
            string_items(json).next().map_or(Value::Null, |id| {
                Value::Text(names.user_name(id).unwrap_or_else(|| id.to_string()))
            })
        }
        FieldKind::Formula(o) => computed_to_value(json, &o.result_type),
        FieldKind::Rollup(o) => computed_to_value(json, &o.result_type),
        FieldKind::Lookup(o) => computed_to_value(json, &o.result_type),
    }
}

/// Human text for a cell: used for CSV export, search and link primary
/// names. Numbers use the field's precision/symbol/percent/duration format,
/// dates the field's formats in its fixed zone (else `tz`), selects their
/// names, multi-valued cells are joined with `", "` (items containing commas
/// are quoted so the text parses back), checkboxes are `"checked"` or `""`.
pub fn display_text(
    field: &Field,
    stored: Option<&Json>,
    names: &dyn NameResolver,
    tz: Tz,
) -> String {
    if let FieldKind::Checkbox(_) = field.kind {
        return if matches!(stored, Some(Json::Bool(true))) {
            "checked".into()
        } else {
            String::new()
        };
    }
    if let FieldKind::Button(o) = &field.kind {
        return match stored {
            Some(Json::String(s)) if !s.is_empty() => o.label.clone(),
            _ => String::new(),
        };
    }
    let value = to_value(field, stored, names);
    let date_opts = date_options_of(field);
    value_text(&value, &number_format_of(field), date_opts.as_ref(), tz)
}

/// Format a runtime value with a number format and (for dates) date options.
pub(crate) fn value_text(
    v: &Value,
    num: &NumberFormat<'_>,
    date: Option<&DateOptions>,
    tz: Tz,
) -> String {
    match v {
        Value::Null => String::new(),
        Value::Text(s) => s.clone(),
        Value::Number(n) => format_number(*n, num),
        Value::Bool(b) => b.to_string(),
        Value::Date(_) | Value::DateTime(_) => {
            let default;
            let opts = match date {
                Some(o) => o,
                None => {
                    default = DateOptions {
                        include_time: matches!(v, Value::DateTime(_)),
                        ..DateOptions::default()
                    };
                    &default
                }
            };
            format_date_value(v, opts, tz)
        }
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .map(|i| value_text(i, num, date, tz))
                .filter(|s| !s.is_empty())
                .collect();
            join_list(&parts)
        }
        Value::Error(e) => e.clone(),
    }
}

/// Convert materialized computed JSON (from `Value::to_json`) back into a
/// value of the static type `rt`. `{"error": "..."}` becomes `Value::Error`.
pub(crate) fn computed_to_value(json: &Json, rt: &ResultType) -> Value {
    if let Json::Object(o) = json {
        return match o.get("error") {
            Some(Json::String(e)) => Value::Error(e.clone()),
            _ => Value::Null,
        };
    }
    if json.is_null() {
        return Value::Null;
    }
    match rt {
        ResultType::Text => match json {
            Json::String(s) if s.is_empty() => Value::Null,
            Json::String(s) => Value::Text(s.clone()),
            Json::Number(n) => Value::Text(n.to_string()),
            Json::Bool(b) => Value::Text(b.to_string()),
            Json::Array(items) => {
                let parts: Vec<String> = items
                    .iter()
                    .map(|i| {
                        value_text(
                            &computed_to_value(i, rt),
                            &NumberFormat::General,
                            None,
                            Tz::UTC,
                        )
                    })
                    .collect();
                Value::Text(parts.join(", "))
            }
            _ => Value::Null,
        },
        ResultType::Number => json_number(json).map_or(Value::Null, Value::Number),
        ResultType::Bool => match json {
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Bool(n.as_f64().is_some_and(|v| v != 0.0)),
            _ => Value::Null,
        },
        ResultType::Date | ResultType::DateTime => match json {
            Json::String(s) => stored_date_value(s),
            _ => Value::Null,
        },
        ResultType::Array(inner) => match json {
            Json::Array(items) => {
                non_empty_array(items.iter().map(|i| computed_to_value(i, inner)).collect())
            }
            other => non_empty_array(vec![computed_to_value(other, inner)]),
        },
    }
}

fn stored_date_value(s: &str) -> Value {
    match read_stored_date(s) {
        Some(ParsedDate::Date(d)) => Value::Date(d),
        Some(ParsedDate::Instant(i)) => Value::DateTime(i),
        _ => Value::Null,
    }
}

fn json_number(json: &Json) -> Option<f64> {
    match json {
        Json::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Json::String(s) => parse_number(s, None).map(|p| p.value),
        _ => None,
    }
}

fn non_empty_array(items: Vec<Value>) -> Value {
    if items.iter().all(Value::is_blank) {
        Value::Null
    } else {
        Value::Array(items)
    }
}

/// Iterate the string items of a stored array (or a lone string).
pub(crate) fn string_items(json: &Json) -> Box<dyn Iterator<Item = &str> + '_> {
    match json {
        Json::Array(items) => Box::new(
            items
                .iter()
                .filter_map(Json::as_str)
                .filter(|s| !s.is_empty()),
        ),
        Json::String(s) if !s.is_empty() => Box::new(std::iter::once(s.as_str())),
        _ => Box::new(std::iter::empty()),
    }
}

pub(crate) fn attachment_names(json: &Json) -> Vec<String> {
    match json {
        Json::Array(items) => items
            .iter()
            .filter_map(|a| a.get("filename").and_then(Json::as_str))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// How a field's numbers are displayed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NumberFormat<'a> {
    /// Shortest sensible text (computed values without a format).
    General,
    Fixed(u8),
    Currency {
        precision: u8,
        symbol: &'a str,
    },
    Percent(u8),
    Duration(DurationFormat),
    Integer,
}

fn from_value_format(f: Option<&ValueFormat>) -> NumberFormat<'_> {
    match f {
        Some(ValueFormat::Number { precision }) => NumberFormat::Fixed(*precision),
        Some(ValueFormat::Currency { precision, symbol }) => NumberFormat::Currency {
            precision: *precision,
            symbol,
        },
        Some(ValueFormat::Percent { precision }) => NumberFormat::Percent(*precision),
        Some(ValueFormat::Duration { format }) => NumberFormat::Duration(*format),
        Some(ValueFormat::Date(_)) | None => NumberFormat::General,
    }
}

/// The number display format of a field.
pub(crate) fn number_format_of(field: &Field) -> NumberFormat<'_> {
    match &field.kind {
        FieldKind::Number(o) => NumberFormat::Fixed(o.precision),
        FieldKind::Currency(o) => NumberFormat::Currency {
            precision: o.precision,
            symbol: &o.symbol,
        },
        FieldKind::Percent(o) => NumberFormat::Percent(o.precision),
        FieldKind::Duration(o) => NumberFormat::Duration(o.format),
        FieldKind::Rating(_) | FieldKind::Autonumber(_) | FieldKind::Count(_) => {
            NumberFormat::Integer
        }
        FieldKind::Formula(o) => from_value_format(o.format.as_ref()),
        FieldKind::Rollup(o) => from_value_format(o.format.as_ref()),
        _ => NumberFormat::General,
    }
}

/// The date display options of a field, if it shows dates.
pub(crate) fn date_options_of(field: &Field) -> Option<DateOptions> {
    match &field.kind {
        FieldKind::Date(o) | FieldKind::CreatedTime(o) => Some(o.clone()),
        FieldKind::LastModifiedTime(o) => Some(o.date.clone()),
        FieldKind::Formula(o) => match &o.format {
            Some(ValueFormat::Date(d)) => Some(d.clone()),
            _ => None,
        },
        FieldKind::Rollup(o) => match &o.format {
            Some(ValueFormat::Date(d)) => Some(d.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn strip_negative_zero(s: String) -> String {
    match s.strip_prefix('-') {
        Some(rest) if rest.chars().all(|c| c == '0' || c == '.') => rest.to_string(),
        _ => s,
    }
}

/// Fixed decimals, rounding half away from zero (Rust's `{:.N}` rounds half
/// to even, which would show 1234.5 as "1234").
fn format_fixed(v: f64, precision: u8) -> String {
    let p = precision.min(8);
    strip_negative_zero(format!("{:.*}", usize::from(p), round_to(v, p)))
}

fn with_thousands(s: &str) -> String {
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => ("-", r),
        None => ("", s),
    };
    let (int, frac) = match rest.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (rest, None),
    };
    let mut grouped = String::with_capacity(int.len() + int.len() / 3);
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    match frac {
        Some(f) => format!("{sign}{grouped}.{f}"),
        None => format!("{sign}{grouped}"),
    }
}

/// Shortest sensible decimal text: integers without a fraction, otherwise up
/// to 10 decimals with trailing zeros trimmed.
pub(crate) fn format_general_number(v: f64) -> String {
    if !v.is_finite() {
        return String::new();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return strip_negative_zero(format!("{v:.0}"));
    }
    let s = format!("{v:.10}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    strip_negative_zero(s)
}

pub(crate) fn format_number(v: f64, fmt: &NumberFormat<'_>) -> String {
    if !v.is_finite() {
        return String::new();
    }
    match fmt {
        NumberFormat::General => format_general_number(v),
        NumberFormat::Fixed(p) => format_fixed(v, *p),
        NumberFormat::Integer => format_fixed(v, 0),
        NumberFormat::Currency { precision, symbol } => {
            let s = with_thousands(&format_fixed(v, *precision));
            match s.strip_prefix('-') {
                Some(rest) => format!("-{symbol}{rest}"),
                None => format!("{symbol}{s}"),
            }
        }
        NumberFormat::Percent(p) => format!("{}%", format_fixed(v * 100.0, *p)),
        NumberFormat::Duration(f) => format_duration(v, *f),
    }
}

/// Format seconds as `h:mm`, `h:mm:ss` or `h:mm:ss.s…`.
pub(crate) fn format_duration(secs: f64, fmt: DurationFormat) -> String {
    let negative = secs < 0.0;
    let a = secs.abs();
    let text = match fmt {
        DurationFormat::HMm => {
            let total_min = (a / 60.0).round() as u64;
            format!("{}:{:02}", total_min / 60, total_min % 60)
        }
        _ => {
            let decimals: u32 = match fmt {
                DurationFormat::HMmSsS => 1,
                DurationFormat::HMmSsSs => 2,
                DurationFormat::HMmSsSss => 3,
                _ => 0,
            };
            let scale = 10u64.pow(decimals);
            let total = (a * scale as f64).round() as u64;
            let whole = total / scale;
            let frac = total % scale;
            let base = format!(
                "{}:{:02}:{:02}",
                whole / 3600,
                (whole % 3600) / 60,
                whole % 60
            );
            if decimals == 0 {
                base
            } else {
                format!("{base}.{frac:0width$}", width = decimals as usize)
            }
        }
    };
    let is_zero = text.chars().all(|c| matches!(c, '0' | ':' | '.'));
    if negative && !is_zero {
        format!("-{text}")
    } else {
        text
    }
}

fn format_day(d: NaiveDate, f: DateFormat) -> String {
    let pattern = match f {
        DateFormat::Us => "%-m/%-d/%Y",
        DateFormat::European => "%-d/%-m/%Y",
        DateFormat::Iso => "%Y-%m-%d",
        DateFormat::Friendly => "%B %-d, %Y",
    };
    d.format(pattern).to_string()
}

/// Format a `Date`/`DateTime` value per `opts` in the field zone (or `tz`).
/// Date-only values are never shifted between zones.
pub(crate) fn format_date_value(v: &Value, opts: &DateOptions, tz: Tz) -> String {
    match v {
        Value::Date(d) => format_day(*d, opts.date_format),
        Value::DateTime(i) => {
            let local = i.with_timezone(&field_zone(opts, tz));
            let day = format_day(local.date_naive(), opts.date_format);
            if !opts.include_time {
                return day;
            }
            let time = match opts.time_format {
                TimeFormat::H12 => local.format("%-I:%M%P").to_string(),
                TimeFormat::H24 => local.format("%H:%M").to_string(),
            };
            format!("{day} {time}")
        }
        _ => String::new(),
    }
}
