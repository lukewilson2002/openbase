//! View queries: filter, search, date range, sort, group, page, summarise.
//!
//! # How a query runs
//!
//! `POST /api/views/{id}/query` streams the table's live records from a read
//! connection in manual (`position`) order and presents each as an
//! `ob_core::query::Row`: the stored JSON of the fields the query needs, plus
//! the *system* fields (created/modified time/by, autonumber) synthesized from
//! the record's columns ([`records::system_cell`], the same helper the write
//! path uses) and link arrays reduced to **live** linked records (trashed ones
//! are hidden from filters, sorts and groups just as they are from responses).
//! Each row goes through
//!
//! 1. the optional [`DateRange`] (the record's span overlaps `[from, to]`),
//! 2. the view filter (`ob_core::query::compile_filter`; conditions on deleted
//!    fields, or that no longer suit their field's type, are ignored),
//! 3. the grid search over the view's visible fields,
//!
//! and survivors keep only the cells the sort and group levels read, so memory
//! stays proportional to the number of *matching* rows times a few cells, not
//! to the table size. The survivors are sorted (group levels first, then the
//! sorts, else manual order), group headers are derived, and the page is
//! loaded **by id** and rendered into [`Record`] DTOs (link cells become
//! `[{id,name}]` with names looked up in batches).
//!
//! # The cache
//!
//! The expensive part is the scan, so its result (the ordered id list, the
//! group headers and the total) is cached in [`QueryCache`], a bounded LRU on
//! [`AppState`](crate::state::AppState). A cached page request loads only the
//! page's records. The key is
//!
//! `(view id, hash of the view config, search, range, timezone, base data
//! version, [user id if the filter uses "me"], [today if it uses relative
//! dates])`.
//!
//! The base data version ([`DataVersions`]) goes up after every committed
//! mutation (see `store::versions`), so a write invalidates every cached query
//! of its base at once. Entries also expire after [`CACHE_TTL`], which bounds
//! staleness for the few things that are not versioned (a user renamed, a
//! profile timezone changed). Row colours are computed per request for the
//! returned page only, so they never go stale.
//!
//! The cache counts full scans and hits ([`QueryCache::scans`],
//! [`QueryCache::hits`]) so tests (and an operator) can verify that a second
//! request really was served without rescanning.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::{NaiveDate, Utc};
use chrono_tz::Tz;
use ob_core::api::records::{
    AggregationsResponse, DateRange, GroupHeader, LinkRef, QueryRequest, QueryResponse, Record,
    TransientConfig,
};
use ob_core::cell::{NoNames, display_text, to_value};
use ob_core::field::{Field, FieldKind, ValueFormat};
use ob_core::ids::FieldId;
use ob_core::limits;
use ob_core::query::{
    CompiledFilter, CompiledRowColor, OwnedRow, QueryCtx, Row, aggregate, aggregations_for,
    compile_filter, compile_row_color, group_spans, matches, matches_search, row_color_compiled,
    search_needle, sort_rows_with_groups,
};
use ob_core::value::Value;
use ob_core::view::{Aggregation, Condition, Filter, FilterItem, RowColor, Sort, ViewConfig};
use rusqlite::Connection;
use serde_json::Value as Json;

use crate::engine::write::user_timezone;
use crate::error::{AppError, AppResult};
use crate::store::links::NameCache;
use crate::store::records::{self, RecordRow};
use crate::store::schema::{self, TableRow, ViewRow};
use crate::store::versions::DataVersions;

/// Page size when the request names none.
pub const DEFAULT_PAGE_SIZE: usize = 100;
/// Entries kept by [`QueryCache`].
pub const CACHE_ENTRIES: usize = 64;
/// Budget of [`QueryCache`]: cached ids plus four per group header. 600k ids
/// is roughly 35 MB, enough for a dozen 50k-record views.
pub const CACHE_WEIGHT: usize = 600_000;
/// How long a cache entry may be served.
pub const CACHE_TTL: Duration = Duration::from_secs(300);
/// Most group headers one public-share response carries. A visitor can group
/// by any shown field, so the number of headers is theirs to inflate; past
/// this the later groups simply have no header (their records still page).
pub const PUBLIC_MAX_GROUP_HEADERS: usize = 1_000;
/// Longest key or label (in characters) of a public group header.
pub const PUBLIC_GROUP_TEXT_CHARS: usize = 200;
/// Default and maximum number of link-picker candidates.
pub const DEFAULT_LOOKUP_LIMIT: usize = 20;
pub const MAX_LOOKUP_LIMIT: usize = 100;

// ------------------------------------------------------------------- cache

/// The cached result of scanning a view: everything except the records of the
/// requested page.
#[derive(Debug)]
pub struct CachedQuery {
    /// Matching record ids in display order.
    pub ids: Vec<String>,
    pub groups: Vec<GroupHeader>,
}

impl CachedQuery {
    /// Ids count one each; a group header counts four plus its text (a group
    /// key, label and value can be as long as a text cell), at about one id
    /// per 64 bytes.
    fn weight(&self) -> usize {
        let header_bytes: usize = self
            .groups
            .iter()
            .map(|g| g.key.len() + g.label.len() + g.value.to_string().len())
            .sum();
        self.ids.len() + self.groups.len() * 4 + header_bytes / 64
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    view_id: String,
    config_hash: u64,
    search: String,
    range: Option<(String, Option<String>, String, String)>,
    timezone: String,
    version: u64,
    /// Only when the filter uses "me".
    user_id: Option<String>,
    /// Only when the filter uses relative dates.
    day: Option<NaiveDate>,
}

struct Slot {
    base_id: String,
    version: u64,
    entry: std::sync::Arc<CachedQuery>,
    used: u64,
    stored: Instant,
}

#[derive(Default)]
struct CacheInner {
    map: HashMap<CacheKey, Slot>,
    tick: u64,
    weight: usize,
}

/// Bounded LRU of view-query results; see the module docs.
#[derive(Default)]
pub struct QueryCache {
    inner: Mutex<CacheInner>,
    scans: AtomicU64,
    hits: AtomicU64,
}

impl QueryCache {
    pub fn new() -> QueryCache {
        QueryCache::default()
    }

    /// Full table scans performed for view queries so far.
    pub fn scans(&self) -> u64 {
        self.scans.load(Ordering::Relaxed)
    }

