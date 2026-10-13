//! The recompute engine: materializes computed fields into `records.data`.
//!
//! # What is materialized
//!
//! | field    | stored in `records.data[field_id]`                              |
//! |----------|-----------------------------------------------------------------|
//! | formula  | `Value::to_json` of the result conformed to `result_type`        |
//! | lookup   | array of the target's values on the *live* linked records, in link order, nested arrays flattened one level, blanks skipped; a lookup of a link field yields the linked records' primary text |
//! | rollup   | the rollup expression evaluated with `values` = that array        |
//! | count    | number of live linked records                                    |
//! | button   | the evaluated URL (text) when it is `http(s):` or `mailto:`, else nothing. Buttons are materialized like formulas (core's cell code and the dependency graph treat them that way); the client shows the stored URL |
//!
//! A blank result removes the key. A formula error is stored as
//! `{"error": "#ERROR: ..."}` (that is `Value::Error`'s JSON). A formula that
//! references a deleted field evaluates to such an error and recovers when
//! the field is restored. **System fields** (created/last-modified time/by,
//! autonumber) are never stored; [`crate::store::records`] synthesizes them
//! when building evaluation contexts and on read.
//!
//! # How it stays current
//!
//! The dependency graph ([`og_core::deps::DepGraph`] plus the "names" edges
//! below) covers every field of a base. A write tells a [`Session`] which
//! fields changed on which records ([`Session::mark_changed`]); the session
//! queues the dependent (record, field) pairs: same-record dependents
//! directly, and for lookups/rollups the records reachable through the
//! *inverse* link arrays. [`Session::run`] then walks the fields in
//! topological order, recomputes every queued pair, saves the value if it
//! changed and queues *its* dependents (so unchanged values stop the
//! cascade). Because the walk follows the topological order of the field
//! graph, every pair is computed after all of its inputs, once.
//!
//! **Names edges.** A link cell shows the linked records' primary text, so
//! formulas over a link field (and lookups of one) depend on the linked
//! table's primary field. The graph gets a virtual node `~names:<link
//! field id>` fed by the primary field and feeding those dependents.
//!
//! A hard cap on recomputed cells per transaction ([`DEFAULT_MAX_EVALS`])
//! turns a runaway cascade into a 409 instead of a stuck writer.
//!
//! # Schema changes
//!
//! [`recompute_fields`] is the entry point for field create/update/delete/
//! restore: the given fields are recomputed for every live *and trashed*
//! record (in chunks), their direct dependents likewise, and anything
//! further downstream follows by change propagation.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use og_core::cell::to_value;
use og_core::deps::{DepGraph, Edge, EdgeKind};
use og_core::field::{Field, FieldKind, ValueFormat};
use og_core::formula::{self, EvalContext, Formula};
use og_core::value::{ResultType, Value};
use rusqlite::Connection;
use serde_json::Value as Json;

use crate::error::{AppError, AppResult};
use crate::store::links::{NameCache, ids_json, link_ids};
use crate::store::records::{self, RecordRow};
use crate::store::schema::{self, TableRow};

/// Recomputed cells allowed in one record-write transaction.
pub const DEFAULT_MAX_EVALS: usize = 200_000;
/// Recomputed cells allowed in one schema-change transaction.
pub const SCHEMA_MAX_EVALS: usize = 5_000_000;
/// Records evaluated per chunk.
const CHUNK: usize = 500;
/// Rows kept in the session's row cache before it is dropped.
const MAX_CACHED_ROWS: usize = 20_000;

const VIRTUAL_PREFIX: &str = "~names:";

fn virtual_id(link_field_id: &str) -> String {
    format!("{VIRTUAL_PREFIX}{link_field_id}")
}

/// The link field behind a virtual "names" node id.
pub fn virtual_link(node: &str) -> Option<&str> {
    node.strip_prefix(VIRTUAL_PREFIX)
}

/// Whether a field's value is materialized into `records.data` by this engine.
pub fn is_materialized(kind: &FieldKind) -> bool {
    matches!(
        kind,
        FieldKind::Formula(_)
            | FieldKind::Lookup(_)
            | FieldKind::Rollup(_)
            | FieldKind::Count(_)
            | FieldKind::Button(_)
    )
}

