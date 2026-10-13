//! Automations: a trigger plus ordered actions. Tables, fields and views in triggers and
//! conditions may be given by name; everything else is the REST API's own shape (see
//! docs/automations.md), and the calls run through the REST API as the caller.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::resolve::{Mode, Xlate, field_lookup, find_table, find_view, load_schema};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use ob_core::api::schema::{BaseSchema, Table};

const TRIGGER_HELP: &str = "What starts it, by `type`: record_created {table}; record_updated {table, field_ids?: [field names; empty = any field]}; record_matches {table, filter: {conjunction, items: [{field_id: <field name>, op, value}]}} (fires when a record starts matching); form_submitted {view: <form view name or id>}; schedule {cron: '0 9 * * 1-5' (5 fields), timezone: IANA zone, at most every 5 minutes}; webhook {} (the token is returned once on create). `table` accepts a name or id.";
const ACTIONS_HELP: &str = "Ordered list (max 25) of {type, ..., condition?}: create_record {table, values: {field name: value}}; update_record {table, record_id, values}; send_email {to, subject, body} (needs SMTP); http_request {method, url, headers?, body?} (public http(s) URLs only); notify {user_ids: [..], message}. Text may use templates: {{trigger.record.id}}, {{trigger.record.fields.<field name>}}, {{trigger.body.<path>}}, {{steps.<n>.record_id}}. `condition` is a filter ({conjunction, items}) on the triggering record; the action is skipped when it does not match.";

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "list_automations",
            "List automations",
            "List a base's automations (name, enabled, trigger, actions, next scheduled run). Needs the creator role.",
            object(json!({ "base_id": string(BASE_ID) }), &["base_id"]),
        ),
        ToolDef::new(
            "get_automation",
            "Get an automation",
            "Get one automation with its trigger and actions. Needs the creator role.",
            object(
                json!({ "automation_id": string("Automation id (from list_automations).") }),
                &["automation_id"],
            ),
        ),
        ToolDef::new(
            "create_automation",
            "Create an automation",
            "Create an automation: one trigger and up to 25 actions. It is off unless enabled=true. Webhook automations return their secret token once. Use test_automation (dry run) to check it. Needs the creator role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "name": string("Automation name."),
                    "enabled": boolean("Turn it on right away (default false)."),
                    "trigger": free_object(TRIGGER_HELP),
                    "actions": json!({
                        "type": "array",
                        "items": { "type": "object" },
                        "description": ACTIONS_HELP,
                    }),
                }),
                &["base_id", "name", "trigger", "actions"],
            ),
        )
        .write(),
        ToolDef::new(
            "update_automation",
            "Update an automation",
            "Enable or disable an automation, rename it, or replace its trigger and/or all its actions. Webhook automations can rotate their token (returned once). Needs the creator role.",
            object(
                json!({
                    "automation_id": string("Automation id."),
                    "name": string("New name."),
                    "enabled": boolean("Turn it on or off."),
                    "trigger": free_object("Replaces the trigger; same shape as create_automation's `trigger`."),
                    "actions": json!({
                        "type": "array",
                        "items": { "type": "object" },
                        "description": "Replaces ALL actions; same shape as create_automation's `actions`.",
                    }),
                    "rotate_webhook_token": boolean("Webhook triggers: issue a new token (the old one stops working)."),
                }),
                &["automation_id"],
            ),
        )
        .write()
        .idempotent(),
        ToolDef::new(
            "delete_automation",
            "Delete an automation",
            "Delete an automation and its run history for good. Needs the creator role.",
            object(
                json!({ "automation_id": string("Automation id.") }),
                &["automation_id"],
            ),
        )
        .write()
        .destructive(),
        ToolDef::new(
            "test_automation",
            "Test an automation",
            "Run an automation once against a record (default: the table's first record) or a sample webhook body. By default a DRY RUN: templates are rendered and conditions evaluated but nothing is created, sent or requested. With dry_run=false the actions really run once. Returns the step-by-step log. Needs the creator role.",
            object(
                json!({
                    "automation_id": string("Automation id."),
                    "record_id": string("Record to use as the trigger record."),
                    "body": free_object("Sample JSON body for webhook triggers."),
                    "dry_run": boolean("Default true. false = really run the actions."),
                }),
                &["automation_id"],
            ),
        )
        .write(),
        ToolDef::new(
            "list_automation_runs",
            "List automation runs",
            "The run history of an automation, newest first: status, trigger data and the log of each action (output or error). Use it to verify an automation ran. Needs the editor role.",
            object(
                json!({
                    "automation_id": string("Automation id."),
                    "limit": integer("Runs to return (default 20, max 100).", 1, 100),
                    "before": integer("The `next_before` of a previous result, for older runs.", 1, i64::MAX as u64),
                }),
                &["automation_id"],
            ),
        ),
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
    match name {
        "list_automations" => with_args!(BaseArg, list_automations),
        "get_automation" => with_args!(AutomationArg, get_automation),
        "create_automation" => with_args!(CreateAutomation, create_automation),
        "update_automation" => with_args!(UpdateAutomation, update_automation),
        "delete_automation" => with_args!(AutomationArg, delete_automation),
        "test_automation" => with_args!(TestAutomation, test_automation),
        "list_automation_runs" => with_args!(RunsArgs, list_runs),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseArg {
    base_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AutomationArg {
    automation_id: String,
}

fn automation_path(id: &str, rest: &str) -> String {
    format!("/api/automations/{}{rest}", encode_segment(id))
}

async fn list_automations(ctx: &McpCtx, a: BaseArg) -> ToolResult {
    fetch_as(
        ctx,
        "GET",
        &base_path(&a.base_id, "/automations"),
        None,
        None,
        "automations",
    )
    .await
}

async fn get_automation(ctx: &McpCtx, a: AutomationArg) -> ToolResult {
    fetch_as(
        ctx,
        "GET",
        &automation_path(&a.automation_id, ""),
        None,
        None,
        "automation",
    )
    .await
}

// -------------------------------------------------------------------- name translation

/// A table reference given as `table_id` or the alias `table`, translated to the id.
fn table_ref<'a>(
    schema: &'a BaseSchema,
    obj: &mut Map<String, Value>,
    what: &str,
) -> Result<&'a Table, String> {
    let alias = obj.remove("table");
    let raw = obj
        .remove("table_id")
        .filter(|v| !v.is_null())
        .or(alias)
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| format!("{what} needs a `table` (a table name or id)"))?;
    let table = find_table(schema, &raw).map_err(|e| e.text)?;
    obj.insert("table_id".into(), json!(table.id));
    Ok(table)
}

