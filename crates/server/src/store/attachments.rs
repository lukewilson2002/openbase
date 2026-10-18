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

use ob_core::field::AttachmentRef;
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

/// Brands of an ISO base media (`ftyp`) file that are audio or video. Others (HEIC, AVIF, ...)
/// are not media this server plays inline.
const MP4_VIDEO_BRANDS: [&[u8; 4]; 17] = [
    b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"mp71", b"avc1",
    b"dash", b"msnv", b"M4V ", b"M4VH", b"M4VP", b"f4v ", b"mmp4",
];
const MP4_AUDIO_BRANDS: [&[u8; 4]; 4] = [b"M4A ", b"M4B ", b"F4A ", b"F4B "];

/// Detect browser-playable video and audio by magic bytes (`head`: the first few hundred bytes
/// of the file). Like [`sniff_image`], only the content counts, never the extension or the
/// client's declared type. WebM is always `video/webm` (an audio-only WebM plays fine in an
/// `<audio>` element under that type); Ogg is video only when it carries Theora.
pub fn sniff_media(head: &[u8]) -> Option<&'static str> {
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        return if brand == b"qt  " {
            Some("video/quicktime")
        } else if MP4_AUDIO_BRANDS.iter().any(|b| b.as_slice() == brand) {
            Some("audio/mp4")
        } else if MP4_VIDEO_BRANDS.iter().any(|b| b.as_slice() == brand) {
            Some("video/mp4")
        } else {
            None
        };
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        // EBML header; the doctype ("webm" or "matroska") is in its first bytes.
        let window = &head[..head.len().min(64)];
        return window
            .windows(4)
            .any(|w| w == b"webm")
            .then_some("video/webm");
    }
    if head.starts_with(b"OggS") {
        let has = |needle: &[u8]| head.windows(needle.len()).any(|w| w == needle);
        return Some(if has(b"\x80theora") {
            "video/ogg"
        } else {
            "audio/ogg"
        });
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if head.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if head.starts_with(b"ID3") {
        return Some("audio/mpeg");
    }
    // A bare MPEG audio frame: 11 sync bits, a valid version, layer, bitrate and sample rate.
    if head.len() >= 4 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0 {
        let version = (head[1] >> 3) & 3;
        let layer = (head[1] >> 1) & 3;
        let bitrate = head[2] >> 4;
        let rate = (head[2] >> 2) & 3;
        if version != 1 && bitrate != 0xF && rate != 3 {
            // Layer 0 with valid sync is ADTS (raw AAC).
            return Some(if layer == 0 {
                "audio/aac"
            } else {
                "audio/mpeg"
            });
        }
    }
    None
}

/// The MIME type to record: the sniffed image type if any, else a guess from
/// the extension (informational only, e.g. for file icons). A raster-image
/// guess whose bytes did not match is demoted, so the stored type is never a
/// lie that would make the file render inline.
pub fn detect_mime(head: &[u8], filename: &str) -> String {
    if let Some(m) = sniff_image(head).or_else(|| sniff_media(head)) {
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
const ID_PREFIX: &str = ob_core::ids::ATTACHMENT;
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

/// The prefix of the address an embedded or linked file has in long text.
pub const REF_PREFIX: &str = "/api/attachments/";

/// Spans `(start, end, id)` of every `/api/attachments/<id>/` reference in `text`: `start..end`
/// is the id. Only this address form counts, never a bare id in prose.
fn ref_spans(text: &str) -> Vec<(usize, usize, &str)> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(pos) = text[from..].find(REF_PREFIX) {
        let start = from + pos + REF_PREFIX.len();
        from = start;
        let end = start + ID_PREFIX.len() + ID_SUFFIX_LEN;
        if text[start..].starts_with(ID_PREFIX)
            && end < bytes.len()
            && bytes[start + ID_PREFIX.len()..end]
                .iter()
                .all(u8::is_ascii_alphanumeric)
            && bytes[end] == b'/'
        {
            out.push((start, end, &text[start..end]));
        }
    }
    out
}

/// The distinct file ids referenced in `text` (`/api/attachments/<id>/...`), in order.
pub fn referenced_ids(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    ref_spans(text)
        .into_iter()
        .filter(|(_, _, id)| seen.insert(*id))
        .map(|(_, _, id)| id.to_string())
        .collect()
}

/// `text` with every referenced file id replaced by its entry in `map` (ids not in the map
/// stay).
pub fn remap_refs(text: &str, map: &std::collections::HashMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, end, id) in ref_spans(text) {
        if let Some(new) = map.get(id) {
            out.push_str(&text[last..start]);
            out.push_str(new);
            last = end;
        }
    }
    out.push_str(&text[last..]);
    out
}

