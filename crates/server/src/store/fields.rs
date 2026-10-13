//! Fields: create, update (with data conversion on type changes), delete,
//! primary field, link pairing, and the trash cascades that keep the schema
//! consistent (a link field and its inverse live and die together; lookups,
//! rollups and counts built on a removed field go with it).
//!
//! All functions run inside the caller's write transaction: any error rolls
//! back every change, including record conversions.

use std::collections::{HashMap, HashSet};

use og_core::api::schema::{CreateField, UpdateField};
use og_core::deps::DepGraph;
use og_core::field::{Field, FieldKind, LinkOptions};
use og_core::limits;
use rusqlite::{Transaction, params};
use serde_json::{Map, Value as Json};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::field_kind::{self, KindCtx, normalize_kind};
use crate::store::fields_engine;
use crate::store::schema::{
    self, FieldRecord, PositionScope, TableRow, Touched, live_field, live_table,
};

/// Rows per batch when rewriting record data.
const CHUNK: i64 = 2000;

/// What a field create/update did.
#[derive(Debug, Clone)]
pub struct FieldChange {
    /// The field, in client form.
    pub field: Field,
    /// The inverse link field created or kept in the linked table, if any.
    pub inverse: Option<Field>,
    /// Fields moved to the trash as a consequence (old inverse, dependents).
    pub removed_field_ids: Vec<String>,
    pub touched: Touched,
}

/// What a field delete did.
#[derive(Debug, Clone)]
pub struct DeleteOutcome {
    pub deleted_field_ids: Vec<String>,
    pub touched: Touched,
}

// ----------------------------------------------------------------- helpers

fn ensure_field_name_free(
    siblings: &[Field],
    name: &str,
    except_id: Option<&str>,
) -> AppResult<()> {
    let keys = schema::name_keys(
        siblings
            .iter()
            .filter(|f| Some(f.id.as_str()) != except_id)
            .map(|f| f.name.as_str()),
    );
    if keys.contains(&schema::name_key(name)) {
        return Err(AppError::conflict(format!(
            "a field named '{name}' already exists in this table"
        )));
    }
    Ok(())
}

fn client_view(tx: &Transaction, field: &Field) -> AppResult<Field> {
    let siblings = schema::table_fields(tx, &field.table_id)?;
    Ok(schema::field_for_client(field, &siblings))
}

fn link_options(field: &Field) -> Option<&LinkOptions> {
    match &field.kind {
        FieldKind::Link(l) => Some(l),
        _ => None,
    }
}

// ------------------------------------------------------------------ create

/// Create a field. Link fields get their inverse created in the linked table.
pub fn create(tx: &Transaction, table_id: &str, input: &CreateField) -> AppResult<FieldChange> {
    let table = live_table(tx, table_id)?;
    let siblings = schema::table_fields(tx, table_id)?;
    if siblings.len() >= limits::MAX_FIELDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "a table can have at most {} fields",
            limits::MAX_FIELDS_PER_TABLE
        )));
    }
    let name = schema::validate_name(&input.name, "field")?;
    ensure_field_name_free(&siblings, &name, None)?;
    let description = schema::normalize_optional_text(
        input.description.as_deref(),
        limits::MAX_DESCRIPTION_LEN,
        "description",
    )?;

    let field_id = new_id(og_core::ids::FIELD);
    let ctx = KindCtx {
        conn: tx,
        table: &table,
        siblings: &siblings,
        field_id: &field_id,
        previous: None,
    };
    let mut kind = normalize_kind(&ctx, input.kind.clone())?;
    let inverse_id = new_id(og_core::ids::FIELD);
    if let FieldKind::Link(l) = &mut kind {
        l.inverse_field_id = inverse_id.clone();
    }
    let field = Field {
        id: field_id,
        table_id: table_id.to_string(),
        name,
        description,
        kind,
    };

    let now = now_ms();
    let position = schema::next_position(tx, PositionScope::FieldsIn(table_id))?;
    schema::insert_field(tx, &field, position, now)?;
    let mut touched = Touched::of(table_id);
    let inverse = if link_options(&field).is_some() {
        let inv = insert_inverse(
            tx,
            &field,
            &table,
            &inverse_id,
            input.inverse_name.as_deref(),
        )?;
        touched.add(&inv.table_id);
        Some(inv)
    } else {
        None
    };

    schema::check_base_acyclic(tx, &table.base_id)?;
    if field.field_type().is_computed() {
        fields_engine::after_field_change(
            tx,
            &table.base_id,
            table_id,
            std::slice::from_ref(&field.id),
        )?;
    }
    let inverse = inverse.map(|i| client_view(tx, &i)).transpose()?;
    Ok(FieldChange {
        field: client_view(tx, &field)?,
        inverse,
        removed_field_ids: Vec::new(),
        touched,
    })
}

