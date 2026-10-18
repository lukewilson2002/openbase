//! Attachments API: streamed uploads and safe downloads.
//!
//! - `POST /api/bases/{id}/attachments` (multipart field `file`, Editor) streams
//!   the body to a temp file while hashing it and enforcing the upload limit,
//!   then stores it content-addressed (see [`crate::store::attachments`]).
//! - `GET /api/attachments/{id}/{filename}` serves the bytes to Viewers of the
//!   base, or to holders of an enabled view share link of that base
//!   (`?share=<token>`, plus `X-Share-Password` for protected shares).
//! - `GET /api/attachments/{id}/thumb` serves the PNG thumbnail of an image.
//!
//! Downloads never let the browser interpret user content: only sniffed
//! raster images are inline; everything else (HTML, SVG, PDF, ...) is an
//! `application/octet-stream` attachment, always with `nosniff` and a
//! sandboxing CSP.
//!
//! [`save_upload`] / [`save_stream`] are public so public form uploads can
//! reuse the same pipeline after their own checks.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, header};
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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::auth::{Actor, ClientInfo, MaybeActor};
use crate::db::now_ms;
use crate::engine::query;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::ids::new_id;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::attachments::{self as store, Attachment};
use crate::store::sharing::{self, Resolved};
use crate::store::{records, schema};

/// Allowance for multipart framing on top of the per-file limit.
const MULTIPART_OVERHEAD: u64 = 64 * 1024;
/// Images above this many pixels get no thumbnail (decoding is too costly).
pub const MAX_THUMB_SOURCE_PIXELS: u64 = 40_000_000;
/// Decoder allocation cap.
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// Longest thumbnail side.
pub const THUMB_SIZE: u32 = 400;

