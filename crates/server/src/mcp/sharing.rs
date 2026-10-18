//! Share links: public read-only views and public forms.

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{find_view, load_schema};
use super::support::*;
use super::tools::{ToolDef, ToolResult};

fn view_props() -> Value {
    json!({
        "project_id": string(BASE_ID),
        "view": string("View name or id (a form view for a public form)."),
        "table": string("Table name or id; needed only when several tables have a view with this name."),
    })
}

pub fn definitions() -> Vec<ToolDef> {
    let mut create_props = view_props();
    create_props["kind"] = enumeration(
        &["view", "form"],
        "'view' = read-only public page of the records, 'form' = public form that creates records anonymously. Default: 'form' for form views, else 'view'.",
    );
    create_props["password"] = string("Optional password visitors must enter.");
    vec![
        ToolDef::new(
            "create_share_link",
            "Create a share link",
            "Publish a view as a public link anyone with the URL can open: a read-only page (kind 'view', non-form views) or a public form (kind 'form', form views) that creates records without signing in. Optional password. Returns the full URL. Needs the creator role.",
            object(create_props, &["project_id", "view"]),
        )
        .write(),
        ToolDef::new(
            "list_share_links",
            "List share links",
            "List the share links of a view with their URL, kind, whether they are enabled and password-protected. Needs the creator role.",
            object(view_props(), &["project_id", "view"]),
        ),
        ToolDef::new(
            "update_share_link",
            "Update a share link",
            "Enable or disable a share link, or set (string) or remove (null) its password. Needs the creator role.",
            object(
                json!({
                    "share_id": string("Share link id (from list_share_links)."),
                    "enabled": boolean("Turn the link on or off."),
                    "password": json!({
                        "type": ["string", "null"],
                        "description": "A string sets the password; null removes it; omit to leave it unchanged.",
                    }),
                }),
                &["share_id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "delete_share_link",
            "Delete a share link",
            "Delete a share link for good; its URL stops working. Needs the creator role.",
            object(
                json!({ "share_id": string("Share link id (from list_share_links).") }),
                &["share_id"],
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
        "create_share_link" => with_args!(CreateShare, create_share_link),
        "list_share_links" => with_args!(ListShares, list_share_links),
        "update_share_link" => with_args!(UpdateShare, update_share_link),
        "delete_share_link" => with_args!(ShareArg, delete_share_link),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListShares {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateShare {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

async fn create_share_link(ctx: &McpCtx, a: CreateShare) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (_, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let is_form = serde_json::to_value(view.view_type).ok() == Some(json!("form"));
    let kind = a
        .kind
        .unwrap_or_else(|| if is_form { "form" } else { "view" }.to_string());
    if kind != "view" && kind != "form" {
        return ToolResult::error("kind must be 'view' or 'form'.");
    }
    if kind == "form" && !is_form {
        return ToolResult::error(format!(
            "'{}' is not a form view, so it cannot be shared as a form. Create a form view with create_view (type 'form') or share it with kind 'view'.",
            view.name
        ));
    }
    if kind == "view" && is_form {
        return ToolResult::error(format!(
            "'{}' is a form view: share it with kind 'form'.",
            view.name
        ));
    }
    let mut body = Map::new();
    body.insert("kind".into(), json!(kind));
    if let Some(p) = a.password.filter(|p| !p.is_empty()) {
        body.insert("password".into(), json!(p));
    }
    let path = format!("/api/views/{}/shares", encode_segment(&view.id));
    fetch_as(
        ctx,
        "POST",
        &path,
        None,
        Some(Value::Object(body)),
        "share_link",
    )
    .await
}

async fn list_share_links(ctx: &McpCtx, a: ListShares) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (_, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let path = format!("/api/views/{}/shares", encode_segment(&view.id));
    fetch_as(ctx, "GET", &path, None, None, "share_links").await
}

/// Distinguish an omitted key (`None`) from an explicit `null` (`Some(None)`).
fn some_value<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateShare {
    share_id: String,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "some_value")]
    password: Option<Option<String>>,
}

async fn update_share_link(ctx: &McpCtx, a: UpdateShare) -> ToolResult {
    let mut body = Map::new();
    if let Some(e) = a.enabled {
        body.insert("enabled".into(), json!(e));
    }
    if let Some(p) = a.password {
        body.insert("password".into(), json!(p));
    }
    if body.is_empty() {
        return ToolResult::error("Give something to change: enabled and/or password.");
    }
    let path = format!("/api/shares/{}", encode_segment(&a.share_id));
    fetch_as(
        ctx,
        "PATCH",
        &path,
        None,
        Some(Value::Object(body)),
        "share_link",
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareArg {
    share_id: String,
}

async fn delete_share_link(ctx: &McpCtx, a: ShareArg) -> ToolResult {
    let path = format!("/api/shares/{}", encode_segment(&a.share_id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({ "deleted": a.share_id })),
        Err(e) => e,
    }
}
