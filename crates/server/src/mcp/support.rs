//! Helpers shared by the tool modules: JSON Schema builders, argument parsing, and running a
//! request of the internal REST API as the caller (the way most curated tools are implemented,
//! so their permission checks, validation, events and side effects are the web UI's own).

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::api::{self, ApiCall, ApiResponse};
use super::tools::{Level, ToolDef, ToolResult};

pub const BASE_ID: &str =
    "Project id (from list_projects; called base in the REST API), e.g. appXXXXXXXXXXXXXX.";
pub const TABLE: &str = "Table name or table id (from get_project_schema).";

pub fn string(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

pub fn boolean(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}

pub fn integer(description: &str, min: u64, max: u64) -> Value {
    json!({ "type": "integer", "minimum": min, "maximum": max, "description": description })
}

pub fn string_list(description: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": description })
}

/// A free-form JSON object argument.
pub fn free_object(description: &str) -> Value {
    json!({ "type": "object", "description": description })
}

/// Put `value` into a request body under `key` when it was given.
pub fn insert_some(body: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value {
        body.insert(key.into(), json!(v));
    }
}

/// An `icon` argument: a Lucide name, or null to remove the icon.
pub fn icon_schema(what: &str) -> Value {
    json!({
        "type": ["string", "null"],
        "description": format!(
            "Optional Lucide icon name in kebab-case for the {what}, e.g. 'briefcase', 'users', 'shopping-cart' \
             (call list_icons to search the names). null removes the icon; leave it out to keep it."
        ),
    })
}

/// Put an `icon` argument into a request body: a name (checked against the Lucide list and
/// stored under its canonical spelling), `null` to clear, nothing when it was not given.
/// Returns a note to show the caller when the stored name differs from what was written.
pub fn put_icon(
    body: &mut Map<String, Value>,
    icon: Option<Option<String>>,
) -> Result<Option<String>, ToolResult> {
    match icon {
        None => Ok(None),
        Some(None) => {
            body.insert("icon".into(), Value::Null);
            Ok(None)
        }
        Some(Some(name)) => {
            let resolved = crate::icons::icons()
                .check(&name)
                .map_err(ToolResult::error)?;
            body.insert("icon".into(), json!(resolved.name));
            Ok(resolved.changed.then(|| {
                format!(
                    "Icon '{name}' was stored as '{}', its canonical name.",
                    resolved.name
                )
            }))
        }
    }
}

/// `value` (an object) with a `note` added when there is one.
pub fn with_note(mut value: Value, note: Option<String>) -> Value {
    if let (Some(note), Some(o)) = (note, value.as_object_mut()) {
        o.insert("note".into(), json!(note));
    }
    value
}

pub fn enumeration(values: &[&str], description: &str) -> Value {
    json!({ "type": "string", "enum": values, "description": description })
}

pub fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

pub fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ToolResult> {
    serde_json::from_value(args).map_err(|e| {
        ToolResult::error(format!(
            "Invalid arguments: {e}. Check the tool's input schema from tools/list."
        ))
    })
}

pub fn no_args(args: Value) -> Result<(), ToolResult> {
    match args.as_object() {
        Some(o) if o.is_empty() => Ok(()),
        _ => Err(ToolResult::error(
            "This tool takes no arguments; send an empty object.",
        )),
    }
}

/// Percent-encode a value placed in one path segment (ids are plain, but arguments are not
/// trusted).
pub fn encode_segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// Run a catalogued request as the caller; the response is returned whatever its status.
pub async fn call_api(
    ctx: &McpCtx,
    method: &str,
    path: &str,
    query: Option<Value>,
    body: Option<Value>,
) -> Result<ApiResponse, ToolResult> {
    api::execute(
        ctx,
        ApiCall {
            method: method.into(),
            path: path.into(),
            query,
            body,
        },
    )
    .await
    .map_err(ToolResult::error)
}

/// What a token's limits mean for a refused request, appended to 403s so the model can tell a
/// missing role from a missing token capability.
fn token_context(ctx: &McpCtx) -> &'static str {
    match &ctx.actor.token_scope {
        None => "",
        Some(s) if !s.write => {
            " (this API token is read-only: it acts with at most the viewer role; create a token with write access for changes)"
        }
        Some(s) if !s.manage => {
            " (this API token has no 'manage' permission, which workspace, member, invite and admin actions need)"
        }
        Some(s) if s.base_ids.is_some() => " (this API token is limited to specific projects)",
        Some(_) => "",
    }
}

