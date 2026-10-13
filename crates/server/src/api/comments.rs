//! Record comments.
//!
//! `GET|POST /api/records/{id}/comments` (Viewer reads, Commenter posts),
//! `PATCH|DELETE /api/comments/{id}` (only the author edits; the author or a
//! base Owner deletes). Mentions (`@[Name](usrXXXX)`) notify the mentioned
//! users who can read the base; see `store::comments`. Every change publishes
//! `CommentsChanged` after it commits.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch};
use axum::{Json, Router};
use og_core::api::records::{Comment, CommentBody};

use crate::api::schema_support::{publish};
use crate::extract::ApiJson;
use crate::auth::Actor;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::{comments, records};
use og_core::api::events::BaseEvent;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/records/{id}/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/api/comments/{id}",
            patch(update_comment).delete(delete_comment),
        )
}

async fn list_comments(
    State(state): State<AppState>,
    actor: Actor,
    Path(record_id): Path<String>,
) -> AppResult<Json<Vec<Comment>>> {
    let list = state
        .db
        .read(move |conn| {
            let base = perm::base_of_record(conn, &record_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            comments::list(conn, &record_id)
        })
        .await?;
    Ok(Json(list))
}

async fn create_comment(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(record_id): Path<String>,
    ApiJson(body): ApiJson<CommentBody>,
) -> AppResult<(StatusCode, Json<Comment>)> {
    let who = actor.clone();
    let rid = record_id.clone();
    let (base, comment) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_record(tx, &rid)?;
            perm::require_base(tx, &actor, &base, Role::Commenter)?;
            match records::get(tx, &rid)? {
                Some(r) if r.is_live() => {}
                _ => return Err(AppError::not_found("record")),
            }
            let comment = comments::create(tx, &rid, &actor.user_id, &body.body, now_ms())?;
            Ok((base, comment))
        })
        .await?;
    publish(
        &state,
        &headers,
        &who,
        &base,
        BaseEvent::CommentsChanged { record_id },
    );
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn update_comment(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CommentBody>,
) -> AppResult<Json<Comment>> {
    let who = actor.clone();
    let (base, comment) = state
        .db
        .write(move |tx| {
            let row = comments::get(tx, &id)?;
            perm::require_base(tx, &actor, &row.base_id, Role::Commenter)?;
            if row.comment.user_id.as_deref() != Some(actor.user_id.as_str()) {
                return Err(AppError::forbidden("only the author can edit a comment"));
            }
            let comment = comments::update(tx, &id, &body.body, now_ms())?;
            Ok((row.base_id, comment))
        })
        .await?;
    publish(
        &state,
        &headers,
        &who,
        &base,
        BaseEvent::CommentsChanged {
            record_id: comment.record_id.clone(),
        },
    );
    Ok(Json(comment))
}

async fn delete_comment(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let who = actor.clone();
    let (base, record_id) = state
        .db
        .write(move |tx| {
            let row = comments::get(tx, &id)?;
            let role = perm::require_base(tx, &actor, &row.base_id, Role::Viewer)?;
            let is_author = row.comment.user_id.as_deref() == Some(actor.user_id.as_str());
            if !is_author && role < Role::Owner {
                return Err(AppError::forbidden(
                    "only the author or a base owner can delete a comment",
                ));
            }
            comments::delete(tx, &id)?;
            Ok((row.base_id, row.comment.record_id))
        })
        .await?;
    publish(
        &state,
        &headers,
        &who,
        &base,
        BaseEvent::CommentsChanged { record_id },
    );
    Ok(StatusCode::NO_CONTENT)
}
