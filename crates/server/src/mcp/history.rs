//! Trash, record history, the activity feed and notifications.

use std::collections::BTreeSet;

use ob_core::api::history::{ActivityItem, ActivityPage, ActivityPlace};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{People, list_names, people_of, pick, value_for_model};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use crate::perm;
use crate::store::{activity, records, schema};

const HISTORY_DEFAULT: usize = 20;
const HISTORY_MAX: usize = 100;
const ACTIVITY_DEFAULT: usize = 30;
const ACTIVITY_MAX: usize = 100;
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
            "list_activity",
            "List recent activity",
            "What changed lately across ALL your projects (or one workspace, project or table), newest first: who created, changed, deleted or restored which record and which fields changed from what to what, and the comments people wrote. Use it to keep up with developments; filter by workspace, project, table, person or kind. For one record's history use get_record_history. Page with `before`.",
            object(
                json!({
                    "workspace": string("Only this workspace (name or id)."),
                    "project": string("Only this project (name or id)."),
                    "table": string("Only this table (name or id; add `project` when several projects have a table of that name)."),
                    "person": string("Only what this person did (name, email or user id of someone in your workspaces)."),
                    "kind": enumeration(activity::KINDS, "Only this kind of activity: create (new records), update (changes), delete, restore or comment."),
                    "order": enumeration(&["newest", "oldest"], "Default newest."),
                    "limit": integer("Items to return (default 30, max 100).", 1, ACTIVITY_MAX as u64),
                    "before": string("The `next_before` of a previous result, to get the next page."),
                }),
                &[],
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
        "list_activity" => with_args!(ActivityArgs, list_activity),
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
struct ActivityArgs {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default, rename = "project", alias = "base")]
    base: Option<String>,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    person: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    order: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<String>,
}

/// The id of the single item of `items` that `key` names (an id or a name), or a tool error
/// listing the valid names.
fn resolve_one<T>(
    what: &str,
    key: &str,
    items: &[T],
    id: impl Fn(&T) -> &str,
    name: impl Fn(&T) -> &str,
) -> Result<String, ToolResult> {
    pick(items, key, &id, &name)
        .map(|x| id(x).to_string())
        .map_err(|why| {
            let names = list_names(items.iter().map(|x| format!("'{}' ({})", name(x), id(x))));
            ToolResult::error(match why {
                Some(_) => {
                    format!("Several {what}s are named '{key}'; use the id. {what}s: {names}.")
                }
                None => format!("{what} '{key}' not found. {what}s: {names}."),
            })
        })
}

fn distinct<'a>(
    places: &'a [ActivityPlace],
    id: impl Fn(&'a ActivityPlace) -> &'a str,
) -> Vec<&'a ActivityPlace> {
    let mut seen = BTreeSet::new();
    places.iter().filter(|p| seen.insert(id(p))).collect()
}

