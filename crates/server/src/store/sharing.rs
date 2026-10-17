//! Share links: storage, resolution of a public token to the thing it
//! exposes, and the field-level rules of what a public viewer may see.
//!
//! A link is *live* only while it is enabled and its view, table, base and
//! workspace are all live. Everything else resolves to "not found", exactly as
//! a token that never existed does.
//!
//! What a public viewer sees (see also `ob_core::api::sharing`):
//! - view shares expose the fields the view shows: all live fields minus
//!   `hidden_fields`, in `field_order` then table order ([`visible_fields`]);
//! - form shares expose the form's fields that exist, are editable and are
//!   not hidden ([`form_fields`]). Link and user fields are never part of a
//!   public form: filling them needs a record or collaborator picker, which
//!   would expose other tables' data.

use std::collections::{BTreeMap, HashMap, HashSet};

use ob_core::api::records::Record;
use ob_core::api::sharing::{PublicField, PublicRecord, PublicViewConfig, ShareKind, ShareLink};
use ob_core::field::{Field, FieldKind};
use ob_core::view::{FormField, ViewConfig, ViewType};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde_json::{Value as Json, json};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::{new_id, new_token};
use crate::store::schema::{self, TableRow, ViewRow};

/// Prefix of share tokens (they appear in URLs).
pub const TOKEN_PREFIX: &str = "shr_";
/// Share links per view.
pub const MAX_SHARES_PER_VIEW: usize = 20;
/// Longest accepted token in a URL; longer ones cannot exist.
pub const MAX_TOKEN_LEN: usize = 128;

/// A row of `share_links`.
#[derive(Debug, Clone)]
pub struct ShareRow {
    pub id: String,
    pub token: String,
    pub kind: ShareKind,
    pub view_id: String,
    pub password_hash: Option<String>,
    pub enabled: bool,
    pub created_by: Option<String>,
    pub created_at: i64,
}

const COLS: &str = "id, token, kind, view_id, password_hash, enabled, created_by, created_at";

fn from_row(r: &Row) -> rusqlite::Result<ShareRow> {
    let kind: String = r.get(2)?;
    Ok(ShareRow {
        id: r.get(0)?,
        token: r.get(1)?,
        // Unknown kinds cannot be written by this code; treat as view (read-only)
        // rather than failing the whole listing.
        kind: ShareKind::parse(&kind).unwrap_or(ShareKind::View),
        view_id: r.get(3)?,
        password_hash: r.get(4)?,
        enabled: r.get(5)?,
        created_by: r.get(6)?,
        created_at: r.get(7)?,
    })
}

