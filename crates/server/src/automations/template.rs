//! `{{placeholder}}` templates for automation actions.
//!
//! Templates are parsed once (at save time, to reject bad syntax early, and
//! again when a run executes) into literal text and variable references. There
//! is no expression language: a placeholder is one of a fixed set of variable
//! paths (see `ob_core::api::automations` for the table), substituted as plain
//! text. Missing values render as an empty string.
//!
//! Substitution can be escaped for the place it lands in: [`Escape::Json`] for
//! request bodies that are JSON (so a record value containing a quote cannot
//! break out of the string it is placed in) and [`Escape::Url`] for URLs.

use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use ob_core::cell::{NoNames, display_text};
use ob_core::field::Field;
use serde_json::{Map, Value as Json};

/// Longest rendered string; protects the runner from template blow-up.
pub const MAX_RENDERED_LEN: usize = 1_000_000;

/// A placeholder variable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Var {
    TriggerType,
    TriggerTime,
    RecordId,
    RecordTableId,
    /// A field of the trigger record, by id or name.
    RecordField(String),
    /// A path into the webhook body (empty = the whole body).
    Body(Vec<String>),
    /// `steps.<n>.<path>`: n is 1-based; an empty path is the whole output.
    Step(usize, Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Text(String),
    Var(Var),
}

/// A parsed template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    segments: Vec<Segment>,
}

/// What kind of event fires the automation, for validating variables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerShape {
    /// Record and form triggers: `trigger.record.*` is available.
    Record,
    /// Webhook trigger: `trigger.body.*` is available.
    Webhook,
    /// Schedule trigger: only `trigger.type` / `trigger.time`.
    Schedule,
}

impl Template {
    pub fn parse(src: &str) -> Result<Template, String> {
        let mut segments = Vec::new();
        let mut rest = src;
        while let Some(start) = rest.find("{{") {
            if start > 0 {
                segments.push(Segment::Text(rest[..start].to_string()));
            }
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else {
                return Err("a placeholder is missing its closing \"}}\"".into());
            };
            let expr = after[..end].trim();
            if expr.contains("{{") {
                return Err("placeholders cannot be nested".into());
            }
            segments.push(Segment::Var(parse_var(expr)?));
            rest = &after[end + 2..];
        }
        if !rest.is_empty() {
            segments.push(Segment::Text(rest.to_string()));
        }
        Ok(Template { segments })
    }

    pub fn vars(&self) -> impl Iterator<Item = &Var> {
        self.segments.iter().filter_map(|s| match s {
            Segment::Var(v) => Some(v),
            Segment::Text(_) => None,
        })
    }

    /// True when the template has no placeholders.
    pub fn is_literal(&self) -> bool {
        self.vars().next().is_none()
    }

    /// The text with every placeholder replaced by `filler` (for validating
    /// the shape of URLs and addresses at save time).
    pub fn with_filler(&self, filler: &str) -> String {
        self.segments
            .iter()
            .map(|s| match s {
                Segment::Text(t) => t.as_str(),
                Segment::Var(_) => filler,
            })
            .collect()
    }

    /// The literal text before the first placeholder.
    pub fn literal_prefix(&self) -> &str {
        match self.segments.first() {
            Some(Segment::Text(t)) => t,
            _ => "",
        }
    }

    /// The variable when the whole template is exactly one placeholder.
    pub fn single_var(&self) -> Option<&Var> {
        match self.segments.as_slice() {
            [Segment::Var(v)] => Some(v),
            _ => None,
        }
    }