/// One image decode at a time: decoding is the most memory-hungry thing the
/// server does, and the VPS budget is small.
static DECODE_PERMITS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

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
/// make a thumbnail for images, then move the bytes to their content address
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
    let mut head: Vec<u8> = Vec::with_capacity(16);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        size = size.saturating_add(chunk.len() as u64);
        if size > max {
            return Err(too_large(state));
        }
        if head.len() < 16 {
            let take = (16 - head.len()).min(chunk.len());
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
    let info = if store::sniff_image(&head).is_some() {
        image_info(tmp.0.clone(), thumb_tmp.0.clone()).await
    } else {
        ImageInfo::default()
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
    let saved = state
        .db
        .write(move |tx| {
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

#[derive(Debug, Default, Clone, Copy)]
struct ImageInfo {
    width: Option<u32>,
    height: Option<u32>,
    thumb: bool,
}

/// Dimensions and thumbnail of an image file. Failures are logged and give
/// an empty result: a bad image is still a valid upload.
async fn image_info(src: PathBuf, thumb_dest: PathBuf) -> ImageInfo {
    let Ok(_permit) = DECODE_PERMITS.acquire().await else {
        return ImageInfo::default();
    };
    match tokio::task::spawn_blocking(move || make_thumbnail(&src, &thumb_dest)).await {
        Ok(info) => info,
        Err(e) => {
            tracing::warn!(error = %e, "thumbnail task failed");
            ImageInfo::default()
        }
    }
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    limits
}

fn make_thumbnail(src: &Path, dest: &Path) -> ImageInfo {
    let mut info = ImageInfo::default();
    let open = || -> image::ImageResult<image::ImageReader<io::BufReader<std::fs::File>>> {
        let mut r = image::ImageReader::open(src)?.with_guessed_format()?;
        r.limits(decode_limits());
        Ok(r)
    };
    let dims = open().and_then(|r| r.into_dimensions());
    let (w, h) = match dims {
        Ok(d) => d,
        Err(e) => {
            tracing::debug!(error = %e, "could not read image dimensions");
            return info;
        }
    };
    info.width = Some(w);
    info.height = Some(h);
    if u64::from(w) * u64::from(h) > MAX_THUMB_SOURCE_PIXELS {
        tracing::debug!(w, h, "image too large for a thumbnail");
        return info;
    }
    let result = open().and_then(|r| r.decode()).and_then(|img| {
        img.thumbnail(THUMB_SIZE, THUMB_SIZE)
            .to_rgba8()
            .save_with_format(dest, image::ImageFormat::Png)
    });
    match result {
        Ok(()) => info.thumb = true,
        Err(e) => tracing::debug!(error = %e, "could not make thumbnail"),
    }
    info
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
/// Views whose allowed-attachment sets are kept.
const SHARE_SET_ENTRIES: usize = 64;

/// What a shared view exposes: attachment ids in visible attachment fields
/// of the live records the view's filter lets through. Keyed by view; valid
/// for one data version of the base, one view config and one day (relative
/// date filters).
type ShareSets = HashMap<String, (u64, u64, chrono::NaiveDate, Arc<HashSet<String>>)>;
static SHARE_SETS: LazyLock<Mutex<ShareSets>> = LazyLock::new(Mutex::default);

fn config_hash(config: &ob_core::view::ViewConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(config)
        .unwrap_or_default()
        .hash(&mut h);
    h.finish()
}

/// Every attachment id a public viewer of `r` can see (see [`ShareSets`]).
fn exposed_attachment_ids(
    conn: &rusqlite::Connection,
    state: &AppState,
    r: &Resolved,
) -> AppResult<Arc<HashSet<String>>> {
    let base_id = r.table.base_id.as_str();
    // Version first, data second (see store::versions).
    let version = state.events.versions().current(base_id);
    let hash = config_hash(&r.view.view.config);
    let day = chrono::Utc::now().date_naive();
    {
        let sets = SHARE_SETS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((v, h, d, set)) = sets.get(&r.view.view.id)
            && (*v, *h, *d) == (version, hash, day)
        {
            return Ok(set.clone());
        }
    }
    let fields = schema::table_fields(conn, &r.table.id)?;
    let visible = sharing::visible_fields(&r.view.view.config, &fields);
    let attachment_fields: Vec<&str> = visible
        .iter()
        .filter(|f| matches!(f.kind, FieldKind::Attachment(_)))
        .map(|f| f.id.as_str())
        .collect();
    let mut out = HashSet::new();
    if !attachment_fields.is_empty() {
        // Same query as the public records endpoint: the view's own filter,
        // no signed-in user.
        let req = QueryRequest::default();
        let entry = query::query_ids(
            conn,
            &state.query_cache,
            state.events.versions(),
            "",
            &r.view,
            &req,
        )?;
        for chunk in entry.ids.chunks(500) {
            for row in records::get_many(conn, chunk)? {
                if row.table_id != r.table.id || !row.is_live() {
                    continue;
                }
                for f in &attachment_fields {
                    let Some(Json2::Array(items)) = row.data.get(*f) else {
                        continue;
                    };
                    out.extend(
                        items
                            .iter()
                            .filter_map(|i| i.get("id").and_then(Json2::as_str))
                            .map(str::to_string),
                    );
                }
            }
        }
    }
    let out = Arc::new(out);
    let mut sets = SHARE_SETS.lock().unwrap_or_else(|p| p.into_inner());
    if sets.len() >= SHARE_SET_ENTRIES {
        sets.clear();
    }
    sets.insert(r.view.view.id.clone(), (version, hash, day, out.clone()));
    Ok(out)
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
        // Not in any base yet: an inbox upload, readable by its uploader only.
        return match actor {
            Some(a) if row.created_by.as_deref() == Some(a.user_id.as_str()) => Ok(row),
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
        .read(move |c| Ok(exposed_attachment_ids(c, &st, &resolved)?.contains(&att_id)))
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
    let (content_type, disposition) = if store::is_inline(&row.mime) {
        (row.mime.as_str(), "inline")
    } else {
        ("application/octet-stream", "attachment")
    };
    file_response(
        &path,
        content_type,
        &content_disposition(disposition, &row.filename),
    )
    .await
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
    file_response(&path, "image/png", &content_disposition("inline", &name)).await
}

/// Stream a file with the safe download headers.
async fn file_response(path: &Path, content_type: &str, disposition: &str) -> AppResult<Response> {
    let file = match tokio::fs::File::open(path).await {
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
    let mut res = Response::new(file_body(file));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, header_value(content_type)?);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
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
    let stream = futures::stream::unfold(Some(file), |state| async move {
        let mut file = state?;
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, io::Error>(Bytes::from(buf)), Some(file)))
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
    fn content_disposition_is_ascii_and_exact() {
        assert_eq!(
            content_disposition("attachment", "a b\"c.txt"),
            "attachment; filename=\"a b_c.txt\"; filename*=UTF-8''a%20b%22c.txt"
        );
        let cd = content_disposition("inline", "日本.png");
        assert!(cd.is_ascii());
        assert!(cd.ends_with("filename*=UTF-8''%E6%97%A5%E6%9C%AC.png"));
    }

    #[test]
    fn thumbnail_of_huge_dimensions_is_skipped_without_decoding() {
        // A PNG header claiming 10000 x 10000 pixels (100 MP) with no data.
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("big.png");
        let img = image::RgbImage::new(1, 1);
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let mut bytes = bytes.into_inner();
        // IHDR width/height live at offsets 16..24; patch them and fix the
        // chunk CRC (over type + data, bytes 12..29) so the header is valid.
        bytes[16..20].copy_from_slice(&10_000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&10_000u32.to_be_bytes());
        let mut crc = flate2::Crc::new();
        crc.update(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.sum().to_be_bytes());
        std::fs::write(&src, &bytes).unwrap();
        let dest = dir.path().join("t.png");
        let info = make_thumbnail(&src, &dest);
        assert_eq!((info.width, info.height), (Some(10_000), Some(10_000)));
        assert!(!info.thumb);
        assert!(!dest.exists());
    }

    #[test]
    fn thumbnail_keeps_aspect_ratio() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("tall.png");
        image::RgbImage::new(100, 1000).save(&src).unwrap();
        let dest = dir.path().join("t.png");
        let info = make_thumbnail(&src, &dest);
        assert_eq!(
            (info.width, info.height, info.thumb),
            (Some(100), Some(1000), true)
        );
        let t = image::open(&dest).unwrap();
        assert_eq!((t.width(), t.height()), (40, 400));
    }
}
