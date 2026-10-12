//! Stored cell JSON: validation/normalization, conversion to runtime values,
//! type conversion when a field's type changes, and display text.
//!
//! The canonical stored JSON per field type is documented at the top of
//! [`crate::field`]. Every function here is pure and total: malformed stored
//! JSON (e.g. after a manual database edit) reads as blank instead of
//! panicking, and client input is rejected with a [`CellError`].
//!
//! Entry points:
//! - [`normalize`]: client JSON → canonical stored JSON (API writes, forms).
//! - [`parse_text`]: pasted / CSV text → canonical stored JSON.
//! - [`missing_choices`]: select names in an input that don't exist yet
//!   (the server creates them first when `typecast` is on).
//! - [`to_value`]: stored JSON → [`Value`] (formulas, filters, sorting).
//! - [`display_text`]: stored JSON → human text (CSV, search, primary names).
//! - [`convert`] / [`choices_needed_for_conversion`]: field type changes.
//!
//! **Typecast.** With `CellCtx::typecast` off, `normalize` requires each
//! field's natural JSON type (numbers as JSON numbers, checkboxes as bools,
//! multiple selects as arrays) while still accepting choice names, any
//! supported date string and the documented link/user/attachment shapes.
//! With it on (Airtable's `typecast: true`), strings are read like pasted
//! text (`"$1,200"` → 1200, `"yes"` → checked, `"a, b"` → two choices),
//! numbers become text for text fields, and out-of-range ratings clamp.

mod convert;
mod normalize;
pub(crate) mod parse;
mod present;

#[cfg(test)]
pub(crate) mod tests;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

pub use convert::{choices_needed_for_conversion, convert};
pub use normalize::{missing_choices, normalize, parse_text};
pub use present::{display_text, to_value};

#[allow(unused_imports)]
pub(crate) use present::{
    NumberFormat, computed_to_value, date_options_of, format_date_value, format_general_number,
    number_format_of,
};

/// Context for interpreting client input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellCtx {
    /// Current time (reserved for relative input; never read from the clock here).
    pub now: DateTime<Utc>,
    /// Zone used to interpret wall-clock date/time input when the field has
    /// no fixed `timezone` option (normally the acting user's zone).
    pub timezone: Tz,
    /// Lenient Airtable-style coercion; see the module docs.
    pub typecast: bool,
}

impl CellCtx {
    /// Strict context in `timezone`.
    pub fn new(now: DateTime<Utc>, timezone: Tz) -> Self {
        Self {
            now,
            timezone,
            typecast: false,
        }
    }

    /// Strict context in UTC.
    pub fn utc(now: DateTime<Utc>) -> Self {
        Self::new(now, Tz::UTC)
    }

    /// The same context with `typecast` set.
    pub fn with_typecast(self, typecast: bool) -> Self {
        Self { typecast, ..self }
    }
}

/// Why client input was rejected. Messages are safe to show to users.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CellError {
    #[error("this field is computed and cannot be edited")]
    ComputedField,
    #[error("unknown option \"{0}\"")]
    UnknownChoice(String),
    #[error("text is too long (maximum {max} characters)")]
    TooLong { max: usize },
    #[error("too many values (maximum {max})")]
    TooMany { max: usize },
    #[error("{0}")]
    Invalid(String),
}

impl CellError {
    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        CellError::Invalid(msg.into())
    }

    /// Stable machine-readable code for API error bodies.
    pub fn code(&self) -> &'static str {
        match self {
            CellError::ComputedField => "computed_field",
            CellError::UnknownChoice(_) => "unknown_choice",
            CellError::TooLong { .. } => "too_long",
            CellError::TooMany { .. } => "too_many",
            CellError::Invalid(_) => "invalid_value",
        }
    }
}

/// Resolves ids to display names: linked records' primary field text and
/// collaborators' names. Returning `None` falls back to showing the id.
pub trait NameResolver {
    fn record_name(&self, id: &str) -> Option<String>;
    fn user_name(&self, id: &str) -> Option<String>;
}

/// A [`NameResolver`] that knows no names (ids are shown as-is).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoNames;

impl NameResolver for NoNames {
    fn record_name(&self, _id: &str) -> Option<String> {
        None
    }
    fn user_name(&self, _id: &str) -> Option<String> {
        None
    }
}

/// Maximum attachments in one cell.
pub const MAX_ATTACHMENTS_PER_CELL: usize = 1_000;
/// Maximum length of a URL cell.
pub const MAX_URL_LEN: usize = 2_048;
/// Maximum length of an email cell.
pub const MAX_EMAIL_LEN: usize = 254;
/// Maximum length of a phone cell.
pub const MAX_PHONE_LEN: usize = 64;