    /// Check every variable is available for this trigger and refers only to
    /// earlier steps. `position` is the 0-based index of the action holding
    /// the template (`steps.n` needs `n <= position`).
    pub fn check(&self, shape: TriggerShape, position: usize) -> Result<(), String> {
        for v in self.vars() {
            match v {
                Var::TriggerType | Var::TriggerTime => {}
                Var::RecordId | Var::RecordTableId | Var::RecordField(_) => {
                    if shape != TriggerShape::Record {
                        return Err(
                            "trigger.record.* is only available for record and form triggers"
                                .into(),
                        );
                    }
                }
                Var::Body(_) => {
                    if shape != TriggerShape::Webhook {
                        return Err("trigger.body.* is only available for webhook triggers".into());
                    }
                }
                Var::Step(n, _) => {
                    if *n > position {
                        return Err(format!(
                            "steps.{n} refers to action {n}, which does not run before this action"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

fn parse_var(expr: &str) -> Result<Var, String> {
    let bad = || {
        format!(
            "unknown placeholder \"{{{{{expr}}}}}\"; use trigger.type, trigger.time, \
             trigger.record.id, trigger.record.fields.<field>, trigger.body.<path> or steps.<n>.<key>"
        )
    };
    if let Some(rest) = expr.strip_prefix("trigger.record.fields.") {
        let key = rest.trim();
        return if key.is_empty() {
            Err(bad())
        } else {
            Ok(Var::RecordField(key.to_string()))
        };
    }
    let parts: Vec<&str> = expr.split('.').map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err(bad());
    }
    match parts.as_slice() {
        ["trigger", "type"] => Ok(Var::TriggerType),
        ["trigger", "time"] => Ok(Var::TriggerTime),
        ["trigger", "record", "id"] => Ok(Var::RecordId),
        ["trigger", "record", "table_id"] => Ok(Var::RecordTableId),
        ["trigger", "body", path @ ..] => {
            Ok(Var::Body(path.iter().map(|s| s.to_string()).collect()))
        }
        ["steps", n, path @ ..] => {
            let n: usize = n.parse().map_err(|_| bad())?;
            if n == 0 {
                return Err("steps are numbered from 1".into());
            }
            Ok(Var::Step(n, path.iter().map(|s| s.to_string()).collect()))
        }
        _ => Err(bad()),
    }
}

/// How substituted text is escaped for where it lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escape {
    None,
    /// Escape for the inside of a JSON string literal.
    Json,
    /// Percent-encode everything but unreserved characters.
    Url,
}

/// The trigger record as templates see it.
#[derive(Debug, Clone, Copy)]
pub struct RecordCtx<'a> {
    pub id: &'a str,
    pub table_id: &'a str,
    pub fields: &'a [Field],
    pub data: &'a Map<String, Json>,
}

impl RecordCtx<'_> {
    /// Display text of a field given by id or name (names match exactly,
    /// then case-insensitively).
    fn field_text(&self, key: &str) -> Option<String> {
        let field = self
            .fields
            .iter()
            .find(|f| f.id == key)
            .or_else(|| self.fields.iter().find(|f| f.name == key))
            .or_else(|| {
                let lower = key.to_lowercase();
                self.fields.iter().find(|f| f.name.to_lowercase() == lower)
            })?;
        Some(display_text(
            field,
            self.data.get(&field.id),
            &NoNames,
            Tz::UTC,
        ))
    }
}

/// Everything a template can read.
#[derive(Debug, Clone, Copy)]
pub struct RenderCtx<'a> {
    pub trigger_type: &'a str,
    pub time_ms: i64,
    pub record: Option<RecordCtx<'a>>,
    pub body: Option<&'a Json>,
    /// Outputs of earlier actions; index 0 is step 1.
    pub steps: &'a [Json],
}

impl RenderCtx<'_> {
    /// The value of a variable as JSON (record fields as display text).
    pub fn resolve(&self, var: &Var) -> Json {
        match var {
            Var::TriggerType => Json::String(self.trigger_type.to_string()),
            Var::TriggerTime => Json::String(
                DateTime::<Utc>::from_timestamp_millis(self.time_ms)
                    .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
                    .unwrap_or_default(),
            ),
            Var::RecordId => self
                .record
                .map(|r| Json::String(r.id.to_string()))
                .unwrap_or(Json::Null),
            Var::RecordTableId => self
                .record
                .map(|r| Json::String(r.table_id.to_string()))
                .unwrap_or(Json::Null),
            Var::RecordField(key) => self
                .record
                .and_then(|r| r.field_text(key))
                .map(Json::String)
                .unwrap_or(Json::Null),
            Var::Body(path) => self
                .body
                .and_then(|b| walk(b, path))
                .cloned()
                .unwrap_or(Json::Null),
            Var::Step(n, path) => self
                .steps
                .get(n - 1)
                .and_then(|o| walk(o, path))
                .cloned()
                .unwrap_or(Json::Null),
        }
    }

    /// Substitute every placeholder in `t`.
    pub fn render(&self, t: &Template, escape: Escape) -> Result<String, String> {
        let mut out = String::new();
        for seg in &t.segments {
            match seg {
                Segment::Text(s) => out.push_str(s),
                Segment::Var(v) => {
                    let text = json_text(&self.resolve(v));
                    match escape {
                        Escape::None => out.push_str(&text),
                        Escape::Json => out.push_str(&json_escape(&text)),
                        Escape::Url => out.push_str(&url_escape(&text)),
                    }
                }
            }
            if out.len() > MAX_RENDERED_LEN {
                return Err("the rendered text is too large".into());
            }
        }
        Ok(out)
    }

    /// Parse and render a string.
    pub fn render_str(&self, src: &str, escape: Escape) -> Result<String, String> {
        self.render(&Template::parse(src)?, escape)
    }

    /// Render the strings inside a JSON value. A string that is exactly one
    /// placeholder for a webhook-body or step value keeps that value's JSON
    /// type (numbers, arrays); everything else becomes text.
    pub fn render_json(&self, v: &Json) -> Result<Json, String> {
        Ok(match v {
            Json::String(s) => {
                let t = Template::parse(s)?;
                match t.single_var() {
                    Some(var @ (Var::Body(_) | Var::Step(..))) => match self.resolve(var) {
                        Json::Null => Json::String(String::new()),
                        other => other,
                    },
                    _ => Json::String(self.render(&t, Escape::None)?),
                }
            }
            Json::Array(a) => Json::Array(
                a.iter()
                    .map(|x| self.render_json(x))
                    .collect::<Result<_, _>>()?,
            ),
            Json::Object(o) => Json::Object(
                o.iter()
                    .map(|(k, x)| Ok((k.clone(), self.render_json(x)?)))
                    .collect::<Result<Map<_, _>, String>>()?,
            ),
            other => other.clone(),
        })
    }
}

/// Parse every string inside a JSON value as a template and check it.
pub fn check_json(v: &Json, shape: TriggerShape, position: usize) -> Result<(), String> {
    match v {
        Json::String(s) => Template::parse(s)?.check(shape, position),
        Json::Array(a) => a.iter().try_for_each(|x| check_json(x, shape, position)),
        Json::Object(o) => o.values().try_for_each(|x| check_json(x, shape, position)),
        _ => Ok(()),
    }
}

fn walk<'a>(mut v: &'a Json, path: &[String]) -> Option<&'a Json> {
    for seg in path {
        v = match v {
            Json::Object(o) => o.get(seg)?,
            Json::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(v)
}

/// Plain-text form of a JSON value: strings as-is, scalars printed, null as
/// empty, arrays and objects as compact JSON.
pub fn json_text(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn json_escape(s: &str) -> String {
    let quoted = Json::String(s.to_string()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

fn url_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{Empty, FieldKind, TextOptions};
    use serde_json::json;

    fn field(id: &str, name: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl1".into(),
            name: name.into(),
            description: None,
            kind,
        }
    }

    fn fields() -> Vec<Field> {
        vec![
            field(
                "fldName",
                "Customer Name",
                FieldKind::Text(TextOptions::default()),
            ),
            field("fldDone", "Done", FieldKind::Checkbox(Default::default())),
            field("fldFiles", "Files", FieldKind::Attachment(Empty {})),
        ]
    }

    fn ctx<'a>(
        fields: &'a [Field],
        data: &'a Map<String, Json>,
        body: Option<&'a Json>,
        steps: &'a [Json],
    ) -> RenderCtx<'a> {
        RenderCtx {
            trigger_type: "record_created",
            time_ms: 1_700_000_000_000,
            record: Some(RecordCtx {
                id: "rec1",
                table_id: "tbl1",
                fields,
                data,
            }),
            body,
            steps,
        }
    }

    fn data() -> Map<String, Json> {
        json!({"fldName": "Ada \"Lovelace\"", "fldDone": true})
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn parses_literals_and_variables() {
        let t = Template::parse(
            "Hi {{ trigger.record.fields.Customer Name }}, id {{trigger.record.id}}!",
        )
        .unwrap();
        assert_eq!(t.vars().count(), 2);
        assert!(!t.is_literal());
        assert!(Template::parse("no placeholders").unwrap().is_literal());
        // Literal braces are fine: JSON bodies often end in "}}".
        assert!(
            Template::parse("{\"a\": {\"b\": 1}} }}")
                .unwrap()
                .is_literal()
        );
        let t = Template::parse("{\"id\": {{trigger.record.id}}}").unwrap();
        assert_eq!(t.vars().count(), 1);
        assert_eq!(Template::parse("").unwrap().vars().count(), 0);
        assert!(
            Template::parse("{{steps.2.record_id}}")
                .unwrap()
                .single_var()
                .is_some()
        );
        assert!(
            Template::parse("x{{trigger.type}}")
                .unwrap()
                .single_var()
                .is_none()
        );
    }

    #[test]
    fn rejects_bad_syntax() {
        for bad in [
            "{{trigger.type",
            "{{}}",
            "{{ nope }}",
            "{{trigger.record}}",
            "{{trigger.record.fields.}}",
            "{{steps.0.x}}",
            "{{steps.x.y}}",
            "{{trigger..id}}",
            "{{ {{trigger.type}} }}",
            "{{system.env}}",
            "{{trigger.record.id.extra}}",
        ] {
            assert!(Template::parse(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn check_enforces_trigger_shape_and_step_order() {
        let t = Template::parse("{{trigger.record.id}}").unwrap();
        assert!(t.check(TriggerShape::Record, 0).is_ok());
        assert!(t.check(TriggerShape::Webhook, 0).is_err());
        assert!(t.check(TriggerShape::Schedule, 0).is_err());
        let b = Template::parse("{{trigger.body.a}}").unwrap();
        assert!(b.check(TriggerShape::Webhook, 0).is_ok());
        assert!(b.check(TriggerShape::Record, 0).is_err());
        let s = Template::parse("{{steps.2.x}}").unwrap();
        assert!(s.check(TriggerShape::Schedule, 1).is_err());
        assert!(s.check(TriggerShape::Schedule, 2).is_ok());
        assert!(
            Template::parse("{{trigger.type}} {{trigger.time}}")
                .unwrap()
                .check(TriggerShape::Schedule, 0)
                .is_ok()
        );
    }

    #[test]
    fn renders_record_body_and_step_values() {
        let f = fields();
        let d = data();
        let body = json!({"order": {"items": [{"sku": "A1"}, {"sku": "B2"}], "total": 12.5}});
        let steps = [json!({"record_id": "recNEW", "status": 201})];
        let c = ctx(&f, &d, Some(&body), &steps);
        let r = |s: &str| c.render_str(s, Escape::None).unwrap();
        assert_eq!(
            r("{{trigger.record.id}}/{{trigger.record.table_id}}"),
            "rec1/tbl1"
        );
        assert_eq!(r("{{trigger.record.fields.fldName}}"), "Ada \"Lovelace\"");
        // By name, exact and case-insensitive.
        assert_eq!(
            r("{{trigger.record.fields.Customer Name}}"),
            "Ada \"Lovelace\""
        );
        assert_eq!(
            r("{{trigger.record.fields.customer name}}"),
            "Ada \"Lovelace\""
        );
        assert_eq!(r("{{trigger.record.fields.Done}}"), "checked");
        assert_eq!(r("[{{trigger.record.fields.Nope}}]"), "[]");
        assert_eq!(r("{{trigger.body.order.items.1.sku}}"), "B2");
        assert_eq!(r("{{trigger.body.order.total}}"), "12.5");
        assert_eq!(
            r("{{trigger.body.order.items.9.sku}}|{{trigger.body.zzz}}"),
            "|"
        );
        assert_eq!(
            r("{{steps.1.record_id}} {{steps.1.status}} [{{steps.2.x}}]"),
            "recNEW 201 []"
        );
        assert_eq!(
            r("{{trigger.type}} {{trigger.time}}"),
            "record_created 2023-11-14T22:13:20.000Z"
        );
        assert!(r("{{trigger.body.order.items.0}}").contains("\"sku\":\"A1\""));
    }

    #[test]
    fn substitution_is_plain_text_not_recursive() {
        let f = fields();
        let mut d = data();
        d.insert(
            "fldName".into(),
            json!("{{trigger.record.id}} {{steps.1.x}}"),
        );
        let c = ctx(&f, &d, None, &[]);
        assert_eq!(
            c.render_str("{{trigger.record.fields.fldName}}", Escape::None)
                .unwrap(),
            "{{trigger.record.id}} {{steps.1.x}}"
        );
    }

    #[test]
    fn escapes_for_json_and_urls() {
        let f = fields();
        let d = data();
        let c = ctx(&f, &d, None, &[]);
        let body = c
            .render_str(
                "{\"name\": \"{{trigger.record.fields.fldName}}\"}",
                Escape::Json,
            )
            .unwrap();
        let parsed: Json = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["name"], "Ada \"Lovelace\"");
        let url = c
            .render_str(
                "https://x.test/a/{{trigger.record.fields.fldName}}?q=1",
                Escape::Url,
            )
            .unwrap();
        assert_eq!(url, "https://x.test/a/Ada%20%22Lovelace%22?q=1");
        // Path traversal / host smuggling characters are encoded.
        let mut d2 = data();
        d2.insert("fldName".into(), json!("../evil@host/?#"));
        let c2 = ctx(&f, &d2, None, &[]);
        let url = c2
            .render_str(
                "https://x.test/{{trigger.record.fields.fldName}}",
                Escape::Url,
            )
            .unwrap();
        assert_eq!(url, "https://x.test/..%2Fevil%40host%2F%3F%23");
    }

    #[test]
    fn json_values_keep_types_for_body_and_step_placeholders() {
        let f = fields();
        let d = data();
        let body = json!({"n": 3, "ids": ["a", "b"]});
        let steps = [json!({"record_id": "recX"})];
        let c = ctx(&f, &d, Some(&body), &steps);
        let v = c
            .render_json(&json!({
                "a": "{{trigger.body.n}}",
                "b": "{{trigger.body.ids}}",
                "c": ["{{steps.1.record_id}}", "x {{trigger.body.n}} y"],
                "d": "{{trigger.record.fields.Done}}",
                "e": 7,
                "f": "{{trigger.body.missing}}"
            }))
            .unwrap();
        assert_eq!(
            v,
            json!({"a": 3, "b": ["a","b"], "c": ["recX", "x 3 y"], "d": "checked", "e": 7, "f": ""})
        );
    }

    #[test]
    fn output_size_is_capped() {
        let f = fields();
        let mut d = data();
        d.insert("fldName".into(), json!("x".repeat(600_000)));
        let c = ctx(&f, &d, None, &[]);
        let r = c.render_str(
            "{{trigger.record.fields.fldName}}{{trigger.record.fields.fldName}}",
            Escape::None,
        );
        assert!(r.is_err());
    }

    #[test]
    fn check_json_walks_nested_strings() {
        assert!(check_json(&json!({"a": ["{{steps.1.x}}"]}), TriggerShape::Webhook, 1).is_ok());
        assert!(check_json(&json!({"a": ["{{steps.1.x}}"]}), TriggerShape::Webhook, 0).is_err());
        assert!(check_json(&json!({"a": {"b": "{{oops"}}), TriggerShape::Webhook, 0).is_err());
    }
}
