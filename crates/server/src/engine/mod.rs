//! Engines that sit on top of the store.
//!
//! - [`recompute`]: materializes computed fields (formula, lookup, rollup,
//!   count, button) into `records.data` and keeps them current through a
//!   field dependency graph.
//! - [`write`]: the record write path (create/update/delete/restore/move)
//!   used by the HTTP API and, later, forms, CSV import, the Airtable
//!   compatible API and automations.
//!
//! - [`aggregate`]: group-by aggregation (count, sum, avg, min, max per group) over a
//!   table's records.
//! - [`query`]: view queries (filter, search, sort, group, page, summaries and
//!   the link picker lookup) with a bounded result cache.

pub mod aggregate;
pub mod query;
pub mod recompute;
pub mod write;
