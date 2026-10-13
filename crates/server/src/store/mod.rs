//! Data access and business rules. Functions are synchronous and take a
//! `&rusqlite::Connection` (reads) or `&rusqlite::Transaction` (writes), so they
//! are callable from `Db::read`/`Db::write` closures and directly in tests.
pub mod attachments;
pub mod audit;
pub mod bases;
pub mod comments;
pub mod csv_io;
pub mod duplicate;
pub mod email_settings;
pub mod field_kind;
pub mod fields;
pub mod fields_engine;
pub mod history;
pub mod invites;
pub mod links;
pub mod notifications;
pub mod records;
pub mod schema;
pub mod sharing;
pub mod tables;
pub mod tokens;
pub mod trash;
pub mod users;
pub mod versions;
pub mod views;
pub mod workspaces;
