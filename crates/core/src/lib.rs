//! OpenBase core.
//!
//! Everything in this crate is pure (no I/O, no clock reads except where a
//! `now` is passed in) so it can be unit-tested exhaustively and compiled to
//! WASM for the browser.
//!
//! Module map:
//! - [`field`]   field definitions and per-type options (the schema contract)
//! - [`view`]    view configuration: filters, sorts, groups, per-view-type settings
//! - [`value`]   the runtime value type used by formulas, filters and sorting
//! - [`cell`]    validation/coercion of stored cell JSON, type conversion, display text
//! - [`formula`] formula lexer, parser, type checker and evaluator
//! - [`query`]   filter evaluation, sort comparators, grouping, aggregations
//! - [`api`]     request/response DTOs shared by server and web client
//! - [`limits`]  hard limits enforced by the server and mirrored in the UI

pub mod api;
pub mod cell;
pub mod deps;
pub mod field;
pub mod formula;
pub mod limits;
pub mod query;
pub mod value;
pub mod view;

/// Identifier types. Ids are opaque strings with a type prefix, e.g. `rec7Hq2...`.
/// Generation lives in the server (it needs a CSPRNG); the prefixes live here.
pub mod ids {
    pub type UserId = String;
    pub type WorkspaceId = String;
    pub type BaseId = String;
    pub type TableId = String;
    pub type FieldId = String;
    pub type RecordId = String;
    pub type ViewId = String;
    pub type ChoiceId = String;
    pub type AttachmentId = String;

    pub const USER: &str = "usr";
    pub const WORKSPACE: &str = "wsp";
    pub const BASE: &str = "app";
    pub const TABLE: &str = "tbl";
    pub const FIELD: &str = "fld";
    pub const RECORD: &str = "rec";
    pub const VIEW: &str = "viw";
    pub const CHOICE: &str = "sel";
    pub const ATTACHMENT: &str = "att";
    pub const COMMENT: &str = "com";
    pub const AUTOMATION: &str = "aut";
    pub const SHARE: &str = "shr";
    pub const TOKEN: &str = "pat";
    pub const INVITE: &str = "inv";
    pub const NOTIFICATION: &str = "ntf";
    /// A draft in a user's inbox (quick capture, not yet filed into a table).
    pub const INBOX: &str = "inb";
    /// OAuth client ids handed out by dynamic registration and `openbase oauth-client add`.
    pub const OAUTH_CLIENT: &str = "ocl";
    /// A user's OAuth grant ("connected app").
    pub const OAUTH_GRANT: &str = "grt";
    /// A pending OAuth authorization request (carried to the consent page).
    pub const OAUTH_REQUEST: &str = "oar";
}
