//! Bases: create (with a starter table unless asked for an empty base),
//! schema view, update, trash, duplicate, the members who can open a base and
//! collaborators.

use std::collections::HashMap;

use ob_core::api::schema::{BaseSchema, Table};
use ob_core::api::workspaces::{Collaborator, CreateBase, DuplicateBase, Member, UpdateBase};
use ob_core::field::{Field, FieldKind, LongTextOptions};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm::Role;
use crate::store::schema::{self, PositionScope};
use crate::store::{duplicate, tables, workspaces};

/// Colour of a base created without one.
pub const DEFAULT_COLOR: &str = "blue";
/// Name of the table every new base starts with.
pub const FIRST_TABLE_NAME: &str = "Table 1";

/// A row of the `bases` table.
#[derive(Debug, Clone)]
pub struct BaseRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
    pub position: f64,
    pub deleted_at: Option<i64>,
}

const BASE_COLS: &str = "id, workspace_id, name, color, icon, position, deleted_at";

impl BaseRow {
    fn from_row(r: &Row) -> rusqlite::Result<BaseRow> {
        Ok(BaseRow {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            color: r.get(3)?,
            icon: r.get(4)?,
            position: r.get(5)?,
            deleted_at: r.get(6)?,
        })
    }
}

/// A base in any state, if it exists.
pub fn base_any(conn: &Connection, base_id: &str) -> AppResult<Option<BaseRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {BASE_COLS} FROM bases WHERE id = ?1"),
            [base_id],
            BaseRow::from_row,
        )
        .optional()?)
}

/// A live base.
pub fn live_base(conn: &Connection, base_id: &str) -> AppResult<BaseRow> {
    base_any(conn, base_id)?
        .filter(|b| b.deleted_at.is_none())
        .ok_or_else(|| AppError::not_found("base"))
}

/// Live bases of a workspace in display order.
pub fn live_bases_in(conn: &Connection, workspace_id: &str) -> AppResult<Vec<BaseRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BASE_COLS} FROM bases WHERE workspace_id = ?1 AND deleted_at IS NULL
         ORDER BY position, created_at, id"
    ))?;
    let rows = stmt.query_map([workspace_id], BaseRow::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Create a base in `workspace_id`, by default with a starter table "Table 1"
/// (primary field "Name", a long-text field "Notes" and a grid view "Grid
/// view"); with `empty: true`, without tables. A creator limited to some
/// bases gets the new base on their list.
pub fn create(
    tx: &Transaction,
    workspace_id: &str,
    input: &CreateBase,
    user_id: &str,
) -> AppResult<BaseRow> {
    let name = schema::validate_name(&input.name, "base")?;
    let color = input.color.clone().unwrap_or_else(|| DEFAULT_COLOR.into());
    schema::validate_color(&color)?;
    let icon = schema::icon_on_create(input.icon.as_deref())?;
    let id = new_id(ob_core::ids::BASE);
    let position = schema::next_position(tx, PositionScope::BasesIn(workspace_id))?;
    tx.execute(
        "INSERT INTO bases (id, workspace_id, name, color, icon, position, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            workspace_id,
            name,
            color,
            icon,
            position,
            user_id,
            now_ms()
        ],
    )?;
    workspaces::add_new_base_for_creator(tx, workspace_id, user_id, &id)?;
    if input.empty == Some(true) {
        return live_base(tx, &id);
    }
    let table = tables::create(tx, &id, FIRST_TABLE_NAME, None, user_id)?;
    let notes = Field {
        id: new_id(ob_core::ids::FIELD),
        table_id: table.id.clone(),
        name: "Notes".into(),
        description: None,
        kind: FieldKind::LongText(LongTextOptions::default()),
    };
    schema::insert_field(tx, &notes, 2.0, now_ms())?;
    live_base(tx, &id)
}

