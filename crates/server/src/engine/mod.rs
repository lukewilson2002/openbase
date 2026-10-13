//! Engines that sit on top of the store.
//!
//! - [`recompute`]: materializes computed fields (formula, lookup, rollup,
//!   count, button) into `records.data` and keeps them current through a
//!   field dependency graph.
//! - [`write`]: the record write path (create/update/delete/restore/move)
//!   used by the HTTP API and, later, forms, CSV import, the Airtable
//!   compatible API and automations.
//!
//! View queries (filter/sort/group with a result cache) live next to these in
//! a later workstream.

pub mod recompute;
pub mod write;
