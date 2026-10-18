//! Trash, record history and notifications.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{people_of, value_for_model};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use crate::perm;
use crate::store::{records, schema};

const HISTORY_DEFAULT: usize = 20;
const HISTORY_MAX: usize = 100;
const NOTIFICATIONS_DEFAULT: usize = 30;
const NOTIFICATIONS_MAX: usize = 100;
/// What `restore_from_trash` accepts. `base` is the old name of `project`: still accepted, not listed.
const TRASH_KINDS: &[&str] = &["record", "field", "table", "view", "project", "workspace"];

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "list_trash",
            "List the trash",
            "List what was deleted and can still be restored: records, fields, tables and views of a project (creator role), or the projects of a workspace (workspace_id; owner role and the manage permission). With neither id, lists your deleted workspaces (manage permission). Items are kept for the trash retention period.",
            object(
                json!({
                    "project_id": string("Project whose trash to list."),
                    "workspace_id": string("Workspace whose deleted projects to list."),
                }),
                &[],
            ),
        ),
        ToolDef::new(
            "restore_from_trash",
            "Restore from the trash",
            "Restore a deleted record, field, table, view, project or workspace by id (ids come from list_trash, or from the result of the delete). Restoring a field brings back the fields trashed with it. Projects and workspaces need the manage permission and the owner role.",
            object(
                json!({
                    "kind": enumeration(TRASH_KINDS, "What to restore."),
                    "id": string("Id of the deleted item (from list_trash)."),
                }),
                &["kind", "id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "get_record_history",
            "Get a record's history",
            "The change history of a record, newest first: who changed which fields from what to what, with field NAMES. Includes creates, updates, deletes and restores, and the edits made through MCP, the web app, forms and automations. Page with `before`.",
            object(
                json!({
                    "record_id": string("Record id."),
                    "limit": integer("Entries to return (default 20, max 100).", 1, HISTORY_MAX as u64),
                    "before": integer("The `next_before` of a previous result, to get older entries.", 1, i64::MAX as u64),
                }),
                &["record_id"],
            ),
        ),
        ToolDef::new(
            "list_notifications",
            "List notifications",
            "List your in-app notifications (mentions, assignments, invites, automation messages), newest first, with the number unread.",
            object(
                json!({
                    "unread_only": boolean("Only unread notifications (default false)."),
                    "limit": integer("How many to return (default 30, max 100).", 1, NOTIFICATIONS_MAX as u64),
                }),
                &[],
            ),
        ),
        ToolDef::new(
            "mark_notifications_read",
            "Mark notifications read",
            "Mark notifications as read: the given ids, or all of them when no ids are given.",
            object(
                json!({ "ids": string_list("Notification ids; omit to mark all read.") }),
                &[],
            ),
        )
        .write()
        .idempotent(),
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
        "list_trash" => with_args!(TrashArgs, list_trash),
        "restore_from_trash" => with_args!(RestoreArgs, restore_from_trash),
        "get_record_history" => with_args!(HistoryArgs, get_record_history),
        "list_notifications" => with_args!(NotificationArgs, list_notifications),
        "mark_notifications_read" => with_args!(MarkReadArgs, mark_notifications_read),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrashArgs {
    #[serde(default)]
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
}

async fn list_trash(ctx: &McpCtx, a: TrashArgs) -> ToolResult {
    let path = match (&a.base_id, &a.workspace_id) {
        (Some(_), Some(_)) => {
            return ToolResult::error("Give either project_id or workspace_id, not both.");
        }
        (Some(b), None) => base_path(b, "/trash"),
        (None, Some(w)) => format!("/api/workspaces/{}/trash", encode_segment(w)),
        (None, None) => "/api/trash/workspaces".to_string(),
    };
    match fetch(ctx, "GET", &path, None, None).await {
        Ok(v) => {
            let items = v.get("items").cloned().unwrap_or(json!([]));
            ToolResult::ok(json!({
                "items": items,
                "retention_days": ctx.state.config.trash_days,
                "hint": "Restore with restore_from_trash {kind, id}.",
            }))
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreArgs {
    kind: String,
    id: String,
}

async fn restore_from_trash(ctx: &McpCtx, mut a: RestoreArgs) -> ToolResult {
    let given = a.kind.clone();
    if a.kind == "project" {
        a.kind = "base".into();
    }
    if a.kind != "base" && !TRASH_KINDS.contains(&a.kind.as_str()) {
        return ToolResult::error(format!(
            "Unknown kind '{}'. Kinds: {}.",
            given,
            TRASH_KINDS.join(", ")
        ));
    }
    match fetch(
        ctx,
        "POST",
        "/api/trash/restore",
        None,
        Some(json!({ "kind": a.kind, "id": a.id })),
    )
    .await
    {
        Ok(v) => {
            let mut out = json!({ "restored": { "kind": given, "id": a.id } });
            if let Some(ids) = v
                .get("restored_field_ids")
                .filter(|i| i.as_array().is_some_and(|a| !a.is_empty()))
            {
                out["restored_field_ids"] = ids.clone();
            }
            ToolResult::ok(out)
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryArgs {
    record_id: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<i64>,
}

async fn get_record_history(ctx: &McpCtx, a: HistoryArgs) -> ToolResult {
    let limit = a.limit.unwrap_or(HISTORY_DEFAULT).clamp(1, HISTORY_MAX);
    let mut query = json!({ "limit": limit });
    if let Some(b) = a.before {
        query["before"] = json!(b);
    }
    let path = format!("/api/records/{}/history", encode_segment(&a.record_id));
    let entries = match fetch(ctx, "GET", &path, Some(query), None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    // The history is keyed by field id and holds stored values (select choice ids, user ids);
    // the caller may read the record, so show field names and readable values. A field deleted
    // since keeps its id.
    let rid = a.record_id.clone();
    let (fields, people) = ctx
        .state
        .db
        .read(move |c| {
            let Some(rec) = records::get(c, &rid)? else {
                return Ok((Vec::new(), Default::default()));
            };
            let base_id = perm::base_of_table(c, &rec.table_id)?;
            Ok((
                schema::table_fields(c, &rec.table_id)?,
                people_of(c, &base_id),
            ))
        })
        .await
        .unwrap_or_default();
    let field_of = |id: &str| fields.iter().find(|f| f.id == id);
    let name_of = |id: &str| -> String {
        field_of(id)
            .map(|f| f.name.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let readable = |id: &str, v: &Value| -> Value {
        field_of(id)
            .map(|f| value_for_model(f, v, &people))
            .unwrap_or_else(|| v.clone())
    };
    let list = entries.as_array().cloned().unwrap_or_default();
    let count = list.len();
    let last_id = list.last().and_then(|e| e["id"].as_i64());
    let entries: Vec<Value> = list
        .into_iter()
        .map(|e| {
            let mut changes = Map::new();
            if let Some(c) = e["changes"].as_object() {
                for (fid, change) in c {
                    changes.insert(
                        name_of(fid),
                        json!({
                            "old": readable(fid, &change["old"]),
                            "new": readable(fid, &change["new"]),
                        }),
                    );
                }
            }
            json!({
                "id": e["id"],
                "kind": e["kind"],
                "user": e["user_name"],
                "at": e["created_at"],
                "changes": changes,
            })
        })
        .collect();
    let mut out = json!({ "record_id": a.record_id, "entries": entries, "count": count });
    if count == limit
        && let Some(id) = last_id
    {
        out["next_before"] = json!(id);
        out["hint"] = json!("Older entries exist: call again with before = next_before.");
    }
    ToolResult::ok(out)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NotificationArgs {
    #[serde(default)]
    unread_only: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn list_notifications(ctx: &McpCtx, a: NotificationArgs) -> ToolResult {
    let res = match fetch(ctx, "GET", "/api/notifications", None, None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let limit = a
        .limit
        .unwrap_or(NOTIFICATIONS_DEFAULT)
        .clamp(1, NOTIFICATIONS_MAX);
    let all = res["notifications"].as_array().cloned().unwrap_or_default();
    let unread_only = a.unread_only.unwrap_or(false);
    let shown: Vec<Value> = all
        .into_iter()
        .filter(|n| !unread_only || n["read_at"].is_null())
        .take(limit)
        .collect();
    ToolResult::ok(json!({
        "unread": res["unread"],
        "count": shown.len(),
        "notifications": shown,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkReadArgs {
    #[serde(default)]
    ids: Option<Vec<String>>,
}

async fn mark_notifications_read(ctx: &McpCtx, a: MarkReadArgs) -> ToolResult {
    let ids = a.ids.unwrap_or_default();
    let all = ids.is_empty();
    match fetch(
        ctx,
        "POST",
        "/api/notifications/read",
        None,
        Some(json!({ "ids": ids })),
    )
    .await
    {
        Ok(_) => ToolResult::ok(json!({
            "ok": true,
            "marked": if all { json!("all") } else { json!(ids.len()) },
        })),
        Err(e) => e,
    }
}
