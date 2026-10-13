//! Conversions between [`Value`] variants following Airtable's coercion rules,
//! plus equality and ordering used by comparison operators.
//!
//! Conversions that can fail return `Err(Value::Error(..))` so callers can
//! propagate with `?`.

use std::cmp::Ordering;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

use super::datetime::parse_date_text;
use crate::limits::MAX_TEXT_CELL_LEN;
use crate::value::Value;

/// Result of a formula operation: `Err` holds a `Value::Error`.
pub(crate) type R<T = Value> = Result<T, Value>;

/// Upper bound on any text a formula produces, in bytes. Generous enough for
/// any text cell (which is limited in characters) but stops `REPT`,
/// `SUBSTITUTE` and friends from exhausting memory.
pub(crate) const MAX_TEXT_BYTES: usize = MAX_TEXT_CELL_LEN * 4;

pub(crate) fn err(msg: impl AsRef<str>) -> Value {
    Value::Error(format!("#ERROR: {}", msg.as_ref()))
}

pub(crate) fn too_long() -> Value {
    err(format!(
        "Text result is too long (maximum {MAX_TEXT_CELL_LEN} characters)"
    ))
}

/// Number result, turning NaN/infinity into an error.
pub(crate) fn num(n: f64) -> R {
    if n.is_finite() {
        Ok(Value::Number(if n == 0.0 { 0.0 } else { n }))
    } else {
        Err(err("Result is not a finite number"))
    }
}

/// Text result, enforcing [`MAX_TEXT_BYTES`].
pub(crate) fn text(s: String) -> R {
    if s.len() > MAX_TEXT_BYTES {
        Err(too_long())
    } else {
        Ok(Value::Text(s))
    }
}

/// Formats a number the way Airtable prints it in text: no trailing zeros,
/// no exponent, `-0` prints as `0`.
pub fn format_number(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string();
    }
    if !n.is_finite() {
        return "NaN".to_string();
    }
    format!("{n}")
}

/// Parses a number written in text (`" 12.5 "`, `-3e2`). Blank text is 0.
/// Rejects words like `inf`/`NaN` that `f64::from_str` would accept.
pub(crate) fn parse_number_text(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Number coercion for arithmetic: blank → 0, TRUE → 1, numeric text →
/// its number, single-item arrays → their item.
pub(crate) fn to_number(v: &Value) -> R<f64> {
    match v {
        Value::Null => Ok(0.0),
        Value::Number(n) if n.is_finite() => Ok(*n),
        Value::Number(_) => Err(err("Number is not finite")),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Text(s) => parse_number_text(s)
            .ok_or_else(|| err(format!("Cannot use the text '{}' as a number", preview(s)))),
        Value::Date(_) | Value::DateTime(_) => Err(err(
            "Cannot do arithmetic on a date; use DATEADD or DATETIME_DIFF",
        )),
        Value::Array(items) => match items.as_slice() {
            [] => Ok(0.0),
            [one] => to_number(one),
            many => Err(err(format!(
                "Cannot use a list of {} values as a number",
                many.len()
            ))),
        },
        Value::Error(_) => Err(v.clone()),
    }
}

/// First 40 characters of `s`, for error messages.
pub(crate) fn preview(s: &str) -> String {
    let mut out: String = s.chars().take(40).collect();
    if s.chars().nth(40).is_some() {
        out.push('…');
    }
    out
}

pub(crate) fn date_text(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub(crate) fn datetime_text(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Text coercion: blank → `""`, numbers without trailing zeros, booleans as
/// `1`/`0`, dates as ISO 8601, arrays flattened and joined with `", "`.
/// Errors propagate as `Err`.
pub fn to_text(v: &Value) -> Result<String, Value> {
    let mut out = String::new();
    push_text(&mut out, v)?;
    Ok(out)
}

fn push_text(out: &mut String, v: &Value) -> R<()> {
    match v {
        Value::Null => {}
        Value::Text(s) => out.push_str(s),
        Value::Number(n) => out.push_str(&format_number(*n)),
        Value::Bool(b) => out.push_str(if *b { "1" } else { "0" }),
        Value::Date(d) => out.push_str(&date_text(*d)),
        Value::DateTime(dt) => out.push_str(&datetime_text(*dt)),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                push_text(out, item)?;
                if out.len() > MAX_TEXT_BYTES {
                    return Err(too_long());
                }
            }
        }
        Value::Error(_) => return Err(v.clone()),
    }
    if out.len() > MAX_TEXT_BYTES {
        return Err(too_long());
    }
    Ok(())
}

/// A date argument: date-only values stay calendar dates (never shifted by a
/// timezone); everything else is an instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum DateVal {
    Date(NaiveDate),
    Instant(DateTime<Utc>),
}

impl DateVal {
    /// Instant for comparisons and differences; date-only values are midnight UTC.
    pub(crate) fn instant(self) -> DateTime<Utc> {
        match self {
            DateVal::Date(d) => naive_midnight(d).and_utc(),
            DateVal::Instant(t) => t,
        }
    }

