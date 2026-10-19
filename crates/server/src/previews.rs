//! Previews of uploaded files: the picture a file shows wherever files are listed
//! (`GET /api/attachments/{id}/thumb`), so what a file holds can be seen at a glance.
//!
//! - Raster images: the image itself, scaled down.
//! - PDFs: the first page, rasterized in pure Rust (hayro).
//! - Videos: the first frame, taken by `ffmpeg` when the server can find it (the Docker
//!   image ships it; `OPENBASE_FFMPEG` names another binary). Without it a video keeps its
//!   file-type tile.
//!
//! Every preview is a PNG at most [`THUMB_SIZE`] on its longest side. Previews are made one
//! at a time ([`DECODE_PERMITS`]) and given up after [`PREVIEW_TIMEOUT`], so one hostile file
//! cannot hold back everyone else's. A failure is logged and leaves the upload without a
//! preview: a file that cannot be previewed is still a valid upload.
//!
//! The width and height recorded are the source's: an image's pixels, a video frame's
//! pixels (as displayed, after rotation) and a PDF page's size in points.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use tokio::sync::Semaphore;

/// Images above this many pixels get no thumbnail (decoding is too costly).
pub const MAX_THUMB_SOURCE_PIXELS: u64 = 40_000_000;
/// Decoder allocation cap.
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
/// Longest thumbnail side.
pub const THUMB_SIZE: u32 = 400;
/// PDFs above this size get no preview: the renderer reads the whole file into memory.
const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
/// How long one preview may take before it is given up.
pub const PREVIEW_TIMEOUT: Duration = Duration::from_secs(30);

/// One preview at a time: decoding is the most memory-hungry thing the server does, and
/// the VPS budget is small.
static DECODE_PERMITS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

/// What kind of preview a file gets, decided from its first bytes (never its name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
    /// A video, with the ffmpeg demuxer its container needs.
    Video(&'static str),
}

/// The preview a file gets: `head` is its first bytes, `mime` the type recorded for it.
pub fn kind(head: &[u8], mime: &str) -> Option<Kind> {
    if crate::store::attachments::sniff_image(head).is_some() {
        return Some(Kind::Image);
    }
    if head.starts_with(b"%PDF-") {
        return Some(Kind::Pdf);
    }
    video_demuxer(mime).map(Kind::Video)
}

/// The ffmpeg demuxer of a sniffed video type. Only containers sniffed from the bytes
/// (see `sniff_media`) qualify, and ffmpeg is told which one to use, so a crafted file
/// cannot reach ffmpeg's playlist or concat demuxers (which fetch URLs and read files).
pub fn video_demuxer(mime: &str) -> Option<&'static str> {
    match mime {
        "video/mp4" | "video/quicktime" => Some("mov"),
        "video/webm" => Some("matroska"),
        "video/ogg" => Some("ogg"),
        _ => None,
    }
}

/// What making a preview found out.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// A preview PNG was written to the destination.
    pub thumb: bool,
}

/// Make the preview of `src` (a file of `kind`) as a PNG at `dest`.
pub async fn make(kind: Kind, src: PathBuf, dest: PathBuf) -> Info {
    let Ok(_permit) = DECODE_PERMITS.acquire().await else {
        return Info::default();
    };
    let work = async {
        match kind {
            Kind::Image => blocking(move || image_thumbnail(&src, &dest)).await,
            Kind::Pdf => blocking(move || pdf_preview(&src, &dest)).await,
            Kind::Video(demuxer) => video_preview(demuxer, &src, &dest).await,
        }
    };
    match tokio::time::timeout(PREVIEW_TIMEOUT, work).await {
        Ok(info) => info,
        Err(_) => {
            // A blocking render cannot be stopped; it finishes in the background, but the
            // permit is released so other uploads get their previews meanwhile.
            tracing::warn!(?kind, "preview took too long; skipped");
            Info::default()
        }
    }
}

async fn blocking(f: impl FnOnce() -> Info + Send + 'static) -> Info {
    match tokio::task::spawn_blocking(f).await {
        Ok(info) => info,
        Err(e) => {
            // Also a renderer panic on a malformed file.
            tracing::warn!(error = %e, "preview task failed");
            Info::default()
        }
    }
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    limits
}

