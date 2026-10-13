//! Save-time validation of automations.
//!
//! Everything that can be checked without running the automation is checked
//! when it is saved, so mistakes surface as a 400 with a precise message
//! instead of as failed runs later: tables, fields and views exist in the
//! base; filters compile against the trigger table; actions are well formed;
//! templates parse and only use variables the trigger provides; URLs and
//! email addresses parse; cron expressions are valid and not too frequent.
//!
//! Validation also *canonicalizes*: field names used as keys of
//! create_record / update_record values are replaced by field ids, so
//! renaming a field later does not break the automation.

use std::collections::{BTreeMap, HashSet};
use std::str::FromStr;

use chrono::Utc;
use chrono_tz::Tz;
use og_core::api::automations::{Action, ActionStep, MAX_ACTIONS, Trigger};
use og_core::cell::{CellCtx, CellError, normalize};
use og_core::field::Field;
use og_core::query::compile_filter;
use og_core::view::ViewType;
use rusqlite::Connection;
use serde_json::Value as Json;
use url::Url;

use super::http::{self, MAX_HEADERS, MAX_REQUEST_BODY_BYTES};
use super::schedule;
use super::ssrf::is_forbidden_ip;
use super::template::{Template, TriggerShape, check_json};
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::perm;
use crate::store::schema;

/// Most recipients of one send_email action.
pub const MAX_RECIPIENTS: usize = 10;
/// Most users one notify action addresses.
pub const MAX_NOTIFY_USERS: usize = 50;
pub const MAX_MESSAGE_LEN: usize = 2_000;
pub const MAX_SUBJECT_LEN: usize = 500;
pub const MAX_EMAIL_BODY_LEN: usize = 100_000;
const MAX_VALUES_PER_ACTION: usize = 200;
const MAX_ACTIONS_JSON_BYTES: usize = 2 * 1024 * 1024;

/// A validated automation definition, ready to store.
#[derive(Debug, Clone)]
pub struct Validated {
    pub trigger: Trigger,
    pub actions: Vec<ActionStep>,
}

/// What the trigger offers actions: which template variables exist and which
/// table's record conditions are evaluated against.
struct TriggerInfo {
    shape: TriggerShape,
    fields: Option<Vec<Field>>,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::bad_request(msg)
}

/// Validate a whole definition for a base. `enabled` automations must have at
/// least one action.
pub fn validate(
    conn: &Connection,
    config: &Config,
    base_id: &str,
    trigger: &Trigger,
    actions: &[ActionStep],
    enabled: bool,
) -> AppResult<Validated> {
    if actions.len() > MAX_ACTIONS {
        return Err(bad(format!(
            "an automation can have at most {MAX_ACTIONS} actions"
        )));
    }
    if enabled && actions.is_empty() {
        return Err(bad(
            "add at least one action before turning the automation on",
        ));
    }
    let (trigger, info) = check_trigger(conn, base_id, trigger)?;
    let mut out = Vec::with_capacity(actions.len());
    for (i, step) in actions.iter().enumerate() {
        let step = check_step(conn, config, base_id, &info, i, step)
            .map_err(|e| prefix(e, &format!("action {}", i + 1)))?;
        out.push(step);
    }
    if serde_json::to_vec(&out)?.len() > MAX_ACTIONS_JSON_BYTES {
        return Err(bad("the actions are too large"));
    }
    Ok(Validated {
        trigger,
        actions: out,
    })
}

fn prefix(e: AppError, what: &str) -> AppError {
    match e {
        AppError::BadRequest(m) => AppError::BadRequest(format!("{what}: {m}")),
        other => other,
    }
}

// --------------------------------------------------------------- trigger

/// A live table of this base.
fn base_table(conn: &Connection, base_id: &str, table_id: &str) -> AppResult<()> {
    match schema::table_any(conn, table_id)? {
        Some(t) if t.deleted_at.is_none() && t.base_id == base_id => Ok(()),
        _ => Err(bad(format!("table {table_id} does not exist in this base"))),
    }
}

