//! Client input → canonical stored JSON ([`normalize`], [`parse_text`]) and
//! the select-choice helper [`missing_choices`].

use std::collections::HashSet;

use chrono::SecondsFormat;
use chrono_tz::Tz;
use serde_json::Value as Json;

use super::parse::{
    ParsedDate, clean_text, is_valid_id, local_to_utc, parse_bool_word, parse_date, parse_duration,
    parse_number, parse_tz, split_list,
};
use super::{
    CellCtx, CellError, MAX_ATTACHMENTS_PER_CELL, MAX_EMAIL_LEN, MAX_PHONE_LEN, MAX_URL_LEN,
};
use crate::field::{
    AttachmentRef, DateFormat, DateOptions, DurationFormat, Field, FieldKind, SelectChoice,
};
use crate::ids;
use crate::limits::{MAX_CHOICES_PER_FIELD, MAX_LINKS_PER_CELL, MAX_NAME_LEN, MAX_TEXT_CELL_LEN};

/// Validate client input for an editable field and return its canonical
/// stored JSON, or `None` when the value is empty (empty values are never
/// stored). JSON `null` always clears the cell. Computed fields are rejected
/// with [`CellError::ComputedField`]. See the module docs for `typecast`.
pub fn normalize(field: &Field, input: &Json, ctx: &CellCtx) -> Result<Option<Json>, CellError> {
    if field.field_type().is_computed() {
        return Err(CellError::ComputedField);
    }
    if input.is_null() {
        return Ok(None);
    }
    let tc = ctx.typecast;
    match &field.kind {
        FieldKind::SingleLineText(_) => text(input, tc, false, false),
        FieldKind::LongText(_) => text(input, tc, true, false),
        FieldKind::Barcode(_) => text(input, tc, false, true),
        FieldKind::Number(o) => {
            let Some(v) = read_number(input, tc, None, false)? else {
                return Ok(None);
            };
            finish_number(v, o.allow_negative, o.precision)
        }
        FieldKind::Currency(o) => {
            let Some(v) = read_number(input, tc, Some(&o.symbol), false)? else {
                return Ok(None);
            };
            finish_number(v, o.allow_negative, o.precision)
        }
        FieldKind::Percent(o) => {
            let Some(v) = read_number(input, tc, None, true)? else {
                return Ok(None);
            };
            finish_number(v, o.allow_negative, o.precision.min(8) + 2)
        }
        FieldKind::Duration(o) => duration(input, tc, o.format),
        FieldKind::Rating(o) => rating(input, tc, o.max),
        FieldKind::Checkbox(_) => checkbox(input, tc),
        FieldKind::SingleSelect(o) => single_select(&o.choices, input, tc),
        FieldKind::MultipleSelect(o) => multi_select(&o.choices, input, tc),
        FieldKind::Date(o) => date(o, input, ctx.timezone),
        FieldKind::Email(_) => email(input, tc),
        FieldKind::Url(_) => url(input, tc),
        FieldKind::Phone(_) => phone(input, tc),
        FieldKind::Attachment(_) => attachments(input, tc),
        FieldKind::Link(o) => {
            let ids = collect_ids(input, ids::RECORD, "record")?;
            if o.single && ids.len() > 1 {
                return Err(CellError::invalid("this field links to a single record"));
            }
            id_array(ids)
        }
        FieldKind::User(o) => {
            let ids = collect_ids(input, ids::USER, "user")?;
            if !o.multiple && ids.len() > 1 {
                return Err(CellError::invalid("this field allows a single user"));
            }
            id_array(ids)
        }
        FieldKind::Formula(_)
        | FieldKind::Lookup(_)
        | FieldKind::Rollup(_)
        | FieldKind::Count(_)
        | FieldKind::CreatedTime(_)
        | FieldKind::LastModifiedTime(_)
        | FieldKind::CreatedBy(_)
        | FieldKind::LastModifiedBy(_)
        | FieldKind::Autonumber(_)
        | FieldKind::Button(_) => Err(CellError::ComputedField),
    }
}

