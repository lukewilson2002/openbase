//! Request/response DTOs shared between the server and the web client.
//! One submodule per API area; each is owned by the workstream building it.
//!
//! # TypeScript conventions (ts-rs, `scripts/gen-types.sh`)
//!
//! Every wire DTO derives `ts_rs::TS` behind the `ts` feature with
//! `ts(export, optional_fields = nullable)`, so each `Option<T>` field becomes
//! `field?: T | null` (serde accepts both an omitted key and `null`).
//!
//! A *request* field that is not an `Option` but has `#[serde(default)]`
//! (a `bool` flag, a `Vec`, a number) is also omittable by clients. ts-rs does
//! not know that, so mark such a field explicitly:
//!
//! ```ignore
//! #[serde(default)]
//! #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
//! pub disable_2fa: bool,
//! ```
//!
//! which emits `disable_2fa?: boolean` (no `| null`: serde rejects `null` for
//! a plain `bool`). Do this on request-only DTOs. Do not do it on response
//! DTOs: the server always sends those fields, so clients should see them as
//! required. Types used in both directions keep the response view.

pub mod auth;
pub mod automations;
pub mod events;
pub mod records;
pub mod schema;
pub mod sharing;
pub mod v1;
pub mod workspaces;
