//! Names to ids and back: the tools accept table, field, view and select-choice NAMES wherever
//! the REST API wants ids, and show names in their results.
//!
//! A base's schema is loaded once per call ([`load_schema`]); lookups ([`find_table`],
//! [`find_field`], [`find_view`]) match an id exactly, then a name exactly, then a name ignoring
//! case, and say which names exist when nothing matches. [`Xlate`] rewrites a view
//! configuration (filters, sorts, groups, hidden fields, row colours, kanban/calendar/gallery/
//! timeline/form settings) in either direction, and [`field_options_to_ids`] does the same for
//! field options (link targets, lookup/rollup/count references, watched fields, select choices).

use std::collections::HashMap;

use ob_core::api::schema::{BaseSchema, Table, View};
use ob_core::field::{Field, FieldKind};
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::tools::ToolResult;
use crate::error::AppError;
use crate::perm::{self, Role};
use crate::store::bases;

/// Names listed in a "valid names" hint.
const MAX_HINT_NAMES: usize = 40;

pub fn list_names(items: impl Iterator<Item = String>) -> String {
    let all: Vec<String> = items.collect();
    let mut out = all
        .iter()
        .take(MAX_HINT_NAMES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if all.len() > MAX_HINT_NAMES {
        out.push_str(&format!(", ... ({} more)", all.len() - MAX_HINT_NAMES));
    }
    out
}

/// A base's schema as the caller sees it (any role may read it).
pub async fn load_schema(ctx: &McpCtx, base_id: &str) -> Result<BaseSchema, ToolResult> {
    let (actor, id) = (ctx.actor.clone(), base_id.to_string());
    let res = ctx
        .state
        .db
        .read(move |c| {
            let role = perm::require_base(c, &actor, &id, Role::Viewer)?;
            let base = bases::live_base(c, &id)?;
            bases::schema(c, &base, &actor.user_id, role)
        })
        .await;
    res.map_err(|e| match e {
        AppError::NotFound(_) => ToolResult::error(format!(
            "Base '{base_id}' not found, or you have no access to it. Use list_bases to see valid base ids."
        )),
        other => ToolResult::error(other.to_string()),
    })
}

/// Index of the single match of `key` among `names`: exact id, exact name, then name ignoring
/// case. `Err(None)` = no match, `Err(Some(n))` = `n` names match equally.
fn pick<'a, T>(
    items: &'a [T],
    key: &str,
    id: impl Fn(&T) -> &str,
    name: impl Fn(&T) -> &str,
) -> Result<&'a T, Option<usize>> {
    let key = key.trim();
    if let Some(x) = items.iter().find(|x| id(x) == key) {
        return Ok(x);
    }
    let exact: Vec<&T> = items.iter().filter(|x| name(x) == key).collect();
    match exact.len() {
        1 => return Ok(exact[0]),
        n if n > 1 => return Err(Some(n)),
        _ => {}
    }
    let lower = key.to_lowercase();
    let folded: Vec<&T> = items
        .iter()
        .filter(|x| name(x).trim().to_lowercase() == lower)
        .collect();
    match folded.len() {
        0 => Err(None),
        1 => Ok(folded[0]),
        n => Err(Some(n)),
    }
}

pub fn find_table<'a>(schema: &'a BaseSchema, key: &str) -> Result<&'a Table, ToolResult> {
    pick(&schema.tables, key, |t| &t.id, |t| &t.name).map_err(|why| {
        let tables = list_names(
            schema
                .tables
                .iter()
                .map(|t| format!("'{}' ({})", t.name, t.id)),
        );
        ToolResult::error(match why {
            Some(_) => format!(
                "Several tables are named '{key}'; use the table id. Tables in '{}': {tables}.",
                schema.name
            ),
            None => format!(
                "Table '{key}' not found in base '{}'. Tables: {tables}.",
                schema.name
            ),
        })
    })
}

pub fn find_field<'a>(table: &'a Table, key: &str) -> Result<&'a Field, ToolResult> {
    field_lookup(table, key).map_err(ToolResult::error)
}