/// Create the inverse of `link` (which is already inserted) in its linked
/// table and return it. Its name is `inverse_name` or the source table's
/// name, made unique within the linked table.
pub fn insert_inverse(
    tx: &Transaction,
    link: &Field,
    link_table: &TableRow,
    inverse_id: &str,
    inverse_name: Option<&str>,
) -> AppResult<Field> {
    let lo = link_options(link).ok_or_else(|| AppError::internal("inverse of a non-link field"))?;
    let target = live_table(tx, &lo.linked_table_id)?;
    let existing = schema::table_fields(tx, &target.id)?;
    if existing.len() >= limits::MAX_FIELDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "the linked table '{}' already has the maximum of {} fields",
            target.name,
            limits::MAX_FIELDS_PER_TABLE
        )));
    }
    let wanted = match inverse_name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => schema::validate_name(n, "inverse field")?,
        None => link_table.name.clone(),
    };
    let name = schema::uniquify(
        &schema::name_keys(existing.iter().map(|f| f.name.as_str())),
        &wanted,
    );
    let inverse = Field {
        id: inverse_id.to_string(),
        table_id: target.id.clone(),
        name,
        description: None,
        kind: FieldKind::Link(LinkOptions {
            linked_table_id: link_table.id.clone(),
            inverse_field_id: link.id.clone(),
            single: false,
            picker_view_id: None,
        }),
    };
    let position = schema::next_position(tx, PositionScope::FieldsIn(&target.id))?;
    schema::insert_field(tx, &inverse, position, now_ms())?;
    Ok(inverse)
}

// ------------------------------------------------------------------ update

/// Apply a partial update. A different `kind` converts existing values.
pub fn update(tx: &Transaction, field_id: &str, patch: &UpdateField) -> AppResult<FieldChange> {
    let rec = live_field(tx, field_id)?;
    let table = live_table(tx, &rec.field.table_id)?;
    let siblings = schema::table_fields(tx, &table.id)?;
    let old = rec.field;
    let mut field = old.clone();

    if let Some(name) = &patch.name {
        let name = schema::validate_name(name, "field")?;
        ensure_field_name_free(&siblings, &name, Some(&old.id))?;
        field.name = name;
    }
    if let Some(desc) = &patch.description {
        field.description = schema::normalize_optional_text(
            Some(desc),
            limits::MAX_DESCRIPTION_LEN,
            "description",
        )?;
    }
    let position = patch.position.map(schema::validate_position).transpose()?;

    let mut touched = Touched::of(&table.id);
    let mut removed = Vec::new();
    let mut new_inverse: Option<Field> = None;
    let mut kind_changed = false;
    if let Some(requested) = &patch.kind {
        let ctx = KindCtx {
            conn: tx,
            table: &table,
            siblings: &siblings,
            field_id: &old.id,
            previous: Some(&old.kind),
        };
        let mut kind = normalize_kind(&ctx, requested.clone())?;
        if table.primary_field_id == old.id && !kind.field_type().can_be_primary() {
            return Err(AppError::bad_request(format!(
                "the primary field cannot be a {} field",
                kind.field_type().label()
            )));
        }
        let plan = plan_link_change(&old, &mut kind);
        field.kind = kind;
        kind_changed = field.kind != old.kind;
        if kind_changed {
            let clears = field.field_type().is_computed()
                || matches!(plan, LinkPlan::Create | LinkPlan::Relink);
            if !clears && old.field_type() != field.field_type() {
                // Names found in the old values become choices of the new select field.
                fields_engine::add_conversion_choices(tx, &table.id, &old, &mut field)?;
            }
            let r = rewrite_for_new_kind(tx, &table, &old, &field, &plan)?;
            removed = r.removed;
            for t in &r.touched.0 {
                touched.add(t);
            }
        }
        schema::save_field(tx, &field, position)?;
        if matches!(plan, LinkPlan::Create | LinkPlan::Relink) && kind_changed {
            let inv_id = link_options(&field).map(|l| l.inverse_field_id.clone());
            let inv_id = inv_id.ok_or_else(|| AppError::internal("link without inverse id"))?;
            let inv = insert_inverse(tx, &field, &table, &inv_id, None)?;
            touched.add(&inv.table_id);
            new_inverse = Some(inv);
        }
    } else {
        schema::save_field(tx, &field, position)?;
    }

    if kind_changed {
        schema::check_base_acyclic(tx, &table.base_id)?;
        let seeds = std::slice::from_ref(&field.id);
        let dependents = refresh_dependents(tx, &table.base_id, seeds)?;
        for (t, _) in &dependents {
            touched.add(t);
        }
        let own = if field.field_type().is_computed() {
            vec![field.id.clone()]
        } else {
            Vec::new()
        };
        run_engine(tx, &table.base_id, &table.id, own, dependents)?;
    }

    let inverse = match new_inverse {
        Some(inv) => Some(inv),
        None => link_options(&field)
            .map(|l| schema::field_any(tx, &l.inverse_field_id))
            .transpose()?
            .flatten()
            .filter(|r| r.deleted_at.is_none())
            .map(|r| r.field),
    };
    let inverse = inverse.map(|i| client_view(tx, &i)).transpose()?;
    Ok(FieldChange {
        field: client_view(tx, &field)?,
        inverse,
        removed_field_ids: removed,
        touched,
    })
}

