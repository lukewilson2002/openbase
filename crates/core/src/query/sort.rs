//! Sort comparators, stable multi-level sorting, grouping keys and group
//! spans, and validation of sort/group configs.

use std::cmp::Ordering;
use std::collections::HashSet;

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde_json::Value as Json;

use super::dates::cell_day;
use super::{FieldLookup, Kind, Row, is_cell_empty, kind_of};
use crate::cell::{NameResolver, display_text, format_general_number, string_items, to_value};
use crate::field::{DateOptions, Field, FieldKind};
use crate::limits::{MAX_GROUPS, MAX_SORTS};
use crate::value::Value;
use crate::view::{Direction, Sort};

/// A precomputed sort key for one cell. Keys of the same field compare with
/// [`Ord`]: `Blank` first, then values by type. Text uses a case-insensitive
/// natural order ("z2" < "z11").
#[derive(Debug, Clone)]
pub enum SortKey {
    Blank,
    Bool(bool),
    Number(f64),
    /// Milliseconds since the Unix epoch.
    Instant(i64),
    Text(Vec<Chunk>),
    /// Choice positions in the field's options (selects).
    Choices(Vec<usize>),
    /// Element keys of a computed array.
    List(Vec<SortKey>),
}

/// A run of digits (compared numerically) or of other characters
/// (compared lowercased) in a natural-order text key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Digits(String),
    Other(String),
}

impl SortKey {
    fn rank(&self) -> u8 {
        match self {
            SortKey::Blank => 0,
            SortKey::Bool(_) => 1,
            SortKey::Number(_) => 2,
            SortKey::Instant(_) => 3,
            SortKey::Text(_) => 4,
            SortKey::Choices(_) => 5,
            SortKey::List(_) => 6,
        }
    }

    pub fn is_blank(&self) -> bool {
        matches!(self, SortKey::Blank)
    }
}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (SortKey::Bool(a), SortKey::Bool(b)) => a.cmp(b),
            (SortKey::Number(a), SortKey::Number(b)) => a.total_cmp(b),
            (SortKey::Instant(a), SortKey::Instant(b)) => a.cmp(b),
            (SortKey::Text(a), SortKey::Text(b)) => cmp_chunks(a, b),
            (SortKey::Choices(a), SortKey::Choices(b)) => a
                .first()
                .cmp(&b.first())
                .then(a.len().cmp(&b.len()))
                .then_with(|| a.cmp(b)),
            (SortKey::List(a), SortKey::List(b)) => a.cmp(b),
            _ => self.rank().cmp(&other.rank()),
        }
    }
}

impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for SortKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for SortKey {}

