//! Attachments API: streamed uploads and safe downloads.
//!
//! - `POST /api/bases/{id}/attachments` (multipart field `file`, Editor) streams
//!   the body to a temp file while hashing it and enforcing the upload limit,
//!   then stores it content-addressed (see [`crate::store::attachments`]).
//! - `GET /api/attachments/{id}/{filename}` serves the bytes to Viewers of the
//!   base, or to holders of an enabled view share link of that base
//!   (`?share=<token>`, plus `X-Share-Password` for protected shares).
//! - `GET /api/attachments/{id}/thumb` serves the PNG preview of an image, a PDF's
//!   first page or a video's first frame (see [`crate::previews`]).
//!
//! Downloads never let the browser interpret user content: only sniffed
//! raster images, video and audio are inline (with their sniffed type);
//! everything else (HTML, SVG, PDF, ...) is an `application/octet-stream`
//! attachment, always with `nosniff` and a sandboxing CSP. A single
//! `Range: bytes=...` is honoured (206, `Accept-Ranges: bytes`) so media can
//! seek; the body is always streamed.
//!
//! [`save_upload`] / [`save_stream`] are public so public form uploads can
//! reuse the same pipeline after their own checks.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use ob_core::api::records::QueryRequest;
use ob_core::api::sharing::ShareKind;
use ob_core::field::{AttachmentRef, FieldKind};
use serde::Deserialize;
use serde_json::Value as Json2;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::auth::{Actor, ClientInfo, MaybeActor};
use crate::db::now_ms;
use crate::engine::query;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::ids::new_id;
use crate::perm::{self, Role};
use crate::previews;
use crate::state::AppState;
use crate::store::attachments::{self as store, Attachment};
use crate::store::schema;
use crate::store::sharing::{self, Resolved};

/// Allowance for multipart framing on top of the per-file limit.
const MULTIPART_OVERHEAD: u64 = 64 * 1024;
/// Leading bytes of an upload kept for type sniffing.
const HEAD_BYTES: usize = 64;
/// Bytes read from the start of a stored file to sniff video/audio when serving it.
const SNIFF_BYTES: usize = 512;

const CSP_SANDBOX: &str = "sandbox; default-src 'none'";
const CACHE_CONTROL: &str = "private, max-age=86400";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/bases/{id}/attachments",
            // The size limit is enforced per request in `multipart_with_limit`
            // (it depends on configuration), so lift the global JSON limit here.
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        // `thumb` is matched before the `{filename}` catch-all segment.
        .route("/api/attachments/{id}/thumb", get(thumbnail))
        .route("/api/attachments/{id}/{filename}", get(download))
}

async fn upload(
    State(state): State<AppState>,
    actor: Actor,
    UrlPath(base_id): UrlPath<String>,
    req: Request,
) -> AppResult<Json<AttachmentRef>> {
    let (a, b) = (actor.clone(), base_id.clone());
    state
        .db
        .read(move |c| perm::require_base(c, &a, &b, Role::Editor))
        .await?;
    let multipart = multipart_with_limit(&state, req).await?;
    let saved = save_upload(&state, Some(&base_id), Some(actor.user_id), multipart).await?;
    Ok(Json(saved))
}

/// Parse `req` as multipart with the body capped at the configured upload
/// limit (+ framing overhead). Oversized bodies fail with 413.
pub async fn multipart_with_limit(state: &AppState, req: Request) -> AppResult<Multipart> {
    let limit = state
        .config
        .max_upload_bytes()
        .saturating_add(MULTIPART_OVERHEAD);
    let declared = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit) {
        return Err(too_large(state));
    }
    let (parts, body) = req.into_parts();
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let body = Body::new(http_body_util::Limited::new(body, limit));
    Multipart::from_request(Request::from_parts(parts, body), state)
        .await
        .map_err(|e| {
            AppError::bad_request(format!(
                "expected a multipart/form-data upload ({})",
                e.body_text()
            ))
        })
}

fn too_large(state: &AppState) -> AppError {
    AppError::PayloadTooLarge(format!(
        "file is larger than the upload limit of {} MB",
        state.config.max_upload_mb
    ))
}

fn multipart_error(state: &AppState, e: axum::extract::multipart::MultipartError) -> AppError {
    if e.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        too_large(state)
    } else {
        AppError::bad_request(format!("invalid multipart upload: {}", e.body_text()))
    }
}

