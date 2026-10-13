//! Record endpoints of the Airtable-compatible API.
//!
//! - `GET    /api/v1/{baseId}/{table}` list (paging, view, fields, sort,
//!   filterByFormula, maxRecords);
//! - `GET    /api/v1/{baseId}/{table}/{recordId}`;
//! - `POST   /api/v1/{baseId}/{table}` create (batch of up to 10, or one `{fields}`);
//! - `PATCH|PUT /api/v1/{baseId}/{table}` and `/{recordId}` update (merge / replace);
//! - `DELETE /api/v1/{baseId}/{table}?records[]=` and `/{recordId}`.
//!
//! Every write goes through `engine::write` in one transaction (a batch is
//! all-or-nothing) and publishes its events after the commit.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json as AxumJson;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use og_core::api::records::{NewRecord, QueryRequest, RecordPatch, TransientConfig};
use og_core::api::schema::View;
use og_core::api::v1::{V1DeletedRecord, V1DeletedRecords, V1Record, V1Records};
use og_core::cell::to_value;
use og_core::field::Field;
use og_core::formula::{self, EvalContext};
use og_core::value::Value;
use og_core::view::{Direction, Sort, ViewConfig, ViewType};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value as Json};

use crate::auth::Actor;
use crate::engine::query::{self, CachedQuery};
use crate::engine::write::{self, CreateOpts, WriteCtx, WriteSource, user_timezone};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::fields_engine;
use crate::store::links::NameCache;
use crate::store::records::{self as record_store, RecordRow};
use crate::store::schema::{self, TableRow, ViewRow};
use crate::v1::auth::{V1Auth, V1Json, V1Pairs};
use crate::v1::cursor;
use crate::v1::error::{V1Error, V1Result};
use crate::v1::input::{FieldIndex, convert_fields};
use crate::v1::shape::{RenderOpts, render};

/// Largest `pageSize`.
pub const MAX_PAGE_SIZE: usize = 100;
/// Records per create / update / delete request.
pub const MAX_BATCH: usize = 10;
/// Records read per database round trip while filtering by formula.
const FORMULA_CHUNK: usize = 500;

// ------------------------------------------------------------- resolution

/// The table `table_ref` (an id, else an exact name) of base `base_id`,
/// after checking the caller's role on the base.
fn resolve_table(
    conn: &Connection,
    actor: &Actor,
    base_id: &str,
    table_ref: &str,
    min: Role,
) -> V1Result<(TableRow, Vec<Field>)> {
    perm::require_base(conn, actor, base_id, min)?;
    let tables = schema::live_tables(conn, base_id)?;
    let table = tables
        .iter()
        .find(|t| t.id == table_ref)
        .or_else(|| tables.iter().find(|t| t.name == table_ref))
        .cloned()
        .ok_or_else(|| V1Error::not_found("Table"))?;
    let fields = schema::table_fields(conn, &table.id)?;
    Ok((table, fields))
}

fn publish(state: &AppState, headers: &HeaderMap, actor: &Actor, outcome: &write::WriteOutcome) {
    crate::api::records::publish_outcome(state, headers, actor, outcome);
}

// ------------------------------------------------------------ parameters

/// Parsed query parameters of the list endpoint.
#[derive(Debug, Default)]
struct ListParams {
    page_size: Option<usize>,
    max_records: Option<usize>,
    offset: Option<String>,
    view: Option<String>,
    fields: Option<Vec<String>>,
    sorts: Vec<(String, Direction)>,
    filter_by_formula: Option<String>,
    /// Case-insensitive substring search over every field (not an Airtable parameter; used by
    /// the MCP `search_records` tool).
    search: Option<String>,
    link_names: bool,
    time_zone: Option<Tz>,
    by_id: bool,
}

fn parse_bool(name: &str, v: &str) -> V1Result<bool> {
    match v {
        "true" | "1" => Ok(true),
        "false" | "0" | "" => Ok(false),
        _ => Err(V1Error::invalid(format!("{name} must be true or false"))),
    }
}

fn parse_count(name: &str, v: &str, max: Option<usize>) -> V1Result<usize> {
    let n: usize = v
        .trim()
        .parse()
        .ok()
        .filter(|n| *n >= 1)
        .ok_or_else(|| V1Error::invalid(format!("{name} must be a positive integer")))?;
    match max {
        Some(max) if n > max => Err(V1Error::invalid(format!(
            "{name} must be between 1 and {max}"
        ))),
        _ => Ok(n),
    }
}