/// Everything the client needs to render a base: tables and fields in
/// position order, views visible to `user_id`, and the caller's `role`.
pub fn schema(
    conn: &Connection,
    base: &BaseRow,
    user_id: &str,
    role: Role,
) -> AppResult<BaseSchema> {
    let table_rows = schema::live_tables(conn, &base.id)?;
    let mut fields_by_table: HashMap<String, Vec<Field>> = HashMap::new();
    for f in schema::base_fields(conn, &base.id)? {
        fields_by_table
            .entry(f.table_id.clone())
            .or_default()
            .push(f);
    }
    let mut views_by_table = schema::base_visible_views(conn, &base.id, user_id)?;
    let mut out = Vec::with_capacity(table_rows.len());
    for t in table_rows {
        let stored = fields_by_table.remove(&t.id).unwrap_or_default();
        out.push(Table {
            id: t.id.clone(),
            base_id: t.base_id.clone(),
            name: t.name.clone(),
            icon: t.icon.clone(),
            description: t.description.clone(),
            primary_field_id: t.primary_field_id.clone(),
            fields: schema::fields_for_client(&stored),
            views: views_by_table
                .remove(&t.id)
                .unwrap_or_default()
                .into_iter()
                .map(|v| v.view)
                .collect(),
        });
    }
    let (workspace_name, workspace_color) = conn.query_row(
        "SELECT name, color FROM workspaces WHERE id = ?1",
        [&base.workspace_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(BaseSchema {
        id: base.id.clone(),
        workspace_id: base.workspace_id.clone(),
        name: base.name.clone(),
        color: base.color.clone(),
        icon: base.icon.clone(),
        role: role.as_str().to_string(),
        tables: out,
        people: workspaces::people_for_base(conn, base)?,
        workspace_name,
        workspace_color,
    })
}

/// Apply a rename / colour / icon / position update.
pub fn update(tx: &Transaction, base_id: &str, patch: &UpdateBase) -> AppResult<BaseRow> {
    live_base(tx, base_id)?;
    let icon = schema::icon_patch(&patch.icon)?;
    if let Some(name) = &patch.name {
        let name = schema::validate_name(name, "base")?;
        tx.execute(
            "UPDATE bases SET name = ?2 WHERE id = ?1",
            params![base_id, name],
        )?;
    }
    if let Some(color) = &patch.color {
        schema::validate_color(color)?;
        tx.execute(
            "UPDATE bases SET color = ?2 WHERE id = ?1",
            params![base_id, color],
        )?;
    }
    if let Some(icon) = icon {
        tx.execute(
            "UPDATE bases SET icon = ?2 WHERE id = ?1",
            params![base_id, icon],
        )?;
    }
    if let Some(pos) = patch.position {
        let pos = schema::validate_position(pos)?;
        tx.execute(
            "UPDATE bases SET position = ?2 WHERE id = ?1",
            params![base_id, pos],
        )?;
    }
    live_base(tx, base_id)
}

/// Move a base to the trash.
pub fn soft_delete(tx: &Transaction, base_id: &str) -> AppResult<()> {
    let n = tx.execute(
        "UPDATE bases SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![base_id, now_ms()],
    )?;
    if n == 0 {
        return Err(AppError::not_found("base"));
    }
    Ok(())
}

/// Deep-copy a base into the same workspace; returns the new base.
pub fn duplicate(
    tx: &Transaction,
    base_id: &str,
    req: &DuplicateBase,
    user_id: &str,
) -> AppResult<BaseRow> {
    let source = live_base(tx, base_id)?;
    let name = match &req.name {
        Some(n) => schema::validate_name(n, "base")?,
        None => {
            let head: String = source
                .name
                .chars()
                .take(ob_core::limits::MAX_NAME_LEN - " copy".len())
                .collect();
            format!("{head} copy")
        }
    };
    let id = new_id(ob_core::ids::BASE);
    let position = schema::next_position(tx, PositionScope::BasesIn(&source.workspace_id))?;
    tx.execute(
        "INSERT INTO bases (id, workspace_id, name, color, icon, position, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            source.workspace_id,
            name,
            source.color,
            source.icon,
            position,
            user_id,
            now_ms()
        ],
    )?;
    workspaces::add_new_base_for_creator(tx, &source.workspace_id, user_id, &id)?;
    duplicate::copy_tables(
        tx,
        &duplicate::CopyRequest {
            sources: schema::live_tables(tx, base_id)?,
            dest_base_id: id.clone(),
            table_names: None,
            include_records: req.include_records,
            user_id: user_id.to_string(),
        },
    )?;
    live_base(tx, &id)
}

// ---------------------------------------------------------------- members

/// Workspace members who can open the base, oldest member first.
pub fn members(conn: &Connection, base: &BaseRow) -> AppResult<Vec<Member>> {
    Ok(workspaces::members(conn, &base.workspace_id)?
        .into_iter()
        .filter(|m| m.all_bases || m.base_ids.contains(&base.id))
        .collect())
}

/// Take the base off a limited member's list (see
/// [`workspaces::remove_listed_base`]).
pub fn remove_member(tx: &Transaction, base: &BaseRow, user_id: &str) -> AppResult<()> {
    workspaces::remove_listed_base(tx, &base.workspace_id, user_id, &base.id)
}

/// Active users who can open the base, by name.
pub fn collaborators(conn: &Connection, base: &BaseRow) -> AppResult<Vec<Collaborator>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT u.id, u.name, u.email FROM users u
         JOIN workspace_members m ON m.user_id = u.id
         JOIN bases b ON b.workspace_id = m.workspace_id
         WHERE u.is_active = 1 AND b.id = ?1 AND {}
         ORDER BY u.name COLLATE NOCASE, u.id",
        crate::perm::MEMBER_CAN_OPEN_BASE
    ))?;
    let rows = stmt.query_map(params![base.id], |r| {
        Ok(Collaborator {
            id: r.get(0)?,
            name: r.get(1)?,
            email: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
