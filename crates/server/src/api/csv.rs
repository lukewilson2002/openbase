//! CSV export and import.
//!
//! - `GET  /api/views/{id}/export.csv?timezone=` (Viewer): the view's visible
//!   fields in view order, its records in view order with filter, sort and
//!   grouping applied. **Streamed** page by page from the query engine, so
//!   memory stays flat however big the table is. UTF-8 with a BOM (Excel),
//!   RFC 4180 quoting, CRLF line ends, dates in the `timezone` parameter or
//!   the caller's profile zone, and a leading `'` on cells that start with
//!   `= + - @ TAB CR` so spreadsheets do not execute them as formulas.
//! - `POST /api/tables/{id}/import` (Editor): multipart `file` (CSV, at most
//!   20 MB / 100,000 rows / 500 columns), `mapping` (JSON object
//!   `{csv column -> field id | null}`; keys are header names, or zero-based
//!   column numbers when `has_header` is `false`; omitted = match columns to
//!   fields by name) and `has_header` (default `true`). Values are read with
//!   typecast on (`"$1,200"`, `"yes"`, select names that create choices...).
//!   All or nothing: if any row is rejected, the answer is 422
//!   `{"error": {"code": "import_failed", "rows": [{"row", "message"}], ...}}`
//!   and nothing is written.
//! - `POST /api/bases/{id}/import` (Creator): multipart `file`, optional
//!   `name` of the new table and `has_header`; creates a table whose fields
//!   are inferred from the data (the first column is the primary field) and
//!   imports every row, again all or nothing.

use std::collections::HashMap;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt;
use og_core::api::records::QueryRequest;
use og_core::api::schema::{CreateField, UpdateField};
use og_core::api::sharing::{ImportResult, ImportRowError, ImportedField};
use og_core::cell::display_text;
use og_core::field::{Field, FieldKind};
use serde::Deserialize;
use serde_json::{Value as Json2, json};

use crate::api::attachments::content_disposition;
use crate::api::records::publish_outcome;
use crate::api::schema_support::publish_schema;
use crate::auth::Actor;
use crate::engine::query;
use crate::engine::write::{WriteCtx, WriteSource, user_timezone};
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::csv_io::{self, Csv, ImportColumn, ImportOutcome};
use crate::store::links::NameCache;
use crate::store::schema::{self, Touched};
use crate::store::sharing::visible_fields;
use crate::store::{attachments, fields, tables};

/// Records fetched from the query engine per streamed chunk.
const EXPORT_PAGE: usize = 500;
/// Framing allowance on top of the file in an import request.
const MULTIPART_SLACK: u64 = 1024 * 1024;
const MAX_MAPPING_BYTES: usize = 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/views/{id}/export.csv", get(export))
        .route(
            "/api/tables/{id}/import",
            post(import_table).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/bases/{id}/import",
            post(import_base).layer(DefaultBodyLimit::disable()),
        )
}

/// Multipart parsing with the whole body capped at `cap` bytes (plus framing)
/// instead of the global upload limit. Oversized bodies fail with 413.
pub async fn limited_multipart(state: &AppState, req: Request, cap: u64) -> AppResult<Multipart> {
    let limit = cap.saturating_add(MULTIPART_SLACK);
    let too_large = || {
        AppError::PayloadTooLarge(format!(
            "the upload is larger than the limit of {} MB",
            (cap / (1024 * 1024)).max(1)
        ))
    };
    let declared = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(too_large());
    }
    let (parts, body) = req.into_parts();
    // One wrapper only: axum recognizes the length-limit error to answer 413
    // as long as the body is wrapped exactly once.
    let body = Body::new(http_body_util::Limited::new(
        body,
        usize::try_from(limit).unwrap_or(usize::MAX),
    ));
    Multipart::from_request(Request::from_parts(parts, body), state)
        .await
        .map_err(|e| {
            AppError::bad_request(format!(
                "expected a multipart/form-data upload ({})",
                e.body_text()
            ))
        })
}

// ------------------------------------------------------------------ export

#[derive(Debug, Default, Deserialize)]
struct ExportParams {
    /// IANA zone for dates; defaults to the caller's profile zone.
    #[serde(default)]
    timezone: Option<String>,
}

/// Everything the streaming loop needs after the first page.
struct ExportStream {
    state: AppState,
    user_id: String,
    view: schema::ViewRow,
    fields: Vec<Field>,
    timezone: String,
    offset: usize,
    total: usize,
    first: Option<Vec<u8>>,
}