    /// Requests answered from the cache so far.
    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::Relaxed)
    }

    /// Number of cached results.
    pub fn len(&self) -> usize {
        self.lock().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop everything (tests, or an operator after a manual database edit).
    pub fn clear(&self) {
        *self.lock() = CacheInner::default();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheInner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn get(&self, key: &CacheKey) -> Option<std::sync::Arc<CachedQuery>> {
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        let expired = inner
            .map
            .get(key)
            .is_some_and(|s| s.stored.elapsed() > CACHE_TTL);
        if expired {
            if let Some(s) = inner.map.remove(key) {
                inner.weight -= s.entry.weight();
            }
            return None;
        }
        let slot = inner.map.get_mut(key)?;
        slot.used = tick;
        Some(slot.entry.clone())
    }

    fn put(&self, key: CacheKey, base_id: &str, entry: std::sync::Arc<CachedQuery>) {
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        let version = key.version;
        // Entries of this base computed under an older version can never be
        // served again; free them now instead of waiting for eviction.
        let stale: Vec<CacheKey> = inner
            .map
            .iter()
            .filter(|(_, s)| s.base_id == base_id && s.version < version)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some(s) = inner.map.remove(&k) {
                inner.weight -= s.entry.weight();
            }
        }
        inner.weight += entry.weight();
        if let Some(old) = inner.map.insert(
            key,
            Slot {
                base_id: base_id.to_string(),
                version,
                entry,
                used: tick,
                stored: Instant::now(),
            },
        ) {
            inner.weight -= old.entry.weight();
        }
        while inner.map.len() > CACHE_ENTRIES
            || (inner.weight > CACHE_WEIGHT && inner.map.len() > 1)
        {
            let Some(oldest) = inner
                .map
                .iter()
                .filter(|(_, s)| s.used != tick)
                .min_by_key(|(_, s)| s.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(s) = inner.map.remove(&oldest) {
                inner.weight -= s.entry.weight();
            }
        }
    }
}

// ------------------------------------------------------------------- plan

/// A view config compiled against the table's current fields.
struct Plan {
    fields: Vec<Field>,
    by_id: HashMap<FieldId, Field>,
    filter: CompiledFilter,
    sorts: Vec<Sort>,
    groups: Vec<Sort>,
    search: String,
    search_fields: Vec<Field>,
    range: Option<RangeSpec>,
    ctx: QueryCtx,
    tz: Tz,
    uses_me: bool,
    uses_relative_dates: bool,
}

struct RangeSpec {
    start: Field,
    end: Option<Field>,
    from: NaiveDate,
    to: NaiveDate,
}

/// Which cells a row must carry: system fields are synthesized and link
/// arrays reduced to live records.
struct Needed {
    system: Vec<Field>,
    links: HashSet<String>,
}

impl Needed {
    fn of<'a>(fields: impl IntoIterator<Item = &'a Field>) -> Needed {
        let mut seen = HashSet::new();
        let mut system = Vec::new();
        let mut links = HashSet::new();
        for f in fields {
            if !seen.insert(f.id.clone()) {
                continue;
            }
            if records::is_system(f) {
                system.push(f.clone());
            } else if matches!(f.kind, FieldKind::Link(_)) {
                links.insert(f.id.clone());
            }
        }
        Needed { system, links }
    }
}

fn parse_timezone(name: &str) -> AppResult<Tz> {
    name.trim()
        .parse::<Tz>()
        .map_err(|_| AppError::bad_request(format!("unknown timezone \"{name}\"")))
}

/// The zone for relative dates: the request's, else the user's profile, else UTC.
fn viewer_timezone(conn: &Connection, user_id: &str, requested: Option<&str>) -> AppResult<Tz> {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => parse_timezone(name),
        None => Ok(user_timezone(conn, user_id)),
    }
}

fn parse_day(s: &str, what: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::bad_request(format!("range {what} must be a date like 2026-03-31")))
}

/// Remove the conditions that cannot be evaluated any more (their field was
/// deleted, or its type changed so the operator or operand no longer fits).
/// Views keep working instead of failing until someone fixes the filter.
fn sanitize_filter(filter: &Filter, by_id: &HashMap<FieldId, Field>) -> Filter {
    let items = filter
        .items
        .iter()
        .filter_map(|item| match item {
            FilterItem::Condition(c) => {
                by_id.get(&c.field_id)?;
                let single = Filter {
                    conjunction: filter.conjunction,
                    items: vec![item.clone()],
                };
                compile_filter(&single, by_id)
                    .ok()
                    .map(|_| FilterItem::Condition(c.clone()))
            }
            FilterItem::Group(g) => Some(FilterItem::Group(sanitize_filter(g, by_id))),
        })
        .collect();
    Filter {
        conjunction: filter.conjunction,
        items,
    }
}

fn conditions(filter: &Filter, out: &mut Vec<Condition>) {
    for item in &filter.items {
        match item {
            FilterItem::Condition(c) => out.push(c.clone()),
            FilterItem::Group(g) => conditions(g, out),
        }
    }
}

fn mentions_me(v: &Json) -> bool {
    match v {
        Json::String(s) => s == "me",
        Json::Array(a) => a.iter().any(mentions_me),
        _ => false,
    }
}

fn is_relative_operand(v: &Json) -> bool {
    v.get("mode")
        .and_then(Json::as_str)
        .is_some_and(|m| m != "exact_date")
}

fn is_user_field(f: &Field) -> bool {
    matches!(
        f.kind,
        FieldKind::User(_) | FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_)
    )
}

fn sortable(by_id: &HashMap<FieldId, Field>, sorts: &[Sort]) -> Vec<Sort> {
    let mut seen = HashSet::new();
    sorts
        .iter()
        .filter(|s| {
            by_id
                .get(&s.field_id)
                .is_some_and(|f| !matches!(f.kind, FieldKind::Button(_)))
                && seen.insert(s.field_id.clone())
        })
        .cloned()
        .collect()
}

/// The zone a date-ish field is displayed in when it has a fixed one.
fn fixed_zone(field: &Field) -> Option<Tz> {
    let name = match &field.kind {
        FieldKind::Date(o) | FieldKind::CreatedTime(o) => o.timezone.as_deref(),
        FieldKind::LastModifiedTime(o) => o.date.timezone.as_deref(),
        FieldKind::Formula(o) => match &o.format {
            Some(ValueFormat::Date(d)) => d.timezone.as_deref(),
            _ => None,
        },
        FieldKind::Rollup(o) => match &o.format {
            Some(ValueFormat::Date(d)) => d.timezone.as_deref(),
            _ => None,
        },
        _ => None,
    }?;
    name.parse().ok()
}

fn is_date_like(field: &Field) -> bool {
    match &field.kind {
        FieldKind::Date(_) | FieldKind::CreatedTime(_) | FieldKind::LastModifiedTime(_) => true,
        FieldKind::Formula(o) => matches!(
            o.result_type,
            ob_core::value::ResultType::Date | ob_core::value::ResultType::DateTime
        ),
        _ => false,
    }
}

