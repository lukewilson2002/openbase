//! Shared schema plumbing: row <-> DTO mapping for tables, fields and views,
//! name validation and uniqueness, ordering positions, formula reference
//! scanning and the cross-table dependency cycle check.
//!
//! Fields loaded here are in *stored* form (formula expressions reference
//! `{fldXXXX}` ids). Use [`fields_for_client`] before sending them out.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use og_core::api::schema::View;
use og_core::field::{Field, FieldKind};
use og_core::ids::FieldId;
use og_core::limits;
use og_core::view::{ViewConfig, ViewType};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value as Json, json};

use crate::error::{AppError, AppResult};
use crate::store::fields_engine;

// ---------------------------------------------------------------- tables

/// A row of the `tables` table.
#[derive(Debug, Clone)]
pub struct TableRow {
    pub id: String,
    pub base_id: String,
    pub name: String,
    pub description: Option<String>,
    pub position: f64,
    pub primary_field_id: String,
    pub next_autonumber: i64,
    pub deleted_at: Option<i64>,
}

const TABLE_COLS: &str =
    "id, base_id, name, description, position, primary_field_id, next_autonumber, deleted_at";

impl TableRow {
    fn from_row(r: &Row) -> rusqlite::Result<TableRow> {
        Ok(TableRow {
            id: r.get(0)?,
            base_id: r.get(1)?,
            name: r.get(2)?,
            description: r.get(3)?,
            position: r.get(4)?,
            primary_field_id: r.get(5)?,
            next_autonumber: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    }
}

/// A table in any state (live or trashed), if it exists.
pub fn table_any(conn: &Connection, table_id: &str) -> AppResult<Option<TableRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {TABLE_COLS} FROM tables WHERE id = ?1"),
            [table_id],
            TableRow::from_row,
        )
        .optional()?)
}

/// A live table (not trashed). The base itself is not checked here: callers
/// have already resolved access through `perm`.
pub fn live_table(conn: &Connection, table_id: &str) -> AppResult<TableRow> {
    table_any(conn, table_id)?
        .filter(|t| t.deleted_at.is_none())
        .ok_or_else(|| AppError::not_found("table"))
}

