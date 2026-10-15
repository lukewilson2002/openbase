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
    /// Caller's role on the base (their workspace role).
    pub role: RoleName,
    /// Who can open this base: workspace members with access to it, then
    /// pending invites that would give access to it.
    pub people: Vec<BasePerson>,
}

/// Someone who can open a base, or will once they accept their invite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct BasePerson {
    /// None for a pending invite.
    #[serde(default)]
    pub user_id: Option<String>,
    /// The member's name; for a pending invite, the invited email.
    pub name: String,
    /// Empty for a pending invite that is not restricted to an address.
    pub email: String,
    pub pending: bool,
    pub role: RoleName,
}

/// `GET /api/workspaces` item: a workspace the caller is a member of, with
/// the bases they can open.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    /// Lucide icon name (kebab-case); the client falls back to the name's initial.
    #[serde(default)]
    pub icon: Option<String>,
    /// One of `ob_core::field::COLORS`, like a base's colour.
    pub color: String,
    /// Caller's workspace role.
    pub role: RoleName,
    pub bases: Vec<BaseSummary>,
    pub member_count: i64,
    /// Unaccepted, unexpired invites to the workspace.
    pub pending_invite_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateWorkspace {
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// One of `ob_core::field::COLORS`. Absent: the first of the default
    /// workspace colours the creator is not using yet.
    #[serde(default)]
    pub color: Option<String>,
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
    /// One of `ob_core::field::COLORS`; absent or null leaves it unchanged.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateBase {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// `true` creates the base without tables; by default it starts with
    /// "Table 1" (fields Name and Notes, a grid view).
    #[serde(default)]
    pub empty: Option<bool>,
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
    /// Whether the member can open every base of the workspace, including
    /// bases created later. Always true for owners.
    pub all_bases: bool,
    /// The bases a member without `all_bases` can open (empty otherwise).
    pub base_ids: Vec<String>,
}

/// `PATCH /api/workspaces/{id}/members/{user_id}`; absent fields are unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateMember {
    #[serde(default)]
    pub role: Option<RoleName>,
    #[serde(default)]
    pub all_bases: Option<bool>,
    /// The bases the member can open; setting it turns `all_bases` off unless
    /// `all_bases: true` is sent too.
    #[serde(default)]
    pub base_ids: Option<Vec<String>>,
}

/// Someone who can see a base (for user fields and @mentions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Collaborator {
    pub id: String,
    pub name: String,
    pub email: String,
}