/// How the link pairing changes in an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkPlan {
    /// Neither the old nor the new kind is a link, or a link keeps its pair.
    Keep,
    /// The field becomes a link (or links a different table): a new inverse is needed.
    Create,
    /// The field stops being a link: its inverse goes away.
    Drop,
    /// Links a different table: old inverse goes away and a new one is created.
    Relink,
}

fn plan_of(old: &Field, new: &Field) -> LinkPlan {
    match (link_options(old), link_options(new)) {
        (None, None) => LinkPlan::Keep,
        (None, Some(_)) => LinkPlan::Create,
        (Some(_), None) => LinkPlan::Drop,
        (Some(a), Some(b)) if a.linked_table_id == b.linked_table_id => LinkPlan::Keep,
        (Some(_), Some(_)) => LinkPlan::Relink,
    }
}

/// Decide the link pairing change and fix up `kind`'s `inverse_field_id`:
/// kept when the linked table is unchanged, fresh otherwise.
fn plan_link_change(old: &Field, kind: &mut FieldKind) -> LinkPlan {
    let probe = Field {
        kind: kind.clone(),
        ..old.clone()
    };
    let plan = plan_of(old, &probe);
    if let FieldKind::Link(l) = kind {
        match (&plan, link_options(old)) {
            (LinkPlan::Keep, Some(prev)) => l.inverse_field_id = prev.inverse_field_id.clone(),
            _ => l.inverse_field_id = new_id(og_core::ids::FIELD),
        }
    }
    plan
}

struct Rewrite {
    removed: Vec<String>,
    touched: Touched,
}

/// Convert/clear stored values and tear down link pairs as the field's type
/// changes from `old` to `new`.
fn rewrite_for_new_kind(
    tx: &Transaction,
    table: &TableRow,
    old: &Field,
    new: &Field,
    plan: &LinkPlan,
) -> AppResult<Rewrite> {
    let mut removed = Vec::new();
    let mut touched = Touched::default();
    if *plan == LinkPlan::Drop || *plan == LinkPlan::Relink {
        let tore = tear_down_pair(tx, table, old)?;
        removed = tore.removed;
        touched = tore.touched;
    }
    let clear =
        new.field_type().is_computed() || *plan == LinkPlan::Create || *plan == LinkPlan::Relink;
    if old.field_type() == new.field_type() && !clear {
        strip_removed_choices(tx, &table.id, old, new)?;
    } else {
        let mode = if clear {
            RewriteMode::Clear
        } else {
            RewriteMode::Convert
        };
        rewrite_cells(tx, &table.id, old, new, mode)?;
    }
    Ok(Rewrite { removed, touched })
}