/// The calendar day of a date cell: dates as stored, instants in the field's
/// fixed zone, else the viewer's.
fn cell_day(field: &Field, stored: Option<&Json>, tz: Tz) -> Option<NaiveDate> {
    match to_value(field, stored, &NoNames) {
        Value::Date(d) => Some(d),
        Value::DateTime(i) => Some(
            i.with_timezone(&fixed_zone(field).unwrap_or(tz))
                .date_naive(),
        ),
        _ => None,
    }
}

impl RangeSpec {
    fn build(range: &DateRange, by_id: &HashMap<FieldId, Field>) -> AppResult<RangeSpec> {
        let date_field = |id: &str| -> AppResult<Field> {
            let f = by_id
                .get(id)
                .ok_or_else(|| AppError::bad_request(format!("unknown field \"{id}\" in range")))?;
            if !is_date_like(f) {
                return Err(AppError::bad_request(format!(
                    "range field \"{}\" is not a date field",
                    f.name
                )));
            }
            Ok(f.clone())
        };
        let from = parse_day(&range.from, "from")?;
        let to = parse_day(&range.to, "to")?;
        if to < from {
            return Err(AppError::bad_request("range \"to\" is before \"from\""));
        }
        Ok(RangeSpec {
            start: date_field(&range.field_id)?,
            end: range
                .end_field_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(date_field)
                .transpose()?,
            from,
            to,
        })
    }

    /// Whether the record's span `[start, end]` overlaps `[from, to]`. A
    /// record with only one of the two dates is a single-day event on it; one
    /// with neither is outside every range; a reversed span is read as
    /// `[end, start]`.
    fn overlaps(&self, row: &dyn Row, tz: Tz) -> bool {
        let start = cell_day(&self.start, row.get(&self.start.id), tz);
        let end = self
            .end
            .as_ref()
            .and_then(|f| cell_day(f, row.get(&f.id), tz));
        let (a, b) = match (start, end) {
            (Some(s), Some(e)) => (s.min(e), s.max(e)),
            (Some(d), None) | (None, Some(d)) => (d, d),
            (None, None) => return false,
        };
        a <= self.to && b >= self.from
    }
}

impl Plan {
    fn build(
        conn: &Connection,
        table_id: &str,
        config: &ViewConfig,
        req: Option<&QueryRequest>,
        user_id: &str,
        tz: Tz,
    ) -> AppResult<Plan> {
        let fields = schema::table_fields(conn, table_id)?;
        let by_id: HashMap<FieldId, Field> =
            fields.iter().map(|f| (f.id.clone(), f.clone())).collect();
        let (filter, uses_me, uses_relative_dates) = match &config.filter {
            Some(f) => {
                let clean = sanitize_filter(f, &by_id);
                let compiled = compile_filter(&clean, &by_id)
                    .map_err(|e| AppError::bad_request(format!("this view's filter: {e}")))?;
                let mut conds = Vec::new();
                conditions(&clean, &mut conds);
                let me = conds.iter().any(|c| {
                    by_id.get(&c.field_id).is_some_and(is_user_field) && mentions_me(&c.value)
                });
                let rel = conds.iter().any(|c| is_relative_operand(&c.value));
                (compiled, me, rel)
            }
            None => (CompiledFilter::match_all(), false, false),
        };
        // Lower-cased once here, not per row; also length-capped.
        let search = search_needle(req.and_then(|r| r.search.as_deref()).unwrap_or_default())
            .map_err(AppError::bad_request)?;
        let search_fields: Vec<Field> = if search.is_empty() {
            Vec::new()
        } else {
            let hidden: HashSet<&str> = config.hidden_fields.iter().map(String::as_str).collect();
            fields
                .iter()
                .filter(|f| {
                    !hidden.contains(f.id.as_str()) && !matches!(f.kind, FieldKind::Button(_))
                })
                .cloned()
                .collect()
        };
        let range = req
            .and_then(|r| r.range.as_ref())
            .map(|r| RangeSpec::build(r, &by_id))
            .transpose()?;
        let ctx = QueryCtx::new(Utc::now(), tz).with_user(user_id);
        Ok(Plan {
            sorts: sortable(&by_id, &config.sorts),
            groups: sortable(&by_id, &config.groups)
                .into_iter()
                .take(limits::MAX_GROUPS)
                .collect(),
            fields,
            by_id,
            filter,
            search,
            search_fields,
            range,
            ctx,
            tz,
            uses_me,
            uses_relative_dates,
        })
    }

    /// Ids of the cells read after the filter: the sort and group levels.
    fn keep(&self) -> HashSet<String> {
        self.sorts
            .iter()
            .chain(&self.groups)
            .map(|s| s.field_id.clone())
            .collect()
    }

    /// Every field the scan must present to its checks and sorts.
    fn needed(&self) -> Needed {
        let mut ids: HashSet<String> = self.keep();
        ids.extend(self.filter.field_ids());
        ids.extend(self.search_fields.iter().map(|f| f.id.clone()));
        if let Some(r) = &self.range {
            ids.insert(r.start.id.clone());
            if let Some(e) = &r.end {
                ids.insert(e.id.clone());
            }
        }
        Needed::of(self.fields.iter().filter(|f| ids.contains(&f.id)))
    }
}

// ------------------------------------------------------------------- scan

/// Turn a stored record into the row the query functions see.
fn eval_row(conn: &Connection, needed: &Needed, row: RecordRow, names: &NameCache) -> OwnedRow {
    let system: Vec<(String, Json)> = needed
        .system
        .iter()
        .filter_map(|f| records::system_cell(conn, f, &row).map(|v| (f.id.clone(), v)))
        .collect();
    let RecordRow { id, mut data, .. } = row;
    for (k, v) in system {
        data.insert(k, v);
    }
    for field_id in &needed.links {
        let Some(stored) = data.get(field_id) else {
            continue;
        };
        let live = names.live_ids(stored);
        if live.is_empty() {
            data.remove(field_id);
        } else {
            data.insert(
                field_id.clone(),
                Json::Array(live.into_iter().map(Json::String).collect()),
            );
        }
    }
    OwnedRow { id, data }
}