fn check_trigger(
    conn: &Connection,
    base_id: &str,
    trigger: &Trigger,
) -> AppResult<(Trigger, TriggerInfo)> {
    match trigger {
        Trigger::RecordCreated { table_id } => {
            base_table(conn, base_id, table_id)?;
            Ok((trigger.clone(), record_info(conn, table_id)?))
        }
        Trigger::RecordUpdated {
            table_id,
            field_ids,
        } => {
            base_table(conn, base_id, table_id)?;
            let fields = schema::table_fields(conn, table_id)?;
            let mut seen = HashSet::new();
            for id in field_ids {
                let f = fields.iter().find(|f| &f.id == id).ok_or_else(|| {
                    bad(format!("field {id} does not exist in the trigger table"))
                })?;
                if f.field_type().is_computed() {
                    return Err(bad(format!(
                        "field \"{}\" is computed; only editable fields can be watched",
                        f.name
                    )));
                }
                if !seen.insert(id) {
                    return Err(bad(format!("field {id} is listed twice")));
                }
            }
            Ok((
                trigger.clone(),
                TriggerInfo {
                    shape: TriggerShape::Record,
                    fields: Some(fields),
                },
            ))
        }
        Trigger::RecordMatches { table_id, filter } => {
            base_table(conn, base_id, table_id)?;
            let fields = schema::table_fields(conn, table_id)?;
            compile_filter(filter, &fields).map_err(|e| bad(format!("invalid filter: {e}")))?;
            Ok((
                trigger.clone(),
                TriggerInfo {
                    shape: TriggerShape::Record,
                    fields: Some(fields),
                },
            ))
        }
        Trigger::FormSubmitted { view_id } => {
            let view = schema::view_any(conn, view_id)?
                .filter(|v| v.deleted_at.is_none())
                .ok_or_else(|| bad(format!("view {view_id} does not exist in this base")))?;
            base_table(conn, base_id, &view.view.table_id)
                .map_err(|_| bad(format!("view {view_id} does not exist in this base")))?;
            if view.view.view_type != ViewType::Form {
                return Err(bad("the view must be a form view"));
            }
            Ok((trigger.clone(), record_info(conn, &view.view.table_id)?))
        }
        Trigger::Schedule { cron, timezone } => {
            let cron = cron.trim().to_string();
            let timezone = timezone.trim().to_string();
            schedule::validate(&cron, &timezone).map_err(bad)?;
            Ok((
                Trigger::Schedule { cron, timezone },
                TriggerInfo {
                    shape: TriggerShape::Schedule,
                    fields: None,
                },
            ))
        }
        Trigger::Webhook {} => Ok((
            trigger.clone(),
            TriggerInfo {
                shape: TriggerShape::Webhook,
                fields: None,
            },
        )),
    }
}

fn record_info(conn: &Connection, table_id: &str) -> AppResult<TriggerInfo> {
    Ok(TriggerInfo {
        shape: TriggerShape::Record,
        fields: Some(schema::table_fields(conn, table_id)?),
    })
}

// --------------------------------------------------------------- actions

