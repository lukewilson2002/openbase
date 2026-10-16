//! The curated tools: the data work an agent does most, with short LLM-oriented descriptions
//! and JSON Schema inputs, plus `api_reference` / `api_request` (the full-parity escape hatch,
//! see [`super::api`]) and a few account-management tools for tokens with the `manage`
//! permission.
//!
//! Record tools call the very functions behind the Airtable-compatible API (`crate::v1`), so
//! value shapes, `filterByFormula`, typecast, permission checks, history attribution, events
//! and automations are identical; this module only translates arguments and results.

use axum::http::HeaderMap;
use ob_core::view::Direction;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::api::{self, ApiCall};
use super::catalogue;
use super::support::*;
use super::tools::{Level, ToolDef, ToolResult};
use crate::error::AppError;
use crate::perm::{self, Role};
use crate::store::{bases, schema};
use crate::v1::aggregate;
use crate::v1::error::V1Error;
use crate::v1::records::{self, ListQuery, MAX_BATCH};
use ob_core::api::records::{AggregateRequest, AggregateSort, AggregateSpec};

/// `max_records` of the listing tools.
const DEFAULT_RECORDS: usize = 50;
const MAX_RECORDS: usize = 200;
/// `limit` of `aggregate_records`: default and maximum number of groups.
const DEFAULT_GROUPS_RETURNED: usize = 200;
const MAX_GROUPS_RETURNED: usize = 1000;
/// Names listed in a "valid names" hint.
const MAX_HINT_NAMES: usize = 40;

// ---------------------------------------------------------------------------------------------
// Definitions

