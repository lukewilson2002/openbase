//! Group-by aggregation of a table's records: the shared core of `POST /api/tables/{id}/aggregate`
//! and the MCP `aggregate_records` tool.
//!
//! Records are selected like listing them (`view` and/or `filter_by_formula`, the same code and
//! the same permission checks as [`super::records::list_for`]), then grouped and aggregated by
//! [`crate::engine::aggregate`] in one pass over the database. This module resolves field names,
//! rejects combinations that make no sense (a sum of text, a group by a button, two aggregates
//! with the same key) with messages that say what would work, and shapes the answer.

use std::collections::HashSet;
use std::sync::Arc;

use axum::http::StatusCode;
use chrono_tz::Tz;
use ob_core::api::records::{
    AggregateFunction as Func, AggregateGroup, AggregateRequest, AggregateResponse, QueryRequest,
};
use ob_core::field::Field;
use ob_core::limits::MAX_GROUPS;
use ob_core::query::aggregations_for;
use ob_core::view::Aggregation;
use rusqlite::Connection;

use crate::auth::Actor;
use crate::engine::aggregate::{self, Measure, Order, OrderKey};
use crate::engine::query::{self, QueryCache};
use crate::engine::write::user_timezone;
use crate::perm::Role;
use crate::state::AppState;
use crate::store::versions::DataVersions;
use crate::v1::error::{V1Error, V1Result};
use crate::v1::input::FieldIndex;
use crate::v1::records::{
    FORMULA_TIME_BUDGET, all_records_view, filter_by_formula, find_view, resolve_table,
};

/// Groups returned when the request names no `limit`, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 1000;
pub const MAX_LIMIT: usize = 10_000;
/// Aggregates per request.
pub const MAX_AGGREGATES: usize = 20;
/// Longest alias, in characters.
const MAX_ALIAS: usize = 100;
/// Names listed in a "valid fields" hint.
const HINT_FIELDS: usize = 20;

fn type_name(f: &Field) -> String {
    serde_json::to_value(&f.kind)
        .ok()
        .and_then(|k| k.get("type").and_then(|t| t.as_str().map(str::to_string)))
        .unwrap_or_else(|| "unknown".into())
}

fn func_name(f: Func) -> &'static str {
    match f {
        Func::Count => "count",
        Func::Sum => "sum",
        Func::Avg => "avg",
        Func::Min => "min",
        Func::Max => "max",
    }
}