/// Interpret pasted or CSV text for a field: numbers with symbols and
/// separators, percentages (`"50"` and `"50%"` both mean 50%), durations,
/// checkbox words, select names (multiple selects split on commas,
/// respecting double quotes), dates in any supported format, record/user
/// ids separated by commas or spaces. Blank text clears the cell.
pub fn parse_text(field: &Field, text: &str, ctx: &CellCtx) -> Result<Option<Json>, CellError> {
    if field.field_type().is_computed() {
        return Err(CellError::ComputedField);
    }
    if matches!(field.kind, FieldKind::Attachment(_)) {
        if text.trim().is_empty() {
            return Ok(None);
        }
        return Err(CellError::invalid("attachments cannot be set from text"));
    }
    normalize(
        field,
        &Json::String(text.to_string()),
        &ctx.with_typecast(true),
    )
}

/// Choice names in `input` that match no existing choice of a select field
/// (by id, exact name or case-insensitive name), trimmed, de-duplicated
/// case-insensitively, in input order. Accepts the same shapes as
/// `normalize` with typecast on, so it also works for text from
/// [`parse_text`] (pass it as a JSON string). Other field types → empty.
pub fn missing_choices(field: &Field, input: &Json) -> Vec<String> {
    let (choices, multi) = match &field.kind {
        FieldKind::SingleSelect(o) => (&o.choices, false),
        FieldKind::MultipleSelect(o) => (&o.choices, true),
        _ => return Vec::new(),
    };
    let names: Vec<String> = match input {
        Json::String(s) if multi => split_list(s),
        Json::String(s) => vec![s.clone()],
        Json::Number(n) => vec![n.to_string()],
        Json::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                Json::String(s) => Some(s.clone()),
                Json::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && resolve_choice(choices, n).is_none())
        .filter(|n| seen.insert(n.to_lowercase()))
        .collect()
}

/// Find a choice by id, then exact name, then case-insensitive trimmed name.
pub(crate) fn resolve_choice<'a>(
    choices: &'a [SelectChoice],
    key: &str,
) -> Option<&'a SelectChoice> {
    if let Some(c) = choices.iter().find(|c| c.id == key || c.name == key) {
        return Some(c);
    }
    let k = key.trim().to_lowercase();
    choices.iter().find(|c| c.name.trim().to_lowercase() == k)
}

fn type_error(expected: &str) -> CellError {
    CellError::invalid(format!("expected {expected}"))
}

fn text(input: &Json, tc: bool, multiline: bool, barcode: bool) -> Result<Option<Json>, CellError> {
    let raw = match input {
        Json::String(s) => s.clone(),
        Json::Object(o) if barcode => match o.get("text") {
            Some(Json::String(s)) => s.clone(),
            _ => return Err(type_error("barcode text")),
        },
        Json::Number(n) if tc => n.to_string(),
        Json::Bool(b) if tc => b.to_string(),
        Json::Array(items) if tc => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|v| match v {
                    Json::String(s) => Some(s.clone()),
                    Json::Number(n) => Some(n.to_string()),
                    Json::Bool(b) => Some(b.to_string()),
                    _ => None,
                })
                .collect();
            parts.join(", ")
        }
        _ => return Err(type_error("text")),
    };
    let cleaned = clean_text(&raw, multiline);
    if cleaned.trim().is_empty() {
        return Ok(None);
    }
    if cleaned.chars().count() > MAX_TEXT_CELL_LEN {
        return Err(CellError::TooLong {
            max: MAX_TEXT_CELL_LEN,
        });
    }
    Ok(Some(Json::String(cleaned)))
}

