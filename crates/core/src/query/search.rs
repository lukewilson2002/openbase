//! Grid search: case-insensitive substring match over display text.

use chrono_tz::Tz;

use super::Row;
use crate::cell::{NameResolver, display_text, without_embeds};
use crate::field::{Field, FieldKind};
use crate::limits::MAX_SEARCH_LEN;

/// Prepares a user's search text for [`matches_search`]: trimmed and
/// lower-cased once, so the per-row match does no work on the needle.
/// `Err` if it is longer than [`MAX_SEARCH_LEN`] characters.
pub fn search_needle(query: &str) -> Result<String, String> {
    let q = query.trim();
    if q.chars().count() > MAX_SEARCH_LEN {
        return Err(format!(
            "search text is too long (maximum {MAX_SEARCH_LEN} characters)"
        ));
    }
    Ok(q.to_lowercase())
}

/// Whether any of `fields` (normally the view's visible fields) contains
/// `needle` in its display text, ignoring case. `needle` must come from
/// [`search_needle`] (already trimmed and lower-cased); an empty needle
/// matches every row. Embed blocks in rich text (see [`without_embeds`]) are
/// configuration, not words, so they are not searched.
pub fn matches_search(
    row: &dyn Row,
    fields: &[&Field],
    needle: &str,
    names: &dyn NameResolver,
    tz: Tz,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    fields.iter().any(|f| {
        let text = display_text(f, row.get(&f.id), names, tz);
        let text = match f.kind {
            FieldKind::RichText(_) => without_embeds(&text),
            _ => text.into(),
        };
        text.to_lowercase().contains(needle)
    })
}