// ------------------------------------------------------------ compiled formulas

/// A parsed formula plus the facts the engine needs.
#[derive(Debug)]
pub struct Compiled {
    pub formula: Option<Formula>,
    pub error: Option<String>,
    pub volatile: bool,
    /// Calls `LAST_MODIFIED_TIME`: must be refreshed on every edit.
    pub uses_modified_time: bool,
}

static PARSE_CACHE: LazyLock<Mutex<HashMap<String, Arc<Compiled>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Parse a stored expression (cached by source text).
pub fn compile(expression: &str) -> Arc<Compiled> {
    {
        let cache = PARSE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = cache.get(expression) {
            return c.clone();
        }
    }
    let compiled = Arc::new(match Formula::parse(expression) {
        Ok(f) => {
            let mut uses_modified_time = false;
            f.expr.walk(&mut |e| {
                if let formula::Expr::Call { name, .. } = e
                    && name == "LAST_MODIFIED_TIME"
                {
                    uses_modified_time = true;
                }
            });
            Compiled {
                volatile: f.volatile,
                formula: Some(f),
                error: None,
                uses_modified_time,
            }
        }
        Err(e) => Compiled {
            formula: None,
            error: Some(e.to_string()),
            volatile: false,
            uses_modified_time: false,
        },
    });
    let mut cache = PARSE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() > 10_000 {
        cache.clear();
    }
    cache.insert(expression.to_string(), compiled.clone());
    compiled
}

/// The stored expression of a formula-like field.
fn expression_of(field: &Field) -> Option<&str> {
    match &field.kind {
        FieldKind::Formula(o) => Some(&o.expression),
        FieldKind::Rollup(o) => Some(&o.expression),
        FieldKind::Button(o) => Some(&o.url_formula),
        _ => None,
    }
}

/// Whether a formula field's stored expression is volatile (`NOW()`, `TODAY()`...).
pub fn is_volatile_field(field: &Field) -> bool {
    matches!(field.kind, FieldKind::Formula(_) | FieldKind::Button(_))
        && expression_of(field).is_some_and(|e| compile(e).volatile)
}

// ------------------------------------------------------------------ the graph

/// Build the dependency graph of a base's fields including the "names" edges
/// (see the module docs). `primary` maps table id to its primary field id.
pub fn build_graph(fields: &[Field], primary: &HashMap<String, String>) -> DepGraph {
    let mut g = DepGraph::build(fields, &schema::field_refs);
    let by_id: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    for f in fields {
        let FieldKind::Link(l) = &f.kind else {
            continue;
        };
        let Some(p) = primary.get(&l.linked_table_id) else {
            continue;
        };
        let sensitive: Vec<Edge> = g
            .dependents_of(&f.id)
            .filter(|e| {
                by_id.get(e.dependent.as_str()).is_some_and(|d| match d.kind {
                    FieldKind::Formula(_) | FieldKind::Button(_) => true,
                    FieldKind::Lookup(_) | FieldKind::Rollup(_) => {
                        matches!(e.kind, EdgeKind::ViaLink { .. })
                    }
                    _ => false,
                })
            })
            .cloned()
            .collect();
        if sensitive.is_empty() {
            continue;
        }
        let v = virtual_id(&f.id);
        g.add_edge(p, &v, EdgeKind::ViaLink { via: f.id.clone() });
        for e in sensitive {
            g.add_edge(&v, &e.dependent, e.kind);
        }
    }
    g
}

/// Everything the engine knows about a base's live schema.
pub struct BaseSchema {
    pub base_id: String,
    pub tables: HashMap<String, TableRow>,
    /// Live fields of each live table in display order.
    pub table_fields: HashMap<String, Vec<Field>>,
    pub fields: HashMap<String, Field>,
    pub graph: DepGraph,
    /// Topological order of every field id and virtual names node.
    pub order: Arc<Vec<String>>,
    /// Link field id -> its inverse field id (both live).
    pub inverse: HashMap<String, String>,
    /// Formula fields per table that must run on every edit.
    pub time_sensitive: HashMap<String, Vec<String>>,
}