/// Read a number. Strings (typecast only) are human text: a `%` divides by
/// 100, and for percent fields a plain `"50"` also means 50%.
fn read_number(
    input: &Json,
    tc: bool,
    symbol: Option<&str>,
    percent_field: bool,
) -> Result<Option<f64>, CellError> {
    match input {
        Json::Number(n) => n.as_f64().map(Some).ok_or_else(|| type_error("a number")),
        Json::String(s) if tc => {
            if s.trim().is_empty() {
                return Ok(None);
            }
            let p = parse_number(s, symbol)
                .ok_or_else(|| CellError::invalid(format!("\"{}\" is not a number", s.trim())))?;
            Ok(Some(if p.percent || percent_field {
                p.value / 100.0
            } else {
                p.value
            }))
        }
        _ => Err(type_error("a number")),
    }
}

/// Round to `decimals` places, keeping the input when rounding would overflow.
pub(crate) fn round_to(v: f64, decimals: u8) -> f64 {
    let factor = 10f64.powi(i32::from(decimals.min(10)));
    let r = (v * factor).round() / factor;
    if r.is_finite() { r } else { v }
}

/// Canonical JSON for a number: integers (exactly representable) as JSON
/// integers so `5` and `5.0` store identically; `-0` becomes `0`.
pub(crate) fn num_json(v: f64) -> Json {
    let v = if v == 0.0 { 0.0 } else { v };
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        return Json::from(v as i64);
    }
    serde_json::Number::from_f64(v)
        .map(Json::Number)
        .unwrap_or(Json::Null)
}

fn finish_number(v: f64, allow_negative: bool, decimals: u8) -> Result<Option<Json>, CellError> {
    let v = round_to(v, decimals.min(10));
    if !allow_negative && v < 0.0 {
        return Err(CellError::invalid("negative numbers are not allowed"));
    }
    Ok(Some(num_json(v)))
}

fn duration(input: &Json, tc: bool, format: DurationFormat) -> Result<Option<Json>, CellError> {
    let secs = match input {
        Json::Number(n) => n
            .as_f64()
            .ok_or_else(|| type_error("a duration in seconds"))?,
        Json::String(s) if tc => {
            if s.trim().is_empty() {
                return Ok(None);
            }
            parse_duration(s)
                .ok_or_else(|| CellError::invalid(format!("\"{}\" is not a duration", s.trim())))?
        }
        _ => return Err(type_error("a duration in seconds")),
    };
    let decimals = match format {
        DurationFormat::HMm | DurationFormat::HMmSs => 0,
        DurationFormat::HMmSsS => 1,
        DurationFormat::HMmSsSs => 2,
        DurationFormat::HMmSsSss => 3,
    };
    Ok(Some(num_json(round_to(secs, decimals))))
}

fn rating(input: &Json, tc: bool, max: u8) -> Result<Option<Json>, CellError> {
    let max = f64::from(max.clamp(1, 10));
    let v = match input {
        Json::Number(n) => n.as_f64().ok_or_else(|| type_error("a rating"))?,
        Json::String(s) if tc => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(None);
            }
            let stars = t.chars().filter(|c| matches!(c, '★' | '⭐')).count();
            if stars > 0 && t.chars().all(|c| matches!(c, '★' | '⭐' | '☆' | ' ')) {
                stars as f64
            } else {
                parse_number(t, None)
                    .map(|p| p.value)
                    .ok_or_else(|| CellError::invalid(format!("\"{t}\" is not a rating")))?
            }
        }
        _ => return Err(type_error("a rating")),
    };
    let v = v.round();
    if v == 0.0 {
        return Ok(None);
    }
    if v < 0.0 {
        return Err(CellError::invalid("ratings cannot be negative"));
    }
    if v > max {
        if tc {
            return Ok(Some(num_json(max)));
        }
        return Err(CellError::invalid(format!(
            "rating must be between 1 and {max}"
        )));
    }
    Ok(Some(num_json(v)))
}

fn checkbox(input: &Json, tc: bool) -> Result<Option<Json>, CellError> {
    let checked = match input {
        Json::Bool(b) => *b,
        Json::String(s) if tc => parse_bool_word(s).ok_or_else(|| {
            CellError::invalid(format!("\"{}\" is not a checkbox value", s.trim()))
        })?,
        Json::Number(n) if tc => n.as_f64().is_some_and(|v| v != 0.0),
        _ => return Err(type_error("true or false")),
    };
    Ok(checked.then_some(Json::Bool(true)))
}

