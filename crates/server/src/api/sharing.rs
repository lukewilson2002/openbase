//! Share links and the public endpoints behind them.
//!
//! **Management** (signed-in Creator on the view's base):
//! `GET|POST /api/views/{id}/shares`, `PATCH|DELETE /api/shares/{id}`.
//!
//! **Public** (no credentials; the unguessable token is the capability):
//! - `GET  /api/public/shares/{token}`: the shared view (layout + visible fields);
//! - `POST /api/public/shares/{token}/query`: records of the view (`QueryRequest`);
//! - `GET  /api/public/forms/{token}`: the form definition;
//! - `POST /api/public/forms/{token}/submit`: create one record anonymously;
//! - `POST /api/public/forms/{token}/attachments`: upload a file for an
//!   attachment field of the form.
//!
//! Attachments of shared views are downloaded through the existing
//! `GET /api/attachments/{id}/{filename}?share=<token>` route.
//!
//! Rules every public endpoint follows:
//! - a disabled link, a link of the wrong kind, or one whose view, table,
//!   base or workspace is deleted answers 404, like an unknown token;
//! - a password-protected link answers 401 `share_password_required` without
//!   the `X-Share-Password` header and 401 `share_password_invalid` with a
//!   wrong one (verified with Argon2id);
//! - requests are rate limited per client IP and per token, password checks
//!   and form traffic more tightly;
//! - responses carry `Cache-Control: no-store`;
//! - only fields visible in the view / included in the form are ever read or
//!   written, and records never carry user ids, e-mail addresses or
//!   creator/editor metadata (see [`crate::store::sharing`]).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use og_core::api::records::{QueryRequest, TransientConfig};
use og_core::api::sharing::{
    CreateShare, FormSubmission, PublicForm, PublicFormField, PublicQueryResponse, PublicView,
    ShareKind, ShareLink, UpdateShare,
};
use og_core::cell::{CellCtx, missing_choices, normalize};
use og_core::field::{AttachmentRef, Field, FieldKind};
use og_core::view::{Filter, FilterItem, RowColor};
use serde_json::{Value as Json2, json};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::auth::{Actor, ClientInfo};
use crate::engine::query;
use crate::engine::write::{CreateOpts, WriteCtx, WriteSource, create_records};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::sharing::{self, Resolved};
use crate::store::{audit, schema};

/// Public requests per client IP per minute (all public endpoints together).
pub const IP_LIMIT: u32 = 300;
/// Public requests per share token per minute.
pub const TOKEN_LIMIT: u32 = 1200;
/// Password verifications per (client IP, token) per minute. Argon2 is
/// deliberately slow, so guessing is throttled hard.
pub const PASSWORD_LIMIT: u32 = 30;
/// Form submissions per (client IP, token) per [`SUBMIT_WINDOW`].
pub const SUBMIT_LIMIT: u32 = 20;
pub const SUBMIT_WINDOW: Duration = Duration::from_secs(600);
/// File uploads per (client IP, token) per [`SUBMIT_WINDOW`].
pub const UPLOAD_LIMIT: u32 = 20;
/// Largest file a public form accepts (further capped by the configured
/// upload limit).
pub const PUBLIC_UPLOAD_MAX: u64 = 25 * 1024 * 1024;
/// Byte budgets for anonymous form uploads, in MB per [`UPLOAD_BYTES_WINDOW`]
/// (in memory: a restart resets them). A request is charged when it starts,
/// for its declared length (the 25 MB cap when the client declares none), so
/// parallel uploads cannot overshoot. Per client IP, per base, and for the
/// whole server.
pub const UPLOAD_MB_PER_IP: u32 = 200;
pub const UPLOAD_MB_PER_BASE: u32 = 500;
pub const UPLOAD_MB_GLOBAL: u32 = 1000;
pub const UPLOAD_BYTES_WINDOW: Duration = Duration::from_secs(3600);
/// Password length bounds for share links.
pub const MIN_SHARE_PASSWORD: usize = 4;
pub const MAX_SHARE_PASSWORD: usize = 256;

const MINUTE: Duration = Duration::from_secs(60);
const PASSWORD_HEADER: &str = "x-share-password";