/// Store the multipart field named `file` as an attachment of `base_id` (or of
/// no base yet, for inbox drafts). Other fields are skipped. The caller must
/// have authorized the upload.
pub async fn save_upload(
    state: &AppState,
    base_id: Option<&str>,
    created_by: Option<String>,
    mut multipart: Multipart,
) -> AppResult<AttachmentRef> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| multipart_error(state, e))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("file").to_string();
            let stream = field.map(|chunk| chunk.map_err(|e| multipart_error(state, e)));
            return save_stream(state, base_id, created_by, &filename, stream).await;
        }
    }
    Err(AppError::bad_request("missing multipart field \"file\""))
}

/// Deletes a file when dropped (cleanup on every error path).
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Store a byte stream as an attachment of `base_id` (`None`: an inbox upload that
/// only its uploader can read, see [`authorize`]): stream to a temp file
/// under `<data_dir>/tmp` while hashing (413 past the limit), sniff the type,
/// make its preview (see [`crate::previews`]), then move the bytes to their content address
/// and insert the row in one write transaction (so garbage collection, which
/// also runs under the writer, can never delete a file a new row needs).
pub async fn save_stream<S>(
    state: &AppState,
    base_id: Option<&str>,
    created_by: Option<String>,
    filename: &str,
    stream: S,
) -> AppResult<AttachmentRef>
where
    S: Stream<Item = AppResult<Bytes>>,
{
    let mut stream = std::pin::pin!(stream);
    let tmp_dir = state.config.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(AppError::internal)?;
    let suffix = new_id("");
    let tmp = TempFile(tmp_dir.join(format!("upload-{suffix}")));
    let thumb_tmp = TempFile(tmp_dir.join(format!("thumb-{suffix}.png")));

    let max = state.config.max_upload_bytes();
    let mut file = tokio::fs::File::create(&tmp.0)
        .await
        .map_err(AppError::internal)?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(HEAD_BYTES);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        size = size.saturating_add(chunk.len() as u64);
        if size > max {
            return Err(too_large(state));
        }
        if head.len() < HEAD_BYTES {
            let take = (HEAD_BYTES - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(AppError::internal)?;
    }
    file.flush().await.map_err(AppError::internal)?;
    file.sync_all().await.map_err(AppError::internal)?;
    drop(file);

    let sha = hex::encode(hasher.finalize());
    let filename = store::sanitize_filename(filename);
    let mime = store::detect_mime(&head, &filename);
    let info = match previews::kind(&head, &mime) {
        Some(kind) => previews::make(kind, tmp.0.clone(), thumb_tmp.0.clone()).await,
        None => previews::Info::default(),
    };

    let mut row = Attachment {
        id: new_id(ob_core::ids::ATTACHMENT),
        sha256: sha,
        filename,
        mime,
        size,
        width: info.width,
        height: info.height,
        has_thumb: false,
        base_id: base_id.map(str::to_string),
        created_by,
        created_at: now_ms(),
    };
    let dir = state.config.attachments_dir();
    let (src, thumb_src) = (tmp.0.clone(), thumb_tmp.0.clone());
    let inbox_cap = state.config.max_inbox_bytes();
    let saved = state
        .db
        .write(move |tx| {
            // Files in no base are the uploader's own storage: capped per user,
            // checked here under the writer so concurrent uploads cannot both fit.
            if let (None, Some(owner)) = (&row.base_id, &row.created_by) {
                let used = store::unattached_bytes(tx, owner)?;
                if used.saturating_add(row.size) > inbox_cap {
                    return Err(AppError::PayloadTooLarge(format!(
                        "your inbox can hold at most {} MB of files and this one does not fit; \
                         file or delete drafts with files first",
                        inbox_cap / (1024 * 1024)
                    )));
                }
            }
            let blob = store::blob_path(&dir, &row.sha256)?;
            let thumb = store::thumb_path(&dir, &row.sha256)?;
            if !blob.exists() {
                move_file(&src, &blob).map_err(AppError::internal)?;
            }
            if info.thumb && !thumb.exists() {
                move_file(&thumb_src, &thumb).map_err(AppError::internal)?;
            }
            row.has_thumb = thumb.exists();
            store::insert(tx, &row)?;
            Ok(row.to_ref())
        })
        .await?;
    drop((tmp, thumb_tmp));
    Ok(saved)
}

/// Rename, falling back to copy + rename when `from` and `to` are on
/// different filesystems.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let mut partial = to.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    std::fs::copy(from, &partial)?;
    std::fs::rename(&partial, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ShareQuery {
    share: Option<String>,
}

/// Download requests per client IP per minute that carry a share token. Own
/// bucket, and generous: one shared gallery page loads dozens of thumbnails.
pub const SHARE_IP_LIMIT: u32 = 600;
/// Download requests per share token per minute.
pub const SHARE_TOKEN_LIMIT: u32 = 2400;
/// Password verifications per (client IP, token) per minute: the same bucket
/// and limit as the public share endpoints in [`crate::api::sharing`], so
/// guesses cannot be spread across the two.
const SHARE_PASSWORD_LIMIT: u32 = crate::api::sharing::PASSWORD_LIMIT;
const MINUTE: std::time::Duration = std::time::Duration::from_secs(60);
/// Share decisions kept (view and file).
const SHARE_DECISION_ENTRIES: usize = 4096;

/// Whether a file is shown by a shared view, for one data version of the base, one view config
/// and one day (relative date filters).
struct Decision {
    version: u64,
    config: u64,
    day: chrono::NaiveDate,
    exposed: bool,
    /// Last use, to drop the least recently used decision when the cache is full.
    used: u64,
}

#[derive(Default)]
struct Decisions {
    tick: u64,
    map: HashMap<(String, String), Decision>,
}

static SHARE_DECISIONS: LazyLock<Mutex<Decisions>> = LazyLock::new(Mutex::default);

fn config_hash(config: &ob_core::view::ViewConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(config)
        .unwrap_or_default()
        .hash(&mut h);
    h.finish()
}

/// Whether a public viewer of `r` can see the file `att_id`: it is in a visible attachment
/// field, or referenced (`/api/attachments/{id}/...`) in a visible long text field, of a live
/// record the view's filter lets through. Decided per file, from the few records that mention
/// its id, not by reading the whole view; the answer is cached (least recently used).
fn attachment_exposed(
    conn: &rusqlite::Connection,
    state: &AppState,
    r: &Resolved,
    att_id: &str,
) -> AppResult<bool> {
    let base_id = r.table.base_id.as_str();
    // Version first, data second (see store::versions).
    let version = state.events.versions().current(base_id);
    let config = config_hash(&r.view.view.config);
    let day = chrono::Utc::now().date_naive();
    let key = (r.view.view.id.clone(), att_id.to_string());
    {
        let mut cache = SHARE_DECISIONS.lock().unwrap_or_else(|p| p.into_inner());
        cache.tick += 1;
        let tick = cache.tick;
        if let Some(d) = cache.map.get_mut(&key)
            && (d.version, d.config, d.day) == (version, config, day)
        {
            d.used = tick;
            return Ok(d.exposed);
        }
    }
    let exposed = compute_exposed(conn, state, r, att_id)?;
    let mut cache = SHARE_DECISIONS.lock().unwrap_or_else(|p| p.into_inner());
    cache.tick += 1;
    let used = cache.tick;
    if cache.map.len() >= SHARE_DECISION_ENTRIES
        && !cache.map.contains_key(&key)
        && let Some(oldest) = cache
            .map
            .iter()
            .min_by_key(|(_, d)| d.used)
            .map(|(k, _)| k.clone())
    {
        cache.map.remove(&oldest);
    }
    cache.map.insert(
        key,
        Decision {
            version,
            config,
            day,
            exposed,
            used,
        },
    );
    Ok(exposed)
}

fn compute_exposed(
    conn: &rusqlite::Connection,
    state: &AppState,
    r: &Resolved,
    att_id: &str,
) -> AppResult<bool> {
    let fields = schema::table_fields(conn, &r.table.id)?;
    let visible = sharing::visible_fields(&r.view.view.config, &fields);
    let attachment_fields: Vec<&str> = visible
        .iter()
        .filter(|f| matches!(f.kind, FieldKind::Attachment(_)))
        .map(|f| f.id.as_str())
        .collect();
    // Files embedded or linked in visible long text are shown too.
    let text_fields: Vec<&str> = visible
        .iter()
        .filter(|f| matches!(f.kind, FieldKind::LongText(_)))
        .map(|f| f.id.as_str())
        .collect();
    if attachment_fields.is_empty() && text_fields.is_empty() {
        return Ok(false);
    }
    // The live records of the shared table that mention the id at all, and then show it in a
    // visible field.
    let mut stmt = conn.prepare(
        "SELECT id, data FROM records
         WHERE table_id = ?1 AND deleted_at IS NULL AND instr(data, ?2) > 0",
    )?;
    let mut showing = HashSet::new();
    let mut rows = stmt.query(rusqlite::params![r.table.id, att_id])?;
    while let Some(row) = rows.next()? {
        let (id, data): (String, String) = (row.get(0)?, row.get(1)?);
        let Ok(Json2::Object(data)) = serde_json::from_str::<Json2>(&data) else {
            continue;
        };
        let in_attachments = attachment_fields.iter().any(|f| {
            matches!(data.get(*f), Some(Json2::Array(items))
                if items.iter().any(|i| i.get("id").and_then(Json2::as_str) == Some(att_id)))
        });
        let in_text = text_fields.iter().any(|f| {
            matches!(data.get(*f), Some(Json2::String(text))
                if store::referenced_ids(text).iter().any(|i| i == att_id))
        });
        if in_attachments || in_text {
            showing.insert(id);
        }
    }
    if showing.is_empty() {
        return Ok(false);
    }
    // Same query as the public records endpoint: the view's own filter, no signed-in user.
    let entry = query::query_ids(
        conn,
        &state.query_cache,
        state.events.versions(),
        "",
        &r.view,
        &QueryRequest::default(),
    )?;
    Ok(entry.ids.iter().any(|id| showing.contains(id)))
}

/// Load an attachment the caller may read: Viewer on its base, or a live,
/// read-only view share link whose view shows it (in a visible attachment
/// field of a record the view lists). Every denial is a 404; share-token
/// requests are rate limited like the public share endpoints.
async fn authorize(
    state: &AppState,
    actor: Option<Actor>,
    client: &ClientInfo,
    share: Option<String>,
    headers: &HeaderMap,
    id: String,
) -> AppResult<Attachment> {
    let not_found = || AppError::not_found("attachment");
    let row = state
        .db
        .read(move |c| store::get(c, &id))
        .await?
        .ok_or_else(not_found)?;
    let Some(base_id) = row.base_id.clone() else {
        // Not in any base yet: an inbox upload, readable by its uploader only, and not by a
        // token limited to specific bases.
        return match actor {
            Some(a) if row.created_by.as_deref() == Some(a.user_id.as_str()) => {
                a.require_no_base_limit("the inbox or its files")?;
                Ok(row)
            }
            _ => Err(not_found()),
        };
    };

    if let Some(actor) = actor {
        let b = base_id.clone();
        let allowed = state
            .db
            .read(move |c| Ok(perm::require_base(c, &actor, &b, Role::Viewer).is_ok()))
            .await?;
        if allowed {
            return Ok(row);
        }
    }
    let Some(token) = share.filter(|t| !t.is_empty() && t.len() <= 256) else {
        return Err(not_found());
    };
    state
        .limiter
        .check("public_attachment_ip", &client.ip, SHARE_IP_LIMIT, MINUTE)?;
    let t = token.clone();
    let resolved = state
        .db
        .read(move |c| sharing::resolve(c, &t, ShareKind::View))
        .await
        .map_err(|e| match e {
            AppError::NotFound(_) => not_found(),
            other => other,
        })?;
    state
        .limiter
        .check("public_attachment_token", &token, SHARE_TOKEN_LIMIT, MINUTE)?;
    if resolved.table.base_id != base_id {
        return Err(not_found());
    }
    if let Some(hash) = resolved.share.password_hash.clone() {
        let given = headers
            .get("x-share-password")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if given.is_empty() {
            return Err(not_found());
        }
        state.limiter.check(
            "share_password",
            &format!("{}|{token}", client.ip),
            SHARE_PASSWORD_LIMIT,
            MINUTE,
        )?;
        if !crate::auth::password::verify_async(given, hash).await? {
            return Err(not_found());
        }
    }
    let (st, att_id) = (state.clone(), row.id.clone());
    let exposed = state
        .db
        .read(move |c| attachment_exposed(c, &st, &resolved, &att_id))
        .await?;
    if !exposed {
        return Err(not_found());
    }
    Ok(row)
}

async fn download(
    State(state): State<AppState>,
    MaybeActor(actor): MaybeActor,
    client: ClientInfo,
    UrlPath((id, _filename)): UrlPath<(String, String)>,
    ApiQuery(q): ApiQuery<ShareQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let row = authorize(&state, actor, &client, q.share, &headers, id).await?;
    let path = store::blob_path(&state.config.attachments_dir(), &row.sha256)?;
    // Images are sniffed at upload; video and audio are sniffed again from the stored
    // bytes, so a file uploaded before they were served inline needs no migration and the
    // extension or the stored type never decides.
    let media = if store::is_inline(&row.mime) {
        None
    } else {
        sniff_stored_media(&path).await
    };
    let (content_type, disposition) = match media {
        Some(m) => (m, "inline"),
        None if store::is_inline(&row.mime) => (row.mime.as_str(), "inline"),
        None => ("application/octet-stream", "attachment"),
    };
    file_response(
        &path,
        content_type,
        &content_disposition(disposition, &row.filename),
        headers.get(header::RANGE),
    )
    .await
}

/// Video or audio type of the stored file, from its first bytes.
async fn sniff_stored_media(path: &Path) -> Option<&'static str> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut head = vec![0u8; SNIFF_BYTES];
    let mut n = 0;
    while n < head.len() {
        match file.read(&mut head[n..]).await {
            Ok(0) | Err(_) => break,
            Ok(m) => n += m,
        }
    }
    store::sniff_media(&head[..n])
}

async fn thumbnail(
    State(state): State<AppState>,
    MaybeActor(actor): MaybeActor,
    client: ClientInfo,
    UrlPath(id): UrlPath<String>,
    ApiQuery(q): ApiQuery<ShareQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let row = authorize(&state, actor, &client, q.share, &headers, id).await?;
    if !row.has_thumb {
        return Err(AppError::not_found("thumbnail"));
    }
    let path = store::thumb_path(&state.config.attachments_dir(), &row.sha256)?;
    let name = format!("{}.thumb.png", row.filename);
    file_response(
        &path,
        "image/png",
        &content_disposition("inline", &name),
        headers.get(header::RANGE),
    )
    .await
}

/// A parsed `Range` request against a file of a known length.
#[derive(Debug, PartialEq, Eq)]
enum ByteRange {
    /// No usable range: serve the whole file (also for syntax we do not support).
    Full,
    /// First and last byte, both inclusive and inside the file.
    Part(u64, u64),
    /// Valid syntax but nothing of the file lies in it (416).
    Unsatisfiable,
}

/// Interpret a `Range` header. Only one `bytes=` range is supported (`a-b`, `a-`, `-n`);
/// anything else, including several ranges, is ignored and answered with the whole file as
/// RFC 9110 allows.
fn parse_range(value: Option<&HeaderValue>, len: u64) -> ByteRange {
    let Some(spec) = value
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().strip_prefix("bytes="))
    else {
        return ByteRange::Full;
    };
    let spec = spec.trim();
    let Some((first, last)) = spec.split_once('-') else {
        return ByteRange::Full;
    };
    let number = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<u64>())
    };
    match (number(first.trim()), number(last.trim())) {
        // `-n`: the last n bytes.
        (None, Some(Ok(n))) => {
            if n == 0 || len == 0 {
                ByteRange::Unsatisfiable
            } else {
                ByteRange::Part(len.saturating_sub(n), len - 1)
            }
        }
        // `a-` and `a-b`.
        (Some(Ok(a)), None) if last.trim().is_empty() => {
            if a >= len {
                ByteRange::Unsatisfiable
            } else {
                ByteRange::Part(a, len - 1)
            }
        }
        (Some(Ok(a)), Some(Ok(b))) => {
            if b < a {
                ByteRange::Full
            } else if a >= len {
                ByteRange::Unsatisfiable
            } else {
                ByteRange::Part(a, b.min(len - 1))
            }
        }
        // Overflowing numbers, `-` alone, several ranges (a comma fails the digit check).
        _ => ByteRange::Full,
    }
}

