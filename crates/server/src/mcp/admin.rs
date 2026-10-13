//! Instance administration: users, audit log, stats and backups. Only for a token with the
//! `manage` permission whose user is an instance administrator; every call is recorded in the
//! audit log as `admin_token_use` (naming the token) by the REST API itself.
//!
//! By design there is no way here to set another user's password or to switch off their
//! two-factor authentication: new users get a reset link to choose their own password.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::support::*;
use super::tools::{ToolDef, ToolResult};

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "admin_list_users",
            "List all users",
            "List every user of the instance: id, email, name, whether they are an administrator or deactivated, whether they use two-factor authentication, creation and last login. Instance administrators only.",
            object(json!({}), &[]),
        )
        .admin(),
        ToolDef::new(
            "admin_create_user",
            "Create a user",
            "Create a user account. The user has no password yet: the result contains a password-reset link (valid 24 hours) to hand over so they can choose one. Instance administrators only.",
            object(
                json!({
                    "email": string("Email address (the sign-in name)."),
                    "name": string("Display name."),
                    "is_admin": boolean("Make them an instance administrator (default false)."),
                }),
                &["email", "name"],
            ),
        )
        .admin()
        .changes(),
        ToolDef::new(
            "admin_update_user",
            "Update a user",
            "Rename a user, deactivate or reactivate them (a deactivated user cannot sign in and their sessions and tokens stop working), or grant or revoke the administrator role. Instance administrators only; you cannot demote or deactivate the last administrator.",
            object(
                json!({
                    "user_id": string("User id (from admin_list_users)."),
                    "name": string("New display name."),
                    "is_active": boolean("false deactivates the account, true reactivates it."),
                    "is_admin": boolean("Grant or revoke the administrator role."),
                }),
                &["user_id"],
            ),
        )
        .admin()
        .changes()
        .idempotent(),
        ToolDef::new(
            "admin_audit_log",
            "Read the audit log",
            "The instance audit log, newest first: sign-ins, admin actions, token use on admin endpoints. Page with `before`. Instance administrators only.",
            object(
                json!({
                    "limit": integer("Entries to return (default 50, max 200).", 1, 200),
                    "before": integer("The `next_before` of a previous page, for older entries.", 1, i64::MAX as u64),
                }),
                &[],
            ),
        )
        .admin(),
        ToolDef::new(
            "admin_stats",
            "Instance statistics",
            "Counts of users, workspaces, bases and records, database and attachment sizes, the time of the last backup and the version. Instance administrators only.",
            object(json!({}), &[]),
        )
        .admin(),
        ToolDef::new(
            "admin_create_backup",
            "Create a backup",
            "Make a consistent backup of the database now. Returns its name; it is stored on the server (download it from the admin page of the web app). Instance administrators only.",
            object(json!({}), &[]),
        )
        .admin()
        .changes(),
        ToolDef::new(
            "admin_list_backups",
            "List backups",
            "List the backups stored on the server with size and creation time. Instance administrators only.",
            object(json!({}), &[]),
        )
        .admin(),
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
    macro_rules! plain {
        ($method:expr, $path:expr, $key:expr) => {
            Some(match no_args(args.clone()) {
                Ok(()) => fetch_as(ctx, $method, $path, None, None, $key).await,
                Err(e) => e,
            })
        };
    }
    match name {
        "admin_list_users" => plain!("GET", "/api/admin/users", "users"),
        "admin_stats" => plain!("GET", "/api/admin/stats", "stats"),
        "admin_list_backups" => plain!("GET", "/api/admin/backups", "backups"),
        "admin_create_backup" => plain!("POST", "/api/admin/backups", "backup"),
        "admin_create_user" => with_args!(CreateUser, create_user),
        "admin_update_user" => with_args!(UpdateUser, update_user),
        "admin_audit_log" => with_args!(AuditArgs, audit_log),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateUser {
    email: String,
    name: String,
    #[serde(default)]
    is_admin: Option<bool>,
}

async fn create_user(ctx: &McpCtx, a: CreateUser) -> ToolResult {
    let body = json!({
        "email": a.email,
        "name": a.name,
        "is_admin": a.is_admin.unwrap_or(false),
    });
    match fetch(ctx, "POST", "/api/admin/users", None, Some(body)).await {
        Ok(v) => {
            let mut out = json!({ "user": v["user"] });
            if !v["reset_link"].is_null() {
                out["reset_link"] = v["reset_link"].clone();
                out["note"] = json!(
                    "Hand this link to the user; they choose their password with it. It is shown only now."
                );
            }
            ToolResult::ok(out)
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateUser {
    user_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    is_active: Option<bool>,
    #[serde(default)]
    is_admin: Option<bool>,
}

async fn update_user(ctx: &McpCtx, a: UpdateUser) -> ToolResult {
    let mut body = Map::new();
    if let Some(n) = a.name {
        body.insert("name".into(), json!(n));
    }
    if let Some(v) = a.is_active {
        body.insert("is_active".into(), json!(v));
    }
    if let Some(v) = a.is_admin {
        body.insert("is_admin".into(), json!(v));
    }
    if body.is_empty() {
        return ToolResult::error("Give something to change: name, is_active or is_admin.");
    }
    let path = format!("/api/admin/users/{}", encode_segment(&a.user_id));
    fetch_as(ctx, "PATCH", &path, None, Some(Value::Object(body)), "user").await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditArgs {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<i64>,
}

async fn audit_log(ctx: &McpCtx, a: AuditArgs) -> ToolResult {
    let mut query = json!({ "limit": a.limit.unwrap_or(50).clamp(1, 200) });
    if let Some(b) = a.before {
        query["before"] = json!(b);
    }
    match fetch(ctx, "GET", "/api/admin/audit", Some(query), None).await {
        Ok(v) => ToolResult::ok(v),
        Err(e) => e,
    }
}
