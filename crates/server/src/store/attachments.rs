//! Attachment metadata and on-disk layout.
//!
//! Bytes are content-addressed: `<data_dir>/attachments/<sha[0..2]>/<sha>`,
//! with an optional thumbnail `<sha>.thumb.png` next to it. Many attachment
//! rows (one per upload) may share one file. Files are immutable; they are
//! deleted only by garbage collection once no row references their hash.
//!
//! Upload streaming lives in `api::attachments`; this module holds the pure
//! helpers (filename sanitizing, type sniffing) and the SQL.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use og_core::field::AttachmentRef;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{AppError, AppResult};

/// Image types served inline. Everything else is a download.
pub const INLINE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Maximum filename length in bytes.
pub const MAX_FILENAME_BYTES: usize = 255;

/// One row of the `attachments` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub id: String,
    pub sha256: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub has_thumb: bool,
    pub base_id: Option<String>,
    pub created_by: Option<String>,
    pub created_at: i64,
}

impl Attachment {
    /// The reference stored in attachment cells.
    pub fn to_ref(&self) -> AttachmentRef {
        AttachmentRef {
            id: self.id.clone(),
            filename: self.filename.clone(),
            mime: self.mime.clone(),
            size: self.size,
            width: self.width,
            height: self.height,
        }
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Path of the file holding the bytes for `sha` (lowercase hex SHA-256).
pub fn blob_path(attachments_dir: &Path, sha: &str) -> AppResult<PathBuf> {
    if !is_sha256_hex(sha) {
        return Err(AppError::internal(format!(
            "invalid attachment hash '{sha}'"
        )));
    }
    Ok(attachments_dir.join(&sha[..2]).join(sha))
}

/// Path of the thumbnail for `sha`.
pub fn thumb_path(attachments_dir: &Path, sha: &str) -> AppResult<PathBuf> {
    let blob = blob_path(attachments_dir, sha)?;
    Ok(blob.with_file_name(format!("{sha}.thumb.png")))
}

/// Make a client-supplied filename safe to store and show: keep only the last
/// path component (either slash), drop control and bidi-override characters,
/// trim whitespace and dots at the ends, cap at 255 bytes (on a char
/// boundary, keeping a short extension when possible), never empty.
pub fn sanitize_filename(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !is_bidi_control(*c))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "file".to_string();
    }
    if trimmed.len() <= MAX_FILENAME_BYTES {
        return trimmed.to_string();
    }
    // Too long: keep the extension (if short) and truncate the stem.
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 16 => (s, format!(".{e}")),
        _ => (trimmed, String::new()),
    };
    let mut budget = MAX_FILENAME_BYTES - ext.len();
    while !stem.is_char_boundary(budget) {
        budget -= 1;
    }
    format!("{}{}", stem[..budget].trim_end(), ext)
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Detect raster image types by magic bytes. Only these are trusted to be
/// images; the client's declared type and the extension are ignored.
pub fn sniff_image(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The MIME type to record: the sniffed image type if any, else a guess from
/// the extension (informational only, e.g. for file icons). A raster-image
/// guess whose bytes did not match is demoted, so the stored type is never a
/// lie that would make the file render inline.
pub fn detect_mime(head: &[u8], filename: &str) -> String {
    if let Some(m) = sniff_image(head) {
        return m.to_string();
    }
    let guess = mime_guess::from_path(filename).first_or_octet_stream();
    let guess = guess.essence_str();
    if INLINE_MIMES.contains(&guess) {
        "application/octet-stream".to_string()
    } else {
        guess.to_string()
    }
}

/// Whether a stored MIME type may be served inline.
pub fn is_inline(mime: &str) -> bool {
    INLINE_MIMES.contains(&mime)
}

pub fn insert(conn: &Connection, a: &Attachment) -> AppResult<()> {
    conn.execute(
        "INSERT INTO attachments
            (id, sha256, filename, mime, size, width, height, has_thumb, base_id, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            a.id,
            a.sha256,
            a.filename,
            a.mime,
            a.size as i64,
            a.width,
            a.height,
            a.has_thumb,
            a.base_id,
            a.created_by,
            a.created_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Attachment>> {
    Ok(conn
        .query_row(
            "SELECT id, sha256, filename, mime, size, width, height, has_thumb, base_id, created_by, created_at
             FROM attachments WHERE id = ?1",
            [id],
            |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    filename: r.get(2)?,
                    mime: r.get(3)?,
                    size: r.get::<_, i64>(4)?.max(0) as u64,
                    width: r.get(5)?,
                    height: r.get(6)?,
                    has_thumb: r.get(7)?,
                    base_id: r.get(8)?,
                    created_by: r.get(9)?,
                    created_at: r.get(10)?,
                })
            },
        )
        .optional()?)
}

/// Attachment ids look like `att` + 14 base62 characters.
const ID_PREFIX: &str = og_core::ids::ATTACHMENT;
const ID_SUFFIX_LEN: usize = 14;

/// Every attachment-id-shaped token in `text`.
fn ids_in(text: &str, out: &mut HashSet<String>) {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(pos) = text[from..].find(ID_PREFIX) {
        let start = from + pos;
        let end = start + ID_PREFIX.len() + ID_SUFFIX_LEN;
        if end <= bytes.len()
            && bytes[start + ID_PREFIX.len()..end]
                .iter()
                .all(u8::is_ascii_alphanumeric)
        {
            out.insert(text[start..end].to_string());
        }
        from = start + ID_PREFIX.len();
    }
}

/// Delete attachment rows created before `cutoff_ms` that no record (live or
/// trashed) mentions in its data JSON. Returns the hashes of the deleted rows.
///
/// Equivalent to `NOT EXISTS (SELECT 1 FROM records WHERE instr(data, id))`
/// but scans the records once instead of once per attachment.
pub fn delete_unreferenced(conn: &Connection, cutoff_ms: i64) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id, sha256 FROM attachments WHERE created_at < ?1")?;
    let candidates: Vec<(String, String)> = stmt
        .query_map([cutoff_ms], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut referenced = HashSet::new();
    let mut stmt = conn.prepare("SELECT data FROM records WHERE instr(data, ?1) > 0")?;
    let mut rows = stmt.query([ID_PREFIX])?;
    while let Some(row) = rows.next()? {
        let data: String = row.get(0)?;
        ids_in(&data, &mut referenced);
    }
    let mut del = conn.prepare("DELETE FROM attachments WHERE id = ?1")?;
    let mut shas = Vec::new();
    for (id, sha) in candidates {
        if !referenced.contains(&id) {
            del.execute([&id])?;
            shas.push(sha);
        }
    }
    Ok(shas)
}

/// Whether any attachment row still uses the file with this hash.
pub fn sha_in_use(conn: &Connection, sha: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM attachments WHERE sha256 = ?1 LIMIT 1",
            [sha],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\bob\\evil.txt"), "evil.txt");
        assert_eq!(sanitize_filename("a\u{0}b\r\n.txt"), "ab.txt");
        assert_eq!(sanitize_filename("cv\u{202E}fdp.exe"), "cvfdp.exe");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename(".."), "file");
        assert_eq!(sanitize_filename("dir/"), "file");
        assert_eq!(sanitize_filename("   "), "file");
        assert_eq!(sanitize_filename(" .hidden "), "hidden");
        assert_eq!(sanitize_filename("résumé.pdf"), "résumé.pdf");
        let long = format!("{}.jpeg", "é".repeat(300));
        let s = sanitize_filename(&long);
        assert!(s.len() <= MAX_FILENAME_BYTES, "{}", s.len());
        assert!(s.ends_with(".jpeg"));
        let long_no_ext = "x".repeat(1000);
        assert_eq!(sanitize_filename(&long_no_ext).len(), MAX_FILENAME_BYTES);
    }

    #[test]
    fn sniffs_images_by_magic_only() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg xmlns="), None);
        assert_eq!(sniff_image(b"<html>"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn detect_mime_never_trusts_extension_for_images() {
        assert_eq!(
            detect_mime(b"<html>", "evil.png"),
            "application/octet-stream"
        );
        assert_eq!(detect_mime(b"\x89PNG\r\n\x1a\n", "photo.txt"), "image/png");
        assert_eq!(detect_mime(b"%PDF-1.7", "doc.pdf"), "application/pdf");
        assert_eq!(detect_mime(b"<svg>", "x.svg"), "image/svg+xml");
        assert!(!is_inline("image/svg+xml"));
        assert!(!is_inline("text/html"));
        assert!(is_inline("image/png"));
    }

    #[test]
    fn blob_paths_require_a_real_hash() {
        let dir = Path::new("/data/attachments");
        let sha = "a".repeat(64);
        assert_eq!(blob_path(dir, &sha).unwrap(), dir.join("aa").join(&sha));
        assert_eq!(
            thumb_path(dir, &sha).unwrap(),
            dir.join("aa").join(format!("{sha}.thumb.png"))
        );
        assert!(blob_path(dir, "../../etc/passwd").is_err());
        assert!(blob_path(dir, &"A".repeat(64)).is_err());
    }

    #[test]
    fn finds_attachment_ids_in_text() {
        let mut set = HashSet::new();
        ids_in(
            r#"{"fld1":[{"id":"attAAAAAAAAAAAAA1","filename":"x"}],"fld2":"attention please","fld3":"att12345678901234"}"#,
            &mut set,
        );
        assert!(set.contains("attAAAAAAAAAAAAA1"));
        assert!(set.contains("att12345678901234"));
        assert_eq!(set.len(), 2, "{set:?}");
        let mut empty = HashSet::new();
        ids_in("att", &mut empty);
        ids_in("atté", &mut empty);
        assert!(empty.is_empty());
    }
}