fn select_key(v: &Json, tc: bool) -> Result<String, CellError> {
    match v {
        Json::String(s) => Ok(s.clone()),
        Json::Number(n) if tc => Ok(n.to_string()),
        _ => Err(type_error("an option name or id")),
    }
}

fn single_select(
    choices: &[SelectChoice],
    input: &Json,
    tc: bool,
) -> Result<Option<Json>, CellError> {
    let key = match input {
        Json::Array(items) if tc => match items.as_slice() {
            [] => return Ok(None),
            [one] => select_key(one, tc)?,
            _ => return Err(CellError::invalid("this field allows a single option")),
        },
        other => select_key(other, tc)?,
    };
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let choice =
        resolve_choice(choices, key).ok_or_else(|| CellError::UnknownChoice(key.to_string()))?;
    Ok(Some(Json::String(choice.id.clone())))
}

fn multi_select(
    choices: &[SelectChoice],
    input: &Json,
    tc: bool,
) -> Result<Option<Json>, CellError> {
    let keys: Vec<String> = match input {
        Json::Array(items) => items
            .iter()
            .map(|v| select_key(v, tc))
            .collect::<Result<_, _>>()?,
        Json::String(s) if tc => split_list(s),
        Json::Number(n) if tc => vec![n.to_string()],
        _ => return Err(type_error("a list of options")),
    };
    let mut out: Vec<Json> = Vec::new();
    let mut seen = HashSet::new();
    for key in keys {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let choice = resolve_choice(choices, key)
            .ok_or_else(|| CellError::UnknownChoice(key.to_string()))?;
        if seen.insert(choice.id.as_str()) {
            out.push(Json::String(choice.id.clone()));
        }
    }
    if out.len() > MAX_CHOICES_PER_FIELD {
        return Err(CellError::TooMany {
            max: MAX_CHOICES_PER_FIELD,
        });
    }
    Ok((!out.is_empty()).then_some(Json::Array(out)))
}

/// The zone a date field interprets and displays wall-clock times in.
pub(crate) fn field_zone(opts: &DateOptions, fallback: Tz) -> Tz {
    opts.timezone
        .as_deref()
        .and_then(parse_tz)
        .unwrap_or(fallback)
}

/// Canonical stored string for an instant: RFC 3339 UTC with milliseconds.
pub(crate) fn instant_json(dt: chrono::DateTime<chrono::Utc>) -> Json {
    Json::String(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Store a parsed date for a field with `opts` (date-only vs date-time).
pub(crate) fn store_date(opts: &DateOptions, parsed: ParsedDate, fallback: Tz) -> Option<Json> {
    let zone = field_zone(opts, fallback);
    if opts.include_time {
        let instant = match parsed {
            ParsedDate::Instant(i) => i,
            ParsedDate::Local(l) => local_to_utc(l, zone)?,
            ParsedDate::Date(d) => local_to_utc(d.and_hms_opt(0, 0, 0)?, zone)?,
        };
        Some(instant_json(instant))
    } else {
        let day = match parsed {
            ParsedDate::Date(d) => d,
            ParsedDate::Local(l) => l.date(),
            ParsedDate::Instant(i) => i.with_timezone(&zone).date_naive(),
        };
        Some(Json::String(day.format("%Y-%m-%d").to_string()))
    }
}

fn date(opts: &DateOptions, input: &Json, fallback: Tz) -> Result<Option<Json>, CellError> {
    let Json::String(s) = input else {
        return Err(type_error("a date string"));
    };
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let european = opts.date_format == DateFormat::European;
    let parsed = parse_date(s, european)
        .ok_or_else(|| CellError::invalid(format!("\"{s}\" is not a recognised date")))?;
    store_date(opts, parsed, fallback)
        .map(Some)
        .ok_or_else(|| CellError::invalid(format!("\"{s}\" is out of range")))
}

fn plain_string<'a>(input: &'a Json, what: &str) -> Result<&'a str, CellError> {
    match input {
        Json::String(s) => Ok(s.trim()),
        _ => Err(type_error(what)),
    }
}

