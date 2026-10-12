//! Test harness: an in-memory [`EvalContext`] and short value constructors.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;

use crate::formula::{EvalContext, eval, parse};
use crate::value::Value;

pub struct Ctx {
    pub fields: HashMap<String, Value>,
    pub record: String,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub now: DateTime<Utc>,
    pub values: Value,
    pub tz: Tz,
    pub field_times: HashMap<String, DateTime<Utc>>,
}

impl Default for Ctx {
    fn default() -> Self {
        Ctx {
            fields: HashMap::new(),
            record: "recABC123".into(),
            created: utc("2024-01-02T03:04:05Z"),
            modified: utc("2024-03-10T08:00:00Z"),
            now: utc("2024-03-15T12:30:45.123Z"),
            values: Value::Null,
            tz: chrono_tz::UTC,
            field_times: HashMap::new(),
        }
    }
}

impl EvalContext for Ctx {
    fn field(&self, field_id: &str) -> Value {
        self.fields.get(field_id).cloned().unwrap_or(Value::Null)
    }
    fn record_id(&self) -> &str {
        &self.record
    }
    fn created_time(&self) -> DateTime<Utc> {
        self.created
    }
    fn last_modified_time(&self) -> DateTime<Utc> {
        self.modified
    }
    fn now(&self) -> DateTime<Utc> {
        self.now
    }
    fn values(&self) -> Value {
        self.values.clone()
    }
    fn timezone(&self) -> Tz {
        self.tz
    }
    fn field_modified_time(&self, field_id: &str) -> Option<DateTime<Utc>> {
        self.field_times.get(field_id).copied()
    }
}

pub fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .expect("valid test timestamp")
        .with_timezone(&Utc)
}

/// Context with the given fields (referenced by name in test formulas).
pub fn with(fields: &[(&str, Value)]) -> Ctx {
    Ctx {
        fields: fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        ..Ctx::default()
    }
}

/// Parses and evaluates with the default context.
pub fn ev(src: &str) -> Value {
    ev_in(src, &Ctx::default())
}

/// Parses and evaluates in `ctx`.
pub fn ev_in(src: &str, ctx: &Ctx) -> Value {
    let expr = parse(src).unwrap_or_else(|e| panic!("parse failed for {src:?}: {e}"));
    eval(&expr, ctx)
}

pub fn n(x: f64) -> Value {
    Value::Number(x)
}

pub fn t(s: &str) -> Value {
    Value::Text(s.to_string())
}

pub fn b(x: bool) -> Value {
    Value::Bool(x)
}

pub fn arr(items: Vec<Value>) -> Value {
    Value::Array(items)
}

pub fn date(y: i32, m: u32, d: u32) -> Value {
    Value::Date(NaiveDate::from_ymd_opt(y, m, d).expect("valid test date"))
}

pub fn dt(s: &str) -> Value {
    Value::DateTime(utc(s))
}

/// Asserts `src` evaluates to `expected` in the default context.
#[track_caller]
pub fn check(src: &str, expected: Value) {
    assert_eq!(ev(src), expected, "formula: {src}");
}

/// Asserts `src` evaluates to `expected` in `ctx`.
#[track_caller]
pub fn check_in(src: &str, ctx: &Ctx, expected: Value) {
    assert_eq!(ev_in(src, ctx), expected, "formula: {src}");
}

/// Asserts `src` evaluates to an error whose message contains `needle`.
#[track_caller]
pub fn check_err(src: &str, needle: &str) {
    check_err_in(src, &Ctx::default(), needle);
}

#[track_caller]
pub fn check_err_in(src: &str, ctx: &Ctx, needle: &str) {
    match ev_in(src, ctx) {
        Value::Error(m) => assert!(
            m.contains(needle),
            "formula {src}: error {m:?} does not contain {needle:?}"
        ),
        other => panic!("formula {src}: expected error containing {needle:?}, got {other:?}"),
    }
}

/// Asserts a number result within 1e-9.
#[track_caller]
pub fn check_num(src: &str, expected: f64) {
    match ev(src) {
        Value::Number(x) => assert!(
            (x - expected).abs() < 1e-9,
            "formula {src}: got {x}, expected {expected}"
        ),
        other => panic!("formula {src}: expected number {expected}, got {other:?}"),
    }
}