/// Stream the live records of a table in manual order, presenting each as an
/// [`OwnedRow`]. `visit` returns `false` to stop early.
fn scan_rows(
    conn: &Connection,
    table_id: &str,
    needed: &Needed,
    names: &NameCache,
    mut visit: impl FnMut(OwnedRow) -> AppResult<bool>,
) -> AppResult<()> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {} FROM records WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
        records::COLS
    ))?;
    let mut rows = stmt.query([table_id])?;
    while let Some(r) = rows.next()? {
        let row = RecordRow::from_sql(r)?;
        if !visit(eval_row(conn, needed, row, names))? {
            break;
        }
    }
    Ok(())
}

/// The raw JSON to write into the grouped field to move a record into the
/// group: the first row's stored cell (so ids, not labels), the day for date
/// groups, a boolean for checkboxes, null for empty and computed fields.
fn group_value(field: &Field, key: &str, empty: bool, first: Option<&OwnedRow>) -> Json {
    if empty || field.field_type().is_computed() {
        return Json::Null;
    }
    match &field.kind {
        FieldKind::Checkbox(_) => Json::Bool(key == "true"),
        FieldKind::Date(_) => Json::String(key.to_string()),
        _ => first
            .and_then(|r| r.get(&field.id))
            .cloned()
            .unwrap_or(Json::Null),
    }
}

fn group_headers(rows: &[OwnedRow], plan: &Plan, names: &NameCache) -> Vec<GroupHeader> {
    if plan.groups.is_empty() {
        return Vec::new();
    }
    group_spans(rows, &plan.groups, &plan.by_id, names, plan.tz)
        .into_iter()
        .filter_map(|span| {
            let level = plan.groups.get(span.level)?;
            let field = plan.by_id.get(&level.field_id)?;
            let value = group_value(field, &span.key.key, span.key.empty, rows.get(span.start));
            Some(GroupHeader {
                depth: span.level,
                field_id: field.id.clone(),
                key: span.key.key,
                label: span.key.label,
                value,
                start: span.start,
                count: span.count,
            })
        })
        .collect()
}

/// Scan the table and build the ordered ids and group headers.
fn build_entry(conn: &Connection, table_id: &str, plan: &Plan) -> AppResult<CachedQuery> {
    let names = NameCache::new(conn, plan.tz);
    let needed = plan.needed();
    let keep = plan.keep();
    let search_refs: Vec<&Field> = plan.search_fields.iter().collect();
    let mut rows: Vec<OwnedRow> = Vec::new();
    scan_rows(conn, table_id, &needed, &names, |mut row| {
        if let Some(range) = &plan.range {
            if !range.overlaps(&row, plan.tz) {
                return Ok(true);
            }
        }
        if !matches(&plan.filter, &row, &plan.ctx, &names) {
            return Ok(true);
        }
        if !plan.search.is_empty()
            && !matches_search(&row, &search_refs, &plan.search, &names, plan.tz)
        {
            return Ok(true);
        }
        row.data.retain(|k, _| keep.contains(k));
        rows.push(row);
        Ok(true)
    })?;
    if !plan.sorts.is_empty() || !plan.groups.is_empty() {
        sort_rows_with_groups(
            &mut rows,
            &plan.groups,
            &plan.sorts,
            &plan.by_id,
            &names,
            plan.tz,
        );
    }
    let groups = group_headers(&rows, plan, &names);
    Ok(CachedQuery {
        ids: rows.into_iter().map(|r| r.id).collect(),
        groups,
    })
}

// ------------------------------------------------------------------ query

fn config_hash(config: &ViewConfig) -> u64 {
    let json = serde_json::to_string(config).unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    json.hash(&mut h);
    h.finish()
}

/// The view `view_id` if the user may see it (personal views belong to their
/// owner alone).
pub fn visible_view(conn: &Connection, user_id: &str, view_id: &str) -> AppResult<ViewRow> {
    let view = schema::live_view(conn, view_id)?;
    match &view.owner_id {
        Some(owner) if owner != user_id => Err(AppError::not_found("view")),
        _ => Ok(view),
    }
}

/// The config a request runs with: the view's saved config with the parts
/// named by a [`TransientConfig`] replaced. The override is validated like a
/// saved config (only the parts it carries, so stale references elsewhere in
/// the saved config do not matter) and is never stored.
pub fn effective_config(
    conn: &Connection,
    view: &ViewRow,
    transient: Option<&TransientConfig>,
) -> AppResult<ViewConfig> {
    let mut config = view.view.config.clone();
    let Some(t) = transient else {
        return Ok(config);
    };
    let fields = schema::table_fields(conn, &view.view.table_id)?;
    let only_the_override = ViewConfig {
        filter: t.filter.clone(),
        sorts: t.sorts.clone().unwrap_or_default(),
        groups: t.groups.clone().unwrap_or_default(),
        ..ViewConfig::default()
    };
    crate::store::views::validate_config(&fields, &only_the_override)
        .map_err(|e| AppError::bad_request(format!("transient: {e}")))?;
    if let Some(f) = &t.filter {
        config.filter = Some(f.clone());
    }
    if let Some(s) = &t.sorts {
        config.sorts = s.clone();
    }
    if let Some(g) = &t.groups {
        config.groups = g.clone();
    }
    Ok(config)
}

/// The result of scanning a view: the (possibly cached) ordered ids plus what
/// rendering a page needs.
struct Scanned {
    entry: std::sync::Arc<CachedQuery>,
    plan: Plan,
    config: ViewConfig,
    table_id: String,
}

fn scan(
    conn: &Connection,
    cache: &QueryCache,
    versions: &DataVersions,
    user_id: &str,
    view: &ViewRow,
    req: &QueryRequest,
) -> AppResult<Scanned> {
    let table_id = view.view.table_id.as_str();
    let table = schema::live_table(conn, table_id)?;
    // Version first, data second (see store::versions): the plan below reads
    // the field definitions, so a schema change that commits after this read
    // must not end up cached under the version that includes it.
    #[cfg(test)]
    tests::before_version_read();
    let version = versions.current(&table.base_id);
    let tz = viewer_timezone(conn, user_id, req.timezone.as_deref())?;
    let config = effective_config(conn, view, req.transient.as_ref())?;
    let plan = Plan::build(conn, table_id, &config, Some(req), user_id, tz)?;

    let key = CacheKey {
        view_id: view.view.id.clone(),
        // The effective config, so a transient override has its own entries.
        config_hash: config_hash(&config),
        search: plan.search.clone(),
        range: req.range.as_ref().map(|r| {
            (
                r.field_id.clone(),
                r.end_field_id.clone().filter(|s| !s.is_empty()),
                r.from.trim().to_string(),
                r.to.trim().to_string(),
            )
        }),
        timezone: tz.name().to_string(),
        version,
        user_id: plan.uses_me.then(|| user_id.to_string()),
        day: plan
            .uses_relative_dates
            .then(|| plan.ctx.now.with_timezone(&tz).date_naive()),
    };
    let entry = match cache.get(&key) {
        Some(hit) => {
            cache.hits.fetch_add(1, Ordering::Relaxed);
            hit
        }
        None => {
            cache.scans.fetch_add(1, Ordering::Relaxed);
            let built = std::sync::Arc::new(build_entry(conn, table_id, &plan)?);
            cache.put(key, &table.base_id, built.clone());
            built
        }
    };
    Ok(Scanned {
        entry,
        plan,
        config,
        table_id: table_id.to_string(),
    })
}