impl BaseSchema {
    pub fn load(conn: &Connection, base_id: &str) -> AppResult<BaseSchema> {
        let tables: HashMap<String, TableRow> = schema::live_tables(conn, base_id)?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let all = schema::base_fields(conn, base_id)?;
        let primary: HashMap<String, String> = tables
            .values()
            .map(|t| (t.id.clone(), t.primary_field_id.clone()))
            .collect();
        let graph = build_graph(&all, &primary);
        let mut node_set: HashSet<String> = all.iter().map(|f| f.id.clone()).collect();
        for f in &all {
            if matches!(f.kind, FieldKind::Link(_)) {
                let v = virtual_id(&f.id);
                if graph.dependents_of(&v).next().is_some() {
                    node_set.insert(v);
                }
            }
        }
        let order = Arc::new(graph.topo_order(&node_set));
        let mut inverse = HashMap::new();
        let mut table_fields: HashMap<String, Vec<Field>> = HashMap::new();
        let mut fields = HashMap::new();
        let mut time_sensitive: HashMap<String, Vec<String>> = HashMap::new();
        for f in all {
            if let FieldKind::Link(l) = &f.kind {
                inverse.insert(f.id.clone(), l.inverse_field_id.clone());
            }
            if let FieldKind::Formula(o) = &f.kind
                && compile(&o.expression).uses_modified_time
            {
                time_sensitive
                    .entry(f.table_id.clone())
                    .or_default()
                    .push(f.id.clone());
            }
            table_fields
                .entry(f.table_id.clone())
                .or_default()
                .push(f.clone());
            fields.insert(f.id.clone(), f);
        }
        // A pairing only counts when both sides are live and point at each other.
        inverse.retain(|id, inv| {
            fields.get(inv).is_some_and(|i| match &i.kind {
                FieldKind::Link(il) => &il.inverse_field_id == id,
                _ => false,
            })
        });
        Ok(BaseSchema {
            base_id: base_id.to_string(),
            tables,
            table_fields,
            fields,
            graph,
            order,
            inverse,
            time_sensitive,
        })
    }

    pub fn fields_of(&self, table_id: &str) -> &[Field] {
        self.table_fields
            .get(table_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn table_of_node(&self, node: &str) -> Option<&str> {
        let field_id = virtual_link(node).unwrap_or(node);
        self.fields.get(field_id).map(|f| f.table_id.as_str())
    }
}

// ------------------------------------------------------------------ row cache

#[derive(Default)]
pub struct RowCache {
    map: HashMap<String, Arc<RecordRow>>,
}

impl RowCache {
    /// Rows for `ids` in the order given (unknown ids skipped), loading the
    /// missing ones in one query.
    pub fn get_many(&mut self, conn: &Connection, ids: &[String]) -> AppResult<Vec<Arc<RecordRow>>> {
        if self.map.len() > MAX_CACHED_ROWS {
            self.map.clear();
        }
        let missing: Vec<String> = ids
            .iter()
            .filter(|i| !self.map.contains_key(*i))
            .cloned()
            .collect();
        if !missing.is_empty() {
            for r in records::get_many(conn, &missing)? {
                self.map.insert(r.id.clone(), Arc::new(r));
            }
        }
        Ok(ids.iter().filter_map(|i| self.map.get(i).cloned()).collect())
    }

    pub fn get(&mut self, conn: &Connection, id: &str) -> AppResult<Option<Arc<RecordRow>>> {
        Ok(self
            .get_many(conn, std::slice::from_ref(&id.to_string()))?
            .pop())
    }

    /// Drop a cached row (it changed in the database behind the cache's back).
    pub fn forget(&mut self, id: &str) {
        self.map.remove(id);
    }

    /// Replace the cached copy after the row was written to the database.
    pub fn put(&mut self, row: RecordRow) -> Arc<RecordRow> {
        let id = row.id.clone();
        let arc = Arc::new(row);
        self.map.insert(id, arc.clone());
        arc
    }
}

// --------------------------------------------------------------------- session

/// Which records a forced recompute covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Live and trashed records (schema changes: restoring a record must find
    /// current values).
    All,
    Live,
}

/// Result of a recompute run.
#[derive(Debug, Clone, Default)]
pub struct RecomputeOutcome {
    /// Records whose stored computed values changed, per table.
    pub updated: BTreeMap<String, BTreeSet<String>>,
    /// Cells evaluated.
    pub evals: usize,
}

/// One recompute pass inside a transaction. See the module docs.
pub struct Session<'a> {
    pub conn: &'a Connection,
    pub schema: BaseSchema,
    pub names: NameCache<'a>,
    pub rows: RowCache,
    pub now: DateTime<Utc>,
    scope: Scope,
    pending: HashMap<String, HashSet<String>>,
    evals: usize,
    max_evals: usize,
    updated: BTreeMap<String, BTreeSet<String>>,
}

