//! The inbox: a user's private quick-capture drafts.
//!
//! - `GET /api/inbox` lists the caller's drafts, most recently changed first.
//! - `POST /api/inbox` (`{body, attachments?}`, 201) adds one.
//! - `PATCH /api/inbox/{id}` changes the text and/or the list of files.
//! - `DELETE /api/inbox/{id}` deletes a draft (204; there is no trash for drafts).
//! - `POST /api/inbox/attachments` (multipart field `file`) uploads a file that
//!   belongs to no base yet; only its uploader can download it. Put the returned
//!   reference in a draft's `attachments`.
//! - `POST /api/inbox/{id}/file` (`{table_id, fields}`, 201) files a draft: it
//!   creates a record in the table through the normal record write path (so the
//!   caller needs the Editor role there, and validation, history, events and
//!   automations all apply), hands the draft's files that `fields` uses over to
//!   the table's base, and deletes the draft, all in one transaction. The answer
//!   is the created record.
//!
//! Everything works for sessions and API tokens (read-only tokens can only
//! list) and only ever touches the caller's own drafts: someone else's draft is
//! a 404, like a missing one. A token limited to specific bases gets a 403 on
//! every inbox route (filing included) and on downloading an inbox file: the
//! inbox belongs to no base, so such a token has no business in it.
//!
//! Limits: [`ob_core::limits::MAX_INBOX_ITEMS`] drafts per user,
//! [`ob_core::limits::MAX_INBOX_ATTACHMENTS`] files per draft, a file can be in
//! one draft only, a user's unattached files add up to at most
//! `OPENBASE_MAX_INBOX_MB` (413 beyond), and uploads are rate limited
//! ([`UPLOAD_LIMIT`] per minute per user, 429).

use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use ob_core::api::inbox::{CreateInboxItem, FileInboxItem, InboxItem, UpdateInboxItem};
use ob_core::api::records::{NewRecord, Record};
use ob_core::field::AttachmentRef;

use crate::auth::Actor;
use crate::engine::write::{self, CreateOpts, WriteCtx, WriteSource};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::{inbox, records as record_store, schema};
use crate::v1::input::convert_fields;

/// Inbox uploads per user per minute.
pub const UPLOAD_LIMIT: u32 = 60;
const MINUTE: std::time::Duration = std::time::Duration::from_secs(60);

const WHAT: &str = "the inbox";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/inbox", get(list).post(create))
        .route(
            "/api/inbox/attachments",
            // The size limit is enforced per request in `multipart_with_limit`.
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/inbox/{id}", patch(update).delete(remove))
        .route("/api/inbox/{id}/file", post(file))
}

async fn list(State(state): State<AppState>, actor: Actor) -> AppResult<Json<Vec<InboxItem>>> {
    actor.require_no_base_limit(WHAT)?;
    let items = state
        .db
        .read(move |conn| inbox::list(conn, &actor.user_id))
        .await?;
    Ok(Json(items))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ApiJson(body): ApiJson<CreateInboxItem>,
) -> AppResult<(StatusCode, Json<InboxItem>)> {
    actor.require_no_base_limit(WHAT)?;
    let item = state
        .db
        .write(move |tx| {
            inbox::create(
                tx,
                &actor.user_id,
                &body.body,
                body.attachments.as_deref().unwrap_or_default(),
            )
        })
        .await?;
    Ok((StatusCode::CREATED, Json(item)))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateInboxItem>,
) -> AppResult<Json<InboxItem>> {
    actor.require_no_base_limit(WHAT)?;
    let item = state
        .db
        .write(move |tx| {
            inbox::update(
                tx,
                &actor.user_id,
                &id,
                body.body.as_deref(),
                body.attachments.as_deref(),
            )
        })
        .await?;
    Ok(Json(item))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_no_base_limit(WHAT)?;
    state
        .db
        .write(move |tx| inbox::delete(tx, &actor.user_id, &id))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload(
    State(state): State<AppState>,
    actor: Actor,
    req: Request,
) -> AppResult<Json<AttachmentRef>> {
    actor.require_no_base_limit("the inbox or its files")?;
    state
        .limiter
        .check("inbox_upload", &actor.user_id, UPLOAD_LIMIT, MINUTE)?;
    let multipart = crate::api::attachments::multipart_with_limit(&state, req).await?;
    let saved =
        crate::api::attachments::save_upload(&state, None, Some(actor.user_id), multipart).await?;
    Ok(Json(saved))
}

async fn file(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<FileInboxItem>,
) -> AppResult<(StatusCode, Json<Record>)> {
    // Filing reads the draft, which is outside every base; refused before the
    // table is even looked at.
    actor.require_no_base_limit(WHAT)?;
    let who = actor.clone();
    let (outcome, record) = state
        .db
        .write(move |tx| {
            // The draft first: someone else's is a 404 whatever the table is.
            let item = inbox::get(tx, &actor.user_id, &id)?;
            let base_id = perm::base_of_table(tx, &body.table_id)?;
            perm::require_base(tx, &actor, &base_id, Role::Editor)?;
            let fields = schema::table_fields(tx, &body.table_id)?;
            // The files the caller puts into the record move into the base
            // first: a record may only hold files of its own base.
            inbox::move_files_to_base(tx, &actor.user_id, &item, &base_id, &fields, &body.fields)?;
            let values = convert_fields(tx, &base_id, &fields, &body.fields, true, false)
                .map_err(|e| AppError::bad_request(e.message))?;
            let ctx = WriteCtx::for_user(tx, &actor.user_id, WriteSource::Api)?.typecast(true);
            let outcome = write::create_records(
                tx,
                &ctx,
                &body.table_id,
                vec![NewRecord { values }],
                &CreateOpts::default(),
            )?;
            let created = outcome.target().created.to_vec();
            let record = record_store::load_dtos(tx, &body.table_id, &created, ctx.timezone)?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::internal("the filed record was not created"))?;
            inbox::delete(tx, &actor.user_id, &id)?;
            Ok((outcome, record))
        })
        .await?;
    crate::api::records::publish_outcome(&state, &headers, &who, &outcome);
    Ok((StatusCode::CREATED, Json(record)))
}