async fn list_activity(ctx: &McpCtx, a: ActivityArgs) -> ToolResult {
    let (actor, want_person) = (ctx.actor.clone(), a.person.is_some());
    let loaded = ctx
        .state
        .db
        .read(move |c| {
            let places = activity::accessible_places(c, &actor, None, None, None)?;
            let people: Vec<(String, String, String)> = if want_person {
                let mut stmt = c.prepare(
                    "SELECT DISTINCT u.id, u.name, u.email FROM users u
                     JOIN workspace_members m ON m.user_id = u.id
                     WHERE m.workspace_id IN
                       (SELECT workspace_id FROM workspace_members WHERE user_id = ?1)
                     ORDER BY u.name, u.id",
                )?;
                stmt.query_map([&actor.user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?
            } else {
                Vec::new()
            };
            Ok((places, people))
        })
        .await;
    let (mut places, people) = match loaded {
        Ok(x) => x,
        Err(e) => return ToolResult::error(e.to_string()),
    };

    // Names to ids, each narrowing what the next one can mean.
    let mut query = Map::new();
    if let Some(key) = &a.workspace {
        let list = distinct(&places, |p| &p.workspace_id);
        let id = match resolve_one(
            "Workspace",
            key,
            &list,
            |p| &p.workspace_id,
            |p| &p.workspace_name,
        ) {
            Ok(id) => id,
            Err(e) => return e,
        };
        places.retain(|p| p.workspace_id == id);
        query.insert("workspace".into(), json!(id));
    }
    if let Some(key) = &a.base {
        let list = distinct(&places, |p| &p.base_id);
        let id = match resolve_one("Project", key, &list, |p| &p.base_id, |p| &p.base_name) {
            Ok(id) => id,
            Err(e) => return e,
        };
        places.retain(|p| p.base_id == id);
        query.insert("base".into(), json!(id));
    }
    if let Some(key) = &a.table {
        let id = match resolve_one("Table", key, &places, |p| &p.table_id, |p| &p.table_name) {
            Ok(id) => id,
            Err(e) => return e,
        };
        query.insert("table".into(), json!(id));
    }
    if let Some(key) = &a.person {
        let key = key.trim();
        let found = people
            .iter()
            .find(|(id, _, email)| id == key || email.eq_ignore_ascii_case(key));
        let id = match found {
            Some((id, _, _)) => id.clone(),
            None => match resolve_one("Person", key, &people, |p| &p.0, |p| &p.1) {
                Ok(id) => id,
                Err(e) => return e,
            },
        };
        query.insert("user".into(), json!(id));
    }
    if let Some(kind) = a.kind {
        query.insert("kind".into(), json!(kind));
    }
    if let Some(order) = a.order {
        query.insert("order".into(), json!(order));
    }
    if let Some(before) = a.before {
        query.insert("before".into(), json!(before));
    }
    let limit = a.limit.unwrap_or(ACTIVITY_DEFAULT).clamp(1, ACTIVITY_MAX);
    query.insert("limit".into(), json!(limit));

    let page = match fetch(ctx, "GET", "/api/history", Some(Value::Object(query)), None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let page: ActivityPage = match serde_json::from_value(page) {
        Ok(p) => p,
        Err(e) => return ToolResult::error(format!("Unexpected response: {e}")),
    };

    // Readable values: select choices and people by name, like get_record_history.
    let bases: BTreeSet<String> = page.items.iter().map(|i| i.place.base_id.clone()).collect();
    let people: People = ctx
        .state
        .db
        .read(move |c| {
            let mut all = People::new();
            for b in &bases {
                all.extend(people_of(c, b));
            }
            Ok(all)
        })
        .await
        .unwrap_or_default();
    let items: Vec<Value> = page
        .items
        .iter()
        .map(|i| activity_item(i, &page.fields, &people))
        .collect();
    let mut out = json!({ "count": items.len(), "items": items });
    if let Some(next) = page.next {
        out["next_before"] = json!(next);
        out["hint"] = json!("More activity exists: call again with before = next_before.");
    }
    ToolResult::ok(out)
}

fn activity_item(
    i: &ActivityItem,
    fields: &std::collections::BTreeMap<String, ob_core::field::Field>,
    people: &People,
) -> Value {
    let mut out = json!({
        "at": i.created_at,
        "kind": i.kind,
        "user": i.author.as_ref().map(|a| a.name.clone()),
        "workspace": i.place.workspace_name,
        "project": i.place.base_name,
        "project_id": i.place.base_id,
        "table": i.place.table_name,
        "table_id": i.place.table_id,
        "record": { "id": i.record.id, "name": i.record.name, "deleted": i.record.deleted },
    });
    if !i.changes.is_empty() {
        let mut changes = Map::new();
        for (fid, change) in &i.changes {
            let readable = |v: &Value| match fields.get(fid) {
                Some(f) => value_for_model(f, v, people),
                None => v.clone(),
            };
            let name = fields.get(fid).map_or(fid.as_str(), |f| f.name.as_str());
            changes.insert(
                name.to_string(),
                json!({ "old": readable(&change.old), "new": readable(&change.new) }),
            );
        }
        out["changes"] = Value::Object(changes);
    }
    if let Some(text) = &i.comment {
        out["comment"] = json!(text);
    }
    out
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