impl<'a> Session<'a> {
    pub fn new(
        conn: &'a Connection,
        base_id: &str,
        now: DateTime<Utc>,
        tz: Tz,
        max_evals: usize,
    ) -> AppResult<Session<'a>> {
        Ok(Session {
            conn,
            schema: BaseSchema::load(conn, base_id)?,
            names: NameCache::new(conn, tz),
            rows: RowCache::default(),
            now,
            scope: Scope::Live,
            pending: HashMap::new(),
            evals: 0,
            max_evals,
            updated: BTreeMap::new(),
        })
    }

    /// Re-read the schema (after field options changed in this transaction).
    pub fn reload_schema(&mut self) -> AppResult<()> {
        self.schema = BaseSchema::load(self.conn, &self.schema.base_id.clone())?;
        self.names.invalidate_all();
        Ok(())
    }

    pub fn set_scope(&mut self, scope: Scope) {
        self.scope = scope;
    }

    pub fn evals(&self) -> usize {
        self.evals
    }

    fn charge(&mut self, n: usize) -> AppResult<()> {
        self.evals += n;
        if self.evals > self.max_evals {
            return Err(AppError::conflict(format!(
                "this change would recalculate more than {} cells and was cancelled; \
                 simplify the formulas or links involved",
                self.max_evals
            )));
        }
        Ok(())
    }

    // ---- seeding

    /// Record `record_id` of `table_id` changed the value of `node` (a field
    /// id, or a virtual names node): queue what depends on it.
    pub fn mark_changed(&mut self, table_id: &str, record_id: &str, node: &str) -> AppResult<()> {
        let edges: Vec<Edge> = self.schema.graph.dependents_of(node).cloned().collect();
        if edges.is_empty() {
            return Ok(());
        }
        let mut row: Option<Arc<RecordRow>> = None;
        for e in edges {
            match e.kind {
                EdgeKind::SameRecord => {
                    self.pending
                        .entry(e.dependent)
                        .or_default()
                        .insert(record_id.to_string());
                }
                EdgeKind::ViaLink { via } => {
                    let Some(inv) = self.schema.inverse.get(&via).cloned() else {
                        continue;
                    };
                    if row.is_none() {
                        row = self.rows.get(self.conn, record_id)?;
                    }
                    let Some(r) = &row else { continue };
                    if r.deleted_at.is_some() || r.table_id != table_id {
                        continue;
                    }
                    let Some(stored) = r.data.get(&inv) else {
                        continue;
                    };
                    let live = self.names.live_ids(stored);
                    if !live.is_empty() {
                        self.pending.entry(e.dependent).or_default().extend(live);
                    }
                }
            }
        }
        Ok(())
    }

    /// Queue every materialized field of one record (a new or restored
    /// record, or one whose inputs cannot be tracked individually).
    pub fn mark_all_computed(&mut self, table_id: &str, record_id: &str) {
        for f in self.schema.fields_of(table_id) {
            if is_materialized(&f.kind) {
                self.pending
                    .entry(f.id.clone())
                    .or_default()
                    .insert(record_id.to_string());
            }
        }
    }

    /// A user edit or creation touched `record_id`: forward the changed
    /// editable fields and the system fields that change with any edit, and
    /// queue formulas that read the modification time.
    pub fn mark_edited(
        &mut self,
        table_id: &str,
        record_id: &str,
        changed_fields: &[String],
        created: bool,
    ) -> AppResult<()> {
        for f in changed_fields {
            self.mark_changed(table_id, record_id, f)?;
        }
        let system: Vec<String> = self
            .schema
            .fields_of(table_id)
            .iter()
            .filter(|f| match f.kind {
                FieldKind::LastModifiedTime(_) | FieldKind::LastModifiedBy(_) => true,
                FieldKind::CreatedTime(_) | FieldKind::CreatedBy(_) | FieldKind::Autonumber(_) => {
                    created
                }
                _ => false,
            })
            .map(|f| f.id.clone())
            .collect();
        for f in system {
            self.mark_changed(table_id, record_id, &f)?;
        }
        if let Some(ids) = self.schema.time_sensitive.get(table_id).cloned() {
            for fid in ids {
                self.pending
                    .entry(fid)
                    .or_default()
                    .insert(record_id.to_string());
            }
        }
        if created {
            self.mark_all_computed(table_id, record_id);
        }
        Ok(())
    }

    fn table_record_ids(&self, table_id: &str, cache: &mut HashMap<String, Vec<String>>) -> AppResult<Vec<String>> {
        if let Some(ids) = cache.get(table_id) {
            return Ok(ids.clone());
        }
        let ids = records::table_ids(self.conn, table_id, self.scope == Scope::All)?;
        cache.insert(table_id.to_string(), ids.clone());
        Ok(ids)
    }

    /// Force the given fields (schema changed): recompute the materialized
    /// ones for every record in scope, and force their direct dependents
    /// too. Anything further downstream follows by change propagation.
    pub fn force_fields(&mut self, field_ids: &[String]) -> AppResult<()> {
        let mut cache: HashMap<String, Vec<String>> = HashMap::new();
        let mut nodes: Vec<String> = Vec::new();
        for id in field_ids {
            let Some(f) = self.schema.fields.get(id) else {
                continue;
            };
            if is_materialized(&f.kind) {
                nodes.push(id.clone());
            }
            nodes.extend(
                self.schema
                    .graph
                    .dependents_of(id)
                    .map(|e| e.dependent.clone()),
            );
        }
        for node in nodes {
            let Some(table) = self.schema.table_of_node(&node).map(str::to_string) else {
                continue;
            };
            let ids = self.table_record_ids(&table, &mut cache)?;
            self.pending.entry(node).or_default().extend(ids);
        }
        Ok(())
    }

    /// Force exactly the given materialized fields (no dependents).
    pub fn force_computed(&mut self, field_ids: &[String]) -> AppResult<()> {
        let mut cache: HashMap<String, Vec<String>> = HashMap::new();
        for id in field_ids {
            let Some(f) = self.schema.fields.get(id) else {
                continue;
            };
            if !is_materialized(&f.kind) {
                continue;
            }
            let table = f.table_id.clone();
            let ids = self.table_record_ids(&table, &mut cache)?;
            self.pending.entry(id.clone()).or_default().extend(ids);
        }
        Ok(())
    }

    // ---- running

    /// Process everything queued, in topological order.
    pub fn run(&mut self) -> AppResult<()> {
        let order = self.schema.order.clone();
        for node in order.iter() {
            let Some(ids) = self.pending.remove(node) else {
                continue;
            };
            if ids.is_empty() {
                continue;
            }
            let mut ids: Vec<String> = ids.into_iter().collect();
            ids.sort();
            let Some(table_id) = self.schema.table_of_node(node).map(str::to_string) else {
                continue;
            };
            if virtual_link(node).is_some() {
                // Names changed on these records' link cell: forward only.
                for id in &ids {
                    self.mark_changed(&table_id, id, node)?;
                }
                self.charge(ids.len())?;
                continue;
            }
            let Some(field) = self.schema.fields.get(node).cloned() else {
                continue;
            };
            if !is_materialized(&field.kind) {
                for id in &ids {
                    self.mark_changed(&table_id, id, node)?;
                }
                continue;
            }
            for chunk in ids.chunks(CHUNK) {
                self.process_chunk(&field, &table_id, chunk)?;
            }
        }
        if !self.pending.is_empty() {
            tracing::warn!(
                nodes = self.pending.len(),
                "recompute left queued work behind (cyclic or unknown fields)"
            );
            self.pending.clear();
        }
        Ok(())
    }

    fn process_chunk(&mut self, field: &Field, table_id: &str, ids: &[String]) -> AppResult<()> {
        let rows = self.rows.get_many(self.conn, ids)?;
        self.prefetch_links(field, &rows)?;
        let is_primary = self
            .schema
            .tables
            .get(table_id)
            .is_some_and(|t| t.primary_field_id == field.id);
        for row in rows {
            if row.table_id != table_id {
                continue;
            }
            if row.deleted_at.is_some() && self.scope == Scope::Live {
                continue;
            }
            self.charge(1)?;
            let value = self.compute(field, &row)?;
            let new = (!value.is_blank()).then(|| canonical_json(value.to_json()));
            if same_json(row.data.get(&field.id), new.as_ref()) {
                continue;
            }
            let mut data = row.data.clone();
            match new {
                Some(v) => data.insert(field.id.clone(), v),
                None => data.remove(&field.id),
            };
            records::save_data(self.conn, &row.id, &data)?;
            let mut next = (*row).clone();
            next.data = data;
            self.rows.put(next);
            if is_primary {
                self.names.invalidate(&row.id);
            }
            self.updated
                .entry(table_id.to_string())
                .or_default()
                .insert(row.id.clone());
            self.mark_changed(table_id, &row.id, &field.id)?;
        }
        Ok(())
    }

    /// Warm the name and row caches for the records a chunk links to.
    fn prefetch_links(&mut self, field: &Field, rows: &[Arc<RecordRow>]) -> AppResult<()> {
        let link_id = match &field.kind {
            FieldKind::Lookup(o) => &o.link_field_id,
            FieldKind::Rollup(o) => &o.link_field_id,
            FieldKind::Count(o) => &o.link_field_id,
            FieldKind::Formula(_) | FieldKind::Button(_) => {
                let ids: Vec<String> = self
                    .schema
                    .fields_of(&field.table_id)
                    .iter()
                    .filter(|f| matches!(f.kind, FieldKind::Link(_)))
                    .flat_map(|f| rows.iter().flat_map(|r| link_ids(&r.data, &f.id)))
                    .collect();
                self.names.preload(ids.iter().map(String::as_str));
                return Ok(());
            }
            _ => return Ok(()),
        };
        let ids: Vec<String> = rows.iter().flat_map(|r| link_ids(&r.data, link_id)).collect();
        self.names.preload(ids.iter().map(String::as_str));
        let live: Vec<String> = ids.into_iter().filter(|i| self.names.is_live(i)).collect();
        self.rows.get_many(self.conn, &live)?;
        Ok(())
    }

    // ---- evaluation

    /// The value of a cell as the formula engine sees it.
    pub fn read_value(&self, field: &Field, row: &RecordRow) -> Value {
        if matches!(field.kind, FieldKind::Link(_)) {
            let live = row
                .data
                .get(&field.id)
                .map(|v| self.names.live_ids(v))
                .unwrap_or_default();
            let stored = (!live.is_empty()).then(|| ids_json(&live));
            return to_value(field, stored.as_ref(), &self.names);
        }
        let stored = records::cell(self.conn, field, row);
        to_value(field, stored.as_ref(), &self.names)
    }

    fn live_linked(&mut self, row: &RecordRow, link_field_id: &str) -> AppResult<Vec<Arc<RecordRow>>> {
        let Some(stored) = row.data.get(link_field_id) else {
            return Ok(Vec::new());
        };
        let ids = self.names.live_ids(stored);
        let rows = self.rows.get_many(self.conn, &ids)?;
        Ok(rows.into_iter().filter(|r| r.deleted_at.is_none()).collect())
    }

    /// Values of `target` on the linked records, flattened and without blanks.
    fn lookup_values(
        &mut self,
        row: &RecordRow,
        link_field_id: &str,
        target_id: &str,
    ) -> AppResult<Vec<Value>> {
        let linked = self.live_linked(row, link_field_id)?;
        let Some(target) = self.schema.fields.get(target_id) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for lr in &linked {
            match self.read_value(target, lr) {
                Value::Array(items) => out.extend(items.into_iter().filter(|v| !v.is_blank())),
                v if v.is_blank() => {}
                v => out.push(v),
            }
        }
        Ok(out)
    }

    /// Compute the value of a materialized field for one record.
    pub fn compute(&mut self, field: &Field, row: &RecordRow) -> AppResult<Value> {
        Ok(match &field.kind {
            FieldKind::Count(o) => {
                let n = row
                    .data
                    .get(&o.link_field_id)
                    .map_or(0, |v| self.names.live_ids(v).len());
                Value::Number(n as f64)
            }
            FieldKind::Lookup(o) => {
                let values = self.lookup_values(row, &o.link_field_id, &o.target_field_id)?;
                formula::conform(Value::Array(values), &o.result_type)
            }
            FieldKind::Rollup(o) => {
                let values = self.lookup_values(row, &o.link_field_id, &o.target_field_id)?;
                let compiled = compile(&o.expression);
                match &compiled.formula {
                    Some(f) => {
                        let ctx = RecCtx::new(self, row, Value::Array(values), None);
                        formula::conform(f.eval(&ctx), &o.result_type)
                    }
                    None => bad_formula(&compiled),
                }
            }
            FieldKind::Formula(o) => {
                let compiled = compile(&o.expression);
                match &compiled.formula {
                    Some(f) => {
                        let ctx = RecCtx::new(self, row, Value::Null, format_zone(&o.format));
                        f.eval_as(&ctx, &o.result_type)
                    }
                    None => bad_formula(&compiled),
                }
            }
            FieldKind::Button(o) => {
                let compiled = compile(&o.url_formula);
                match &compiled.formula {
                    Some(f) => {
                        let ctx = RecCtx::new(self, row, Value::Null, None);
                        match f.eval_as(&ctx, &ResultType::Text) {
                            Value::Text(url) if safe_url(&url) => Value::Text(url),
                            err @ Value::Error(_) => err,
                            _ => Value::Null,
                        }
                    }
                    None => bad_formula(&compiled),
                }
            }
            _ => Value::Null,
        })
    }

    /// Evaluate a stored formula expression for one record without saving
    /// anything (the formula check preview).
    pub fn preview(&mut self, stored_expression: &str, ty: &ResultType, row: &RecordRow) -> Value {
        let compiled = compile(stored_expression);
        match &compiled.formula {
            Some(f) => {
                let ctx = RecCtx::new(self, row, Value::Null, None);
                f.eval_as(&ctx, ty)
            }
            None => bad_formula(&compiled),
        }
    }

    /// Hand back what recomputation changed.
    pub fn finish(self) -> RecomputeOutcome {
        RecomputeOutcome {
            updated: self.updated,
            evals: self.evals,
        }
    }

    /// Records whose computed values changed so far.
    pub fn updated(&self) -> &BTreeMap<String, BTreeSet<String>> {
        &self.updated
    }
}

