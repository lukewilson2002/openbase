//! Data access and business rules. Functions are synchronous and take a
//! `&rusqlite::Connection` (reads) or `&rusqlite::Transaction` (writes), so they
//! are callable from `Db::read`/`Db::write` closures and directly in tests.
pub mod attachments;
pub mod audit;
pub mod invites;
pub mod notifications;
pub mod tokens;
pub mod users;
