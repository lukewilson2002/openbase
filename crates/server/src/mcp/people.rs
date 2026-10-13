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

const SCOPE_HELP: &str = "Whether `id` is a workspace id or a base id.";

fn scope_schema() -> Value {
    enumeration(&["workspace", "base"], SCOPE_HELP)
}

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "list_workspaces",
            "List workspaces",
            "List the workspaces you belong to with your role on each and the bases inside (a base-limited token sees only its bases). list_bases returns the same; use this one when you care about workspaces.",
            object(json!({}), &[]),
        ),
        ToolDef::new(
            "rename_workspace",
            "Rename a workspace or change its icon",
            "Change a workspace's name and/or icon (either; what you leave out stays). icon: a Lucide name sets it, null removes it. Needs the manage permission and the owner role on the workspace.",
            object(
                json!({
                    "workspace_id": string("Workspace id (from list_workspaces)."),
                    "name": string("New name."),
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
            "Delete a workspace and all its bases. They move to the trash and can be restored for the trash retention period (restore_from_trash with kind 'workspace'). Needs the manage permission and the owner role.",
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
            "Remove someone's access to a workspace or a single base (their role there disappears; access through the other level, if any, remains). A workspace always keeps an owner. Needs the manage permission and the owner role.",
            object(
                json!({
                    "scope": scope_schema(),
                    "id": string("Workspace id or base id."),
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
            "List the pending invite links of a workspace (owner role) or a single base (creator role). Invite links are shown only when created (create_invite); this lists their ids, roles, emails and expiry so they can be revoked.",
            object(
                json!({ "scope": scope_schema(), "id": string("Workspace id or base id.") }),
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
            "List the people who can see a base (id, name, email): the values for user fields and the ids for @mentions in comments. Any role can read this.",
            object(json!({ "base_id": string(BASE_ID) }), &["base_id"]),
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
    #[serde(default, deserialize_with = "og_core::api::double_option")]
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
    let note = match put_icon(&mut body, a.icon) {
        Ok(n) => n,
        Err(e) => return e,
    };
    if body.is_empty() {
        return ToolResult::error("Give a new name and/or icon.");
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
