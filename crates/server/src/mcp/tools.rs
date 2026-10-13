//! The tool registry: which tools exist, which token scopes see them, and their dispatch.
//!
//! What a token sees is only a convenience; every tool re-checks permissions through the same
//! code paths as the web app (`perm::require_base`, `Actor::require_capability`), so a tool
//! called by name without being listed is still refused.

use std::sync::OnceLock;

use base64::Engine;
use serde_json::{Value, json};

use super::McpCtx;
use crate::auth::Actor;

/// Longest tool result text returned to the model; longer results are cut with a note.
pub const MAX_RESULT_BYTES: usize = 100_000;

/// What a token needs to see and use a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Any token.
    Read,
    /// A token that can write.
    Write,
    /// A token with the `manage` permission (and write).
    Manage,
    /// Like `Manage`, and the token's user must be an instance administrator.
    Admin,
}

impl Level {
    pub fn allows(self, actor: &Actor) -> bool {
        let Some(scope) = &actor.token_scope else {
            return true;
        };
        match self {
            Level::Read => true,
            Level::Write => scope.write,
            Level::Manage => scope.write && scope.manage,
            Level::Admin => scope.write && scope.manage && actor.is_admin,
        }
    }

    fn needs(self) -> &'static str {
        match self {
            Level::Read => "an API token",
            Level::Write => "an API token with write access (not read-only)",
            Level::Manage => {
                "an API token with write access and the 'manage' permission \
                 (\"Allow managing workspaces, members and settings\" when creating the token)"
            }
            Level::Admin => {
                "an API token with write access and the 'manage' permission, created by an \
                 instance administrator"
            }
        }
    }
}

pub struct ToolDef {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub level: Level,
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

impl ToolDef {
    /// A read-only tool any token can use; refine with the builder methods below.
    pub fn new(
        name: &'static str,
        title: &'static str,
        description: &'static str,
        schema: Value,
    ) -> ToolDef {
        ToolDef {
            name,
            title,
            description,
            schema,
            level: Level::Read,
            read_only: true,
            destructive: false,
            idempotent: true,
        }
    }

    /// Changes data: needs a token with write access.
    pub fn write(mut self) -> ToolDef {
        self.level = Level::Write;
        self.read_only = false;
        self.idempotent = false;
        self
    }

    /// Needs the 'manage' permission (and changes data).
    pub fn manage(mut self) -> ToolDef {
        self.level = Level::Manage;
        self.read_only = false;
        self.idempotent = false;
        self
    }

    /// Needs the 'manage' permission and an instance administrator (reads only unless
    /// followed by [`ToolDef::changes`]).
    pub fn admin(mut self) -> ToolDef {
        self.level = Level::Admin;
        self
    }

    /// The tool changes data (without touching the access level).
    pub fn changes(mut self) -> ToolDef {
        self.read_only = false;
        self.idempotent = false;
        self
    }

    /// Needs the 'manage' permission but only reads.
    pub fn manage_read(mut self) -> ToolDef {
        self.level = Level::Manage;
        self
    }

    pub fn destructive(mut self) -> ToolDef {
        self.destructive = true;
        self.idempotent = false;
        self
    }

    /// Repeating the call with the same arguments changes nothing more.
    pub fn idempotent(mut self) -> ToolDef {
        self.idempotent = true;
        self
    }

    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.schema,
            "annotations": {
                "title": self.title,
                "readOnlyHint": self.read_only,
                "destructiveHint": self.destructive,
                "idempotentHint": self.idempotent,
                "openWorldHint": false,
            },
        })
    }
}

/// What a tool returns: a text for the model, optionally the same data as structured content.
pub struct ToolResult {
    pub text: String,
    pub structured: Option<Value>,
    pub is_error: bool,
}

impl ToolResult {
    /// A successful result: compact JSON text, plus the value as `structuredContent` when it
    /// is an object and fits.
    pub fn ok(value: Value) -> ToolResult {
        let text = value.to_string();
        if text.len() > MAX_RESULT_BYTES {
            return ToolResult {
                text: truncate(&text, MAX_RESULT_BYTES),
                structured: None,
                is_error: false,
            };
        }
        ToolResult {
            structured: value.is_object().then_some(value),
            text,
            is_error: false,
        }
    }

    /// A failed call the model can act on (MCP: `isError`, not a protocol error).
    pub fn error(message: impl Into<String>) -> ToolResult {
        ToolResult {
            text: message.into(),
            structured: None,
            is_error: true,
        }
    }

    pub fn into_result(self) -> Value {
        let mut out = json!({
            "content": [{ "type": "text", "text": self.text }],
            "isError": self.is_error,
        });
        if let Some(s) = self.structured {
            out["structuredContent"] = s;
        }
        out
    }
}

/// `text` cut to at most `max` bytes (on a character boundary) with a note.
pub fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[truncated: showing the first {end} of {} bytes. Ask for less: fewer records, \
         specific fields, or a narrower filter]",
        &text[..end],
        text.len()
    )
}

pub fn registry() -> &'static [ToolDef] {
    static TOOLS: OnceLock<Vec<ToolDef>> = OnceLock::new();
    TOOLS.get_or_init(super::definitions)
}

