//! In-app notifications: `GET /api/notifications` (newest first, at most
//! [`LIST_LIMIT`], with the unread count) and `POST /api/notifications/read`
//! (`{"ids": [...]}`; an empty list or no body marks everything read). Both
//! work for sessions and API tokens and only ever touch the caller's own
//! notifications. A token limited to certain bases only sees (and can only
//! mark read) notifications of those bases; a read-only token cannot mark
//! anything read.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use ob_core::api::auth::OkResponse;
use ob_core::api::records::{MarkRead, Notification, NotificationsResponse};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};
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

/// The bases a caller is limited to (None = no limit).
fn base_scope(actor: &Actor) -> Option<&[String]> {
    actor
        .token_scope
        .as_ref()
        .and_then(|s| s.base_ids.as_deref())
}

/// SQL condition (and its parameters) restricting `notifications` rows to
/// `scope`: the payload names one of the bases. Notifications without a
/// `base_id` are hidden from base-limited callers.
fn scope_clause(scope: Option<&[String]>) -> (String, Vec<SqlValue>) {
    match scope {
        None => (String::new(), Vec::new()),
        Some(bases) => {
            let marks = vec!["?"; bases.len()].join(",");
            (
                format!(" AND json_extract(payload, '$.base_id') IN ({marks})"),
                bases.iter().cloned().map(SqlValue::from).collect(),
            )
        }
    }
}

/// A user's newest notifications and their unread count, limited to `scope`
/// when the caller is a base-limited token.
pub fn list_for(
    conn: &Connection,
    user_id: &str,
    scope: Option<&[String]>,
) -> AppResult<NotificationsResponse> {
    let (clause, scope_args) = scope_clause(scope);
    let mut stmt = conn.prepare(&format!(
        "SELECT id, kind, payload, read_at, created_at FROM notifications
         WHERE user_id = ?{clause} ORDER BY created_at DESC, rowid DESC LIMIT {LIST_LIMIT}"
    ))?;
    let mut args: Vec<SqlValue> = vec![user_id.to_string().into()];
    args.extend(scope_args.iter().cloned());
    let notifications = stmt
        .query_map(params_from_iter(&args), |r| {
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
        &format!(
            "SELECT count(*) FROM notifications WHERE user_id = ? AND read_at IS NULL{clause}"
        ),
        params_from_iter(&args),
        |r| r.get(0),
    )?;
    Ok(NotificationsResponse {
        notifications,
        unread: unread as usize,
    })
}

/// Mark the given notifications of `user_id` read (all when `ids` is empty),
/// within `scope` for base-limited callers. Already-read ones keep their
/// original `read_at`; ids that belong to someone else (or are out of scope)
/// are ignored.
pub fn mark_read_for(
    conn: &Connection,
    user_id: &str,
    ids: &[String],
    scope: Option<&[String]>,
) -> AppResult<()> {
    let now = now_ms();
    let (clause, scope_args) = scope_clause(scope);
    let base_args = |mut args: Vec<SqlValue>| {
        args.extend(scope_args.iter().cloned());
        args
    };
    if ids.is_empty() {
        let args = base_args(vec![now.into(), user_id.to_string().into()]);
        conn.execute(
            &format!(
                "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL{clause}"
            ),
            params_from_iter(args),
        )?;
        return Ok(());
    }
    for chunk in ids.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN ({marks}){clause}"
        );
        let mut args: Vec<SqlValue> = vec![now.into(), user_id.to_string().into()];
        args.extend(chunk.iter().cloned().map(Into::into));
        conn.execute(&sql, params_from_iter(base_args(args)))?;
    }
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<NotificationsResponse>> {
    let out = state
        .db
        .read(move |conn| list_for(conn, &actor.user_id, base_scope(&actor)))
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
        .write(move |tx| mark_read_for(tx, &actor.user_id, &body.ids, base_scope(&actor)))
        .await?;
    Ok(Json(OkResponse::new()))
}
