//! DTOs for the automations API.
//!
//! An automation is one trigger plus an ordered list of actions. The same
//! [`Trigger`] / [`ActionStep`] JSON is what the API accepts and what the
//! server stores in the `automations` table.
//!
//! **Templates.** Every string an action sends somewhere (record values,
//! recipients, subjects, bodies, URLs, header values, notification messages,
//! the `record_id` of `update_record`) may contain `{{...}}` placeholders that
//! are substituted as plain text before the action runs:
//!
//! | placeholder                           | value                                                    |
//! |---------------------------------------|----------------------------------------------------------|
//! | `{{trigger.type}}`                    | the trigger kind, e.g. `record_created`                  |
//! | `{{trigger.time}}`                    | when the event happened (RFC 3339, UTC)                  |
//! | `{{trigger.record.id}}`               | id of the record that fired the trigger                  |
//! | `{{trigger.record.table_id}}`         | its table                                                |
//! | `{{trigger.record.fields.<field>}}`   | a field's display text; `<field>` is a field id or name  |
//! | `{{trigger.body.<path>}}`             | webhook JSON body; `a.b.0.c` walks objects and arrays    |
//! | `{{steps.<n>.<key>}}`                 | output of the n-th action (1-based) of this run          |
//!
//! Step outputs: `create_record` and `update_record` give `record_id` (and
//! `table_id`); `http_request` gives `status`, `body` (text, at most 256 KB)
//! and `json` (the parsed body, when it is JSON); `send_email` gives `sent_to`;
//! `notify` gives `notified`. Unknown or missing values render as an empty
//! string. Only the listed variables exist: templates never run code.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::view::Filter;

/// At most this many actions per automation.
pub const MAX_ACTIONS: usize = 25;
/// Scheduled automations may not fire more often than this.
pub const MIN_SCHEDULE_INTERVAL_SECS: i64 = 300;

/// What starts an automation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    /// A record was created in `table_id` (by a person, a form, the API or
    /// an import; never by an automation).
    RecordCreated { table_id: String },
    /// A record in `table_id` was updated. With `field_ids` empty any
    /// editable field counts; otherwise at least one of them must change.
    RecordUpdated {
        table_id: String,
        #[serde(default)]
        field_ids: Vec<String>,
    },
    /// A record in `table_id` started matching `filter`: it was created
    /// matching, or an update turned it from not matching into matching.
    RecordMatches { table_id: String, filter: Filter },
    /// A public form (a form view) was submitted.
    FormSubmitted { view_id: String },
    /// Fires on a cron schedule (5 fields, or 6 with leading seconds), in an
    /// IANA time zone, at most every 5 minutes.
    Schedule { cron: String, timezone: String },
    /// `POST /api/hooks/{token}` with a JSON body of up to 1 MB. The token is
    /// shown once, when the automation is created (or the token is rotated).
    Webhook {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub enum HttpMethod {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
    #[serde(rename = "PUT")]
    Put,
    #[serde(rename = "PATCH")]
    Patch,
    #[serde(rename = "DELETE")]
    Delete,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Patch => "PATCH",
            HttpMethod::Delete => "DELETE",
        }
    }
}

/// What an automation does. Strings support templates (see the module docs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Create a record in `table_id` (a table of the same base). `values` is
    /// keyed by field id or field name and written leniently (typecast).
    CreateRecord {
        table_id: String,
        #[serde(default)]
        values: BTreeMap<String, Json>,
    },
    /// Update the record `record_id` (a template, e.g.
    /// `{{trigger.record.id}}` or `{{steps.1.record_id}}`) of `table_id`.
    UpdateRecord {
        table_id: String,
        record_id: String,
        #[serde(default)]
        values: BTreeMap<String, Json>,
    },
    /// Send a plain-text email. `to` is one address or a comma-separated
    /// list (at most 10). Needs SMTP to be configured on the server.
    SendEmail {
        to: String,
        subject: String,
        body: String,
    },
    /// Call an external URL. Only http(s); private, loopback and link-local
    /// addresses are refused unless the server operator allows them.
    HttpRequest {
        method: HttpMethod,
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        body: Option<String>,
    },
    /// Send an in-app notification to these users (who must have access to
    /// the base).
    Notify {
        user_ids: Vec<String>,
        message: String,
    },
}

impl Action {
    /// The snake_case action name used in run logs.
    pub fn kind(&self) -> &'static str {
        match self {
            Action::CreateRecord { .. } => "create_record",
            Action::UpdateRecord { .. } => "update_record",
            Action::SendEmail { .. } => "send_email",
            Action::HttpRequest { .. } => "http_request",
            Action::Notify { .. } => "notify",
        }
    }
}