/// `sort[2][field]` -> `(2, "field")`.
fn sort_key(key: &str) -> Option<(usize, &str)> {
    let rest = key.strip_prefix("sort[")?;
    let (index, rest) = rest.split_once("][")?;
    let prop = rest.strip_suffix(']')?;
    Some((index.parse().ok()?, prop))
}

/// Parameters every read accepts: `cellFormat` (only `json`), `timeZone`,
/// `userLocale`, `returnFieldsByFieldId`.
fn read_common(pairs: &[(String, String)]) -> V1Result<(Option<Tz>, bool)> {
    let mut tz = None;
    let mut by_id = false;
    for (k, v) in pairs {
        match k.as_str() {
            "cellFormat" if v != "json" => {
                return Err(V1Error::invalid(
                    "cellFormat=string is not supported; values are always returned as JSON",
                ));
            }
            "timeZone" => {
                tz = Some(v.parse::<Tz>().map_err(|_| {
                    V1Error::invalid(format!("timeZone \"{v}\" is not a valid IANA time zone"))
                })?);
            }
            "returnFieldsByFieldId" => by_id = parse_bool(k, v)?,
            _ => {}
        }
    }
    Ok((tz, by_id))
}

impl ListParams {
    fn parse(pairs: &[(String, String)]) -> V1Result<ListParams> {
        let (time_zone, by_id) = read_common(pairs)?;
        let mut p = ListParams {
            time_zone,
            by_id,
            ..Default::default()
        };
        let mut sorts: BTreeMap<usize, (Option<String>, Direction)> = BTreeMap::new();
        for (k, v) in pairs {
            match k.as_str() {
                "pageSize" => p.page_size = Some(parse_count(k, v, Some(MAX_PAGE_SIZE))?),
                "maxRecords" => p.max_records = Some(parse_count(k, v, None)?),
                "offset" => p.offset = Some(v.clone()).filter(|o| !o.is_empty()),
                "view" => p.view = Some(v.clone()).filter(|o| !o.is_empty()),
                "filterByFormula" => {
                    p.filter_by_formula = Some(v.clone()).filter(|f| !f.trim().is_empty())
                }
                "fields[]" | "fields" => p.fields.get_or_insert_with(Vec::new).push(v.clone()),
                other => {
                    if let Some((i, prop)) = sort_key(other) {
                        let entry = sorts.entry(i).or_insert((None, Direction::Asc));
                        match prop {
                            "field" => entry.0 = Some(v.clone()),
                            "direction" => {
                                entry.1 = match v.as_str() {
                                    "asc" => Direction::Asc,
                                    "desc" => Direction::Desc,
                                    _ => {
                                        return Err(V1Error::invalid(
                                            "sort direction must be \"asc\" or \"desc\"",
                                        ));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        if sorts.len() > og_core::limits::MAX_SORTS {
            return Err(V1Error::invalid(format!(
                "at most {} sort levels are allowed",
                og_core::limits::MAX_SORTS
            )));
        }
        for (i, (field, dir)) in sorts {
            let field =
                field.ok_or_else(|| V1Error::invalid(format!("sort[{i}][field] is missing")))?;
            p.sorts.push((field, dir));
        }
        Ok(p)
    }
}

fn iterator_gone() -> V1Error {
    V1Error::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "LIST_RECORDS_ITERATOR_NOT_AVAILABLE",
        "The offset is no longer available (it expired, or the request parameters changed). \
         Start listing again without an offset.",
    )
}

fn invalid_formula(why: impl std::fmt::Display) -> V1Error {
    V1Error::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_FILTER_BY_FORMULA",
        format!("The formula for filtering records is invalid: {why}"),
    )
}

// -------------------------------------------------------------- list

/// What the list endpoint needs besides the connection.
struct ListEnv {
    cache: Arc<query::QueryCache>,
    versions: crate::store::versions::DataVersions,
    cursors: Arc<cursor::Cursors>,
    public_url: String,
}

fn dir_code(d: Direction) -> u8 {
    match d {
        Direction::Asc => 0,
        Direction::Desc => 1,
    }
}

/// A stand-in view for listings without `view`: every record in manual order.
fn all_records_view(table: &TableRow) -> ViewRow {
    ViewRow {
        view: View {
            id: format!("v1:{}", table.id),
            table_id: table.id.clone(),
            name: "All records".into(),
            view_type: ViewType::Grid,
            config: ViewConfig::default(),
            personal: false,
            locked: false,
        },
        position: 0.0,
        owner_id: None,
        deleted_at: None,
    }
}

fn find_view(
    conn: &Connection,
    actor: &Actor,
    table: &TableRow,
    wanted: &str,
) -> V1Result<ViewRow> {
    let views = schema::visible_views(conn, &table.id, &actor.user_id)?;
    views
        .iter()
        .find(|v| v.view.id == wanted)
        .or_else(|| views.iter().find(|v| v.view.name == wanted))
        .cloned()
        .ok_or_else(|| {
            V1Error::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "VIEW_NAME_NOT_FOUND",
                format!("View \"{wanted}\" was not found in this table"),
            )
        })
}

/// A record as formulas see it.
struct RowCtx<'a> {
    fields: &'a HashMap<&'a str, &'a Field>,
    row: &'a RecordRow,
    values: Map<String, Json>,
    names: &'a NameCache<'a>,
    now: DateTime<Utc>,
    tz: Tz,
}

impl EvalContext for RowCtx<'_> {
    fn field(&self, field_id: &str) -> Value {
        match self.fields.get(field_id) {
            Some(f) => to_value(f, self.values.get(field_id), self.names),
            None => Value::error("#ERROR: Unknown field"),
        }
    }
    fn record_id(&self) -> &str {
        &self.row.id
    }
    fn created_time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.row.created_at).unwrap_or(DateTime::UNIX_EPOCH)
    }
    fn last_modified_time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.row.updated_at).unwrap_or(DateTime::UNIX_EPOCH)
    }
    fn now(&self) -> DateTime<Utc> {
        self.now
    }
    fn timezone(&self) -> Tz {
        self.tz
    }
}

