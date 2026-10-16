//! Group-by aggregation: count, sum, avg, min and max per group over a table's records.
//!
//! The records are streamed from a read connection (all live records of the table in manual
//! order, or only the ids a view and/or formula filter kept) and folded into one small
//! accumulator per group and aggregate, so memory is proportional to the number of *groups*, not
//! to the number of records, and nothing is sent to the client but the groups.
//!
//! Groups are identified exactly like the grid's grouping (`ob_core::query::group_key`): a
//! select by choice, links and users by their record/user ids (so two linked records with the
//! same name stay two groups), a multiple select by its set of choices, dates by calendar day in
//! the caller's time zone, numbers by value, text by its exact text and empty cells together.
//! Each group is *reported* with names, never ids: see [`group_value`].
//!
//! This module does no validation of field types; `v1::aggregate` resolves the request against
//! the table's fields (and rejects sums of text, groups by buttons, ...) and builds the
//! [`Measure`]s.

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono_tz::Tz;
use ob_core::api::records::AggregateFunction as Func;
use ob_core::cell::{NoNames, to_value};
use ob_core::field::{Field, FieldKind};
use ob_core::query::{GroupKey, OwnedRow, Row, SortKey, group_key, is_cell_empty};
use ob_core::value::Value;
use ob_core::view::Direction;
use rusqlite::Connection;
use serde_json::Value as Json;

use super::query::{Needed, eval_row, scan_rows};
use crate::error::AppResult;
use crate::store::links::NameCache;
use crate::store::records::{self, RecordRow};

/// Records read per database round trip when the ids are given.
const ID_CHUNK: usize = 500;

/// One aggregate to compute per group.
#[derive(Debug, Clone)]
pub struct Measure {
    pub alias: String,
    pub func: Func,
    /// The field aggregated; `None` only for a plain `count`.
    pub field: Option<Field>,
}

/// What orders the groups.
#[derive(Debug, Clone, Copy)]
pub enum OrderKey {
    /// The n-th group-by field.
    Group(usize),
    /// The n-th measure.
    Measure(usize),
}

#[derive(Debug, Clone, Copy)]
pub struct Order {
    pub key: OrderKey,
    pub direction: Direction,
}

/// One group of the result.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupRow {
    /// One value per group-by field, in order (see [`group_value`]).
    pub values: Vec<Json>,
    /// One value per measure, in order.
    pub aggregates: Vec<Json>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grouped {
    /// The groups after sorting and `limit`.
    pub groups: Vec<GroupRow>,
    /// Groups before `limit`.
    pub total_groups: usize,
    /// Records that matched.
    pub record_count: usize,
}

/// Running state of one aggregate in one group.
#[derive(Default)]
struct Acc {
    /// Records seen.
    rows: u64,
    /// Records with a non-empty value (for `count` of a field).
    filled: u64,
    /// Numbers seen.
    numbers: u64,
    sum: f64,
    min: f64,
    max: f64,
    earliest: Option<(i64, Value)>,
    latest: Option<(i64, Value)>,
}