    pub(crate) fn to_value(self) -> Value {
        match self {
            DateVal::Date(d) => Value::Date(d),
            DateVal::Instant(t) => Value::DateTime(t),
        }
    }
}

pub(crate) fn naive_midnight(d: NaiveDate) -> NaiveDateTime {
    d.and_time(chrono::NaiveTime::MIN)
}

/// Date coercion for date function arguments. Blank → `Ok(None)` (date
/// functions return blank for blank input); text is parsed leniently.
pub(crate) fn to_date(v: &Value) -> R<Option<DateVal>> {
    match v {
        Value::Null => Ok(None),
        Value::Date(d) => Ok(Some(DateVal::Date(*d))),
        Value::DateTime(t) => Ok(Some(DateVal::Instant(*t))),
        Value::Text(s) if s.trim().is_empty() => Ok(None),
        Value::Text(s) => parse_date_text(s)
            .map(Some)
            .ok_or_else(|| err(format!("Cannot read '{}' as a date", preview(s)))),
        Value::Array(items) => match items.as_slice() {
            [] => Ok(None),
            [one] => to_date(one),
            many => Err(err(format!(
                "Cannot use a list of {} values as a date",
                many.len()
            ))),
        },
        Value::Number(_) | Value::Bool(_) => Err(err("Expected a date")),
        Value::Error(_) => Err(v.clone()),
    }
}

/// Calls `f` on every leaf of the values, descending into arrays.
pub(crate) fn for_each_leaf<'a>(vals: &'a [Value], f: &mut dyn FnMut(&'a Value)) {
    for v in vals {
        match v {
            Value::Array(items) => for_each_leaf(items, f),
            other => f(other),
        }
    }
}

/// All leaves, flattened. Returns the first error found anywhere.
pub(crate) fn flatten(vals: &[Value]) -> R<Vec<Value>> {
    let mut out = Vec::new();
    let mut first_err = None;
    for_each_leaf(vals, &mut |v| {
        if v.is_error() && first_err.is_none() {
            first_err = Some(v.clone());
        }
        out.push(v.clone());
    });
    match first_err {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

fn is_dateish(v: &Value) -> bool {
    matches!(v, Value::Date(_) | Value::DateTime(_))
}

fn as_instant(v: &Value) -> Option<DateTime<Utc>> {
    match v {
        Value::Date(d) => Some(naive_midnight(*d).and_utc()),
        Value::DateTime(t) => Some(*t),
        Value::Text(s) => parse_date_text(s).map(DateVal::instant),
        _ => None,
    }
}

/// Unwraps single-item arrays so `{Lookup} = 5` works for one linked record.
fn unwrap_single(v: &Value) -> &Value {
    match v {
        Value::Array(items) if items.len() == 1 => unwrap_single(&items[0]),
        other => other,
    }
}

/// Ordering used by `< > <= >= = !=` (errors must be handled by the caller).
/// `None` means the values are not comparable: every ordering test is false
/// and `!=` is true.
pub(crate) fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    let (a, b) = (unwrap_single(a), unwrap_single(b));
    if is_dateish(a) || is_dateish(b) {
        if a.is_blank() || b.is_blank() {
            return None;
        }
        return as_instant(a)?.partial_cmp(&as_instant(b)?);
    }
    match (a, b) {
        (Value::Array(_), _) | (_, Value::Array(_)) => {
            Some(to_text(a).ok()?.cmp(&to_text(b).ok()?))
        }
        (Value::Text(x), Value::Text(y)) => Some(x.cmp(y)),
        (Value::Null, Value::Text(y)) => Some("".cmp(y.as_str())),
        (Value::Text(x), Value::Null) => Some(x.as_str().cmp("")),
        _ => {
            let x = to_number(a).ok()?;
            let y = to_number(b).ok()?;
            x.partial_cmp(&y)
        }
    }
}

/// Equality for `=`: like JavaScript loose equality for numbers and blanks
/// (`0 = ""` and `BLANK() = 0` are true), case-sensitive for text.
pub(crate) fn loose_eq(a: &Value, b: &Value) -> bool {
    compare(a, b) == Some(Ordering::Equal)
}

/// Equality for `SWITCH` patterns: blank matches only blank, otherwise
/// values must be of comparable kinds and equal.
pub(crate) fn strict_eq(a: &Value, b: &Value) -> bool {
    let (a, b) = (unwrap_single(a), unwrap_single(b));
    match (a.is_blank(), b.is_blank()) {
        (true, true) => return true,
        (true, false) | (false, true) => return false,
        _ => {}
    }
    match (a, b) {
        (Value::Text(x), Value::Text(y)) => x == y,
        (Value::Number(_) | Value::Bool(_), Value::Number(_) | Value::Bool(_)) => {
            to_number(a).ok() == to_number(b).ok()
        }
        _ if is_dateish(a) && is_dateish(b) => as_instant(a) == as_instant(b),
        (Value::Array(_), Value::Array(_)) => to_text(a).ok() == to_text(b).ok(),
        _ => false,
    }
}
