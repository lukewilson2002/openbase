//! Data access and business rules. Functions are synchronous and take a
//! `&rusqlite::Connection` (reads) or `&rusqlite::Transaction` (writes), so they
//! are callable from `Db::read`/`Db::write` closures and directly in tests.
pub mod attachments;
pub mod audit;
pub mod bases;
pub mod duplicate;
pub mod field_kind;
pub mod fields;
pub mod fields_engine;
pub mod invites;
pub mod notifications;
pub mod schema;
pub mod tables;
pub mod tokens;
pub mod trash;
pub mod users;
pub mod views;
pub mod workspaces;
