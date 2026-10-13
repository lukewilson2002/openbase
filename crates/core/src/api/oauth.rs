//! DTOs of the OAuth consent flow (`/api/oauth/*`) and of the "Connected apps" lists.
//!
//! The OAuth protocol endpoints themselves (`/oauth/authorize`, `/oauth/token`, ...) speak the
//! RFC formats and have no DTOs here. These are what the web app's consent page and account page
//! use: the server stores the pending authorization request, the page shows it and posts the
//! user's decision.

use serde::{Deserialize, Serialize};

/// The access levels a user can give an app, lowest first. They map onto the token scope model
/// (`write`, `manage`) of personal access tokens.
pub mod access {
    /// Read everything the user can read.
    pub const READ: &str = "read";
    /// Also create, edit and delete content (`write`).
    pub const WRITE: &str = "write";
    /// Also manage workspaces, members, invites and settings (`write` + `manage`).
    pub const MANAGE: &str = "manage";
}

/// A pending authorization request, as the consent page shows it
/// (`GET /api/oauth/requests/{id}`). Everything here was validated when the request was made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ConsentRequest {
    pub id: String,
    /// The app's client id: an opaque id, or for apps identified by a metadata document the
    /// HTTPS address of that document.
    pub client_id: String,
    /// The name the app gave itself. Untrusted text: anyone can register any name.
    pub client_name: String,
    /// `dcr` (registered itself), `cimd` (identified by a metadata document URL) or
    /// `preregistered` (added by the administrator).
    pub client_source: String,
    /// Where the approval (or refusal) is sent.
    pub redirect_uri: String,
    /// Host (and port, when not the default) of `redirect_uri`: who receives the access.
    pub redirect_host: String,
    /// The redirect address is on the user's own machine (an app running locally).
    pub loopback: bool,
    /// The redirect host belongs to a known assistant provider (claude.ai, chatgpt.com, openai.com).
    pub trusted_host: bool,
    /// Set (to "Claude" or "ChatGPT") when the app's name imitates that product but the redirect
    /// host is not one of its own.
    #[serde(default)]
    pub impersonates: Option<String>,
    /// The highest access level the app asked for, if it asked for any.
    #[serde(default)]
    pub requested_access: Option<String>,
    /// The highest level the user may choose (`read`, `write` or `manage`).
    pub max_access: String,
    /// The level the page selects first (never `manage`).
    pub default_access: String,
    /// When the request lapses (unix ms).
    pub expires_at: i64,
}

/// The user's answer (`POST /api/oauth/requests/{id}/decision`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ConsentDecision {
    /// `approve` or `deny`.
    pub decision: String,
    /// For `approve`: `read`, `write` or `manage`.
    #[serde(default)]
    pub access: Option<String>,
    /// For `approve`: limit the app to these bases; absent = every base the user can access.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
}

/// Where the browser goes next: the app's redirect address with the authorization code (or the
/// error) added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ConsentOutcome {
    pub redirect_to: String,
}

/// One base a grant is limited to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct GrantBase {
    pub id: String,
    /// The base's name, or its id when the base no longer exists.
    pub name: String,
}

/// A connected app: what a user allowed an OAuth client to do
/// (`GET /api/oauth/grants`, `GET /api/admin/oauth/grants`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct GrantInfo {
    pub id: String,
    pub client_name: String,
    pub client_source: String,
    /// Host (and port) the app receives its access at.
    pub redirect_host: String,
    pub write: bool,
    pub manage: bool,
    /// The bases the app is limited to; absent = every base the user can access.
    #[serde(default)]
    pub bases: Option<Vec<GrantBase>>,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// The grant lapses at this time unless the app refreshes its access first (unix ms).
    pub expires_at: i64,
    /// Admin list only: who gave the access.
    #[serde(default)]
    pub user_email: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
}
