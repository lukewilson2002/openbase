//! Views: create and configure any view type with field NAMES, read a view's configuration, and
//! query a view the way the web app shows it (filter, sort and grouping applied, hidden fields
//! left out).
//!
//! Configurations use the shape of the REST API's `ViewConfig`; wherever it expects a field id
//! a field name works too, and select filters take choice names ([`super::resolve::Xlate`]).

use ob_core::api::schema::{Table, View};
use ob_core::view::{Filter, FilterItem, RowColor, ViewType};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{
    Mode, People, Xlate, find_field, find_table, find_view, load_people, load_schema, merge_config,
    pick_many, value_for_model, view_for_model,
};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use crate::store::fields_engine::config_slots;

const VIEW_TYPES: &[&str] = &[
    "grid", "form", "gallery", "kanban", "calendar", "timeline", "list",
];
const DEFAULT_ROWS: usize = 50;
const MAX_ROWS: usize = 200;

const CONFIG_HELP: &str = "View configuration (all parts optional). filter: {conjunction: and|or, items: [{field_id: <field name>, op, value} | nested {conjunction, items}]}, ops: is, is_not, is_empty, is_not_empty, contains, does_not_contain, starts_with, ends_with, lt, lte, gt, gte, is_any_of, is_none_of, has_any_of, has_all_of, has_none_of, is_exactly, is_before, is_after, is_on_or_before, is_on_or_after, is_within (select values are choice names; dates take {mode: today|tomorrow|yesterday|one_week_ago|one_week_from_now|one_month_ago|one_month_from_now|exact_date, date}|{mode: number_of_days_ago|number_of_days_from_now|past_number_of_days|next_number_of_days, days}|{mode: past_week|past_month|past_year|next_week|next_month|next_year|this_calendar_month|this_calendar_year} (the last two groups are for is_within). Relative modes (today, tomorrow, past_week, ...) are calendar days in the VIEWER's time zone, not the server's or UTC: the app sends the browser's zone, query_view uses its timezone argument, else the token owner's profile time zone, else UTC. Date-only fields are compared as calendar dates; date-times in the field's own time zone if it has one, else the viewer's. exact_date is the calendar day as written). sorts and groups: [{field_id: <name>, direction: asc|desc}] (groups: up to 3 levels; a group on a date field also takes granularity: day|week|month|quarter|year, default day, bucketed in the viewer's time zone like date filters). hidden_fields and field_order: lists of field names. field_widths and summaries: objects keyed by field name (summaries: one of empty, filled, unique, percent_empty, percent_filled, percent_unique, sum, average, median, min, max, range, std_dev, checked, unchecked, percent_checked, percent_unchecked, earliest_date, latest_date, date_range_days). row_height: short|medium|tall|extra_tall. frozen_columns: number. row_color: {mode: by_select, field_id} | {mode: by_conditions, rules: [{color, filter}]}. description_field_id (at the top of the config, for every view type, not inside kanban or the other sections): a text field read as each record's description under its title (kanban, gallery and list show an excerpt; calendar and timeline show it on hover). kanban: {stack_field_id (a single select, a user field that holds one person, or a checkbox field), cover_field_id, hide_empty_stacks, stack_order: [stack names, left to right: choice names for a single select, person names (or emails) for a user field, \"Checked\" / \"Unchecked\" for a checkbox; \"Uncategorized\" is the stack of cards with no value (the web app saves it as an empty string, and get_view shows it as \"Uncategorized\"); stacks you leave out follow the listed ones]}. calendar: {date_field_id, end_field_id}: both must be date fields (a date, created time or last modified time field, or a formula or rollup that returns a date) and the end must differ from the start; leave end_field_id out for single-day items. gallery: {cover_field_id, cover_crop}. timeline: {start_field_id, end_field_id (date fields as for the calendar, different from each other), group_field_id (swimlanes), dependency_field_id (a link field whose records are in this same table; it draws the arrows), scale: day|week|month|quarter|year, label_width: the left column's width in pixels, 80 to 480}. form: {title, description, fields: [{field_id, required, label, help}], submit_label, success_message, redirect_url, show_submit_another}. Every *_field_id and filter/sort `field_id` accepts a field NAME. A calendar, timeline or kanban field of the wrong type is refused with an error naming the field and the types that work.";