/// How long one list request may spend evaluating its `filterByFormula`
/// (the read connection is held for that long). Generous: a sane formula over
/// a 100,000-record table takes a second or two.
const FORMULA_TIME_BUDGET: Duration = Duration::from_secs(5);

/// The ids among `ids` (order kept) for which `formula_text` is truthy.
/// `{Field Name}` references resolve against the table's field names. Fails
/// with 422 if the evaluation takes longer than `budget`.
fn filter_by_formula(
    conn: &Connection,
    table: &TableRow,
    fields: &[Field],
    formula_text: &str,
    ids: &[String],
    tz: Tz,
    budget: Duration,
) -> V1Result<Vec<String>> {
    let (stored, _ty) = fields_engine::check_formula(fields, formula_text)
        .map_err(|e| invalid_formula(e.to_string()))?;
    let expr = formula::parse(&stored).map_err(|e| invalid_formula(e.to_string()))?;
    let by_id: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let names = NameCache::new(conn, tz);
    let now = Utc::now();
    let started = Instant::now();
    let mut kept = Vec::new();
    for chunk in ids.chunks(FORMULA_CHUNK) {
        let mut rows: HashMap<String, RecordRow> = record_store::get_many(conn, chunk)?
            .into_iter()
            .filter(|r| r.table_id == table.id && r.is_live())
            .map(|r| (r.id.clone(), r))
            .collect();
        for id in chunk {
            let Some(row) = rows.remove(id) else { continue };
            if started.elapsed() > budget {
                return Err(invalid_formula(
                    "it took too long to evaluate; use a simpler formula or a view that \
                     narrows the records first",
                ));
            }
            let ctx = RowCtx {
                fields: &by_id,
                values: record_store::full_values(conn, fields, &row, &names),
                row: &row,
                names: &names,
                now,
                tz,
            };
            if formula::eval(&expr, &ctx).truthy() {
                kept.push(id.clone());
            }
        }
    }
    Ok(kept)
}