/// Names of the fields of the table that satisfy `ok`, for a hint.
fn fields_where(fields: &[Field], ok: impl Fn(&Field) -> bool) -> String {
    let names: Vec<String> = fields
        .iter()
        .filter(|f| ok(f))
        .map(|f| format!("\"{}\"", f.name))
        .collect();
    if names.is_empty() {
        return "this table has none".into();
    }
    let mut shown = names
        .iter()
        .take(HINT_FIELDS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > HINT_FIELDS {
        shown.push_str(&format!(", ... ({} more)", names.len() - HINT_FIELDS));
    }
    shown
}

fn is_numeric(f: &Field) -> bool {
    aggregations_for(f).contains(&Aggregation::Sum)
}

fn is_date(f: &Field) -> bool {
    aggregations_for(f).contains(&Aggregation::EarliestDate)
}

/// A request resolved against the table's fields.
struct Plan {
    group_fields: Vec<Field>,
    measures: Vec<Measure>,
    order: Vec<Order>,
    limit: usize,
}

fn plan(fields: &[Field], req: &AggregateRequest) -> V1Result<Plan> {
    let index = FieldIndex::new(fields);

    if req.group_by.len() > MAX_GROUPS {
        return Err(V1Error::invalid(format!(
            "group_by can name at most {MAX_GROUPS} fields (got {})",
            req.group_by.len()
        )));
    }
    let mut group_fields: Vec<Field> = Vec::new();
    for key in &req.group_by {
        let f = index.require(key)?;
        if aggregations_for(f).len() <= 1 {
            return Err(V1Error::invalid(format!(
                "Cannot group by \"{}\": {} fields have no values to group by. Groupable fields: {}.",
                f.name,
                type_name(f),
                fields_where(fields, |f| aggregations_for(f).len() > 1)
            )));
        }
        if group_fields.iter().any(|g| g.id == f.id) {
            return Err(V1Error::invalid(format!(
                "group_by names \"{}\" more than once",
                f.name
            )));
        }
        group_fields.push(f.clone());
    }

    let specs = if req.aggregates.is_empty() {
        vec![ob_core::api::records::AggregateSpec {
            function: Func::Count,
            field: None,
            alias: None,
        }]
    } else {
        req.aggregates.clone()
    };
    if specs.len() > MAX_AGGREGATES {
        return Err(V1Error::invalid(format!(
            "at most {MAX_AGGREGATES} aggregates are allowed (got {})",
            specs.len()
        )));
    }
    let mut measures: Vec<Measure> = Vec::new();
    let mut aliases: HashSet<String> = HashSet::new();
    for spec in &specs {
        let func = spec.function;
        let field = match spec.field.as_deref().filter(|f| !f.is_empty()) {
            Some(key) => Some(index.require(key)?.clone()),
            None => None,
        };
        match (func, &field) {
            (Func::Count, None) => {}
            (Func::Count, Some(f)) => {
                let a = aggregations_for(f);
                if !a.contains(&Aggregation::Filled) && !a.contains(&Aggregation::Checked) {
                    return Err(V1Error::invalid(format!(
                        "Cannot count \"{}\": {} fields cannot be counted. Leave `field` out to count records.",
                        f.name,
                        type_name(f)
                    )));
                }
            }
            (_, None) => {
                return Err(V1Error::invalid(format!(
                    "{} needs a `field`; only count can run without one",
                    func_name(func)
                )));
            }
            (Func::Sum | Func::Avg, Some(f)) if !is_numeric(f) => {
                return Err(V1Error::invalid(format!(
                    "Cannot {} \"{}\": it is a {} field, and {} needs a number field \
                     (number, currency, percent, duration, rating, autonumber, count, or a \
                     formula, rollup or lookup that returns a number). Number fields: {}.",
                    func_name(func),
                    f.name,
                    type_name(f),
                    func_name(func),
                    fields_where(fields, is_numeric)
                )));
            }
            (Func::Min | Func::Max, Some(f)) if !is_numeric(f) && !is_date(f) => {
                return Err(V1Error::invalid(format!(
                    "Cannot take the {} of \"{}\": it is a {} field, and {} works on number and \
                     date fields. Number and date fields: {}.",
                    func_name(func),
                    f.name,
                    type_name(f),
                    func_name(func),
                    fields_where(fields, |f| is_numeric(f) || is_date(f))
                )));
            }
            _ => {}
        }
        let alias = match spec
            .alias
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
        {
            Some(a) => a.to_string(),
            None => match &field {
                Some(f) => format!("{}_{}", func_name(func), f.name),
                None => func_name(func).to_string(),
            },
        };
        if alias.chars().count() > MAX_ALIAS {
            return Err(V1Error::invalid(format!(
                "an alias is at most {MAX_ALIAS} characters"
            )));
        }
        if !aliases.insert(alias.clone()) {
            return Err(V1Error::invalid(format!(
                "two aggregates would be called \"{alias}\"; give one of them a different `alias`"
            )));
        }
        measures.push(Measure { alias, func, field });
    }

    let mut order = Vec::new();
    for s in &req.sort {
        let key = if let Some(i) = measures.iter().position(|m| m.alias == s.by) {
            OrderKey::Measure(i)
        } else if let Some(i) = group_fields
            .iter()
            .position(|f| f.id == s.by || f.name == s.by)
        {
            OrderKey::Group(i)
        } else {
            let mut valid: Vec<String> = measures
                .iter()
                .map(|m| format!("\"{}\"", m.alias))
                .collect();
            valid.extend(group_fields.iter().map(|f| format!("\"{}\"", f.name)));
            return Err(V1Error::invalid(format!(
                "Cannot sort by \"{}\": sort `by` an aggregate alias or a group_by field. Valid: {}.",
                s.by,
                valid.join(", ")
            )));
        };
        order.push(Order {
            key,
            direction: s.direction,
        });
    }

    let limit = match req.limit {
        None => DEFAULT_LIMIT,
        Some(n) if (1..=MAX_LIMIT).contains(&n) => n,
        Some(_) => {
            return Err(V1Error::invalid(format!(
                "limit must be between 1 and {MAX_LIMIT}"
            )));
        }
    };
    Ok(Plan {
        group_fields,
        measures,
        order,
        limit,
    })
}

/// [`aggregate_for`] on a connection: `actor` needs at least the viewer role on the base.
pub fn aggregate_in(
    conn: &Connection,
    cache: &Arc<QueryCache>,
    versions: &DataVersions,
    actor: &Actor,
    base_id: &str,
    table_ref: &str,
    req: AggregateRequest,
) -> V1Result<AggregateResponse> {
    let (table, fields) = resolve_table(conn, actor, base_id, table_ref, Role::Viewer)?;
    let plan = plan(&fields, &req)?;
    let tz: Tz = match req
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(name) => name.parse().map_err(|_| {
            V1Error::invalid(format!("timezone \"{name}\" is not a valid IANA time zone"))
        })?,
        None => user_timezone(conn, &actor.user_id),
    };
    let formula = req
        .filter_by_formula
        .as_deref()
        .filter(|f| !f.trim().is_empty());
    let view_name = req.view.as_deref().filter(|v| !v.is_empty());
    let view = view_name
        .map(|v| find_view(conn, actor, &table, v))
        .transpose()?;

    // The records a view and/or a formula keep; otherwise every live record (streamed).
    let ids: Option<Vec<String>> = if view.is_some() || formula.is_some() {
        let standin;
        let view_ref = match &view {
            Some(v) => v,
            None => {
                standin = all_records_view(&table);
                &standin
            }
        };
        let q = QueryRequest {
            timezone: req.timezone.clone().filter(|t| !t.trim().is_empty()),
            ..Default::default()
        };
        let entry = query::query_ids(conn, cache, versions, &actor.user_id, view_ref, &q)?;
        Some(match formula {
            Some(text) => filter_by_formula(
                conn,
                &table,
                &fields,
                text,
                &entry.ids,
                tz,
                FORMULA_TIME_BUDGET,
            )?,
            None => entry.ids.clone(),
        })
    } else {
        None
    };

    let grouped = aggregate::run(
        conn,
        &table.id,
        ids.as_deref(),
        &plan.group_fields,
        &plan.measures,
        &plan.order,
        plan.limit,
        tz,
    )?;
    let groups = grouped
        .groups
        .into_iter()
        .map(|g| AggregateGroup {
            group: plan
                .group_fields
                .iter()
                .map(|f| f.name.clone())
                .zip(g.values)
                .collect(),
            aggregates: plan
                .measures
                .iter()
                .map(|m| m.alias.clone())
                .zip(g.aggregates)
                .collect(),
        })
        .collect();
    Ok(AggregateResponse {
        group_by: plan.group_fields.iter().map(|f| f.name.clone()).collect(),
        groups,
        total_groups: grouped.total_groups,
        truncated: grouped.total_groups > plan.limit,
        record_count: grouped.record_count,
    })
}

/// Group and aggregate the records of a table for `actor`, with the same permission checks,
/// view and `filterByFormula` handling as listing records.
pub async fn aggregate_for(
    state: &AppState,
    actor: Actor,
    base_id: String,
    table_ref: String,
    req: AggregateRequest,
) -> V1Result<AggregateResponse> {
    let cache = state.query_cache.clone();
    let versions = state.events.versions().clone();
    state
        .db
        .read_as(move |conn| {
            aggregate_in(conn, &cache, &versions, &actor, &base_id, &table_ref, req)
        })
        .await
}

/// The error of [`aggregate_in`] as the internal API reports it.
pub fn app_error(e: V1Error) -> crate::error::AppError {
    use crate::error::AppError;
    match e.status {
        StatusCode::NOT_FOUND => AppError::not_found(
            e.message
                .strip_suffix(" not found")
                .unwrap_or(&e.message)
                .to_string(),
        ),
        StatusCode::FORBIDDEN => AppError::forbidden(e.message),
        StatusCode::UNAUTHORIZED => AppError::Unauthorized,
        StatusCode::TOO_MANY_REQUESTS => AppError::TooManyRequests,
        s if s.is_server_error() => AppError::internal(e.message),
        _ => AppError::bad_request(e.message),
    }
}