pub fn definitions() -> Vec<ToolDef> {
    let role_names = json!(["viewer", "commenter", "editor", "creator", "owner"]);
    let scope = json!({ "type": "string", "enum": ["workspace", "base"], "description": "Whether `id` is a workspace id or a base id." });
    vec![
        tool(
            "list_bases",
            "List workspaces and bases",
            "List the workspaces and bases this token can reach, with your role on each (and their icons, when set). Start here to get base ids (and workspace ids for creating bases).",
            object(json!({}), &[]),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "get_base_schema",
            "Get a base's schema",
            "Get the tables, fields (name, id, type, options such as select choices or link targets) and views of a base. Use it to learn the exact table and field names before reading or writing records.",
            object(json!({ "base_id": string(BASE_ID) }), &["base_id"]),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "list_records",
            "List records",
            "List records of a table as {id, createdTime, fields} keyed by field NAME (linked records appear as {id, name}). Optionally use a saved view's filter/sort, an Airtable filterByFormula such as {Status}='Done', field selection and sorting. Returns up to max_records (default 50, max 200); if `offset` is returned there are more: call again with it.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "view": string("Optional view name or id; its filter, sorting and hidden records apply."),
                    "filter_by_formula": string("Optional Airtable formula; records where it is true are returned, e.g. AND({Status}='Open', {Priority}>2)."),
                    "fields": { "type": "array", "items": { "type": "string" }, "description": "Optional field names to return (default: all)." },
                    "sort": {
                        "type": "array",
                        "description": "Optional sort order, most important first.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": string("Field name."),
                                "direction": { "type": "string", "enum": ["asc", "desc"], "description": "Default asc." }
                            },
                            "required": ["field"],
                            "additionalProperties": false
                        }
                    },
                    "max_records": integer("How many records to return (default 50, max 200).", 1, MAX_RECORDS as u64),
                    "offset": string("The `offset` of a previous result, to get the next records."),
                }),
                &["base_id", "table"],
            ),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "search_records",
            "Search records",
            "Find records whose any field contains the text (case-insensitive). Same result shape as list_records.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "query": string("Text to look for (at most 500 characters)."),
                    "max_records": integer("How many records to return (default 50, max 200).", 1, MAX_RECORDS as u64),
                }),
                &["base_id", "table", "query"],
            ),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "aggregate_records",
            "Aggregate records (group by)",
            "Counts, sums, averages, minimums and maximums computed on the server, optionally per group, without reading the records. Give `group_by` field names (e.g. [\"Status\"]; none = one row of totals) and `aggregates` ([{\"function\": \"sum\", \"field\": \"Amount\"}]; functions: count, sum, avg, min, max; sum and avg need a number field, min and max a number or date field; count with no field counts records, with a field it counts the records where that field is filled; default is one count). Narrow the records like list_records: `view` and/or `filter_by_formula`. Returns {group_by, groups: [{group: {Field: value}, aggregates: {alias: value}}], total_groups, truncated, record_count}. Group values are names, never ids: a select's choice name, linked records / people / multiple selects as arrays of names, dates as YYYY-MM-DD, null for the empty group; a multiple select, link or people field groups by its exact combination of values. Aggregates are named `count` or `<function>_<Field>` unless you give an `alias`.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "group_by": string_list("Field names to group by (at most 3). Leave out for one row of totals."),
                    "aggregates": {
                        "type": "array",
                        "description": "What to compute per group (default: one count).",
                        "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "function": { "type": "string", "enum": ["count", "sum", "avg", "min", "max"], "description": "count, sum, avg, min or max." },
                                "field": string("Field name. Optional for count only."),
                                "alias": string("Name of the value in the result (default `count` or `<function>_<Field>`).")
                            },
                            "required": ["function"],
                            "additionalProperties": false
                        }
                    },
                    "view": string("Optional view name or id; only records its filter keeps are included."),
                    "filter_by_formula": string("Optional Airtable formula; only records where it is true are included, e.g. {Status}='Done'."),
                    "sort": {
                        "type": "array",
                        "description": "Optional order of the groups, most important first (default: by the group_by values).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "by": string("An aggregate alias or a group_by field name."),
                                "direction": { "type": "string", "enum": ["asc", "desc"], "description": "Default asc." }
                            },
                            "required": ["by"],
                            "additionalProperties": false
                        }
                    },
                    "limit": integer("Most groups to return (default 200, max 1000); `truncated` says whether more exist.", 1, MAX_GROUPS_RETURNED as u64),
                }),
                &["base_id", "table"],
            ),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "get_record",
            "Get a record",
            "Get one record by id as {id, createdTime, fields} keyed by field name.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "record_id": string("Record id, e.g. recXXXXXXXXXXXXXX."),
                }),
                &["base_id", "table", "record_id"],
            ),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "create_records",
            "Create records",
            "Create 1-10 records. Each record is {\"fields\": {\"Field name\": value}}. Value shapes follow the Airtable API: text, number, checkbox true/false, date 'YYYY-MM-DD' or ISO datetime, single select 'Choice', multiple select ['A','B'], linked records as an array of record ids (results show linked records as {id, name}). Computed fields cannot be set. With typecast (default true) values are converted leniently and new select choices are created.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "records": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_BATCH,
                        "description": "Records to create (at most 10).",
                        "items": {
                            "type": "object",
                            "properties": { "fields": { "type": "object", "description": "Field name -> value." } },
                            "required": ["fields"],
                            "additionalProperties": false
                        }
                    },
                    "typecast": { "type": "boolean", "description": "Convert values leniently and create missing select choices (default true)." },
                }),
                &["base_id", "table", "records"],
            ),
            Level::Write,
            false,
            false,
            false,
        ),
        tool(
            "update_records",
            "Update records",
            "Update 1-10 existing records. Each is {\"id\": \"rec...\", \"fields\": {...}}; only the fields you give change (set a field to null to clear it). Same value shapes as create_records. The change is attributed to you in the record history.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "records": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_BATCH,
                        "description": "Records to update (at most 10).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": string("Record id."),
                                "fields": { "type": "object", "description": "Field name -> new value." }
                            },
                            "required": ["id", "fields"],
                            "additionalProperties": false
                        }
                    },
                    "typecast": { "type": "boolean", "description": "Convert values leniently and create missing select choices (default true)." },
                }),
                &["base_id", "table", "records"],
            ),
            Level::Write,
            false,
            false,
            true,
        ),
        tool(
            "delete_records",
            "Delete records",
            "Delete 1-10 records by id. They are moved to the trash (restorable for the trash retention period, 30 days by default), not erased immediately.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "table": string(TABLE),
                    "record_ids": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_BATCH,
                        "items": { "type": "string" },
                        "description": "Ids of the records to delete (at most 10)."
                    },
                }),
                &["base_id", "table", "record_ids"],
            ),
            Level::Write,
            false,
            true,
            true,
        ),
        tool(
            "list_comments",
            "List comments",
            "List the comments on a record, oldest first.",
            object(json!({ "record_id": string("Record id.") }), &["record_id"]),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "add_comment",
            "Add a comment",
            "Comment on a record as the token's user. To mention someone write @[Name](usrXXXX) with their user id (see get_base_schema / the collaborators endpoint in api_reference).",
            object(
                json!({
                    "record_id": string("Record id."),
                    "body": string("Comment text (plain text)."),
                }),
                &["record_id", "body"],
            ),
            Level::Write,
            false,
            false,
            false,
        ),
        tool(
            "api_reference",
            "Look up REST endpoints",
            "Catalogue of every REST endpoint of OpenBase's internal API (what the web app uses): method, path, purpose, minimum role, required token permission and request/response summary. Without `area` it lists the areas; with one it lists that area's endpoints in detail. Use it before api_request.",
            object(
                json!({ "area": string("Area to list in detail: workspaces, bases, tables, fields, views, records, comments, search, trash, csv, attachments, sharing, automations, invites, notifications, account, admin, airtable, system.") }),
                &[],
            ),
            Level::Read,
            true,
            false,
            true,
        ),
        tool(
            "api_request",
            "Call a REST endpoint",
            "Call any endpoint listed by api_reference as the token's user: the request goes through the same permission checks, validation, live updates and automations as the web app. `path` starts with /api/ and contains real ids; `query` is an object; `body` is the JSON body (for file uploads and CSV import use {\"multipart\": {\"file\": {\"filename\": \"x.csv\", \"text\": \"...\"}, \"name\": \"value\"}}, with content_base64 instead of text for binary files). Returns {status, ok, body}. Account credentials, sessions and API tokens cannot be touched. Read-only tokens can only read; some endpoints need a token with the manage permission.",
            object(
                json!({
                    "method": { "type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"], "description": "HTTP method." },
                    "path": string("Request path starting with /api/, e.g. /api/tables/tblXXXX/fields. No query string."),
                    "query": { "type": "object", "description": "Query parameters as an object (lists repeat the key)." },
                    "body": { "description": "JSON request body, or {\"multipart\": {...}} for uploads." },
                }),
                &["method", "path"],
            ),
            Level::Read,
            false,
            true,
            false,
        ),
        tool(
            "create_workspace",
            "Create a workspace",
            "Create a workspace, optionally with an icon; you become its owner. Needs the manage permission.",
            object(
                json!({
                    "name": string("Workspace name."),
                    "icon": icon_schema("workspace"),
                }),
                &["name"],
            ),
            Level::Manage,
            false,
            false,
            false,
        ),
        tool(
            "list_members",
            "List members",
            "List the members of a workspace with their role and the bases each can open (all_bases, or the base_ids they were given), or, for a base, the workspace members who can open it. People get access only by being workspace members. Needs the manage permission.",
            object(
                json!({ "scope": scope.clone(), "id": string("Workspace id or base id.") }),
                &["scope", "id"],
            ),
            Level::Manage,
            true,
            false,
            true,
        ),
        tool(
            "set_member_role",
            "Change a member's role or bases",
            "Change a workspace member's role and/or the bases they can open: all_bases true gives every base (including later ones), base_ids limits them to those bases. One role applies to every base they can open; owners always have all bases. Only scope 'workspace' is accepted (there are no per-base roles). Needs the manage permission and the owner role.",
            object(
                json!({
                    "scope": scope.clone(),
                    "id": string("Workspace id."),
                    "user_id": string("User id of the member (from list_members)."),
                    "role": { "type": "string", "enum": role_names.clone(), "description": "New role (leave out to keep it)." },
                    "all_bases": { "type": "boolean", "description": "true: every base of the workspace, including bases made later." },
                    "base_ids": { "type": "array", "items": { "type": "string" }, "description": "Limit the member to these bases of the workspace (at least one)." },
                }),
                &["scope", "id", "user_id"],
            ),
            Level::Manage,
            false,
            false,
            true,
        ),
        tool(
            "create_invite",
            "Invite someone",
            "Create an invite link to join a workspace. Scope 'workspace' (owner role needed): any role, every base by default or only base_ids. Scope 'base' (creator role on that base needed): only that base by default, or base_ids you can open yourself; never all bases and never above your own role. Give the link to the person; with an email, the invite is only valid for that address (and emailed if the server can send mail). Needs the manage permission.",
            object(
                json!({
                    "scope": scope,
                    "id": string("Workspace id or base id."),
                    "role": { "type": "string", "enum": role_names, "description": "Role the invitee gets (not above your own)." },
                    "email": string("Optional: restrict the invite to this email address."),
                    "all_bases": { "type": "boolean", "description": "true: every base of the workspace, including bases made later (workspace owners only)." },
                    "base_ids": { "type": "array", "items": { "type": "string" }, "description": "Bases of the workspace the invitee can open." },
                }),
                &["scope", "id", "role"],
            ),
            Level::Manage,
            false,
            false,
            false,
        ),
    ]
}

