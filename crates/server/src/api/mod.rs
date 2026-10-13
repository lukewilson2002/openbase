//! HTTP handlers, one module per API area. Each module exposes `router()`;
//! handlers stay thin and delegate to `store`/`engine` functions.

pub mod admin;
pub mod admin_email;
pub mod attachments;
pub mod auth;
pub mod automations;
pub mod backups;
pub mod bases;
pub mod comments;
pub mod csv;
pub mod events;
pub mod fields;
pub mod invites;
pub mod notifications;
pub mod oauth;
pub mod records;
pub mod schema_support;
pub mod sharing;
pub mod tables;
pub mod tokens;
pub mod trash;
pub mod v1;
pub mod views;
pub mod workspaces;

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(auth::router())
        .merge(admin::router())
        .merge(admin_email::router())
        .merge(backups::router())
        .merge(tokens::router())
        .merge(oauth::router())
        .merge(invites::router())
        .merge(workspaces::router())
        .merge(bases::router())
        .merge(tables::router())
        .merge(fields::router())
        .merge(views::router())
        .merge(trash::router())
        .merge(records::router())
        .merge(comments::router())
        .merge(events::router())
        .merge(attachments::router())
        .merge(csv::router())
        .merge(sharing::router())
        .merge(automations::router())
        .merge(notifications::router())
        .merge(v1::router())
}
