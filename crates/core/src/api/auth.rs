//! DTOs for setup, authentication, account, tokens, invites and admin APIs.
//! Owned by workstream W3 (server) and consumed by W5 (web). Add fields with
//! `#[serde(default)]` so older clients keep working.

use serde::{Deserialize, Serialize};

/// Response of actions with nothing else to return (logout, password change,
/// password reset request/confirm, revoke other sessions): `{"ok": true}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct OkResponse {
    pub ok: bool,
}

impl OkResponse {
    pub fn new() -> Self {
        OkResponse { ok: true }
    }
}

impl Default for OkResponse {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SetupStatus {
    /// No users exist yet: the next signup creates the administrator.
    pub needs_setup: bool,
    pub open_signup: bool,
    pub email_enabled: bool,
    /// The address users reach OpenBase at (`OPENBASE_PUBLIC_URL`, no trailing slash). The account
    /// page builds the MCP address from it, because the browser may be on another address (a proxy,
    /// a tunnel) than the one AI assistants must use.
    pub public_url: String,
    /// Passkey sign-in is available: the public URL's host is a domain name (WebAuthn does not
    /// work for an IP address).
    #[serde(default)]
    pub passkeys_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_admin: bool,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub totp_enabled: bool,
    /// Whether the user has seen (or skipped) the introduction.
    #[serde(default)]
    pub intro_seen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SignupRequest {
    pub email: String,
    pub name: String,
    pub password: String,
    #[serde(default)]
    pub invite_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

/// Login result: either a user (logged in) or a 2FA challenge (a pending
/// session cookie is set; complete with `POST /api/auth/login/2fa`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct LoginResponse {
    #[serde(default)]
    pub user: Option<User>,
    #[serde(default)]
    pub two_factor_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TwoFactorCode {
    pub code: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateMeRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// IANA zone, or empty string to clear (use browser zone).
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub intro_seen: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasswordResetRequest {
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasswordResetConfirm {
    pub token: String,
    pub new_password: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TwoFactorSetup {
    /// Base32 secret for manual entry.
    pub secret: String,
    /// otpauth:// URI for QR codes.
    pub otpauth_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TwoFactorDisable {
    pub password: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SessionInfo {
    /// Opaque id (a prefix of the token hash), usable with DELETE /api/auth/sessions/{id}.
    pub id: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateTokenRequest {
    pub name: String,
    pub write: bool,
    /// Also allow account-level management a signed-in user can do in the web app: workspaces,
    /// members, invites, base deletion and (for administrators) the admin pages. Requires
    /// `write`. Credentials, sessions and tokens are never reachable with a token.
    #[serde(default)]
    pub manage: bool,
    /// Limit to these bases; None = all bases the user can access.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
    pub write: bool,
    /// May manage workspaces, members, invites and settings (see `CreateTokenRequest::manage`).
    #[serde(default)]
    pub manage: bool,
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Returned once at creation; the raw token is never shown again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreatedToken {
    pub token: String,
    pub info: TokenInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateInviteRequest {
    /// Optional: restrict acceptance to this email and send an email if SMTP is configured.
    #[serde(default)]
    pub email: Option<String>,
    /// viewer | commenter | editor | creator | owner
    pub role: String,
    /// Give access to every base of the workspace, including later ones.
    /// Defaults to true for workspace invites and false for base invites
    /// (which only owners may widen); always true for the owner role.
    #[serde(default)]
    pub all_bases: Option<bool>,
    /// Bases the invitee can open when `all_bases` is false. Base invites
    /// default to the base they were created from.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct InviteInfo {
    pub id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Always null: every invite is a workspace invite now (see `all_bases`
    /// and `base_ids`). Kept so older clients still parse the response.
    #[serde(default)]
    pub base_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub role: String,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub accepted_at: Option<i64>,
    /// Whether accepting gives access to every base of the workspace.
    pub all_bases: bool,
    /// The bases accepting gives access to when `all_bases` is false.
    pub base_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreatedInvite {
    /// Full URL to share: `<public_url>/invite/<token>`. Shown once.
    pub url: String,
    pub info: InviteInfo,
}

/// Public view of an invite (by token) shown on the accept page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct InvitePreview {
    /// Workspace or base name.
    pub target_name: String,
    /// Lucide icon name of the workspace or base, if it has one.
    #[serde(default)]
    pub target_icon: Option<String>,
    /// The workspace's colour (one of `ob_core::field::COLORS`).
    pub target_color: String,
    pub target_kind: String,
    pub role: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub invited_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AdminUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub totp_enabled: bool,
    /// How many passkeys the user has registered.
    #[serde(default)]
    pub passkey_count: i64,
    pub created_at: i64,
    #[serde(default)]
    pub last_login_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AdminCreateUser {
    pub email: String,
    pub name: String,
    /// If omitted, a reset link is returned for the user to set their password (to a signed-in
    /// administrator only). Setting a password is not possible with an API token.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub is_admin: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AdminUpdateUser {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_admin: Option<bool>,
    /// Turn off the user's two-factor authentication (e.g. lost device). Not possible with an
    /// API token.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub disable_2fa: bool,
}

/// Result of `POST /api/admin/users`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AdminCreatedUser {
    pub user: AdminUser,
    /// Present when no password was given and the caller is signed in: send this link to the
    /// user so they can choose one. An API token never receives it.
    #[serde(default)]
    pub reset_link: Option<ResetLink>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ResetLink {
    pub url: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AuditEntry {
    pub id: i64,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_email: Option<String>,
    pub action: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
    #[serde(default)]
    pub ip: Option<String>,
    pub created_at: i64,
}

/// One page of `GET /api/admin/audit?before=<id>&limit=<n>` (newest first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    /// Pass as `before` to fetch the next (older) page; None when exhausted.
    #[serde(default)]
    pub next_before: Option<i64>,
}

/// `GET /api/tokens/whoami`: who the caller is and, for API tokens, the scope.
/// Works with a session or a token, so integrations can check their token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct WhoAmI {
    pub user_id: String,
    pub email: String,
    pub name: String,
    /// True when authenticated with an API token.
    pub via_token: bool,
    /// Whether writes are allowed (always true for sessions).
    pub write: bool,
    /// Whether account-level management is allowed (always true for sessions).
    #[serde(default)]
    pub manage: bool,
    /// Base restriction of the token; None = all bases the user can access.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct InstanceStats {
    pub users: i64,
    pub workspaces: i64,
    pub bases: i64,
    pub records: i64,
    pub database_bytes: i64,
    pub attachments_bytes: i64,
    #[serde(default)]
    pub last_backup_at: Option<i64>,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
}
