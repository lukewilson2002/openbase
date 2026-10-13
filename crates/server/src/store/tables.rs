//! Tables: create (with primary field and default view), rename, reorder,
//! trash, duplicate, and the client-facing table DTO.

use og_core::api::schema::{DuplicateTable, Table, UpdateTable, View};
use og_core::field::{Field, FieldKind, TextOptions};
use og_core::limits;
use og_core::view::{ViewConfig, ViewType};
use rusqlite::{Connection, Transaction, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::schema::{self, PositionScope, TableRow, Touched};
use crate::store::{duplicate, fields};

/// Name of the primary field every new table starts with.
pub const PRIMARY_FIELD_NAME: &str = "Name";
/// Name of the grid view every new table starts with.
pub const DEFAULT_VIEW_NAME: &str = "Grid view";

fn live_table_names(
    conn: &Connection,
    base_id: &str,
    except_id: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM tables WHERE base_id = ?1 AND deleted_at IS NULL AND id IS NOT ?2",
    )?;
    let rows = stmt.query_map(params![base_id, except_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Fail with 409 when a live table of the base already uses `name`
/// (case-insensitively).
pub fn ensure_name_free(
    conn: &Connection,
    base_id: &str,
    name: &str,
    except_id: Option<&str>,
) -> AppResult<()> {
    let names = live_table_names(conn, base_id, except_id)?;
    let keys = schema::name_keys(names.iter().map(String::as_str));
    if keys.contains(&schema::name_key(name)) {
        return Err(AppError::conflict(format!(
            "a table named '{name}' already exists in this base"
        )));
    }
    Ok(())
}

/// A table name not used by any live table of the base: `base`, or `base 2`...
pub fn free_name(conn: &Connection, base_id: &str, wanted: &str) -> AppResult<String> {
    let names = live_table_names(conn, base_id, None)?;
    Ok(schema::uniquify(
        &schema::name_keys(names.iter().map(String::as_str)),
        wanted,
    ))
}

/// Create a table with its primary single-line-text field "Name" and a grid
/// view "Grid view". Used by base and table creation.
pub fn create(tx: &Transaction, base_id: &str, name: &str, user_id: &str) -> AppResult<TableRow> {
    let name = schema::validate_name(name, "table")?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM tables WHERE base_id = ?1 AND deleted_at IS NULL",
        [base_id],
        |r| r.get(0),
    )?;
    if count as usize >= limits::MAX_TABLES_PER_BASE {
        return Err(AppError::bad_request(format!(
            "a base can have at most {} tables",
            limits::MAX_TABLES_PER_BASE
        )));
    }
    ensure_name_free(tx, base_id, &name, None)?;

    let now = now_ms();
    let table_id = new_id(og_core::ids::TABLE);
    let primary_id = new_id(og_core::ids::FIELD);
    let position = schema::next_position(tx, PositionScope::TablesIn(base_id))?;
    tx.execute(
        "INSERT INTO tables (id, base_id, name, position, primary_field_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![table_id, base_id, name, position, primary_id, now],
    )?;
    let primary = Field {
        id: primary_id,
        table_id: table_id.clone(),
        name: PRIMARY_FIELD_NAME.to_string(),
        description: None,
        kind: FieldKind::SingleLineText(TextOptions::default()),
    };
    schema::insert_field(tx, &primary, 1.0, now)?;
    let view = View {
        id: new_id(og_core::ids::VIEW),
        table_id: table_id.clone(),
        name: DEFAULT_VIEW_NAME.to_string(),
        view_type: ViewType::Grid,
        config: ViewConfig::default(),
        personal: false,
        locked: false,
    };
    schema::insert_view(tx, &view, 1.0, None, Some(user_id), now)?;
    schema::live_table(tx, &table_id)
}

/// Apply a rename / description / position update.
pub fn update(tx: &Transaction, table_id: &str, patch: &UpdateTable) -> AppResult<TableRow> {
    let table = schema::live_table(tx, table_id)?;
    if let Some(name) = &patch.name {
        let name = schema::validate_name(name, "table")?;
        ensure_name_free(tx, &table.base_id, &name, Some(table_id))?;
        tx.execute(
            "UPDATE tables SET name = ?2 WHERE id = ?1",
            params![table_id, name],
        )?;
    }
    if let Some(desc) = &patch.description {
        let desc = schema::normalize_optional_text(
            Some(desc),
            limits::MAX_DESCRIPTION_LEN,
            "description",
        )?;
        tx.execute(
            "UPDATE tables SET description = ?2 WHERE id = ?1",
            params![table_id, desc],
        )?;
    }
    if let Some(pos) = patch.position {
        let pos = schema::validate_position(pos)?;
        tx.execute(
            "UPDATE tables SET position = ?2 WHERE id = ?1",
            params![table_id, pos],
        )?;
    }
    schema::live_table(tx, table_id)
}

/// Move a table to the trash. The last live table of a base cannot be deleted.
/// Link fields in other tables that point at it go to the trash with it (as do
/// the lookups/rollups/counts built on them), so no live field ever references
/// a trashed table; restoring the table brings them back.
pub fn soft_delete(tx: &Transaction, table_id: &str) -> AppResult<Touched> {
    let table = schema::live_table(tx, table_id)?;
    let live: i64 = tx.query_row(
        "SELECT count(*) FROM tables WHERE base_id = ?1 AND deleted_at IS NULL",
        [&table.base_id],
        |r| r.get(0),
    )?;
    if live <= 1 {
        return Err(AppError::conflict(
            "a base must keep at least one table; create another before deleting this one",
        ));
    }
    let now = now_ms();
    tx.execute(
        "UPDATE tables SET deleted_at = ?2 WHERE id = ?1",
        params![table_id, now],
    )?;
    let mut touched = Touched::of(table_id);
    for other in fields::cascade_delete_incoming_links(tx, &table, now)?.0 {
        touched.add(&other);
    }
    Ok(touched)
}

/// The table as sent to clients: fields (expressions in display form) and the
/// views visible to `user_id`.
pub fn to_dto(conn: &Connection, table: &TableRow, user_id: &str) -> AppResult<Table> {
    let stored = schema::table_fields(conn, &table.id)?;
    let views = schema::visible_views(conn, &table.id, user_id)?
        .into_iter()
        .map(|v| v.view)
        .collect();
    Ok(Table {
        id: table.id.clone(),
        base_id: table.base_id.clone(),
        name: table.name.clone(),
        description: table.description.clone(),
        primary_field_id: table.primary_field_id.clone(),
        fields: schema::fields_for_client(&stored),
        views,
    })
}

/// Copy a table (schema, views and, optionally, records) within its base.
pub fn duplicate(
    tx: &Transaction,
    table_id: &str,
    req: &DuplicateTable,
    user_id: &str,
) -> AppResult<(TableRow, Touched)> {
    let source = schema::live_table(tx, table_id)?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM tables WHERE base_id = ?1 AND deleted_at IS NULL",
        [&source.base_id],
        |r| r.get(0),
    )?;
    if count as usize >= limits::MAX_TABLES_PER_BASE {
        return Err(AppError::bad_request(format!(
            "a base can have at most {} tables",
            limits::MAX_TABLES_PER_BASE
        )));
    }
    let wanted = match &req.name {
        Some(n) => schema::validate_name(n, "table")?,
        None => format!("{} copy", source.name),
    };
    let name = match &req.name {
        Some(_) => {
            ensure_name_free(tx, &source.base_id, &wanted, None)?;
            wanted
        }
        None => free_name(tx, &source.base_id, &wanted)?,
    };
    let copy = duplicate::copy_tables(
        tx,
        &duplicate::CopyRequest {
            sources: vec![source.clone()],
            dest_base_id: source.base_id.clone(),
            table_names: Some(vec![name]),
            include_records: req.include_records,
            user_id: user_id.to_string(),
        },
    )?;
    let new_id = copy
        .table_ids
        .first()
        .ok_or_else(|| AppError::internal("duplicate produced no table"))?;
    let mut touched = Touched::of(new_id);
    for t in &copy.touched_tables {
        touched.add(t);
    }
    Ok((schema::live_table(tx, new_id)?, touched))
}
