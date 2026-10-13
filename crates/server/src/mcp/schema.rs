//! Bases, tables and fields: create, rename, duplicate, delete, field definitions of all 28
//! types, the primary field and formula checks.
//!
//! Tables and fields are addressed by NAME or id; option references (the table a link points
//! to, the link and target field of a lookup or rollup, watched fields, select choices) may be
//! names too and are translated to ids here ([`super::resolve`]). The changes themselves run
//! through the REST API, so roles, limits, validation, history, live updates and recomputation
//! are the web UI's own.

use ob_core::api::schema::Table;
use ob_core::field::{Field, FieldType};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{field_options_to_ids, find_field, find_table, load_schema, type_name};
use super::support::*;
use super::tools::{ToolDef, ToolResult};

/// The snake_case names of the 28 field types (leaked once: they live for the whole process).
fn type_names() -> &'static [&'static str] {
    static NAMES: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        FieldType::ALL
            .iter()
            .map(|t| match serde_json::to_value(t) {
                Ok(Value::String(s)) => &*Box::leak(s.into_boxed_str()),
                _ => "",
            })
            .collect()
    })
}

pub fn definitions() -> Vec<ToolDef> {
    let ftype = json!({
        "type": "string",
        "enum": type_names(),
        "description": "Field type. Call field_types for each type's options and value shape.",
    });
    let options = free_object(
        "Type options, e.g. {\"choices\": [\"Todo\", \"Done\"]} for selects, {\"precision\": 2} for numbers, {\"linked_table\": \"Customers\"} for links, {\"expression\": \"{Price} * {Qty}\"} for formulas, {\"link_field\": \"Orders\", \"target_field\": \"Total\", \"expression\": \"SUM(values)\"} for rollups. Tables and fields may be given by name. See field_types.",
    );
    vec![
        ToolDef::new(
            "create_base",
            "Create a base",
            "Create a base in a workspace (you become its owner), optionally with a colour and an icon. Needs the creator role on the workspace and a token with write access that is not limited to specific bases.",
            object(
                json!({
                    "workspace_id": string("Workspace id (from list_bases or list_workspaces)."),
                    "name": string("Base name."),
                    "color": string("Optional colour name, e.g. blue, green, red, purple."),
                    "icon": icon_schema("base"),
                }),
                &["workspace_id", "name"],
            ),
        )
        .write(),
        ToolDef::new(
            "rename_base",
            "Rename or restyle a base",
            "Change a base's name, colour or icon (any of them; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "name": string("New name."),
                    "color": string("New colour name."),
                    "icon": icon_schema("base"),
                }),
                &["base_id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "duplicate_base",
            "Duplicate a base",
            "Copy a base (tables, fields, views and icons; records only with include_records) into the same workspace. Needs the manage permission and the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "name": string("Name of the copy (default: '<name> copy')."),
                    "include_records": boolean("Copy the records too (default false)."),
                }),
                &["base_id"],
            ),
        )
        .manage(),
        ToolDef::new(
            "delete_base",
            "Delete a base",
            "Delete a base with everything in it. It moves to the trash and can be restored within the trash retention period (restore_from_trash, kind 'base'). Needs the manage permission and the owner role.",
            object(json!({ "base_id": string(BASE_ID) }), &["base_id"]),
        )
        .manage()
        .destructive(),
        ToolDef::new(
            "create_table",
            "Create a table",
            "Add a table to a base, optionally with an icon. It starts with a primary text field and a grid view; add fields with create_field. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "name": string("Table name."),
                    "icon": icon_schema("table"),
                }),
                &["base_id", "name"],
            ),
        )
        .write(),
        ToolDef::new(
            "rename_table",
            "Rename a table or change its icon",
            "Change a table's name, description and/or icon (any of them; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("New name."),
                    "description": string("New description."),
                    "icon": icon_schema("table"),
                }),
                &["base_id", "table"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "duplicate_table",
            "Duplicate a table",
            "Copy a table (fields, views and icon, and the records unless include_records is false) within its base. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("Name of the copy (default: '<name> copy')."),
                    "include_records": boolean("Copy the records too (default true)."),
                }),
                &["base_id", "table"],
            ),
        )
        .write(),
        ToolDef::new(
            "delete_table",
            "Delete a table",
            "Delete a table with its records. It moves to the trash and can be restored (restore_from_trash, kind 'table'). Link fields pointing at it are trashed with it. Needs the creator role.",
            object(
                json!({ "base_id": string(BASE_ID), "table": string(TABLE) }),
                &["base_id", "table"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "create_field",
            "Create a field",
            "Add a field (column) to a table. All 28 types are supported; call field_types for the options and value shape of each. Link fields also create the inverse field in the other table (name it with inverse_name). Computed fields (formula, lookup, rollup, count, ...) are filled in automatically. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("Field name (unique within the table)."),
                    "type": ftype.clone(),
                    "options": options.clone(),
                    "description": string("Optional description."),
                    "inverse_name": string("Link fields only: name of the field created in the linked table (default: the table's name)."),
                }),
                &["base_id", "table", "name", "type"],
            ),
        )
        .write(),
        ToolDef::new(
            "update_field",
            "Update a field",
            "Rename a field, change its description or options (options you give are merged into the current ones; select choices repeated by name keep their values), or change its type. Changing the type CONVERTS every existing value and may lose values that do not fit: the first call explains this and you repeat it with confirm_conversion=true. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                    "name": string("New name."),
                    "description": string("New description."),
                    "type": ftype,
                    "options": free_object("Options to change, in the shape of create_field's `options` (merged into the current ones; names accepted). Needed with `type` for types that require options."),
                    "confirm_conversion": boolean("Set true to confirm a type change that converts existing data."),
                }),
                &["base_id", "table", "field"],
            ),
        )
        .write(),
        ToolDef::new(
            "delete_field",
            "Delete a field",
            "Delete a field and the fields that depend on it (lookups, rollups, the inverse of a link). They move to the trash and can be restored with restore_from_trash (kind 'field'). Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                }),
                &["base_id", "table", "field"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "set_primary_field",
            "Set the primary field",
            "Make another field the table's primary (first, name-giving) field. Links and record titles show it. Link, attachment, checkbox, multiple select, rating and computed-from-link fields cannot be primary. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                }),
                &["base_id", "table", "field"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "check_formula",
            "Check a formula",
            "Parse and type-check a formula without creating a field and preview its value on a record. Write field references as {Field Name}. Returns ok, the result type, or the error with its position. Needs the editor role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "expression": string("Formula, e.g. {Price} * {Qty} or IF({Status} = 'Done', 1, 0)."),
                    "record_id": string("Record to preview against (default: the table's first record)."),
                }),
                &["base_id", "table", "expression"],
            ),
        )
        // The REST endpoint is a POST that needs a token with write access, though it changes
        // nothing.
        .write()
        .idempotent(),
        ToolDef::new(
            "list_icons",
            "Search icon names",
            "Search the Lucide icon names that workspaces, bases and tables can have (set with the `icon` argument of create_workspace / rename_workspace, create_base / rename_base and create_table / rename_table). Every word of `query` has to match an icon's name or one of its old names ('cart shop' finds shopping-cart, 'home' finds house); without a query the first icons alphabetically are listed. Names are kebab-case, e.g. briefcase, users, chart-column.",
            object(
                json!({
                    "query": string("Words to search for, e.g. 'money' or 'truck delivery'."),
                    "limit": integer("Icons to return (default 40, max 200).", 1, 200),
                }),
                &[],
            ),
        ),
        ToolDef::new(
            "field_types",
            "Field types help",
            "Explain the field types: without `type` a one-line overview of all 28; with a type its create_field options, the value shape for create_records/update_records, and an example.",
            object(
                json!({ "type": string("A field type, e.g. single_select, link, rollup.") }),
                &[],
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
        "create_base" => with_args!(CreateBase, create_base),
        "rename_base" => with_args!(RenameBase, rename_base),
        "duplicate_base" => with_args!(DuplicateBase, duplicate_base),
        "delete_base" => with_args!(BaseArg, delete_base),
        "create_table" => with_args!(CreateTable, create_table),
        "rename_table" => with_args!(RenameTable, rename_table),
        "duplicate_table" => with_args!(DuplicateTable, duplicate_table),
        "delete_table" => with_args!(TableArg, delete_table),
        "create_field" => with_args!(CreateField, create_field),
        "update_field" => with_args!(UpdateField, update_field),
        "delete_field" => with_args!(FieldArg, delete_field),
        "set_primary_field" => with_args!(FieldArg, set_primary_field),
        "check_formula" => with_args!(CheckFormula, check_formula),
        "list_icons" => Some(match parse::<ListIconsArg>(args.clone()) {
            Ok(a) => list_icons(a),
            Err(e) => e,
        }),
        "field_types" => Some(match parse::<FieldTypesArg>(args.clone()) {
            Ok(a) => field_types(a),
            Err(e) => e,
        }),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListIconsArg {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

fn list_icons(a: ListIconsArg) -> ToolResult {
    let set = crate::icons::icons();
    let limit = a.limit.unwrap_or(40).clamp(1, 200);
    let query = a.query.unwrap_or_default();
    let all = set.search(&query, usize::MAX);
    let mut out = json!({
        "icons": all.iter().take(limit).collect::<Vec<_>>(),
        "matches": all.len(),
        "total_icons": set.len(),
    });
    if all.len() > limit {
        out["note"] = json!(format!(
            "Showing the best {limit} of {} matches; narrow the query or raise limit.",
            all.len()
        ));
    } else if all.is_empty() {
        out["note"] = json!(
            "No icon matches every word; try fewer or different words (e.g. 'cart' instead of 'shopping basket')."
        );
    }
    ToolResult::ok(out)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseArg {
    base_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableArg {
    base_id: String,
    table: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldArg {
    base_id: String,
    table: String,
    field: String,
}

/// A field from the API without bookkeeping the model does not need.
fn field_out(v: &Value) -> Value {
    let mut out = v.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("table_id");
        if let Some(inv) = o.get_mut("inverse")
            && let Some(io) = inv.as_object_mut()
        {
            io.remove("table_id");
        }
    }
    out
}

/// A table: its fields and views by name, id and type only.
fn table_out(v: &Value) -> Value {
    let empty = Vec::new();
    let primary = v["fields"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .find(|f| f["id"] == v["primary_field_id"])
        .map(|f| f["name"].clone())
        .unwrap_or(Value::Null);
    let brief = |list: &Value, with_options: bool| -> Vec<Value> {
        list.as_array()
            .unwrap_or(&empty)
            .iter()
            .map(|x| {
                let mut o = json!({ "id": x["id"], "name": x["name"], "type": x["type"] });
                if with_options
                    && let Some(opts) = x
                        .get("options")
                        .filter(|o| o.as_object().is_none_or(|m| !m.is_empty()))
                {
                    o["options"] = opts.clone();
                }
                o
            })
            .collect()
    };
    let mut out = json!({
        "id": v["id"],
        "name": v["name"],
        "primary_field": primary,
        "fields": brief(&v["fields"], true),
        "views": brief(&v["views"], false),
    });
    if let Some(d) = v["description"].as_str().filter(|d| !d.is_empty()) {
        out["description"] = json!(d);
    }
    if let Some(i) = v["icon"].as_str() {
        out["icon"] = json!(i);
    }
    out
}

/// A base (a summary, or with its tables).
fn base_out(v: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "name", "workspace_id", "color", "icon", "role"] {
        if !v[key].is_null() {
            out.insert(key.into(), v[key].clone());
        }
    }
    if let Some(tables) = v["tables"].as_array() {
        out.insert(
            "tables".into(),
            Value::Array(tables.iter().map(table_out).collect()),
        );
    }
    Value::Object(out)
}

fn insert_some(body: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value {
        body.insert(key.into(), json!(v));
    }
}

// ----------------------------------------------------------------------------------- bases

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBase {
    workspace_id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn create_base(ctx: &McpCtx, a: CreateBase) -> ToolResult {
    let mut body = Map::new();
    body.insert("name".into(), json!(a.name));
    insert_some(&mut body, "color", a.color);
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let path = format!("/api/workspaces/{}/bases", encode_segment(&a.workspace_id));
    match fetch(ctx, "POST", &path, None, Some(Value::Object(body))).await {
        Ok(v) => ToolResult::ok(with_note(json!({ "base": base_out(&v) }), note)),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameBase {
    base_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn rename_base(ctx: &McpCtx, a: RenameBase) -> ToolResult {
    let mut body = Map::new();
    insert_some(&mut body, "name", a.name);
    insert_some(&mut body, "color", a.color);
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if body.is_empty() {
        return ToolResult::error("Give a new name, colour or icon.");
    }
    match fetch(
        ctx,
        "PATCH",
        &base_path(&a.base_id, ""),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(with_note(json!({ "base": base_out(&v) }), note)),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateBase {
    base_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    include_records: Option<bool>,
}

async fn duplicate_base(ctx: &McpCtx, a: DuplicateBase) -> ToolResult {
    let mut body = Map::new();
    insert_some(&mut body, "name", a.name);
    body.insert(
        "include_records".into(),
        json!(a.include_records.unwrap_or(false)),
    );
    match fetch(
        ctx,
        "POST",
        &base_path(&a.base_id, "/duplicate"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(json!({ "base": base_out(&v) })),
        Err(e) => e,
    }
}

async fn delete_base(ctx: &McpCtx, a: BaseArg) -> ToolResult {
    match fetch(ctx, "DELETE", &base_path(&a.base_id, ""), None, None).await {
        Ok(_) => ToolResult::ok(json!({
            "deleted": a.base_id,
            "note": format!(
                "Moved to the trash, not erased: restore_from_trash (kind 'base') brings it back within {} days.",
                ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------------- tables

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTable {
    base_id: String,
    name: String,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn create_table(ctx: &McpCtx, a: CreateTable) -> ToolResult {
    let mut body = Map::new();
    body.insert("name".into(), json!(a.name));
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    match fetch(
        ctx,
        "POST",
        &base_path(&a.base_id, "/tables"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(with_note(json!({ "table": table_out(&v) }), note)),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameTable {
    base_id: String,
    table: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn rename_table(ctx: &McpCtx, a: RenameTable) -> ToolResult {
    let mut body = Map::new();
    insert_some(&mut body, "name", a.name);
    insert_some(&mut body, "description", a.description);
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if body.is_empty() {
        return ToolResult::error("Give a new name, description and/or icon.");
    }
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    match fetch(
        ctx,
        "PATCH",
        &table_path(&table.id, ""),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(with_note(json!({ "table": table_out(&v) }), note)),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateTable {
    base_id: String,
    table: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    include_records: Option<bool>,
}

async fn duplicate_table(ctx: &McpCtx, a: DuplicateTable) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let mut body = Map::new();
    insert_some(&mut body, "name", a.name);
    body.insert(
        "include_records".into(),
        json!(a.include_records.unwrap_or(true)),
    );
    match fetch(
        ctx,
        "POST",
        &table_path(&table.id, "/duplicate"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(json!({ "table": table_out(&v) })),
        Err(e) => e,
    }
}

async fn delete_table(ctx: &McpCtx, a: TableArg) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    match fetch(ctx, "DELETE", &table_path(&table.id, ""), None, None).await {
        Ok(_) => ToolResult::ok(json!({
            "deleted": { "id": table.id, "name": table.name },
            "note": format!(
                "Moved to the trash, not erased: restore_from_trash (kind 'table', id '{}') brings it back within {} days.",
                table.id, ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

// ----------------------------------------------------------------------------------- fields

fn check_type(t: &str) -> Result<(), ToolResult> {
    if type_names().contains(&t) {
        Ok(())
    } else {
        Err(ToolResult::error(format!(
            "Unknown field type '{t}'. Types: {}. Call field_types for details.",
            type_names().join(", ")
        )))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateField {
    base_id: String,
    table: String,
    name: String,
    #[serde(rename = "type")]
    field_type: String,
    #[serde(default)]
    options: Option<Value>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    inverse_name: Option<String>,
}

async fn create_field(ctx: &McpCtx, a: CreateField) -> ToolResult {
    if let Err(e) = check_type(&a.field_type) {
        return e;
    }
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let mut options = a.options.unwrap_or_else(|| json!({}));
    if let Err(e) = field_options_to_ids(&schema, table, &a.field_type, &mut options, None) {
        return ToolResult::error(e);
    }
    let mut body = Map::new();
    body.insert("name".into(), json!(a.name));
    body.insert("type".into(), json!(a.field_type));
    body.insert("options".into(), options);
    insert_some(&mut body, "description", a.description);
    insert_some(&mut body, "inverse_name", a.inverse_name);
    match fetch(
        ctx,
        "POST",
        &table_path(&table.id, "/fields"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(field) => ToolResult::ok(json!({ "field": field_out(&field) })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateField {
    base_id: String,
    table: String,
    field: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "type")]
    field_type: Option<String>,
    #[serde(default)]
    options: Option<Value>,
    #[serde(default)]
    confirm_conversion: Option<bool>,
}

/// The options of `field` as the API shows them, for merging an options update into.
fn current_options(field: &Field) -> Map<String, Value> {
    serde_json::to_value(&field.kind)
        .ok()
        .and_then(|v| v.get("options").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn conversion_warning(table: &Table, field: &Field, from: &str, to: &str) -> String {
    format!(
        "Changing the type of '{}' in '{}' from {from} to {to} converts every existing value. \
         Values that do not fit the new type are cleared, and the old values are not kept \
         (the record history does not record conversions). If this is intended, repeat the call \
         with confirm_conversion=true. To keep the old data, create a new field of the new type \
         and copy the values over, or duplicate the table first.",
        field.name, table.name
    )
}

async fn update_field(ctx: &McpCtx, a: UpdateField) -> ToolResult {
    if a.name.is_none() && a.description.is_none() && a.field_type.is_none() && a.options.is_none()
    {
        return ToolResult::error("Give something to change: name, description, type or options.");
    }
    if let Some(t) = &a.field_type
        && let Err(e) = check_type(t)
    {
        return e;
    }
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let field = match find_field(table, &a.field) {
        Ok(f) => f,
        Err(e) => return e,
    };
    let current_type = type_name(field);
    let new_type = a.field_type.clone().unwrap_or_else(|| current_type.clone());
    let converts = new_type != current_type;
    if converts && a.confirm_conversion != Some(true) {
        return ToolResult::error(conversion_warning(table, field, &current_type, &new_type));
    }

    let mut body = Map::new();
    insert_some(&mut body, "name", a.name);
    insert_some(&mut body, "description", a.description);
    if converts || a.options.is_some() {
        let mut options = a.options.clone().unwrap_or_else(|| json!({}));
        if !converts {
            // Same type: the given options change the current ones, they do not reset the rest.
            let mut merged = current_options(field);
            if let Some(given) = options.as_object() {
                for (k, v) in given {
                    merged.insert(k.clone(), v.clone());
                }
            }
            options = Value::Object(merged);
        }
        let existing = (!converts).then_some(field);
        if let Err(e) = field_options_to_ids(&schema, table, &new_type, &mut options, existing) {
            return ToolResult::error(e);
        }
        body.insert("type".into(), json!(new_type));
        body.insert("options".into(), options);
    }
    let path = format!("/api/fields/{}", encode_segment(&field.id));
    match fetch(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(updated) => {
            let mut out = json!({ "field": field_out(&updated) });
            if converts {
                out["conversion"] = json!({
                    "from": current_type,
                    "to": new_type,
                    "note": "Existing values were converted; values that did not fit were cleared (conversions are not recorded in the record history).",
                });
            }
            ToolResult::ok(out)
        }
        Err(e) => e,
    }
}

async fn delete_field(ctx: &McpCtx, a: FieldArg) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let field = match find_field(table, &a.field) {
        Ok(f) => f,
        Err(e) => return e,
    };
    let path = format!("/api/fields/{}", encode_segment(&field.id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(v) => ToolResult::ok(json!({
            "deleted_field_ids": v.get("deleted_field_ids").cloned().unwrap_or(json!([field.id])),
            "note": format!(
                "Moved to the trash with their values: restore_from_trash (kind 'field', id '{}') brings them back within {} days.",
                field.id, ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

async fn set_primary_field(ctx: &McpCtx, a: FieldArg) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let field = match find_field(table, &a.field) {
        Ok(f) => f,
        Err(e) => return e,
    };
    match fetch(
        ctx,
        "POST",
        &table_path(&table.id, "/primary-field"),
        None,
        Some(json!({ "field_id": field.id })),
    )
    .await
    {
        Ok(_) => ToolResult::ok(json!({ "table": table.name, "primary_field": field.name })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckFormula {
    base_id: String,
    table: String,
    expression: String,
    #[serde(default)]
    record_id: Option<String>,
}

async fn check_formula(ctx: &McpCtx, a: CheckFormula) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let mut body = json!({ "expression": a.expression });
    if let Some(r) = a.record_id {
        body["record_id"] = json!(r);
    }
    match fetch(
        ctx,
        "POST",
        &table_path(&table.id, "/formula/check"),
        None,
        Some(body),
    )
    .await
    {
        Ok(v) => ToolResult::ok(v),
        Err(e) => e,
    }
}

// ----------------------------------------------------------------------------- field_types

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldTypesArg {
    #[serde(default, rename = "type")]
    field_type: Option<String>,
}

const DATE_OPTS: &str = "{include_time: false, date_format: us|european|iso|friendly, time_format: h12|h24, timezone?: IANA zone}";
const VALUE_FORMAT: &str = "format?: {kind: number|percent, precision} | {kind: currency, precision, symbol} | {kind: duration, format} | {kind: date, ...date options}";

/// (type, label, computed, options help, value help, example options).
fn catalogue() -> Vec<(&'static str, &'static str, bool, String, String, Value)> {
    let e =
        |t: &'static str, l: &'static str, c: bool, options: &str, value: &str, example: Value| {
            (t, l, c, options.to_string(), value.to_string(), example)
        };
    vec![
        e(
            "single_line_text",
            "Single line text",
            false,
            "{default?: string}",
            "string",
            json!({}),
        ),
        e(
            "long_text",
            "Long text",
            false,
            "{rich?: boolean} rich = markdown",
            "string",
            json!({"rich": true}),
        ),
        e(
            "number",
            "Number",
            false,
            "{precision: 0-8 (0), allow_negative: true, default?: number}",
            "number",
            json!({"precision": 2}),
        ),
        e(
            "currency",
            "Currency",
            false,
            "{precision: 2, symbol: \"$\", allow_negative: true}",
            "number",
            json!({"symbol": "EUR "}),
        ),
        e(
            "percent",
            "Percent",
            false,
            "{precision: 0, allow_negative: true, default?}",
            "fraction: 0.25 is 25%",
            json!({"precision": 1}),
        ),
        e(
            "duration",
            "Duration",
            false,
            "{format: h_mm | h_mm_ss | h_mm_ss_s | h_mm_ss_ss | h_mm_ss_sss}",
            "seconds as a number; with typecast also \"1:30:00\"",
            json!({"format": "h_mm_ss"}),
        ),
        e(
            "rating",
            "Rating",
            false,
            "{max: 1-10 (5), icon: \"star\", color: \"yellow\"}",
            "integer 1..max",
            json!({"max": 5}),
        ),
        e(
            "checkbox",
            "Checkbox",
            false,
            "{icon: \"check\", color: \"green\"}",
            "true or false",
            json!({}),
        ),
        e(
            "single_select",
            "Single select",
            false,
            "{choices: [\"Todo\", {name: \"Done\", color: \"green\"}]} choices are names or {name, color?}; colours: blue cyan teal green yellow orange red pink purple gray (+ _dark)",
            "choice name; with typecast a missing choice is created",
            json!({"choices": ["Todo", "Doing", {"name": "Done", "color": "green"}]}),
        ),
        e(
            "multiple_select",
            "Multiple select",
            false,
            "same as single_select",
            "array of choice names",
            json!({"choices": ["Urgent", "Billing"]}),
        ),
        e(
            "date",
            "Date",
            false,
            DATE_OPTS,
            "\"YYYY-MM-DD\", or an ISO datetime when include_time",
            json!({"include_time": false, "date_format": "iso"}),
        ),
        e("email", "Email", false, "{}", "string", json!({})),
        e("url", "URL", false, "{}", "string", json!({})),
        e("phone", "Phone number", false, "{}", "string", json!({})),
        e(
            "attachment",
            "Attachment",
            false,
            "{}",
            "array of {id}: upload with upload_attachment (same base), then write the returned reference",
            json!({}),
        ),
        e(
            "link",
            "Link to another record",
            false,
            "{linked_table: name or id, single?: boolean (one record only), picker_view?: view of the linked table}. Also pass inverse_name to create_field: the name of the matching field created in the other table (both sides are kept in sync)",
            "array of record ids of the linked table (results show {id, name})",
            json!({"linked_table": "Customers", "single": true}),
        ),
        e(
            "user",
            "User",
            false,
            "{multiple?: boolean, notify?: boolean}",
            "{id} or {email} (array for multiple); the person must have access to the base (list_collaborators)",
            json!({"multiple": false}),
        ),
        e(
            "formula",
            "Formula",
            true,
            &format!(
                "{{expression: \"{{Price}} * {{Qty}}\", {VALUE_FORMAT}}}; reference fields as {{Field Name}}; check first with check_formula"
            ),
            "not writable; computed",
            json!({"expression": "{Price} * {Qty}"}),
        ),
        e(
            "lookup",
            "Lookup",
            true,
            "{link_field: a link field of this table, target_field: a field of the linked table}",
            "not writable; an array of the linked records' values",
            json!({"link_field": "Customer", "target_field": "Email"}),
        ),
        e(
            "rollup",
            "Rollup",
            true,
            &format!(
                "{{link_field, target_field, expression: \"SUM(values)\" (a formula over the array `values`, e.g. COUNTA(values), ARRAYJOIN(values, \", \")), {VALUE_FORMAT}}}"
            ),
            "not writable; computed",
            json!({"link_field": "Orders", "target_field": "Total", "expression": "SUM(values)"}),
        ),
        e(
            "count",
            "Count",
            true,
            "{link_field: a link field of this table}",
            "not writable; number of linked records",
            json!({"link_field": "Orders"}),
        ),
        e(
            "created_time",
            "Created time",
            true,
            DATE_OPTS,
            "not writable; set when the record is created",
            json!({"include_time": true}),
        ),
        e(
            "last_modified_time",
            "Last modified time",
            true,
            "{fields?: [names watched; empty = any editable field], date?: date options}",
            "not writable",
            json!({"fields": []}),
        ),
        e(
            "created_by",
            "Created by",
            true,
            "{}",
            "not writable",
            json!({}),
        ),
        e(
            "last_modified_by",
            "Last modified by",
            true,
            "{fields?: [names watched]}",
            "not writable",
            json!({}),
        ),
        e(
            "autonumber",
            "Autonumber",
            true,
            "{}",
            "not writable; 1, 2, 3, ... in creation order",
            json!({}),
        ),
        e(
            "barcode",
            "Barcode",
            false,
            "{}",
            "string or {text}",
            json!({}),
        ),
        e(
            "button",
            "Button",
            true,
            "{label: string, url_formula: formula producing an http(s) or mailto URL}",
            "not writable; opens the URL in the web app",
            json!({"label": "Open", "url_formula": "\"https://example.com/\" & {Name}"}),
        ),
    ]
}

fn field_types(a: FieldTypesArg) -> ToolResult {
    let all = catalogue();
    match a.field_type {
        None => ToolResult::ok(json!({
            "types": all
                .iter()
                .map(|(t, l, c, _, v, _)| json!({
                    "type": t,
                    "label": l,
                    "computed": c,
                    "value": v,
                }))
                .collect::<Vec<_>>(),
            "usage": "create_field {base_id, table, name, type, options}. Call field_types with `type` for the options of one type.",
        })),
        Some(t) => match all.iter().find(|(name, ..)| *name == t) {
            None => ToolResult::error(format!(
                "Unknown field type '{t}'. Types: {}.",
                type_names().join(", ")
            )),
            Some((t, l, c, options, value, example)) => ToolResult::ok(json!({
                "type": t,
                "label": l,
                "computed": c,
                "options": options,
                "value": value,
                "example": { "tool": "create_field", "arguments": { "name": l, "type": t, "options": example } },
            })),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_help_covers_every_type_exactly_once() {
        let helped: Vec<&str> = catalogue().iter().map(|e| e.0).collect();
        let all = type_names();
        assert_eq!(all.len(), 28);
        assert_eq!(
            helped,
            all.to_vec(),
            "field_types must list the 28 types in order"
        );
    }

    #[test]
    fn help_lookup_and_overview() {
        let t = field_types(FieldTypesArg { field_type: None });
        assert_eq!(t.structured.unwrap()["types"].as_array().unwrap().len(), 28);
        let t = field_types(FieldTypesArg {
            field_type: Some("rollup".into()),
        });
        assert!(t.text.contains("SUM(values)"));
        assert!(
            field_types(FieldTypesArg {
                field_type: Some("nope".into())
            })
            .is_error
        );
    }

    #[test]
    fn unknown_types_are_listed() {
        assert!(check_type("number").is_ok());
        let e = check_type("numbr").unwrap_err();
        assert!(e.text.contains("single_line_text"));
    }
}