fn has_bad_chars(s: &str) -> bool {
    s.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub(crate) fn is_valid_email(s: &str) -> bool {
    if s.len() > MAX_EMAIL_LEN || has_bad_chars(s) {
        return false;
    }
    let Some((local, domain)) = s.rsplit_once('@') else {
        return false;
    };
    if local.is_empty() || local.len() > 64 || local.contains('@') {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
}

fn email(input: &Json, _tc: bool) -> Result<Option<Json>, CellError> {
    let s = plain_string(input, "an email address")?;
    if s.is_empty() {
        return Ok(None);
    }
    if !is_valid_email(s) {
        return Err(CellError::invalid(format!(
            "\"{s}\" is not a valid email address"
        )));
    }
    Ok(Some(Json::String(s.to_string())))
}

/// Validate a URL, returning its canonical form. Only http, https and mailto
/// are allowed; bare domains (`example.com/x`, `localhost:8080`) get
/// `https://` prepended. `javascript:`, `data:` and all other schemes fail.
pub(crate) fn canonical_url(s: &str) -> Result<String, CellError> {
    let bad = || CellError::invalid(format!("\"{s}\" is not a valid URL"));
    if s.len() > MAX_URL_LEN {
        return Err(CellError::TooLong { max: MAX_URL_LEN });
    }
    if has_bad_chars(s) || s.is_empty() {
        return Err(bad());
    }
    if let Some(rest) = s.strip_prefix("//") {
        return bare_url(rest).ok_or_else(bad);
    }
    if let Some((scheme, rest)) = s.split_once(':') {
        let looks_like_scheme = scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
        if looks_like_scheme {
            let lower = scheme.to_ascii_lowercase();
            if lower == "http" || lower == "https" {
                let host = rest
                    .strip_prefix("//")
                    .map(|r| r.split(['/', '?', '#']).next().unwrap_or(""))
                    .unwrap_or("");
                if host.is_empty() || host.starts_with('@') || host.starts_with(':') {
                    return Err(bad());
                }
                return Ok(format!("{lower}:{rest}"));
            }
            if lower == "mailto" {
                if rest.is_empty() {
                    return Err(bad());
                }
                return Ok(format!("mailto:{rest}"));
            }
            let is_port = rest.chars().next().is_some_and(|c| c.is_ascii_digit());
            let is_host = scheme.contains('.') || lower == "localhost";
            if !(is_port && is_host) {
                return Err(CellError::invalid(
                    "only http, https and mailto links are allowed",
                ));
            }
        }
    }
    bare_url(s).ok_or_else(bad)
}

fn bare_url(s: &str) -> Option<String> {
    let host_port = s.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match host_port.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (host_port, None),
    };
    let port_ok =
        port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
    if !port_ok {
        return None;
    }
    let host_ok = host == "localhost"
        || (host.contains('.')
            && !host.starts_with('.')
            && !host.ends_with('.')
            && !host.contains("..")
            && host
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '.'));
    host_ok.then(|| format!("https://{s}"))
}

fn url(input: &Json, _tc: bool) -> Result<Option<Json>, CellError> {
    let s = plain_string(input, "a URL")?;
    if s.is_empty() {
        return Ok(None);
    }
    canonical_url(s).map(|u| Some(Json::String(u)))
}

pub(crate) fn is_valid_phone(s: &str) -> bool {
    if s.chars().count() > MAX_PHONE_LEN {
        return false;
    }
    let lower = s.to_lowercase();
    let stripped = lower
        .replace("extension", " ")
        .replace("ext.", " ")
        .replace("ext", " ")
        .replace('x', " ");
    let digits = stripped.chars().filter(char::is_ascii_digit).count();
    digits >= 3
        && stripped
            .chars()
            .all(|c| c.is_ascii_digit() || " +-().,/#*;\u{a0}".contains(c))
}