impl ShareRow {
    /// The management DTO. `public_url` is the configured public URL.
    pub fn to_dto(&self, public_url: &str) -> ShareLink {
        let path = match self.kind {
            ShareKind::View => format!("/s/{}", self.token),
            ShareKind::Form => format!("/f/{}", self.token),
        };
        ShareLink {
            id: self.id.clone(),
            view_id: self.view_id.clone(),
            kind: self.kind,
            token: self.token.clone(),
            url: format!("{}{}", public_url.trim_end_matches('/'), path),
            path,
            enabled: self.enabled,
            has_password: self.password_hash.is_some(),
            created_by: self.created_by.clone(),
            created_at: self.created_at,
        }
    }
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<ShareRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM share_links WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

/// Shares of a view, oldest first.
pub fn list_for_view(conn: &Connection, view_id: &str) -> AppResult<Vec<ShareRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM share_links WHERE view_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([view_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Whether a view may carry a share of `kind`: forms only on form views,
/// read-only shares only on the other view types. Personal views cannot be
/// shared (they belong to one user and can vanish with them).
pub fn ensure_shareable(view: &ViewRow, kind: ShareKind) -> AppResult<()> {
    if view.owner_id.is_some() {
        return Err(AppError::bad_request("personal views cannot be shared"));
    }
    match (kind, view.view.view_type) {
        (ShareKind::Form, ViewType::Form) => Ok(()),
        (ShareKind::Form, _) => Err(AppError::bad_request(
            "form links can only be created for form views",
        )),
        (ShareKind::View, ViewType::Form) => Err(AppError::bad_request(
            "a form view is shared as a form link, not a read-only view",
        )),
        (ShareKind::View, _) => Ok(()),
    }
}

pub fn create(
    tx: &Transaction,
    view_id: &str,
    kind: ShareKind,
    password_hash: Option<String>,
    user_id: &str,
) -> AppResult<ShareRow> {
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM share_links WHERE view_id = ?1",
        [view_id],
        |r| r.get(0),
    )?;
    if n as usize >= MAX_SHARES_PER_VIEW {
        return Err(AppError::bad_request(format!(
            "a view can have at most {MAX_SHARES_PER_VIEW} share links; delete one first"
        )));
    }
    let row = ShareRow {
        id: new_id(ob_core::ids::SHARE),
        token: new_token(TOKEN_PREFIX),
        kind,
        view_id: view_id.to_string(),
        password_hash,
        enabled: true,
        created_by: Some(user_id.to_string()),
        created_at: now_ms(),
    };
    tx.execute(
        "INSERT INTO share_links (id, token, kind, view_id, password_hash, enabled, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
        params![
            row.id,
            row.token,
            kind.as_str(),
            row.view_id,
            row.password_hash,
            row.created_by,
            row.created_at
        ],
    )?;
    Ok(row)
}

/// Apply a patch. `password` follows [`ob_core::api::sharing::UpdateShare`]:
/// `None` keeps it, `Some(None)` removes it, `Some(Some(hash))` replaces it.
pub fn update(
    tx: &Transaction,
    id: &str,
    enabled: Option<bool>,
    password_hash: Option<Option<String>>,
) -> AppResult<ShareRow> {
    if let Some(on) = enabled {
        tx.execute(
            "UPDATE share_links SET enabled = ?2 WHERE id = ?1",
            params![id, on],
        )?;
    }
    if let Some(hash) = password_hash {
        tx.execute(
            "UPDATE share_links SET password_hash = ?2 WHERE id = ?1",
            params![id, hash],
        )?;
    }
    get(tx, id)?.ok_or_else(|| AppError::not_found("share link"))
}

pub fn delete(tx: &Transaction, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM share_links WHERE id = ?1", [id])?;
    Ok(())
}

// ----------------------------------------------------------- resolution

/// A live share together with what it exposes.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub share: ShareRow,
    pub view: ViewRow,
    pub table: TableRow,
    pub base_name: String,
    pub base_icon: Option<String>,
}

/// The live share of `kind` with `token`; anything else is a 404: unknown
/// token, other kind, disabled link, deleted view/table/base/workspace.
pub fn resolve(conn: &Connection, token: &str, kind: ShareKind) -> AppResult<Resolved> {
    let not_found = || AppError::not_found("share link");
    if token.is_empty() || token.len() > MAX_TOKEN_LEN {
        return Err(not_found());
    }
    let share = conn
        .query_row(
            &format!("SELECT {COLS} FROM share_links WHERE token = ?1"),
            [token],
            from_row,
        )
        .optional()?
        .filter(|s| s.enabled && s.kind == kind)
        .ok_or_else(not_found)?;
    let view = schema::live_view(conn, &share.view_id).map_err(|_| not_found())?;
    if view.owner_id.is_some() {
        return Err(not_found());
    }
    let table = schema::live_table(conn, &view.view.table_id).map_err(|_| not_found())?;
    let (base_name, base_icon): (String, Option<String>) = conn
        .query_row(
            "SELECT b.name, b.icon FROM bases b JOIN workspaces w ON w.id = b.workspace_id
             WHERE b.id = ?1 AND b.deleted_at IS NULL AND w.deleted_at IS NULL",
            [&table.base_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(not_found)?;
    Ok(Resolved {
        share,
        view,
        table,
        base_name,
        base_icon,
    })
}

// ------------------------------------------------------- visible fields

/// The fields a view shows, in display order: `field_order` first (ids that
/// are not live fields are skipped), then the remaining visible fields in
/// table order. Hidden fields are never included.
pub fn visible_fields(config: &ViewConfig, fields: &[Field]) -> Vec<Field> {
    let hidden: HashSet<&str> = config.hidden_fields.iter().map(String::as_str).collect();
    let by_id: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<Field> = Vec::new();
    for id in &config.field_order {
        if hidden.contains(id.as_str()) || !seen.insert(id.as_str()) {
            continue;
        }
        if let Some(f) = by_id.get(id.as_str()) {
            out.push((*f).clone());
        }
    }
    for f in fields {
        if !hidden.contains(f.id.as_str()) && seen.insert(f.id.as_str()) {
            out.push(f.clone());
        }
    }
    out
}

/// A field a public form can collect: editable, not hidden, and not a link or
/// user field (those need pickers over other data).
pub fn is_public_form_type(field: &Field) -> bool {
    !field.field_type().is_computed()
        && !matches!(field.kind, FieldKind::Link(_) | FieldKind::User(_))
}

/// The form's inputs: entries of `config.form.fields` whose field is live,
/// collectable and not hidden in the view, in form order (first mention wins).
pub fn form_fields(config: &ViewConfig, fields: &[Field]) -> Vec<(FormField, Field)> {
    let hidden: HashSet<&str> = config.hidden_fields.iter().map(String::as_str).collect();
    let by_id: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in &config.form.fields {
        if hidden.contains(entry.field_id.as_str()) || !seen.insert(entry.field_id.as_str()) {
            continue;
        }
        if let Some(f) = by_id.get(entry.field_id.as_str())
            && is_public_form_type(f)
        {
            out.push((entry.clone(), (*f).clone()));
        }
    }
    out
}

// ------------------------------------------------------ public rendering

/// The `options` object of a field without internals (formulas, ids of other
/// fields or tables). See [`PublicField`].
pub fn public_options(field: &Field) -> Json {
    let full = serde_json::to_value(field).unwrap_or(Json::Null);
    let options = full.get("options").cloned().unwrap_or_else(|| json!({}));
    let pick = |keys: &[&str]| -> Json {
        let mut out = serde_json::Map::new();
        for k in keys {
            if let Some(v) = options.get(*k) {
                out.insert((*k).to_string(), v.clone());
            }
        }
        Json::Object(out)
    };
    match &field.kind {
        FieldKind::Formula(_) | FieldKind::Rollup(_) => pick(&["format", "result_type"]),
        FieldKind::Lookup(_) => pick(&["result_type"]),
        FieldKind::Count(_) => json!({}),
        FieldKind::Button(_) => pick(&["label"]),
        FieldKind::Link(_) => pick(&["single"]),
        FieldKind::LastModifiedTime(_) | FieldKind::LastModifiedBy(_) => pick(&["date"]),
        _ => options,
    }
}

pub fn public_field(field: &Field) -> PublicField {
    PublicField {
        id: field.id.clone(),
        name: field.name.clone(),
        description: field.description.clone(),
        field_type: field.field_type(),
        options: public_options(field),
    }
}

/// Layout-relevant parts of a view config, restricted to `visible` field ids.
pub fn public_config(config: &ViewConfig, visible: &HashSet<&str>) -> PublicViewConfig {
    let keep = |id: &Option<String>| -> Option<String> {
        id.clone().filter(|i| visible.contains(i.as_str()))
    };
    PublicViewConfig {
        field_widths: config
            .field_widths
            .iter()
            .filter(|(id, _)| visible.contains(id.as_str()))
            .map(|(k, v)| (k.clone(), *v))
            .collect::<BTreeMap<_, _>>(),
        frozen_columns: config.frozen_columns,
        kanban_stack_field_id: keep(&config.kanban.stack_field_id),
        kanban_cover_field_id: keep(&config.kanban.cover_field_id),
        description_field_id: keep(&config.description_field_id),
        kanban_hide_empty_stacks: config.kanban.hide_empty_stacks,
        gallery_cover_field_id: keep(&config.gallery.cover_field_id),
        calendar_date_field_id: keep(&config.calendar.date_field_id),
        calendar_end_field_id: keep(&config.calendar.end_field_id),
        timeline_start_field_id: keep(&config.timeline.start_field_id),
        timeline_end_field_id: keep(&config.timeline.end_field_id),
        timeline_group_field_id: keep(&config.timeline.group_field_id),
    }
}

/// Render a record for a public viewer: only `visible` fields, user ids
/// replaced by names, no creator/editor ids or timestamps.
///
/// - `User` fields become `[{"name"}]`;
/// - created-by / last-modified-by become `{"name"}`;
/// - everything else (links as `[{id,name}]`, attachments, computed values)
///   is passed through, since it is part of the visible cell.
pub fn public_record(
    conn: &Connection,
    record: Record,
    visible: &[Field],
    user_names: &mut HashMap<String, Option<String>>,
) -> PublicRecord {
    let mut values: BTreeMap<String, Json> = BTreeMap::new();
    for f in visible {
        let Some(v) = record.values.get(&f.id) else {
            continue;
        };
        let rendered = match &f.kind {
            FieldKind::User(_) => {
                let names: Vec<Json> = ids_in(v)
                    .into_iter()
                    .filter_map(|id| user_name(conn, user_names, &id))
                    .map(|n| json!({ "name": n }))
                    .collect();
                if names.is_empty() {
                    continue;
                }
                Json::Array(names)
            }
            FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_) => {
                match ids_in(v)
                    .first()
                    .and_then(|id| user_name(conn, user_names, id))
                {
                    Some(n) => json!({ "name": n }),
                    None => continue,
                }
            }
            _ => v.clone(),
        };
        values.insert(f.id.clone(), rendered);
    }
    PublicRecord {
        id: record.id,
        values,
    }
}

fn ids_in(v: &Json) -> Vec<String> {
    match v {
        Json::String(s) => vec![s.clone()],
        Json::Array(a) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn user_name(
    conn: &Connection,
    cache: &mut HashMap<String, Option<String>>,
    id: &str,
) -> Option<String> {
    cache
        .entry(id.to_string())
        .or_insert_with(|| {
            conn.query_row("SELECT name FROM users WHERE id = ?1", [id], |r| r.get(0))
                .ok()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{Empty, TextOptions};

    fn field(id: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl".into(),
            name: id.into(),
            description: None,
            kind,
        }
    }

    fn text(id: &str) -> Field {
        field(id, FieldKind::SingleLineText(TextOptions::default()))
    }

    fn ids(fields: &[Field]) -> Vec<&str> {
        fields.iter().map(|f| f.id.as_str()).collect()
    }

    #[test]
    fn visible_fields_follow_order_then_table_and_skip_hidden() {
        let fields = vec![text("a"), text("b"), text("c"), text("d")];
        let mut config = ViewConfig::default();
        assert_eq!(ids(&visible_fields(&config, &fields)), ["a", "b", "c", "d"]);
        config.field_order = vec!["c".into(), "gone".into(), "a".into(), "c".into()];
        config.hidden_fields = vec!["b".into()];
        assert_eq!(ids(&visible_fields(&config, &fields)), ["c", "a", "d"]);
        // Hidden wins over the explicit order.
        config.hidden_fields = vec!["c".into()];
        assert_eq!(ids(&visible_fields(&config, &fields)), ["a", "b", "d"]);
    }

    #[test]
    fn form_fields_skip_computed_link_user_hidden_and_unknown() {
        let fields = vec![
            text("a"),
            text("b"),
            field("auto", FieldKind::Autonumber(Empty {})),
            field(
                "who",
                FieldKind::User(ob_core::field::UserOptions::default()),
            ),
        ];
        let mut config = ViewConfig::default();
        let entry = |id: &str| FormField {
            field_id: id.into(),
            required: id == "a",
            label: None,
            help: None,
        };
        config.form.fields = vec![
            entry("b"),
            entry("auto"),
            entry("who"),
            entry("nope"),
            entry("a"),
            entry("b"),
        ];
        let got = form_fields(&config, &fields);
        assert_eq!(
            got.iter().map(|(_, f)| f.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert!(got[1].0.required);
        config.hidden_fields = vec!["b".into()];
        assert_eq!(form_fields(&config, &fields).len(), 1);
    }

    #[test]
    fn public_options_hide_formula_and_link_internals() {
        let formula = field(
            "f",
            FieldKind::Formula(ob_core::field::FormulaOptions {
                expression: "{fldSecret} * 2".into(),
                format: None,
                result_type: ob_core::value::ResultType::Number,
            }),
        );
        let opts = public_options(&formula);
        assert_eq!(opts, json!({ "result_type": "number" }));
        assert!(!opts.to_string().contains("fldSecret"));
        let link = field(
            "l",
            FieldKind::Link(ob_core::field::LinkOptions {
                linked_table_id: "tblSecret".into(),
                inverse_field_id: "fldInv".into(),
                single: true,
                picker_view_id: Some("viwSecret".into()),
            }),
        );
        assert_eq!(public_options(&link), json!({ "single": true }));
    }
}