/// Live tables of a base in display order.
pub fn live_tables(conn: &Connection, base_id: &str) -> AppResult<Vec<TableRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TABLE_COLS} FROM tables WHERE base_id = ?1 AND deleted_at IS NULL
         ORDER BY position, created_at, id"
    ))?;
    let rows = stmt.query_map([base_id], TableRow::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------------------------------------------------------------- fields

/// A field plus the bookkeeping columns the DTO does not carry.
#[derive(Debug, Clone)]
pub struct FieldRecord {
    pub field: Field,
    pub position: f64,
    pub deleted_at: Option<i64>,
}

const FIELD_COLS: &str = "id, table_id, name, type, options, description, position, deleted_at";

struct RawField {
    id: String,
    table_id: String,
    name: String,
    ty: String,
    options: String,
    description: Option<String>,
    position: f64,
    deleted_at: Option<i64>,
}

impl RawField {
    fn from_row(r: &Row) -> rusqlite::Result<RawField> {
        Ok(RawField {
            id: r.get(0)?,
            table_id: r.get(1)?,
            name: r.get(2)?,
            ty: r.get(3)?,
            options: r.get(4)?,
            description: r.get(5)?,
            position: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    }

    fn parse(self) -> AppResult<FieldRecord> {
        let kind = parse_kind(&self.ty, &self.options)?;
        Ok(FieldRecord {
            field: Field {
                id: self.id,
                table_id: self.table_id,
                name: self.name,
                description: self.description,
                kind,
            },
            position: self.position,
            deleted_at: self.deleted_at,
        })
    }
}

/// Build a [`FieldKind`] from the `type` and `options` columns.
pub fn parse_kind(ty: &str, options: &str) -> AppResult<FieldKind> {
    let opts: Json = serde_json::from_str(options)?;
    serde_json::from_value(json!({ "type": ty, "options": opts }))
        .map_err(|e| AppError::internal(format!("corrupt field definition ({ty}): {e}")))
}

/// The `type` and `options` columns for a [`FieldKind`].
pub fn kind_columns(kind: &FieldKind) -> AppResult<(String, String)> {
    let v = serde_json::to_value(kind)?;
    let ty = v
        .get("type")
        .and_then(Json::as_str)
        .ok_or_else(|| AppError::internal("field kind without a type tag"))?
        .to_string();
    let options = v.get("options").cloned().unwrap_or_else(|| json!({}));
    Ok((ty, options.to_string()))
}

fn query_fields(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> AppResult<Vec<FieldRecord>> {
    let mut stmt = conn.prepare(sql)?;
    let raws = stmt
        .query_map(params, RawField::from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    raws.into_iter().map(RawField::parse).collect()
}

/// A field in any state, if it exists.
pub fn field_any(conn: &Connection, field_id: &str) -> AppResult<Option<FieldRecord>> {
    let mut v = query_fields(
        conn,
        &format!("SELECT {FIELD_COLS} FROM fields WHERE id = ?1"),
        [field_id],
    )?;
    Ok(v.pop())
}

/// A live field of a live table.
pub fn live_field(conn: &Connection, field_id: &str) -> AppResult<FieldRecord> {
    let mut v = query_fields(
        conn,
        "SELECT f.id, f.table_id, f.name, f.type, f.options, f.description, f.position, f.deleted_at
         FROM fields f JOIN tables t ON t.id = f.table_id
         WHERE f.id = ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL",
        [field_id],
    )?;
    v.pop().ok_or_else(|| AppError::not_found("field"))
}

/// Live fields of a table in display order, with bookkeeping.
pub fn table_field_records(conn: &Connection, table_id: &str) -> AppResult<Vec<FieldRecord>> {
    query_fields(
        conn,
        &format!(
            "SELECT {FIELD_COLS} FROM fields WHERE table_id = ?1 AND deleted_at IS NULL
             ORDER BY position, created_at, id"
        ),
        [table_id],
    )
}

/// Live fields of a table in display order.
pub fn table_fields(conn: &Connection, table_id: &str) -> AppResult<Vec<Field>> {
    Ok(table_field_records(conn, table_id)?
        .into_iter()
        .map(|r| r.field)
        .collect())
}

/// Live fields of every live table of a base.
pub fn base_fields(conn: &Connection, base_id: &str) -> AppResult<Vec<Field>> {
    Ok(query_fields(
        conn,
        "SELECT f.id, f.table_id, f.name, f.type, f.options, f.description, f.position, f.deleted_at
         FROM fields f JOIN tables t ON t.id = f.table_id
         WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND f.deleted_at IS NULL
         ORDER BY f.position, f.created_at, f.id",
        [base_id],
    )?
    .into_iter()
    .map(|r| r.field)
    .collect())
}

/// Every field row (live or trashed) of every table of a base, including
/// tables in the trash. Used by trash cascades.
pub fn base_field_records_all(conn: &Connection, base_id: &str) -> AppResult<Vec<FieldRecord>> {
    query_fields(
        conn,
        "SELECT f.id, f.table_id, f.name, f.type, f.options, f.description, f.position, f.deleted_at
         FROM fields f JOIN tables t ON t.id = f.table_id
         WHERE t.base_id = ?1 ORDER BY f.position, f.created_at, f.id",
        [base_id],
    )
}

/// Write a field's `type` and `options` (and name/description/position).
pub fn save_field(conn: &Connection, rec: &Field, position: Option<f64>) -> AppResult<()> {
    let (ty, options) = kind_columns(&rec.kind)?;
    conn.execute(
        "UPDATE fields SET name = ?2, type = ?3, options = ?4, description = ?5,
                position = COALESCE(?6, position)
         WHERE id = ?1",
        params![rec.id, rec.name, ty, options, rec.description, position],
    )?;
    Ok(())
}

/// Insert a new field row.
pub fn insert_field(
    conn: &Connection,
    field: &Field,
    position: f64,
    created_at: i64,
) -> AppResult<()> {
    let (ty, options) = kind_columns(&field.kind)?;
    conn.execute(
        "INSERT INTO fields (id, table_id, name, type, options, description, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            field.id,
            field.table_id,
            field.name,
            ty,
            options,
            field.description,
            position,
            created_at
        ],
    )?;
    Ok(())
}

// ----------------------------------------------------------------- views

/// A row of the `views` table with its ownership columns.
#[derive(Debug, Clone)]
pub struct ViewRow {
    pub view: View,
    pub position: f64,
    /// Set for personal views.
    pub owner_id: Option<String>,
    pub deleted_at: Option<i64>,
}

const VIEW_COLS: &str =
    "id, table_id, name, type, config, position, personal_owner_id, locked, deleted_at";

fn view_from_row(r: &Row) -> rusqlite::Result<(ViewRow, String, String)> {
    let owner: Option<String> = r.get(6)?;
    let locked: bool = r.get(7)?;
    let ty: String = r.get(3)?;
    let config: String = r.get(4)?;
    let row = ViewRow {
        view: View {
            id: r.get(0)?,
            table_id: r.get(1)?,
            name: r.get(2)?,
            view_type: ViewType::Grid,
            config: ViewConfig::default(),
            personal: owner.is_some(),
            locked,
        },
        position: r.get(5)?,
        owner_id: owner,
        deleted_at: r.get(8)?,
    };
    Ok((row, ty, config))
}

fn finish_view((mut row, ty, config): (ViewRow, String, String)) -> AppResult<ViewRow> {
    row.view.view_type = serde_json::from_value(Json::String(ty))
        .map_err(|e| AppError::internal(format!("corrupt view type: {e}")))?;
    row.view.config = serde_json::from_str(&config).unwrap_or_else(|e| {
        tracing::warn!(view = %row.view.id, error = %e, "unreadable view config; using defaults");
        ViewConfig::default()
    });
    Ok(row)
}

/// A view in any state, if it exists.
pub fn view_any(conn: &Connection, view_id: &str) -> AppResult<Option<ViewRow>> {
    let raw = conn
        .query_row(
            &format!("SELECT {VIEW_COLS} FROM views WHERE id = ?1"),
            [view_id],
            view_from_row,
        )
        .optional()?;
    raw.map(finish_view).transpose()
}

/// A live view of a live table.
pub fn live_view(conn: &Connection, view_id: &str) -> AppResult<ViewRow> {
    let raw = conn
        .query_row(
            "SELECT v.id, v.table_id, v.name, v.type, v.config, v.position, v.personal_owner_id,
                    v.locked, v.deleted_at
             FROM views v JOIN tables t ON t.id = v.table_id
             WHERE v.id = ?1 AND v.deleted_at IS NULL AND t.deleted_at IS NULL",
            [view_id],
            view_from_row,
        )
        .optional()?;
    raw.map(finish_view)
        .transpose()?
        .ok_or_else(|| AppError::not_found("view"))
}

/// Live views of a table visible to `user_id`: collaborative views plus the
/// user's own personal views, in display order.
pub fn visible_views(conn: &Connection, table_id: &str, user_id: &str) -> AppResult<Vec<ViewRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VIEW_COLS} FROM views
         WHERE table_id = ?1 AND deleted_at IS NULL
           AND (personal_owner_id IS NULL OR personal_owner_id = ?2)
         ORDER BY position, created_at, id"
    ))?;
    let raws = stmt
        .query_map(params![table_id, user_id], view_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    raws.into_iter().map(finish_view).collect()
}

/// Visible live views of every live table of a base, grouped by table id.
pub fn base_visible_views(
    conn: &Connection,
    base_id: &str,
    user_id: &str,
) -> AppResult<HashMap<String, Vec<ViewRow>>> {
    let mut stmt = conn.prepare(
        "SELECT v.id, v.table_id, v.name, v.type, v.config, v.position, v.personal_owner_id,
                v.locked, v.deleted_at
         FROM views v JOIN tables t ON t.id = v.table_id
         WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND v.deleted_at IS NULL
           AND (v.personal_owner_id IS NULL OR v.personal_owner_id = ?2)
         ORDER BY v.position, v.created_at, v.id",
    )?;
    let raws = stmt
        .query_map(params![base_id, user_id], view_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out: HashMap<String, Vec<ViewRow>> = HashMap::new();
    for raw in raws {
        let row = finish_view(raw)?;
        out.entry(row.view.table_id.clone()).or_default().push(row);
    }
    Ok(out)
}

/// Insert a view row.
pub fn insert_view(
    conn: &Connection,
    view: &View,
    position: f64,
    owner_id: Option<&str>,
    created_by: Option<&str>,
    created_at: i64,
) -> AppResult<()> {
    let ty = serde_json::to_value(view.view_type)?;
    conn.execute(
        "INSERT INTO views (id, table_id, name, type, config, position, personal_owner_id, locked,
                            created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            view.id,
            view.table_id,
            view.name,
            ty.as_str().unwrap_or("grid"),
            serde_json::to_string(&view.config)?,
            position,
            owner_id,
            view.locked,
            created_by,
            created_at
        ],
    )?;
    Ok(())
}

// ------------------------------------------------------------- positions

/// Where a new item is appended.
pub enum PositionScope<'a> {
    BasesIn(&'a str),
    TablesIn(&'a str),
    FieldsIn(&'a str),
    ViewsIn(&'a str),
}

/// `max(position) + 1` among the siblings (trashed ones included, so a
/// restored item never collides with a newer one).
pub fn next_position(conn: &Connection, scope: PositionScope) -> AppResult<f64> {
    let (sql, id) = match scope {
        PositionScope::BasesIn(id) => (
            "SELECT COALESCE(MAX(position), 0) + 1 FROM bases WHERE workspace_id = ?1",
            id,
        ),
        PositionScope::TablesIn(id) => (
            "SELECT COALESCE(MAX(position), 0) + 1 FROM tables WHERE base_id = ?1",
            id,
        ),
        PositionScope::FieldsIn(id) => (
            "SELECT COALESCE(MAX(position), 0) + 1 FROM fields WHERE table_id = ?1",
            id,
        ),
        PositionScope::ViewsIn(id) => (
            "SELECT COALESCE(MAX(position), 0) + 1 FROM views WHERE table_id = ?1",
            id,
        ),
    };
    Ok(conn.query_row(sql, [id], |r| r.get(0))?)
}

/// Validate a client-supplied position.
pub fn validate_position(p: f64) -> AppResult<f64> {
    if p.is_finite() && p.abs() < 1e15 {
        Ok(p)
    } else {
        Err(AppError::bad_request("position must be a finite number"))
    }
}

// ----------------------------------------------------------------- names

/// Trim and validate a user-visible name.
pub fn validate_name(raw: &str, what: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::bad_request(format!(
            "{what} name cannot be empty"
        )));
    }
    if name.chars().count() > limits::MAX_NAME_LEN {
        return Err(AppError::bad_request(format!(
            "{what} name is too long (max {} characters)",
            limits::MAX_NAME_LEN
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::bad_request(format!(
            "{what} name cannot contain control characters"
        )));
    }
    Ok(name.to_string())
}

/// Validate a colour name against the fixed palette.
pub fn validate_color(color: &str) -> AppResult<()> {
    if og_core::field::COLORS.contains(&color) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!("unknown color '{color}'")))
    }
}

/// Normalize optional free text (descriptions, icons): trimmed, empty means
/// "none", bounded length.
pub fn normalize_optional_text(
    raw: Option<&str>,
    max_chars: usize,
    what: &str,
) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let text = raw.trim();
    if text.chars().count() > max_chars {
        return Err(AppError::bad_request(format!(
            "{what} is too long (max {max_chars} characters)"
        )));
    }
    Ok((!text.is_empty()).then(|| text.to_string()))
}

