//! DTOs for a workspace's Home (`GET /api/workspaces/{id}/home`): what is due soon, what changed
//! lately and the caller's inbox drafts, in one response.

use serde::{Deserialize, Serialize};

use super::history::ActivityAuthor;
use super::inbox::InboxItem;

/// `GET /api/workspaces/{id}/home`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct HomeResponse {
    /// Today in the caller's time zone (`YYYY-MM-DD`): the day `overdue` and the window of `due`
    /// count from.
    pub today: String,
    /// The caller's time zone (an IANA name; UTC when none is set).
    pub timezone: String,
    /// Records dated from 30 days ago to 7 days ahead by their collection's Home date, not marked
    /// done, oldest first, at most 50.
    pub due: Vec<HomeDue>,
    /// True when the scan budget ran out: some collections were not checked, so `due` may miss
    /// records.
    pub truncated: bool,
    /// The 10 records most recently created or edited that the caller can open, newest first.
    pub recent: Vec<HomeRecent>,
    /// The caller's inbox drafts (they belong to the person, not to a workspace), most recently
    /// changed first. Empty for a token limited to some projects: the inbox is in no project.
    pub drafts: Vec<InboxItem>,
}

/// A record that is due soon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct HomeDue {
    pub record_id: String,
    pub table_id: String,
    /// The project (folder) the collection is in.
    pub base_id: String,
    pub base_name: String,
    /// The text of the record's primary field.
    pub title: String,
    pub table_name: String,
    pub table_color: String,
    /// The calendar day in the caller's time zone (`YYYY-MM-DD`), or in the date property's own
    /// zone when it has a fixed one.
    pub date: String,
    /// Whether the date has a time of day.
    pub has_time: bool,
    /// The time of day on `date` (`HH:MM`, 24 hours); null when `has_time` is false.
    #[serde(default)]
    pub time: Option<String>,
    /// Whether the collection has a Done property. When it does, `done_field_id` names it, and
    /// checking it takes the record off Home.
    pub has_done: bool,
    #[serde(default)]
    pub done_field_id: Option<String>,
    /// `date` is before `today`.
    pub overdue: bool,
    /// Whether the caller may edit records of the collection (the Done checkbox is enabled).
    pub can_edit: bool,
}

/// A record that changed lately.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct HomeRecent {
    pub record_id: String,
    pub table_id: String,
    pub base_id: String,
    pub base_name: String,
    pub title: String,
    pub table_name: String,
    pub table_color: String,
    /// What the latest change was: create | update | restore.
    pub kind: String,
    /// Who made it; null when the account is gone or an automation did it.
    #[serde(default)]
    pub author: Option<ActivityAuthor>,
    /// When, in Unix milliseconds.
    pub at: i64,
}