// ---------------------------------------------------------------------------------------------
// Dispatch

pub async fn run(ctx: &McpCtx, name: &str, args: Value) -> ToolResult {
    if name == "list_bases" {
        return match no_args(args) {
            Ok(()) => list_bases(ctx).await,
            Err(e) => e,
        };
    }
    run_other(ctx, name, args).await
}

async fn run_other(ctx: &McpCtx, name: &str, args: Value) -> ToolResult {
    macro_rules! with_args {
        ($t:ty, $f:expr) => {
            match parse::<$t>(args) {
                Ok(a) => $f(ctx, a).await,
                Err(e) => e,
            }
        };
    }
    match name {
        "get_base_schema" => with_args!(BaseArg, get_base_schema),
        "list_records" => with_args!(ListArgs, list_records),
        "search_records" => with_args!(SearchArgs, search_records),
        "aggregate_records" => with_args!(AggregateArgs, aggregate_records),
        "get_record" => with_args!(GetArgs, get_record),
        "create_records" => with_args!(CreateArgs, create_records),
        "update_records" => with_args!(UpdateArgs, update_records),
        "delete_records" => with_args!(DeleteArgs, delete_records),
        "list_comments" => with_args!(RecordArg, list_comments),
        "add_comment" => with_args!(CommentArgs, add_comment),
        "api_reference" => with_args!(ReferenceArgs, api_reference),
        "api_request" => with_args!(RequestArgs, api_request),
        "create_workspace" => with_args!(WorkspaceArgs, create_workspace),
        "list_members" => with_args!(ScopeArgs, list_members),
        "set_member_role" => with_args!(MemberRoleArgs, set_member_role),
        "create_invite" => with_args!(InviteArgs, create_invite),
        other => ToolResult::error(format!("Unknown tool: {other}")),
    }
}