/// Case-insensitive comparison key for names.
pub fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// Set of comparison keys for a collection of names.
pub fn name_keys<'a>(names: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    names.into_iter().map(name_key).collect()
}

/// `base`, or `base 2`, `base 3`, ... whichever is the first not in `taken`
/// (a set of [`name_key`]s). The result never exceeds `MAX_NAME_LEN`.
pub fn uniquify(taken: &HashSet<String>, base: &str) -> String {
    let fit = |suffix: &str| -> String {
        let room = limits::MAX_NAME_LEN.saturating_sub(suffix.chars().count());
        let head: String = base.chars().take(room).collect();
        format!("{head}{suffix}")
    };
    let first = fit("");
    if !taken.contains(&name_key(&first)) {
        return first;
    }
    (2..)
        .map(|n| fit(&format!(" {n}")))
        .find(|c| !taken.contains(&name_key(c)))
        .unwrap_or(first)
}

// ------------------------------------------------------ formula references

static FIELD_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{(fld[0-9A-Za-z]+)\}").expect("static regex is valid"));

/// Field ids referenced in a stored expression (`{fldXXXX}` tokens).
pub fn stored_refs(expression: &str) -> Vec<FieldId> {
    FIELD_REF
        .captures_iter(expression)
        .map(|c| c[1].to_string())
        .collect()
}