/// Render records as CSV rows (no header).
fn render_rows(
    conn: &rusqlite::Connection,
    fields: &[Field],
    records: Vec<og_core::api::records::Record>,
    tz: chrono_tz::Tz,
    header: bool,
) -> AppResult<Vec<u8>> {
    let names = NameCache::new(conn, tz);
    let mut out = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    if header {
        out.write_record(
            fields
                .iter()
                .map(|f| csv_io::guard_cell(f.name.clone(), false)),
        )
        .map_err(AppError::internal)?;
    }
    for rec in records {
        let row: Vec<String> = fields
            .iter()
            .map(|f| {
                let stored = rec.values.get(&f.id).map(|v| restore_link_ids(f, v));
                let text = display_text(f, stored.as_ref(), &names, tz);
                let numeric = matches!(
                    f.kind,
                    FieldKind::Number(_)
                        | FieldKind::Currency(_)
                        | FieldKind::Percent(_)
                        | FieldKind::Duration(_)
                        | FieldKind::Rating(_)
                        | FieldKind::Autonumber(_)
                        | FieldKind::Count(_)
                        | FieldKind::Formula(_)
                        | FieldKind::Rollup(_)
                ) && matches!(stored, Some(Json2::Number(_)));
                csv_io::guard_cell(text, numeric)
            })
            .collect();
        out.write_record(&row).map_err(AppError::internal)?;
    }
    out.into_inner().map_err(AppError::internal)
}

/// The API renders link cells as `[{id, name}]`; `display_text` wants ids.
fn restore_link_ids(field: &Field, value: &Json2) -> Json2 {
    if !matches!(field.kind, FieldKind::Link(_)) {
        return value.clone();
    }
    Json2::Array(
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r.get("id").cloned())
            .collect(),
    )
}

fn export_filename(view_name: &str) -> String {
    attachments::sanitize_filename(&format!("{view_name}.csv"))
}

async fn export(
    State(state): State<AppState>,
    actor: Actor,
    Path(view_id): Path<String>,
    ApiQuery(params): ApiQuery<ExportParams>,
) -> AppResult<Response> {
    let cache = state.query_cache.clone();
    let versions = state.events.versions().clone();
    let user_id = actor.user_id.clone();
    let tz_param = params.timezone.clone();
    let (first, view, fields, total, timezone) = state
        .db
        .read(move |conn| {
            let base = perm::base_of_view(conn, &view_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let view = query::visible_view(conn, &actor.user_id, &view_id)?;
            let all = schema::table_fields(conn, &view.view.table_id)?;
            let fields = visible_fields(&view.view.config, &all);
            let tz: chrono_tz::Tz =
                match tz_param.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(name) => name.parse().map_err(|_| {
                        AppError::bad_request(format!("unknown timezone \"{name}\""))
                    })?,
                    None => user_timezone(conn, &actor.user_id),
                };
            let req = QueryRequest {
                offset: 0,
                limit: Some(EXPORT_PAGE),
                timezone: Some(tz.name().to_string()),
                ..QueryRequest::default()
            };
            let resp = query::run_query(conn, &cache, &versions, &actor.user_id, &view, &req)?;
            let total = resp.total;
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend(render_rows(conn, &fields, resp.records, tz, true)?);
            Ok((bytes, view, fields, total, tz.name().to_string()))
        })
        .await?;

    let filename = export_filename(&view.view.name);
    let st = ExportStream {
        state,
        user_id,
        view,
        fields,
        timezone,
        offset: EXPORT_PAGE,
        total,
        first: Some(first),
    };
    let stream = futures::stream::unfold(Some(st), |st| async move {
        let mut st = st?;
        if let Some(first) = st.first.take() {
            return Some((Ok::<_, std::io::Error>(Bytes::from(first)), Some(st)));
        }
        if st.offset >= st.total {
            return None;
        }
        let cache = st.state.query_cache.clone();
        let versions = st.state.events.versions().clone();
        let (user_id, view, fields, tzname, offset) = (
            st.user_id.clone(),
            st.view.clone(),
            st.fields.clone(),
            st.timezone.clone(),
            st.offset,
        );
        let page = st
            .state
            .db
            .read(move |conn| {
                let tz: chrono_tz::Tz = tzname.parse().unwrap_or(chrono_tz::Tz::UTC);
                let req = QueryRequest {
                    offset,
                    limit: Some(EXPORT_PAGE),
                    timezone: Some(tzname),
                    ..QueryRequest::default()
                };
                let resp = query::run_query(conn, &cache, &versions, &user_id, &view, &req)?;
                let n = resp.records.len();
                Ok((render_rows(conn, &fields, resp.records, tz, false)?, n))
            })
            .await;
        match page {
            // An empty page means the table shrank under us: stop cleanly.
            Ok((_, 0)) => None,
            Ok((bytes, n)) => {
                st.offset += n;
                Some((Ok(Bytes::from(bytes)), Some(st)))
            }
            Err(e) => {
                tracing::warn!(error = %e, "CSV export failed mid-stream");
                Some((Err(std::io::Error::other(e.to_string())), None))
            }
        }
    });

    let mut res = Response::new(Body::from_stream(stream.fuse()));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&content_disposition("attachment", &filename)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(res)
}

