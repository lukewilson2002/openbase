//! Workspaces and people: renaming and deleting workspaces, members, invite links and
//! collaborators. (`create_workspace`, `list_members`, `set_member_role` and `create_invite`
//! live with the data tools in [`super::data`].)
//!
//! Everything runs through the REST API as the caller, so the owner/creator role rules and the
//! `manage` permission are the server's own.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::data::Scope;
use super::support::*;
use super::tools::{ToolDef, ToolResult};

const SCOPE_HELP: &str = "Whether `id` is a workspace id or a project id.";

fn scope_schema() -> Value {
    enumeration(&["workspace", "project"], SCOPE_HELP)
}

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "list_workspaces",
            "List workspaces",
            "List the workspaces you belong to with your role on each, the projects inside you can open (with who else can open each) and member and pending-invite counts (a project-limited token sees only its projects). list_projects returns the same; use this one when you care about workspaces.",
            object(json!({}), &[]),
        ),
        ToolDef::new(
            "rename_workspace",
            "Rename or restyle a workspace",
            "Change a workspace's name, colour and/or icon (any of them; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the manage permission and the owner role on the workspace.",
            object(
                json!({
                    "workspace_id": string("Workspace id (from list_workspaces)."),
                    "name": string("New name."),
                    "color": string("New colour name, e.g. blue, green, red, purple."),
                    "icon": icon_schema("workspace"),
                }),
                &["workspace_id"],
            ),
        )
        .manage()
        .idempotent(),
        ToolDef::new(
            "delete_workspace",
            "Delete a workspace",
            "Delete a workspace and all its projects. They move to the trash and can be restored for the trash retention period (restore_from_trash with kind 'workspace'). Needs the manage permission and the owner role.",
            object(
                json!({ "workspace_id": string("Workspace id (from list_workspaces).") }),
                &["workspace_id"],
            ),
        )
        .manage()
        .destructive(),
        ToolDef::new(
            "remove_member",
            "Remove a member",
            "Scope 'workspace': remove someone from the workspace (they lose every project in it; a workspace always keeps an owner). Scope 'project': take that project off the list of a member who was given only some projects (not their last one; members with all projects are changed with set_member_role). You may also remove yourself. Needs the manage permission and the owner role.",
            object(
                json!({
                    "scope": scope_schema(),
                    "id": string("Workspace id or project id."),
                    "user_id": string("User id of the member (from list_members)."),
                }),
                &["scope", "id", "user_id"],
            ),
        )
        .manage()
        .destructive(),
        ToolDef::new(
            "list_invites",
            "List invites",
            "List the invite links of a workspace (owner role; accepted and expired included) or the pending ones that give access to a project (creator role). Invite links are shown only when created (create_invite); this lists their ids, roles, projects, emails and expiry so they can be revoked.",
            object(
                json!({ "scope": scope_schema(), "id": string("Workspace id or project id.") }),
                &["scope", "id"],
            ),
        )
        .manage_read(),
        ToolDef::new(
            "revoke_invite",
            "Revoke an invite",
            "Revoke an invite link so it can no longer be accepted. Needs the manage permission.",
            object(
                json!({ "invite_id": string("Invite id (from list_invites).") }),
                &["invite_id"],
            ),
        )
        .manage()
        .destructive(),
        ToolDef::new(
            "list_collaborators",
            "List collaborators",
            "List the people who can see a project (id, name, email): the values for user fields and the ids for @mentions (@[Name](usrXXXX)) in comments and rich text fields. Any role can read this.",
            object(json!({ "project_id": string(BASE_ID) }), &["project_id"]),
        ),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceArg {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameWorkspace {
    workspace_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "ob_core::api::double_option")]
    icon: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeArgs {
    scope: Scope,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoveMember {
    scope: Scope,
    id: String,
    user_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InviteArg {
    invite_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseArg {
    #[serde(rename = "project_id", alias = "base_id")]
    base_id: String,
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
        "list_workspaces" => Some(match no_args(args.clone()) {
            Ok(()) => fetch_as(ctx, "GET", "/api/workspaces", None, None, "workspaces").await,
            Err(e) => e,
        }),
        "rename_workspace" => with_args!(RenameWorkspace, rename_workspace),
        "delete_workspace" => with_args!(WorkspaceArg, delete_workspace),
        "remove_member" => with_args!(RemoveMember, remove_member),
        "list_invites" => with_args!(ScopeArgs, list_invites),
        "revoke_invite" => with_args!(InviteArg, revoke_invite),
        "list_collaborators" => with_args!(BaseArg, list_collaborators),
        _ => None,
    }
}

async fn rename_workspace(ctx: &McpCtx, a: RenameWorkspace) -> ToolResult {
    let mut body = Map::new();
    if let Some(name) = a.name {
        body.insert("name".into(), json!(name));
    }
    insert_some(&mut body, "color", a.color);
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if body.is_empty() {
        return ToolResult::error("Give a new name, colour and/or icon.");
    }
    let path = format!("/api/workspaces/{}", encode_segment(&a.workspace_id));
    match fetch(ctx, "PATCH", &path, None, Some(Value::Object(body))).await {
        Ok(v) => ToolResult::ok(with_note(json!({ "workspace": v }), note)),
        Err(e) => e,
    }
}

async fn delete_workspace(ctx: &McpCtx, a: WorkspaceArg) -> ToolResult {
    let path = format!("/api/workspaces/{}", encode_segment(&a.workspace_id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({
            "deleted": a.workspace_id,
            "note": format!(
                "Moved to the trash, not erased: restore_from_trash (kind 'workspace') brings it back within {} days.",
                ctx.state.config.trash_days
            ),
        })),
        Err(e) => e,
    }
}

async fn remove_member(ctx: &McpCtx, a: RemoveMember) -> ToolResult {
    let path = format!(
        "/api/{}/{}/members/{}",
        a.scope.collection(),
        encode_segment(&a.id),
        encode_segment(&a.user_id)
    );
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({ "removed": a.user_id })),
        Err(e) => e,
    }
}

async fn list_invites(ctx: &McpCtx, a: ScopeArgs) -> ToolResult {
    let path = format!(
        "/api/{}/{}/invites",
        a.scope.collection(),
        encode_segment(&a.id)
    );
    fetch_as(ctx, "GET", &path, None, None, "invites").await
}

async fn revoke_invite(ctx: &McpCtx, a: InviteArg) -> ToolResult {
    let path = format!("/api/invites/{}", encode_segment(&a.invite_id));
    match fetch(ctx, "DELETE", &path, None, None).await {
        Ok(_) => ToolResult::ok(json!({ "revoked": a.invite_id })),
        Err(e) => e,
    }
}

async fn list_collaborators(ctx: &McpCtx, a: BaseArg) -> ToolResult {
    fetch_as(
        ctx,
        "GET",
        &base_path(&a.base_id, "/collaborators"),
        None,
        None,
        "collaborators",
    )
    .await
}