/// A failed response as a tool error the model can act on.
pub fn api_failure(ctx: &McpCtx, res: &ApiResponse) -> ToolResult {
    let msg = res
        .error_message()
        .or_else(|| res.text.clone())
        .unwrap_or_else(|| format!("the request failed with status {}", res.status));
    ToolResult::error(match res.status {
        401 => format!("{msg} (the token is no longer valid)"),
        403 => {
            // The server's message already says "requires the X role" or "needs a token with
            // the 'manage' permission"; add what this token's own limits imply.
            let mut m = msg;
            let ctx_note = token_context(ctx);
            if !ctx_note.is_empty() && !m.contains("API token") {
                m.push_str(ctx_note);
            }
            m
        }
        404 => format!("{msg} (not found, or you have no access to it)"),
        _ => msg,
    })
}

/// Run a request and return its JSON body (`{"ok": true}` when empty); a failure is a tool error.
pub async fn fetch(
    ctx: &McpCtx,
    method: &str,
    path: &str,
    query: Option<Value>,
    body: Option<Value>,
) -> Result<Value, ToolResult> {
    let res = call_api(ctx, method, path, query, body).await?;
    if res.ok() {
        Ok(res.body.unwrap_or_else(|| json!({ "ok": true })))
    } else {
        Err(api_failure(ctx, &res))
    }
}

/// `fetch`, with the body put under `key` (tool results are objects).
pub async fn fetch_as(
    ctx: &McpCtx,
    method: &str,
    path: &str,
    query: Option<Value>,
    body: Option<Value>,
    key: &str,
) -> ToolResult {
    match fetch(ctx, method, path, query, body).await {
        Ok(v) => ToolResult::ok(json!({ key: v })),
        Err(e) => e,
    }
}

/// `fetch`, with the JSON body returned as is when it is an object.
pub async fn fetch_plain(
    ctx: &McpCtx,
    method: &str,
    path: &str,
    query: Option<Value>,
    body: Option<Value>,
) -> ToolResult {
    match fetch(ctx, method, path, query, body).await {
        Ok(v) if v.is_object() => ToolResult::ok(v),
        Ok(v) => ToolResult::ok(json!({ "result": v })),
        Err(e) => e,
    }
}

pub fn base_path(base_id: &str, rest: &str) -> String {
    format!("/api/bases/{}{rest}", encode_segment(base_id))
}

pub fn table_path(table_id: &str, rest: &str) -> String {
    format!("/api/tables/{}{rest}", encode_segment(table_id))
}

/// Positional constructor used by the first tool group; new code uses the [`ToolDef`] builder.
#[allow(clippy::too_many_arguments)]
pub fn tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: Value,
    level: Level,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
) -> ToolDef {
    ToolDef {
        name,
        title,
        description,
        schema,
        level,
        read_only,
        destructive,
        idempotent,
    }
}

/// What a workspace or project looked like just before it went to the trash, for the delete
/// result (AGT-4).
pub struct TrashedBefore {
    pub name: String,
    /// The projects of a workspace (`id`, `name`, `tables`); empty for a project.
    pub projects: Vec<Value>,
    /// The number of live tables of a project.
    pub tables: i64,
}