fn cmp_chunks(a: &[Chunk], b: &[Chunk]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let o = match (x, y) {
            (Chunk::Digits(p), Chunk::Digits(q)) => p.len().cmp(&q.len()).then_with(|| p.cmp(q)),
            (Chunk::Other(p), Chunk::Other(q)) => p.cmp(q),
            (Chunk::Digits(_), Chunk::Other(_)) => Ordering::Less,
            (Chunk::Other(_), Chunk::Digits(_)) => Ordering::Greater,
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

/// Split text into natural-order chunks (lowercased; digit runs without
/// leading zeros). Empty text → `Blank`.
fn text_key(s: &str) -> SortKey {
    if s.trim().is_empty() {
        return SortKey::Blank;
    }
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut digits = false;
    let flush = |cur: &mut String, digits: bool, chunks: &mut Vec<Chunk>| {
        if cur.is_empty() {
            return;
        }
        if digits {
            let trimmed = cur.trim_start_matches('0');
            chunks.push(Chunk::Digits(if trimmed.is_empty() {
                "0".into()
            } else {
                trimmed.into()
            }));
        } else {
            chunks.push(Chunk::Other(cur.to_lowercase()));
        }
        cur.clear();
    };
    for c in s.chars() {
        let d = c.is_ascii_digit();
        if d != digits {
            flush(&mut cur, digits, &mut chunks);
            digits = d;
        }
        cur.push(c);
    }
    flush(&mut cur, digits, &mut chunks);
    SortKey::Text(chunks)
}

fn day_millis(d: NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0)
        .map_or(0, |t| t.and_utc().timestamp_millis())
}

fn value_key(v: &Value, tz: Tz, opts: Option<&DateOptions>) -> SortKey {
    match v {
        Value::Null | Value::Error(_) => SortKey::Blank,
        Value::Text(s) => text_key(s),
        Value::Number(n) if n.is_finite() => SortKey::Number(*n),
        Value::Number(_) => SortKey::Blank,
        Value::Bool(b) => SortKey::Bool(*b),
        Value::Date(d) => {
            // Midnight in the display zone so dates interleave with instants.
            let zone = opts.map(|o| crate::cell::field_zone(o, tz)).unwrap_or(tz);
            let millis = d
                .and_hms_opt(0, 0, 0)
                .and_then(|l| crate::cell::parse::local_to_utc(l, zone))
                .map_or_else(|| day_millis(*d), |i| i.timestamp_millis());
            SortKey::Instant(millis)
        }
        Value::DateTime(i) => SortKey::Instant(i.timestamp_millis()),
        Value::Array(items) => {
            let keys: Vec<SortKey> = items
                .iter()
                .map(|i| value_key(i, tz, opts))
                .filter(|k| !k.is_blank())
                .collect();
            if keys.is_empty() {
                SortKey::Blank
            } else {
                SortKey::List(keys)
            }
        }
    }
}

fn choice_positions(field: &Field, stored: Option<&Json>) -> Vec<usize> {
    let choices = match &field.kind {
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => &o.choices,
        _ => return Vec::new(),
    };
    stored
        .map(|j| {
            string_items(j)
                .filter_map(|id| choices.iter().position(|c| c.id == id))
                .collect()
        })
        .unwrap_or_default()
}

/// Item names joined with ", " (no quoting, unlike display text, so a name
/// containing a comma doesn't sort by its quote character).
fn names_text(v: &Value) -> String {
    match v {
        Value::Text(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| match i {
                Value::Text(s) => Some(s.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

/// The sort key of one cell. Text sorts naturally and case-insensitively;
/// numbers numerically; dates chronologically; single selects by choice
/// order; multiple selects by first choice's order, then count; checkboxes
/// false < true; links, users and attachments by display text.
pub fn sort_key(field: &Field, stored: Option<&Json>, names: &dyn NameResolver, tz: Tz) -> SortKey {
    let stored = stored.filter(|j| !j.is_null());
    match kind_of(field) {
        Kind::Text => text_key(&display_text(field, stored, names, tz)),
        Kind::Link | Kind::User { .. } | Kind::Attachment => {
            text_key(&names_text(&to_value(field, stored, names)))
        }
        Kind::Bool if matches!(field.kind, FieldKind::Checkbox(_)) => {
            SortKey::Bool(matches!(stored, Some(Json::Bool(true))))
        }
        Kind::Select | Kind::MultiSelect => {
            let pos = choice_positions(field, stored);
            if pos.is_empty() {
                SortKey::Blank
            } else {
                SortKey::Choices(pos)
            }
        }
        Kind::Inert => SortKey::Blank,
        Kind::Number | Kind::Bool | Kind::Date | Kind::List => value_key(
            &to_value(field, stored, names),
            tz,
            crate::cell::date_options_of(field).as_ref(),
        ),
    }
}

/// Compare two cells of `field` in ascending order (blanks first).
pub fn compare(
    field: &Field,
    a: Option<&Json>,
    b: Option<&Json>,
    names: &dyn NameResolver,
    tz: Tz,
) -> Ordering {
    sort_key(field, a, names, tz).cmp(&sort_key(field, b, names, tz))
}

/// Per-row composite key: (key, descending) per level.
struct RowKey(Vec<(SortKey, bool)>);

impl Ord for RowKey {
    fn cmp(&self, other: &Self) -> Ordering {
        for ((a, desc), (b, _)) in self.0.iter().zip(&other.0) {
            let o = a.cmp(b);
            let o = if *desc { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for RowKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for RowKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for RowKey {}

enum Level<'a> {
    Sort(&'a Field, bool),
    Group(&'a Field, bool),
}

fn sort_by_levels<R: Row>(rows: &mut [R], levels: &[Level<'_>], names: &dyn NameResolver, tz: Tz) {
    if levels.is_empty() {
        return;
    }
    rows.sort_by_cached_key(|row| {
        RowKey(
            levels
                .iter()
                .map(|level| match level {
                    Level::Sort(f, desc) => (sort_key(f, row.get(&f.id), names, tz), *desc),
                    Level::Group(f, desc) => (group_key(f, row.get(&f.id), names, tz).sort, *desc),
                })
                .collect(),
        )
    });
}

fn levels<'a, F: FieldLookup + ?Sized>(
    specs: &[Sort],
    fields: &'a F,
    group: bool,
) -> Vec<Level<'a>> {
    specs
        .iter()
        .filter_map(|s| {
            let f = fields.field(&s.field_id)?;
            let desc = s.direction == Direction::Desc;
            Some(if group {
                Level::Group(f, desc)
            } else {
                Level::Sort(f, desc)
            })
        })
        .collect()
}

/// Sort rows by `sorts` (first sort is the primary key). The sort is stable:
/// ties keep the input order, which the caller passes as manual position.
/// Sorts on unknown fields are skipped (validate first with
/// [`validate_sorts`]).
pub fn sort_rows<R: Row, F: FieldLookup + ?Sized>(
    rows: &mut [R],
    sorts: &[Sort],
    fields: &F,
    names: &dyn NameResolver,
    tz: Tz,
) {
    sort_by_levels(rows, &levels(sorts, fields, false), names, tz);
}

/// Sort rows for a grouped view: by each group level's [`GroupKey`] (in the
/// group's direction), then by `sorts`, then input order. Feed the result to
/// [`group_spans`].
pub fn sort_rows_with_groups<R: Row, F: FieldLookup + ?Sized>(
    rows: &mut [R],
    groups: &[Sort],
    sorts: &[Sort],
    fields: &F,
    names: &dyn NameResolver,
    tz: Tz,
) {
    let mut all = levels(groups, fields, true);
    all.extend(levels(sorts, fields, false));
    sort_by_levels(rows, &all, names, tz);
}

/// Identity, label and ordering of the group a cell falls into.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupKey {
    /// Stable identity: choice id(s), record/user ids, `YYYY-MM-DD` day,
    /// canonical number, `"true"`/`"false"`, exact text, or `""` for the
    /// empty group.
    pub key: String,
    /// Human label (`"(Empty)"` for the empty group).
    pub label: String,
    /// Single select choice colour, when grouping by a single select.
    pub color: Option<String>,
    pub empty: bool,
    /// Orders groups (with the group's direction).
    pub sort: SortKey,
}

/// Label of the empty group.
pub const EMPTY_GROUP_LABEL: &str = "(Empty)";

/// The group of one cell. Multi-valued fields group by their exact
/// combination (multiple selects order-insensitively, by choice order;
/// links/users/attachments in stored order); date-times group by calendar
/// day in the field zone (else `tz`); empty cells form one `(Empty)` group
/// (checkboxes group as Checked/Unchecked instead).
pub fn group_key(
    field: &Field,
    stored: Option<&Json>,
    names: &dyn NameResolver,
    tz: Tz,
) -> GroupKey {
    let stored = stored.filter(|j| !j.is_null());
    let kind = kind_of(field);
    if let FieldKind::Checkbox(_) = field.kind {
        let checked = matches!(stored, Some(Json::Bool(true)));
        return GroupKey {
            key: checked.to_string(),
            label: if checked { "Checked" } else { "Unchecked" }.into(),
            color: None,
            empty: false,
            sort: SortKey::Bool(checked),
        };
    }
    let empty = GroupKey {
        key: String::new(),
        label: EMPTY_GROUP_LABEL.into(),
        color: None,
        empty: true,
        sort: SortKey::Blank,
    };
    if kind == Kind::Inert || is_cell_empty(field, stored) {
        return empty;
    }
    let label = || display_text(field, stored, names, tz);
    match (&field.kind, kind) {
        (FieldKind::SingleSelect(o), _) => {
            let Some(id) = stored.and_then(Json::as_str) else {
                return empty;
            };
            match o.choices.iter().position(|c| c.id == id) {
                Some(i) => GroupKey {
                    key: id.to_string(),
                    label: o.choices[i].name.clone(),
                    color: Some(o.choices[i].color.clone()),
                    empty: false,
                    sort: SortKey::Choices(vec![i]),
                },
                None => empty,
            }
        }
        (FieldKind::MultipleSelect(o), _) => {
            let mut pos = choice_positions(field, stored);
            pos.sort_unstable();
            pos.dedup();
            if pos.is_empty() {
                return empty;
            }
            let ids: Vec<&str> = pos.iter().map(|&i| o.choices[i].id.as_str()).collect();
            let label_names: Vec<&str> = pos.iter().map(|&i| o.choices[i].name.as_str()).collect();
            GroupKey {
                key: ids.join(","),
                label: crate::cell::parse::join_list(&label_names),
                color: None,
                empty: false,
                sort: SortKey::Choices(pos),
            }
        }
        (_, Kind::Date) => match cell_day(field, stored, tz) {
            Some(day) => {
                let opts = DateOptions {
                    include_time: false,
                    ..crate::cell::date_options_of(field).unwrap_or_default()
                };
                GroupKey {
                    key: day.format("%Y-%m-%d").to_string(),
                    label: crate::cell::format_date_value(&Value::Date(day), &opts, tz),
                    color: None,
                    empty: false,
                    sort: SortKey::Instant(day_millis(day)),
                }
            }
            None => GroupKey {
                key: "#error".into(),
                label: label(),
                color: None,
                empty: false,
                sort: SortKey::Blank,
            },
        },
        (FieldKind::Attachment(_), _) => {
            let ids: Vec<&str> = match stored {
                Some(Json::Array(items)) => items
                    .iter()
                    .filter_map(|a| a.get("id").and_then(Json::as_str))
                    .collect(),
                _ => Vec::new(),
            };
            let label = label();
            GroupKey {
                key: ids.join(","),
                sort: text_key(&names_text(&to_value(field, stored, names))),
                label,
                color: None,
                empty: false,
            }
        }
        (_, Kind::Link | Kind::User { .. }) => {
            let ids: Vec<&str> = stored
                .map(|j| string_items(j).collect())
                .unwrap_or_default();
            let label = label();
            GroupKey {
                key: ids.join(","),
                sort: text_key(&names_text(&to_value(field, stored, names))),
                label,
                color: None,
                empty: false,
            }
        }
        (_, Kind::Number) => {
            let sort = sort_key(field, stored, names, tz);
            let key = match &sort {
                SortKey::Number(n) => format_general_number(*n),
                _ => "#error".into(),
            };
            GroupKey {
                key,
                label: label(),
                color: None,
                empty: false,
                sort,
            }
        }
        (_, Kind::List) => GroupKey {
            key: stored.map(Json::to_string).unwrap_or_default(),
            label: label(),
            color: None,
            empty: false,
            sort: sort_key(field, stored, names, tz),
        },
        _ => {
            let label = label();
            GroupKey {
                key: label.clone(),
                sort: sort_key(field, stored, names, tz),
                label,
                color: None,
                empty: false,
            }
        }
    }
}

/// One group header in a grouped result, in pre-order (a group is listed
/// before its sub-groups). `start..start + count` indexes the sorted rows.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupSpan {
    /// 0 for the outermost group level.
    pub level: usize,
    pub key: GroupKey,
    /// Keys of this group and its ancestors, outermost first (a stable id
    /// for collapsed-state tracking).
    pub path: Vec<String>,
    pub start: usize,
    pub count: usize,
}

/// Group headers for rows already ordered by [`sort_rows_with_groups`] with
/// the same `groups`. Group levels on unknown fields are skipped.
pub fn group_spans<R: Row, F: FieldLookup + ?Sized>(
    rows: &[R],
    groups: &[Sort],
    fields: &F,
    names: &dyn NameResolver,
    tz: Tz,
) -> Vec<GroupSpan> {
    let group_fields: Vec<&Field> = groups
        .iter()
        .filter_map(|g| fields.field(&g.field_id))
        .collect();
    let mut spans: Vec<GroupSpan> = Vec::new();
    // Index into `spans` of the open group at each level.
    let mut open: Vec<usize> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let keys: Vec<GroupKey> = group_fields
            .iter()
            .map(|f| group_key(f, row.get(&f.id), names, tz))
            .collect();
        // First level whose key differs from the open group's.
        let first_change = (0..keys.len())
            .find(|&l| open.get(l).is_none_or(|&s| spans[s].key.key != keys[l].key))
            .unwrap_or(keys.len());
        open.truncate(first_change);
        for (level, key) in keys.into_iter().enumerate().skip(first_change) {
            let mut path: Vec<String> = open.iter().map(|&s| spans[s].key.key.clone()).collect();
            path.push(key.key.clone());
            spans.push(GroupSpan {
                level,
                key,
                path,
                start: i,
                count: 0,
            });
            open.push(spans.len() - 1);
        }
        for &s in &open {
            spans[s].count += 1;
        }
    }
    spans
}

fn validate_levels<F: FieldLookup + ?Sized>(
    specs: &[Sort],
    fields: &F,
    max: usize,
    what: &str,
) -> Result<(), String> {
    if specs.len() > max {
        return Err(format!("a view can have at most {max} {what}s"));
    }
    let mut seen = HashSet::new();
    for s in specs {
        let field = fields
            .field(&s.field_id)
            .ok_or_else(|| format!("{what} refers to unknown field {}", s.field_id))?;
        if kind_of(field) == Kind::Inert {
            return Err(format!(
                "cannot {what} by \"{}\" ({})",
                field.name,
                field.field_type().label()
            ));
        }
        if !seen.insert(s.field_id.as_str()) {
            return Err(format!(
                "\"{}\" is used in more than one {what}",
                field.name
            ));
        }
    }
    Ok(())
}

/// Validate view sorts: at most `limits::MAX_SORTS`, existing sortable
/// fields, each field at most once.
pub fn validate_sorts<F: FieldLookup + ?Sized>(sorts: &[Sort], fields: &F) -> Result<(), String> {
    validate_levels(sorts, fields, MAX_SORTS, "sort")
}

/// Validate view groups: at most `limits::MAX_GROUPS` levels, existing
/// groupable fields, each field at most once.
pub fn validate_groups<F: FieldLookup + ?Sized>(groups: &[Sort], fields: &F) -> Result<(), String> {
    validate_levels(groups, fields, MAX_GROUPS, "group")
}