/// A link field stops being a link (or relinks): its inverse and everything
/// built on either side move to the trash.
fn tear_down_pair(tx: &Transaction, table: &TableRow, old: &Field) -> AppResult<Rewrite> {
    let all = schema::base_fields(tx, &table.base_id)?;
    let mut seeds: HashSet<String> = HashSet::from([old.id.clone()]);
    if let Some(l) = link_options(old) {
        seeds.insert(l.inverse_field_id.clone());
    }
    // Lookups through either side of the pair, or aiming at the inverse, are
    // meaningless now; lookups aiming at `old` itself stay valid.
    let inverse_only: HashSet<String> = link_options(old)
        .map(|l| HashSet::from([l.inverse_field_id.clone()]))
        .unwrap_or_default();
    let mut ids: Vec<String> = inverse_only.iter().cloned().collect();
    ids.extend(dependents_closure(&all, &seeds, &inverse_only));
    let tables: HashMap<&str, &str> = all
        .iter()
        .map(|f| (f.id.as_str(), f.table_id.as_str()))
        .collect();
    let mut touched = Touched::default();
    for id in &ids {
        if let Some(t) = tables.get(id.as_str()) {
            touched.add(t);
        }
    }
    mark_deleted(tx, &ids, now_ms())?;
    Ok(Rewrite {
        removed: ids,
        touched,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RewriteMode {
    Convert,
    Clear,
}

/// Rewrite the stored cell of `old.id` in every record of the table (live and
/// trashed), in chunks: converted through the engine, or removed.
fn rewrite_cells(
    tx: &Transaction,
    table_id: &str,
    old: &Field,
    new: &Field,
    mode: RewriteMode,
) -> AppResult<()> {
    match mode {
        RewriteMode::Clear => map_cells(tx, table_id, &old.id, |_| None),
        RewriteMode::Convert => fields_engine::convert_column(tx, table_id, old, new),
    }
}

/// For every record of the table having a cell for `field_id`, replace the
/// cell with `f(cell)`; `None` removes it. Batches of [`CHUNK`] rows.
pub fn map_cells(
    tx: &Transaction,
    table_id: &str,
    field_id: &str,
    f: impl Fn(&Json) -> Option<Json>,
) -> AppResult<()> {
    let path = format!("$.\"{field_id}\"");
    let mut after = String::new();
    loop {
        let rows: Vec<(String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, data FROM records
                 WHERE table_id = ?1 AND id > ?2 AND json_type(data, ?3) IS NOT NULL
                 ORDER BY id LIMIT ?4",
            )?;
            stmt.query_map(params![table_id, after, path, CHUNK], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<_, _>>()?
        };
        let Some(last) = rows.last() else { break };
        after = last.0.clone();
        for (id, data) in &rows {
            let Ok(mut obj) = serde_json::from_str::<Map<String, Json>>(data) else {
                tracing::warn!(record = %id, "skipping record with unreadable data");
                continue;
            };
            let next = obj.get(field_id).and_then(&f);
            match next {
                Some(v) => obj.insert(field_id.to_string(), v),
                None => obj.remove(field_id),
            };
            tx.execute(
                "UPDATE records SET data = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&obj)?],
            )?;
        }
    }
    Ok(())
}

/// Same-type select update: values pointing at removed choices are cleared.
fn strip_removed_choices(
    tx: &Transaction,
    table_id: &str,
    old: &Field,
    new: &Field,
) -> AppResult<()> {
    let ((FieldKind::SingleSelect(o), FieldKind::SingleSelect(n))
    | (FieldKind::MultipleSelect(o), FieldKind::MultipleSelect(n))) = (&old.kind, &new.kind)
    else {
        return Ok(());
    };
    let kept: HashSet<&str> = n.choices.iter().map(|c| c.id.as_str()).collect();
    let gone: HashSet<String> = o
        .choices
        .iter()
        .filter(|c| !kept.contains(c.id.as_str()))
        .map(|c| c.id.clone())
        .collect();
    if gone.is_empty() {
        return Ok(());
    }
    map_cells(tx, table_id, &old.id, |cell| match cell {
        Json::String(s) if gone.contains(s) => None,
        Json::Array(items) => {
            let left: Vec<Json> = items
                .iter()
                .filter(|v| v.as_str().is_none_or(|s| !gone.contains(s)))
                .cloned()
                .collect();
            (!left.is_empty()).then_some(Json::Array(left))
        }
        other => Some(other.clone()),
    })
}

// -------------------------------------------------- dependents bookkeeping

fn depends_on(f: &Field, set: &HashSet<String>) -> bool {
    match &f.kind {
        FieldKind::Lookup(o) => set.contains(&o.link_field_id) || set.contains(&o.target_field_id),
        FieldKind::Rollup(o) => set.contains(&o.link_field_id) || set.contains(&o.target_field_id),
        FieldKind::Count(o) => set.contains(&o.link_field_id),
        _ => false,
    }
}

/// Lookups, rollups and counts (transitively) built on the given fields:
/// directly on a link field in `link_seeds` or on a target in `target_seeds`,
/// then on anything already found.
fn dependents_closure(
    fields: &[Field],
    link_seeds: &HashSet<String>,
    target_seeds: &HashSet<String>,
) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut found_set: HashSet<String> = HashSet::new();
    for f in fields {
        let direct = match &f.kind {
            FieldKind::Lookup(o) => {
                link_seeds.contains(&o.link_field_id) || target_seeds.contains(&o.target_field_id)
            }
            FieldKind::Rollup(o) => {
                link_seeds.contains(&o.link_field_id) || target_seeds.contains(&o.target_field_id)
            }
            FieldKind::Count(o) => link_seeds.contains(&o.link_field_id),
            _ => false,
        };
        if direct && found_set.insert(f.id.clone()) {
            found.push(f.id.clone());
        }
    }
    loop {
        let mut grew = false;
        for f in fields {
            if !found_set.contains(&f.id) && depends_on(f, &found_set) {
                found_set.insert(f.id.clone());
                found.push(f.id.clone());
                grew = true;
            }
        }
        if !grew {
            return found;
        }
    }
}

fn mark_deleted(tx: &Transaction, ids: &[String], at: i64) -> AppResult<()> {
    let mut stmt =
        tx.prepare("UPDATE fields SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL")?;
    for id in ids {
        stmt.execute(params![id, at])?;
    }
    Ok(())
}

/// After `seeds` changed type or options, recompute what depends on them:
/// lookup result types, rollup/formula inference (best effort). Returns the
/// dependents per table (to feed the recompute engine).
fn refresh_dependents(
    tx: &Transaction,
    base_id: &str,
    seeds: &[String],
) -> AppResult<Vec<(String, Vec<String>)>> {
    let all = schema::base_fields(tx, base_id)?;
    let graph = DepGraph::build(&all, &schema::field_refs);
    let dependents = graph.transitive_dependents(seeds);
    let order = graph.topo_order(&dependents);
    let table_order: Vec<(String, String)> = all
        .iter()
        .map(|f| (f.id.clone(), f.table_id.clone()))
        .collect();
    let mut by_id: HashMap<String, Field> = all.into_iter().map(|f| (f.id.clone(), f)).collect();
    let mut per_table: Vec<(String, Vec<String>)> = Vec::new();
    for id in &order {
        let Some(mut f) = by_id.get(id).cloned() else {
            continue;
        };
        let before = f.kind.clone();
        let table_fields: Vec<Field> = table_order
            .iter()
            .filter(|(_, t)| *t == f.table_id)
            .filter_map(|(fid, _)| by_id.get(fid).cloned())
            .collect();
        match &mut f.kind {
            FieldKind::Lookup(o) => {
                if let Some(t) = by_id.get(&o.target_field_id) {
                    o.result_type = field_kind::lookup_result_type(t);
                }
            }
            FieldKind::Rollup(o) => {
                if let Some(t) = by_id.get(&o.target_field_id) {
                    let display = fields_engine::display_formula(&o.expression, &table_fields);
                    match fields_engine::prepare_rollup(&table_fields, t, &display) {
                        Ok((stored, ty)) => {
                            o.expression = stored;
                            o.result_type = ty;
                        }
                        Err(e) => {
                            tracing::warn!(field = %f.id, error = %e, "rollup no longer type-checks")
                        }
                    }
                }
            }
            FieldKind::Formula(o) => {
                let display = fields_engine::display_formula(&o.expression, &table_fields);
                match fields_engine::prepare_formula(&table_fields, &display) {
                    Ok((stored, ty)) => {
                        o.expression = stored;
                        o.result_type = ty;
                    }
                    Err(e) => {
                        tracing::warn!(field = %f.id, error = %e, "formula no longer type-checks")
                    }
                }
            }
            _ => {}
        }
        if f.kind != before {
            schema::save_field(tx, &f, None)?;
        }
        match per_table.iter_mut().find(|(t, _)| *t == f.table_id) {
            Some((_, ids)) => ids.push(f.id.clone()),
            None => per_table.push((f.table_id.clone(), vec![f.id.clone()])),
        }
        by_id.insert(f.id.clone(), f);
    }
    Ok(per_table)
}

/// Run the recompute hook for the changed fields of `table_id` plus dependents.
fn run_engine(
    tx: &Transaction,
    base_id: &str,
    table_id: &str,
    own: Vec<String>,
    dependents: Vec<(String, Vec<String>)>,
) -> AppResult<()> {
    let mut per_table: Vec<(String, Vec<String>)> = dependents;
    if !own.is_empty() {
        match per_table.iter_mut().find(|(t, _)| t == table_id) {
            Some((_, ids)) => ids.extend(own),
            None => per_table.push((table_id.to_string(), own)),
        }
    }
    for (t, ids) in per_table {
        fields_engine::after_field_change(tx, base_id, &t, &ids)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ delete

/// Move a field to the trash. Its link partner and everything built on it go
/// with it. The primary field cannot be deleted.
pub fn delete(tx: &Transaction, field_id: &str) -> AppResult<DeleteOutcome> {
    let field = live_field(tx, field_id)?.field;
    let table = live_table(tx, &field.table_id)?;
    if table.primary_field_id == field.id {
        return Err(AppError::conflict(
            "the primary field cannot be deleted; make another field primary first",
        ));
    }
    let all = schema::base_fields(tx, &table.base_id)?;
    let mut seeds: HashSet<String> = HashSet::from([field.id.clone()]);
    if let Some(l) = link_options(&field) {
        seeds.insert(l.inverse_field_id.clone());
    }
    let mut ids: Vec<String> = seeds.iter().cloned().collect();
    ids.sort();
    ids.extend(dependents_closure(&all, &seeds, &seeds));

    let tables: HashMap<&str, &str> = all
        .iter()
        .map(|f| (f.id.as_str(), f.table_id.as_str()))
        .collect();
    let mut touched = Touched::of(&table.id);
    for id in &ids {
        if let Some(t) = tables.get(id.as_str()) {
            touched.add(t);
        }
    }
    mark_deleted(tx, &ids, now_ms())?;

    // Anything that referenced the removed fields needs a refresh.
    let live = schema::base_fields(tx, &table.base_id)?;
    let graph = DepGraph::build(&live, &schema::field_refs);
    let affected = graph.transitive_dependents(&ids);
    let mut per_table: Vec<(String, Vec<String>)> = Vec::new();
    for f in live.iter().filter(|f| affected.contains(&f.id)) {
        match per_table.iter_mut().find(|(t, _)| *t == f.table_id) {
            Some((_, v)) => v.push(f.id.clone()),
            None => per_table.push((f.table_id.clone(), vec![f.id.clone()])),
        }
    }
    run_engine(tx, &table.base_id, &table.id, Vec::new(), per_table)?;
    Ok(DeleteOutcome {
        deleted_field_ids: ids,
        touched,
    })
}

/// Trash the link fields of other tables that point at `table` (already
/// trashed) and everything built on them, all stamped `at` so restoring the
/// table can bring exactly them back.
pub fn cascade_delete_incoming_links(
    tx: &Transaction,
    table: &TableRow,
    at: i64,
) -> AppResult<Touched> {
    let all = schema::base_fields(tx, &table.base_id)?;
    let seeds: HashSet<String> = all
        .iter()
        .filter(|f| link_options(f).is_some_and(|l| l.linked_table_id == table.id))
        .map(|f| f.id.clone())
        .collect();
    let mut ids: Vec<String> = seeds.iter().cloned().collect();
    ids.sort();
    ids.extend(dependents_closure(&all, &seeds, &seeds));
    let tables: HashMap<&str, &str> = all
        .iter()
        .map(|f| (f.id.as_str(), f.table_id.as_str()))
        .collect();
    let mut touched = Touched::default();
    for id in &ids {
        if let Some(t) = tables.get(id.as_str()) {
            touched.add(t);
        }
    }
    mark_deleted(tx, &ids, at)?;
    Ok(touched)
}

// ----------------------------------------------------------------- primary

/// Make `field_id` the table's primary field (and first in display order).
pub fn set_primary(tx: &Transaction, table_id: &str, field_id: &str) -> AppResult<TableRow> {
    let table = live_table(tx, table_id)?;
    let field = live_field(tx, field_id)
        .ok()
        .filter(|r| r.field.table_id == table_id)
        .ok_or_else(|| AppError::not_found("field"))?
        .field;
    if !field.field_type().can_be_primary() {
        return Err(AppError::bad_request(format!(
            "a {} field cannot be the primary field",
            field.field_type().label()
        )));
    }
    if table.primary_field_id != field.id {
        let first: f64 = tx.query_row(
            "SELECT COALESCE(MIN(position), 1) - 1 FROM fields WHERE table_id = ?1",
            [table_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE fields SET position = ?2 WHERE id = ?1",
            params![field.id, first],
        )?;
        tx.execute(
            "UPDATE tables SET primary_field_id = ?2 WHERE id = ?1",
            params![table_id, field.id],
        )?;
        // Linked records are shown by their primary field's text.
        schema::check_base_acyclic(tx, &table.base_id)?;
        fields_engine::after_field_change(
            tx,
            &table.base_id,
            table_id,
            &[table.primary_field_id.clone(), field.id.clone()],
        )?;
    }
    live_table(tx, table_id)
}

// ----------------------------------------------------------------- restore

/// What a restore brought back.
#[derive(Debug, Clone)]
pub struct RestoreOutcome {
    pub restored_field_ids: Vec<String>,
    pub touched: Touched,
}

fn lookup_all(all: &[FieldRecord]) -> HashMap<&str, &FieldRecord> {
    all.iter().map(|r| (r.field.id.as_str(), r)).collect()
}

/// Restore a trashed field with its link partner and the dependents that were
/// trashed together with it. Names that now collide get " (restored)".
pub fn restore(tx: &Transaction, field_id: &str) -> AppResult<RestoreOutcome> {
    let root = schema::field_any(tx, field_id)?.ok_or_else(|| AppError::not_found("field"))?;
    let Some(stamp) = root.deleted_at else {
        return Err(AppError::conflict("this field is not in the trash"));
    };
    let table =
        schema::table_any(tx, &root.field.table_id)?.ok_or_else(|| AppError::not_found("table"))?;
    if table.deleted_at.is_some() {
        return Err(AppError::conflict(format!(
            "restore the table '{}' first",
            table.name
        )));
    }
    let all = schema::base_field_records_all(tx, &table.base_id)?;
    let by_id = lookup_all(&all);
    let tables = base_tables(tx, &table.base_id)?;

    let mut members: Vec<String> = vec![root.field.id.clone()];
    if let Some(lo) = link_options(&root.field) {
        let partner = by_id.get(lo.inverse_field_id.as_str()).copied();
        let ok = partner.is_some_and(|p| {
            link_options(&p.field).is_some_and(|b| b.inverse_field_id == root.field.id)
                && p.field.table_id == lo.linked_table_id
        });
        let Some(partner) = partner.filter(|_| ok) else {
            return Err(AppError::conflict(
                "the field this link pointed back to no longer exists, so it cannot be restored",
            ));
        };
        if tables
            .get(partner.field.table_id.as_str())
            .is_none_or(|t| t.deleted_at.is_some())
        {
            return Err(AppError::conflict("restore the linked table first"));
        }
        match partner.deleted_at {
            Some(t) if t == stamp => members.push(partner.field.id.clone()),
            Some(_) => {
                return Err(AppError::conflict(
                    "the paired link field was deleted separately; restore it first",
                ));
            }
            None => {}
        }
    }

    // Dependents trashed in the same operation.
    let mut member_set: HashSet<String> = members.iter().cloned().collect();
    loop {
        let mut grew = false;
        for r in &all {
            if r.deleted_at == Some(stamp)
                && !member_set.contains(&r.field.id)
                && depends_on(&r.field, &member_set)
                && tables
                    .get(r.field.table_id.as_str())
                    .is_some_and(|t| t.deleted_at.is_none())
            {
                member_set.insert(r.field.id.clone());
                members.push(r.field.id.clone());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    // Drop dependents whose own references are not available.
    loop {
        let dropped = members.iter().position(|id| {
            by_id.get(id.as_str()).is_some_and(|rec| {
                id != &root.field.id && !refs_available(&rec.field, &by_id, &member_set)
            })
        });
        match dropped {
            Some(i) => {
                let id = members.remove(i);
                member_set.remove(&id);
            }
            None => break,
        }
    }
    if !refs_available(&root.field, &by_id, &member_set) {
        return Err(AppError::conflict(
            "restore the fields this field is built on first",
        ));
    }

    // Capacity and names.
    let mut taken: HashMap<String, HashSet<String>> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for r in all.iter().filter(|r| r.deleted_at.is_none()) {
        taken
            .entry(r.field.table_id.clone())
            .or_default()
            .insert(schema::name_key(&r.field.name));
        *counts.entry(r.field.table_id.clone()).or_default() += 1;
    }
    let mut touched = Touched::default();
    for id in &members {
        let f = &by_id
            .get(id.as_str())
            .ok_or_else(|| AppError::internal("restore member vanished"))?
            .field;
        let n = counts.entry(f.table_id.clone()).or_default();
        *n += 1;
        if *n > limits::MAX_FIELDS_PER_TABLE {
            return Err(AppError::bad_request(format!(
                "a table can have at most {} fields",
                limits::MAX_FIELDS_PER_TABLE
            )));
        }
        let set = taken.entry(f.table_id.clone()).or_default();
        let name = if set.contains(&schema::name_key(&f.name)) {
            let head: String = f.name.chars().take(limits::MAX_NAME_LEN - 16).collect();
            schema::uniquify(set, &format!("{head} (restored)"))
        } else {
            f.name.clone()
        };
        set.insert(schema::name_key(&name));
        tx.execute(
            "UPDATE fields SET deleted_at = NULL, name = ?2 WHERE id = ?1",
            params![f.id, name],
        )?;
        touched.add(&f.table_id);
    }

    schema::check_base_acyclic(tx, &table.base_id)?;
    let mut per_table: Vec<(String, Vec<String>)> = Vec::new();
    // Every restored field counts, computed or not: formulas that referenced a
    // restored editable field evaluated to errors while it was gone.
    for id in &members {
        let f = &by_id
            .get(id.as_str())
            .ok_or_else(|| AppError::internal("restore member vanished"))?
            .field;
        match per_table.iter_mut().find(|(t, _)| *t == f.table_id) {
            Some((_, v)) => v.push(f.id.clone()),
            None => per_table.push((f.table_id.clone(), vec![f.id.clone()])),
        }
    }
    run_engine(tx, &table.base_id, &table.id, Vec::new(), per_table)?;
    Ok(RestoreOutcome {
        restored_field_ids: members,
        touched,
    })
}

/// Restore, after the table itself came back, the link fields of other tables
/// that were trashed with it (stamped `stamp`) together with their dependents.
pub fn restore_incoming_links(
    tx: &Transaction,
    table: &TableRow,
    stamp: i64,
) -> AppResult<Touched> {
    let all = schema::base_field_records_all(tx, &table.base_id)?;
    let roots: Vec<String> = all
        .iter()
        .filter(|r| {
            r.deleted_at == Some(stamp)
                && link_options(&r.field).is_some_and(|l| l.linked_table_id == table.id)
        })
        .map(|r| r.field.id.clone())
        .collect();
    let mut touched = Touched::default();
    let mut done: HashSet<String> = HashSet::new();
    for id in roots {
        if done.contains(&id) {
            continue;
        }
        let out = restore(tx, &id)?;
        done.extend(out.restored_field_ids);
        for t in &out.touched.0 {
            touched.add(t);
        }
    }
    Ok(touched)
}

fn base_tables(tx: &Transaction, base_id: &str) -> AppResult<HashMap<String, TableRow>> {
    let mut stmt = tx.prepare("SELECT id FROM tables WHERE base_id = ?1")?;
    let ids: Vec<String> = stmt
        .query_map([base_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut out = HashMap::new();
    for id in ids {
        if let Some(t) = schema::table_any(tx, &id)? {
            out.insert(id, t);
        }
    }
    Ok(out)
}

/// Whether everything `f` points at is live or being restored with it.
fn refs_available(
    f: &Field,
    by_id: &HashMap<&str, &FieldRecord>,
    restoring: &HashSet<String>,
) -> bool {
    let available =
        |id: &str| restoring.contains(id) || by_id.get(id).is_some_and(|r| r.deleted_at.is_none());
    match &f.kind {
        FieldKind::Lookup(o) => available(&o.link_field_id) && available(&o.target_field_id),
        FieldKind::Rollup(o) => available(&o.link_field_id) && available(&o.target_field_id),
        FieldKind::Count(o) => available(&o.link_field_id),
        _ => true,
    }
}