/// Stream a file with the safe download headers, or the part of it a `Range` header asks for.
async fn file_response(
    path: &Path,
    content_type: &str,
    disposition: &str,
    range: Option<&HeaderValue>,
) -> AppResult<Response> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            tracing::warn!(path = %path.display(), "attachment file missing on disk");
            return Err(AppError::not_found("attachment"));
        }
        Err(e) => return Err(AppError::internal(e)),
    };
    let len = file.metadata().await.map_err(AppError::internal)?.len();
    let header_value =
        |v: &str| HeaderValue::from_str(v).map_err(|e| AppError::internal(format!("header: {e}")));
    let (status, body, content_len, content_range) = match parse_range(range, len) {
        ByteRange::Full => (StatusCode::OK, file_body(file), len, None),
        ByteRange::Part(first, last) => {
            file.seek(io::SeekFrom::Start(first))
                .await
                .map_err(AppError::internal)?;
            let n = last - first + 1;
            (
                StatusCode::PARTIAL_CONTENT,
                file_body_limited(file, n),
                n,
                Some(format!("bytes {first}-{last}/{len}")),
            )
        }
        ByteRange::Unsatisfiable => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            Body::empty(),
            0,
            Some(format!("bytes */{len}")),
        ),
    };
    let mut res = Response::new(body);
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, header_value(content_type)?);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(content_len));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(cr) = content_range {
        h.insert(header::CONTENT_RANGE, header_value(&cr)?);
    }
    h.insert(header::CONTENT_DISPOSITION, header_value(disposition)?);
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP_SANDBOX),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL),
    );
    Ok(res)
}