fn bad_formula(c: &Compiled) -> Value {
    Value::error(format!(
        "#ERROR: invalid formula ({})",
        c.error.as_deref().unwrap_or("unreadable")
    ))
}

fn safe_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

fn format_zone(format: &Option<ValueFormat>) -> Option<Tz> {
    match format {
        Some(ValueFormat::Date(d)) => d.timezone.as_deref().and_then(|z| z.parse().ok()),
        _ => None,
    }
}

/// Whole numbers as JSON integers (`5`, not `5.0`), like `cell::normalize`
/// stores editable numbers, so equal values store identically.
fn canonical_json(v: Json) -> Json {
    match v {
        Json::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                Json::from(if f == 0.0 { 0 } else { f as i64 })
            }
            _ => Json::Number(n),
        },
        Json::Array(items) => Json::Array(items.into_iter().map(canonical_json).collect()),
        other => other,
    }
}

/// JSON equality that treats `1` and `1.0` as equal.
pub fn same_json(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Null), None) | (None, Some(Json::Null)) => true,
        (Some(x), Some(y)) => json_eq(x, y),
        _ => false,
    }
}

fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

// --------------------------------------------------------- evaluation context

struct RecCtx<'s, 'a> {
    sess: &'s Session<'a>,
    row: &'s RecordRow,
    values: Value,
    tz: Tz,
}