/// Run a view query (see the module docs). The caller has checked that the
/// user may read the view's base.
pub fn run_query(
    conn: &Connection,
    cache: &QueryCache,
    versions: &DataVersions,
    user_id: &str,
    view: &ViewRow,
    req: &QueryRequest,
) -> AppResult<QueryResponse> {
    run_query_with(conn, cache, versions, user_id, view, req, |entry, _| {
        entry.groups.clone()
    })
}

/// [`run_query`] for a public share link: the group headers are cut down to
/// what an anonymous visitor may see and what is cheap to send. Only headers
/// of `visible` fields are kept, at most [`PUBLIC_MAX_GROUP_HEADERS`] of them
/// (cloned one by one, so a huge cached list costs nothing extra); keys and
/// labels are cut to [`PUBLIC_GROUP_TEXT_CHARS`]; the raw `value` (which holds
/// ids of users and linked records) is dropped; and the keys of user-valued
/// fields, which are user ids, are replaced by per-response placeholders.
pub fn run_query_public(
    conn: &Connection,
    cache: &QueryCache,
    versions: &DataVersions,
    view: &ViewRow,
    req: &QueryRequest,
    visible: &HashSet<&str>,
) -> AppResult<QueryResponse> {
    run_query_with(conn, cache, versions, "", view, req, |entry, plan| {
        // Placeholder keys, numbered per field in order of appearance.
        let mut aliases: HashMap<(&str, &str), String> = HashMap::new();
        entry
            .groups
            .iter()
            .filter(|g| visible.contains(g.field_id.as_str()))
            .take(PUBLIC_MAX_GROUP_HEADERS)
            .map(|g| {
                let holds_user_ids = plan.by_id.get(&g.field_id).is_some_and(|f| {
                    matches!(
                        f.kind,
                        FieldKind::User(_) | FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_)
                    )
                });
                let key = if holds_user_ids && !g.key.is_empty() {
                    let n = aliases.len();
                    aliases
                        .entry((g.field_id.as_str(), g.key.as_str()))
                        .or_insert_with(|| format!("user-{n}"))
                        .clone()
                } else {
                    g.key.chars().take(PUBLIC_GROUP_TEXT_CHARS).collect()
                };
                GroupHeader {
                    depth: g.depth,
                    field_id: g.field_id.clone(),
                    key,
                    label: g.label.chars().take(PUBLIC_GROUP_TEXT_CHARS).collect(),
                    value: Json::Null,
                    start: g.start,
                    count: g.count,
                }
            })
            .collect()
    })
}

fn run_query_with(
    conn: &Connection,
    cache: &QueryCache,
    versions: &DataVersions,
    user_id: &str,
    view: &ViewRow,
    req: &QueryRequest,
    groups: impl FnOnce(&CachedQuery, &Plan) -> Vec<GroupHeader>,
) -> AppResult<QueryResponse> {
    let scanned = scan(conn, cache, versions, user_id, view, req)?;
    let limit = req
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .min(limits::MAX_PAGE_SIZE);
    let entry = &scanned.entry;
    let total = entry.ids.len();
    let start = req.offset.min(total);
    let end = start.saturating_add(limit).min(total);
    let page_ids = &entry.ids[start..end];
    let (records, colors) = load_page(
        conn,
        &scanned.plan,
        &scanned.config,
        page_ids,
        &scanned.table_id,
    )?;
    Ok(QueryResponse {
        total,
        offset: req.offset,
        records,
        groups: groups(entry, &scanned.plan),
        colors,
    })
}

/// The ordered ids of every record the query matches (the same scan and cache
/// as [`run_query`], without rendering a page). `offset` and `limit` of the
/// request are ignored. Used by the Airtable-compatible API, which pages
/// through a snapshot of these ids.
pub fn query_ids(
    conn: &Connection,
    cache: &QueryCache,
    versions: &DataVersions,
    user_id: &str,
    view: &ViewRow,
    req: &QueryRequest,
) -> AppResult<std::sync::Arc<CachedQuery>> {
    Ok(scan(conn, cache, versions, user_id, view, req)?.entry)
}

/// Load the page's records by id and render them, with row colours.
fn load_page(
    conn: &Connection,
    plan: &Plan,
    config: &ViewConfig,
    ids: &[String],
    table_id: &str,
) -> AppResult<(Vec<Record>, BTreeMap<String, String>)> {
    if ids.is_empty() {
        return Ok((Vec::new(), BTreeMap::new()));
    }
    let mut by_id: HashMap<String, RecordRow> = records::get_many(conn, ids)?
        .into_iter()
        .filter(|r| r.table_id == table_id && r.is_live())
        .map(|r| (r.id.clone(), r))
        .collect();
    let ordered: Vec<RecordRow> = ids.iter().filter_map(|i| by_id.remove(i)).collect();
    let names = NameCache::new(conn, plan.tz);
    let colors = row_colors(conn, plan, config, &ordered, &names);
    let dtos = records::to_dtos(conn, &plan.fields, &ordered, &names);
    Ok((dtos, colors))
}

/// Compile the view's row colouring against the current fields: rules whose
/// filters no longer compile lose the offending conditions; a select field
/// that is gone colours nothing.
fn compile_colors(config: &ViewConfig, plan: &Plan) -> Option<(CompiledRowColor, Needed)> {
    let rc = config.row_color.as_ref()?;
    let clean = match rc {
        RowColor::BySelect { .. } => rc.clone(),
        RowColor::ByConditions { rules } => RowColor::ByConditions {
            rules: rules
                .iter()
                .map(|r| ob_core::view::ColorRule {
                    color: r.color.clone(),
                    filter: sanitize_filter(&r.filter, &plan.by_id),
                })
                .collect(),
        },
    };
    let compiled = compile_row_color(&clean, &plan.by_id).ok()?;
    let mut ids: HashSet<String> = HashSet::new();
    match &clean {
        RowColor::BySelect { field_id } => {
            ids.insert(field_id.clone());
        }
        RowColor::ByConditions { rules } => {
            for r in rules {
                let mut conds = Vec::new();
                conditions(&r.filter, &mut conds);
                ids.extend(conds.into_iter().map(|c| c.field_id));
            }
        }
    }
    let needed = Needed::of(plan.fields.iter().filter(|f| ids.contains(&f.id)));
    Some((compiled, needed))
}

