//! Runtime values used by the formula engine, filters, sorting and grouping.
//!
//! Stored cell JSON is converted into a [`Value`] by `cell::to_value` using the
//! field definition; computed fields produce `Value`s directly. Values are
//! converted back to JSON for API responses with [`Value::to_json`].

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value as Json;

/// Static type of a computed field's result. The server fills it in on
/// formula/rollup/lookup options when the field is saved (from formula type
/// inference or the lookup target), so stored materialized JSON can be read
/// back into the right [`Value`] variant (e.g. a date string vs plain text).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultType {
    #[default]
    Text,
    Number,
    Bool,
    Date,
    DateTime,
    Array(Box<ResultType>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// Empty / blank.
    Null,
    Text(String),
    Number(f64),
    Bool(bool),
    /// A calendar date without time (date-only fields).
    Date(NaiveDate),
    /// An instant (date fields with time, created/modified time, NOW()).
    DateTime(DateTime<Utc>),
    /// Multi-valued results: multiple select names, lookups, linked records.
    Array(Vec<Value>),
    /// A formula error, e.g. `#ERROR: division by zero`. Errors propagate.
    Error(String),
}

impl Value {
    pub fn error(msg: impl Into<String>) -> Value {
        Value::Error(msg.into())
    }

    pub fn is_blank(&self) -> bool {
        match self {
            Value::Null => true,
            Value::Text(s) => s.is_empty(),
            Value::Array(a) => a.iter().all(Value::is_blank),
            _ => false,
        }
    }

    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }

    /// Airtable truthiness: 0, "", blank, false and empty arrays are false.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Text(s) => !s.is_empty(),
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Bool(b) => *b,
            Value::Date(_) | Value::DateTime(_) => true,
            Value::Array(a) => a.iter().any(Value::truthy),
            Value::Error(_) => false,
        }
    }

    /// JSON representation used in API responses for computed values.
    /// Dates are ISO strings, errors are `{"error": "..."}`.
    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Text(s) => Json::String(s.clone()),
            Value::Number(n) => {
                if n.is_finite() {
                    serde_json::Number::from_f64(*n)
                        .map(Json::Number)
                        .unwrap_or(Json::Null)
                } else {
                    Json::Null
                }
            }
            Value::Bool(b) => Json::Bool(*b),
            Value::Date(d) => Json::String(d.format("%Y-%m-%d").to_string()),
            Value::DateTime(dt) => {
                Json::String(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            }
            Value::Array(a) => Json::Array(a.iter().map(Value::to_json).collect()),
            Value::Error(e) => serde_json::json!({ "error": e }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_airtable() {
        assert!(!Value::Null.truthy());
        assert!(!Value::Number(0.0).truthy());
        assert!(!Value::Text(String::new()).truthy());
        assert!(Value::Text("0".into()).truthy());
        assert!(!Value::Array(vec![]).truthy());
        assert!(Value::Array(vec![Value::Number(1.0)]).truthy());
    }

    #[test]
    fn json_of_non_finite_number_is_null() {
        assert_eq!(Value::Number(f64::NAN).to_json(), Json::Null);
    }
}
