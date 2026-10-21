//! `search_everything`: the web app's "Search everything" box for agents. It calls
//! `GET /api/search` as the caller, so what it finds, its order and its access rules are the
//! web app's own; a workspace or project given by name is resolved among those the caller can
//! open (`GET /api/workspaces`).

use ob_core::api::search::{SearchResponse, SearchResult};
use ob_core::api::workspaces::WorkspaceSummary;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::history::resolve_one;
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use crate::store::search::{DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_CHARS};

pub fn definitions() -> Vec<ToolDef> {
    vec![ToolDef::new(
        "search_everything",
        "Search everything",
        "Find text across ALL your workspaces and projects at once (or only inside one workspace or project): workspace, project, table and view names, record text (the primary field and text, rich text, email, URL and phone fields) and comments, like the web app's search box. Case-insensitive; matches anywhere in a word ('mark' finds 'Marketing'). Best first: names, then records, then comments (newest first). Each result says where it is (workspace, project, table, ids to open it with get_record / query_view) and where it matched: `name_matches` in `name`, and for a record found by another field or a comment a `snippet` of plain text around the match (rich text and comments without Markdown, a mention as @Name, `…` where cut) with `snippet_matches` and the `field` it came from. Match ranges are [start, end) character (code point) offsets. To search one table with full records use search_records.",
        object(
            json!({
                "query": string(&format!("Text to look for (1-{MAX_QUERY_CHARS} characters).")),
                "workspace": string("Only what is inside this workspace (name or id)."),
                "project": string("Only what is inside this project (name or id; add `workspace` when several projects have that name)."),
                "limit": integer(&format!("Results to return (default {DEFAULT_LIMIT}, max {MAX_LIMIT})."), 1, MAX_LIMIT as u64),
            }),
            &["query"],
        ),
    )]
}

pub async fn run(ctx: &McpCtx, name: &str, args: &Value) -> Option<ToolResult> {
    match name {
        "search_everything" => Some(match parse::<SearchArgs>(args.clone()) {
            Ok(a) => search_everything(ctx, a).await,
            Err(e) => e,
        }),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    query: String,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default, alias = "base")]
    project: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn search_everything(ctx: &McpCtx, a: SearchArgs) -> ToolResult {
    let q = a.query.trim();
    if q.is_empty() {
        return ToolResult::error("query must not be empty.");
    }
    if q.chars().count() > MAX_QUERY_CHARS {
        return ToolResult::error(format!(
            "query is too long (at most {MAX_QUERY_CHARS} characters)."
        ));
    }
    let limit = a.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut query = Map::new();
    query.insert("q".into(), json!(q));
    query.insert("limit".into(), json!(limit));

    // Names to ids, the workspace narrowing which projects a name can mean.
    if a.workspace.is_some() || a.project.is_some() {
        let list = match fetch(ctx, "GET", "/api/workspaces", None, None).await {
            Ok(v) => v,
            Err(e) => return e,
        };
        let mut workspaces: Vec<WorkspaceSummary> = match serde_json::from_value(list) {
            Ok(w) => w,
            Err(e) => return ToolResult::error(format!("Unexpected response: {e}")),
        };
        if let Some(key) = &a.workspace {
            let id = match resolve_one("Workspace", key, &workspaces, |w| &w.id, |w| &w.name) {
                Ok(id) => id,
                Err(e) => return e,
            };
            workspaces.retain(|w| w.id == id);
            query.insert("workspace".into(), json!(id));
        }
        if let Some(key) = &a.project {
            let bases: Vec<_> = workspaces.into_iter().flat_map(|w| w.bases).collect();
            let id = match resolve_one("Project", key, &bases, |b| &b.id, |b| &b.name) {
                Ok(id) => id,
                Err(e) => return e,
            };
            query.insert("base".into(), json!(id));
        }
    }

    let res = match fetch(ctx, "GET", "/api/search", Some(Value::Object(query)), None).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let res: SearchResponse = match serde_json::from_value(res) {
        Ok(r) => r,
        Err(e) => return ToolResult::error(format!("Unexpected response: {e}")),
    };
    let results: Vec<Value> = res.results.iter().map(result).collect();
    let mut out = json!({ "count": results.len(), "results": results });
    if res.results.len() >= limit {
        out["hint"] = json!(
            "There may be more: raise `limit`, narrow with `workspace` or `project`, or use more specific text."
        );
    }
    ToolResult::ok(out)
}

/// A result in the tools' words: projects, not bases; nothing that is not there.
fn result(r: &SearchResult) -> Value {
    let kind = if r.kind == "base" { "project" } else { &r.kind };
    let mut out = json!({
        "kind": kind,
        "id": r.id,
        "name": r.name,
        "workspace": r.workspace_name,
        "workspace_id": r.workspace_id,
    });
    let mut put = |key: &str, v: &Option<String>| {
        if let Some(v) = v {
            out[key] = json!(v);
        }
    };
    put("project", &r.base_name);
    put("project_id", &r.base_id);
    put("table", &r.table_name);
    put("table_id", &r.table_id);
    put("view_id", &r.view_id);
    put("record_id", &r.record_id);
    put("field", &r.field_name);
    put("author", &r.author_name);
    put("snippet", &r.snippet);
    let ranges = |m: &[ob_core::api::search::TextMatch]| -> Value {
        m.iter().map(|m| json!([m.start, m.end])).collect()
    };
    if !r.name_matches.is_empty() {
        out["name_matches"] = ranges(&r.name_matches);
    }
    if !r.snippet_matches.is_empty() {
        out["snippet_matches"] = ranges(&r.snippet_matches);
    }
    out
}