// ---------------------------------------------------------------------------------------------
// Errors that help the model recover

fn app_error(e: &AppError) -> ToolResult {
    match e {
        AppError::NotFound(what) => ToolResult::error(format!(
            "{what} not found, or you have no access to it. Check the id (list_bases and get_base_schema list valid ones)."
        )),
        other => ToolResult::error(other.to_string()),
    }
}

/// Valid table and field names of a base, for error messages. Never fails: a hint is optional.
async fn hints(ctx: &McpCtx, base_id: &str, table: Option<&str>) -> String {
    let (actor, base_id, table) = (
        ctx.actor.clone(),
        base_id.to_string(),
        table.map(str::to_string),
    );
    let res = ctx
        .state
        .db
        .read(move |c| {
            if perm::require_base(c, &actor, &base_id, Role::Viewer).is_err() {
                return Ok("Use list_bases to see the base ids you can access.".to_string());
            }
            let tables = schema::live_tables(c, &base_id)?;
            let mut text = format!(
                "Tables in this base: {}.",
                names(tables.iter().map(|t| format!("'{}' ({})", t.name, t.id)))
            );
            if let Some(wanted) = table
                && let Some(t) = tables.iter().find(|t| t.id == wanted || t.name == wanted)
            {
                let fields = schema::table_fields(c, &t.id)?;
                text.push_str(&format!(
                    " Fields of '{}': {}.",
                    t.name,
                    names(fields.iter().map(|f| format!("'{}'", f.name)))
                ));
                let views = schema::visible_views(c, &t.id, &actor.user_id)?;
                if !views.is_empty() {
                    text.push_str(&format!(
                        " Views: {}.",
                        names(views.iter().map(|v| format!("'{}'", v.view.name)))
                    ));
                }
            }
            Ok(text)
        })
        .await;
    res.unwrap_or_default()
}

fn names(iter: impl Iterator<Item = String>) -> String {
    let all: Vec<String> = iter.collect();
    let shown = all.iter().take(MAX_HINT_NAMES).cloned().collect::<Vec<_>>();
    let mut out = shown.join(", ");
    if all.len() > shown.len() {
        out.push_str(&format!(", ... ({} more)", all.len() - shown.len()));
    }
    out
}

/// A failed record operation as a tool error, with the names the model needs when the failure
/// was about tables, fields or views.
async fn v1_failure(ctx: &McpCtx, e: V1Error, base_id: &str, table: Option<&str>) -> ToolResult {
    let wants_names = matches!(
        e.kind,
        "NOT_FOUND" | "UNKNOWN_FIELD_NAME" | "VIEW_NAME_NOT_FOUND" | "INVALID_VALUE_FOR_COLUMN"
    ) || e.status == axum::http::StatusCode::UNPROCESSABLE_ENTITY;
    let mut text = if e.kind == "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" {
        "You do not have permission to do this on this base (check your role and the token's permissions), or the base or table does not exist.".to_string()
    } else {
        format!("{} ({})", e.message, e.kind)
    };
    if wants_names {
        let hint = hints(ctx, base_id, table).await;
        if !hint.is_empty() {
            text.push(' ');
            text.push_str(&hint);
        }
    }
    ToolResult::error(text)
}

/// Fail early, with the precise role message, when the caller cannot write to the base.
async fn require_editor(ctx: &McpCtx, base_id: &str) -> Result<(), ToolResult> {
    let (actor, base_id) = (ctx.actor.clone(), base_id.to_string());
    ctx.state
        .db
        .read(move |c| perm::require_base(c, &actor, &base_id, Role::Editor).map(|_| ()))
        .await
        .map_err(|e| app_error(&e))
}