/// Stream a file as a response body in 64 KiB chunks.
///
/// The stream is fused: the compression layer (every browser sends `Accept-Encoding`)
/// polls the body once more after the end, and a bare `unfold` panics when polled
/// after it returned `None`, which used to cut off every compressed download.
pub fn file_body(file: tokio::fs::File) -> Body {
    file_body_limited(file, u64::MAX)
}

/// Like [`file_body`], but at most `limit` bytes from the file's current position.
fn file_body_limited(file: tokio::fs::File, limit: u64) -> Body {
    let stream = futures::stream::unfold(Some((file, limit)), |state| async move {
        let (mut file, left) = state?;
        if left == 0 {
            return None;
        }
        let want = usize::try_from(left).map_or(64 * 1024, |l| l.min(64 * 1024));
        let mut buf = vec![0u8; want];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((
                    Ok::<_, io::Error>(Bytes::from(buf)),
                    Some((file, left - n as u64)),
                ))
            }
            Err(e) => Some((Err(e), None)),
        }
    });
    Body::from_stream(stream.fuse())
}

/// `Content-Disposition` with an ASCII fallback name and the exact UTF-8 name
/// (RFC 6266 / RFC 5987).
pub fn content_disposition(kind: &str, filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " .-_()+".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{kind}; filename=\"{fallback}\"; filename*=UTF-8''{}",
        rfc5987_encode(filename)
    )
}

