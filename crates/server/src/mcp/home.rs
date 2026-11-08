//! `get_home`: a workspace's Home for agents, the same one read the web app's Home screen makes
//! (`GET /api/workspaces/{id}/home`), so what is due, what changed and which drafts wait are the
//! web app's own, with its access rules. A workspace given by name is resolved among those the
//! caller belongs to (`GET /api/workspaces`).

use ob_core::api::home::{HomeDue, HomeRecent, HomeResponse};
use ob_core::api::workspaces::WorkspaceSummary;
use serde::Deserialize;
use serde_json::{Value, json};

use super::McpCtx;
use super::history::resolve_one;
use super::resolve::list_names;
use super::support::*;
use super::tools::{ToolDef, ToolResult};

pub fn definitions() -> Vec<ToolDef> {
    vec![ToolDef::new(
        "get_home",
        "Get a workspace's Home",
        "What the web app's Home shows for a workspace, in one read: `due` (records dated from 30 days ago to 7 days ahead by their table's Home date setting, not marked done, oldest first, at most 50: with `date` (YYYY-MM-DD in your time zone), `time` (HH:MM) when the date has one, `overdue`, `done_field_id` (tick that checkbox with update_records to finish the task) and whether you `can_edit` it), `recent` (the 10 records most recently created or edited, newest first, with who and when) and `drafts` (your inbox drafts, which belong to no workspace). A table has a Home date once update_table_settings sets one. When `truncated` is true some tables were not checked (very large workspaces). Only projects you can open are read. Use it to see what is on the user's plate before asking them; for one table's records use query_view or list_records.",
        object(
            json!({
                "workspace": string("The workspace (name or id). Optional when you belong to only one."),
            }),
            &[],
        ),
    )]
}

pub async fn run(ctx: &McpCtx, name: &str, args: &Value) -> Option<ToolResult> {
    match name {
        "get_home" => Some(match parse::<HomeArgs>(args.clone()) {
            Ok(a) => get_home(ctx, a).await,
            Err(e) => e,
        }),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HomeArgs {
    #[serde(default)]
    workspace: Option<String>,
}

async fn get_home(ctx: &McpCtx, a: HomeArgs) -> ToolResult {
    let list = match fetch(ctx, "GET", "/api/workspaces", None, None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let workspaces: Vec<WorkspaceSummary> = match serde_json::from_value(list) {
        Ok(w) => w,
        Err(e) => return ToolResult::error(format!("Unexpected response: {e}")),
    };
    let key = match (&a.workspace, workspaces.as_slice()) {
        (Some(key), _) => key.clone(),
        (None, [only]) => only.id.clone(),
        (None, []) => return ToolResult::error("You do not belong to any workspace yet."),
        (None, _) => {
            return ToolResult::error(format!(
                "Several workspaces: say which with `workspace`. Workspaces: {}.",
                list_names(
                    workspaces
                        .iter()
                        .map(|w| format!("'{}' ({})", w.name, w.id))
                )
            ));
        }
    };
    let id = match resolve_one("Workspace", &key, &workspaces, |w| &w.id, |w| &w.name) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let path = format!("/api/workspaces/{}/home", encode_segment(&id));
    let res = match fetch(ctx, "GET", &path, None, None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let home: HomeResponse = match serde_json::from_value(res) {
        Ok(h) => h,
        Err(e) => return ToolResult::error(format!("Unexpected response: {e}")),
    };
    let workspace = workspaces.iter().find(|w| w.id == id);
    let mut out = json!({
        "workspace": workspace.map(|w| w.name.as_str()),
        "workspace_id": id,
        "today": home.today,
        "timezone": home.timezone,
        "due": home.due.iter().map(due).collect::<Vec<_>>(),
        "truncated": home.truncated,
        "recent": home.recent.iter().map(recent).collect::<Vec<_>>(),
        "drafts": home.drafts,
    });
    if home.truncated {
        out["hint"] = json!(
            "Some tables were not checked because the workspace is very large; use query_view on a table's own view to see its dated records."
        );
    }
    ToolResult::ok(out)
}

/// A due record in the tools' words: projects, not bases; nothing that is not there.
fn due(d: &HomeDue) -> Value {
    let mut out = json!({
        "record_id": d.record_id,
        "title": d.title,
        "table": d.table_name,
        "table_id": d.table_id,
        "project": d.base_name,
        "project_id": d.base_id,
        "date": d.date,
        "overdue": d.overdue,
        "can_edit": d.can_edit,
    });
    if let Some(time) = &d.time {
        out["time"] = json!(time);
    }
    if let Some(done) = &d.done_field_id {
        out["done_field_id"] = json!(done);
    }
    out
}

fn recent(r: &HomeRecent) -> Value {
    let mut out = json!({
        "record_id": r.record_id,
        "title": r.title,
        "table": r.table_name,
        "table_id": r.table_id,
        "project": r.base_name,
        "project_id": r.base_id,
        "kind": r.kind,
        "at": r.at,
    });
    if let Some(a) = &r.author {
        out["author"] = json!(a.name);
        out["author_id"] = json!(a.id);
    }
    out
}