fn list_in(
    conn: &Connection,
    env: &ListEnv,
    actor: &Actor,
    base_id: &str,
    table_ref: &str,
    p: ListParams,
) -> V1Result<V1Records> {
    let (table, fields) = resolve_table(conn, actor, base_id, table_ref, Role::Viewer)?;
    let index = FieldIndex::new(&fields);
    let only: Option<HashSet<String>> = match &p.fields {
        None => None,
        Some(names) => Some(
            names
                .iter()
                .map(|n| index.require(n).map(|f| f.id.clone()))
                .collect::<V1Result<_>>()?,
        ),
    };
    let sorts: Vec<Sort> = p
        .sorts
        .iter()
        .map(|(name, direction)| {
            index.require(name).map(|f| Sort {
                field_id: f.id.clone(),
                direction: *direction,
            })
        })
        .collect::<V1Result<_>>()?;
    let view = p
        .view
        .as_deref()
        .map(|v| find_view(conn, actor, &table, v))
        .transpose()?;
    let tz = p
        .time_zone
        .unwrap_or_else(|| user_timezone(conn, &actor.user_id));

    // What the id list depends on; an offset is only valid for the same query.
    let fingerprint = {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        table.id.hash(&mut h);
        view.as_ref().map(|v| &v.view.id).hash(&mut h);
        for s in &sorts {
            (&s.field_id, dir_code(s.direction)).hash(&mut h);
        }
        p.filter_by_formula.hash(&mut h);
        p.search.hash(&mut h);
        p.max_records.hash(&mut h);
        p.time_zone.map(|t| t.name()).hash(&mut h);
        h.finish()
    };

    let (snapshot_id, snapshot, start) = match &p.offset {
        Some(offset) => {
            let (sid, start) = cursor::decode(offset).ok_or_else(iterator_gone)?;
            let snapshot = env
                .cursors
                .get(&sid, &actor.user_id, &table.id, fingerprint)
                .ok_or_else(iterator_gone)?;
            if start > snapshot.ids.len() {
                return Err(iterator_gone());
            }
            (Some(sid), snapshot, start)
        }
        None => {
            let standin;
            let view_ref = match &view {
                Some(v) => v,
                None => {
                    standin = all_records_view(&table);
                    &standin
                }
            };
            let req = QueryRequest {
                transient: (!sorts.is_empty()).then(|| TransientConfig {
                    sorts: Some(sorts.clone()),
                    ..Default::default()
                }),
                timezone: p.time_zone.map(|t| t.name().to_string()),
                search: p.search.clone(),
                ..Default::default()
            };
            let mut entry = query::query_ids(
                conn,
                &env.cache,
                &env.versions,
                &actor.user_id,
                view_ref,
                &req,
            )?;
            if let Some(text) = &p.filter_by_formula {
                let kept = filter_by_formula(
                    conn,
                    &table,
                    &fields,
                    text,
                    &entry.ids,
                    tz,
                    FORMULA_TIME_BUDGET,
                )?;
                entry = Arc::new(CachedQuery {
                    ids: kept,
                    groups: Vec::new(),
                });
            }
            if let Some(max) = p.max_records
                && entry.ids.len() > max
            {
                entry = Arc::new(CachedQuery {
                    ids: entry.ids[..max].to_vec(),
                    groups: Vec::new(),
                });
            }
            (None, entry, 0)
        }
    };

    let page_size = p.page_size.unwrap_or(MAX_PAGE_SIZE);
    let end = start.saturating_add(page_size).min(snapshot.ids.len());
    let records = record_store::load_dtos(conn, &table.id, &snapshot.ids[start..end], tz)?;
    let offset = (end < snapshot.ids.len()).then(|| {
        let sid = snapshot_id.unwrap_or_else(|| {
            env.cursors
                .create(&actor.user_id, &table.id, fingerprint, snapshot.clone())
        });
        cursor::encode(&sid, end)
    });
    let opts = RenderOpts {
        by_id: p.by_id,
        only: only.as_ref(),
        public_url: &env.public_url,
        link_names: p.link_names,
    };
    Ok(V1Records {
        records: render(conn, &fields, records, &opts),
        offset,
    })
}

/// What an in-process caller (the MCP tools) can ask of the list endpoint.
#[derive(Debug, Default)]
pub struct ListQuery {
    pub view: Option<String>,
    pub fields: Option<Vec<String>>,
    pub sorts: Vec<(String, Direction)>,
    pub filter_by_formula: Option<String>,
    pub search: Option<String>,
    /// Render linked records as `{id, name}` instead of ids.
    pub link_names: bool,
    /// Records per page; `max_records` caps the whole listing.
    pub page_size: usize,
    pub max_records: Option<usize>,
    pub offset: Option<String>,
}

/// [`list`] without HTTP: the same permission checks, view, `filterByFormula`, paging and
/// rendering, for the caller `actor`.
pub async fn list_for(
    state: &AppState,
    actor: Actor,
    base_id: String,
    table_ref: String,
    q: ListQuery,
) -> V1Result<V1Records> {
    let params = ListParams {
        page_size: Some(q.page_size.max(1)),
        max_records: q.max_records,
        offset: q.offset.filter(|o| !o.is_empty()),
        view: q.view.filter(|v| !v.is_empty()),
        fields: q.fields,
        sorts: q.sorts,
        filter_by_formula: q.filter_by_formula.filter(|f| !f.trim().is_empty()),
        search: q.search.filter(|f| !f.trim().is_empty()),
        link_names: q.link_names,
        time_zone: None,
        by_id: false,
    };
    list_with(state, actor, base_id, table_ref, params).await
}

