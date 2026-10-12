//! Deep copies of tables (and, by extension, whole bases).
//!
//! Every table, field, select choice, view and record in the copy gets a fresh
//! id, and every reference is remapped: link `linked_table_id` /
//! `inverse_field_id` / `picker_view_id`, lookup/rollup/count field ids,
//! `{fldXXXX}` references inside formula and button expressions, the ids
//! inside view configs, the primary field, and record data (keys, choice ids,
//! linked record ids).
//!
//! Link fields that point outside the copied set (duplicating one table of a
//! base) get a brand-new inverse field created in the linked table, and the
//! linked records' inverse arrays are filled so both sides stay consistent.

use std::collections::{HashMap, HashSet};

use og_core::api::schema::View;
use og_core::field::{Field, FieldKind, LinkOptions};
use og_core::view::ViewConfig;
use rusqlite::{Transaction, params};
use serde_json::{Map, Value as Json};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::fields_engine;
use crate::store::schema::{self, FieldRecord, PositionScope, TableRow, ViewRow};

/// Rows per batch when copying records.
const CHUNK: i64 = 2000;

/// What to copy and where.
pub struct CopyRequest {
    /// Live tables to copy.
    pub sources: Vec<TableRow>,
    pub dest_base_id: String,
    /// Names for the copies, in the order of `sources`; `None` keeps the
    /// source names (base duplication).
    pub table_names: Option<Vec<String>>,
    pub include_records: bool,
    /// The acting user: owner of copied personal views, creator of the copies.
    pub user_id: String,
}

/// What the copy produced.
pub struct CopyResult {
    /// Ids of the new tables, in the order of `CopyRequest::sources`.
    pub table_ids: Vec<String>,
    /// Other tables that received inverse link fields.
    pub touched_tables: Vec<String>,
}

struct Source {
    table: TableRow,
    fields: Vec<FieldRecord>,
    views: Vec<ViewRow>,
}

/// How one source field's cell values are carried over.
enum CellPlan {
    Plain,
    Select,
    Attachment,
    Computed,
    /// Link to a table that is also being copied.
    InternalLink,
    /// Link to a table outside the copy; `inverse` is the new inverse field
    /// created over there and `target_table` the linked table.
    ExternalLink {
        inverse: String,
        target_table: String,
    },
}

