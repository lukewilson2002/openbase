//! Instance administration: users, audit log, stats and backups. Only for a token with the
//! `manage` permission whose user is an instance administrator; every call is recorded in the
//! audit log as `admin_token_use` (naming the token) by the REST API itself.
//!
//! By design there is no way here to set another user's password, to switch off their
//! two-factor authentication or to obtain a password-reset link: those are credentials, which
//! no API token can touch (the REST API refuses them for tokens whatever the scope). A user
//! created here has no usable password; a person sets one through the web app's "Forgot
//! password" (when email is configured) or an administrator's reset link from Admin -> Users.

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
            "Create a user account (name, email, optional administrator role). The account has no usable password and this tool cannot set one or return a reset link (credentials are never handled by API tokens): the person uses 'Forgot password' on the sign-in page when the server sends email, otherwise an administrator creates a reset link under Admin > Users in the web app. Instance administrators only.",
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
            "Rename a user, deactivate or reactivate them (a deactivated user cannot sign in and their sessions and tokens stop working), or grant or revoke the administrator role. It cannot switch off someone's two-factor authentication (a credential: administrators do that in the web app). Instance administrators only; you cannot demote or deactivate the last administrator.",
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
            "admin_get_email_settings",
            "Read the email settings",
            "The outgoing-email (SMTP) settings: whether email is on, host, port, security (starttls | tls | none), username, sender address, whether a password is stored (never the password itself), where each setting comes from (environment = fixed by an OPENGRID_SMTP_* variable and read-only, settings = saved here, default, unset) and the read-only hourly email budgets. Instance administrators only.",
            object(json!({}), &[]),
        )
        .admin(),
        ToolDef::new(
            "admin_update_email_settings",
            "Change the email settings",
            "Change the SMTP settings; the change applies at once. Leave a field out to keep it; null clears host (switches email off) or username. Fields fixed by an environment variable cannot be changed. The SMTP password can NOT be set or removed here (credentials are entered by a person in the web app, Admin > Email), and while a password is in use the host, port, security and username cannot be changed here either, because that would send the password to another server. Run admin_send_test_email afterwards. Instance administrators only.",
            object(
                json!({
                    "host": json!({"type": ["string", "null"], "description": "SMTP server host name, e.g. smtp.example.com. null switches email off."}),
                    "port": integer("SMTP port, e.g. 587 (starttls), 465 (tls), 25.", 1, 65535),
                    "security": enumeration(&["starttls", "tls", "none"], "Connection security: starttls (usually port 587), tls (implicit TLS, usually 465) or none (a local relay only)."),
                    "username": json!({"type": ["string", "null"], "description": "SMTP username. null removes it."}),
                    "from": string("Sender address, e.g. 'OpenGrid <opengrid@example.com>'."),
                }),
                &[],
            ),
        )
        .admin()
        .changes()
        .idempotent(),
        ToolDef::new(
            "admin_send_test_email",
            "Send a test email",
            "Send a test email through the current SMTP settings, to the administrator's own address unless `to` is given. A failure comes back as an error with the real SMTP error text (connection refused, authentication failed, ...). Counts against the email budgets. Instance administrators only.",
            object(
                json!({ "to": string("Recipient address (default: your own).") }),
                &[],
            ),
        )
        .admin()
        .changes(),
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
        "admin_get_email_settings" => plain!("GET", "/api/admin/email", "email"),
        "admin_update_email_settings" => with_args!(UpdateEmail, update_email),
        "admin_send_test_email" => with_args!(TestEmail, test_email),
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
            // A token never receives a reset link (the REST API leaves it out), so the account
            // cannot be signed in to until a person chooses a password.
            let how = if ctx.state.email.enabled() {
                "The new person can choose a password with 'Forgot password' on the sign-in page \
                 (the server sends email), or an administrator can create a reset link under \
                 Admin > Users in the web app."
            } else {
                "Email is not configured on this server, so an administrator has to create a \
                 password-reset link under Admin > Users in the web app and send it to them \
                 (or set up email under Admin > Email)."
            };
            ToolResult::ok(json!({
                "user": v["user"],
                "note": format!(
                    "Created without a usable password: API tokens never set passwords or receive reset links. {how}"
                ),
            }))
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateEmail {
    #[serde(default, deserialize_with = "og_core::api::double_option")]
    host: Option<Option<String>>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    security: Option<String>,
    #[serde(default, deserialize_with = "og_core::api::double_option")]
    username: Option<Option<String>>,
    #[serde(default)]
    from: Option<String>,
}

async fn update_email(ctx: &McpCtx, a: UpdateEmail) -> ToolResult {
    let mut body = Map::new();
    if let Some(host) = a.host {
        body.insert("host".into(), json!(host));
    }
    if let Some(port) = a.port {
        body.insert("port".into(), json!(port));
    }
    if let Some(security) = a.security {
        body.insert("security".into(), json!(security));
    }
    if let Some(username) = a.username {
        body.insert("username".into(), json!(username));
    }
    if let Some(from) = a.from {
        body.insert("from".into(), json!(from));
    }
    if body.is_empty() {
        return ToolResult::error(
            "Give something to change: host, port, security, username or from.",
        );
    }
    match fetch(
        ctx,
        "PATCH",
        "/api/admin/email",
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(json!({
            "email": v,
            "note": "Saved and in effect. Run admin_send_test_email to check delivery.",
        })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestEmail {
    #[serde(default)]
    to: Option<String>,
}

async fn test_email(ctx: &McpCtx, a: TestEmail) -> ToolResult {
    let mut body = Map::new();
    if let Some(to) = a.to {
        body.insert("to".into(), json!(to));
    }
    match fetch(
        ctx,
        "POST",
        "/api/admin/email/test",
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) if v["ok"] == true => ToolResult::ok(json!({
            "sent": true,
            "to": v["to"],
            "note": "The mail server accepted the message. Check the inbox to confirm it arrived.",
        })),
        Ok(v) => ToolResult::error(format!(
            "The test email to {} was not sent: {}",
            v["to"].as_str().unwrap_or("?"),
            v["error"].as_str().unwrap_or("unknown error")
        )),
        Err(e) => e,
    }
}