fn filter_to_ids(table: &Table, filter: &mut Value) -> Result<(), String> {
    let mut wrapper = json!({ "filter": filter.take() });
    let x = Xlate {
        table,
        mode: Mode::ToIds,
    };
    let res = x.config(&mut wrapper);
    *filter = wrapper["filter"].take();
    res
}

/// Translate a trigger; returns the table it watches (for action conditions).
fn trigger_to_ids<'a>(
    schema: &'a BaseSchema,
    trigger: &mut Value,
) -> Result<Option<&'a Table>, String> {
    let Some(obj) = trigger.as_object_mut() else {
        return Err("trigger must be an object with a `type`".into());
    };
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "trigger needs a `type`: record_created, record_updated, record_matches, form_submitted, schedule or webhook".to_string()
        })?
        .to_string();
    match kind.as_str() {
        "record_created" | "record_updated" | "record_matches" => {
            let table = table_ref(schema, obj, &format!("a {kind} trigger"))?;
            if let Some(Value::Array(ids)) = obj.get_mut("field_ids") {
                for id in ids {
                    if let Value::String(s) = id {
                        *s = field_lookup(table, s)?.id.clone();
                    }
                }
            }
            if let Some(filter) = obj.get_mut("filter") {
                filter_to_ids(table, filter)?;
            }
            Ok(Some(table))
        }
        "form_submitted" => {
            let alias = obj.remove("view");
            let raw = obj
                .remove("view_id")
                .filter(|v| !v.is_null())
                .or(alias)
                .and_then(|v| v.as_str().map(str::to_string))
                .ok_or("a form_submitted trigger needs a `view` (a form view name or id)")?;
            let (table, view) = find_view(schema, None, &raw).map_err(|e| e.text)?;
            obj.insert("view_id".into(), json!(view.id));
            Ok(Some(table))
        }
        "schedule" | "webhook" => Ok(None),
        other => Err(format!(
            "unknown trigger type '{other}'. Types: record_created, record_updated, record_matches, form_submitted, schedule, webhook."
        )),
    }
}

