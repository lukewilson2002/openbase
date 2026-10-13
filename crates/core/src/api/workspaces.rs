//! DTOs for workspaces, bases and membership.

use serde::{Deserialize, Serialize};

/// Roles as strings on the wire: viewer | commenter | editor | creator | owner.
pub type RoleName = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct BaseSummary {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub color: String,
    /// Lucide icon name (kebab-case); the client falls back to the name's initial.
    #[serde(default)]
    pub icon: Option<String>,
    /// Caller's effective role on the base.
    pub role: RoleName,
}

/// `GET /api/workspaces` item. Bases shared with the caller directly (base
/// membership without workspace membership) appear under their workspace
/// with `role: None` on the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    /// Lucide icon name (kebab-case); the client falls back to the name's initial.
    #[serde(default)]
    pub icon: Option<String>,
    /// Caller's workspace role; None when only individual bases are shared.
    #[serde(default)]
    pub role: Option<RoleName>,
    pub bases: Vec<BaseSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateWorkspace {
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateWorkspace {
    #[serde(default)]
    pub name: Option<String>,
    /// Lucide icon name (kebab-case). Absent = unchanged, `null` = clear.
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub icon: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateBase {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateBase {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Lucide icon name (kebab-case). Absent = unchanged, `null` = clear.
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct DuplicateBase {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub include_records: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Member {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: RoleName,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateMember {
    pub role: RoleName,
}

/// Someone who can see a base (for user fields and @mentions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Collaborator {
    pub id: String,
    pub name: String,
    pub email: String,
}