pub fn router() -> Router<AppState> {
    let public = Router::new()
        .route("/api/public/shares/{token}", get(public_view))
        .route("/api/public/shares/{token}/query", post(public_query))
        .route("/api/public/forms/{token}", get(public_form))
        .route("/api/public/forms/{token}/submit", post(submit_form))
        .route(
            "/api/public/forms/{token}/attachments",
            post(upload_form_file).layer(DefaultBodyLimit::disable()),
        )
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));
    Router::new()
        .route("/api/views/{id}/shares", get(list).post(create))
        .route("/api/shares/{id}", patch(update).delete(remove))
        .merge(public)
}

// ------------------------------------------------------------ management

fn validate_password(pw: &str) -> AppResult<()> {
    let n = pw.chars().count();
    if !(MIN_SHARE_PASSWORD..=MAX_SHARE_PASSWORD).contains(&n) {
        return Err(AppError::bad_request(format!(
            "a share password must be {MIN_SHARE_PASSWORD} to {MAX_SHARE_PASSWORD} characters"
        )));
    }
    Ok(())
}

fn creator_on_view(
    conn: &rusqlite::Connection,
    actor: &Actor,
    view_id: &str,
) -> AppResult<schema::ViewRow> {
    let base = perm::base_of_view(conn, view_id)?;
    perm::require_base(conn, actor, &base, Role::Creator)?;
    schema::live_view(conn, view_id)
}

async fn list(
    State(state): State<AppState>,
    actor: Actor,
    Path(view_id): Path<String>,
) -> AppResult<Json<Vec<ShareLink>>> {
    let url = state.config.public_url.clone();
    let rows = state
        .db
        .read(move |conn| {
            creator_on_view(conn, &actor, &view_id)?;
            sharing::list_for_view(conn, &view_id)
        })
        .await?;
    Ok(Json(rows.iter().map(|r| r.to_dto(&url)).collect()))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(view_id): Path<String>,
    ApiJson(body): ApiJson<CreateShare>,
) -> AppResult<(StatusCode, Json<ShareLink>)> {
    let hash = match body.password.as_deref() {
        None => None,
        Some(pw) => {
            validate_password(pw)?;
            Some(crate::auth::password::hash_async(pw.to_string()).await?)
        }
    };
    let url = state.config.public_url.clone();
    let row = state
        .db
        .write(move |tx| {
            let view = creator_on_view(tx, &actor, &view_id)?;
            sharing::ensure_shareable(&view, body.kind)?;
            let row = sharing::create(tx, &view_id, body.kind, hash, &actor.user_id)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                "share_create",
                Some(&row.id),
                Some(json!({
                    "view_id": view_id,
                    "kind": body.kind.as_str(),
                    "password": row.password_hash.is_some(),
                })),
                Some(&client.ip),
            )?;
            Ok(row)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(row.to_dto(&url))))
}