/// Replace every string (and object key) found in `ids` by its mapping.
pub fn remap_json(v: &Json, ids: &HashMap<String, String>) -> Json {
    match v {
        Json::String(s) => ids
            .get(s)
            .map_or_else(|| v.clone(), |n| Json::String(n.clone())),
        Json::Array(a) => Json::Array(a.iter().map(|x| remap_json(x, ids)).collect()),
        Json::Object(o) => Json::Object(
            o.iter()
                .map(|(k, x)| {
                    (
                        ids.get(k).cloned().unwrap_or_else(|| k.clone()),
                        remap_json(x, ids),
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn remap_config(config: &ViewConfig, ids: &HashMap<String, String>) -> AppResult<ViewConfig> {
    let json = remap_json(&serde_json::to_value(config)?, ids);
    serde_json::from_value(json)
        .map_err(|e| AppError::internal(format!("view config remap failed: {e}")))
}

/// Remap one field definition's options into the copy.
fn remap_kind(
    field: &Field,
    ids: &HashMap<String, String>,
    copied_tables: &HashSet<String>,
    external_inverse: &HashMap<String, String>,
) -> AppResult<FieldKind> {
    let get = |id: &str| ids.get(id).cloned().unwrap_or_else(|| id.to_string());
    let mut kind = field.kind.clone();
    match &mut kind {
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => {
            for c in &mut o.choices {
                c.id = get(&c.id);
            }
        }
        FieldKind::Link(l) => {
            if copied_tables.contains(&l.linked_table_id) {
                l.inverse_field_id = ids
                    .get(&l.inverse_field_id)
                    .cloned()
                    .ok_or_else(|| AppError::internal("link pair is incomplete"))?;
                l.linked_table_id = get(&l.linked_table_id);
                l.picker_view_id = l.picker_view_id.as_ref().and_then(|v| ids.get(v).cloned());
            } else {
                l.inverse_field_id = external_inverse
                    .get(&field.id)
                    .cloned()
                    .ok_or_else(|| AppError::internal("missing inverse for external link"))?;
            }
        }
        FieldKind::Lookup(o) => {
            o.link_field_id = get(&o.link_field_id);
            o.target_field_id = get(&o.target_field_id);
        }
        FieldKind::Rollup(o) => {
            o.link_field_id = get(&o.link_field_id);
            o.target_field_id = get(&o.target_field_id);
        }
        FieldKind::Count(o) => o.link_field_id = get(&o.link_field_id),
        FieldKind::Formula(o) => o.expression = schema::remap_stored_refs(&o.expression, ids),
        FieldKind::Button(o) => o.url_formula = schema::remap_stored_refs(&o.url_formula, ids),
        FieldKind::LastModifiedTime(o) | FieldKind::LastModifiedBy(o) => {
            o.fields = o
                .fields
                .iter()
                .filter_map(|f| ids.get(f).cloned())
                .collect();
        }
        _ => {}
    }
    Ok(kind)
}

fn load_sources(tx: &Transaction, req: &CopyRequest) -> AppResult<Vec<Source>> {
    req.sources
        .iter()
        .map(|t| {
            Ok(Source {
                table: t.clone(),
                fields: schema::table_field_records(tx, &t.id)?,
                views: schema::visible_views(tx, &t.id, &req.user_id)?,
            })
        })
        .collect()
}

/// Assign fresh ids to every table, field, choice and view of the sources.
fn assign_ids(sources: &[Source]) -> HashMap<String, String> {
    let mut ids = HashMap::new();
    for s in sources {
        ids.insert(s.table.id.clone(), new_id(og_core::ids::TABLE));
        for f in &s.fields {
            ids.insert(f.field.id.clone(), new_id(og_core::ids::FIELD));
            if let FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) = &f.field.kind {
                for c in &o.choices {
                    ids.entry(c.id.clone())
                        .or_insert_with(|| new_id(og_core::ids::CHOICE));
                }
            }
        }
        for v in &s.views {
            ids.insert(v.view.id.clone(), new_id(og_core::ids::VIEW));
        }
    }
    ids
}

/// Copy the requested tables. See the module docs for the guarantees.
pub fn copy_tables(tx: &Transaction, req: &CopyRequest) -> AppResult<CopyResult> {
    let sources = load_sources(tx, req)?;
    let copied_tables: HashSet<String> = sources.iter().map(|s| s.table.id.clone()).collect();
    let mut ids = assign_ids(&sources);

    // Link fields pointing outside the copy each get a new inverse field id.
    let mut external_inverse: HashMap<String, String> = HashMap::new();
    for s in &sources {
        for f in &s.fields {
            if let FieldKind::Link(l) = &f.field.kind {
                if !copied_tables.contains(&l.linked_table_id) {
                    external_inverse.insert(f.field.id.clone(), new_id(og_core::ids::FIELD));
                }
            }
        }
    }

    let same_base = sources
        .first()
        .is_some_and(|s| s.table.base_id == req.dest_base_id);
    let now = now_ms();
    insert_tables(tx, req, &sources, &ids, same_base, now)?;
    insert_fields(tx, &sources, &ids, &copied_tables, &external_inverse, now)?;
    let touched_tables = insert_external_inverses(tx, &sources, &ids, &external_inverse, now)?;
    insert_views(tx, req, &sources, &ids, now)?;
    if req.include_records {
        copy_records(tx, req, &sources, &mut ids, &external_inverse, same_base)?;
    }
    for s in &sources {
        let new_table = &ids[&s.table.id];
        let computed: Vec<String> = s
            .fields
            .iter()
            .filter(|f| f.field.field_type().is_computed())
            .map(|f| ids[&f.field.id].clone())
            .collect();
        if !computed.is_empty() {
            fields_engine::after_field_change(tx, &req.dest_base_id, new_table, &computed)?;
        }
    }
    Ok(CopyResult {
        table_ids: sources.iter().map(|s| ids[&s.table.id].clone()).collect(),
        touched_tables,
    })
}

fn insert_tables(
    tx: &Transaction,
    req: &CopyRequest,
    sources: &[Source],
    ids: &HashMap<String, String>,
    same_base: bool,
    now: i64,
) -> AppResult<()> {
    for (i, s) in sources.iter().enumerate() {
        let name = req
            .table_names
            .as_ref()
            .and_then(|n| n.get(i))
            .cloned()
            .unwrap_or_else(|| s.table.name.clone());
        let position = if same_base {
            schema::next_position(tx, PositionScope::TablesIn(&req.dest_base_id))?
        } else {
            s.table.position
        };
        let primary = ids
            .get(&s.table.primary_field_id)
            .ok_or_else(|| AppError::internal("table has no live primary field"))?;
        let next_autonumber = if req.include_records {
            s.table.next_autonumber
        } else {
            1
        };
        tx.execute(
            "INSERT INTO tables (id, base_id, name, description, position, primary_field_id,
                                 next_autonumber, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                ids[&s.table.id],
                req.dest_base_id,
                name,
                s.table.description,
                position,
                primary,
                next_autonumber,
                now
            ],
        )?;
    }
    Ok(())
}

fn insert_fields(
    tx: &Transaction,
    sources: &[Source],
    ids: &HashMap<String, String>,
    copied_tables: &HashSet<String>,
    external_inverse: &HashMap<String, String>,
    now: i64,
) -> AppResult<()> {
    for s in sources {
        for rec in &s.fields {
            let f = &rec.field;
            let copy = Field {
                id: ids[&f.id].clone(),
                table_id: ids[&s.table.id].clone(),
                name: f.name.clone(),
                description: f.description.clone(),
                kind: remap_kind(f, ids, copied_tables, external_inverse)?,
            };
            schema::insert_field(tx, &copy, rec.position, now)?;
        }
    }
    Ok(())
}

/// Create the new inverse field, in the linked table, of every link that
/// points outside the copy. Returns the tables that received one.
fn insert_external_inverses(
    tx: &Transaction,
    sources: &[Source],
    ids: &HashMap<String, String>,
    external_inverse: &HashMap<String, String>,
    now: i64,
) -> AppResult<Vec<String>> {
    let mut touched: Vec<String> = Vec::new();
    for s in sources {
        for rec in &s.fields {
            let FieldKind::Link(l) = &rec.field.kind else {
                continue;
            };
            let Some(inverse_id) = external_inverse.get(&rec.field.id) else {
                continue;
            };
            let existing = schema::table_fields(tx, &l.linked_table_id)?;
            if existing.len() >= og_core::limits::MAX_FIELDS_PER_TABLE {
                return Err(AppError::bad_request(
                    "the linked table already has the maximum number of fields",
                ));
            }
            let new_table_name: String = tx.query_row(
                "SELECT name FROM tables WHERE id = ?1",
                [&ids[&s.table.id]],
                |r| r.get(0),
            )?;
            let name = schema::uniquify(
                &schema::name_keys(existing.iter().map(|f| f.name.as_str())),
                &new_table_name,
            );
            let inverse = Field {
                id: inverse_id.clone(),
                table_id: l.linked_table_id.clone(),
                name,
                description: None,
                kind: FieldKind::Link(LinkOptions {
                    linked_table_id: ids[&s.table.id].clone(),
                    inverse_field_id: ids[&rec.field.id].clone(),
                    single: false,
                    picker_view_id: None,
                }),
            };
            let position = schema::next_position(tx, PositionScope::FieldsIn(&l.linked_table_id))?;
            schema::insert_field(tx, &inverse, position, now)?;
            if !touched.contains(&l.linked_table_id) {
                touched.push(l.linked_table_id.clone());
            }
        }
    }
    Ok(touched)
}

fn insert_views(
    tx: &Transaction,
    req: &CopyRequest,
    sources: &[Source],
    ids: &HashMap<String, String>,
    now: i64,
) -> AppResult<()> {
    for s in sources {
        for v in &s.views {
            let copy = View {
                id: ids[&v.view.id].clone(),
                table_id: ids[&s.table.id].clone(),
                name: v.view.name.clone(),
                view_type: v.view.view_type,
                config: remap_config(&v.view.config, ids)?,
                personal: v.owner_id.is_some(),
                locked: v.view.locked,
            };
            schema::insert_view(
                tx,
                &copy,
                v.position,
                v.owner_id.as_deref(),
                Some(&req.user_id),
                now,
            )?;
        }
    }
    Ok(())
}

// ----------------------------------------------------------------- records

fn plan_for(
    f: &Field,
    copied_tables: &HashSet<String>,
    external_inverse: &HashMap<String, String>,
) -> CellPlan {
    match &f.kind {
        FieldKind::Link(l) if copied_tables.contains(&l.linked_table_id) => CellPlan::InternalLink,
        FieldKind::Link(l) => CellPlan::ExternalLink {
            inverse: external_inverse.get(&f.id).cloned().unwrap_or_default(),
            target_table: l.linked_table_id.clone(),
        },
        FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_) => CellPlan::Select,
        FieldKind::Attachment(_) => CellPlan::Attachment,
        _ if f.field_type().is_computed() => CellPlan::Computed,
        _ => CellPlan::Plain,
    }
}

/// Inverse arrays to fill in tables outside the copy:
/// external record id -> new inverse field id -> new record ids.
type ExternalFills = HashMap<String, HashMap<String, Vec<String>>>;

fn string_items(v: &Json) -> Vec<&str> {
    match v {
        Json::Array(a) => a.iter().filter_map(Json::as_str).collect(),
        Json::String(s) => vec![s.as_str()],
        _ => Vec::new(),
    }
}

fn copy_records(
    tx: &Transaction,
    req: &CopyRequest,
    sources: &[Source],
    ids: &mut HashMap<String, String>,
    external_inverse: &HashMap<String, String>,
    same_base: bool,
) -> AppResult<()> {
    let copied_tables: HashSet<String> = sources.iter().map(|s| s.table.id.clone()).collect();

    // New ids for every live record first: links between copied tables need them.
    for s in sources {
        let mut stmt =
            tx.prepare("SELECT id FROM records WHERE table_id = ?1 AND deleted_at IS NULL")?;
        let rows = stmt.query_map([&s.table.id], |r| r.get::<_, String>(0))?;
        for id in rows {
            ids.insert(id?, new_id(og_core::ids::RECORD));
        }
    }

    // Live records of the tables that external links point at.
    let mut external_live: HashMap<String, HashSet<String>> = HashMap::new();
    for s in sources {
        for f in &s.fields {
            if let FieldKind::Link(l) = &f.field.kind {
                if !copied_tables.contains(&l.linked_table_id) {
                    if !external_live.contains_key(&l.linked_table_id) {
                        let mut stmt = tx.prepare(
                            "SELECT id FROM records WHERE table_id = ?1 AND deleted_at IS NULL",
                        )?;
                        let set = stmt
                            .query_map([&l.linked_table_id], |r| r.get::<_, String>(0))?
                            .collect::<Result<HashSet<_>, _>>()?;
                        external_live.insert(l.linked_table_id.clone(), set);
                    }
                }
            }
        }
    }

    let mut fills: ExternalFills = HashMap::new();
    let mut attachment_cache: HashMap<String, Option<String>> = HashMap::new();
    for s in sources {
        let plans: HashMap<&str, CellPlan> = s
            .fields
            .iter()
            .map(|f| {
                (
                    f.field.id.as_str(),
                    plan_for(&f.field, &copied_tables, external_inverse),
                )
            })
            .collect();
        let new_table = ids[&s.table.id].clone();
        let mut after = String::new();
        loop {
            let rows = fetch_record_chunk(tx, &s.table.id, &after)?;
            let Some(last) = rows.last() else { break };
            after = last.id.clone();
            for row in &rows {
                let new_id = ids[&row.id].clone();
                let data = transform_data(
                    tx,
                    row,
                    &new_id,
                    &plans,
                    ids,
                    &external_live,
                    &mut fills,
                    &mut attachment_cache,
                    (!same_base).then_some((req.dest_base_id.as_str(), req.user_id.as_str())),
                )?;
                tx.execute(
                    "INSERT INTO records (id, table_id, data, position, autonumber, created_at,
                                          created_by, updated_at, updated_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        new_id,
                        new_table,
                        serde_json::to_string(&data)?,
                        row.position,
                        row.autonumber,
                        row.created_at,
                        row.created_by,
                        row.updated_at,
                        row.updated_by
                    ],
                )?;
            }
        }
    }
    apply_external_fills(tx, &fills)
}

struct RecordRow {
    id: String,
    data: String,
    position: f64,
    autonumber: i64,
    created_at: i64,
    created_by: Option<String>,
    updated_at: i64,
    updated_by: Option<String>,
}

fn fetch_record_chunk(tx: &Transaction, table_id: &str, after: &str) -> AppResult<Vec<RecordRow>> {
    let mut stmt = tx.prepare(
        "SELECT id, data, position, autonumber, created_at, created_by, updated_at, updated_by
         FROM records WHERE table_id = ?1 AND deleted_at IS NULL AND id > ?2
         ORDER BY id LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![table_id, after, CHUNK], |r| {
        Ok(RecordRow {
            id: r.get(0)?,
            data: r.get(1)?,
            position: r.get(2)?,
            autonumber: r.get(3)?,
            created_at: r.get(4)?,
            created_by: r.get(5)?,
            updated_at: r.get(6)?,
            updated_by: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[allow(clippy::too_many_arguments)]
fn transform_data(
    tx: &Transaction,
    row: &RecordRow,
    new_record_id: &str,
    plans: &HashMap<&str, CellPlan>,
    ids: &HashMap<String, String>,
    external_live: &HashMap<String, HashSet<String>>,
    fills: &mut ExternalFills,
    attachment_cache: &mut HashMap<String, Option<String>>,
    attachment_copy: Option<(&str, &str)>,
) -> AppResult<Map<String, Json>> {
    let source: Map<String, Json> = serde_json::from_str(&row.data).unwrap_or_default();
    let mut out = Map::new();
    for (key, value) in &source {
        let Some(plan) = plans.get(key.as_str()) else {
            continue; // trashed or unknown field: not copied
        };
        let new_key = ids[key].clone();
        let new_value = match plan {
            CellPlan::Plain => Some(value.clone()),
            CellPlan::Computed => Some(remap_json(value, ids)),
            CellPlan::Select => remap_select(value, ids),
            CellPlan::InternalLink => {
                let links: Vec<Json> = string_items(value)
                    .into_iter()
                    .filter_map(|r| ids.get(r).cloned().map(Json::String))
                    .collect();
                (!links.is_empty()).then_some(Json::Array(links))
            }
            CellPlan::ExternalLink {
                inverse,
                target_table,
            } => {
                let live = external_live.get(target_table);
                let kept: Vec<&str> = string_items(value)
                    .into_iter()
                    .filter(|r| live.is_some_and(|set| set.contains(*r)))
                    .collect();
                for r in &kept {
                    fills
                        .entry((*r).to_string())
                        .or_default()
                        .entry(inverse.clone())
                        .or_default()
                        .push(new_record_id.to_string());
                }
                (!kept.is_empty()).then(|| {
                    Json::Array(kept.into_iter().map(|r| Json::String(r.into())).collect())
                })
            }
            CellPlan::Attachment => match attachment_copy {
                Some((base, user)) => copy_attachments(tx, value, base, user, attachment_cache)?,
                None => Some(value.clone()),
            },
        };
        if let Some(v) = new_value {
            out.insert(new_key, v);
        }
    }
    Ok(out)
}

fn remap_select(value: &Json, ids: &HashMap<String, String>) -> Option<Json> {
    match value {
        Json::String(s) => ids.get(s).map(|n| Json::String(n.clone())),
        Json::Array(a) => {
            let kept: Vec<Json> = a
                .iter()
                .filter_map(Json::as_str)
                .filter_map(|s| ids.get(s).cloned().map(Json::String))
                .collect();
            (!kept.is_empty()).then_some(Json::Array(kept))
        }
        _ => None,
    }
}

/// Attachment cells point at rows of `attachments` that belong to a base.
/// Copying into another base duplicates those rows (the bytes are shared by
/// content hash) and re-points the cell at the copies; refs whose row is gone
/// are dropped.
fn copy_attachments(
    tx: &Transaction,
    value: &Json,
    dest_base: &str,
    user_id: &str,
    cache: &mut HashMap<String, Option<String>>,
) -> AppResult<Option<Json>> {
    let Some(items) = value.as_array() else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for item in items {
        let Some(old_id) = item.get("id").and_then(Json::as_str) else {
            continue;
        };
        let new_id = match cache.get(old_id) {
            Some(cached) => cached.clone(),
            None => {
                let fresh = new_id(og_core::ids::ATTACHMENT);
                let n = tx.execute(
                    "INSERT INTO attachments (id, sha256, filename, mime, size, width, height,
                                              has_thumb, base_id, created_by, created_at)
                     SELECT ?1, sha256, filename, mime, size, width, height, has_thumb, ?2, ?3,
                            created_at
                     FROM attachments WHERE id = ?4",
                    params![fresh, dest_base, user_id, old_id],
                )?;
                let result = (n == 1).then_some(fresh);
                cache.insert(old_id.to_string(), result.clone());
                result
            }
        };
        if let (Some(id), Some(obj)) = (new_id, item.as_object()) {
            let mut o = obj.clone();
            o.insert("id".into(), Json::String(id));
            out.push(Json::Object(o));
        }
    }
    Ok((!out.is_empty()).then_some(Json::Array(out)))
}

/// Write the new records into the inverse arrays of the linked (external)
/// records.
fn apply_external_fills(tx: &Transaction, fills: &ExternalFills) -> AppResult<()> {
    for (record_id, per_field) in fills {
        let data: String =
            tx.query_row("SELECT data FROM records WHERE id = ?1", [record_id], |r| {
                r.get(0)
            })?;
        let mut obj: Map<String, Json> = serde_json::from_str(&data).unwrap_or_default();
        for (field_id, new_ids) in per_field {
            let slot = obj
                .entry(field_id.clone())
                .or_insert_with(|| Json::Array(Vec::new()));
            if let Json::Array(items) = slot {
                for id in new_ids {
                    if !items.iter().any(|v| v.as_str() == Some(id.as_str())) {
                        items.push(Json::String(id.clone()));
                    }
                }
            }
        }
        tx.execute(
            "UPDATE records SET data = ?2 WHERE id = ?1",
            params![record_id, serde_json::to_string(&obj)?],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remap_json_rewrites_keys_and_values() {
        let ids: HashMap<String, String> = [("fldA", "fldNew"), ("selX", "selNew")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let v = json!({"fldA": ["selX", "other", 3], "nested": {"selX": true}});
        assert_eq!(
            remap_json(&v, &ids),
            json!({"fldNew": ["selNew", "other", 3], "nested": {"selX": true}})
        );
    }

    #[test]
    fn select_remap_drops_unknown_choices() {
        let ids: HashMap<String, String> = [("a".to_string(), "A".to_string())].into();
        assert_eq!(remap_select(&json!("a"), &ids), Some(json!("A")));
        assert_eq!(remap_select(&json!("zzz"), &ids), None);
        assert_eq!(remap_select(&json!(["a", "zzz"]), &ids), Some(json!(["A"])));
        assert_eq!(remap_select(&json!(["zzz"]), &ids), None);
    }
}
