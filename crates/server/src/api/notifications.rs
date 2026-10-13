//! In-app notifications: `GET /api/notifications` (newest first, at most
//! [`LIST_LIMIT`], with the unread count) and `POST /api/notifications/read`
//! (`{"ids": [...]}`; an empty list or no body marks everything read). Both
//! work for sessions and API tokens and only ever touch the caller's own
//! notifications.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use og_core::api::auth::OkResponse;
use og_core::api::records::{MarkRead, Notification, NotificationsResponse};
use rusqlite::{Connection, params, params_from_iter};
use serde_json::Value as Json2;

use crate::api::schema_support::OptionalJson;
use crate::auth::Actor;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::state::AppState;

/// Notifications returned by one `GET /api/notifications`.
pub const LIST_LIMIT: usize = 50;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list))
        .route("/api/notifications/read", post(mark_read))
}

/// A user's newest notifications and their unread count.
pub fn list_for(conn: &Connection, user_id: &str) -> AppResult<NotificationsResponse> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, payload, read_at, created_at FROM notifications
         WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let notifications = stmt
        .query_map(params![user_id, LIST_LIMIT as i64], |r| {
            let payload: String = r.get(2)?;
            Ok(Notification {
                id: r.get(0)?,
                kind: r.get(1)?,
                payload: serde_json::from_str::<Json2>(&payload).unwrap_or(Json2::Null),
                read_at: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let unread: i64 = conn.query_row(
        "SELECT count(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL",
        [user_id],
        |r| r.get(0),
    )?;
    Ok(NotificationsResponse {
        notifications,
        unread: unread as usize,
    })
}

/// Mark the given notifications of `user_id` read (all when `ids` is empty).
/// Already-read ones keep their original `read_at`; ids that belong to
/// someone else are ignored.
pub fn mark_read_for(conn: &Connection, user_id: &str, ids: &[String]) -> AppResult<()> {
    let now = now_ms();
    if ids.is_empty() {
        conn.execute(
            "UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL",
            params![user_id, now],
        )?;
        return Ok(());
    }
    for chunk in ids.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN ({marks})"
        );
        let mut args: Vec<rusqlite::types::Value> = vec![now.into(), user_id.to_string().into()];
        args.extend(chunk.iter().cloned().map(Into::into));
        conn.execute(&sql, params_from_iter(args))?;
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<NotificationsResponse>> {
    let out = state
        .db
        .read(move |conn| list_for(conn, &actor.user_id))
        .await?;
    Ok(Json(out))
}

async fn mark_read(
    State(state): State<AppState>,
    actor: Actor,
    OptionalJson(body): OptionalJson<MarkRead>,
) -> AppResult<Json<OkResponse>> {
    state
        .db
        .write(move |tx| mark_read_for(tx, &actor.user_id, &body.ids))
        .await?;
    Ok(Json(OkResponse::new()))
}