/// The first file referenced in `text` that is not a file of `base_id` (a foreign project's,
/// somebody's inbox upload, or one that does not exist). References already present in `held`
/// (the value being replaced) are left alone, so editing other text of an old value never
/// fails.
pub fn first_foreign_ref(
    conn: &Connection,
    base_id: &str,
    text: &str,
    held: Option<&str>,
) -> AppResult<Option<String>> {
    let held: HashSet<String> = held
        .map(referenced_ids)
        .unwrap_or_default()
        .into_iter()
        .collect();
    for id in referenced_ids(text) {
        if held.contains(&id) {
            continue;
        }
        let ok = get(conn, &id)?.is_some_and(|a| a.base_id.as_deref() == Some(base_id));
        if !ok {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Delete attachment rows that nothing references: created before
/// `cutoff_ms`, or (uploads without a user, i.e. from public forms) before
/// `anonymous_cutoff_ms`. "Referenced" means mentioned in the data of any
/// record (live or trashed), in a comment or in the retained record history, in any field including long text: removing a
/// file from a cell must stay undoable (client-side undo, copying from the
/// history panel) for as long as that history exists. Returns the hashes of
/// the deleted rows. Files of inbox drafts (list and embedded in the text) count as referenced too.
///
/// Equivalent to `NOT EXISTS (SELECT 1 FROM records WHERE instr(data, id))`
/// but scans the records once instead of once per attachment; the history is
/// scanned (once) only when some candidate is unreferenced by the records.
pub fn delete_unreferenced(
    conn: &Connection,
    cutoff_ms: i64,
    anonymous_cutoff_ms: i64,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id, sha256 FROM attachments
         WHERE created_at < ?1 OR (created_by IS NULL AND created_at < ?2)",
    )?;
    let candidates: Vec<(String, String)> = stmt
        .query_map([cutoff_ms, anonymous_cutoff_ms], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
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
    // Files of unfiled inbox drafts are still wanted: those in the file list and those
    // embedded or linked in the text.
    let mut stmt = conn.prepare(
        "SELECT attachments, body FROM inbox_items
         WHERE attachments != '[]' OR instr(body, ?1) > 0",
    )?;
    let mut rows = stmt.query([REF_PREFIX])?;
    while let Some(row) = rows.next()? {
        let files: String = row.get(0)?;
        ids_in(&files, &mut referenced);
        let body: String = row.get(1)?;
        referenced.extend(referenced_ids(&body));
    }
    // Files embedded or linked in comments (including ones filed from a draft's note) are
    // referenced from there only.
    let mut stmt = conn.prepare("SELECT body FROM comments WHERE instr(body, ?1) > 0")?;
    let mut rows = stmt.query([REF_PREFIX])?;
    while let Some(row) = rows.next()? {
        let body: String = row.get(0)?;
        referenced.extend(referenced_ids(&body));
    }
    if candidates.iter().any(|(id, _)| !referenced.contains(id)) {
        let mut stmt =
            conn.prepare("SELECT changes FROM record_history WHERE instr(changes, ?1) > 0")?;
        let mut rows = stmt.query([ID_PREFIX])?;
        while let Some(row) = rows.next()? {
            let changes: String = row.get(0)?;
            ids_in(&changes, &mut referenced);
        }
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

/// Bytes of the files `user_id` uploaded that are in no base (inbox uploads, whether or not
/// a draft holds them yet).
pub fn unattached_bytes(conn: &Connection, user_id: &str) -> AppResult<u64> {
    let n: i64 = conn.query_row(
        "SELECT coalesce(sum(size), 0) FROM attachments
         WHERE base_id IS NULL AND created_by = ?1",
        [user_id],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u64)
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
    fn sniffs_video_and_audio_by_magic_only() {
        let ftyp = |brand: &[u8; 4]| {
            let mut v = vec![0, 0, 0, 0x14];
            v.extend_from_slice(b"ftyp");
            v.extend_from_slice(brand);
            v.extend_from_slice(&[0; 8]);
            v
        };
        assert_eq!(sniff_media(&ftyp(b"isom")), Some("video/mp4"));
        assert_eq!(sniff_media(&ftyp(b"mp42")), Some("video/mp4"));
        assert_eq!(sniff_media(&ftyp(b"M4A ")), Some("audio/mp4"));
        assert_eq!(sniff_media(&ftyp(b"qt  ")), Some("video/quicktime"));
        // Image brands share the box layout and are not media.
        assert_eq!(sniff_media(&ftyp(b"avif")), None);
        assert_eq!(sniff_media(&ftyp(b"heic")), None);
        let mut webm = vec![0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x82, 0x84];
        webm.extend_from_slice(b"webm");
        assert_eq!(sniff_media(&webm), Some("video/webm"));
        let mut mkv = vec![0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x82, 0x88];
        mkv.extend_from_slice(b"matroska");
        assert_eq!(sniff_media(&mkv), None);
        assert_eq!(sniff_media(b"OggS\0\x02....\x01vorbis"), Some("audio/ogg"));
        assert_eq!(sniff_media(b"OggS\0\x02....\x80theora"), Some("video/ogg"));
        assert_eq!(sniff_media(b"RIFF\0\0\0\0WAVEfmt "), Some("audio/wav"));
        assert_eq!(sniff_media(b"RIFF\0\0\0\0AVI LIST"), None);
        assert_eq!(sniff_media(b"fLaC...."), Some("audio/flac"));
        assert_eq!(sniff_media(b"ID3\x04rest"), Some("audio/mpeg"));
        assert_eq!(sniff_media(&[0xFF, 0xFB, 0x90, 0x00]), Some("audio/mpeg"));
        assert_eq!(sniff_media(&[0xFF, 0xF1, 0x50, 0x80]), Some("audio/aac"));
        // JPEG, text, markup and short input are not media.
        assert_eq!(sniff_media(&[0xFF, 0xD8, 0xFF, 0xE0]), None);
        assert_eq!(sniff_media(b"<html>"), None);
        assert_eq!(sniff_media(b"<svg xmlns="), None);
        assert_eq!(sniff_media(b""), None);
        assert_eq!(sniff_media(&[0xFF]), None);
    }

    #[test]
    fn finds_file_references_by_address_only() {
        let a = "attAAAAAAAAAAAAA1";
        let b = "attBBBBBBBBBBBBB2";
        let text = format!(
            "![x](/api/attachments/{a}/a%20b.png \"cap\") see {b} and [f](/api/attachments/{b}/f.pdf) \
             and again /api/attachments/{a}/thumb; not /api/attachments/att123/x, nor \
             /api/attachments/{a}x/y, nor /api/attachments/{a}"
        );
        assert_eq!(referenced_ids(&text), [a, b]);
        assert!(referenced_ids(&format!("just {a} in prose")).is_empty());
        assert!(referenced_ids("").is_empty());
        let map = [(a.to_string(), "attCCCCCCCCCCCCC3".to_string())].into();
        let out = remap_refs(&text, &map);
        assert!(!out.contains(&format!("{a}/")));
        assert_eq!(referenced_ids(&out), ["attCCCCCCCCCCCCC3", b]);
        assert!(out.contains(&format!("see {b} and")));
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