fn check_step(
    conn: &Connection,
    config: &Config,
    base_id: &str,
    info: &TriggerInfo,
    index: usize,
    step: &ActionStep,
) -> AppResult<ActionStep> {
    if let Some(filter) = &step.condition {
        let fields = info.fields.as_ref().ok_or_else(|| {
            bad("conditions need a record or form trigger (there is no record to test)")
        })?;
        compile_filter(filter, fields).map_err(|e| bad(format!("invalid condition: {e}")))?;
    }
    let shape = info.shape;
    let action = match &step.action {
        Action::CreateRecord { table_id, values } => {
            base_table(conn, base_id, table_id)?;
            let fields = schema::table_fields(conn, table_id)?;
            Action::CreateRecord {
                table_id: table_id.clone(),
                values: canonical_values(&fields, values, shape, index)?,
            }
        }
        Action::UpdateRecord {
            table_id,
            record_id,
            values,
        } => {
            base_table(conn, base_id, table_id)?;
            let fields = schema::table_fields(conn, table_id)?;
            let record_id = record_id.trim().to_string();
            if record_id.is_empty() {
                return Err(bad(
                    "record_id is required (for example {{trigger.record.id}})",
                ));
            }
            template(&record_id, shape, index, "record_id")?;
            if values.is_empty() {
                return Err(bad("choose at least one field to update"));
            }
            Action::UpdateRecord {
                table_id: table_id.clone(),
                record_id,
                values: canonical_values(&fields, values, shape, index)?,
            }
        }
        Action::SendEmail { to, subject, body } => {
            if !config.email_enabled() {
                return Err(bad(
                    "email is not configured on this server (set OPENGRID_SMTP_HOST)",
                ));
            }
            let to = to.trim().to_string();
            let t = template(&to, shape, index, "to")?;
            if t.is_literal() {
                let list = split_recipients(&to);
                if list.is_empty() {
                    return Err(bad("at least one recipient is required"));
                }
                check_recipients(&list)?;
            } else if to.is_empty() {
                return Err(bad("at least one recipient is required"));
            }
            if subject.trim().is_empty() {
                return Err(bad("the subject is required"));
            }
            if subject.chars().count() > MAX_SUBJECT_LEN {
                return Err(bad(format!(
                    "the subject is too long (max {MAX_SUBJECT_LEN} characters)"
                )));
            }
            template(subject, shape, index, "subject")?;
            if body.chars().count() > MAX_EMAIL_BODY_LEN {
                return Err(bad(format!(
                    "the body is too long (max {MAX_EMAIL_BODY_LEN} characters)"
                )));
            }
            template(body, shape, index, "body")?;
            Action::SendEmail {
                to,
                subject: subject.clone(),
                body: body.clone(),
            }
        }
        Action::HttpRequest {
            method,
            url,
            headers,
            body,
        } => {
            check_url(url.trim(), config, shape, index)?;
            if headers.len() > MAX_HEADERS {
                return Err(bad(format!("at most {MAX_HEADERS} headers are allowed")));
            }
            let mut seen = HashSet::new();
            for (name, value) in headers {
                let name = name.trim();
                if !seen.insert(name.to_ascii_lowercase()) {
                    return Err(bad(format!("header \"{name}\" is listed twice")));
                }
                http::check_header(name, value).map_err(bad)?;
                template(value, shape, index, &format!("header {name}"))?;
            }
            if let Some(b) = body {
                if b.len() > MAX_REQUEST_BODY_BYTES {
                    return Err(bad("the request body is too large"));
                }
                if *method == og_core::api::automations::HttpMethod::Get && !b.is_empty() {
                    return Err(bad("a GET request cannot have a body"));
                }
                template(b, shape, index, "body")?;
            }
            Action::HttpRequest {
                method: *method,
                url: url.trim().to_string(),
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.trim().to_string(), v.clone()))
                    .collect(),
                body: body.clone().filter(|b| !b.is_empty()),
            }
        }
        Action::Notify { user_ids, message } => {
            if user_ids.is_empty() {
                return Err(bad("choose at least one user to notify"));
            }
            if user_ids.len() > MAX_NOTIFY_USERS {
                return Err(bad(format!(
                    "at most {MAX_NOTIFY_USERS} users can be notified"
                )));
            }
            let mut seen = HashSet::new();
            for u in user_ids {
                if !seen.insert(u) {
                    return Err(bad(format!("user {u} is listed twice")));
                }
                if perm::base_role(conn, u, base_id)?.is_none() {
                    return Err(bad(format!("user {u} does not have access to this base")));
                }
            }
            if message.trim().is_empty() {
                return Err(bad("the message is required"));
            }
            if message.chars().count() > MAX_MESSAGE_LEN {
                return Err(bad(format!(
                    "the message is too long (max {MAX_MESSAGE_LEN} characters)"
                )));
            }
            template(message, shape, index, "message")?;
            step.action.clone()
        }
    };
    Ok(ActionStep {
        condition: step.condition.clone(),
        action,
    })
}

fn template(src: &str, shape: TriggerShape, index: usize, what: &str) -> AppResult<Template> {
    let t = Template::parse(src).map_err(|e| bad(format!("{what}: {e}")))?;
    t.check(shape, index)
        .map_err(|e| bad(format!("{what}: {e}")))?;
    Ok(t)
}

