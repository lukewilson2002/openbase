//! Helpers shared by the tool modules: JSON Schema builders, argument parsing, and running a
//! request of the internal REST API as the caller (the way most curated tools are implemented,
//! so their permission checks, validation, events and side effects are the web UI's own).

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::api::{self, ApiCall, ApiResponse};
use super::tools::{Level, ToolDef, ToolResult};

pub const BASE_ID: &str = "Base id (from list_bases), e.g. appXXXXXXXXXXXXXX.";
pub const TABLE: &str = "Table name or table id (from get_base_schema).";

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
        Some(s) if s.base_ids.is_some() => " (this API token is limited to specific bases)",
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