/// Read a workspace (`kind` "workspace") or project (`kind` "project") before it is deleted.
/// A failed read is not an error: the delete decides whether the caller may do it, and its result
/// only loses detail.
pub async fn read_before_trash(ctx: &McpCtx, kind: &'static str, id: &str) -> TrashedBefore {
    let id = id.to_string();
    ctx.state
        .db
        .read(move |c| {
            if kind == "workspace" {
                let name =
                    c.query_row("SELECT name FROM workspaces WHERE id = ?1", [&id], |r| {
                        r.get(0)
                    })?;
                let mut stmt = c.prepare(
                    "SELECT b.id, b.name, (SELECT COUNT(*) FROM tables t
                                           WHERE t.base_id = b.id AND t.deleted_at IS NULL)
                     FROM bases b WHERE b.workspace_id = ?1 AND b.deleted_at IS NULL
                     ORDER BY b.position, b.created_at, b.id",
                )?;
                let projects = stmt
                    .query_map([&id], |r| {
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "name": r.get::<_, String>(1)?,
                            "tables": r.get::<_, i64>(2)?,
                        }))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(TrashedBefore {
                    name,
                    projects,
                    tables: 0,
                })
            } else {
                let (name, tables) = c.query_row(
                    "SELECT b.name, (SELECT COUNT(*) FROM tables t
                                     WHERE t.base_id = b.id AND t.deleted_at IS NULL)
                     FROM bases b WHERE b.id = ?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                Ok(TrashedBefore {
                    name,
                    projects: Vec::new(),
                    tables,
                })
            }
        })
        .await
        .unwrap_or(TrashedBefore {
            name: String::new(),
            projects: Vec::new(),
            tables: 0,
        })
}

/// The result of deleting a workspace or project: what moved to the trash, how to bring it back
/// and when the retention purge will erase it for good (AGT-4). `deleted` is kept as it always
/// was; everything else is additive.
pub async fn trash_receipt(
    ctx: &McpCtx,
    kind: &'static str,
    id: &str,
    before: TrashedBefore,
) -> Value {
    let (table, noun) = if kind == "workspace" {
        ("workspaces", "workspace")
    } else {
        ("bases", "project")
    };
    let row = id.to_string();
    let deleted_at: i64 = ctx
        .state
        .db
        .read(move |c| {
            Ok(c.query_row(
                &format!("SELECT deleted_at FROM {table} WHERE id = ?1"),
                [&row],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap_or_else(|_| crate::db::now_ms());
    let days = ctx.state.config.trash_days;
    let purge_ms = deleted_at.saturating_add(crate::store::trash::retention_ms(days));
    let purge_after = chrono::DateTime::from_timestamp_millis(purge_ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default();
    let name = &before.name;
    let moved = if kind == "workspace" {
        let projects = before.projects.len();
        let tables: i64 = before
            .projects
            .iter()
            .filter_map(|p| p["tables"].as_i64())
            .sum();
        format!(
            "the workspace '{name}' with its {projects} project{} and {tables} table{} (records \
             included)",
            if projects == 1 { "" } else { "s" },
            if tables == 1 { "" } else { "s" },
        )
    } else {
        let tables = before.tables;
        format!(
            "the project '{name}' with its {tables} table{} (records included)",
            if tables == 1 { "" } else { "s" },
        )
    };
    let mut trashed = json!({ "kind": kind, "id": id, "name": name });
    if kind == "workspace" {
        trashed["projects"] = json!(before.projects);
    } else {
        trashed["tables"] = json!(before.tables);
    }
    json!({
        "deleted": id,
        "trashed": trashed,
        "restore_with": {
            "tool": "restore_from_trash",
            "arguments": { "kind": kind, "id": id },
        },
        "purge_after": purge_after,
        "retention_days": days,
        "note": format!(
            "Moved to the trash, not erased: {moved}. Bring the {noun} back with restore_from_trash \
             {{kind: '{kind}', id: '{id}'}} until {purge_after}; the daily trash purge erases it \
             for good on or after that date ({days} days after the delete).",
        ),
    })
}