/// The share `id` and the caller's Creator check on its view's base.
fn creator_on_share(
    conn: &rusqlite::Connection,
    actor: &Actor,
    id: &str,
) -> AppResult<sharing::ShareRow> {
    let share = sharing::get(conn, id)?.ok_or_else(|| AppError::not_found("share link"))?;
    creator_on_view(conn, actor, &share.view_id)?;
    Ok(share)
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateShare>,
) -> AppResult<Json<ShareLink>> {
    let hash = match body.password {
        None => None,
        Some(None) => Some(None),
        Some(Some(pw)) => {
            validate_password(&pw)?;
            Some(Some(crate::auth::password::hash_async(pw).await?))
        }
    };
    let url = state.config.public_url.clone();
    let enabled = body.enabled;
    let row = state
        .db
        .write(move |tx| {
            creator_on_share(tx, &actor, &id)?;
            let row = sharing::update(tx, &id, enabled, hash.clone())?;
            audit::record(
                tx,
                Some(&actor.user_id),
                "share_update",
                Some(&id),
                Some(json!({
                    "enabled": enabled,
                    "password": hash.as_ref().map(Option::is_some),
                })),
                Some(&client.ip),
            )?;
            Ok(row)
        })
        .await?;
    Ok(Json(row.to_dto(&url)))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    state
        .db
        .write(move |tx| {
            creator_on_share(tx, &actor, &id)?;
            sharing::delete(tx, &id)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                "share_delete",
                Some(&id),
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- public

/// Errors of the public endpoints: the standard envelope plus the two
/// password answers.
#[derive(Debug)]
pub enum PublicError {
    App(AppError),
    PasswordRequired,
    PasswordInvalid,
}

impl From<AppError> for PublicError {
    fn from(e: AppError) -> Self {
        PublicError::App(e)
    }
}

impl IntoResponse for PublicError {
    fn into_response(self) -> Response {
        let (code, message) = match self {
            PublicError::App(e) => return e.into_response(),
            PublicError::PasswordRequired => (
                "share_password_required",
                "this link is protected by a password",
            ),
            PublicError::PasswordInvalid => ("share_password_invalid", "the password is incorrect"),
        };
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response()
    }
}

type PublicResult<T> = Result<T, PublicError>;

/// Rate limit, resolve and password-check a public request.
async fn authorize(
    state: &AppState,
    client: &ClientInfo,
    headers: &HeaderMap,
    token: &str,
    kind: ShareKind,
) -> PublicResult<Resolved> {
    state
        .limiter
        .check("public_ip", &client.ip, IP_LIMIT, MINUTE)?;
    let t = token.to_string();
    let resolved = state
        .db
        .read(move |conn| sharing::resolve(conn, &t, kind))
        .await?;
    state
        .limiter
        .check("public_token", token, TOKEN_LIMIT, MINUTE)?;
    if let Some(hash) = resolved.share.password_hash.clone() {
        let given = headers
            .get(PASSWORD_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if given.is_empty() {
            return Err(PublicError::PasswordRequired);
        }
        state.limiter.check(
            "share_password",
            &format!("{}|{token}", client.ip),
            PASSWORD_LIMIT,
            MINUTE,
        )?;
        if !crate::auth::password::verify_async(given.to_string(), hash).await? {
            return Err(PublicError::PasswordInvalid);
        }
    }
    Ok(resolved)
}

async fn public_view(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> PublicResult<Json<PublicView>> {
    let r = authorize(&state, &client, &headers, &token, ShareKind::View).await?;
    let table_id = r.table.id.clone();
    let fields = state
        .db
        .read(move |conn| schema::table_fields(conn, &table_id))
        .await?;
    let visible = sharing::visible_fields(&r.view.view.config, &fields);
    let ids: HashSet<&str> = visible.iter().map(|f| f.id.as_str()).collect();
    Ok(Json(PublicView {
        kind: ShareKind::View,
        name: r.view.view.name.clone(),
        view_type: r.view.view.view_type,
        table_name: r.table.name.clone(),
        base_name: r.base_name.clone(),
        fields: visible.iter().map(sharing::public_field).collect(),
        config: sharing::public_config(&r.view.view.config, &ids),
    }))
}

async fn public_query(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Path(token): Path<String>,
    ApiJson(req): ApiJson<QueryRequest>,
) -> PublicResult<Json<PublicQueryResponse>> {
    let r = authorize(&state, &client, &headers, &token, ShareKind::View).await?;
    let cache = state.query_cache.clone();
    let versions = state.events.versions().clone();
    let response = state
        .db
        .read(move |conn| {
            let fields = schema::table_fields(conn, &r.table.id)?;
            let config = &r.view.view.config;
            let visible = sharing::visible_fields(config, &fields);
            let ids: HashSet<&str> = visible.iter().map(|f| f.id.as_str()).collect();
            // A date range on a hidden field would let a visitor probe it.
            if let Some(range) = &req.range {
                let end = range.end_field_id.as_deref().filter(|s| !s.is_empty());
                if !ids.contains(range.field_id.as_str()) || end.is_some_and(|e| !ids.contains(e)) {
                    return Err(AppError::bad_request(
                        "range refers to a field that is not shown in this view",
                    ));
                }
            }
            // A one-off filter/sort/group on a hidden field would be an
            // oracle for its values, so it may only use shown fields.
            if let Some(t) = &req.transient {
                ensure_transient_visible(t, &ids)?;
            }
            // No signed-in user: "me" filters match nobody and dates use UTC
            // unless the request names a zone.
            let mut resp = query::run_query(conn, &cache, &versions, "", &r.view, &req)?;
            let mut names: HashMap<String, Option<String>> = HashMap::new();
            let records = resp
                .records
                .drain(..)
                .map(|rec| sharing::public_record(conn, rec, &visible, &mut names))
                .collect();
            resp.groups.retain(|g| ids.contains(g.field_id.as_str()));
            let colors_ok = matches!(
                &config.row_color,
                Some(RowColor::BySelect { field_id }) if ids.contains(field_id.as_str())
            );
            Ok(PublicQueryResponse {
                total: resp.total,
                offset: resp.offset,
                records,
                groups: resp.groups,
                colors: if colors_ok {
                    resp.colors
                } else {
                    Default::default()
                },
            })
        })
        .await?;
    Ok(Json(response))
}

fn filter_field_ids<'a>(filter: &'a Filter, out: &mut Vec<&'a str>) {
    for item in &filter.items {
        match item {
            FilterItem::Condition(c) => out.push(c.field_id.as_str()),
            FilterItem::Group(g) => filter_field_ids(g, out),
        }
    }
}

/// Reject a transient override that names a field the visitor may not see.
fn ensure_transient_visible(t: &TransientConfig, visible: &HashSet<&str>) -> AppResult<()> {
    let mut used: Vec<&str> = Vec::new();
    if let Some(f) = &t.filter {
        filter_field_ids(f, &mut used);
    }
    for s in t.sorts.iter().chain(t.groups.iter()).flatten() {
        used.push(s.field_id.as_str());
    }
    if used.iter().any(|id| !visible.contains(id)) {
        return Err(AppError::bad_request(
            "transient refers to a field that is not shown in this view",
        ));
    }
    Ok(())
}

fn http_url(url: &Option<String>) -> Option<String> {
    url.as_deref()
        .map(str::trim)
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .map(str::to_string)
}

async fn public_form(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> PublicResult<Json<PublicForm>> {
    let r = authorize(&state, &client, &headers, &token, ShareKind::Form).await?;
    let table_id = r.table.id.clone();
    let fields = state
        .db
        .read(move |conn| schema::table_fields(conn, &table_id))
        .await?;
    let cfg = &r.view.view.config;
    let form = &cfg.form;
    let inputs = sharing::form_fields(cfg, &fields)
        .into_iter()
        .map(|(entry, field)| PublicFormField {
            label: entry
                .label
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or(&field.name)
                .to_string(),
            help: entry.help.clone().filter(|h| !h.trim().is_empty()),
            required: entry.required,
            field_type: field.field_type(),
            options: sharing::public_options(&field),
            id: field.id,
        })
        .collect();
    let or = |s: &str, default: &str| {
        if s.trim().is_empty() {
            default.to_string()
        } else {
            s.to_string()
        }
    };
    Ok(Json(PublicForm {
        title: or(&form.title, &r.view.view.name),
        description: form.description.clone(),
        base_name: r.base_name.clone(),
        table_name: r.table.name.clone(),
        fields: inputs,
        submit_label: or(&form.submit_label, "Submit"),
        success_message: or(
            &form.success_message,
            "Thanks! Your response has been recorded.",
        ),
        redirect_url: http_url(&form.redirect_url),
        show_submit_another: form.show_submit_another,
    }))
}

fn form_error(field: &Field, msg: impl std::fmt::Display) -> AppError {
    AppError::bad_request(format!("field \"{}\": {msg}", field.name))
}

/// Check a submission against the form and return the values to write.
fn validate_submission(
    cfg: &og_core::view::ViewConfig,
    fields: &[Field],
    submission: FormSubmission,
) -> AppResult<std::collections::BTreeMap<String, Json2>> {
    let inputs = sharing::form_fields(cfg, fields);
    if inputs.is_empty() {
        return Err(AppError::bad_request("this form has no fields"));
    }
    let allowed: HashSet<&str> = inputs.iter().map(|(_, f)| f.id.as_str()).collect();
    if let Some(bad) = submission
        .values
        .keys()
        .find(|k| !allowed.contains(k.as_str()))
    {
        return Err(AppError::bad_request(format!(
            "\"{bad}\" is not a field of this form"
        )));
    }
    let cell_ctx = CellCtx::utc(chrono::Utc::now()).with_typecast(true);
    let mut out = std::collections::BTreeMap::new();
    for (entry, field) in &inputs {
        let value = submission.values.get(&field.id).filter(|v| !v.is_null());
        let normalized = match value {
            None => None,
            Some(v) => {
                // Lenient parsing (typecast) must never invent select choices.
                if let Some(name) = missing_choices(field, v).first() {
                    return Err(form_error(field, format!("unknown option \"{name}\"")));
                }
                normalize(field, v, &cell_ctx).map_err(|e| form_error(field, e))?
            }
        };
        match (normalized, value) {
            (Some(_), Some(v)) => {
                out.insert(field.id.clone(), v.clone());
            }
            _ if entry.required => {
                return Err(AppError::bad_request(format!(
                    "field \"{}\" is required",
                    field.name
                )));
            }
            _ => {}
        }
    }
    if out.is_empty() {
        return Err(AppError::bad_request("the form is empty"));
    }
    Ok(out)
}

async fn submit_form(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Path(token): Path<String>,
    ApiJson(body): ApiJson<FormSubmission>,
) -> PublicResult<Json<Json2>> {
    authorize(&state, &client, &headers, &token, ShareKind::Form).await?;
    state.limiter.check(
        "form_submit",
        &format!("{}|{token}", client.ip),
        SUBMIT_LIMIT,
        SUBMIT_WINDOW,
    )?;
    let t = token.clone();
    let outcome = state
        .db
        .write(move |tx| {
            // Re-resolve inside the transaction: the form may have been
            // disabled or edited since the checks above.
            let r = sharing::resolve(tx, &t, ShareKind::Form)?;
            let fields = schema::table_fields(tx, &r.table.id)?;
            let values = validate_submission(&r.view.view.config, &fields, body)?;
            let ctx = WriteCtx::new(
                None,
                WriteSource::Form {
                    view_id: r.view.view.id.clone(),
                },
            )
            .typecast(true);
            create_records(
                tx,
                &ctx,
                &r.table.id,
                vec![og_core::api::records::NewRecord { values }],
                &CreateOpts::default(),
            )
        })
        .await?;
    for event in outcome.events() {
        state.events.publish(&outcome.base_id, None, None, event);
    }
    Ok(Json(json!({ "ok": true })))
}

/// Charge the byte budgets of anonymous uploads (see [`UPLOAD_MB_PER_IP`]);
/// 429 when one is used up. One limiter hit per MB.
fn charge_upload_bytes(
    state: &AppState,
    client: &ClientInfo,
    base_id: &str,
    headers: &HeaderMap,
    cap: u64,
) -> AppResult<()> {
    const MB: u64 = 1024 * 1024;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mb = declared.unwrap_or(cap).min(cap).div_ceil(MB).max(1);
    for (bucket, key, max) in [
        ("form_upload_mb_ip", client.ip.as_str(), UPLOAD_MB_PER_IP),
        ("form_upload_mb_base", base_id, UPLOAD_MB_PER_BASE),
        ("form_upload_mb_all", "all", UPLOAD_MB_GLOBAL),
    ] {
        for _ in 0..mb {
            state.limiter.check(bucket, key, max, UPLOAD_BYTES_WINDOW)?;
        }
    }
    Ok(())
}

async fn upload_form_file(
    State(state): State<AppState>,
    client: ClientInfo,
    Path(token): Path<String>,
    req: Request,
) -> PublicResult<Json<AttachmentRef>> {
    let headers = req.headers().clone();
    let r = authorize(&state, &client, &headers, &token, ShareKind::Form).await?;
    state.limiter.check(
        "form_upload",
        &format!("{}|{token}", client.ip),
        UPLOAD_LIMIT,
        SUBMIT_WINDOW,
    )?;
    let table_id = r.table.id.clone();
    let fields = state
        .db
        .read(move |conn| schema::table_fields(conn, &table_id))
        .await?;
    let has_file_field = sharing::form_fields(&r.view.view.config, &fields)
        .iter()
        .any(|(_, f)| matches!(f.kind, FieldKind::Attachment(_)));
    if !has_file_field {
        return Err(AppError::bad_request("this form has no file upload field").into());
    }
    let cap = state.config.max_upload_bytes().min(PUBLIC_UPLOAD_MAX);
    charge_upload_bytes(&state, &client, &r.table.base_id, &headers, cap)?;
    let multipart = crate::api::csv::limited_multipart(&state, req, cap).await?;
    let saved =
        crate::api::attachments::save_upload(&state, &r.table.base_id, None, multipart).await?;
    Ok(Json(saved))
}