impl<'s, 'a> RecCtx<'s, 'a> {
    fn new(sess: &'s Session<'a>, row: &'s RecordRow, values: Value, tz: Option<Tz>) -> Self {
        RecCtx {
            sess,
            row,
            values,
            tz: tz.unwrap_or(Tz::UTC),
        }
    }
}

fn millis(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
}

impl EvalContext for RecCtx<'_, '_> {
    fn field(&self, field_id: &str) -> Value {
        match self.sess.schema.fields.get(field_id) {
            Some(f) if f.table_id == self.row.table_id => self.sess.read_value(f, self.row),
            _ => Value::error("#ERROR: Unknown field (it may have been deleted)"),
        }
    }
    fn record_id(&self) -> &str {
        &self.row.id
    }
    fn created_time(&self) -> DateTime<Utc> {
        millis(self.row.created_at)
    }
    fn last_modified_time(&self) -> DateTime<Utc> {
        millis(self.row.updated_at)
    }
    fn now(&self) -> DateTime<Utc> {
        self.sess.now
    }
    fn values(&self) -> Value {
        self.values.clone()
    }
    fn timezone(&self) -> Tz {
        self.tz
    }
    fn field_modified_time(&self, field_id: &str) -> Option<DateTime<Utc>> {
        crate::store::history::last_modified(
            self.sess.conn,
            &self.row.id,
            std::slice::from_ref(&field_id.to_string()),
        )
        .ok()
        .flatten()
        .map(|(ms, _)| millis(ms))
    }
}

