//! Hard limits. The server enforces them; the UI mirrors them for early feedback.
//! These are deliberately conservative for a 1 vCPU / 1 GB VPS; see
//! docs/plans/2026-10-12-openbase.md "Scale limits".

pub const MAX_NAME_LEN: usize = 255;
pub const MAX_DESCRIPTION_LEN: usize = 20_000;
pub const MAX_TEXT_CELL_LEN: usize = 100_000;
pub const MAX_FORMULA_LEN: usize = 10_000;
pub const MAX_FIELDS_PER_TABLE: usize = 500;
pub const MAX_TABLES_PER_BASE: usize = 200;
pub const MAX_VIEWS_PER_TABLE: usize = 200;
pub const MAX_CHOICES_PER_FIELD: usize = 1_000;
pub const MAX_LINKS_PER_CELL: usize = 10_000;
pub const MAX_RECORDS_PER_TABLE: usize = 100_000;
pub const MAX_RECORDS_PER_BATCH: usize = 1_000;
pub const MAX_COMMENT_LEN: usize = 10_000;
pub const MAX_FILTER_DEPTH: usize = 3;
pub const MAX_FILTER_CONDITIONS: usize = 100;
pub const MAX_SORTS: usize = 10;
pub const MAX_GROUPS: usize = 3;
/// Longest grid search text, in characters.
pub const MAX_SEARCH_LEN: usize = 500;
pub const MAX_PAGE_SIZE: usize = 1_000;
/// Formula evaluation nesting (function calls / computed field chains).
pub const MAX_FORMULA_DEPTH: usize = 64;
