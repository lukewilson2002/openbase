//! DTOs of the instance's outgoing-email (SMTP) settings: `GET|PATCH /api/admin/email` and
//! `POST /api/admin/email/test`.
//!
//! Each setting comes from the environment (`OPENGRID_SMTP_*`, which wins and is read-only here),
//! from the settings saved through this API, or from a default. The SMTP password is write-only:
//! it is never returned, only whether one is stored.

use serde::{Deserialize, Serialize};

/// Where the effective value of one setting comes from.
pub mod source {
    /// An `OPENGRID_SMTP_*` environment variable (or the matching command-line flag): read-only.
    pub const ENVIRONMENT: &str = "environment";
    /// Saved on the Email tab (or through the API).
    pub const SETTINGS: &str = "settings";
    /// Not set anywhere: the built-in default applies.
    pub const DEFAULT: &str = "default";
    /// Not set anywhere and there is no default (host, username, password).
    pub const UNSET: &str = "unset";
}

/// The source of each setting: `environment` | `settings` | `default` | `unset`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct EmailSources {
    pub host: String,
    pub port: String,
    pub security: String,
    pub username: String,
    pub password: String,
    pub from: String,
}

/// The `OPENGRID_EMAIL_PER_*` budgets, shown read-only (they are set by the environment only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct EmailBudgets {
    /// Invite and automation emails one user can cause per hour.
    pub per_user_hour: u32,
    /// Invite and automation emails the whole instance sends per hour on behalf of users.
    pub per_hour: u32,
}

/// `GET /api/admin/email` and the result of `PATCH /api/admin/email`: the effective settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct EmailSettings {
    /// Email features are on: a host is configured.
    pub enabled: bool,
    /// Where the host comes from: `environment`, `settings` or `unset` (email disabled).
    pub source: String,
    #[serde(default)]
    pub host: Option<String>,
    pub port: u16,
    /// `starttls` | `tls` | `none`
    pub security: String,
    #[serde(default)]
    pub username: Option<String>,
    /// Sender address, e.g. `OpenGrid <opengrid@example.com>`.
    pub from: String,
    /// A password is stored or provided by the environment. The password itself is never sent.
    pub password_set: bool,
    pub sources: EmailSources,
    pub budgets: EmailBudgets,
}

/// `PATCH /api/admin/email`. A field left out keeps its value. `null` or an empty string clears
/// `host` (switching email off unless the environment sets one) and `username`. For `password`:
/// a string replaces it, `null` removes it and an empty string or leaving it out keeps it.
/// Settings fixed by the environment cannot be changed (a value equal to the current one is
/// accepted and ignored). Changing the password is possible only when signed in, never with an
/// API token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateEmailSettings {
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub host: Option<Option<String>>,
    #[serde(default)]
    pub port: Option<u16>,
    /// `starttls` | `tls` | `none`
    #[serde(default)]
    pub security: Option<String>,
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub username: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub password: Option<Option<String>>,
    #[serde(default)]
    pub from: Option<String>,
}

/// `POST /api/admin/email/test`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SendTestEmail {
    /// Recipient; the administrator's own address when left out.
    #[serde(default)]
    pub to: Option<String>,
}

/// Result of `POST /api/admin/email/test`. A failed delivery is a normal answer (`ok: false`
/// with the server's own error text), not an HTTP error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct EmailTestResult {
    pub ok: bool,
    /// The address the message was sent to.
    pub to: String,
    /// What went wrong, as reported by the SMTP library or server; present when `ok` is false.
    #[serde(default)]
    pub error: Option<String>,
}
