//! Grid search: case-insensitive substring match over display text.

use chrono_tz::Tz;

use super::Row;
use crate::cell::{NameResolver, display_text};
use crate::field::Field;

/// Whether any of `fields` (normally the view's visible fields) contains
/// `query` in its display text, ignoring case. The query is trimmed; an
/// empty query matches every row.
pub fn matches_search(
    row: &dyn Row,
    fields: &[&Field],
    query: &str,
    names: &dyn NameResolver,
    tz: Tz,
) -> bool {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    fields.iter().any(|f| {
        display_text(f, row.get(&f.id), names, tz)
            .to_lowercase()
            .contains(&needle)
    })
}