fn phone(input: &Json, tc: bool) -> Result<Option<Json>, CellError> {
    let s = match input {
        Json::String(s) => s.trim().to_string(),
        Json::Number(n) if tc => n.to_string(),
        _ => return Err(type_error("a phone number")),
    };
    if s.is_empty() {
        return Ok(None);
    }
    if !is_valid_phone(&s) {
        return Err(CellError::invalid(format!(
            "\"{s}\" is not a valid phone number"
        )));
    }
    Ok(Some(Json::String(s)))
}

fn valid_attachment(a: &AttachmentRef) -> bool {
    let mime_ok = !a.mime.is_empty()
        && a.mime.len() <= 255
        && a.mime.contains('/')
        && !has_bad_chars(&a.mime);
    is_valid_id(&a.id, ids::ATTACHMENT)
        && !a.filename.trim().is_empty()
        && a.filename.chars().count() <= MAX_NAME_LEN
        && !a.filename.chars().any(char::is_control)
        && mime_ok
}

fn attachments(input: &Json, tc: bool) -> Result<Option<Json>, CellError> {
    let items: Vec<&Json> = match input {
        Json::Array(items) => items.iter().collect(),
        Json::Object(_) if tc => vec![input],
        Json::String(_) => {
            return Err(CellError::invalid(
                "attachments must be uploaded first; send attachment objects",
            ));
        }
        _ => return Err(type_error("a list of attachments")),
    };
    if items.len() > MAX_ATTACHMENTS_PER_CELL {
        return Err(CellError::TooMany {
            max: MAX_ATTACHMENTS_PER_CELL,
        });
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (i, item) in items.into_iter().enumerate() {
        let parsed: AttachmentRef = serde_json::from_value(item.clone()).map_err(|_| {
            CellError::invalid(format!(
                "attachment {} must have id, filename, mime and size",
                i + 1
            ))
        })?;
        if !valid_attachment(&parsed) {
            return Err(CellError::invalid(format!(
                "attachment {} is invalid",
                i + 1
            )));
        }
        if seen.insert(parsed.id.clone()) {
            let json = serde_json::to_value(&parsed)
                .map_err(|_| CellError::invalid("attachment could not be stored"))?;
            out.push(json);
        }
    }
    Ok((!out.is_empty()).then_some(Json::Array(out)))
}

/// Collect ids from `"id"`, `"id1, id2"`, `["id"]`, `[{"id": "id"}]` or
/// `{"id": "id"}`, validating the prefix and de-duplicating in order.
fn collect_ids(input: &Json, prefix: &str, what: &str) -> Result<Vec<String>, CellError> {
    let shape_err = || type_error(&format!("{what} ids"));
    let raw: Vec<String> = match input {
        Json::String(s) => s
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        Json::Array(items) => items
            .iter()
            .map(|v| match v {
                Json::String(s) => Ok(s.trim().to_string()),
                Json::Object(o) => match o.get("id") {
                    Some(Json::String(s)) => Ok(s.trim().to_string()),
                    _ => Err(shape_err()),
                },
                _ => Err(shape_err()),
            })
            .collect::<Result<_, _>>()?,
        Json::Object(o) => match o.get("id") {
            Some(Json::String(s)) => vec![s.trim().to_string()],
            _ => return Err(shape_err()),
        },
        _ => return Err(shape_err()),
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in raw {
        if id.is_empty() {
            continue;
        }
        if !is_valid_id(&id, prefix) {
            let shown: String = id.chars().take(50).collect();
            return Err(CellError::invalid(format!(
                "\"{shown}\" is not a valid {what} id"
            )));
        }
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    if out.len() > MAX_LINKS_PER_CELL {
        return Err(CellError::TooMany {
            max: MAX_LINKS_PER_CELL,
        });
    }
    Ok(out)
}

fn id_array(ids: Vec<String>) -> Result<Option<Json>, CellError> {
    Ok((!ids.is_empty()).then(|| Json::Array(ids.into_iter().map(Json::String).collect())))
}