pub struct Page {
    pub tools: Vec<Value>,
    pub next_cursor: Option<String>,
}

fn encode_cursor(offset: usize) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("tools:{offset}"))
}

fn decode_cursor(cursor: &str) -> Option<usize> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()?;
    String::from_utf8(bytes)
        .ok()?
        .strip_prefix("tools:")?
        .parse()
        .ok()
}

/// The tools `actor` can use, one page at a time (deterministic order).
pub fn list_page(actor: &Actor, cursor: Option<&str>, page_size: usize) -> Result<Page, String> {
    let start = match cursor {
        None => 0,
        Some(c) => decode_cursor(c).ok_or_else(|| "invalid cursor".to_string())?,
    };
    let visible: Vec<&ToolDef> = registry()
        .iter()
        .filter(|t| t.level.allows(actor))
        .collect();
    if start > visible.len() {
        return Err("invalid cursor".to_string());
    }
    let end = (start + page_size).min(visible.len());
    Ok(Page {
        tools: visible[start..end].iter().map(|t| t.to_json()).collect(),
        next_cursor: (end < visible.len()).then(|| encode_cursor(end)),
    })
}

/// Run a tool. `None` = no such tool (a protocol error); a tool the token may not use is a tool
/// error that says what it needs.
pub async fn call(ctx: &McpCtx, name: &str, args: Value) -> Option<ToolResult> {
    let def = registry().iter().find(|t| t.name == name)?;
    if !def.level.allows(&ctx.actor) {
        return Some(ToolResult::error(format!(
            "The tool '{name}' needs {}. Tools available to this token are listed by tools/list.",
            def.level.needs()
        )));
    }
    tracing::debug!(tool = name, user = %ctx.actor.user_id, "mcp tool call");
    Some(super::run(ctx, name, args).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(write: bool, manage: bool) -> Actor {
        Actor {
            user_id: "usr".into(),
            name: "n".into(),
            email: "e".into(),
            is_admin: false,
            token_scope: Some(crate::auth::TokenScope {
                write,
                manage,
                base_ids: None,
            }),
            session_hash: None,
            token_hash: Some("h".into()),
            token_id: Some("pat".into()),
        }
    }

    fn names(a: &Actor) -> Vec<String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = list_page(a, cursor.as_deref(), 3).unwrap();
            out.extend(
                page.tools
                    .iter()
                    .map(|t| t["name"].as_str().unwrap().to_string()),
            );
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => return out,
            }
        }
    }

    #[test]
    fn tools_by_scope_are_nested_and_paginated() {
        let read = names(&actor(false, false));
        let write = names(&actor(true, false));
        let manage = names(&actor(true, true));
        assert!(read.contains(&"list_records".to_string()));
        assert!(!read.contains(&"create_records".to_string()));
        assert!(write.contains(&"create_records".to_string()));
        assert!(!write.contains(&"create_workspace".to_string()));
        assert!(manage.contains(&"create_workspace".to_string()));
        assert!(read.len() < write.len() && write.len() < manage.len());
        for r in &read {
            assert!(write.contains(r));
        }
        // manage without write grants nothing extra (managing is writing).
        assert_eq!(names(&actor(false, true)), read);
        // Paging with a tiny page size visits every tool exactly once.
        let mut sorted = manage.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), manage.len());
    }

    #[test]
    fn bad_cursors_are_rejected() {
        let a = actor(true, true);
        assert!(list_page(&a, Some("!!"), 10).is_err());
        assert!(list_page(&a, Some(&encode_cursor(10_000)), 10).is_err());
        assert!(list_page(&a, Some(&encode_cursor(0)), 10).is_ok());
    }

    #[test]
    fn every_tool_has_a_valid_definition() {
        let mut seen = std::collections::BTreeSet::new();
        for t in registry() {
            assert!(seen.insert(t.name), "duplicate tool {}", t.name);
            assert!(
                t.name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
                    && t.name.len() <= 128,
                "{}",
                t.name
            );
            assert!(!t.description.is_empty() && t.description.len() < 1200);
            assert_eq!(t.schema["type"], "object", "{}", t.name);
            assert!(t.schema["properties"].is_object(), "{}", t.name);
            // Every described property has a description (LLM-oriented schemas).
            for (prop, spec) in t.schema["properties"].as_object().unwrap() {
                assert!(
                    spec["description"].is_string(),
                    "{}.{prop} has no description",
                    t.name
                );
            }
            if t.read_only {
                assert!(!t.destructive, "{}", t.name);
                assert_ne!(t.level, Level::Write, "{} is read-only", t.name);
            }
        }
    }

    #[test]
    fn long_results_are_truncated_on_a_char_boundary() {
        let text = "é".repeat(MAX_RESULT_BYTES);
        let cut = truncate(&text, MAX_RESULT_BYTES);
        assert!(cut.contains("[truncated: showing the first"));
        let r = ToolResult::ok(json!({ "big": text }));
        assert!(r.structured.is_none());
        assert!(r.text.contains("[truncated"));
        let small = ToolResult::ok(json!({"a": 1}));
        assert_eq!(small.structured, Some(json!({"a": 1})));
        assert_eq!(small.text, r#"{"a":1}"#);
    }
}