// ---------------------------------------------------------------------------------------------
// Tools

async fn list_bases(ctx: &McpCtx) -> ToolResult {
    let actor = ctx.actor.clone();
    let listed = ctx
        .state
        .db
        .read(move |c| crate::api::workspaces::visible_workspaces(c, &actor))
        .await;
    let workspaces = match listed {
        Ok(w) => w,
        Err(e) => return app_error(&e),
    };
    let access = match &ctx.actor.token_scope {
        None => "full (signed-in session)",
        Some(s) if s.write && s.manage => "read, write and manage",
        Some(s) if s.write => "read and write",
        Some(_) => "read-only",
    };
    ToolResult::ok(json!({
        "access": access,
        "workspaces": workspaces.iter().map(|w| with_icon(json!({
            "id": w.id,
            "name": w.name,
            "role": w.role,
            "bases": w.bases.iter().map(|b| with_icon(json!({"id": b.id, "name": b.name, "role": b.role}), &b.icon)).collect::<Vec<_>>(),
        }), &w.icon)).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseArg {
    base_id: String,
}

async fn get_base_schema(ctx: &McpCtx, a: BaseArg) -> ToolResult {
    let (actor, id) = (ctx.actor.clone(), a.base_id.clone());
    let res = ctx
        .state
        .db
        .read(move |c| {
            let role = perm::require_base(c, &actor, &id, Role::Viewer)?;
            let base = bases::live_base(c, &id)?;
            bases::schema(c, &base, &actor.user_id, role)
        })
        .await;
    let schema = match res {
        Ok(s) => s,
        Err(AppError::NotFound(_)) => {
            return ToolResult::error(format!(
                "Base '{}' not found, or you have no access to it. Use list_bases to see valid base ids.",
                a.base_id
            ));
        }
        Err(e) => return app_error(&e),
    };
    let tables: Vec<Value> = schema
        .tables
        .iter()
        .map(|t| {
            let primary = t
                .fields
                .iter()
                .find(|f| f.id == t.primary_field_id)
                .map(|f| f.name.clone());
            with_icon(
                json!({
                    "id": t.id,
                    "name": t.name,
                    "description": t.description,
                    "primary_field": primary,
                    "fields": t.fields.iter().map(field_json).collect::<Vec<_>>(),
                    "views": t.views.iter().map(|v| json!({
                        "id": v.id,
                        "name": v.name,
                        "type": serde_json::to_value(v.view_type).unwrap_or(Value::Null),
                    })).collect::<Vec<_>>(),
                }),
                &t.icon,
            )
        })
        .collect();
    ToolResult::ok(with_icon(
        json!({
            "id": schema.id,
            "name": schema.name,
            "workspace_id": schema.workspace_id,
            "your_role": schema.role,
            "tables": tables,
        }),
        &schema.icon,
    ))
}

/// `value` (an object) with its `icon` when it has one (icons are left out when unset, like
/// other optional properties in tool results).
fn with_icon(mut value: Value, icon: &Option<String>) -> Value {
    if let (Some(icon), Some(o)) = (icon, value.as_object_mut()) {
        o.insert("icon".into(), json!(icon));
    }
    value
}

pub fn field_json(f: &ob_core::field::Field) -> Value {
    let kind = serde_json::to_value(&f.kind).unwrap_or(Value::Null);
    let mut out = json!({
        "id": f.id,
        "name": f.name,
        "type": kind.get("type").cloned().unwrap_or(Value::Null),
    });
    if let Some(d) = f.description.as_deref().filter(|d| !d.is_empty()) {
        out["description"] = json!(d);
    }
    if let Some(o) = kind
        .get("options")
        .filter(|o| !o.is_null() && o.as_object().is_none_or(|m| !m.is_empty()))
    {
        out["options"] = o.clone();
    }
    out
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SortArg {
    field: String,
    #[serde(default)]
    direction: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    base_id: String,
    table: String,
    #[serde(default)]
    view: Option<String>,
    #[serde(default)]
    filter_by_formula: Option<String>,
    #[serde(default)]
    fields: Option<Vec<String>>,
    #[serde(default)]
    sort: Option<Vec<SortArg>>,
    #[serde(default)]
    max_records: Option<usize>,
    #[serde(default)]
    offset: Option<String>,
}

fn clamp_records(requested: Option<usize>) -> (usize, Option<String>) {
    match requested {
        None => (DEFAULT_RECORDS, None),
        Some(0) => (
            1,
            Some("max_records must be at least 1; returned 1.".into()),
        ),
        Some(n) if n > MAX_RECORDS => (
            MAX_RECORDS,
            Some(format!(
                "max_records is capped at {MAX_RECORDS}; use `offset` to continue."
            )),
        ),
        Some(n) => (n, None),
    }
}

async fn records_result(
    ctx: &McpCtx,
    base_id: &str,
    table: &str,
    query: ListQuery,
    note: Option<String>,
) -> ToolResult {
    let out = records::list_for(
        &ctx.state,
        ctx.actor.clone(),
        base_id.to_string(),
        table.to_string(),
        query,
    )
    .await;
    match out {
        Ok(list) => {
            let mut v = serde_json::to_value(&list).unwrap_or(Value::Null);
            v["count"] = json!(list.records.len());
            if list.offset.is_some() {
                v["more_records"] = json!(true);
                v["hint"] = json!("More records exist: call again with this `offset`.");
            }
            if let Some(n) = note {
                v["note"] = json!(n);
            }
            ToolResult::ok(v)
        }
        Err(e) => v1_failure(ctx, e, base_id, Some(table)).await,
    }
}

async fn list_records(ctx: &McpCtx, a: ListArgs) -> ToolResult {
    let (n, note) = clamp_records(a.max_records);
    let mut sorts = Vec::new();
    for s in a.sort.unwrap_or_default() {
        let dir = match s.direction.as_deref() {
            None | Some("asc") => Direction::Asc,
            Some("desc") => Direction::Desc,
            Some(other) => {
                return ToolResult::error(format!(
                    "sort direction must be \"asc\" or \"desc\" (got {other:?})"
                ));
            }
        };
        sorts.push((s.field, dir));
    }
    let query = ListQuery {
        view: a.view,
        fields: a.fields,
        sorts,
        filter_by_formula: a.filter_by_formula,
        search: None,
        link_names: true,
        page_size: n,
        // `max_records` of the tool is the page size; `offset` continues past it.
        max_records: None,
        offset: a.offset,
    };
    records_result(ctx, &a.base_id, &a.table, query, note).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    base_id: String,
    table: String,
    query: String,
    #[serde(default)]
    max_records: Option<usize>,
}

async fn search_records(ctx: &McpCtx, a: SearchArgs) -> ToolResult {
    if a.query.trim().is_empty() {
        return ToolResult::error("query must not be empty; use list_records to list everything.");
    }
    if a.query.chars().count() > 500 {
        return ToolResult::error("query is too long (at most 500 characters).");
    }
    let (n, note) = clamp_records(a.max_records);
    let query = ListQuery {
        search: Some(a.query),
        link_names: true,
        page_size: n,
        ..Default::default()
    };
    records_result(ctx, &a.base_id, &a.table, query, note).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AggregateArgs {
    base_id: String,
    table: String,
    #[serde(default)]
    view: Option<String>,
    #[serde(default)]
    filter_by_formula: Option<String>,
    #[serde(default)]
    group_by: Option<Vec<String>>,
    #[serde(default)]
    aggregates: Option<Vec<AggregateSpec>>,
    #[serde(default)]
    sort: Option<Vec<AggregateSort>>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn aggregate_records(ctx: &McpCtx, a: AggregateArgs) -> ToolResult {
    let (limit, note) = match a.limit {
        None => (DEFAULT_GROUPS_RETURNED, None),
        Some(0) => (
            1,
            Some("limit must be at least 1; returned 1 group at most.".to_string()),
        ),
        Some(n) if n > MAX_GROUPS_RETURNED => (
            MAX_GROUPS_RETURNED,
            Some(format!(
                "limit is capped at {MAX_GROUPS_RETURNED}; narrow the records or group by fewer fields."
            )),
        ),
        Some(n) => (n, None),
    };
    let req = AggregateRequest {
        view: a.view,
        filter_by_formula: a.filter_by_formula,
        group_by: a.group_by.unwrap_or_default(),
        aggregates: a.aggregates.unwrap_or_default(),
        sort: a.sort.unwrap_or_default(),
        limit: Some(limit),
        timezone: None,
    };
    match aggregate::aggregate_for(
        &ctx.state,
        ctx.actor.clone(),
        a.base_id.clone(),
        a.table.clone(),
        req,
    )
    .await
    {
        Ok(out) => {
            let mut v = serde_json::to_value(&out).unwrap_or(Value::Null);
            if out.truncated {
                v["hint"] = json!(
                    "More groups exist than were returned: raise `limit`, sort by what matters, or narrow with `view` / `filter_by_formula`."
                );
            }
            if let Some(n) = note {
                v["note"] = json!(n);
            }
            ToolResult::ok(v)
        }
        Err(e) => v1_failure(ctx, e, &a.base_id, Some(&a.table)).await,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetArgs {
    base_id: String,
    table: String,
    record_id: String,
}

async fn get_record(ctx: &McpCtx, a: GetArgs) -> ToolResult {
    match records::get_for(
        &ctx.state,
        ctx.actor.clone(),
        a.base_id.clone(),
        a.table.clone(),
        a.record_id.clone(),
    )
    .await
    {
        Ok(r) => ToolResult::ok(serde_json::to_value(r).unwrap_or(Value::Null)),
        Err(e) if e.kind == "NOT_FOUND" && e.message.starts_with("Record") => {
            ToolResult::error(format!(
                "Record '{}' not found in table '{}' (it may be deleted, or belong to another table).",
                a.record_id, a.table
            ))
        }
        Err(e) => v1_failure(ctx, e, &a.base_id, Some(&a.table)).await,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewRecordArg {
    fields: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    base_id: String,
    table: String,
    records: Vec<NewRecordArg>,
    #[serde(default)]
    typecast: Option<bool>,
}

fn check_batch(n: usize, what: &str) -> Result<(), ToolResult> {
    if n == 0 {
        return Err(ToolResult::error(format!(
            "Send at least one record to {what}."
        )));
    }
    if n > MAX_BATCH {
        return Err(ToolResult::error(format!(
            "You can {what} at most {MAX_BATCH} records per call (got {n}); split them into several calls."
        )));
    }
    Ok(())
}

async fn create_records(ctx: &McpCtx, a: CreateArgs) -> ToolResult {
    if let Err(e) = check_batch(a.records.len(), "create") {
        return e;
    }
    if let Err(e) = require_editor(ctx, &a.base_id).await {
        return e;
    }
    let new = a.records.into_iter().map(|r| r.fields).collect();
    let out = records::create_records(
        &ctx.state,
        &HeaderMap::new(),
        ctx.actor.clone(),
        a.base_id.clone(),
        a.table.clone(),
        new,
        a.typecast.unwrap_or(true),
        false,
        true,
    )
    .await;
    match out {
        Ok(created) => ToolResult::ok(json!({ "created": created, "count": created.len() })),
        Err(e) => v1_failure(ctx, e, &a.base_id, Some(&a.table)).await,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRecordArg {
    id: String,
    fields: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    base_id: String,
    table: String,
    records: Vec<UpdateRecordArg>,
    #[serde(default)]
    typecast: Option<bool>,
}

async fn update_records(ctx: &McpCtx, a: UpdateArgs) -> ToolResult {
    if let Err(e) = check_batch(a.records.len(), "update") {
        return e;
    }
    if let Err(e) = require_editor(ctx, &a.base_id).await {
        return e;
    }
    let updates = a.records.into_iter().map(|r| (r.id, r.fields)).collect();
    let out = records::update_records(
        &ctx.state,
        &HeaderMap::new(),
        ctx.actor.clone(),
        a.base_id.clone(),
        a.table.clone(),
        updates,
        a.typecast.unwrap_or(true),
        false,
        true,
    )
    .await;
    match out {
        Ok(updated) => ToolResult::ok(json!({ "updated": updated, "count": updated.len() })),
        Err(e) => v1_failure(ctx, e, &a.base_id, Some(&a.table)).await,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteArgs {
    base_id: String,
    table: String,
    record_ids: Vec<String>,
}

async fn delete_records(ctx: &McpCtx, a: DeleteArgs) -> ToolResult {
    if let Err(e) = check_batch(a.record_ids.len(), "delete") {
        return e;
    }
    if let Err(e) = require_editor(ctx, &a.base_id).await {
        return e;
    }
    let out = records::delete_ids(
        &ctx.state,
        ctx.actor.clone(),
        &HeaderMap::new(),
        a.base_id.clone(),
        a.table.clone(),
        a.record_ids,
    )
    .await;
    match out {
        Ok(deleted) => ToolResult::ok(json!({
            "deleted": deleted.iter().map(|d| &d.id).collect::<Vec<_>>(),
            "count": deleted.len(),
            "note": format!(
                "Moved to the trash, not erased: restorable for {} days (restore_from_trash with kind 'record' and the record id, or the trash in the web app).",
                ctx.state.config.trash_days
            ),
        })),
        Err(e) => v1_failure(ctx, e, &a.base_id, Some(&a.table)).await,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordArg {
    record_id: String,
}

async fn list_comments(ctx: &McpCtx, a: RecordArg) -> ToolResult {
    let path = format!("/api/records/{}/comments", encode_segment(&a.record_id));
    match call_api(ctx, "GET", &path, None, None).await {
        Ok(res) if res.ok() => {
            let comments = res.body.unwrap_or(Value::Null);
            ToolResult::ok(json!({ "comments": comments }))
        }
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommentArgs {
    record_id: String,
    body: String,
}

async fn add_comment(ctx: &McpCtx, a: CommentArgs) -> ToolResult {
    if a.body.trim().is_empty() {
        return ToolResult::error("The comment body must not be empty.");
    }
    let path = format!("/api/records/{}/comments", encode_segment(&a.record_id));
    match call_api(ctx, "POST", &path, None, Some(json!({ "body": a.body }))).await {
        Ok(res) if res.ok() => {
            ToolResult::ok(json!({ "comment": res.body.unwrap_or(Value::Null) }))
        }
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReferenceArgs {
    #[serde(default)]
    area: Option<String>,
}

async fn api_reference(ctx: &McpCtx, a: ReferenceArgs) -> ToolResult {
    match catalogue::reference(a.area.as_deref(), ctx.actor.oauth_grant_id.is_some()) {
        Ok(v) => ToolResult::ok(v),
        Err(e) => ToolResult::error(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestArgs {
    method: String,
    path: String,
    #[serde(default)]
    query: Option<Value>,
    #[serde(default)]
    body: Option<Value>,
}

async fn api_request(ctx: &McpCtx, a: RequestArgs) -> ToolResult {
    let call = ApiCall {
        method: a.method,
        path: a.path,
        query: a.query,
        body: a.body,
    };
    match api::execute(ctx, call).await {
        Ok(res) => {
            let mut out = ToolResult::ok(res.to_json());
            out.is_error = !res.ok();
            out
        }
        Err(e) => ToolResult::error(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceArgs {
    name: String,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

async fn create_workspace(ctx: &McpCtx, a: WorkspaceArgs) -> ToolResult {
    let mut body = serde_json::Map::new();
    body.insert("name".into(), json!(a.name));
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    match call_api(
        ctx,
        "POST",
        "/api/workspaces",
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(res) if res.ok() => ToolResult::ok(with_note(
            json!({ "workspace": res.body.unwrap_or(Value::Null) }),
            note,
        )),
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Workspace,
    Base,
}

impl Scope {
    pub fn collection(self) -> &'static str {
        match self {
            Scope::Workspace => "workspaces",
            Scope::Base => "bases",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeArgs {
    scope: Scope,
    id: String,
}

async fn list_members(ctx: &McpCtx, a: ScopeArgs) -> ToolResult {
    let path = format!(
        "/api/{}/{}/members",
        a.scope.collection(),
        encode_segment(&a.id)
    );
    match call_api(ctx, "GET", &path, None, None).await {
        Ok(res) if res.ok() => {
            ToolResult::ok(json!({ "members": res.body.unwrap_or(Value::Null) }))
        }
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberRoleArgs {
    scope: Scope,
    id: String,
    user_id: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    all_bases: Option<bool>,
    #[serde(default)]
    base_ids: Option<Vec<String>>,
}

async fn set_member_role(ctx: &McpCtx, a: MemberRoleArgs) -> ToolResult {
    if matches!(a.scope, Scope::Base) {
        return ToolResult::error(
            "There are no per-base roles: a member has one role in the workspace. Use scope \
             'workspace' with the workspace id, and all_bases or base_ids to choose which bases \
             they can open.",
        );
    }
    let mut body = Map::new();
    if let Some(role) = a.role {
        body.insert("role".into(), json!(role));
    }
    if let Some(all) = a.all_bases {
        body.insert("all_bases".into(), json!(all));
    }
    if let Some(ids) = a.base_ids {
        body.insert("base_ids".into(), json!(ids));
    }
    if body.is_empty() {
        return ToolResult::error("Give a new role, all_bases or base_ids.");
    }
    let path = format!(
        "/api/workspaces/{}/members/{}",
        encode_segment(&a.id),
        encode_segment(&a.user_id)
    );
    match call_api(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(res) if res.ok() => ToolResult::ok(json!({ "ok": true })),
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InviteArgs {
    scope: Scope,
    id: String,
    role: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    all_bases: Option<bool>,
    #[serde(default)]
    base_ids: Option<Vec<String>>,
}

async fn create_invite(ctx: &McpCtx, a: InviteArgs) -> ToolResult {
    let path = format!(
        "/api/{}/{}/invites",
        a.scope.collection(),
        encode_segment(&a.id)
    );
    let mut body = json!({ "role": a.role });
    if let Some(email) = a.email.filter(|e| !e.trim().is_empty()) {
        body["email"] = json!(email);
    }
    if let Some(all) = a.all_bases {
        body["all_bases"] = json!(all);
    }
    if let Some(ids) = a.base_ids {
        body["base_ids"] = json!(ids);
    }
    match call_api(ctx, "POST", &path, None, Some(body)).await {
        Ok(res) if res.ok() => ToolResult::ok(res.body.unwrap_or(Value::Null)),
        Ok(res) => api_failure(ctx, &res),
        Err(e) => e,
    }
}
