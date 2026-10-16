//! View query logic: filter evaluation, sorting, grouping, search,
//! summary-bar aggregations and row colouring.
//!
//! The server streams a table's rows through these functions (and the web
//! client runs the same code), so results are identical on both sides.
//! Rows are anything implementing [`Row`]; field definitions are looked up
//! through [`FieldLookup`] (implemented for maps and slices of [`Field`]).
//!
//! Conventions shared by every function here:
//! - values are read with [`crate::cell::to_value`] / `display_text`, so
//!   computed fields behave per their `result_type`;
//! - **blanks sort first ascending** (and last descending), as Airtable
//!   documents ("blanks first ascending", docs/research/airtable-features.md
//!   §1.2); formula errors sort as blanks;
//! - dates compare by calendar day in the field's fixed zone, else the
//!   viewer's zone (`QueryCtx::timezone` / `tz`).

mod aggregate;
mod dates;
mod filter;
mod search;
mod sort;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value as Json};

use crate::field::{Field, FieldKind};
use crate::ids::FieldId;
use crate::value::ResultType;

pub use aggregate::{aggregate, aggregations_for};
pub use filter::{
    CompiledFilter, CompiledRowColor, compile_filter, compile_row_color, filter_ops_for, matches,
    row_color, row_color_compiled,
};
pub use search::{matches_search, search_needle};
pub use sort::{
    Chunk, EMPTY_GROUP_LABEL, GroupKey, GroupSpan, SortKey, compare, group_key, group_spans,
    sort_key, sort_rows, sort_rows_with_groups, validate_groups, validate_sorts,
};

/// A record as seen by the query functions.
pub trait Row {
    fn id(&self) -> &str;
    /// Stored JSON of one cell (`None` when absent).
    fn get(&self, field_id: &str) -> Option<&Json>;
}

impl<T: Row + ?Sized> Row for &T {
    fn id(&self) -> &str {
        (**self).id()
    }
    fn get(&self, field_id: &str) -> Option<&Json> {
        (**self).get(field_id)
    }
}

/// A row borrowing a record's id and its JSON `data` object.
#[derive(Debug, Clone, Copy)]
pub struct MapRow<'a> {
    pub id: &'a str,
    pub data: &'a Map<String, Json>,
}

impl Row for MapRow<'_> {
    fn id(&self) -> &str {
        self.id
    }
    fn get(&self, field_id: &str) -> Option<&Json> {
        self.data.get(field_id)
    }
}

/// An owned row: a record id and its JSON `data` object.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OwnedRow {
    pub id: String,
    pub data: Map<String, Json>,
}

impl Row for OwnedRow {
    fn id(&self) -> &str {
        &self.id
    }
    fn get(&self, field_id: &str) -> Option<&Json> {
        self.data.get(field_id)
    }
}

/// Context for evaluating filters.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryCtx {
    /// Current time; relative date operands are resolved against it.
    pub now: DateTime<Utc>,
    /// Viewer's zone: resolves "today" and is the zone for date fields
    /// without a fixed zone.
    pub timezone: Tz,
    /// The viewer, for the "me" operand of user filters.
    pub current_user_id: Option<String>,
}

impl QueryCtx {
    pub fn new(now: DateTime<Utc>, timezone: Tz) -> Self {
        Self {
            now,
            timezone,
            current_user_id: None,
        }
    }

    pub fn with_user(self, user_id: impl Into<String>) -> Self {
        Self {
            current_user_id: Some(user_id.into()),
            ..self
        }
    }
}

/// Field definitions by id.
pub type FieldMap = HashMap<FieldId, Field>;

/// Anything that can look up a field definition by id.
pub trait FieldLookup {
    fn field(&self, id: &str) -> Option<&Field>;
}

impl FieldLookup for HashMap<FieldId, Field> {
    fn field(&self, id: &str) -> Option<&Field> {
        self.get(id)
    }
}

impl FieldLookup for HashMap<FieldId, &Field> {
    fn field(&self, id: &str) -> Option<&Field> {
        self.get(id).copied()
    }
}

impl FieldLookup for [Field] {
    fn field(&self, id: &str) -> Option<&Field> {
        self.iter().find(|f| f.id == id)
    }
}

impl FieldLookup for Vec<Field> {
    fn field(&self, id: &str) -> Option<&Field> {
        self.as_slice().field(id)
    }
}

impl FieldLookup for [&Field] {
    fn field(&self, id: &str) -> Option<&Field> {
        self.iter().find(|f| f.id == id).copied()
    }
}

impl FieldLookup for Vec<&Field> {
    fn field(&self, id: &str) -> Option<&Field> {
        self.as_slice().field(id)
    }
}

/// How a field behaves for filtering, sorting and aggregation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Number,
    /// Checkbox, or a formula returning a boolean.
    Bool,
    Select,
    MultiSelect,
    Date,
    Attachment,
    Link,
    User {
        multiple: bool,
    },
    /// Computed arrays (lookups, array formulas): compared by element text.
    List,
    /// Not filterable or sortable (buttons).
    Inert,
}

pub(crate) fn kind_of(field: &Field) -> Kind {
    match &field.kind {
        FieldKind::SingleLineText(_)
        | FieldKind::LongText(_)
        | FieldKind::Email(_)
        | FieldKind::Url(_)
        | FieldKind::Phone(_)
        | FieldKind::Barcode(_) => Kind::Text,
        FieldKind::Number(_)
        | FieldKind::Currency(_)
        | FieldKind::Percent(_)
        | FieldKind::Duration(_)
        | FieldKind::Rating(_)
        | FieldKind::Autonumber(_)
        | FieldKind::Count(_) => Kind::Number,
        FieldKind::Checkbox(_) => Kind::Bool,
        FieldKind::SingleSelect(_) => Kind::Select,
        FieldKind::MultipleSelect(_) => Kind::MultiSelect,
        FieldKind::Date(_) | FieldKind::CreatedTime(_) | FieldKind::LastModifiedTime(_) => {
            Kind::Date
        }
        FieldKind::Attachment(_) => Kind::Attachment,
        FieldKind::Link(_) => Kind::Link,
        FieldKind::User(o) => Kind::User {
            multiple: o.multiple,
        },
        FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_) => Kind::User { multiple: false },
        FieldKind::Formula(o) => kind_of_result(&o.result_type),
        FieldKind::Rollup(o) => kind_of_result(&o.result_type),
        FieldKind::Lookup(o) => kind_of_result(&o.result_type),
        FieldKind::Button(_) => Kind::Inert,
    }
}

fn kind_of_result(rt: &ResultType) -> Kind {
    match rt {
        ResultType::Text => Kind::Text,
        ResultType::Number => Kind::Number,
        ResultType::Bool => Kind::Bool,
        ResultType::Date | ResultType::DateTime => Kind::Date,
        ResultType::Array(_) => Kind::List,
    }
}

/// Whether a cell counts as empty for `is_empty` / summary counts:
/// unchecked checkboxes, absent values, blank text and empty arrays.
/// Formula errors and `false` formula results are not empty.
pub fn is_cell_empty(field: &Field, stored: Option<&Json>) -> bool {
    if let FieldKind::Checkbox(_) = field.kind {
        return !matches!(stored, Some(Json::Bool(true)));
    }
    crate::cell::to_value(field, stored, &crate::cell::NoNames).is_blank()
}