/// One action plus its optional condition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActionStep {
    /// Evaluated against the record that fired the trigger (only for record
    /// and form triggers); the action is skipped when it does not match.
    #[serde(default)]
    pub condition: Option<Filter>,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Automation {
    pub id: String,
    pub base_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub actions: Vec<ActionStep>,
    /// Next scheduled run (schedule triggers of enabled automations).
    #[serde(default)]
    pub next_run_at: Option<i64>,
    /// Set only in the response that created the webhook token (create, or
    /// after `rotate_webhook_token`). It cannot be recovered later: only its
    /// hash is stored. Post to `/api/hooks/{webhook_token}`.
    #[serde(default)]
    pub webhook_token: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateAutomation {
    pub name: String,
    /// New automations are off unless asked otherwise.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub enabled: bool,
    pub trigger: Trigger,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<Vec<ActionStep>>", optional))]
    pub actions: Vec<ActionStep>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateAutomation {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Replaces the trigger.
    #[serde(default)]
    pub trigger: Option<Trigger>,
    /// Replaces all actions.
    #[serde(default)]
    pub actions: Option<Vec<ActionStep>>,
    /// Webhook triggers only: issue a new token (the old one stops working)
    /// and return it once in the response.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub rotate_webhook_token: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Succeeded,
    Failed,
    /// The action's condition did not match.
    Skipped,
}

/// One line of a run's log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct StepLog {
    /// 0-based position of the action; absent for system lines (`recovery`).
    #[serde(default)]
    pub index: Option<u32>,
    /// Action kind (`create_record`, ...) or `recovery`.
    pub action: String,
    pub status: StepStatus,
    /// Run attempt this line belongs to (1-based).
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub output: Option<Json>,
    #[serde(default)]
    pub error: Option<String>,
    pub duration_ms: i64,
    /// Set on a failed line that will be retried: not before this time.
    #[serde(default)]
    pub retry_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AutomationRun {
    pub id: i64,
    pub automation_id: String,
    pub status: RunStatus,
    /// What fired the run: `{type, time, record?, body?, ...}`.
    pub trigger_data: Json,
    pub log: Vec<StepLog>,
    #[serde(default)]
    pub error: Option<String>,
    pub attempts: u32,
    pub created_at: i64,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
}

/// `GET /api/automations/{id}/runs`: newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct RunsPage {
    pub runs: Vec<AutomationRun>,
    /// All runs of the automation.
    pub total: i64,
    /// Pass as `before` to fetch the next (older) page; absent on the last page.
    #[serde(default)]
    pub next_before: Option<i64>,
}

/// `POST /api/automations/{id}/test`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TestAutomation {
    /// Record to use as the trigger record; default: the table's first record.
    #[serde(default)]
    pub record_id: Option<String>,
    /// Sample body for webhook triggers.
    #[serde(default)]
    pub body: Option<Json>,
    /// Default true: render templates and evaluate conditions but send,
    /// write and request nothing. Pass false to really run the actions once.
    #[serde(default = "default_true")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub dry_run: bool,
}

fn default_true() -> bool {
    true
}

impl Default for TestAutomation {
    fn default() -> Self {
        TestAutomation {
            record_id: None,
            body: None,
            dry_run: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TestResult {
    pub dry_run: bool,
    /// `succeeded` or `failed`.
    pub status: RunStatus,
    pub log: Vec<StepLog>,
    #[serde(default)]
    pub error: Option<String>,
    /// The recorded run (real runs only).
    #[serde(default)]
    pub run_id: Option<i64>,
}

/// `POST /api/hooks/{token}` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct WebhookAccepted {
    pub ok: bool,
    pub run_id: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trigger_and_action_wire_shapes() {
        let t: Trigger = serde_json::from_value(json!({"type":"webhook"})).unwrap();
        assert_eq!(t, Trigger::Webhook {});
        let t: Trigger =
            serde_json::from_value(json!({"type":"record_updated","table_id":"tbl1"})).unwrap();
        assert_eq!(
            t,
            Trigger::RecordUpdated {
                table_id: "tbl1".into(),
                field_ids: vec![]
            }
        );
        let s: ActionStep = serde_json::from_value(json!({
            "type":"http_request","method":"POST","url":"https://x.test/","condition":
            {"conjunction":"and","items":[]}
        }))
        .unwrap();
        assert!(s.condition.is_some());
        assert_eq!(s.action.kind(), "http_request");
        assert_eq!(serde_json::to_value(&s).unwrap()["method"], json!("POST"));
        assert!(
            serde_json::from_value::<ActionStep>(json!({"type":"run_script","code":"x"})).is_err()
        );
    }

    #[test]
    fn test_request_defaults_to_dry_run() {
        let t: TestAutomation = serde_json::from_value(json!({})).unwrap();
        assert!(t.dry_run);
        let t: TestAutomation = serde_json::from_value(json!({"dry_run": false})).unwrap();
        assert!(!t.dry_run);
    }
}