fn row_colors(
    conn: &Connection,
    plan: &Plan,
    config: &ViewConfig,
    rows: &[RecordRow],
    names: &NameCache,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some((compiled, needed)) = compile_colors(config, plan) else {
        return out;
    };
    for row in rows {
        let eval = eval_row(conn, &needed, row.clone(), names);
        if let Some(color) = row_color_compiled(&compiled, &eval, &plan.ctx, names) {
            out.insert(row.id.clone(), color);
        }
    }
    out
}

// ----------------------------------------------------------- aggregations

/// Options of [`run_aggregations`] besides the view itself.
#[derive(Debug, Default, Clone)]
pub struct AggregationOpts<'a> {
    /// IANA zone for relative dates (default: the user's, then UTC).
    pub timezone: Option<&'a str>,
    /// The same search as the grid's search box: only matching records are
    /// summarised.
    pub search: Option<&'a str>,
    /// A one-off filter override (sorts and groups are accepted and ignored).
    pub transient: Option<&'a TransientConfig>,
}

/// The summary-bar values of a view: each configured aggregation over the
/// records that pass the view filter and the optional search (the date range
/// of calendar queries does not apply).
pub fn run_aggregations(
    conn: &Connection,
    user_id: &str,
    view: &ViewRow,
    opts: &AggregationOpts,
) -> AppResult<AggregationsResponse> {
    let tz = viewer_timezone(conn, user_id, opts.timezone)?;
    let table_id = view.view.table_id.as_str();
    let config = effective_config(conn, view, opts.transient)?;
    let req = QueryRequest {
        search: opts.search.map(str::to_string),
        ..QueryRequest::default()
    };
    let plan = Plan::build(conn, table_id, &config, Some(&req), user_id, tz)?;
    // Summaries in field-id order, each with a usable aggregation.
    let summaries: Vec<(Field, Aggregation)> = config
        .summaries
        .iter()
        .filter(|(_, agg)| **agg != Aggregation::None)
        .filter_map(|(id, agg)| plan.by_id.get(id).map(|f| (f.clone(), *agg)))
        .filter(|(f, agg)| aggregations_for(f).contains(agg))
        .collect();
    let mut out = BTreeMap::new();
    if summaries.is_empty() {
        return Ok(AggregationsResponse { values: out });
    }
    let names = NameCache::new(conn, tz);
    let mut ids: HashSet<String> = plan.filter.field_ids().into_iter().collect();
    ids.extend(summaries.iter().map(|(f, _)| f.id.clone()));
    ids.extend(plan.search_fields.iter().map(|f| f.id.clone()));
    let needed = Needed::of(plan.fields.iter().filter(|f| ids.contains(&f.id)));
    let search_refs: Vec<&Field> = plan.search_fields.iter().collect();
    let mut columns: Vec<Vec<Option<Json>>> = vec![Vec::new(); summaries.len()];
    scan_rows(conn, table_id, &needed, &names, |row| {
        if !matches(&plan.filter, &row, &plan.ctx, &names) {
            return Ok(true);
        }
        if !plan.search.is_empty()
            && !matches_search(&row, &search_refs, &plan.search, &names, plan.tz)
        {
            return Ok(true);
        }
        for (i, (f, _)) in summaries.iter().enumerate() {
            columns[i].push(row.get(&f.id).cloned());
        }
        Ok(true)
    })?;
    for ((field, agg), column) in summaries.iter().zip(&columns) {
        let refs: Vec<Option<&Json>> = column.iter().map(Option::as_ref).collect();
        out.insert(field.id.clone(), aggregate(*agg, field, &refs, tz));
    }
    Ok(AggregationsResponse { values: out })
}

// ----------------------------------------------------------- link lookup

/// Link-picker candidates: records of the table whose primary text contains
/// `q` (case-insensitive), in manual order, optionally restricted to the
/// filter of `view` (the link field's picker view).
pub fn lookup_candidates(
    conn: &Connection,
    user_id: &str,
    table_id: &str,
    q: &str,
    limit: usize,
    view: Option<&ViewRow>,
) -> AppResult<Vec<LinkRef>> {
    let table = schema::live_table(conn, table_id)?;
    let tz = user_timezone(conn, user_id);
    let config = view.map(|v| v.view.config.clone()).unwrap_or_default();
    let plan = Plan::build(conn, table_id, &config, None, user_id, tz)?;
    let primary = plan
        .by_id
        .get(&table.primary_field_id)
        .cloned()
        .ok_or_else(|| AppError::internal("table has no primary field"))?;
    let names = NameCache::new(conn, tz);
    let mut ids: HashSet<String> = plan.filter.field_ids().into_iter().collect();
    ids.insert(primary.id.clone());
    let needed = Needed::of(plan.fields.iter().filter(|f| ids.contains(&f.id)));
    let needle = q.trim().to_lowercase();
    let mut out: Vec<LinkRef> = Vec::new();
    if limit == 0 {
        return Ok(out);
    }
    scan_rows(conn, table_id, &needed, &names, |row| {
        let name = display_text(&primary, row.get(&primary.id), &names, tz);
        if !needle.is_empty() && !name.to_lowercase().contains(&needle) {
            return Ok(true);
        }
        if !matches(&plan.filter, &row, &plan.ctx, &names) {
            return Ok(true);
        }
        out.push(LinkRef { id: row.id, name });
        Ok(out.len() < limit)
    })?;
    Ok(out)
}

// ------------------------------------------------------- search everything

/// A record [`search_table`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordHit {
    pub id: String,
    /// The text of the primary field.
    pub name: String,
    /// Whether `name` starts with the search text.
    pub starts_with: bool,
    /// When the primary field did not match: the text of the field that did.
    pub matched_text: Option<String>,
}

/// Fields whose text the global search reads besides the primary field.
fn is_text_like(kind: &FieldKind) -> bool {
    matches!(
        kind,
        FieldKind::SingleLineText(_)
            | FieldKind::LongText(_)
            | FieldKind::Email(_)
            | FieldKind::Url(_)
            | FieldKind::Phone(_)
    )
}

