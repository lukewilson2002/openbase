//! Request/response DTOs shared between the server and the web client.
//! One submodule per API area; each is owned by the workstream building it.

pub mod auth;
pub mod automations;
pub mod events;
pub mod records;
pub mod schema;
pub mod sharing;
pub mod workspaces;