/// Field ids a field's own expression references (formula and button only;
/// lookups/rollups/counts are structural and handled by the graph itself).
pub fn field_refs(field: &Field) -> Vec<FieldId> {
    match &field.kind {
        FieldKind::Formula(o) => stored_refs(&o.expression),
        FieldKind::Button(o) => stored_refs(&o.url_formula),
        _ => Vec::new(),
    }
}

/// Rewrite `{fldXXXX}` references in a stored expression through `map`
/// (unmapped ids are left as they are).
pub fn remap_stored_refs(expression: &str, map: &HashMap<String, String>) -> String {
    FIELD_REF
        .replace_all(expression, |c: &regex::Captures| match map.get(&c[1]) {
            Some(new) => format!("{{{new}}}"),
            None => c[0].to_string(),
        })
        .into_owned()
}

/// Reject the schema if any computed fields of the base depend on each other
/// in a circle. Runs over all live fields of all live tables of the base.
pub fn check_base_acyclic(conn: &Connection, base_id: &str) -> AppResult<()> {
    let fields = base_fields(conn, base_id)?;
    let primary: HashMap<String, String> = live_tables(conn, base_id)?
        .into_iter()
        .map(|t| (t.id, t.primary_field_id))
        .collect();
    // The engine's graph: field dependencies plus "a link shows the linked
    // records' primary text" edges, so circles through those are caught too.
    let graph = crate::engine::recompute::build_graph(&fields, &primary);
    graph.check_acyclic().map_err(|path| {
        let names: HashMap<&str, &str> = fields
            .iter()
            .map(|f| (f.id.as_str(), f.name.as_str()))
            .collect();
        let shown: Vec<&str> = path
            .iter()
            .map(|id| {
                let id = crate::engine::recompute::virtual_link(id).unwrap_or(id);
                names.get(id).copied().unwrap_or("?")
            })
            .collect();
        AppError::bad_request(format!(
            "this change would create a circular dependency ({})",
            shown.join(" -> ")
        ))
    })
}

