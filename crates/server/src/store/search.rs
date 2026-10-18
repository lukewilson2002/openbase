//! Search everything the caller can open (`GET /api/search`): the names of
//! workspaces, bases, tables and views, the text of records, and comments.
//!
//! Access is decided exactly as for opening things: workspaces the caller is a
//! member of, the bases of them they can open (`perm::require_base`, which also
//! applies an API token's base limit), and in those the views the caller can
//! see (shared ones and their own personal ones).

use ob_core::api::search::SearchResult;
use rusqlite::Connection;

use crate::auth::Actor;
use crate::engine::query::{self, RecordHit};
use crate::engine::write::user_timezone;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::store::bases::{self, BaseRow};
use crate::store::links::NameCache;
use crate::store::schema::{self, TableRow};

/// Results returned when the request names no limit, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 50;
/// Longest search text, in characters.
pub const MAX_QUERY_CHARS: usize = 200;

/// Records read per search, across all tables. Record text has no index:
/// every table is scanned the way the grid search scans it, parsing each
/// record. The search box asks again after every pause in typing, so a search
/// may cost about one full table's scan (the most records a table can hold),
/// a fraction of a second, however many tables the caller can open. Tables
/// beyond the budget are not searched for records; their names still are.
pub const MAX_RECORDS_SCANNED: usize = ob_core::limits::MAX_RECORDS_PER_TABLE;
/// Tables whose records are searched per request: each one costs a schema read
/// even when it is empty, which the record budget does not count.
pub const MAX_TABLES_SCANNED: usize = 100;
/// Characters of a record's matching text shown around the match.
const SNIPPET_CHARS: usize = 120;
const SNIPPET_BEFORE: usize = 40;

/// The search text, trimmed and lower-cased like the grid search's, or a 400
/// when it is empty or longer than [`MAX_QUERY_CHARS`].
pub fn needle(q: &str) -> AppResult<String> {
    let q = q.trim();
    let n = q.chars().count();
    if n == 0 {
        return Err(AppError::bad_request("type something to search for (q)"));
    }
    if n > MAX_QUERY_CHARS {
        return Err(AppError::bad_request(format!(
            "search text is too long (maximum {MAX_QUERY_CHARS} characters)"
        )));
    }
    Ok(q.to_lowercase())
}

/// A live workspace the caller is a member of.
struct Workspace {
    id: String,
    name: String,
    color: String,
}

/// A result and where it sorts: names before records, then text that starts
/// with the query before text that only contains it, then (for names) the
/// kind, then the order things appear in the sidebar.
struct Ranked {
    group: u8,
    rank: u8,
    kind: u8,
    result: SearchResult,
}

fn located(
    kind: &str,
    id: &str,
    name: &str,
    ws: &Workspace,
    base: Option<&BaseRow>,
) -> SearchResult {
    SearchResult {
        kind: kind.to_string(),
        id: id.to_string(),
        name: name.to_string(),
        workspace_id: ws.id.clone(),
        workspace_name: ws.name.clone(),
        workspace_color: ws.color.clone(),
        base_id: base.map(|b| b.id.clone()),
        base_name: base.map(|b| b.name.clone()),
        base_icon: base.and_then(|b| b.icon.clone()),
        base_color: base.map(|b| b.color.clone()),
        table_id: None,
        table_name: None,
        view_id: None,
        view_type: None,
        record_id: None,
        snippet: None,
        author_name: None,
    }
}

fn view_type_name(v: &schema::ViewRow) -> Option<String> {
    serde_json::to_value(v.view.view_type)
        .ok()
        .and_then(|t| t.as_str().map(str::to_string))
}

/// 0 when `name` starts with the needle, 1 when it contains it, else None.
fn name_rank(name: &str, needle: &str) -> Option<u8> {
    let lower = name.to_lowercase();
    if lower.starts_with(needle) {
        Some(0)
    } else if lower.contains(needle) {
        Some(1)
    } else {
        None
    }
}

