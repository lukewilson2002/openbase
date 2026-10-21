//! Best-effort data conversion when a field's type (or options) change.

use std::collections::HashSet;

use chrono_tz::Tz;
use serde_json::Value as Json;

use super::normalize::{instant_json, num_json, resolve_choice};
use super::parse::{clean_text, parse_bool_word, split_list};
use super::present::string_items;
use super::{CellCtx, NameResolver, display_text, normalize, parse_text, to_value};
use crate::field::{Field, FieldKind};
use crate::limits::{MAX_CHOICES_PER_FIELD, MAX_NAME_LEN, MAX_TEXT_CELL_LEN};
use crate::value::Value;

/// Convert one stored cell from field definition `from` to `to`. Never fails:
/// values that cannot be represented in the new type become `None`.
///
/// Rules, in order:
/// - into a computed type, attachment (from anything else) or link (from
///   anything but a link to the same table): `None` (names can't be
///   resolved to record ids here);
/// - link → link (same table) and user-ish → user keep ids, truncated to
///   one when the target allows a single value;
/// - select ↔ select keeps choices by name (the caller creates missing
///   choices first, see [`choices_needed_for_conversion`]); multi → single
///   keeps the first;
/// - anything → text uses [`display_text`] (truncated to the cell limit);
///   into one-line text, line breaks and the spaces around them become one
///   space. Markdown is not read or written here: the server turns rich
///   text into plain text and back around this (`fields_engine`);
/// - numeric ↔ numeric keeps the raw number (re-rounded and range-checked
///   for the target), checkbox → number is 1, number → checkbox is `≠ 0`;
/// - dates and date-times re-normalize through the target's zone and
///   `include_time` setting;
/// - otherwise the display text is re-read with [`parse_text`].
pub fn convert(
    from: &Field,
    to: &Field,
    stored: Option<&Json>,
    ctx: &CellCtx,
    names: &dyn NameResolver,
) -> Option<Json> {
    let stored = stored.filter(|j| !j.is_null())?;
    if to.field_type().is_computed() {
        return None;
    }
    let tctx = ctx.with_typecast(true);
    let renormalize = |input: &Json| normalize(to, input, &tctx).ok().flatten();

    match (&from.kind, &to.kind) {
        (FieldKind::Link(a), FieldKind::Link(b)) => {
            if a.linked_table_id != b.linked_table_id {
                return None;
            }
            let ids = id_list(stored, b.single);
            return renormalize(&ids);
        }
        (_, FieldKind::Link(_)) => return None,
        (
            FieldKind::User(_) | FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_),
            FieldKind::User(o),
        ) => {
            return renormalize(&id_list(stored, !o.multiple));
        }
        (FieldKind::Attachment(_), FieldKind::Attachment(_)) => return renormalize(stored),
        (_, FieldKind::Attachment(_)) => return None,
        (
            FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_),
            FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_),
        ) => {
            let names = select_names(from, stored);
            let input = if matches!(to.kind, FieldKind::SingleSelect(_)) {
                Json::String(names.into_iter().next()?)
            } else {
                Json::Array(names.into_iter().map(Json::String).collect())
            };
            return renormalize(&input);
        }
        _ => {}
    }

    let value = to_value(from, Some(stored), names);
    let text = || display_text(from, Some(stored), names, ctx.timezone);
    let from_text = || parse_text(to, &text(), ctx).ok().flatten();

    match &to.kind {
        FieldKind::Text(_) | FieldKind::RichText(_) | FieldKind::Barcode(_) => {
            let multiline = match &to.kind {
                FieldKind::Text(o) => o.multiline,
                FieldKind::RichText(_) => true,
                _ => false,
            };
            let text = text();
            let text = if multiline {
                text
            } else {
                // One line: each run of line breaks, with the spaces around it, becomes one space.
                let lines: Vec<&str> = text
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .collect();
                lines.join(" ")
            };
            let cleaned: String = clean_text(&text, multiline)
                .chars()
                .take(MAX_TEXT_CELL_LEN)
                .collect();
            renormalize(&Json::String(cleaned))
        }
        FieldKind::Number(_)
        | FieldKind::Currency(_)
        | FieldKind::Percent(_)
        | FieldKind::Duration(_)
        | FieldKind::Rating(_) => match value {
            Value::Number(n) => renormalize(&num_json(n)),
            Value::Bool(b) => renormalize(&num_json(if b { 1.0 } else { 0.0 })),
            Value::Date(_) | Value::DateTime(_) | Value::Error(_) => None,
            _ => from_text(),
        },
        FieldKind::Checkbox(_) => match value {
            Value::Number(n) => (n != 0.0).then_some(Json::Bool(true)),
            Value::Bool(b) => b.then_some(Json::Bool(true)),
            Value::Error(_) => None,
            _ => parse_bool_word(&text())
                .filter(|b| *b)
                .map(|_| Json::Bool(true)),
        },
        FieldKind::Date(_) => match value {
            Value::Date(d) => renormalize(&Json::String(d.format("%Y-%m-%d").to_string())),
            Value::DateTime(i) => renormalize(&instant_json(i)),
            Value::Number(_) | Value::Bool(_) | Value::Error(_) => None,
            _ => from_text(),
        },
        _ => match value {
            Value::Error(_) => None,
            _ => from_text(),
        },
    }
}

fn id_list(stored: &Json, single: bool) -> Json {
    let ids = string_items(stored).take(if single { 1 } else { usize::MAX });
    Json::Array(ids.map(|s| Json::String(s.to_string())).collect())
}

fn select_names(from: &Field, stored: &Json) -> Vec<String> {
    match to_value(from, Some(stored), &super::NoNames) {
        Value::Text(s) => vec![s],
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::Text(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Choice names that must be added to select field `to` before converting
/// the given stored values of `from` with [`convert`]. Names are trimmed,
/// de-duplicated case-insensitively in first-seen order, exclude existing
/// choices, skip names longer than `limits::MAX_NAME_LEN` (those cells
/// convert to empty) and stop once the field would hold
/// `limits::MAX_CHOICES_PER_FIELD` choices. Non-select targets → empty.
pub fn choices_needed_for_conversion<'a>(
    from: &Field,
    to: &Field,
    stored: impl IntoIterator<Item = Option<&'a Json>>,
    names: &dyn NameResolver,
    tz: Tz,
) -> Vec<String> {
    let (choices, multi_target) = match &to.kind {
        FieldKind::SingleSelect(o) => (&o.choices, false),
        FieldKind::MultipleSelect(o) => (&o.choices, true),
        _ => return Vec::new(),
    };
    let from_select = matches!(
        from.kind,
        FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_)
    );
    let room = MAX_CHOICES_PER_FIELD.saturating_sub(choices.len());
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for json in stored.into_iter().flatten() {
        if json.is_null() {
            continue;
        }
        let mut candidates = if from_select {
            select_names(from, json)
        } else {
            let text = display_text(from, Some(json), names, tz);
            if multi_target {
                split_list(&text)
            } else {
                vec![text]
            }
        };
        if !multi_target {
            candidates.truncate(1);
        }
        for name in candidates {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
                continue;
            }
            if resolve_choice(choices, name).is_some() || !seen.insert(name.to_lowercase()) {
                continue;
            }
            if out.len() >= room {
                return out;
            }
            out.push(name.to_string());
        }
    }
    out
}