/// [`find_field`] with a plain-string error.
pub fn field_lookup<'a>(table: &'a Table, key: &str) -> Result<&'a Field, String> {
    pick(&table.fields, key, |f| &f.id, |f| &f.name).map_err(|why| match why {
        Some(_) => format!(
            "Several fields in table '{}' are named '{key}'; use the field id.",
            table.name
        ),
        None => format!(
            "Field '{key}' not found in table '{}'. Fields: {}.",
            table.name,
            list_names(table.fields.iter().map(|f| format!("'{}'", f.name)))
        ),
    })
}

/// A view by id or name; `table` (name or id) narrows a name that exists in several tables.
pub fn find_view<'a>(
    schema: &'a BaseSchema,
    table: Option<&str>,
    key: &str,
) -> Result<(&'a Table, &'a View), ToolResult> {
    let tables: Vec<&Table> = match table {
        Some(t) => vec![find_table(schema, t)?],
        None => schema.tables.iter().collect(),
    };
    let mut hits: Vec<(&Table, &View)> = Vec::new();
    for t in &tables {
        match pick(&t.views, key, |v| &v.id, |v| &v.name) {
            Ok(v) => hits.push((t, v)),
            Err(Some(_)) => {
                return Err(ToolResult::error(format!(
                    "Several views in table '{}' are named '{key}'; use the view id.",
                    t.name
                )));
            }
            Err(None) => {}
        }
    }
    match hits.len() {
        1 => Ok(hits[0]),
        0 => Err(ToolResult::error(format!(
            "View '{key}' not found{}. Views: {}.",
            table
                .map(|t| format!(" in table '{t}'"))
                .unwrap_or_default(),
            list_names(tables.iter().flat_map(|t| {
                t.views
                    .iter()
                    .map(move |v| format!("'{}' ({}, table '{}')", v.name, v.id, t.name))
            }))
        ))),
        _ => Err(ToolResult::error(format!(
            "Several tables have a view named '{key}'; pass `table` or use the view id."
        ))),
    }
}

pub fn type_name(f: &Field) -> String {
    serde_json::to_value(&f.kind)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// Choices of a select field.
fn choices(f: &Field) -> &[ob_core::field::SelectChoice] {
    match &f.kind {
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => &o.choices,
        _ => &[],
    }
}

fn is_select(f: &Field) -> bool {
    matches!(
        f.kind,
        FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_)
    )
}

// ---------------------------------------------------------------------------------------------
// Values

/// People of a base by user id: `{id, name, email}` (users cells hold ids only).
pub type People = HashMap<String, Value>;

pub fn people_of(conn: &rusqlite::Connection, base_id: &str) -> People {
    let Ok(base) = bases::live_base(conn, base_id) else {
        return People::new();
    };
    bases::collaborators(conn, &base)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            (
                c.id.clone(),
                json!({ "id": c.id, "name": c.name, "email": c.email }),
            )
        })
        .collect()
}

/// The collaborators of a base, for showing user cells (empty when they cannot be read).
pub async fn load_people(ctx: &McpCtx, base_id: &str) -> People {
    let (actor, id) = (ctx.actor.clone(), base_id.to_string());
    ctx.state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Viewer)?;
            Ok(people_of(c, &id))
        })
        .await
        .unwrap_or_default()
}

/// A stored cell value the way a model reads it: select choice ids become names and user ids
/// become `{id, name, email}`; everything else is unchanged. (The names direction of
/// `list_records`, which speaks in names, so every tool shows the same values.)
pub fn value_for_model(field: &Field, v: &Value, people: &People) -> Value {
    let person = |id: &str| {
        people
            .get(id)
            .cloned()
            .unwrap_or_else(|| json!({ "id": id }))
    };
    match &field.kind {
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => {
            let name = |id: &str| {
                o.choices
                    .iter()
                    .find(|c| c.id == id)
                    .map(|c| json!(c.name))
                    .unwrap_or_else(|| json!(id))
            };
            match v {
                Value::String(s) => name(s),
                Value::Array(items) => Value::Array(
                    items
                        .iter()
                        .map(|i| i.as_str().map(name).unwrap_or_else(|| i.clone()))
                        .collect(),
                ),
                other => other.clone(),
            }
        }
        FieldKind::User(_) | FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_) => match v {
            Value::String(s) => person(s),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|i| i.as_str().map(person).unwrap_or_else(|| i.clone()))
                    .collect(),
            ),
            other => other.clone(),
        },
        _ => v.clone(),
    }
}