impl Acc {
    fn add(&mut self, m: &Measure, stored: Option<&Json>) {
        self.rows += 1;
        let Some(field) = &m.field else { return };
        match m.func {
            Func::Count => {
                if !is_cell_empty(field, stored) {
                    self.filled += 1;
                }
            }
            Func::Sum | Func::Avg | Func::Min | Func::Max => {
                match to_value(field, stored, &NoNames) {
                    Value::Number(n) if n.is_finite() => {
                        if self.numbers == 0 {
                            self.min = n;
                            self.max = n;
                        } else {
                            self.min = self.min.min(n);
                            self.max = self.max.max(n);
                        }
                        self.numbers += 1;
                        self.sum += n;
                    }
                    v @ (Value::Date(_) | Value::DateTime(_)) => {
                        let Some(at) = instant(&v) else { return };
                        if self.earliest.as_ref().is_none_or(|(e, _)| at < *e) {
                            self.earliest = Some((at, v.clone()));
                        }
                        if self.latest.as_ref().is_none_or(|(l, _)| at > *l) {
                            self.latest = Some((at, v));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn finish(&self, m: &Measure) -> Json {
        match m.func {
            Func::Count => Json::from(if m.field.is_some() {
                self.filled
            } else {
                self.rows
            }),
            Func::Sum => number(self.sum),
            Func::Avg if self.numbers > 0 => number(self.sum / self.numbers as f64),
            Func::Min => match (&self.earliest, self.numbers) {
                (Some((_, v)), _) => v.to_json(),
                (None, n) if n > 0 => number(self.min),
                _ => Json::Null,
            },
            Func::Max => match (&self.latest, self.numbers) {
                (Some((_, v)), _) => v.to_json(),
                (None, n) if n > 0 => number(self.max),
                _ => Json::Null,
            },
            Func::Avg => Json::Null,
        }
    }
}

/// Milliseconds since the epoch of a date or date-time value.
fn instant(v: &Value) -> Option<i64> {
    match v {
        Value::Date(d) => d
            .and_hms_opt(0, 0, 0)
            .map(|t| t.and_utc().timestamp_millis()),
        Value::DateTime(i) => Some(i.timestamp_millis()),
        _ => None,
    }
}

/// A number as JSON: integers as integers, sums and means cleaned of float noise
/// (`0.1 + 0.2` is `0.3`).
fn number(v: f64) -> Json {
    if !v.is_finite() {
        return Json::Null;
    }
    let v = if v.abs() < 1e9 {
        (v * 1e10).round() / 1e10
    } else {
        v
    };
    let v = if v == 0.0 { 0.0 } else { v };
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        return Json::from(v as i64);
    }
    serde_json::Number::from_f64(v)
        .map(Json::Number)
        .unwrap_or(Json::Null)
}

/// How a group is reported for the field: text, number and boolean as they are, a select as its
/// choice name, dates as `YYYY-MM-DD`, links, users and multiple selects as the array of names,
/// and the empty group as `null`. `stored` is the cell of the group's first record.
pub fn group_value(
    field: &Field,
    stored: Option<&Json>,
    key: &GroupKey,
    names: &NameCache,
) -> Json {
    if key.empty {
        return Json::Null;
    }
    match &field.kind {
        FieldKind::Checkbox(_) => return Json::Bool(key.key == "true"),
        FieldKind::SingleSelect(_) => return Json::String(key.label.clone()),
        _ => {}
    }
    match to_value(field, stored, names) {
        Value::Date(_) | Value::DateTime(_) if key.key != "#error" => Json::String(key.key.clone()),
        Value::Number(n) => number(n),
        Value::Bool(b) => Json::Bool(b),
        Value::Text(s) => Json::String(s),
        Value::Array(items) => Json::Array(items.iter().map(Value::to_json).collect()),
        Value::Null => Json::Null,
        _ => Json::String(key.label.clone()),
    }
}

struct GroupState {
    /// Identity, to break ties between groups whose sort keys are equal.
    key: String,
    values: Vec<Json>,
    sorts: Vec<SortKey>,
    accs: Vec<Acc>,
    out: Vec<Json>,
}

fn cmp_json(a: &Json, b: &Json) -> Ordering {
    fn rank(v: &Json) -> u8 {
        match v {
            Json::Null => 0,
            Json::Number(_) => 1,
            _ => 2,
        }
    }
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x
            .as_f64()
            .unwrap_or(f64::NAN)
            .total_cmp(&y.as_f64().unwrap_or(f64::NAN)),
        (Json::String(x), Json::String(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    }
}

/// Visit the records of the table as rows: those of `ids` in that order, or every live record
/// in manual order.
fn visit_rows(
    conn: &Connection,
    table_id: &str,
    ids: Option<&[String]>,
    needed: &Needed,
    names: &NameCache,
    mut visit: impl FnMut(OwnedRow),
) -> AppResult<()> {
    match ids {
        None => scan_rows(conn, table_id, needed, names, |row| {
            visit(row);
            Ok(true)
        }),
        Some(ids) => {
            for chunk in ids.chunks(ID_CHUNK) {
                let mut found: HashMap<String, RecordRow> = records::get_many(conn, chunk)?
                    .into_iter()
                    .filter(|r| r.table_id == table_id && r.is_live())
                    .map(|r| (r.id.clone(), r))
                    .collect();
                for id in chunk {
                    if let Some(row) = found.remove(id) {
                        visit(eval_row(conn, needed, row, names));
                    }
                }
            }
            Ok(())
        }
    }
}

/// Group the records and compute the measures. `ids` restricts the records (a view's and/or a
/// formula's matches); `None` takes every live record. With no `group_fields` the result is one
/// group with the totals (also for an empty table).
#[allow(clippy::too_many_arguments)]
pub fn run(
    conn: &Connection,
    table_id: &str,
    ids: Option<&[String]>,
    group_fields: &[Field],
    measures: &[Measure],
    order: &[Order],
    limit: usize,
    tz: Tz,
) -> AppResult<Grouped> {
    let names = NameCache::new(conn, tz);
    let needed = Needed::of(
        group_fields
            .iter()
            .chain(measures.iter().filter_map(|m| m.field.as_ref())),
    );
    let new_state = |key: String, values: Vec<Json>, sorts: Vec<SortKey>| GroupState {
        key,
        values,
        sorts,
        accs: measures.iter().map(|_| Acc::default()).collect(),
        out: Vec::new(),
    };
    let mut states: Vec<GroupState> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    if group_fields.is_empty() {
        states.push(new_state(String::new(), Vec::new(), Vec::new()));
        index.insert(String::new(), 0);
    }
    let mut record_count = 0usize;
    visit_rows(conn, table_id, ids, &needed, &names, |row| {
        record_count += 1;
        let keys: Vec<GroupKey> = group_fields
            .iter()
            .map(|f| group_key(f, row.get(&f.id), &names, tz))
            .collect();
        let path = keys
            .iter()
            .map(|k| k.key.as_str())
            .collect::<Vec<_>>()
            .join("\u{1f}");
        let at = match index.get(&path) {
            Some(&i) => i,
            None => {
                let values = group_fields
                    .iter()
                    .zip(&keys)
                    .map(|(f, k)| group_value(f, row.get(&f.id), k, &names))
                    .collect();
                let sorts = keys.iter().map(|k| k.sort.clone()).collect();
                states.push(new_state(path.clone(), values, sorts));
                index.insert(path, states.len() - 1);
                states.len() - 1
            }
        };
        for (acc, m) in states[at].accs.iter_mut().zip(measures) {
            acc.add(m, m.field.as_ref().and_then(|f| row.get(&f.id)));
        }
    })?;
    for s in &mut states {
        s.out = s
            .accs
            .iter()
            .zip(measures)
            .map(|(a, m)| a.finish(m))
            .collect();
    }
    states.sort_by(|a, b| {
        for o in order {
            let c = match o.key {
                OrderKey::Group(i) => a.sorts[i].cmp(&b.sorts[i]),
                OrderKey::Measure(i) => cmp_json(&a.out[i], &b.out[i]),
            };
            let c = if o.direction == Direction::Desc {
                c.reverse()
            } else {
                c
            };
            if c != Ordering::Equal {
                return c;
            }
        }
        a.sorts.cmp(&b.sorts).then_with(|| a.key.cmp(&b.key))
    });
    let total_groups = states.len();
    states.truncate(limit);
    Ok(Grouped {
        groups: states
            .into_iter()
            .map(|s| GroupRow {
                values: s.values,
                aggregates: s.out,
            })
            .collect(),
        total_groups,
        record_count,
    })
}