/// Dimensions and thumbnail of a raster image.
pub fn image_thumbnail(src: &Path, dest: &Path) -> Info {
    let mut info = Info::default();
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

/// The first page of a PDF, on white, scaled so its longest side is [`THUMB_SIZE`].
pub fn pdf_preview(src: &Path, dest: &Path) -> Info {
    let mut info = Info::default();
    match std::fs::metadata(src) {
        Ok(m) if m.len() <= MAX_PDF_BYTES => {}
        Ok(_) => {
            tracing::debug!("PDF too large for a preview");
            return info;
        }
        Err(e) => {
            tracing::debug!(error = %e, "could not read PDF");
            return info;
        }
    }
    let data = match std::fs::read(src) {
        Ok(d) => d,
        Err(e) => {
            tracing::debug!(error = %e, "could not read PDF");
            return info;
        }
    };
    let pdf = match hayro::hayro_syntax::Pdf::new(data) {
        Ok(p) => p,
        Err(e) => {
            tracing::debug!(error = ?e, "could not open PDF");
            return info;
        }
    };
    let Some(page) = pdf.pages().first() else {
        return info;
    };
    let (w, h) = page.render_dimensions();
    if !(w.is_finite() && h.is_finite() && w >= 1.0 && h >= 1.0) {
        return info;
    }
    info.width = Some(w.round() as u32);
    info.height = Some(h.round() as u32);
    // The renderer truncates the scaled size: half a pixel more keeps the long side at THUMB_SIZE.
    let scale = (THUMB_SIZE as f32 + 0.5) / w.max(h);
    let pixmap = hayro::render(
        page,
        &hayro::RenderCache::new(),
        &hayro::hayro_interpret::InterpreterSettings::default(),
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: hayro::vello_cpu::color::palette::css::WHITE,
        },
    );
    match pixmap
        .into_png()
        .map_err(io::Error::other)
        .and_then(|png| std::fs::write(dest, png))
    {
        Ok(()) => info.thumb = true,
        Err(e) => tracing::debug!(error = %e, "could not write PDF preview"),
    }
    info
}

/// The ffmpeg binary: `OPENBASE_FFMPEG` if set, else `ffmpeg` on the `PATH`, looked up once.
pub fn ffmpeg() -> Option<&'static Path> {
    static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
    FFMPEG
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("OPENBASE_FFMPEG").filter(|p| !p.is_empty()) {
                return Some(PathBuf::from(path));
            }
            let name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
            let found = std::env::var_os("PATH")
                .and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join(&name)).find(|p| p.is_file()));
            if found.is_none() {
                tracing::info!("ffmpeg not found: videos get no preview (install ffmpeg or set OPENBASE_FFMPEG)");
            }
            found
        })
        .as_deref()
}

/// The first frame of a video, scaled so its longest side is [`THUMB_SIZE`].
async fn video_preview(demuxer: &'static str, src: &Path, dest: &Path) -> Info {
    let Some(ffmpeg) = ffmpeg() else {
        return Info::default();
    };
    let mut frame = dest.as_os_str().to_owned();
    frame.push(".frame.png");
    let frame = PathBuf::from(frame);
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
    ])
    // Local files only, and the container named: no network, no playlists.
    .args(["-protocol_whitelist", "file", "-f", demuxer, "-i"])
    .arg(file_url(src))
    .args([
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-f",
        "image2",
        "-c:v",
        "png",
        "-y",
    ])
    .arg(file_url(&frame))
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    let out = match cmd.output().await {
        Ok(out) => out,
        Err(e) => {
            tracing::warn!(error = %e, "could not run ffmpeg");
            return Info::default();
        }
    };
    if !out.status.success() {
        tracing::debug!(stderr = %String::from_utf8_lossy(&out.stderr), "ffmpeg could not take a frame");
        let _ = std::fs::remove_file(&frame);
        return Info::default();
    }
    let dest = dest.to_path_buf();
    let frame_done = frame.clone();
    let info = blocking(move || {
        let info = image_thumbnail(&frame_done, &dest);
        let _ = std::fs::remove_file(&frame_done);
        info
    })
    .await;
    let _ = std::fs::remove_file(&frame);
    info
}

/// `file:` URL of a path, so ffmpeg never reads a colon in a file name as a protocol.
fn file_url(path: &Path) -> std::ffi::OsString {
    let mut url = std::ffi::OsString::from("file:");
    url.push(path.as_os_str());
    url
}