// ------------------------------------------------------------- entry points

/// A schema change touched `field_ids` in `table_id` of `base_id` (created,
/// converted, deleted or restored fields, or fields whose inputs changed):
/// materialize them and everything depending on them. Runs inside the
/// schema-changing transaction. See the module docs.
pub fn recompute_fields(
    conn: &Connection,
    base_id: &str,
    table_id: &str,
    field_ids: &[String],
) -> AppResult<RecomputeOutcome> {
    let mut s = Session::new(conn, base_id, Utc::now(), Tz::UTC, SCHEMA_MAX_EVALS)?;
    s.set_scope(Scope::All);
    let in_table: Vec<String> = field_ids
        .iter()
        .filter(|id| {
            s.schema
                .fields
                .get(*id)
                .is_some_and(|f| f.table_id == table_id)
        })
        .cloned()
        .collect();
    s.force_fields(&in_table)?;
    s.run()?;
    Ok(s.finish())
}

/// The formula fields (grouped by base) whose stored expression is volatile.
pub fn volatile_fields(conn: &Connection) -> AppResult<Vec<(String, Vec<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT t.base_id, f.id, f.type, f.options FROM fields f
         JOIN tables t ON t.id = f.table_id
         JOIN bases b ON b.id = t.base_id
         JOIN workspaces w ON w.id = b.workspace_id
         WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL AND b.deleted_at IS NULL
           AND w.deleted_at IS NULL AND f.type IN ('formula', 'button')
           AND (f.options LIKE '%NOW%' OR f.options LIKE '%TODAY%'
                OR f.options LIKE '%TONOW%' OR f.options LIKE '%FROMNOW%')
         ORDER BY t.base_id, f.id",
    )?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for (base, id, ty, options) in rows {
        let Ok(kind) = schema::parse_kind(&ty, &options) else {
            continue;
        };
        let field = Field {
            id: id.clone(),
            table_id: String::new(),
            name: String::new(),
            description: None,
            kind,
        };
        if !is_volatile_field(&field) {
            continue;
        }
        match out.last_mut() {
            Some((b, ids)) if *b == base => ids.push(id),
            _ => out.push((base, vec![id])),
        }
    }
    Ok(out)
}

/// Recompute the volatile `field_ids` of one base for its live records at
/// `now`, and what depends on them. Returns the changed records per table.
pub fn refresh_volatile(
    conn: &Connection,
    base_id: &str,
    field_ids: &[String],
    now: DateTime<Utc>,
) -> AppResult<RecomputeOutcome> {
    let mut s = Session::new(conn, base_id, now, Tz::UTC, SCHEMA_MAX_EVALS)?;
    s.set_scope(Scope::Live);
    s.force_computed(field_ids)?;
    s.run()?;
    Ok(s.finish())
}