/// Live records of `table` whose primary field or text-like fields contain
/// `needle` (from [`search_needle`]), compared like the grid search: display
/// text, ignoring case. Primary fields that start with the needle come first,
/// then other primary-field matches, then matches in other fields; at most
/// `limit`, in manual order within each group. Reads at most `*rows_left`
/// records and counts them off, so a search over many tables shares one
/// budget; it stops early once `limit` records start with the needle, since
/// nothing later could rank above them.
pub fn search_table(
    conn: &Connection,
    table: &TableRow,
    needle: &str,
    limit: usize,
    tz: Tz,
    rows_left: &mut usize,
) -> AppResult<Vec<RecordHit>> {
    if limit == 0 || *rows_left == 0 || needle.is_empty() {
        return Ok(Vec::new());
    }
    let fields = schema::table_fields(conn, &table.id)?;
    let Some(primary) = fields
        .iter()
        .find(|f| f.id == table.primary_field_id)
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let others: Vec<Field> = fields
        .into_iter()
        .filter(|f| f.id != primary.id && is_text_like(&f.kind))
        .collect();
    let names = NameCache::new(conn, tz);
    let needed = Needed::of(std::iter::once(&primary).chain(&others));
    let (mut starts, mut contains, mut elsewhere) = (Vec::new(), Vec::new(), Vec::new());
    scan_rows(conn, &table.id, &needed, &names, |row| {
        *rows_left -= 1;
        let name = display_text(&primary, row.get(&primary.id), &names, tz);
        let lower = name.to_lowercase();
        if lower.starts_with(needle) {
            starts.push(RecordHit {
                id: row.id,
                name,
                starts_with: true,
                matched_text: None,
            });
        } else if lower.contains(needle) {
            if contains.len() < limit {
                contains.push(RecordHit {
                    id: row.id,
                    name,
                    starts_with: false,
                    matched_text: None,
                });
            }
        } else if elsewhere.len() < limit {
            let matched = others
                .iter()
                .map(|f| display_text(f, row.get(&f.id), &names, tz))
                .find(|text| text.to_lowercase().contains(needle));
            if let Some(text) = matched {
                elsewhere.push(RecordHit {
                    id: row.id,
                    name,
                    starts_with: false,
                    matched_text: Some(text),
                });
            }
        }
        Ok(starts.len() < limit && *rows_left > 0)
    })?;
    starts.extend(contains);
    starts.extend(elsewhere);
    starts.truncate(limit);
    Ok(starts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{DateOptions, Empty, TextOptions};
    use serde_json::{Map, json};
    use std::cell::RefCell;

    thread_local! {
        static BEFORE_VERSION_READ: RefCell<Option<Box<dyn Fn()>>> = const { RefCell::new(None) };
    }

    /// Test seam called by `scan` just before it reads the data version.
    pub(super) fn before_version_read() {
        BEFORE_VERSION_READ.with(|h| {
            if let Some(f) = h.borrow().as_ref() {
                f();
            }
        });
    }

    fn owned(id: &str, data: Json) -> OwnedRow {
        let data: Map<String, Json> = data.as_object().cloned().unwrap_or_default();
        OwnedRow {
            id: id.to_string(),
            data,
        }
    }

    fn field(id: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl".into(),
            name: id.into(),
            description: None,
            kind,
        }
    }

    fn key(version: u64) -> CacheKey {
        CacheKey {
            view_id: "viw".into(),
            config_hash: 1,
            search: String::new(),
            range: None,
            timezone: "UTC".into(),
            version,
            user_id: None,
            day: None,
        }
    }

    fn entry(n: usize) -> std::sync::Arc<CachedQuery> {
        std::sync::Arc::new(CachedQuery {
            ids: (0..n).map(|i| format!("rec{i}")).collect(),
            groups: Vec::new(),
        })
    }

    /// A table with a name and a note field, a view that filters on the note
    /// containing "x", and two records (note "x" and note "y").
    fn scan_fixture() -> (std::rc::Rc<Connection>, ViewRow) {
        use ob_core::api::schema::View;
        use ob_core::view::ViewType;
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'w', 1);
             INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('b', 'w', 'b', 1);
             INSERT INTO tables (id, base_id, name, primary_field_id, created_at)
                 VALUES ('t', 'b', 't', 'fldName', 1);",
        )
        .unwrap();
        for (i, id) in ["fldName", "fldNote"].into_iter().enumerate() {
            let f = field(id, FieldKind::SingleLineText(TextOptions::default()));
            let f = Field {
                table_id: "t".into(),
                ..f
            };
            schema::insert_field(&conn, &f, i as f64, 1).unwrap();
        }
        for (id, note) in [("rec1", "x"), ("rec2", "y")] {
            conn.execute(
                "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
                 VALUES (?1, 't', ?2, 1, 1, 1, 1)",
                rusqlite::params![id, json!({ "fldNote": note }).to_string()],
            )
            .unwrap();
        }
        let config: ViewConfig = serde_json::from_value(json!({
            "filter": { "conjunction": "and", "items": [
                { "field_id": "fldNote", "op": "contains", "value": "x" } ] }
        }))
        .unwrap();
        let view = View {
            id: "viw".into(),
            table_id: "t".into(),
            name: "v".into(),
            view_type: ViewType::Grid,
            config,
            personal: false,
            locked: false,
        };
        schema::insert_view(&conn, &view, 1.0, None, None, 1).unwrap();
        let row = schema::live_view(&conn, "viw").unwrap();
        (std::rc::Rc::new(conn), row)
    }

    #[test]
    fn a_schema_change_during_a_scan_is_not_cached_under_its_own_version() {
        let (conn, view) = scan_fixture();
        let cache = QueryCache::new();
        let versions = DataVersions::default();
        let req = QueryRequest::default();

        // The note field is deleted (and the base version bumped) right
        // before the scan reads the data version.
        let (c, v) = (conn.clone(), versions.clone());
        BEFORE_VERSION_READ.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                c.execute("UPDATE fields SET deleted_at = 2 WHERE id = 'fldNote'", [])
                    .unwrap();
                v.bump("b");
            }));
        });
        let first = scan(&conn, &cache, &versions, "", &view, &req).unwrap();
        BEFORE_VERSION_READ.with(|h| *h.borrow_mut() = None);
        // With the field gone its condition is ignored, so both records match.
        assert_eq!(first.entry.ids.len(), 2, "plan must see the new schema");

        // A later request is served from the cache under the new version and
        // must agree with a fresh scan.
        let again = scan(&conn, &cache, &versions, "", &view, &req).unwrap();
        assert_eq!(again.entry.ids.len(), 2);
    }

    #[test]
    fn cache_serves_by_key_and_drops_older_versions_of_the_base() {
        let c = QueryCache::new();
        c.put(key(1), "bse", entry(3));
        assert_eq!(c.get(&key(1)).unwrap().ids.len(), 3);
        assert!(c.get(&key(2)).is_none());
        c.put(key(2), "bse", entry(5));
        // The version-1 entry of the same base was freed on insert.
        assert_eq!(c.len(), 1);
        assert!(c.get(&key(1)).is_none());
        // Another base's entries are untouched.
        c.put(key(1), "other", entry(1));
        c.put(key(3), "bse", entry(1));
        assert!(c.get(&key(1)).is_some());
    }

    #[test]
    fn cache_evicts_least_recently_used_within_its_budgets() {
        let c = QueryCache::new();
        for i in 0..CACHE_ENTRIES as u64 {
            let mut k = key(1);
            k.config_hash = i;
            c.put(k, "bse", entry(1));
        }
        assert_eq!(c.len(), CACHE_ENTRIES);
        // Touch entry 0, then add one more: entry 1 (the oldest untouched) goes.
        let mut k0 = key(1);
        k0.config_hash = 0;
        assert!(c.get(&k0).is_some());
        let mut extra = key(1);
        extra.config_hash = 1000;
        c.put(extra, "bse", entry(1));
        assert_eq!(c.len(), CACHE_ENTRIES);
        assert!(c.get(&k0).is_some());
        let mut k1 = key(1);
        k1.config_hash = 1;
        assert!(c.get(&k1).is_none());

        // The weight budget evicts big entries too, but never the newest.
        let c = QueryCache::new();
        let mut a = key(1);
        a.config_hash = 1;
        let mut b = key(1);
        b.config_hash = 2;
        c.put(a.clone(), "bse", entry(CACHE_WEIGHT - 10));
        c.put(b.clone(), "bse", entry(100));
        assert!(c.get(&a).is_none());
        assert!(c.get(&b).is_some());
    }

    #[test]
    fn range_overlap_uses_start_end_and_single_day_fallbacks() {
        let start = field("s", FieldKind::Date(DateOptions::default()));
        let end = field("e", FieldKind::Date(DateOptions::default()));
        let spec = RangeSpec {
            start,
            end: Some(end),
            from: NaiveDate::from_ymd_opt(2026, 3, 10).unwrap(),
            to: NaiveDate::from_ymd_opt(2026, 3, 20).unwrap(),
        };
        let tz = Tz::UTC;
        let hit = |v: Json| spec.overlaps(&owned("r", v), tz);
        // Inside, straddling either edge, covering the whole range.
        assert!(hit(json!({"s": "2026-03-12", "e": "2026-03-14"})));
        assert!(hit(json!({"s": "2026-03-01", "e": "2026-03-10"})));
        assert!(hit(json!({"s": "2026-03-20", "e": "2026-04-01"})));
        assert!(hit(json!({"s": "2026-01-01", "e": "2026-12-31"})));
        // Outside on either side.
        assert!(!hit(json!({"s": "2026-03-01", "e": "2026-03-09"})));
        assert!(!hit(json!({"s": "2026-03-21", "e": "2026-03-25"})));
        // One date only: a single-day event; no dates: never.
        assert!(hit(json!({"s": "2026-03-15"})));
        assert!(hit(json!({"e": "2026-03-15"})));
        assert!(!hit(json!({"s": "2026-04-15"})));
        assert!(!hit(json!({})));
        // A reversed span counts as its reverse.
        assert!(hit(json!({"s": "2026-03-14", "e": "2026-03-12"})));
    }

    #[test]
    fn range_days_of_instants_follow_the_viewer_zone() {
        let start = field(
            "s",
            FieldKind::Date(DateOptions {
                include_time: true,
                ..Default::default()
            }),
        );
        let spec = RangeSpec {
            start,
            end: None,
            from: NaiveDate::from_ymd_opt(2026, 3, 11).unwrap(),
            to: NaiveDate::from_ymd_opt(2026, 3, 11).unwrap(),
        };
        // 23:30 UTC on the 10th is the 11th in Tokyo, the 10th in UTC.
        let row = owned("r", json!({"s": "2026-03-10T23:30:00.000Z"}));
        assert!(spec.overlaps(&row, "Asia/Tokyo".parse().unwrap()));
        assert!(!spec.overlaps(&row, Tz::UTC));
    }

    #[test]
    fn sanitize_drops_conditions_on_unknown_fields_and_unfit_operators() {
        let name = field("name", FieldKind::SingleLineText(TextOptions::default()));
        let by_id: HashMap<FieldId, Field> = [("name".to_string(), name)].into();
        let filter: Filter = serde_json::from_value(json!({
            "conjunction": "or",
            "items": [
                {"field_id": "name", "op": "contains", "value": "x"},
                {"field_id": "gone", "op": "contains", "value": "x"},
                {"field_id": "name", "op": "has_any_of", "value": ["a"]},
                {"conjunction": "and", "items": [
                    {"field_id": "gone", "op": "is_empty"}
                ]}
            ]
        }))
        .unwrap();
        let clean = sanitize_filter(&filter, &by_id);
        assert_eq!(clean.items.len(), 2);
        assert!(matches!(&clean.items[1], FilterItem::Group(g) if g.items.is_empty()));
        assert!(compile_filter(&clean, &by_id).is_ok());
    }

    #[test]
    fn group_value_is_the_raw_value_to_write() {
        let status = field("status", FieldKind::SingleLineText(TextOptions::default()));
        let row = owned("r", json!({"status": "Open"}));
        assert_eq!(
            group_value(&status, "Open", false, Some(&row)),
            json!("Open")
        );
        assert_eq!(group_value(&status, "", true, Some(&row)), Json::Null);
        let done = field("done", FieldKind::Checkbox(Default::default()));
        assert_eq!(group_value(&done, "true", false, None), json!(true));
        assert_eq!(group_value(&done, "false", false, None), json!(false));
        let day = field("day", FieldKind::Date(DateOptions::default()));
        assert_eq!(
            group_value(&day, "2026-03-10", false, None),
            json!("2026-03-10")
        );
        let auto = field("n", FieldKind::Autonumber(Empty {}));
        assert_eq!(group_value(&auto, "3", false, None), Json::Null);
    }

    #[test]
    fn me_and_relative_operands_are_recognized() {
        assert!(mentions_me(&json!("me")));
        assert!(mentions_me(&json!(["usr1", "me"])));
        assert!(!mentions_me(&json!("usr1")));
        assert!(is_relative_operand(&json!({"mode": "today"})));
        assert!(!is_relative_operand(
            &json!({"mode": "exact_date", "date": "2026-01-01"})
        ));
        assert!(!is_relative_operand(&json!("2026-01-01")));
    }
}