fn rfc5987_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_byte_ranges() {
        let r = |v: &str| parse_range(Some(&HeaderValue::from_str(v).unwrap()), 100);
        assert_eq!(parse_range(None, 100), ByteRange::Full);
        assert_eq!(r("bytes=0-9"), ByteRange::Part(0, 9));
        assert_eq!(r("bytes=90-"), ByteRange::Part(90, 99));
        assert_eq!(r("bytes=-5"), ByteRange::Part(95, 99));
        assert_eq!(r("bytes=-500"), ByteRange::Part(0, 99));
        assert_eq!(r("bytes=50-5000"), ByteRange::Part(50, 99));
        assert_eq!(r(" bytes= 1 - 2 "), ByteRange::Part(1, 2));
        assert_eq!(r("bytes=100-"), ByteRange::Unsatisfiable);
        assert_eq!(r("bytes=100-200"), ByteRange::Unsatisfiable);
        assert_eq!(r("bytes=-0"), ByteRange::Unsatisfiable);
        assert_eq!(r("bytes=5-1"), ByteRange::Full);
        assert_eq!(r("bytes=0-1,5-6"), ByteRange::Full);
        assert_eq!(r("bytes=99999999999999999999-"), ByteRange::Full);
        assert_eq!(r("lines=0-1"), ByteRange::Full);
        assert_eq!(r("bytes=-"), ByteRange::Full);
        assert_eq!(
            parse_range(Some(&HeaderValue::from_static("bytes=0-")), 0),
            ByteRange::Unsatisfiable
        );
    }

    #[test]
    fn content_disposition_is_ascii_and_exact() {
        assert_eq!(
            content_disposition("attachment", "a b\"c.txt"),
            "attachment; filename=\"a b_c.txt\"; filename*=UTF-8''a%20b%22c.txt"
        );
        let cd = content_disposition("inline", "日本.png");
        assert!(cd.is_ascii());
        assert!(cd.ends_with("filename*=UTF-8''%E6%97%A5%E6%9C%AC.png"));
    }
}
