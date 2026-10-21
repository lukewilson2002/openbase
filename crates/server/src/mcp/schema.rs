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
use super::resolve::{
    field_options_to_ids, find_field, find_table, load_schema, pick_many, type_name,
};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use super::views::{NEW_TABLE_VIEWS, new_field_views_note, views_using};

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
        "description": "Field type. For text: rich_text (Markdown) for notes, summaries, descriptions, articles, posts and anything longer than a sentence; text for names, titles, codes and other short plain values. Call field_types for what each type is for, its options and value shape.",
    });
    let options = free_object(
        "Type options, e.g. {\"choices\": [\"Todo\", {\"name\": \"Done\", \"color\": \"green\"}]} for selects (choices are names or {name, color}; names like Critical/High/Low/Done get a fitting colour when none is given), {\"precision\": 2} for numbers, {\"linked_table\": \"Customers\"} for links, {\"expression\": \"{Price} * {Qty}\"} for formulas, {\"link_field\": \"Orders\", \"target_field\": \"Total\", \"expression\": \"SUM(values)\"} for rollups. Tables and fields may be given by name. See field_types.",
    );
    vec![
        ToolDef::new(
            "create_project",
            "Create a project",
            "Create a project in a workspace (you become its owner), optionally with a colour and an icon. Needs the creator role on the workspace and a token with write access that is not limited to specific projects.",
            object(
                json!({
                    "workspace_id": string("Workspace id (from list_projects or list_workspaces)."),
                    "name": string("Project name."),
                    "color": string("Optional colour name, e.g. blue, green, red, purple."),
                    "icon": icon_schema("project"),
                }),
                &["workspace_id", "name"],
            ),
        )
        .write(),
        ToolDef::new(
            "rename_project",
            "Rename or restyle a project",
            "Change a project's name, colour or icon (any of them; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "name": string("New name."),
                    "color": string("New colour name."),
                    "icon": icon_schema("project"),
                }),
                &["project_id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "duplicate_project",
            "Duplicate a project",
            "Copy a project (tables, fields, views and icons; records only with include_records) into the same workspace. Needs the manage permission and the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "name": string("Name of the copy (default: '<name> copy')."),
                    "include_records": boolean("Copy the records too (default false)."),
                }),
                &["project_id"],
            ),
        )
        .manage(),
        ToolDef::new(
            "delete_project",
            "Delete a project",
            "Delete a project with everything in it. It moves to the trash and can be restored within the trash retention period (restore_from_trash, kind 'project'). Needs the manage permission and the owner role.",
            object(json!({ "project_id": string(BASE_ID) }), &["project_id"]),
        )
        .manage()
        .destructive(),
        ToolDef::new(
            "create_table",
            "Create a table",
            "Add a table to a project, optionally with an icon and its fields, so a typical table is set up in ONE call. Every new table starts with just the primary text field 'Name' and a grid view, exactly like the first table of a new project (create_project): nothing else is added, so you do not need to check which fields exist. Pass `fields` (same shape as create_field: name, type, options, description, inverse_name; listed in order after 'Name') to create the rest at once (rich_text for notes, summaries and articles; text for names and codes). It is all or nothing: every field is validated first and if one is invalid nothing is created, and the error names it (e.g. fields[2] 'Status'). A link may point to any table of the project, including ones created earlier; a lookup, rollup or count may use a link field listed earlier in `fields` (options.link_field) and formulas may use any field listed before them. To link a table to itself, create the table and then call create_field. Rename the primary field afterwards with update_field if 'Name' does not fit. Then set up the views the table's purpose calls for (create_view; the result's views_note says how). Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "name": string("Table name."),
                    "icon": icon_schema("table"),
                    "fields": {
                        "type": "array",
                        "description": "Fields to create after the primary field 'Name', in order. Each one is exactly the arguments of create_field without project_id and table. 'Name' is taken by the primary field, so give the other fields other names. The whole call fails, creating nothing, if any field is invalid.",
                        "items": object(
                            json!({
                                "name": string("Field name (unique within the table; 'Name' is the primary field)."),
                                "type": ftype.clone(),
                                "options": options.clone(),
                                "description": string("Optional field description."),
                                "inverse_name": string("For link fields: the name of the field created in the linked table (default: this table's name)."),
                            }),
                            &["name", "type"],
                        ),
                    },
                }),
                &["project_id", "name"],
            ),
        )
        .write(),
        ToolDef::new(
            "rename_table",
            "Rename a table or change its icon",
            "Change a table's name, description and/or icon (any of them; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("New name."),
                    "description": string("New description."),
                    "icon": icon_schema("table"),
                }),
                &["project_id", "table"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "reorder_tables",
            "Reorder a project's tables",
            "Put some of a project's tables in a new order, as in the sidebar. List tables (by name or id) in the order you want them: the listed tables take the places they now hold, in that order, and every table you leave out stays where it is. So listing two tables swaps them and listing all of them sets the whole order. Listing the same tables again changes nothing. The result is the project's resulting table order. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "tables": string_list("Table names or ids in the order they should appear; at least one, none twice."),
                }),
                &["project_id", "tables"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "duplicate_table",
            "Duplicate a table",
            "Copy a table (fields, views and icon, and the records unless include_records is false) within its project. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("Name of the copy (default: '<name> copy')."),
                    "include_records": boolean("Copy the records too (default true)."),
                }),
                &["project_id", "table"],
            ),
        )
        .write(),
        ToolDef::new(
            "delete_table",
            "Delete a table",
            "Delete a table with its records. It moves to the trash and can be restored (restore_from_trash, kind 'table'). Link fields pointing at it are trashed with it. Needs the creator role.",
            object(
                json!({ "project_id": string(BASE_ID), "table": string(TABLE) }),
                &["project_id", "table"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "create_field",
            "Create a field",
            "Add a field (column) to a table. All 28 types are supported; call field_types for what each is for, its options and value shape. Pick rich_text, not text, for anything people will read as prose: notes, summaries, descriptions, articles, blog posts; text is for short plain values such as names, titles and codes. Link fields also create the inverse field in the other table (name it with inverse_name). Computed fields (formula, lookup, rollup, count, ...) are filled in automatically. The result's views_note says what to check in the table's views (forms do not ask for a new field until you add it). Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("Field name (unique within the table)."),
                    "type": ftype.clone(),
                    "options": options.clone(),
                    "description": string("Optional description."),
                    "inverse_name": string("Link fields only: name of the field created in the linked table (default: the table's name)."),
                }),
                &["project_id", "table", "name", "type"],
            ),
        )
        .write(),
        ToolDef::new(
            "update_field",
            "Update a field",
            "Rename a field, change its description or options (options you give are merged into the current ones; select choices repeated by name keep their values), or change its type. Changing the type (or turning a text field's multiline off) CONVERTS every existing value and may lose values that do not fit: the first call explains this and you repeat it with confirm_conversion=true. Text and rich text convert both ways: rich text becomes the plain text it shows, and plain text becomes rich text that shows the same; the result lists the views that use the field (views_to_check) so you can fix them. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                    "name": string("New name."),
                    "description": string("New description."),
                    "type": ftype,
                    "options": free_object("Options to change, in the shape of create_field's `options` (merged into the current ones; names accepted). Needed with `type` for types that require options."),
                    "confirm_conversion": boolean("Set true to confirm a type change (or multiline turned off) that converts existing data."),
                }),
                &["project_id", "table", "field"],
            ),
        )
        .write(),
        ToolDef::new(
            "delete_field",
            "Delete a field",
            "Delete a field and the fields that depend on it (lookups, rollups, the inverse of a link). They move to the trash and can be restored with restore_from_trash (kind 'field'). The result lists the views that used them (views_to_check: a calendar's date field, a kanban's stack field, a filter, a form question, ...) so you can fix or delete those views. Needs the creator role.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                }),
                &["project_id", "table", "field"],
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
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "field": string("Field name or id."),
                }),
                &["project_id", "table", "field"],
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
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "expression": string("Formula, e.g. {Price} * {Qty} or IF({Status} = 'Done', 1, 0)."),
                    "record_id": string("Record to preview against (default: the table's first record)."),
                }),
                &["project_id", "table", "expression"],
            ),
        )
        // The REST endpoint is a POST that needs a token with write access, though it changes
        // nothing.
        .write()
        .idempotent(),
        ToolDef::new(
            "list_icons",
            "Search icon names",
            "Search the Lucide icon names that workspaces, projects and tables can have (set with the `icon` argument of create_workspace / rename_workspace, create_project / rename_project and create_table / rename_table). Every word of `query` has to match an icon's name or one of its old names ('cart shop' finds shopping-cart, 'home' finds house); without a query the first icons alphabetically are listed. Names are kebab-case, e.g. briefcase, users, chart-column.",
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
        "create_project" => with_args!(CreateBase, create_project),
        "rename_project" => with_args!(RenameBase, rename_project),
        "duplicate_project" => with_args!(DuplicateBase, duplicate_project),
        "delete_project" => with_args!(BaseArg, delete_project),
        "create_table" => with_args!(CreateTable, create_table),
        "rename_table" => with_args!(RenameTable, rename_table),
        "reorder_tables" => with_args!(ReorderTables, reorder_tables),
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
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableArg {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    table: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldArg {
    #[serde(rename = "project_id", alias = "base_id")]
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

// -------------------------------------------------------------------------------- projects

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

async fn create_project(ctx: &McpCtx, a: CreateBase) -> ToolResult {
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
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn rename_project(ctx: &McpCtx, a: RenameBase) -> ToolResult {
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
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    include_records: Option<bool>,
}

async fn duplicate_project(ctx: &McpCtx, a: DuplicateBase) -> ToolResult {
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

async fn delete_project(ctx: &McpCtx, a: BaseArg) -> ToolResult {
    match fetch(ctx, "DELETE", &base_path(&a.base_id, ""), None, None).await {
        Ok(_) => ToolResult::ok(json!({
            "deleted": a.base_id,
            "note": format!(
                "Moved to the trash, not erased: restore_from_trash (kind 'project') brings it back within {} days.",
                ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------------- tables

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewField {
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTable {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    name: String,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
    #[serde(default)]
    fields: Option<Vec<NewField>>,
}

/// The REST body of one entry of `fields`: names in `options` become ids. `table` is the new
/// table as far as it is known (its primary field and the fields before this one), with each
/// field's name as its id: a reference to such a field is a name that the endpoint maps to the
/// real id once the field exists.
fn new_field_body(
    schema: &ob_core::api::schema::BaseSchema,
    table: &Table,
    mut f: NewField,
) -> Result<Value, String> {
    check_type(&f.field_type).map_err(|e| e.text)?;
    f.field_type = canonical_type(&f.field_type).to_string();
    let mut options = f.options.unwrap_or_else(|| json!({}));
    field_options_to_ids(schema, table, &f.field_type, &mut options, None)?;
    let mut body = Map::new();
    body.insert("name".into(), json!(f.name));
    body.insert("type".into(), json!(f.field_type));
    body.insert("options".into(), options);
    insert_some(&mut body, "description", f.description);
    insert_some(&mut body, "inverse_name", f.inverse_name);
    Ok(Value::Object(body))
}

/// A stand-in for a field already defined in the same `create_table` call, so later fields can
/// refer to it by name. Only a link field's kind matters (a lookup checks that its link field
/// is one); the others are placeholders.
fn placeholder_field(body: &Value) -> Field {
    let name = body["name"].as_str().unwrap_or_default().to_string();
    let kind = serde_json::from_value::<ob_core::field::FieldKind>(
        json!({ "type": body["type"], "options": body["options"] }),
    )
    .ok()
    .filter(|k| matches!(k, ob_core::field::FieldKind::Link(_)))
    .unwrap_or_else(|| ob_core::field::FieldKind::Text(ob_core::field::TextOptions::default()));
    Field {
        id: name.clone(),
        table_id: String::new(),
        name,
        description: None,
        kind,
    }
}

async fn create_table(ctx: &McpCtx, a: CreateTable) -> ToolResult {
    let mut body = Map::new();
    body.insert("name".into(), json!(a.name));
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if let Some(list) = a.fields.filter(|l| !l.is_empty()) {
        let schema = match load_schema(ctx, &a.base_id).await {
            Ok(s) => s,
            Err(e) => return e,
        };
        let mut new_table = Table {
            id: String::new(),
            base_id: a.base_id.clone(),
            name: a.name.clone(),
            icon: None,
            description: None,
            primary_field_id: "Name".into(),
            fields: Vec::new(),
            views: Vec::new(),
        };
        new_table.fields.push(Field {
            id: "Name".into(),
            table_id: String::new(),
            name: "Name".into(),
            description: None,
            kind: ob_core::field::FieldKind::Text(ob_core::field::TextOptions::default()),
        });
        let mut defs = Vec::new();
        for (i, f) in list.into_iter().enumerate() {
            let label = format!("fields[{i}] '{}'", f.name);
            let def = match new_field_body(&schema, &new_table, f) {
                Ok(d) => d,
                Err(e) => {
                    return ToolResult::error(format!("{label}: {e} Nothing was created."));
                }
            };
            new_table.fields.push(placeholder_field(&def));
            defs.push(def);
        }
        body.insert("fields".into(), Value::Array(defs));
    }
    match fetch(
        ctx,
        "POST",
        &base_path(&a.base_id, "/tables"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(with_note(
            json!({ "table": table_out(&v), "views_note": NEW_TABLE_VIEWS }),
            note,
        )),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameTable {
    #[serde(rename = "project_id", alias = "base_id")]
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
struct ReorderTables {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    tables: Vec<String>,
}

async fn reorder_tables(ctx: &McpCtx, a: ReorderTables) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let scope = format!(" in project '{}'", schema.name);
    let picked = match pick_many(
        &schema.tables,
        &a.tables,
        "table",
        &scope,
        |t| &t.id,
        |t| &t.name,
    ) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let ids: Vec<&str> = picked.iter().map(|t| t.id.as_str()).collect();
    let path = base_path(&a.base_id, "/tables/reorder");
    if let Err(e) = fetch(ctx, "POST", &path, None, Some(json!({ "ids": ids }))).await {
        return e;
    }
    let after = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    ToolResult::ok(json!({
        "project": { "id": after.id, "name": after.name },
        "tables": after.tables.iter().map(|t| json!({ "id": t.id, "name": t.name })).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateTable {
    #[serde(rename = "project_id", alias = "base_id")]
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

/// The current name of a field type: `single_line_text` and `long_text`
/// (the names before v0.8) are still understood. Other names are returned as given.
fn canonical_type(t: &str) -> &str {
    match t {
        "single_line_text" => "text",
        "long_text" => "rich_text",
        t => t,
    }
}

fn check_type(t: &str) -> Result<(), ToolResult> {
    if type_names().contains(&canonical_type(t)) {
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
    #[serde(rename = "project_id", alias = "base_id")]
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

async fn create_field(ctx: &McpCtx, mut a: CreateField) -> ToolResult {
    if let Err(e) = check_type(&a.field_type) {
        return e;
    }
    a.field_type = canonical_type(&a.field_type).to_string();
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
        Ok(field) => ToolResult::ok(json!({
            "field": field_out(&field),
            "views_note": new_field_views_note(table, &a.field_type),
        })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateField {
    #[serde(rename = "project_id", alias = "base_id")]
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
    let new_type = a
        .field_type
        .as_deref()
        .map_or_else(|| current_type.clone(), |t| canonical_type(t).to_string());
    let converts = new_type != current_type;
    if converts && a.confirm_conversion != Some(true) {
        return ToolResult::error(conversion_warning(table, field, &current_type, &new_type));
    }
    let joins_lines = !converts
        && new_type == "text"
        && current_options(field).get("multiline") == Some(&json!(true))
        && a.options.as_ref().and_then(|o| o.get("multiline")) == Some(&json!(false));
    if joins_lines && a.confirm_conversion != Some(true) {
        return ToolResult::error(format!(
            "Turning multiline off for '{}' in '{}' joins the lines of every existing value \
             (each line break becomes a space), and the old values are not kept. If this is \
             intended, repeat the call with confirm_conversion=true.",
            field.name, table.name
        ));
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
                let using = views_using(table, std::slice::from_ref(&field.id));
                if !using.is_empty() {
                    out["views_to_check"] = json!(using);
                    out["views_note"] = json!(VIEWS_TO_CHECK);
                }
            }
            ToolResult::ok(out)
        }
        Err(e) => e,
    }
}

/// Beside `views_to_check` in the results of delete_field and of type changes.
const VIEWS_TO_CHECK: &str = "These views used the field (`uses` says where). Fix each with update_view: a calendar, timeline or kanban needs another field of the right type for that setting, a form another question, a filter or sort another field; if the view no longer serves a purpose, delete_view.";

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
        Ok(v) => {
            let deleted = v
                .get("deleted_field_ids")
                .cloned()
                .unwrap_or(json!([field.id]));
            let ids: Vec<String> = serde_json::from_value(deleted.clone()).unwrap_or_default();
            let using: Vec<Value> = schema
                .tables
                .iter()
                .flat_map(|t| {
                    views_using(t, &ids).into_iter().map(move |mut u| {
                        u["table"] = json!(t.name);
                        u
                    })
                })
                .collect();
            let mut out = json!({
                "deleted_field_ids": deleted,
                "note": format!(
                    "Moved to the trash with their values: restore_from_trash (kind 'field', id '{}') brings them back within {} days.",
                    field.id, ctx.state.config.trash_days
                ),
            });
            if !using.is_empty() {
                out["views_to_check"] = json!(using);
                out["views_note"] = json!(VIEWS_TO_CHECK);
            }
            ToolResult::ok(out)
        }
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
    #[serde(rename = "project_id", alias = "base_id")]
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

/// One field type explained to an agent.
struct TypeHelp {
    name: &'static str,
    label: &'static str,
    computed: bool,
    /// What the type is for: how an agent chooses between types.
    use_for: &'static str,
    options: String,
    value: String,
    example: Value,
}

fn catalogue() -> Vec<TypeHelp> {
    let e = |name: &'static str,
             label: &'static str,
             computed: bool,
             use_for: &'static str,
             options: &str,
             value: &str,
             example: Value| TypeHelp {
        name,
        label,
        computed,
        use_for,
        options: options.to_string(),
        value: value.to_string(),
        example,
    };
    vec![
        e(
            "text",
            "Text",
            false,
            "Short plain values: names, titles, codes, ids, a single sentence. With multiline: plain text whose line breaks matter but that has no formatting, like a postal address. Not for notes, summaries or articles: use rich_text",
            "{multiline?: boolean (false), default?: string} multiline keeps line breaks; without it a line break becomes a space. Never formatted: Markdown shows as typed",
            "string",
            json!({}),
        ),
        e(
            "rich_text",
            "Rich text",
            false,
            "Anything written to be read: notes, summaries, descriptions, meeting minutes, articles, blog posts, documentation, instructions. It is Markdown: text formatting (bold, italics, headings, links, code), tables, lists and checklists, images and other embedded files, @mentions, quotes and more. Choose it over text for anything longer than a sentence",
            "{} (no options; always multiline Markdown). It can embed files of the same project, see upload_attachment (`markdown`); an https:// image is shown only as a link; @[Name](usrXXXX) mentions a person (notified when the cell is saved)",
            "Markdown string",
            json!({}),
        ),
        e(
            "number",
            "Number",
            false,
            "Whole or decimal numbers: quantities, scores, measurements",
            "{precision: 0-8 (0), allow_negative: true, default?: number}",
            "number",
            json!({"precision": 2}),
        ),
        e(
            "currency",
            "Currency",
            false,
            "Money amounts, shown with a symbol",
            "{precision: 2, symbol: \"$\", allow_negative: true}",
            "number",
            json!({"symbol": "EUR "}),
        ),
        e(
            "percent",
            "Percent",
            false,
            "Percentages: rates, progress, shares",
            "{precision: 0, allow_negative: true, default?}",
            "fraction: 0.25 is 25%",
            json!({"precision": 1}),
        ),
        e(
            "duration",
            "Duration",
            false,
            "Lengths of time: hours, minutes and seconds",
            "{format: h_mm | h_mm_ss | h_mm_ss_s | h_mm_ss_ss | h_mm_ss_sss}",
            "seconds as a number; with typecast also \"1:30:00\"",
            json!({"format": "h_mm_ss"}),
        ),
        e(
            "rating",
            "Rating",
            false,
            "A score shown as stars or hearts",
            "{max: 1-10 (5), icon: \"star\", color: \"yellow\"}",
            "integer 1..max",
            json!({"max": 5}),
        ),
        e(
            "checkbox",
            "Checkbox",
            false,
            "Yes or no: done, approved, active",
            "{icon: \"check\", color: \"green\"}",
            "true or false",
            json!({}),
        ),
        e(
            "single_select",
            "Single select",
            false,
            "One option from a fixed list: status, category, priority, stage",
            "{choices: [\"Todo\", {name: \"Done\", color: \"green\"}]} choices are names or {name, color?}; colours: blue cyan teal green yellow orange red pink purple gray (+ _dark). Pass color to set it at creation. Without one, common severity/status names get a matching colour (Critical/Urgent red, High orange, Medium/In Progress yellow, Low/Done green, Open/Todo blue, Cancelled gray) and any other name cycles through the palette",
            "choice name; with typecast a missing choice is created",
            json!({"choices": ["Todo", "Doing", {"name": "Done", "color": "green"}]}),
        ),
        e(
            "multiple_select",
            "Multiple select",
            false,
            "Several options from a fixed list: tags, labels, skills",
            "same as single_select",
            "array of choice names",
            json!({"choices": ["Urgent", "Billing"]}),
        ),
        e(
            "date",
            "Date",
            false,
            "A date, optionally with a time: due dates, events, deadlines",
            DATE_OPTS,
            "\"YYYY-MM-DD\", or an ISO datetime when include_time",
            json!({"include_time": false, "date_format": "iso"}),
        ),
        e(
            "email",
            "Email",
            false,
            "An email address",
            "{}",
            "string",
            json!({}),
        ),
        e("url", "URL", false, "A web link", "{}", "string", json!({})),
        e(
            "phone",
            "Phone number",
            false,
            "A phone number",
            "{}",
            "string",
            json!({}),
        ),
        e(
            "attachment",
            "Attachment",
            false,
            "Files and images kept with the record",
            "{}",
            "array of {id}: upload with upload_attachment (same project), then write the returned reference",
            json!({}),
        ),
        e(
            "link",
            "Link to another record",
            false,
            "Records of another table (or this one): relationships such as a task's project or an order's customer",
            "{linked_table: name or id, single?: boolean (one record only), picker_view?: view of the linked table}. Also pass inverse_name to create_field: the name of the matching field created in the other table (both sides are kept in sync)",
            "array of record ids of the linked table (results show {id, name})",
            json!({"linked_table": "Customers", "single": true}),
        ),
        e(
            "user",
            "User",
            false,
            "People who can access the project: owner, assignee, reviewer",
            "{multiple?: boolean, notify?: boolean}",
            "{id} or {email} (array for multiple); the person must have access to the project (list_collaborators)",
            json!({"multiple": false}),
        ),
        e(
            "formula",
            "Formula",
            true,
            "A value calculated from other fields of the record",
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
            "Values of a field of the linked records",
            "{link_field: a link field of this table, target_field: a field of the linked table}",
            "not writable; an array of the linked records' values",
            json!({"link_field": "Customer", "target_field": "Email"}),
        ),
        e(
            "rollup",
            "Rollup",
            true,
            "A summary (sum, count, list, ...) of a field of the linked records",
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
            "How many records are linked",
            "{link_field: a link field of this table}",
            "not writable; number of linked records",
            json!({"link_field": "Orders"}),
        ),
        e(
            "created_time",
            "Created time",
            true,
            "When the record was created",
            DATE_OPTS,
            "not writable; set when the record is created",
            json!({"include_time": true}),
        ),
        e(
            "last_modified_time",
            "Last modified time",
            true,
            "When the record (or some of its fields) last changed",
            "{fields?: [names watched; empty = any editable field], date?: date options}",
            "not writable",
            json!({"fields": []}),
        ),
        e(
            "created_by",
            "Created by",
            true,
            "Who created the record",
            "{}",
            "not writable",
            json!({}),
        ),
        e(
            "last_modified_by",
            "Last modified by",
            true,
            "Who last changed the record (or some of its fields)",
            "{fields?: [names watched]}",
            "not writable",
            json!({}),
        ),
        e(
            "autonumber",
            "Autonumber",
            true,
            "A number counting up in creation order",
            "{}",
            "not writable; 1, 2, 3, ... in creation order",
            json!({}),
        ),
        e(
            "barcode",
            "Barcode",
            false,
            "A barcode's value",
            "{}",
            "string or {text}",
            json!({}),
        ),
        e(
            "button",
            "Button",
            true,
            "A button that opens a link made from the record",
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
                .map(|h| json!({
                    "type": h.name,
                    "label": h.label,
                    "computed": h.computed,
                    "use_for": h.use_for,
                    "value": h.value,
                }))
                .collect::<Vec<_>>(),
            "usage": "create_field {project_id, table, name, type, options}. Call field_types with `type` for the options of one type. For text, pick by what the value is: rich_text for anything written to be read (notes, summaries, descriptions, articles, posts), text for short plain values (names, titles, codes).",
        })),
        Some(t) => match all.iter().find(|h| h.name == canonical_type(&t)) {
            None => ToolResult::error(format!(
                "Unknown field type '{t}'. Types: {}.",
                type_names().join(", ")
            )),
            Some(h) => ToolResult::ok(json!({
                "type": h.name,
                "label": h.label,
                "computed": h.computed,
                "use_for": h.use_for,
                "options": h.options,
                "value": h.value,
                "example": { "tool": "create_field", "arguments": { "name": h.label, "type": h.name, "options": h.example } },
            })),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_help_covers_every_type_exactly_once() {
        let helped: Vec<&str> = catalogue().iter().map(|e| e.name).collect();
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
        assert!(e.text.contains("rich_text"));
        // The names before v0.8 still work.
        assert!(check_type("single_line_text").is_ok());
        assert!(check_type("long_text").is_ok());
    }
}
