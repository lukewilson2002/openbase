//! The inbox tools: the caller's private quick-capture drafts (see [`crate::api::inbox`]).
//! They call the REST endpoints as the caller, so ownership checks, limits and the record
//! write path (when a draft is filed) are the web app's own. A token limited to specific
//! projects is refused by those endpoints (the inbox is in no project), so these tools fail for it.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{find_table, load_schema};
use super::support::*;
use super::tools::{ToolDef, ToolResult};

pub fn definitions() -> Vec<ToolDef> {
    let files = json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": { "id": string("Attachment id from upload_attachment (called without project_id).") },
            "required": ["id"],
        },
        "description": "Files of the draft as [{\"id\": \"att...\"}]; upload each with upload_attachment first, leaving project_id out (at most 20 per draft; a file can be in one draft only). On update it replaces the whole list.",
    });
    vec![
        ToolDef::new(
            "list_inbox",
            "List inbox drafts",
            "List your inbox: private quick-capture drafts (Markdown text plus files) that are not in any project yet, most recently changed first. Only you ever see them. File one into a table with file_inbox_item.",
            object(json!({}), &[]),
        ),
        ToolDef::new(
            "add_to_inbox",
            "Add a draft to the inbox",
            "Save a note in your inbox for later (Markdown text, optionally files). Use it to capture something when you do not know yet which table it belongs in; file_inbox_item turns it into a record later.",
            object(
                json!({
                    "body": string("The note, in Markdown (up to 100,000 characters; may be empty when files are attached)."),
                    "attachments": files.clone(),
                }),
                &[],
            ),
        )
        .write(),
        ToolDef::new(
            "update_inbox_item",
            "Edit an inbox draft",
            "Change an inbox draft's text and/or its list of files (what you leave out stays).",
            object(
                json!({
                    "id": string("Inbox draft id (inb...), from list_inbox."),
                    "body": string("New Markdown text."),
                    "attachments": files,
                }),
                &["id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "file_inbox_item",
            "File an inbox draft into a table",
            "Turn an inbox draft into a record of a table and remove the draft, in one step. You choose the values: `fields` is {\"Field name\": value} like create_records (the draft's text is NOT copied automatically: put it in a long-text field yourself). To keep the draft's files, list them ([{\"id\": \"att...\"}]) in an attachment field. Needs the editor role on the project; nothing changes if the record cannot be created.",
            object(
                json!({
                    "id": string("Inbox draft id (inb...), from list_inbox."),
                    "project_id": string(BASE_ID),
                    "table": string(TABLE),
                    "fields": free_object("Field name -> value for the new record, same shapes as create_records."),
                }),
                &["id", "project_id", "table"],
            ),
        )
        .write(),
        ToolDef::new(
            "delete_inbox_item",
            "Delete an inbox draft",
            "Delete an inbox draft permanently (drafts have no trash).",
            object(
                json!({ "id": string("Inbox draft id (inb...), from list_inbox.") }),
                &["id"],
            ),
        )
        .write()
        .destructive(),
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
        "list_inbox" => Some(match no_args(args.clone()) {
            Ok(()) => fetch_as(ctx, "GET", "/api/inbox", None, None, "items").await,
            Err(e) => e,
        }),
        "add_to_inbox" => with_args!(AddArgs, add_to_inbox),
        "update_inbox_item" => with_args!(UpdateArgs, update_inbox_item),
        "file_inbox_item" => with_args!(FileArgs, file_inbox_item),
        "delete_inbox_item" => with_args!(IdArg, delete_inbox_item),
        _ => None,
    }
}

/// The REST draft endpoints take full attachment references; the server rebuilds them from its
/// own record of the upload, so an agent only needs to give the `id`.
fn file_refs(files: Vec<Value>) -> Vec<Value> {
    files
        .into_iter()
        .map(|f| {
            let mut f = f;
            if let Some(o) = f.as_object_mut() {
                o.entry("filename").or_insert(json!("file"));
                o.entry("mime").or_insert(json!("application/octet-stream"));
                o.entry("size").or_insert(json!(0));
            }
            f
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddArgs {
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<Value>>,
}

async fn add_to_inbox(ctx: &McpCtx, a: AddArgs) -> ToolResult {
    let mut body = Map::new();
    body.insert("body".into(), json!(a.body.unwrap_or_default()));
    if let Some(files) = a.attachments {
        body.insert("attachments".into(), json!(file_refs(files)));
    }
    match fetch(ctx, "POST", "/api/inbox", None, Some(Value::Object(body))).await {
        Ok(item) => ToolResult::ok(json!({ "item": item })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    id: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<Value>>,
}

async fn update_inbox_item(ctx: &McpCtx, a: UpdateArgs) -> ToolResult {
    let mut body = Map::new();
    insert_some(&mut body, "body", a.body);
    if let Some(files) = a.attachments {
        body.insert("attachments".into(), json!(file_refs(files)));
    }
    if body.is_empty() {
        return ToolResult::error("Give a new body and/or attachments.");
    }
    let path = format!("/api/inbox/{}", encode_segment(&a.id));
    match fetch(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(item) => ToolResult::ok(json!({ "item": item })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileArgs {
    id: String,
    #[serde(alias = "base_id")]
    project_id: String,
    table: String,
    #[serde(default)]
    fields: Map<String, Value>,
}

async fn file_inbox_item(ctx: &McpCtx, a: FileArgs) -> ToolResult {
    let schema = match load_schema(ctx, &a.project_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let table = match find_table(&schema, &a.table) {
        Ok(t) => t.id.clone(),
        Err(e) => return e,
    };
    let path = format!("/api/inbox/{}/file", encode_segment(&a.id));
    let body = json!({ "table_id": table, "fields": a.fields });
    match fetch(ctx, "POST", &path, None, Some(body)).await {
        Ok(record) => ToolResult::ok(json!({
            "filed": true,
            "record": record,
            "note": "The draft was removed from your inbox. The record is keyed by field id; get_record shows it with field names.",
        })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArg {
    id: String,
}

async fn delete_inbox_item(ctx: &McpCtx, a: IdArg) -> ToolResult {
    let path = format!("/api/inbox/{}", encode_segment(&a.id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({ "deleted": a.id })),
        Err(e) => e,
    }
}