async fn list_with(
    state: &AppState,
    actor: Actor,
    base_id: String,
    table_ref: String,
    params: ListParams,
) -> V1Result<V1Records> {
    let env = ListEnv {
        cache: state.query_cache.clone(),
        versions: state.events.versions().clone(),
        cursors: state.v1_cursors.clone(),
        public_url: state.config.public_url.clone(),
    };
    state
        .db
        .read_as(move |conn| list_in(conn, &env, &actor, &base_id, &table_ref, params))
        .await
}

pub async fn list(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    Path((base_id, table_ref)): Path<(String, String)>,
    V1Pairs(pairs): V1Pairs,
) -> V1Result<AxumJson<V1Records>> {
    let params = ListParams::parse(&pairs)?;
    let out = list_with(&state, actor, base_id, table_ref, params).await?;
    Ok(AxumJson(out))
}

/// [`get_one`] without HTTP.
pub async fn get_for(
    state: &AppState,
    actor: Actor,
    base_id: String,
    table_ref: String,
    record_id: String,
) -> V1Result<V1Record> {
    get_record(
        state, actor, base_id, table_ref, record_id, None, false, true,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn get_record(
    state: &AppState,
    actor: Actor,
    base_id: String,
    table_ref: String,
    record_id: String,
    tz: Option<Tz>,
    by_id: bool,
    link_names: bool,
) -> V1Result<V1Record> {
    let public_url = state.config.public_url.clone();
    state
        .db
        .read_as(move |conn| {
            let (table, fields) = resolve_table(conn, &actor, &base_id, &table_ref, Role::Viewer)?;
            let tz = tz.unwrap_or_else(|| user_timezone(conn, &actor.user_id));
            let found = record_store::load_dtos(conn, &table.id, &[record_id], tz)?;
            let opts = RenderOpts {
                by_id,
                only: None,
                public_url: &public_url,
                link_names,
            };
            render(conn, &fields, found, &opts)
                .pop()
                .ok_or_else(|| V1Error::not_found("Record"))
        })
        .await
}

pub async fn get_one(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    Path((base_id, table_ref, record_id)): Path<(String, String, String)>,
    V1Pairs(pairs): V1Pairs,
) -> V1Result<AxumJson<V1Record>> {
    let (tz, by_id) = read_common(&pairs)?;
    let record = get_record(
        &state, actor, base_id, table_ref, record_id, tz, by_id, false,
    )
    .await?;
    Ok(AxumJson(record))
}

// ------------------------------------------------------------- writes

#[derive(Debug, Deserialize)]
struct RecordIn {
    fields: Map<String, Json>,
}

#[derive(Debug, Deserialize)]
struct RecordUpdateIn {
    #[serde(default)]
    id: Option<String>,
    fields: Map<String, Json>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    #[serde(default)]
    records: Option<Vec<RecordIn>>,
    #[serde(default)]
    fields: Option<Map<String, Json>>,
    #[serde(default)]
    typecast: bool,
    #[serde(default, rename = "returnFieldsByFieldId")]
    return_by_id: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    #[serde(default)]
    records: Option<Vec<RecordUpdateIn>>,
    #[serde(default)]
    typecast: bool,
    #[serde(default, rename = "returnFieldsByFieldId")]
    return_by_id: bool,
    #[serde(default, rename = "performUpsert")]
    perform_upsert: Option<Json>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateOneBody {
    fields: Map<String, Json>,
    #[serde(default)]
    typecast: bool,
    #[serde(default, rename = "returnFieldsByFieldId")]
    return_by_id: bool,
}

fn check_batch(n: usize, what: &str) -> V1Result<()> {
    if n == 0 {
        return Err(V1Error::invalid(format!(
            "Send at least one record to {what}"
        )));
    }
    if n > MAX_BATCH {
        return Err(V1Error::invalid(format!(
            "You can {what} at most {MAX_BATCH} records per request"
        )));
    }
    Ok(())
}

fn editor_ctx(tx: &rusqlite::Transaction, actor: &Actor, typecast: bool) -> V1Result<WriteCtx> {
    Ok(WriteCtx::for_user(tx, &actor.user_id, WriteSource::Api)?.typecast(typecast))
}

/// Re-read and render the records `ids` after a write. The fields are loaded
/// again because `typecast` may have added select choices.
fn render_after(
    tx: &Connection,
    table_id: &str,
    ids: &[String],
    tz: Tz,
    by_id: bool,
    public_url: &str,
    link_names: bool,
) -> V1Result<Vec<V1Record>> {
    let fields = schema::table_fields(tx, table_id)?;
    let records = record_store::load_dtos(tx, table_id, ids, tz)?;
    let opts = RenderOpts {
        by_id,
        only: None,
        public_url,
        link_names,
    };
    Ok(render(tx, &fields, records, &opts))
}

/// Where a write goes: the caller, the table (by id or name) and the URL
/// attachment links are built from.
struct Target {
    actor: Actor,
    public_url: String,
    base_id: String,
    table_ref: String,
}

/// Body options shared by the write endpoints.
#[derive(Clone, Copy)]
struct Mode {
    typecast: bool,
    by_id: bool,
    /// `PUT`: clear the editable fields that are not given.
    replace: bool,
    /// Render linked records as `{id, name}` in the answer (MCP tools).
    link_names: bool,
}

fn create_in(
    tx: &rusqlite::Transaction,
    target: &Target,
    new: Vec<Map<String, Json>>,
    mode: Mode,
) -> V1Result<(write::WriteOutcome, Vec<V1Record>)> {
    let (table, fields) = resolve_table(
        tx,
        &target.actor,
        &target.base_id,
        &target.table_ref,
        Role::Editor,
    )?;
    let mut records = Vec::with_capacity(new.len());
    for given in &new {
        records.push(NewRecord {
            values: convert_fields(tx, &target.base_id, &fields, given, mode.typecast, false)?,
        });
    }
    let ctx = editor_ctx(tx, &target.actor, mode.typecast)?;
    let outcome = write::create_records(tx, &ctx, &table.id, records, &CreateOpts::default())?;
    let ids = outcome.target().created.to_vec();
    let rendered = render_after(
        tx,
        &table.id,
        &ids,
        ctx.timezone,
        mode.by_id,
        &target.public_url,
        mode.link_names,
    )?;
    Ok((outcome, rendered))
}

pub async fn create(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path((base_id, table_ref)): Path<(String, String)>,
    V1Json(body): V1Json<CreateBody>,
) -> V1Result<AxumJson<Json>> {
    let (batch, new) = match (body.records, body.fields) {
        (Some(_), Some(_)) => {
            return Err(V1Error::invalid(
                "Send either \"records\" or \"fields\", not both",
            ));
        }
        (Some(list), None) => (true, list.into_iter().map(|r| r.fields).collect::<Vec<_>>()),
        (None, Some(fields)) => (false, vec![fields]),
        (None, None) => {
            return Err(V1Error::invalid(
                "The request body needs \"records\" (a list of {\"fields\": {...}}) or \"fields\"",
            ));
        }
    };
    if batch {
        check_batch(new.len(), "create")?;
    }
    let mut rendered = create_records(
        &state,
        &headers,
        actor,
        base_id,
        table_ref,
        new,
        body.typecast,
        body.return_by_id,
        false,
    )
    .await?;
    Ok(AxumJson(records_body(batch, &mut rendered)))
}

/// Create records (`new` are `fields` objects keyed by field name or id) and publish the
/// change; the shared core of the create endpoint and the MCP `create_records` tool.
#[allow(clippy::too_many_arguments)]
pub async fn create_records(
    state: &AppState,
    headers: &HeaderMap,
    actor: Actor,
    base_id: String,
    table_ref: String,
    new: Vec<Map<String, Json>>,
    typecast: bool,
    by_id: bool,
    link_names: bool,
) -> V1Result<Vec<V1Record>> {
    let mode = Mode {
        typecast,
        by_id,
        replace: false,
        link_names,
    };
    let who = actor.clone();
    let t = target(state, actor, base_id, table_ref);
    let (outcome, rendered) = state
        .db
        .write_as(move |tx| create_in(tx, &t, new, mode))
        .await?;
    publish(state, headers, &who, &outcome);
    Ok(rendered)
}

/// `{records: [...]}` for batches, the bare record for single-record calls.
fn records_body(batch: bool, rendered: &mut Vec<V1Record>) -> Json {
    if batch {
        serde_json::to_value(V1Records {
            records: std::mem::take(rendered),
            offset: None,
        })
    } else {
        serde_json::to_value(rendered.remove(0))
    }
    .unwrap_or(Json::Null)
}

fn update_in(
    tx: &rusqlite::Transaction,
    target: &Target,
    updates: Vec<(String, Map<String, Json>)>,
    mode: Mode,
) -> V1Result<(write::WriteOutcome, Vec<V1Record>)> {
    let (table, fields) = resolve_table(
        tx,
        &target.actor,
        &target.base_id,
        &target.table_ref,
        Role::Editor,
    )?;
    let mut patches = Vec::with_capacity(updates.len());
    for (id, given) in &updates {
        patches.push(RecordPatch {
            id: id.clone(),
            values: convert_fields(
                tx,
                &target.base_id,
                &fields,
                given,
                mode.typecast,
                mode.replace,
            )?,
        });
    }
    let ids: Vec<String> = updates.iter().map(|(id, _)| id.clone()).collect();
    let ctx = editor_ctx(tx, &target.actor, mode.typecast)?;
    let outcome = write::update_records(tx, &ctx, &table.id, patches)?;
    let rendered = render_after(
        tx,
        &table.id,
        &ids,
        ctx.timezone,
        mode.by_id,
        &target.public_url,
        mode.link_names,
    )?;
    Ok((outcome, rendered))
}

/// Update records (`updates` are `(record id, fields)`); the shared core of the update
/// endpoints and the MCP `update_records` tool.
#[allow(clippy::too_many_arguments)]
pub async fn update_records(
    state: &AppState,
    headers: &HeaderMap,
    actor: Actor,
    base_id: String,
    table_ref: String,
    updates: Vec<(String, Map<String, Json>)>,
    typecast: bool,
    replace: bool,
    link_names: bool,
) -> V1Result<Vec<V1Record>> {
    let mode = Mode {
        typecast,
        by_id: false,
        replace,
        link_names,
    };
    let t = target(state, actor, base_id, table_ref);
    run_update(state, headers, t, updates, mode).await
}

async fn run_update(
    state: &AppState,
    headers: &HeaderMap,
    target: Target,
    updates: Vec<(String, Map<String, Json>)>,
    mode: Mode,
) -> V1Result<Vec<V1Record>> {
    let who = target.actor.clone();
    let (outcome, rendered) = state
        .db
        .write_as(move |tx| update_in(tx, &target, updates, mode))
        .await?;
    publish(state, headers, &who, &outcome);
    Ok(rendered)
}

async fn update_batch(
    state: AppState,
    target: Target,
    headers: HeaderMap,
    body: UpdateBody,
    replace: bool,
) -> V1Result<AxumJson<Json>> {
    if body.perform_upsert.is_some() {
        return Err(V1Error::invalid(
            "performUpsert is not supported; update records by id",
        ));
    }
    let list = body.records.ok_or_else(|| {
        V1Error::invalid("The request body needs \"records\" (a list of {\"id\", \"fields\"})")
    })?;
    check_batch(list.len(), "update")?;
    let updates = list
        .into_iter()
        .map(|r| {
            r.id.map(|id| (id, r.fields))
                .ok_or_else(|| V1Error::invalid("Every record needs an \"id\""))
        })
        .collect::<V1Result<Vec<(String, Map<String, Json>)>>>()?;
    let mode = Mode {
        typecast: body.typecast,
        by_id: body.return_by_id,
        replace,
        link_names: false,
    };
    let mut rendered = run_update(&state, &headers, target, updates, mode).await?;
    Ok(AxumJson(records_body(true, &mut rendered)))
}

async fn update_one(
    state: AppState,
    target: Target,
    headers: HeaderMap,
    record_id: String,
    body: UpdateOneBody,
    replace: bool,
) -> V1Result<AxumJson<Json>> {
    let mode = Mode {
        typecast: body.typecast,
        by_id: body.return_by_id,
        replace,
        link_names: false,
    };
    let updates = vec![(record_id, body.fields)];
    let mut rendered = run_update(&state, &headers, target, updates, mode).await?;
    Ok(AxumJson(records_body(false, &mut rendered)))
}

fn target(state: &AppState, actor: Actor, base_id: String, table_ref: String) -> Target {
    Target {
        actor,
        public_url: state.config.public_url.clone(),
        base_id,
        table_ref,
    }
}

pub async fn patch_batch(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path((base_id, table_ref)): Path<(String, String)>,
    V1Json(body): V1Json<UpdateBody>,
) -> V1Result<AxumJson<Json>> {
    let t = target(&state, actor, base_id, table_ref);
    update_batch(state, t, headers, body, false).await
}

pub async fn put_batch(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path((base_id, table_ref)): Path<(String, String)>,
    V1Json(body): V1Json<UpdateBody>,
) -> V1Result<AxumJson<Json>> {
    let t = target(&state, actor, base_id, table_ref);
    update_batch(state, t, headers, body, true).await
}

pub async fn patch_one(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path(path): Path<(String, String, String)>,
    V1Json(body): V1Json<UpdateOneBody>,
) -> V1Result<AxumJson<Json>> {
    let (base_id, table_ref, record_id) = path;
    let t = target(&state, actor, base_id, table_ref);
    update_one(state, t, headers, record_id, body, false).await
}

pub async fn put_one(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path(path): Path<(String, String, String)>,
    V1Json(body): V1Json<UpdateOneBody>,
) -> V1Result<AxumJson<Json>> {
    let (base_id, table_ref, record_id) = path;
    let t = target(&state, actor, base_id, table_ref);
    update_one(state, t, headers, record_id, body, true).await
}

/// Delete (to the trash) the records `ids`; the shared core of the delete endpoints and the MCP
/// `delete_records` tool.
pub async fn delete_ids(
    state: &AppState,
    actor: Actor,
    headers: &HeaderMap,
    base_id: String,
    table_ref: String,
    ids: Vec<String>,
) -> V1Result<Vec<V1DeletedRecord>> {
    let who = actor.clone();
    let (outcome, deleted) = state
        .db
        .write_as(move |tx| {
            let (table, _) = resolve_table(tx, &actor, &base_id, &table_ref, Role::Editor)?;
            let ctx = editor_ctx(tx, &actor, false)?;
            let outcome = write::delete_records(tx, &ctx, &table.id, &ids)?;
            let deleted = outcome
                .target()
                .deleted
                .iter()
                .map(|id| V1DeletedRecord {
                    id: id.clone(),
                    deleted: true,
                })
                .collect::<Vec<_>>();
            Ok::<_, V1Error>((outcome, deleted))
        })
        .await?;
    publish(state, headers, &who, &outcome);
    Ok(deleted)
}

pub async fn delete_batch(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path((base_id, table_ref)): Path<(String, String)>,
    V1Pairs(pairs): V1Pairs,
) -> V1Result<AxumJson<V1DeletedRecords>> {
    let ids: Vec<String> = pairs
        .into_iter()
        .filter(|(k, _)| k == "records[]" || k == "records")
        .map(|(_, v)| v)
        .collect();
    check_batch(ids.len(), "delete")?;
    let records = delete_ids(&state, actor, &headers, base_id, table_ref, ids).await?;
    Ok(AxumJson(V1DeletedRecords { records }))
}

pub async fn delete_one(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    headers: HeaderMap,
    Path((base_id, table_ref, record_id)): Path<(String, String, String)>,
) -> V1Result<AxumJson<V1DeletedRecord>> {
    let mut records =
        delete_ids(&state, actor, &headers, base_id, table_ref, vec![record_id]).await?;
    records
        .pop()
        .map(AxumJson)
        .ok_or_else(|| V1Error::not_found("Record"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use og_core::field::{FieldKind, TextOptions};

    /// A table with a text field and `n` records.
    fn fixture(n: usize) -> (Connection, TableRow, Vec<Field>, Vec<String>) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'w', 1);
             INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('b', 'w', 'b', 1);
             INSERT INTO tables (id, base_id, name, primary_field_id, created_at)
                 VALUES ('t', 'b', 't', 'fldName', 1);",
        )
        .unwrap();
        let name = Field {
            id: "fldName".into(),
            table_id: "t".into(),
            name: "Name".into(),
            description: None,
            kind: FieldKind::SingleLineText(TextOptions::default()),
        };
        schema::insert_field(&conn, &name, 1.0, 1).unwrap();
        let mut ids = Vec::new();
        for i in 0..n {
            let id = format!("rec{i}");
            conn.execute(
                "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
                 VALUES (?1, 't', '{}', ?2, ?2, 1, 1)",
                rusqlite::params![id, i as f64],
            )
            .unwrap();
            ids.push(id);
        }
        let table = schema::live_table(&conn, "t").unwrap();
        let fields = schema::table_fields(&conn, "t").unwrap();
        (conn, table, fields, ids)
    }

    #[test]
    fn filter_by_formula_gives_up_after_its_time_budget() {
        let (conn, table, fields, ids) = fixture(20);
        let run =
            |budget| filter_by_formula(&conn, &table, &fields, "TRUE()", &ids, Tz::UTC, budget);
        assert_eq!(run(Duration::from_secs(60)).unwrap().len(), 20);
        let err = run(Duration::ZERO).unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.kind, "INVALID_FILTER_BY_FORMULA");
        assert!(err.message.contains("too long"), "{}", err.message);
    }
}