fn actions_to_ids(
    schema: &BaseSchema,
    trigger_table: Option<&Table>,
    actions: &mut Value,
) -> Result<(), String> {
    let Some(list) = actions.as_array_mut() else {
        return Err("actions must be a list".into());
    };
    for (i, step) in list.iter_mut().enumerate() {
        let Some(obj) = step.as_object_mut() else {
            return Err(format!("action {} must be an object with a `type`", i + 1));
        };
        let kind = obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if matches!(kind.as_str(), "create_record" | "update_record") {
            table_ref(schema, obj, &format!("action {} ({kind})", i + 1))?;
        }
        if let Some(cond) = obj.get_mut("condition")
            && !cond.is_null()
        {
            let Some(table) = trigger_table else {
                return Err(format!(
                    "action {} has a condition, but conditions only work with record and form triggers",
                    i + 1
                ));
            };
            filter_to_ids(table, cond)?;
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------- mutations

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateAutomation {
    base_id: String,
    name: String,
    #[serde(default)]
    enabled: Option<bool>,
    trigger: Value,
    actions: Value,
}

async fn create_automation(ctx: &McpCtx, a: CreateAutomation) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (mut trigger, mut actions) = (a.trigger, a.actions);
    let table = match trigger_to_ids(&schema, &mut trigger) {
        Ok(t) => t,
        Err(e) => return ToolResult::error(e),
    };
    if let Err(e) = actions_to_ids(&schema, table, &mut actions) {
        return ToolResult::error(e);
    }
    let body = json!({
        "name": a.name,
        "enabled": a.enabled.unwrap_or(false),
        "trigger": trigger,
        "actions": actions,
    });
    match fetch(
        ctx,
        "POST",
        &base_path(&a.base_id, "/automations"),
        None,
        Some(body),
    )
    .await
    {
        Ok(v) => {
            let mut out = json!({ "automation": v });
            if v.get("webhook_token").is_some_and(|t| !t.is_null()) {
                out["note"] = json!(
                    "The webhook token is shown only now. POST JSON to /api/hooks/<webhook_token> to trigger it."
                );
            }
            ToolResult::ok(out)
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateAutomation {
    automation_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    trigger: Option<Value>,
    #[serde(default)]
    actions: Option<Value>,
    #[serde(default)]
    rotate_webhook_token: Option<bool>,
}

async fn update_automation(ctx: &McpCtx, a: UpdateAutomation) -> ToolResult {
    let mut body = Map::new();
    if let Some(n) = a.name {
        body.insert("name".into(), json!(n));
    }
    if let Some(e) = a.enabled {
        body.insert("enabled".into(), json!(e));
    }
    if a.rotate_webhook_token == Some(true) {
        body.insert("rotate_webhook_token".into(), json!(true));
    }
    if a.trigger.is_some() || a.actions.is_some() {
        // Names need the base: read the automation (this also checks the caller may see it).
        let current = match fetch(
            ctx,
            "GET",
            &automation_path(&a.automation_id, ""),
            None,
            None,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return e,
        };
        let Some(base_id) = current["base_id"].as_str() else {
            return ToolResult::error("could not determine the base of the automation");
        };
        let schema = match load_schema(ctx, base_id).await {
            Ok(s) => s,
            Err(e) => return e,
        };
        let mut trigger_table: Option<&Table> = None;
        if let Some(mut trigger) = a.trigger {
            match trigger_to_ids(&schema, &mut trigger) {
                Ok(t) => trigger_table = t,
                Err(e) => return ToolResult::error(e),
            }
            body.insert("trigger".into(), trigger);
        } else {
            // Conditions of replaced actions refer to the table of the unchanged trigger.
            let mut existing = current["trigger"].clone();
            if let Ok(t) = trigger_table_of(&schema, &mut existing) {
                trigger_table = t;
            }
        }
        if let Some(mut actions) = a.actions {
            if let Err(e) = actions_to_ids(&schema, trigger_table, &mut actions) {
                return ToolResult::error(e);
            }
            body.insert("actions".into(), actions);
        }
    }
    if body.is_empty() {
        return ToolResult::error(
            "Give something to change: name, enabled, trigger, actions or rotate_webhook_token.",
        );
    }
    match fetch(
        ctx,
        "PATCH",
        &automation_path(&a.automation_id, ""),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(json!({ "automation": v })),
        Err(e) => e,
    }
}

/// The table an existing (id-based) trigger watches.
fn trigger_table_of<'a>(
    schema: &'a BaseSchema,
    trigger: &mut Value,
) -> Result<Option<&'a Table>, String> {
    let kind = trigger["type"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "record_created" | "record_updated" | "record_matches" => Ok(trigger["table_id"]
            .as_str()
            .and_then(|id| schema.tables.iter().find(|t| t.id == id))),
        "form_submitted" => Ok(trigger["view_id"].as_str().and_then(|vid| {
            schema
                .tables
                .iter()
                .find(|t| t.views.iter().any(|v| v.id == vid))
        })),
        _ => Ok(None),
    }
}

async fn delete_automation(ctx: &McpCtx, a: AutomationArg) -> ToolResult {
    match fetch(
        ctx,
        "DELETE",
        &automation_path(&a.automation_id, ""),
        None,
        None,
    )
    .await
    {
        Ok(_) => ToolResult::ok(json!({ "deleted": a.automation_id })),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestAutomation {
    automation_id: String,
    #[serde(default)]
    record_id: Option<String>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    dry_run: Option<bool>,
}

async fn test_automation(ctx: &McpCtx, a: TestAutomation) -> ToolResult {
    let mut body = Map::new();
    body.insert("dry_run".into(), json!(a.dry_run.unwrap_or(true)));
    if let Some(r) = a.record_id {
        body.insert("record_id".into(), json!(r));
    }
    if let Some(b) = a.body {
        body.insert("body".into(), b);
    }
    match fetch(
        ctx,
        "POST",
        &automation_path(&a.automation_id, "/test"),
        None,
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(v) => ToolResult::ok(v),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunsArgs {
    automation_id: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<i64>,
}

async fn list_runs(ctx: &McpCtx, a: RunsArgs) -> ToolResult {
    let mut query = json!({ "limit": a.limit.unwrap_or(20).clamp(1, 100) });
    if let Some(b) = a.before {
        query["before"] = json!(b);
    }
    match fetch(
        ctx,
        "GET",
        &automation_path(&a.automation_id, "/runs"),
        Some(query),
        None,
    )
    .await
    {
        Ok(v) => ToolResult::ok(v),
        Err(e) => e,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{Field, FieldKind, TextOptions};

    fn schema() -> BaseSchema {
        BaseSchema {
            id: "app1".into(),
            workspace_id: "wsp1".into(),
            name: "CRM".into(),
            color: "blue".into(),
            icon: None,
            role: "owner".into(),
            tables: vec![Table {
                id: "tbl1".into(),
                base_id: "app1".into(),
                name: "Leads".into(),
                icon: None,
                description: None,
                primary_field_id: "fld1".into(),
                fields: vec![Field {
                    id: "fld1".into(),
                    table_id: "tbl1".into(),
                    name: "Name".into(),
                    description: None,
                    kind: FieldKind::SingleLineText(TextOptions::default()),
                }],
                views: vec![],
            }],
        }
    }

    #[test]
    fn triggers_and_actions_accept_names() {
        let s = schema();
        let mut trigger =
            json!({"type": "record_updated", "table": "leads", "field_ids": ["Name"]});
        let table = trigger_to_ids(&s, &mut trigger).unwrap().unwrap();
        assert_eq!(
            trigger,
            json!({"type": "record_updated", "table_id": "tbl1", "field_ids": ["fld1"]})
        );
        let mut actions = json!([
            {"type": "create_record", "table": "Leads", "values": {"Name": "x"},
             "condition": {"conjunction": "and", "items": [{"field": "Name", "op": "is_not_empty"}]}},
            {"type": "notify", "user_ids": [], "message": "hi"}
        ]);
        actions_to_ids(&s, Some(table), &mut actions).unwrap();
        assert_eq!(actions[0]["table_id"], "tbl1");
        assert!(actions[0].get("table").is_none());
        assert_eq!(actions[0]["condition"]["items"][0]["field_id"], "fld1");
    }

    #[test]
    fn mistakes_are_explained() {
        let s = schema();
        let e = trigger_to_ids(&s, &mut json!({"type": "record_created", "table": "Nope"}))
            .unwrap_err();
        assert!(
            e.contains("Table 'Nope' not found") && e.contains("'Leads'"),
            "{e}"
        );
        let e = trigger_to_ids(&s, &mut json!({"type": "sometimes"})).unwrap_err();
        assert!(e.contains("unknown trigger type"), "{e}");
        let e = trigger_to_ids(&s, &mut json!({"type": "record_created"})).unwrap_err();
        assert!(e.contains("needs a `table`"), "{e}");
        let e = actions_to_ids(
            &s,
            None,
            &mut json!([{"type": "notify", "condition": {"items": []}}]),
        )
        .unwrap_err();
        assert!(e.contains("conditions only work"), "{e}");
    }
}