// ------------------------------------------------------------------ import

/// Errors of the import endpoints: the standard envelope, or the list of bad
/// rows (422).
pub enum ImportError {
    App(AppError),
    Rejected {
        errors: Vec<ImportRowError>,
        truncated: bool,
    },
}

impl From<AppError> for ImportError {
    fn from(e: AppError) -> Self {
        ImportError::App(e)
    }
}

impl IntoResponse for ImportError {
    fn into_response(self) -> Response {
        match self {
            ImportError::App(e) => e.into_response(),
            ImportError::Rejected { errors, truncated } => {
                let shown = errors.len();
                let message = if truncated {
                    format!("at least {shown} rows could not be imported; nothing was imported")
                } else {
                    format!("{shown} row(s) could not be imported; nothing was imported")
                };
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "error": {
                        "code": "import_failed",
                        "message": message,
                        "rows": errors,
                        "truncated": truncated,
                    } })),
                )
                    .into_response()
            }
        }
    }
}

/// The parts of an import request.
#[derive(Default)]
struct ImportForm {
    file: Option<Vec<u8>>,
    file_name: Option<String>,
    mapping: Option<String>,
    has_header: bool,
    name: Option<String>,
}

fn upload_error(e: axum::extract::multipart::MultipartError) -> AppError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::PayloadTooLarge(format!(
            "the CSV file is larger than {} MB",
            csv_io::MAX_FILE_BYTES / (1024 * 1024)
        ))
    } else {
        AppError::bad_request(format!("invalid multipart upload: {}", e.body_text()))
    }
}

async fn read_text_part(
    field: &mut axum::extract::multipart::Field<'_>,
    max: usize,
    what: &str,
) -> AppResult<String> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(upload_error)? {
        buf.extend_from_slice(&chunk);
        if buf.len() > max {
            return Err(AppError::bad_request(format!("{what} is too long")));
        }
    }
    String::from_utf8(buf).map_err(|_| AppError::bad_request(format!("{what} must be UTF-8 text")))
}

async fn read_form(mut mp: Multipart) -> AppResult<ImportForm> {
    let mut form = ImportForm {
        has_header: true,
        ..ImportForm::default()
    };
    while let Some(mut field) = mp.next_field().await.map_err(upload_error)? {
        match field.name().unwrap_or_default() {
            "file" => {
                form.file_name = field.file_name().map(str::to_string);
                let mut buf: Vec<u8> = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(upload_error)? {
                    buf.extend_from_slice(&chunk);
                    if buf.len() as u64 > csv_io::MAX_FILE_BYTES {
                        return Err(AppError::PayloadTooLarge(format!(
                            "the CSV file is larger than {} MB",
                            csv_io::MAX_FILE_BYTES / (1024 * 1024)
                        )));
                    }
                }
                form.file = Some(buf);
            }
            "mapping" => {
                form.mapping =
                    Some(read_text_part(&mut field, MAX_MAPPING_BYTES, "mapping").await?);
            }
            "has_header" => {
                let v = read_text_part(&mut field, 16, "has_header").await?;
                form.has_header = !matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "false" | "0" | "no" | "off"
                );
            }
            "name" => {
                form.name = Some(read_text_part(&mut field, 1024, "name").await?);
            }
            _ => {}
        }
    }
    Ok(form)
}