fn check_url(raw: &str, config: &Config, shape: TriggerShape, index: usize) -> AppResult<()> {
    if raw.is_empty() {
        return Err(bad("the URL is required"));
    }
    let t = template(raw, shape, index, "url")?;
    let prefix = t.literal_prefix().to_ascii_lowercase();
    if !(prefix.starts_with("http://") || prefix.starts_with("https://")) {
        return Err(bad("the URL must start with http:// or https://"));
    }
    let url = Url::parse(&t.with_filler("x")).map_err(|e| bad(format!("invalid URL: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad(
            "URLs with a user name or password are not allowed; use an Authorization header",
        ));
    }
    if t.is_literal() && !config.allow_private_webhooks {
        // Immediate feedback for the obvious cases; DNS-based checks happen at run time.
        match url.host() {
            Some(url::Host::Ipv4(ip)) if is_forbidden_ip(ip.into()) => {
                return Err(bad(format!(
                    "requests to private, loopback or link-local addresses are not allowed ({ip})"
                )));
            }
            Some(url::Host::Ipv6(ip)) if is_forbidden_ip(ip.into()) => {
                return Err(bad(format!(
                    "requests to private, loopback or link-local addresses are not allowed ({ip})"
                )));
            }
            Some(url::Host::Domain(d))
                if d.eq_ignore_ascii_case("localhost")
                    || d.to_ascii_lowercase().ends_with(".localhost") =>
            {
                return Err(bad("requests to localhost are not allowed"));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Split a `to` field into addresses (comma or semicolon separated).
pub fn split_recipients(to: &str) -> Vec<String> {
    to.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Check an already-split list of addresses.
pub fn check_recipients(list: &[String]) -> AppResult<()> {
    if list.len() > MAX_RECIPIENTS {
        return Err(bad(format!(
            "at most {MAX_RECIPIENTS} recipients are allowed"
        )));
    }
    for addr in list {
        if addr.len() > 254 || lettre::Address::from_str(addr).is_err() {
            return Err(bad(format!("\"{addr}\" is not a valid email address")));
        }
    }
    Ok(())
}

/// Find a field by id, then exact name, then case-insensitive name.
pub fn resolve_field<'a>(fields: &'a [Field], key: &str) -> Option<&'a Field> {
    let key = key.trim();
    fields
        .iter()
        .find(|f| f.id == key)
        .or_else(|| fields.iter().find(|f| f.name == key))
        .or_else(|| {
            let lower = key.to_lowercase();
            fields.iter().find(|f| f.name.to_lowercase() == lower)
        })
}

/// Re-key `values` by field id, check templates, and type-check literal values.
fn canonical_values(
    fields: &[Field],
    values: &BTreeMap<String, Json>,
    shape: TriggerShape,
    index: usize,
) -> AppResult<BTreeMap<String, Json>> {
    if values.len() > MAX_VALUES_PER_ACTION {
        return Err(bad("too many field values"));
    }
    let ctx = CellCtx::new(Utc::now(), Tz::UTC).with_typecast(true);
    let mut out = BTreeMap::new();
    for (key, value) in values {
        let field = resolve_field(fields, key)
            .ok_or_else(|| bad(format!("unknown field \"{key}\" in the values")))?;
        if field.field_type().is_computed() {
            return Err(bad(format!(
                "field \"{}\" is computed and cannot be set",
                field.name
            )));
        }
        check_json(value, shape, index)
            .map_err(|e| bad(format!("field \"{}\": {e}", field.name)))?;
        if !has_placeholder(value) {
            match normalize(field, value, &ctx) {
                Ok(_) | Err(CellError::UnknownChoice(_)) => {}
                Err(e) => return Err(bad(format!("field \"{}\": {e}", field.name))),
            }
        }
        if out.insert(field.id.clone(), value.clone()).is_some() {
            return Err(bad(format!(
                "field \"{}\" is given more than once",
                field.name
            )));
        }
    }
    Ok(out)
}

fn has_placeholder(v: &Json) -> bool {
    match v {
        Json::String(s) => s.contains("{{"),
        Json::Array(a) => a.iter().any(has_placeholder),
        Json::Object(o) => o.values().any(has_placeholder),
        _ => false,
    }
}