/// A table whose records may be searched, with what its results need.
struct Scan<'a> {
    ws: &'a Workspace,
    base: &'a BaseRow,
    table: TableRow,
    first_view: Option<(String, Option<String>)>,
}

/// Up to `limit` results for `needle` (from [`needle`]), best first.
pub fn search(
    conn: &Connection,
    actor: &Actor,
    needle: &str,
    limit: usize,
) -> AppResult<Vec<SearchResult>> {
    let workspaces: Vec<Workspace> = {
        let mut stmt = conn.prepare(
            "SELECT w.id, w.name, w.color FROM workspace_members m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ?1 AND w.deleted_at IS NULL
             ORDER BY w.created_at, w.id",
        )?;
        let rows = stmt.query_map([&actor.user_id], |r| {
            Ok(Workspace {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let base_limited = actor
        .token_scope
        .as_ref()
        .is_some_and(|s| s.base_ids.is_some());

    let mut bases_by_ws: Vec<(&Workspace, Vec<BaseRow>)> = Vec::new();
    for ws in &workspaces {
        let bases: Vec<BaseRow> = bases::live_bases_in(conn, &ws.id)?
            .into_iter()
            .filter(|b| perm::require_base(conn, actor, &b.id, Role::Viewer).is_ok())
            .collect();
        // Like `GET /api/workspaces`: a token limited to some bases does not
        // see the workspaces that hold none of them.
        if base_limited && bases.is_empty() {
            continue;
        }
        bases_by_ws.push((ws, bases));
    }

    let mut ranked: Vec<Ranked> = Vec::new();
    let mut scans: Vec<Scan> = Vec::new();
    for (ws, bases) in &bases_by_ws {
        if let Some(rank) = name_rank(&ws.name, needle) {
            ranked.push(Ranked {
                group: 0,
                rank,
                kind: 0,
                result: located("workspace", &ws.id, &ws.name, ws, None),
            });
        }
        for base in bases {
            if let Some(rank) = name_rank(&base.name, needle) {
                ranked.push(Ranked {
                    group: 0,
                    rank,
                    kind: 1,
                    result: located("base", &base.id, &base.name, ws, Some(base)),
                });
            }
            let mut views = schema::base_visible_views(conn, &base.id, &actor.user_id)?;
            for table in schema::live_tables(conn, &base.id)? {
                let table_views = views.remove(&table.id).unwrap_or_default();
                let first_view = table_views
                    .first()
                    .map(|v| (v.view.id.clone(), view_type_name(v)));
                let in_table = |kind: &str, id: &str, name: &str| {
                    let mut r = located(kind, id, name, ws, Some(base));
                    r.table_id = Some(table.id.clone());
                    r.table_name = Some(table.name.clone());
                    r
                };
                if let Some(rank) = name_rank(&table.name, needle) {
                    let mut r = in_table("table", &table.id, &table.name);
                    if let Some((id, kind)) = &first_view {
                        r.view_id = Some(id.clone());
                        r.view_type = kind.clone();
                    }
                    ranked.push(Ranked {
                        group: 0,
                        rank,
                        kind: 2,
                        result: r,
                    });
                }
                for v in &table_views {
                    if let Some(rank) = name_rank(&v.view.name, needle) {
                        let mut r = in_table("view", &v.view.id, &v.view.name);
                        r.view_id = Some(v.view.id.clone());
                        r.view_type = view_type_name(v);
                        ranked.push(Ranked {
                            group: 0,
                            rank,
                            kind: 3,
                            result: r,
                        });
                    }
                }
                scans.push(Scan {
                    ws,
                    base,
                    table,
                    first_view,
                });
            }
        }
    }

    // Names rank above every record, so once there are `limit` of them no
    // record could make the cut and the scans are skipped.
    let tz = user_timezone(conn, &actor.user_id);
    let wanted = limit.saturating_sub(ranked.len());
    if wanted > 0 {
        let mut rows_left = MAX_RECORDS_SCANNED;
        let mut starting = 0;
        for scan in scans.iter().take(MAX_TABLES_SCANNED) {
            // Records found later rank no higher than those found earlier, so
            // with `wanted` records that start with the text the rest can only
            // lose.
            if rows_left == 0 || starting >= wanted {
                break;
            }
            for hit in query::search_table(conn, &scan.table, needle, wanted, tz, &mut rows_left)? {
                if hit.starts_with {
                    starting += 1;
                }
                ranked.push(record_result(scan, hit, needle));
            }
        }
    }

    // Comments rank below records: they fill what room is left, newest first in
    // each table. Anyone who can open a table's records can read their comments.
    let wanted = limit.saturating_sub(ranked.len());
    if wanted > 0 {
        let names = NameCache::new(conn, tz);
        let mut found = 0;
        for scan in scans.iter().take(MAX_TABLES_SCANNED) {
            if found >= wanted {
                break;
            }
            for hit in comment_hits(conn, &scan.table.id, needle, wanted - found)? {
                found += 1;
                ranked.push(comment_result(scan, hit, needle, &names));
            }
        }
    }

    // Stable: ties keep the order things were found in (sidebar order).
    ranked.sort_by_key(|r| (r.group, r.rank, r.kind));
    Ok(ranked.into_iter().take(limit).map(|r| r.result).collect())
}

struct CommentHit {
    id: String,
    record_id: String,
    body: String,
    author: Option<String>,
}

/// Comments read per table when the search text is not plain ASCII (see [`comment_hits`]).
const MAX_COMMENTS_SCANNED: i64 = 5_000;

/// The newest comments on live records of a table whose text holds `needle`
/// (already lower-cased). SQLite's `lower` folds ASCII only: for an ASCII
/// needle it narrows the rows in SQL, for any other the newest
/// [`MAX_COMMENTS_SCANNED`] are read; either way the match is checked with
/// full Unicode lower-casing.
fn comment_hits(
    conn: &Connection,
    table_id: &str,
    needle: &str,
    limit: usize,
) -> AppResult<Vec<CommentHit>> {
    let ascii = needle.is_ascii();
    let sql = format!(
        "SELECT c.id, c.record_id, c.body, u.name FROM comments c
         JOIN records r ON r.id = c.record_id
         LEFT JOIN users u ON u.id = c.user_id
         WHERE r.table_id = ?1 AND r.deleted_at IS NULL AND c.deleted_at IS NULL
           {}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ?3",
        if ascii {
            "AND instr(lower(c.body), ?2) > 0"
        } else {
            "AND ?2 IS NOT NULL"
        }
    );
    let cap = if ascii {
        limit as i64
    } else {
        MAX_COMMENTS_SCANNED
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![table_id, needle, cap], |r| {
        Ok(CommentHit {
            id: r.get(0)?,
            record_id: r.get(1)?,
            body: r.get(2)?,
            author: r.get(3)?,
        })
    })?;
    let mut hits = Vec::new();
    for hit in rows {
        let hit = hit?;
        if hit.body.to_lowercase().contains(needle) {
            hits.push(hit);
            if hits.len() >= limit {
                break;
            }
        }
    }
    Ok(hits)
}

fn comment_result(scan: &Scan, hit: CommentHit, needle: &str, names: &NameCache) -> Ranked {
    let name = names.record_text(&hit.record_id).unwrap_or_default();
    let mut r = located("comment", &hit.id, &name, scan.ws, Some(scan.base));
    r.table_id = Some(scan.table.id.clone());
    r.table_name = Some(scan.table.name.clone());
    if let Some((id, kind)) = &scan.first_view {
        r.view_id = Some(id.clone());
        r.view_type = kind.clone();
    }
    r.record_id = Some(hit.record_id);
    r.snippet = Some(snippet(&hit.body, needle));
    r.author_name = hit.author;
    Ranked {
        group: 2,
        rank: 0,
        kind: 5,
        result: r,
    }
}

fn record_result(scan: &Scan, hit: RecordHit, needle: &str) -> Ranked {
    let mut r = located("record", &hit.id, &hit.name, scan.ws, Some(scan.base));
    r.table_id = Some(scan.table.id.clone());
    r.table_name = Some(scan.table.name.clone());
    if let Some((id, kind)) = &scan.first_view {
        r.view_id = Some(id.clone());
        r.view_type = kind.clone();
    }
    r.record_id = Some(hit.id);
    let rank = if hit.starts_with {
        0
    } else if hit.matched_text.is_none() {
        1
    } else {
        2
    };
    r.snippet = hit.matched_text.map(|t| snippet(&t, needle));
    Ranked {
        group: 1,
        rank,
        kind: 4,
        result: r,
    }
}

/// About [`SNIPPET_CHARS`] characters of `text` around the first match of
/// `needle`, on one line, with an ellipsis where it was cut.
fn snippet(text: &str, needle: &str) -> String {
    let chars: Vec<char> = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    // Lower-case char by char, remembering where each byte came from, so the
    // match position maps back to the original even where lower-casing
    // changes a character's length.
    let mut lower = String::new();
    let mut origin: Vec<usize> = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        for l in c.to_lowercase() {
            let before = lower.len();
            lower.push(fold_sigma(l));
            origin.resize(origin.len() + lower.len() - before, i);
        }
    }
    // The needle was lower-cased as a whole string, which writes a word-final
    // Σ as ς where char-by-char gives σ; without folding both, "ΟΔΟΣ" would
    // not be found here and the snippet would show the wrong part.
    let needle: String = needle.chars().map(fold_sigma).collect();
    let at = lower.find(&needle).map_or(0, |b| origin[b]);
    let end = (at.saturating_sub(SNIPPET_BEFORE) + SNIPPET_CHARS).min(chars.len());
    let start = end.saturating_sub(SNIPPET_CHARS);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// The final sigma as the ordinary one: the only context-dependent mapping in
/// `str::to_lowercase`.
fn fold_sigma(c: char) -> char {
    if c == 'ς' { 'σ' } else { c }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needle_is_trimmed_lower_cased_and_bounded() {
        assert_eq!(needle("  Dishes ").unwrap(), "dishes");
        assert!(needle("   ").is_err());
        assert!(needle(&"x".repeat(MAX_QUERY_CHARS)).is_ok());
        assert!(needle(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        // Characters, not bytes.
        assert!(needle(&"é".repeat(MAX_QUERY_CHARS)).is_ok());
    }

    #[test]
    fn snippets_show_the_match_in_context() {
        assert_eq!(snippet("Buy milk\nand eggs", "eggs"), "Buy milk and eggs");
        let long = format!("{}needle{}", "a".repeat(200), "b".repeat(200));
        let s = snippet(&long, "needle");
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.contains("needle"));
        assert_eq!(s.chars().count(), SNIPPET_CHARS + 2);
        // A match near the end still fills the snippet from before it.
        let tail = format!("{}end", "a".repeat(300));
        let s = snippet(&tail, "end");
        assert!(s.ends_with("end") && s.starts_with('…'));
        assert_eq!(s.chars().count(), SNIPPET_CHARS + 1);
        // Lower-casing that changes length does not shift the window.
        let s = snippet(&format!("{}İstanbul trip", "x".repeat(100)), "trip");
        assert!(s.contains("trip"), "{s}");
    }

    #[test]
    fn snippets_find_a_word_final_sigma() {
        // The needle is lower-cased as a whole string, which turns a final
        // Σ into ς; the text must be folded the same way to find it.
        let text = format!("{} ΟΔΟΣ end", "x".repeat(130));
        let s = snippet(&text, &needle("ΟΔΟΣ").unwrap());
        assert!(s.contains("ΟΔΟΣ"), "{s}");
    }
}