// ---------------------------------------------------------------------------------------------
// View configurations

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Names (or ids) written by the model to ids for the API.
    ToIds,
    /// Ids from the API to names for the model.
    ToNames,
}

/// Rewrites references inside a view configuration (JSON shape of `ViewConfig`).
pub struct Xlate<'a> {
    pub table: &'a Table,
    pub mode: Mode,
}

const CONFIG_KEYS: &[&str] = &[
    "filter",
    "sorts",
    "groups",
    "hidden_fields",
    "field_order",
    "field_widths",
    "frozen_columns",
    "row_height",
    "row_color",
    "summaries",
    "wrap_headers",
    "description_field_id",
    "kanban",
    "calendar",
    "gallery",
    "timeline",
    "form",
];
const KANBAN_KEYS: &[&str] = &[
    "stack_field_id",
    "cover_field_id",
    "hide_empty_stacks",
    "stack_order",
];
const CALENDAR_KEYS: &[&str] = &["date_field_id", "end_field_id"];
const GALLERY_KEYS: &[&str] = &["cover_field_id", "cover_crop"];
const TIMELINE_KEYS: &[&str] = &[
    "start_field_id",
    "end_field_id",
    "group_field_id",
    "dependency_field_id",
    "scale",
];
const FORM_KEYS: &[&str] = &[
    "title",
    "description",
    "fields",
    "submit_label",
    "success_message",
    "redirect_url",
    "show_submit_another",
];