// ------------------------------------------------------- client rendering

/// A field as shown to clients: expressions in display form.
pub fn field_for_client(field: &Field, table_fields: &[Field]) -> Field {
    let mut out = field.clone();
    match &mut out.kind {
        FieldKind::Formula(o) => {
            o.expression = fields_engine::display_formula(&o.expression, table_fields)
        }
        FieldKind::Rollup(o) => {
            o.expression = fields_engine::display_formula(&o.expression, table_fields)
        }
        FieldKind::Button(o) => {
            o.url_formula = fields_engine::display_formula(&o.url_formula, table_fields)
        }
        _ => {}
    }
    out
}

/// All fields of one table in client form.
pub fn fields_for_client(table_fields: &[Field]) -> Vec<Field> {
    table_fields
        .iter()
        .map(|f| field_for_client(f, table_fields))
        .collect()
}

/// Ids of tables touched by a schema change, for event publishing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Touched(pub Vec<String>);

impl Touched {
    pub fn of(table_id: &str) -> Touched {
        Touched(vec![table_id.to_string()])
    }
    pub fn add(&mut self, table_id: &str) {
        if !self.0.iter().any(|t| t == table_id) {
            self.0.push(table_id.to_string());
        }
    }
    /// The table id to put in a `SchemaChanged` event: the single touched
    /// table, or None (refetch everything) when several were.
    pub fn event_table(&self) -> Option<String> {
        (self.0.len() == 1).then(|| self.0[0].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(validate_name("  Hello ", "field").unwrap(), "Hello");
        assert!(validate_name("   ", "field").is_err());
        assert!(validate_name("a\nb", "field").is_err());
        assert!(validate_name(&"x".repeat(limits::MAX_NAME_LEN), "field").is_ok());
        assert!(validate_name(&"x".repeat(limits::MAX_NAME_LEN + 1), "field").is_err());
        // multi-byte characters count as one
        assert!(validate_name(&"é".repeat(limits::MAX_NAME_LEN), "field").is_ok());
    }

    #[test]
    fn uniquify_appends_counter_case_insensitively() {
        let taken = name_keys(["Name", "name 2"]);
        assert_eq!(uniquify(&taken, "Other"), "Other");
        assert_eq!(uniquify(&taken, "NAME"), "NAME 3");
        let long = "x".repeat(limits::MAX_NAME_LEN);
        let taken = name_keys([long.as_str()]);
        let u = uniquify(&taken, &long);
        assert_eq!(u.chars().count(), limits::MAX_NAME_LEN);
        assert!(u.ends_with(" 2"));
    }

    #[test]
    fn stored_refs_and_remap() {
        let e = "{fldAbc123} + {fldDef456} + {Not A Ref} + {fld}";
        assert_eq!(stored_refs(e), vec!["fldAbc123", "fldDef456"]);
        let mut map = HashMap::new();
        map.insert("fldAbc123".to_string(), "fldNEW".to_string());
        assert_eq!(
            remap_stored_refs(e, &map),
            "{fldNEW} + {fldDef456} + {Not A Ref} + {fld}"
        );
    }

    #[test]
    fn kind_columns_round_trip() {
        let kind = FieldKind::Rating(Default::default());
        let (ty, opts) = kind_columns(&kind).unwrap();
        assert_eq!(ty, "rating");
        assert_eq!(parse_kind(&ty, &opts).unwrap(), kind);
        let (ty, opts) = kind_columns(&FieldKind::Email(og_core::field::Empty {})).unwrap();
        assert_eq!((ty.as_str(), opts.as_str()), ("email", "{}"));
    }

    #[test]
    fn position_validation() {
        assert!(validate_position(1.5).is_ok());
        assert!(validate_position(f64::NAN).is_err());
        assert!(validate_position(f64::INFINITY).is_err());
    }

    #[test]
    fn touched_event_table() {
        let mut t = Touched::of("tbl1");
        assert_eq!(t.event_table().as_deref(), Some("tbl1"));
        t.add("tbl1");
        assert_eq!(t.0.len(), 1);
        t.add("tbl2");
        assert_eq!(t.event_table(), None);
    }
}