/// Parse off the async threads: a 20 MB file takes a moment.
async fn parse_csv(bytes: Vec<u8>, has_header: bool) -> AppResult<Csv> {
    tokio::task::spawn_blocking(move || csv_io::parse(&bytes, has_header))
        .await
        .map_err(AppError::internal)?
}

fn parse_mapping(text: &str) -> AppResult<HashMap<String, Option<String>>> {
    serde_json::from_str(text).map_err(|e| {
        AppError::bad_request(format!(
            "mapping must be a JSON object like {{\"Column\": \"fldXXXX\" | null}}: {e}"
        ))
    })
}

/// Without an explicit mapping, match columns to importable fields by name
/// (case-insensitively).
fn auto_mapping(csv: &Csv, fields: &[Field]) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    for (i, name) in csv.header.iter().enumerate() {
        let key = if csv.has_header {
            name.clone()
        } else {
            i.to_string()
        };
        let target = csv
            .has_header
            .then(|| {
                fields.iter().find(|f| {
                    f.name.to_lowercase() == name.to_lowercase() && csv_io::importable(f).is_ok()
                })
            })
            .flatten();
        map.insert(key, target.map(|f| f.id.clone()));
    }
    map
}

async fn import_table(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    req: Request,
) -> Result<Json<ImportResult>, ImportError> {
    let who = actor.clone();
    let (a, t) = (actor.clone(), table_id.clone());
    state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &t)?;
            perm::require_base(conn, &a, &base, Role::Editor).map(|_| ())
        })
        .await?;
    let multipart = limited_multipart(&state, req, csv_io::MAX_FILE_BYTES).await?;
    let form = read_form(multipart).await?;
    let file = form
        .file
        .ok_or_else(|| AppError::bad_request("missing multipart field \"file\""))?;
    let csv = parse_csv(file, form.has_header).await?;
    let explicit = form.mapping.as_deref().map(parse_mapping).transpose()?;

    let (outcome, created_table) = (table_id.clone(), table_id.clone());
    let result = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &outcome)?;
            perm::require_base(tx, &actor, &base, Role::Editor)?;
            let table_fields = schema::table_fields(tx, &outcome)?;
            let mapping = explicit.unwrap_or_else(|| auto_mapping(&csv, &table_fields));
            let columns = csv_io::resolve_mapping(&csv, &mapping, &table_fields)?;
            let ctx = WriteCtx::for_user(tx, &actor.user_id, WriteSource::Import)?.typecast(true);
            csv_io::import_rows(tx, &ctx, &outcome, &columns, &csv.rows)
        })
        .await?;
    match result {
        ImportOutcome::Imported { created, outcomes } => {
            for o in &outcomes {
                publish_outcome(&state, &headers, &who, o);
            }
            Ok(Json(ImportResult {
                table_id: created_table,
                created,
                fields: Vec::new(),
            }))
        }
        ImportOutcome::Rejected { errors, truncated } => {
            Err(ImportError::Rejected { errors, truncated })
        }
    }
}

/// A table name from the upload's file name: `People 2026.csv` -> `People 2026`.
fn name_from_file(file_name: Option<&str>) -> String {
    let stem = file_name
        .map(attachments::sanitize_filename)
        .map(|n| match n.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() && ext.eq_ignore_ascii_case("csv") => {
                stem.to_string()
            }
            _ => n,
        })
        .unwrap_or_default();
    if stem.is_empty() || stem == "file" {
        "Imported table".to_string()
    } else {
        stem
    }
}