fn check_keys(obj: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!(
                "unknown key '{k}' in {what}. Valid keys: {}.",
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

impl Xlate<'_> {
    /// One field reference.
    fn field(&self, v: &str) -> Result<String, String> {
        match self.mode {
            Mode::ToIds => field_lookup(self.table, v).map(|f| f.id.clone()),
            Mode::ToNames => Ok(self
                .table
                .fields
                .iter()
                .find(|f| f.id == v)
                .map(|f| f.name.clone())
                .unwrap_or_else(|| v.to_string())),
        }
    }

    fn field_value(&self, v: &mut Value, what: &str) -> Result<(), String> {
        match v {
            Value::Null => Ok(()),
            Value::String(s) => {
                *s = self.field(s)?;
                Ok(())
            }
            _ => Err(format!("{what} must be a field name or id")),
        }
    }

    fn field_list(&self, v: &mut Value, what: &str) -> Result<(), String> {
        match v {
            Value::Null => Ok(()),
            Value::Array(items) => {
                for item in items {
                    self.field_value(item, what)?;
                }
                Ok(())
            }
            _ => Err(format!("{what} must be a list of field names or ids")),
        }
    }

    fn field_keys(&self, v: &mut Value, what: &str) -> Result<(), String> {
        match v {
            Value::Null => Ok(()),
            Value::Object(map) => {
                let old = std::mem::take(map);
                for (k, val) in old {
                    map.insert(self.field(&k)?, val);
                }
                Ok(())
            }
            _ => Err(format!("{what} must be an object keyed by field")),
        }
    }

    /// One select choice (name or id) of `field`.
    fn choice(&self, field: &Field, v: &str) -> Result<String, String> {
        let list = choices(field);
        match self.mode {
            Mode::ToIds => {
                if list.iter().any(|c| c.id == v) {
                    return Ok(v.to_string());
                }
                let lower = v.trim().to_lowercase();
                list.iter()
                    .find(|c| c.name.trim().to_lowercase() == lower)
                    .map(|c| c.id.clone())
                    .ok_or_else(|| {
                        format!(
                            "'{v}' is not a choice of field '{}'. Choices: {}.",
                            field.name,
                            list_names(list.iter().map(|c| format!("'{}'", c.name)))
                        )
                    })
            }
            Mode::ToNames => Ok(list
                .iter()
                .find(|c| c.id == v)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| v.to_string())),
        }
    }

    fn choice_value(&self, field: &Field, v: &mut Value) -> Result<(), String> {
        match v {
            Value::String(s) => {
                *s = self.choice(field, s)?;
                Ok(())
            }
            Value::Array(items) => {
                for item in items {
                    self.choice_value(field, item)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// `field_id` of a condition / sort: accepts the alias `field` as input.
    fn field_ref(
        &self,
        obj: &mut Map<String, Value>,
        what: &str,
    ) -> Result<Option<&Field>, String> {
        if self.mode == Mode::ToIds
            && !obj.contains_key("field_id")
            && let Some(v) = obj.remove("field")
        {
            obj.insert("field_id".into(), v);
        }
        let Some(Value::String(raw)) = obj.get("field_id").cloned() else {
            return Err(format!("{what} needs a \"field_id\" (a field name or id)"));
        };
        let translated = self.field(&raw)?;
        let id = match self.mode {
            Mode::ToIds => translated.clone(),
            Mode::ToNames => raw.clone(),
        };
        obj.insert("field_id".into(), Value::String(translated));
        Ok(self.table.fields.iter().find(|f| f.id == id))
    }

    fn filter(&self, f: &mut Value) -> Result<(), String> {
        let Some(obj) = f.as_object_mut() else {
            return Err("a filter must be an object {conjunction, items}".into());
        };
        check_keys(obj, &["conjunction", "items"], "a filter")?;
        let Some(items) = obj.get_mut("items") else {
            return Ok(());
        };
        let Some(items) = items.as_array_mut() else {
            return Err("filter.items must be a list".into());
        };
        for item in items {
            let Some(o) = item.as_object() else {
                return Err("each filter item must be an object".into());
            };
            if o.contains_key("items") || o.contains_key("conjunction") {
                self.filter(item)?;
            } else {
                self.condition(item)?;
            }
        }
        Ok(())
    }

    fn condition(&self, c: &mut Value) -> Result<(), String> {
        let Some(obj) = c.as_object_mut() else {
            return Err("a filter condition must be an object {field_id, op, value}".into());
        };
        check_keys(
            obj,
            &["field_id", "field", "op", "value"],
            "a filter condition",
        )?;
        let field = self.field_ref(obj, "a filter condition")?.cloned();
        if let (Some(field), Some(value)) = (field, obj.get_mut("value"))
            && is_select(&field)
        {
            self.choice_value(&field, value)?;
        }
        Ok(())
    }

    fn sorts(&self, v: &mut Value, what: &str) -> Result<(), String> {
        match v {
            Value::Null => Ok(()),
            Value::Array(items) => {
                for item in items {
                    let Some(o) = item.as_object_mut() else {
                        return Err(format!(
                            "each entry of {what} must be {{field_id, direction}}"
                        ));
                    };
                    check_keys(o, &["field_id", "field", "direction"], what)?;
                    self.field_ref(o, what)?;
                }
                Ok(())
            }
            _ => Err(format!("{what} must be a list of {{field_id, direction}}")),
        }
    }

    /// Rewrite a whole `ViewConfig` (or any part of one; absent sections are skipped).
    pub fn config(&self, cfg: &mut Value) -> Result<(), String> {
        let Some(obj) = cfg.as_object_mut() else {
            return Err("config must be an object".into());
        };
        hoist_description(obj)?;
        check_keys(obj, CONFIG_KEYS, "the view config")?;
        if let Some(f) = obj.get_mut("filter")
            && !f.is_null()
        {
            self.filter(f)?;
        }
        if let Some(v) = obj.get_mut("sorts") {
            self.sorts(v, "sorts")?;
        }
        if let Some(v) = obj.get_mut("groups") {
            self.sorts(v, "groups")?;
        }
        if let Some(v) = obj.get_mut("hidden_fields") {
            self.field_list(v, "hidden_fields")?;
        }
        if let Some(v) = obj.get_mut("field_order") {
            self.field_list(v, "field_order")?;
        }
        if let Some(v) = obj.get_mut("field_widths") {
            self.field_keys(v, "field_widths")?;
        }
        if let Some(v) = obj.get_mut("summaries") {
            self.field_keys(v, "summaries")?;
        }
        if let Some(v) = obj.get_mut("description_field_id")
            && !v.is_null()
        {
            self.field_value(v, "description_field_id")?;
        }
        if let Some(rc) = obj.get_mut("row_color")
            && !rc.is_null()
        {
            self.row_color(rc)?;
        }
        if let Some(k) = obj.get_mut("kanban")
            && !k.is_null()
        {
            self.kanban(k)?;
        }
        self.settings(
            obj,
            "calendar",
            CALENDAR_KEYS,
            &["date_field_id", "end_field_id"],
        )?;
        self.settings(obj, "gallery", GALLERY_KEYS, &["cover_field_id"])?;
        self.settings(
            obj,
            "timeline",
            TIMELINE_KEYS,
            &[
                "start_field_id",
                "end_field_id",
                "group_field_id",
                "dependency_field_id",
            ],
        )?;
        if let Some(form) = obj.get_mut("form")
            && !form.is_null()
        {
            let Some(fo) = form.as_object_mut() else {
                return Err("form must be an object".into());
            };
            check_keys(fo, FORM_KEYS, "the form settings")?;
            if let Some(fields) = fo.get_mut("fields") {
                let Some(list) = fields.as_array_mut() else {
                    return Err(
                        "form.fields must be a list of {field_id, required, label, help}".into(),
                    );
                };
                for item in list {
                    let Some(o) = item.as_object_mut() else {
                        return Err(
                            "each form field must be {field_id, required?, label?, help?}".into(),
                        );
                    };
                    check_keys(
                        o,
                        &["field_id", "field", "required", "label", "help"],
                        "a form field",
                    )?;
                    self.field_ref(o, "a form field")?;
                }
            }
        }
        Ok(())
    }

    /// A settings object whose listed keys hold field references.
    fn settings(
        &self,
        obj: &mut Map<String, Value>,
        section: &str,
        allowed: &[&str],
        field_keys: &[&str],
    ) -> Result<(), String> {
        let Some(s) = obj.get_mut(section) else {
            return Ok(());
        };
        if s.is_null() {
            return Ok(());
        }
        let Some(o) = s.as_object_mut() else {
            return Err(format!("{section} must be an object"));
        };
        check_keys(o, allowed, &format!("the {section} settings"))?;
        for key in field_keys {
            if let Some(v) = o.get_mut(*key) {
                self.field_value(v, &format!("{section}.{key}"))?;
            }
        }
        Ok(())
    }

    fn kanban(&self, k: &mut Value) -> Result<(), String> {
        let Some(o) = k.as_object_mut() else {
            return Err("kanban must be an object".into());
        };
        check_keys(o, KANBAN_KEYS, "the kanban settings")?;
        // Resolve the stack field first: its choices decide how `stack_order` is read.
        let stack_raw = o
            .get("stack_field_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let stack_field = match (&stack_raw, self.mode) {
            (Some(raw), Mode::ToIds) => Some(field_lookup(self.table, raw)?.clone()),
            (Some(raw), Mode::ToNames) => self.table.fields.iter().find(|f| &f.id == raw).cloned(),
            (None, _) => None,
        };
        for key in ["stack_field_id", "cover_field_id"] {
            if let Some(v) = o.get_mut(key) {
                self.field_value(v, &format!("kanban.{key}"))?;
            }
        }
        if let (Some(field), Some(order)) = (stack_field, o.get_mut("stack_order"))
            && is_select(&field)
        {
            self.choice_value(&field, order)?;
        }
        Ok(())
    }

    fn row_color(&self, rc: &mut Value) -> Result<(), String> {
        let Some(o) = rc.as_object_mut() else {
            return Err("row_color must be {mode: 'by_select', field_id} or {mode: 'by_conditions', rules: [{color, filter}]}".into());
        };
        check_keys(o, &["mode", "field_id", "field", "rules"], "row_color")?;
        match o.get("mode").and_then(Value::as_str) {
            Some("by_select") => {
                self.field_ref(o, "row_color by_select")?;
            }
            Some("by_conditions") => {
                let Some(rules) = o.get_mut("rules").and_then(Value::as_array_mut) else {
                    return Err("row_color by_conditions needs `rules`: [{color, filter}]".into());
                };
                for r in rules {
                    let Some(ro) = r.as_object_mut() else {
                        return Err("each row_color rule must be {color, filter}".into());
                    };
                    check_keys(ro, &["color", "filter"], "a row_color rule")?;
                    if let Some(f) = ro.get_mut("filter") {
                        self.filter(f)?;
                    }
                }
            }
            _ => {
                return Err("row_color.mode must be \"by_select\" or \"by_conditions\"".into());
            }
        }
        Ok(())
    }
}

/// Merge `patch` into `base` the way `update_view` applies a partial config: sections in the
/// patch replace the same sections of `base`; the settings sections (kanban, calendar, gallery,
/// timeline, form) merge key by key; `null` removes a key back to its default.
pub fn merge_config(base: &Value, patch: &Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    let Some(p) = patch.as_object() else {
        return Value::Object(out);
    };
    for (k, v) in p {
        let nested = matches!(
            k.as_str(),
            "kanban" | "calendar" | "gallery" | "timeline" | "form"
        );
        if v.is_null() {
            out.remove(k);
        } else if nested && v.is_object() {
            let mut section = out
                .get(k)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (sk, sv) in v.as_object().into_iter().flatten() {
                if sv.is_null() {
                    section.remove(sk);
                } else {
                    section.insert(sk.clone(), sv.clone());
                }
            }
            out.insert(k.clone(), Value::Object(section));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// A view from the API with its config in names, for the model.
pub fn view_for_model(table: &Table, view: &Value) -> Value {
    let mut v = view.clone();
    if let Some(cfg) = v.get_mut("config") {
        let x = Xlate {
            table,
            mode: Mode::ToNames,
        };
        let _ = x.config(cfg);
        prune_defaults(cfg);
    }
    if let Some(o) = v.as_object_mut() {
        o.remove("table_id");
        o.insert("table".into(), json!(table.name));
    }
    v
}

/// Drop empty / default sections so a config reads as what was set.
fn prune_defaults(cfg: &mut Value) {
    let Some(o) = cfg.as_object_mut() else {
        return;
    };
    o.retain(|_, v| match v {
        Value::Null => false,
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_u64() != Some(0),
        Value::String(s) => !s.is_empty(),
    });
    if o.get("row_height") == Some(&json!("short")) {
        o.remove("row_height");
    }
    if let Some(Value::Object(t)) = o.get_mut("timeline")
        && t.get("scale") == Some(&json!("week"))
    {
        t.remove("scale");
    }
    if let Some(Value::Object(form)) = o.get_mut("form")
        && let Some(Value::Array(fields)) = form.get_mut("fields")
    {
        for f in fields {
            if let Some(m) = f.as_object_mut() {
                m.retain(|_, v| !v.is_null() && v != &json!(false));
            }
        }
    }
    for key in ["kanban", "calendar", "gallery", "timeline", "form"] {
        if let Some(Value::Object(m)) = o.get_mut(key) {
            m.retain(|_, v| match v {
                Value::Null => false,
                Value::Array(a) => !a.is_empty(),
                Value::Bool(b) => *b,
                Value::String(s) => !s.is_empty(),
                _ => true,
            });
        }
    }
    if matches!(o.get("kanban"), Some(Value::Object(m)) if m.is_empty()) {
        o.remove("kanban");
    }
    for key in ["calendar", "gallery", "timeline", "form"] {
        if matches!(o.get(key), Some(Value::Object(m)) if m.is_empty()) {
            o.remove(key);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Field options

/// Rewrite the `options` of a field definition so names become ids. `existing` is the field
/// being updated (select choices keep their ids when a choice is repeated by name).
pub fn field_options_to_ids(
    schema: &BaseSchema,
    table: &Table,
    ftype: &str,
    options: &mut Value,
    existing: Option<&Field>,
) -> Result<(), String> {
    if options.is_null() {
        *options = json!({});
    }
    let Some(o) = options.as_object_mut() else {
        return Err("options must be an object".into());
    };
    match ftype {
        "single_select" | "multiple_select" => select_choices(o, existing),
        "link" => {
            let linked = take_ref(o, "linked_table_id", "linked_table");
            if let Some(Value::String(t)) = linked {
                let found = find_table(schema, &t).map_err(|r| r.text)?;
                o.insert("linked_table_id".into(), json!(found.id));
                if let Some(Value::String(v)) = o.get("picker_view_id").cloned()
                    && let Ok((_, view)) = find_view(schema, Some(&found.id), &v)
                {
                    o.insert("picker_view_id".into(), json!(view.id));
                }
            }
            Ok(())
        }
        "lookup" | "rollup" | "count" => {
            let link_ref = take_ref(o, "link_field_id", "link_field");
            let Some(Value::String(link_name)) = link_ref else {
                return Err(format!(
                    "a {ftype} field needs options.link_field: the name of a link field in this table"
                ));
            };
            let link = field_lookup(table, &link_name)?;
            let FieldKind::Link(lo) = &link.kind else {
                return Err(format!(
                    "'{}' is not a link field, so a {ftype} cannot be based on it",
                    link.name
                ));
            };
            o.insert("link_field_id".into(), json!(link.id));
            if ftype != "count" {
                let target_ref = take_ref(o, "target_field_id", "target_field");
                let Some(Value::String(target_name)) = target_ref else {
                    return Err(format!(
                        "a {ftype} field needs options.target_field: a field of the linked table"
                    ));
                };
                let linked_table = schema
                    .tables
                    .iter()
                    .find(|t| t.id == lo.linked_table_id)
                    .ok_or_else(|| "the linked table is not in this base".to_string())?;
                let target = field_lookup(linked_table, &target_name)?;
                o.insert("target_field_id".into(), json!(target.id));
            }
            Ok(())
        }
        "last_modified_time" | "last_modified_by" => {
            if let Some(Value::Array(items)) = o.get_mut("fields") {
                for item in items {
                    if let Value::String(s) = item {
                        *s = field_lookup(table, s)?.id.clone();
                    }
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Remove a reference given under its id key or its friendly alias; returns the value.
fn take_ref(o: &mut Map<String, Value>, id_key: &str, alias: &str) -> Option<Value> {
    let alias_v = o.remove(alias);
    let id_v = o.remove(id_key).filter(|v| !v.is_null());
    id_v.or(alias_v)
}

fn select_choices(o: &mut Map<String, Value>, existing: Option<&Field>) -> Result<(), String> {
    let Some(list) = o.get_mut("choices") else {
        return Ok(());
    };
    let Some(items) = list.as_array_mut() else {
        return Err("options.choices must be a list of names or {name, color?}".into());
    };
    let old: &[ob_core::field::SelectChoice] = existing.map(choices).unwrap_or(&[]);
    for item in items.iter_mut() {
        if let Value::String(name) = item {
            *item = json!({ "name": name });
        }
        let Some(c) = item.as_object_mut() else {
            return Err("each choice must be a name or {name, color?}".into());
        };
        let has_id = c
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        if !has_id
            && let Some(name) = c.get("name").and_then(Value::as_str)
            && let Some(prev) = old
                .iter()
                .find(|p| p.name.trim().to_lowercase() == name.trim().to_lowercase())
        {
            c.insert("id".into(), json!(prev.id));
            if c.get("color").is_none_or(Value::is_null) {
                c.insert("color".into(), json!(prev.color));
            }
        }
    }
    Ok(())
}

/// The description field is a setting of the whole view (0.5.0 moved it out of `kanban`), but the
/// app shows it among each view type's settings and older tool lists put it under `kanban`, so a
/// model may well send it inside a view type's section. Move it to the top of the config.
fn hoist_description(obj: &mut Map<String, Value>) -> Result<(), String> {
    for section in ["kanban", "gallery", "calendar", "timeline"] {
        let Some(inner) = obj.get_mut(section).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(v) = inner.remove("description_field_id") else {
            continue;
        };
        match obj.get("description_field_id") {
            Some(top) if *top != v => {
                return Err(format!(
                    "description_field_id is given twice, at the top of the config and in {section}, with different fields. It is a setting of the whole view: give it once, at the top."
                ));
            }
            _ => {
                obj.insert("description_field_id".into(), v);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{FieldKind, SelectChoice, SelectOptions, TextOptions};

    fn field(id: &str, name: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl1".into(),
            name: name.into(),
            description: None,
            kind,
        }
    }

    fn table() -> Table {
        Table {
            id: "tbl1".into(),
            base_id: "app1".into(),
            name: "Tasks".into(),
            icon: None,
            description: None,
            primary_field_id: "fld1".into(),
            fields: vec![
                field(
                    "fld1",
                    "Name",
                    FieldKind::SingleLineText(TextOptions::default()),
                ),
                field(
                    "fld2",
                    "Status",
                    FieldKind::SingleSelect(SelectOptions {
                        choices: vec![
                            SelectChoice {
                                id: "selA".into(),
                                name: "Todo".into(),
                                color: "blue".into(),
                            },
                            SelectChoice {
                                id: "selB".into(),
                                name: "Done".into(),
                                color: "green".into(),
                            },
                        ],
                    }),
                ),
            ],
            views: vec![],
        }
    }

    #[test]
    fn config_names_round_trip_through_ids() {
        let t = table();
        let mut cfg = json!({
            "filter": {"conjunction": "and", "items": [
                {"field": "status", "op": "is", "value": "done"},
                {"conjunction": "or", "items": [{"field_id": "Name", "op": "contains", "value": "x"}]}
            ]},
            "sorts": [{"field": "Name", "direction": "desc"}],
            "hidden_fields": ["Status"],
            "field_widths": {"Name": 200},
            "kanban": {"stack_field_id": "Status", "stack_order": ["Done", "Todo"]},
            "row_color": {"mode": "by_select", "field": "Status"}
        });
        Xlate {
            table: &t,
            mode: Mode::ToIds,
        }
        .config(&mut cfg)
        .unwrap();
        assert_eq!(
            cfg["filter"]["items"][0],
            json!({"field_id": "fld2", "op": "is", "value": "selB"})
        );
        assert_eq!(cfg["filter"]["items"][1]["items"][0]["field_id"], "fld1");
        assert_eq!(cfg["sorts"][0]["field_id"], "fld1");
        assert_eq!(cfg["hidden_fields"], json!(["fld2"]));
        assert_eq!(cfg["field_widths"], json!({"fld1": 200}));
        assert_eq!(cfg["kanban"]["stack_order"], json!(["selB", "selA"]));
        assert_eq!(cfg["row_color"]["field_id"], "fld2");
        assert!(cfg["row_color"].get("field").is_none());

        Xlate {
            table: &t,
            mode: Mode::ToNames,
        }
        .config(&mut cfg)
        .unwrap();
        assert_eq!(cfg["filter"]["items"][0]["value"], "Done");
        assert_eq!(cfg["filter"]["items"][0]["field_id"], "Status");
        assert_eq!(cfg["kanban"]["stack_order"], json!(["Done", "Todo"]));
        assert_eq!(cfg["hidden_fields"], json!(["Status"]));
    }

    #[test]
    fn unknown_names_and_keys_are_explained() {
        let t = table();
        let x = Xlate {
            table: &t,
            mode: Mode::ToIds,
        };
        let e = x
            .config(&mut json!({"sorts": [{"field": "Nope"}]}))
            .unwrap_err();
        assert!(
            e.contains("Field 'Nope' not found") && e.contains("'Status'"),
            "{e}"
        );
        let e = x.config(&mut json!({"sort": []})).unwrap_err();
        assert!(
            e.contains("unknown key 'sort'") && e.contains("sorts"),
            "{e}"
        );
        let e = x
            .config(&mut json!({"filter": {"items": [{"field": "Status", "op": "is", "value": "Nope"}]}}))
            .unwrap_err();
        assert!(e.contains("not a choice") && e.contains("'Todo'"), "{e}");
        let e = x
            .config(&mut json!({"kanban": {"stack": "x"}}))
            .unwrap_err();
        assert!(e.contains("unknown key 'stack'"), "{e}");
    }

    #[test]
    fn partial_configs_merge_section_by_section() {
        let base = json!({"sorts": [1], "kanban": {"stack_field_id": "a", "hide_empty_stacks": true}, "filter": {"items": []}});
        let merged = merge_config(
            &base,
            &json!({"sorts": [2], "kanban": {"cover_field_id": "c", "hide_empty_stacks": null}, "filter": null}),
        );
        assert_eq!(merged["sorts"], json!([2]));
        assert_eq!(
            merged["kanban"],
            json!({"stack_field_id": "a", "cover_field_id": "c"})
        );
        assert!(merged.get("filter").is_none());
    }

    #[test]
    fn lookups_match_ids_then_names_then_case() {
        let t = table();
        assert_eq!(field_lookup(&t, "fld2").unwrap().name, "Status");
        assert_eq!(field_lookup(&t, "Status").unwrap().id, "fld2");
        assert_eq!(field_lookup(&t, " status ").unwrap().id, "fld2");
        assert!(
            field_lookup(&t, "Nope")
                .unwrap_err()
                .contains("Fields: 'Name', 'Status'")
        );
    }
}
