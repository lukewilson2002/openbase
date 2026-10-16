//! Views: create and configure any view type with field NAMES, read a view's configuration, and
//! query a view the way the web app shows it (filter, sort and grouping applied, hidden fields
//! left out).
//!
//! Configurations use the shape of the REST API's `ViewConfig`; wherever it expects a field id
//! a field name works too, and select filters take choice names ([`super::resolve::Xlate`]).

use ob_core::api::schema::{Table, View};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{
    Mode, Xlate, find_view, load_people, load_schema, merge_config, value_for_model, view_for_model,
};
use super::support::*;
use super::tools::{ToolDef, ToolResult};

const VIEW_TYPES: &[&str] = &[
    "grid", "form", "gallery", "kanban", "calendar", "timeline", "list",
];
const DEFAULT_ROWS: usize = 50;
const MAX_ROWS: usize = 200;

const CONFIG_HELP: &str = "View configuration (all parts optional). filter: {conjunction: and|or, items: [{field_id: <field name>, op, value} | nested {conjunction, items}]}, ops: is, is_not, is_empty, is_not_empty, contains, does_not_contain, starts_with, ends_with, lt, lte, gt, gte, is_any_of, is_none_of, has_any_of, has_all_of, has_none_of, is_exactly, is_before, is_after, is_on_or_before, is_on_or_after, is_within (select values are choice names; dates take {mode: today|tomorrow|yesterday|exact_date, date}|{mode: past_week|next_month|past_number_of_days, days}). sorts and groups: [{field_id: <name>, direction: asc|desc}] (groups: up to 3 levels). hidden_fields and field_order: lists of field names. field_widths and summaries: objects keyed by field name (summaries: one of empty, filled, unique, percent_empty, percent_filled, percent_unique, sum, average, median, min, max, range, std_dev, checked, unchecked, percent_checked, percent_unchecked, earliest_date, latest_date, date_range_days). row_height: short|medium|tall|extra_tall. frozen_columns: number. row_color: {mode: by_select, field_id} | {mode: by_conditions, rules: [{color, filter}]}. kanban: {stack_field_id (a single select, user or checkbox field), cover_field_id, hide_empty_stacks, stack_order: [choice names]}. calendar: {date_field_id, end_field_id}. gallery: {cover_field_id, cover_crop}. timeline: {start_field_id, end_field_id, group_field_id, dependency_field_id, scale: day|week|month|quarter|year}. form: {title, description, fields: [{field_id, required, label, help}], submit_label, success_message, redirect_url, show_submit_another}. Every *_field_id and filter/sort `field_id` accepts a field NAME.";

pub fn definitions() -> Vec<ToolDef> {
    let view_types = enumeration(VIEW_TYPES, "View type.");
    vec![
        ToolDef::new(
            "get_view",
            "Get a view",
            "Get a view's saved configuration (filter, sorts, grouping, hidden fields, settings) with field names instead of ids.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                }),
                &["base_id", "view"],
            ),
        ),
        ToolDef::new(
            "create_view",
            "Create a view",
            "Create a view of any type (grid, form, gallery, kanban, calendar, timeline, list) with an optional configuration. Shared views need the creator role; personal views (personal=true) only the viewer role and are visible to you alone.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("View name."),
                    "type": view_types,
                    "personal": boolean("Make it visible to you only (default false)."),
                    "config": free_object(CONFIG_HELP),
                }),
                &["base_id", "table", "name", "type"],
            ),
        )
        .write(),
        ToolDef::new(
            "update_view",
            "Update a view",
            "Rename a view, lock it, or change its configuration. Parts of `config` you give replace the same parts of the saved config (kanban, calendar, gallery, timeline and form settings merge key by key); parts you omit stay; a null value resets a part. Shared views need the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                    "name": string("New name."),
                    "locked": boolean("Lock the view so only creators can reconfigure it."),
                    "config": free_object("The parts to change, in the shape of create_view's `config` (field names accepted)."),
                }),
                &["base_id", "view"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "delete_view",
            "Delete a view",
            "Delete a view (it moves to the trash and can be restored with restore_from_trash, kind 'view'). Share links of the view stop working. Shared views need the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                }),
                &["base_id", "view"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "query_view",
            "Query a view",
            "Read the rows of a view exactly as the web app shows them: the view's filter, sort and grouping applied, hidden fields left out, computed fields included. Returns records keyed by field NAME in view order, group headers (depth, field, label, start, count) for grouped views, and the total. Page with offset.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                    "search": string("Optional text; only rows containing it in a visible field are returned."),
                    "max_records": integer("Rows to return (default 50, max 200).", 1, MAX_ROWS as u64),
                    "offset": integer("Index of the first row to return (default 0).", 0, 10_000_000),
                    "include_empty": boolean("Return visible fields with no value as null (default false: they are left out of a record's `fields`). `columns` always lists every visible field."),
                }),
                &["base_id", "view"],
            ),
        ),
    ]
}