pub fn definitions() -> Vec<ToolDef> {
    let view_types = enumeration(VIEW_TYPES, "View type.");
    vec![
        ToolDef::new(
            "get_view",
            "Get a view",
            "Get a view's saved configuration (filter, sorts, grouping, hidden fields, settings) with field names instead of ids.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                }),
                &["project_id", "view"],
            ),
        ),
        ToolDef::new(
            "create_view",
            "Create a view",
            "Create a view of any type (grid, form, gallery, kanban, calendar, timeline, list) with an optional configuration. Make the views a table's purpose and its users call for, not one of every type: a calendar or timeline for dated records, a kanban stacked by a status, a gallery for pictures, a form for collecting entries, grids or lists filtered and sorted for recurring questions (e.g. 'Contacts by company', 'Overdue invoices'). Name a view for what it shows. Shared views need the creator role; personal views (personal=true) only the viewer role and are visible to you alone. Relative date filters such as {mode: today} follow the VIEWER's time zone (each person's profile or browser zone in the app, the `timezone` argument of query_view), not the server's or UTC; see `config`.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "name": string("View name."),
                    "type": view_types,
                    "personal": boolean("Make it visible to you only (default false)."),
                    "config": free_object(CONFIG_HELP),
                }),
                &["project_id", "table", "name", "type"],
            ),
        )
        .write(),
        ToolDef::new(
            "update_view",
            "Update a view",
            "Rename a view, lock it, or change its configuration. Parts of `config` you give replace the same parts of the saved config (kanban, calendar, gallery, timeline and form settings merge key by key); parts you omit stay; a null value resets a part. Shared views need the creator role. A table's default grid (is_default in get_project_schema) holds the layout of every record: change its field_order and hidden_fields to reorder or hide fields in every record (the editor role is enough); it cannot be renamed or locked and keeps no filter, sort, grouping or colours. Relative date filters such as {mode: today} follow the VIEWER's time zone, not the server's or UTC; see `config`.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                    "name": string("New name."),
                    "locked": boolean("Lock the view so only creators can reconfigure it."),
                    "config": free_object("The parts to change, in the shape of create_view's `config` (field names accepted)."),
                }),
                &["project_id", "view"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "reorder_views",
            "Reorder a table's views",
            "Put some of a table's views in a new order, as in the view list of the app. List views (by name or id) in the order you want them: the listed views take the places they now hold, in that order, and every view you leave out stays where it is. So listing two views swaps them and listing all of them sets the whole order. Listing the same views again changes nothing. You see the shared views and your own personal views: the shared views' order is the same for everyone and needs the creator role; a list of only your personal views needs the editor role (they are ordered among the shared ones in the same one list). The table's default grid (is_default in get_project_schema) is not one of the views: it always comes first, has no place to change and is refused here. The result is the resulting view order.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "views": string_list("View names or ids in the order they should appear; at least one, none twice, no default grid."),
                }),
                &["project_id", "table", "views"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "delete_view",
            "Delete a view",
            "Delete a view (it moves to the trash and can be restored with restore_from_trash, kind 'view'). Share links of the view stop working. Shared views need the creator role. A table's default grid cannot be deleted.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                }),
                &["project_id", "view"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "query_view",
            "Query a view",
            "Read the rows of a view exactly as the web app shows them: the view's filter, sort and grouping applied, hidden fields left out, computed fields included. When a view fits the question (get_project_schema lists them), read it instead of building the same filter in list_records. Returns records keyed by field NAME in view order, group headers (depth, field, label, start, count) for grouped views, and the total. Page with offset. To see what is on a calendar or timeline for a window (this week, next month) pass `from` and `to`: the same overlap rule the app uses for the days it shows.",
            object(
                json!({
                    "project_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                    "search": string("Optional text; only rows containing it in a visible field are returned."),
                    "max_records": integer("Rows to return (default 50, max 200).", 1, MAX_ROWS as u64),
                    "offset": integer("Index of the first row to return (default 0).", 0, 10_000_000),
                    "include_empty": boolean("Return visible fields with no value as null (default false: they are left out of a record's `fields`). `columns` always lists every visible field."),
                    "timezone": string("IANA time zone (for example America/Chicago) that decides what \"today\" means for relative date filters (today, tomorrow, past_week, ...) and which day, month or year a date-time is grouped under. Default: the time zone on your profile (set it with api_request PATCH /api/auth/me {timezone}), else UTC."),
                    "from": string("First day of a date range, YYYY-MM-DD (with `to`). Only records whose dates fall in the range are returned, as a calendar or timeline shows a window: a record is in when its span from start to end overlaps the range, one with a single date counts as that day, one with no date is left out. The dates come from the view's calendar or timeline settings, or from `date_field`."),
                    "to": string("Last day of the date range, YYYY-MM-DD, included (the same day as `from` for one day). Needs `from`."),
                    "date_field": string("Date field (name or id) the range is read from, and the start of each record's span. Default: the view's calendar date field or timeline start field; needed for other view types."),
                    "end_field": string("Optional date field (name or id) that ends each record's span. Default: the view's calendar or timeline end field."),
                }),
                &["project_id", "view"],
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
        "reorder_views" => with_args!(ReorderViews, reorder_views),
        "delete_view" => with_args!(ViewArg, delete_view),
        "query_view" => with_args!(QueryView, query_view),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewArg {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
}

/// The API's view JSON for a model, config in names.
fn present(table: &Table, view: &Value, people: &People) -> Value {
    view_for_model(table, view, people)
}

/// The project's people when the table has a user field: a kanban stacked by one names its
/// stacks by person.
async fn people_for(ctx: &McpCtx, base_id: &str, table: &Table) -> People {
    let has_user = table
        .fields
        .iter()
        .any(|f| matches!(f.kind, ob_core::field::FieldKind::User(_)));
    if has_user {
        load_people(ctx, base_id).await
    } else {
        People::default()
    }
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
        Ok((table, view)) => {
            let people = people_for(ctx, &a.base_id, table).await;
            ToolResult::ok(json!({ "view": present(table, &view_json(view), &people) }))
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateView {
    #[serde(rename = "project_id", alias = "base_id")]
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

/// Field and choice names in a config to ids. `stack_field` is the kanban stack field the view
/// already has (an update that only sets `stack_order` reads it against that field).
fn translate(
    table: &Table,
    people: &People,
    stack_field: Option<&str>,
    config: &mut Value,
) -> Result<(), ToolResult> {
    Xlate::new(table, Mode::ToIds)
        .with_people(people)
        .with_stack_field(stack_field)
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
    let people = people_for(ctx, &a.base_id, table).await;
    if let Some(mut config) = a.config.filter(|c| !c.is_null()) {
        if let Err(e) = translate(table, &people, None, &mut config) {
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
        Ok(view) => ToolResult::ok(json!({ "view": present(table, &view, &people) })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateView {
    #[serde(rename = "project_id", alias = "base_id")]
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
    let people = people_for(ctx, &a.base_id, table).await;
    if let Some(mut patch) = a.config.filter(|c| !c.is_null()) {
        if let Err(e) = translate(
            table,
            &people,
            view.config.kanban.stack_field_id.as_deref(),
            &mut patch,
        ) {
            return e;
        }
        let current = serde_json::to_value(&view.config).unwrap_or(Value::Null);
        body.insert("config".into(), merge_config(&current, &patch));
    }
    let path = format!("/api/views/{}", encode_segment(&view.id));
    match fetch(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(updated) => ToolResult::ok(json!({ "view": present(table, &updated, &people) })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReorderViews {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    table: String,
    views: Vec<String>,
}

async fn reorder_views(ctx: &McpCtx, a: ReorderViews) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let scope = format!(" in table '{}'", table.name);
    let picked = match pick_many(
        &table.views,
        &a.views,
        "view",
        &scope,
        |v| &v.id,
        |v| &v.name,
    ) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if let Some(default) = picked.iter().find(|v| v.is_default) {
        return ToolResult::error(format!(
            "'{}' is the table's default grid, not a view you can place: it always comes first. Leave it out and list the other views.",
            default.name
        ));
    }
    let ids: Vec<&str> = picked.iter().map(|v| v.id.as_str()).collect();
    let path = table_path(&table.id, "/views/reorder");
    if let Err(e) = fetch(ctx, "POST", &path, None, Some(json!({ "ids": ids }))).await {
        return e;
    }
    let after = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let Some(after) = after.tables.iter().find(|t| t.id == table.id) else {
        return ToolResult::error("The table disappeared while reordering.");
    };
    ToolResult::ok(json!({
        "table": { "id": after.id, "name": after.name },
        "views": after.views.iter().filter(|v| !v.is_default).map(|v| json!({
            "id": v.id,
            "name": v.name,
            "type": v.view_type,
            "personal": v.personal,
        })).collect::<Vec<_>>(),
        "note": "The table's default grid is not listed: it always comes first.",
    }))
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
    #[serde(rename = "project_id", alias = "base_id")]
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
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    date_field: Option<String>,
    #[serde(default)]
    end_field: Option<String>,
}

/// The `range` of a view query for `from` / `to`: the date fields come from the arguments, else
/// from the view's calendar or timeline settings.
fn date_range(table: &Table, view: &View, a: &QueryView) -> Result<Option<Value>, ToolResult> {
    let (from, to) = match (a.from.as_deref(), a.to.as_deref()) {
        (None, None) => {
            if a.date_field.is_some() || a.end_field.is_some() {
                return Err(ToolResult::error(
                    "date_field and end_field need a date range: give `from` and `to` too.",
                ));
            }
            return Ok(None);
        }
        (Some(f), Some(t)) => (f.trim(), t.trim()),
        _ => {
            return Err(ToolResult::error(
                "Give both `from` and `to` (YYYY-MM-DD); use the same day for one day.",
            ));
        }
    };
    let config = &view.config;
    let (default_start, default_end) = match view.view_type {
        ViewType::Calendar => (
            &config.calendar.date_field_id,
            &config.calendar.end_field_id,
        ),
        ViewType::Timeline => (
            &config.timeline.start_field_id,
            &config.timeline.end_field_id,
        ),
        _ => (&None, &None),
    };
    let start = match a.date_field.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(name) => find_field(table, name)?.id.clone(),
        None => default_start.clone().ok_or_else(|| {
            ToolResult::error(format!(
                "View '{}' has no date field to read the range from: give `date_field`{}.",
                view.name,
                match view.view_type {
                    ViewType::Calendar | ViewType::Timeline =>
                        " or set the view's date fields with update_view",
                    _ => "",
                }
            ))
        })?,
    };
    let end = match a.end_field.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(name) => Some(find_field(table, name)?.id.clone()),
        // Only the view's own start field goes with the view's own end field.
        None if a.date_field.is_none() => default_end.clone(),
        None => None,
    };
    Ok(Some(
        json!({ "field_id": start, "end_field_id": end, "from": from, "to": to }),
    ))
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
    if let Some(s) = a.search.as_ref().filter(|s| !s.trim().is_empty()) {
        body["search"] = json!(s);
    }
    if let Some(tz) = a.timezone.as_ref().filter(|t| !t.trim().is_empty()) {
        body["timezone"] = json!(tz);
    }
    let range = match date_range(table, view, &a) {
        Ok(r) => r,
        Err(e) => return e,
    };
    if let Some(r) = &range {
        body["range"] = r.clone();
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
    if let Some(r) = &range {
        out["range"] = json!({
            "from": r["from"],
            "to": r["to"],
            "date_field": name_of(r["field_id"].as_str().unwrap_or("")),
            "end_field": r["end_field_id"].as_str().map(name_of),
        });
    }
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

// ------------------------------------------------------------------- view upkeep

/// What a new table's result tells the model about views: only the default grid exists, and the
/// views the table's purpose calls for are the model's to set up.
pub const NEW_TABLE_VIEWS: &str = "The table has only its default grid ('Default grid', is_default: true): every record, laid out in its field order. Reorder or hide fields there (update_view) to change the layout of every record; it keeps no filter or sort and cannot be deleted. Now set up the views its purpose calls for with create_view, and only those: a calendar or timeline for dated records, a kanban stacked by a status, a gallery for pictures, a form for collecting entries, grids or lists filtered and sorted for the questions people ask (contacts by company, open tasks by due date). Name each for what it shows. People open them in the app, you can point them to one by name, and query_view reads one with its filter and sort applied.";

/// Types whose values the server computes; forms cannot ask for them.
const COMPUTED_TYPES: &[&str] = &[
    "formula",
    "lookup",
    "rollup",
    "count",
    "created_time",
    "last_modified_time",
    "created_by",
    "last_modified_by",
    "autonumber",
    "button",
];

/// What a new field of `field_type` in `table` (as it was before the field) may mean for the
/// table's views.
pub fn new_field_views_note(table: &Table, field_type: &str) -> String {
    let mut note = String::from(
        "Check whether this table's views should show, filter, sort or group by the new field",
    );
    note.push_str(match field_type {
        "date" | "created_time" | "last_modified_time" => {
            ", and whether its dates call for a calendar or timeline view or an upcoming/overdue filter."
        }
        "single_select" | "user" | "checkbox" => {
            ", and whether it calls for a kanban view stacked by it or a grid grouped by it."
        }
        "attachment" => ", and whether its pictures call for a gallery view with it as the cover.",
        _ => ".",
    });
    let forms: Vec<&str> = table
        .views
        .iter()
        .filter(|v| v.view_type == ViewType::Form)
        .map(|v| v.name.as_str())
        .collect();
    if !forms.is_empty() && !COMPUTED_TYPES.contains(&field_type) {
        note.push_str(&format!(
            " Forms list their questions: add it to config.form.fields of the forms that should ask for it ({}).",
            forms
                .iter()
                .map(|n| format!("'{n}'"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    note
}

/// The views of `table` whose filter, sorts, grouping, row colours, form or a setting (calendar
/// date field, kanban stack field, ...) name one of `field_ids`, with where each names them:
/// what to fix after those fields are deleted or change type. Column order, widths, hidden
/// fields and summaries are left out: they need no attention.
pub fn views_using(table: &Table, field_ids: &[String]) -> Vec<Value> {
    fn in_filter(f: &Filter, ids: &[String]) -> bool {
        f.items.iter().any(|item| match item {
            FilterItem::Condition(c) => ids.contains(&c.field_id),
            FilterItem::Group(g) => in_filter(g, ids),
        })
    }
    let names = |list: &[ob_core::view::Sort]| list.iter().any(|s| field_ids.contains(&s.field_id));
    table
        .views
        .iter()
        .filter_map(|v| {
            let c = &v.config;
            let mut uses: Vec<&str> = Vec::new();
            if c.filter.as_ref().is_some_and(|f| in_filter(f, field_ids)) {
                uses.push("filter");
            }
            if names(&c.sorts) {
                uses.push("sort");
            }
            if c.groups.iter().any(|g| field_ids.contains(&g.field_id)) {
                uses.push("group");
            }
            let colors = match &c.row_color {
                Some(RowColor::BySelect { field_id }) => field_ids.contains(field_id),
                Some(RowColor::ByConditions { rules }) => {
                    rules.iter().any(|r| in_filter(&r.filter, field_ids))
                }
                None => false,
            };
            if colors {
                uses.push("row color");
            }
            if c.form
                .fields
                .iter()
                .any(|f| field_ids.contains(&f.field_id))
            {
                uses.push("form");
            }
            for (slot, id) in config_slots(c) {
                if id.is_some_and(|id| field_ids.contains(id)) {
                    uses.push(slot);
                }
            }
            (!uses.is_empty()).then(|| json!({ "view": v.name, "type": v.view_type, "uses": uses }))
        })
        .collect()
}