/// Give the files stored before previews existed (or before ffmpeg was installed) their
/// preview: every PDF and video without one, once per distinct content. Run once at startup,
/// in the background; returns how many contents got a preview.
pub async fn backfill(state: &crate::state::AppState) -> crate::error::AppResult<usize> {
    use crate::store::attachments as store;
    let pending: Vec<(String, String)> = state
        .db
        .read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT sha256, MIN(mime) FROM attachments
                     WHERE has_thumb = 0
                       AND mime IN ('application/pdf', 'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg')
                     GROUP BY sha256",
                )
                .map_err(crate::error::AppError::internal)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(crate::error::AppError::internal)?;
            rows.collect::<Result<_, _>>().map_err(crate::error::AppError::internal)
        })
        .await?;
    let dir = state.config.attachments_dir();
    let tmp_dir = state.config.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(crate::error::AppError::internal)?;
    let mut made = 0;
    for (sha, mime) in pending {
        let blob = store::blob_path(&dir, &sha)?;
        let Some(kind) = head_of(&blob).await.and_then(|head| kind(&head, &mime)) else {
            continue;
        };
        if matches!(kind, Kind::Video(_)) && ffmpeg().is_none() {
            continue;
        }
        let tmp = tmp_dir.join(format!("backfill-{}.png", crate::ids::new_id("")));
        let info = make(kind, blob.clone(), tmp.clone()).await;
        if !info.thumb {
            let _ = std::fs::remove_file(&tmp);
            continue;
        }
        let (dir, sha, tmp_moved) = (dir.clone(), sha.clone(), tmp.clone());
        // Under the writer, like an upload, so garbage collection cannot delete the file
        // between the check and the update.
        let saved = state
            .db
            .write(move |tx| {
                let thumb = store::thumb_path(&dir, &sha)?;
                if !store::sha_in_use(tx, &sha)? {
                    return Ok(false);
                }
                if !thumb.exists() {
                    if let Some(parent) = thumb.parent() {
                        std::fs::create_dir_all(parent).map_err(crate::error::AppError::internal)?;
                    }
                    std::fs::rename(&tmp_moved, &thumb)
                        .or_else(|_| std::fs::copy(&tmp_moved, &thumb).map(|_| ()))
                        .map_err(crate::error::AppError::internal)?;
                }
                tx.execute(
                    "UPDATE attachments SET has_thumb = 1, width = COALESCE(width, ?2), height = COALESCE(height, ?3)
                     WHERE sha256 = ?1",
                    rusqlite::params![sha, info.width, info.height],
                )
                .map_err(crate::error::AppError::internal)?;
                Ok(true)
            })
            .await;
        let _ = std::fs::remove_file(&tmp);
        match saved {
            Ok(true) => made += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "could not save a preview"),
        }
    }
    Ok(made)
}

/// The first bytes of a stored file, for [`kind`].
async fn head_of(path: &Path) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut head = vec![0u8; 64];
    let mut n = 0;
    while n < head.len() {
        match file.read(&mut head[n..]).await {
            Ok(0) | Err(_) => break,
            Ok(m) => n += m,
        }
    }
    head.truncate(n);
    Some(head)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let info = image_thumbnail(&src, &dest);
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
        let info = image_thumbnail(&src, &dest);
        assert_eq!(
            (info.width, info.height, info.thumb),
            (Some(100), Some(1000), true)
        );
        let t = image::open(&dest).unwrap();
        assert_eq!((t.width(), t.height()), (40, 400));
    }

    #[test]
    fn kind_comes_from_the_bytes() {
        assert_eq!(
            kind(b"\x89PNG\r\n\x1a\n....", "image/png"),
            Some(Kind::Image)
        );
        assert_eq!(kind(b"%PDF-1.7\n", "application/pdf"), Some(Kind::Pdf));
        // A name or a declared type alone is not enough.
        assert_eq!(kind(b"<html>", "application/pdf"), None);
        assert_eq!(kind(b"....ftypisom", "video/mp4"), Some(Kind::Video("mov")));
        assert_eq!(kind(b"#EXTM3U\n", "application/vnd.apple.mpegurl"), None);
    }

    #[test]
    fn a_pdf_previews_its_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("doc.pdf");
        std::fs::write(&src, two_page_pdf()).unwrap();
        let dest = dir.path().join("t.png");
        let info = pdf_preview(&src, &dest);
        // US Letter: 612 x 792 points.
        assert_eq!(
            (info.width, info.height, info.thumb),
            (Some(612), Some(792), true)
        );
        let t = image::open(&dest).unwrap().to_rgb8();
        assert_eq!((t.width(), t.height()), (309, 400));
        // The first page is a black square on white: dark in the middle, white in the corner.
        assert!(t.get_pixel(154, 200).0[0] < 64, "the page's drawing shows");
        assert_eq!(t.get_pixel(2, 2).0, [255, 255, 255]);
    }

    #[test]
    fn a_broken_pdf_gets_no_preview() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("doc.pdf");
        std::fs::write(&src, b"%PDF-1.7 fake").unwrap();
        let dest = dir.path().join("t.png");
        assert_eq!(pdf_preview(&src, &dest), Info::default());
        assert!(!dest.exists());
    }

    /// A two-page US Letter PDF whose first page fills a square in its middle, with a
    /// correct cross-reference table.
    pub(crate) fn two_page_pdf() -> Vec<u8> {
        let page1 = b"0 0 0 rg 156 246 300 300 re f";
        let page2 = b"";
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>".to_vec(),
            [
                format!("<< /Length {} >>\nstream\n", page1.len()).as_bytes(),
                page1,
                b"\nendstream",
            ]
            .concat(),
            [
                format!("<< /Length {} >>\nstream\n", page2.len()).as_bytes(),
                page2,
                b"\nendstream",
            ]
            .concat(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for off in offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }
}