pub async fn run(ctx: &McpCtx, name: &str, args: &Value) -> Option<ToolResult> {
    macro_rules! with_args {
        ($t:ty, $f:expr) => {
            Some(match parse::<$t>(args.clone()) {
                Ok(a) => $f(ctx, a).await,
                Err(e) => e,
            })
        };
    }
    match name {
        "get_view" => with_args!(ViewArg, get_view),
        "create_view" => with_args!(CreateView, create_view),
        "update_view" => with_args!(UpdateView, update_view),
        "delete_view" => with_args!(ViewArg, delete_view),
        "query_view" => with_args!(QueryView, query_view),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewArg {
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
}

/// The API's view JSON for a model, config in names.
fn present(table: &Table, view: &Value) -> Value {
    view_for_model(table, view)
}

fn view_json(v: &View) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

async fn get_view(ctx: &McpCtx, a: ViewArg) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok((table, view)) => ToolResult::ok(json!({ "view": present(table, &view_json(view)) })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateView {
    base_id: String,
    table: String,
    name: String,
    #[serde(rename = "type")]
    view_type: String,
    #[serde(default)]
    personal: Option<bool>,
    #[serde(default)]
    config: Option<Value>,
}

fn translate(table: &Table, config: &mut Value) -> Result<(), ToolResult> {
    Xlate {
        table,
        mode: Mode::ToIds,
    }
    .config(config)
    .map_err(ToolResult::error)
}

async fn create_view(ctx: &McpCtx, a: CreateView) -> ToolResult {
    if !VIEW_TYPES.contains(&a.view_type.as_str()) {
        return ToolResult::error(format!(
            "Unknown view type '{}'. Types: {}.",
            a.view_type,
            VIEW_TYPES.join(", ")
        ));
    }
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match super::resolve::find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let mut body = Map::new();
    body.insert("name".into(), json!(a.name));
    body.insert("type".into(), json!(a.view_type));
    body.insert("personal".into(), json!(a.personal.unwrap_or(false)));
    if let Some(mut config) = a.config.filter(|c| !c.is_null()) {
        if let Err(e) = translate(table, &mut config) {
            return e;
        }
        body.insert("config".into(), config);
    }
    match fetch(
        ctx,
        "POST",
        &table_path(&table.id, "/views"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(view) => ToolResult::ok(json!({ "view": present(table, &view) })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateView {
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    locked: Option<bool>,
    #[serde(default)]
    config: Option<Value>,
}

async fn update_view(ctx: &McpCtx, a: UpdateView) -> ToolResult {
    if a.name.is_none() && a.locked.is_none() && a.config.is_none() {
        return ToolResult::error("Give something to change: name, locked or config.");
    }
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (table, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let mut body = Map::new();
    if let Some(n) = a.name {
        body.insert("name".into(), json!(n));
    }
    if let Some(l) = a.locked {
        body.insert("locked".into(), json!(l));
    }
    if let Some(mut patch) = a.config.filter(|c| !c.is_null()) {
        if let Err(e) = translate(table, &mut patch) {
            return e;
        }
        let current = serde_json::to_value(&view.config).unwrap_or(Value::Null);
        body.insert("config".into(), merge_config(&current, &patch));
    }
    let path = format!("/api/views/{}", encode_segment(&view.id));
    match fetch(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(updated) => ToolResult::ok(json!({ "view": present(table, &updated) })),
        Err(e) => e,
    }
}

async fn delete_view(ctx: &McpCtx, a: ViewArg) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (table, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let path = format!("/api/views/{}", encode_segment(&view.id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({
            "deleted": { "id": view.id, "name": view.name, "table": table.name },
            "note": format!(
                "Moved to the trash: restore_from_trash (kind 'view', id '{}') brings it back within {} days.",
                view.id, ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryView {
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    max_records: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    include_empty: bool,
}

/// Field ids shown by the view, in display order: `field_order` first, the rest in table order,
/// hidden ones left out.
fn visible_columns<'a>(table: &'a Table, view: &View) -> Vec<&'a ob_core::field::Field> {
    let hidden = &view.config.hidden_fields;
    let mut ordered: Vec<&ob_core::field::Field> = Vec::new();
    for id in &view.config.field_order {
        if let Some(f) = table.fields.iter().find(|f| &f.id == id)
            && !ordered.iter().any(|o| o.id == f.id)
        {
            ordered.push(f);
        }
    }
    for f in &table.fields {
        if !ordered.iter().any(|o| o.id == f.id) {
            ordered.push(f);
        }
    }
    // The primary field always comes first and is never hidden.
    ordered.sort_by_key(|f| f.id != table.primary_field_id);
    ordered
        .into_iter()
        .filter(|f| f.id == table.primary_field_id || !hidden.contains(&f.id))
        .collect()
}

async fn query_view(ctx: &McpCtx, a: QueryView) -> ToolResult {
    let limit = a.max_records.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS);
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (table, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let offset = a.offset.unwrap_or(0);
    let mut body = json!({ "offset": offset, "limit": limit });
    if let Some(s) = a.search.filter(|s| !s.trim().is_empty()) {
        body["search"] = json!(s);
    }
    let path = format!("/api/views/{}/query", encode_segment(&view.id));
    let res = match fetch(ctx, "POST", &path, None, Some(body)).await {
        Ok(v) => v,
        Err(e) => return e,
    };

    let columns = visible_columns(table, view);
    let shows_people = columns.iter().any(|f| {
        matches!(
            f.kind,
            ob_core::field::FieldKind::User(_)
                | ob_core::field::FieldKind::CreatedBy(_)
                | ob_core::field::FieldKind::LastModifiedBy(_)
        )
    });
    let people = if shows_people {
        load_people(ctx, &a.base_id).await
    } else {
        Default::default()
    };
    let name_of = |id: &str| -> String {
        table
            .fields
            .iter()
            .find(|f| f.id == id)
            .map(|f| f.name.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let empty = Vec::new();
    let records: Vec<Value> = res["records"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|r| {
            let mut fields = Map::new();
            for f in &columns {
                if let Some(v) = r["values"].get(&f.id) {
                    fields.insert(f.name.clone(), value_for_model(f, v, &people));
                } else if a.include_empty {
                    fields.insert(f.name.clone(), Value::Null);
                }
            }
            json!({ "id": r["id"], "fields": fields })
        })
        .collect();
    let groups: Vec<Value> = res["groups"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|g| {
            json!({
                "depth": g["depth"],
                "field": name_of(g["field_id"].as_str().unwrap_or("")),
                "label": g["label"],
                "key": g["key"],
                "start": g["start"],
                "count": g["count"],
            })
        })
        .collect();
    let total = res["total"].as_u64().unwrap_or(0) as usize;
    let returned = records.len();
    let mut out = json!({
        "view": view.name,
        "table": table.name,
        "view_type": view.view_type,
        "columns": columns.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
        "total": total,
        "offset": offset,
        "count": returned,
        "records": records,
    });
    if !groups.is_empty() {
        out["groups"] = json!(groups);
    }
    if res["colors"].as_object().is_some_and(|c| !c.is_empty()) {
        out["colors"] = res["colors"].clone();
    }
    if offset + returned < total {
        out["next_offset"] = json!(offset + returned);
        out["hint"] = json!("More rows exist: call again with next_offset as offset.");
    }
    ToolResult::ok(out)
}