async fn import_base(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(base_id): Path<String>,
    req: Request,
) -> Result<(StatusCode, Json<ImportResult>), ImportError> {
    let who = actor.clone();
    let (a, b) = (actor.clone(), base_id.clone());
    state
        .db
        .read(move |conn| perm::require_base(conn, &a, &b, Role::Creator).map(|_| ()))
        .await?;
    let multipart = limited_multipart(&state, req, csv_io::MAX_FILE_BYTES).await?;
    let form = read_form(multipart).await?;
    let file = form
        .file
        .ok_or_else(|| AppError::bad_request("missing multipart field \"file\""))?;
    let csv = parse_csv(file, form.has_header).await?;
    let explicit_name = form
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    let wanted = explicit_name
        .clone()
        .unwrap_or_else(|| name_from_file(form.file_name.as_deref()));

    // Infer the column types off the async threads (every cell is checked).
    let csv = std::sync::Arc::new(csv);
    let inferred = {
        let csv = csv.clone();
        tokio::task::spawn_blocking(move || {
            (0..csv.columns())
                .map(|i| {
                    let cells: Vec<&str> = csv.rows.iter().map(|r| r.cells[i].as_str()).collect();
                    csv_io::infer_kind(&cells, i == 0)
                })
                .collect::<Vec<FieldKind>>()
        })
        .await
        .map_err(AppError::internal)?
    };

    let base = base_id.clone();
    // An error (including rejected rows) rolls the whole transaction back,
    // table and fields included.
    let result = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            build_table(
                tx,
                &actor,
                &base,
                &wanted,
                explicit_name.is_some(),
                &csv,
                inferred,
            )
        })
        .await;
    match result {
        Ok(BuiltTable {
            table_id,
            created,
            fields: imported,
            outcomes,
        }) => {
            publish_schema(&state, &headers, &who, &base_id, &Touched::of(&table_id));
            for o in &outcomes {
                publish_outcome(&state, &headers, &who, o);
            }
            Ok((
                StatusCode::CREATED,
                Json(ImportResult {
                    table_id,
                    created,
                    fields: imported,
                }),
            ))
        }
        Err(e) => Err(unwrap_rejection(e)),
    }
}

struct BuiltTable {
    table_id: String,
    created: usize,
    fields: Vec<ImportedField>,
    outcomes: Vec<crate::engine::write::WriteOutcome>,
}

/// Row rejections travel through the `AppError` channel as a tagged
/// bad-request so the write closure can roll back; they are turned back into
/// the 422 answer here.
const REJECTION_TAG: &str = "\u{1}import_rejected:";

fn unwrap_rejection(e: AppError) -> ImportError {
    if let AppError::BadRequest(msg) = &e
        && let Some(json) = msg.strip_prefix(REJECTION_TAG)
        && let Ok(v) = serde_json::from_str::<Json2>(json)
    {
        let errors: Vec<ImportRowError> =
            serde_json::from_value(v["rows"].clone()).unwrap_or_default();
        return ImportError::Rejected {
            errors,
            truncated: v["truncated"].as_bool().unwrap_or(false),
        };
    }
    ImportError::App(e)
}

/// Create the table, its fields and the records. `Err` with a tagged
/// rejection when rows are bad (the caller rolls back).
fn build_table(
    tx: &rusqlite::Transaction,
    actor: &Actor,
    base_id: &str,
    wanted: &str,
    explicit_name: bool,
    csv: &Csv,
    kinds: Vec<FieldKind>,
) -> AppResult<BuiltTable> {
    let name = if explicit_name {
        wanted.to_string()
    } else {
        tables::free_name(tx, base_id, wanted)?
    };
    let table = tables::create(tx, base_id, &name, &actor.user_id)?;
    let mut columns: Vec<ImportColumn> = Vec::new();
    let mut imported: Vec<ImportedField> = Vec::new();
    for (i, kind) in kinds.into_iter().enumerate() {
        let field = if i == 0 {
            let change = fields::update(
                tx,
                &table.primary_field_id,
                &UpdateField {
                    name: Some(csv.header[0].clone()),
                    description: None,
                    kind: (!matches!(kind, FieldKind::SingleLineText(_))).then_some(kind),
                    position: None,
                },
            )?;
            change.field
        } else {
            fields::create(
                tx,
                &table.id,
                &CreateField {
                    name: csv.header[i].clone(),
                    kind,
                    description: None,
                    inverse_name: None,
                },
            )?
            .field
        };
        imported.push(ImportedField {
            id: field.id.clone(),
            name: field.name.clone(),
            field_type: field.field_type(),
        });
        columns.push(ImportColumn { column: i, field });
    }
    let ctx = WriteCtx::for_user(tx, &actor.user_id, WriteSource::Import)?.typecast(true);
    match csv_io::import_rows(tx, &ctx, &table.id, &columns, &csv.rows)? {
        ImportOutcome::Imported { created, outcomes } => Ok(BuiltTable {
            table_id: table.id,
            created,
            fields: imported,
            outcomes,
        }),
        ImportOutcome::Rejected { errors, truncated } => Err(AppError::BadRequest(format!(
            "{REJECTION_TAG}{}",
            json!({ "rows": errors, "truncated": truncated })
        ))),
    }
}
