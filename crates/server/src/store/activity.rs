//! The activity feed (`GET /api/history`): the history entries and comments of every record the
//! caller can open, newest first or oldest first, across all their workspaces.
//!
//! Access is decided as for opening things (`perm::MEMBER_CAN_OPEN_BASE`, the rule behind
//! `perm::require_base`, plus an API token's base limit): tables of live bases of live
//! workspaces the caller is a member of. History entries and comments are two sources read by
//! one query each over those table ids (newest first: the `created_at` indexes in reverse), each
//! asked for one page, and merged. A page's position is an opaque cursor, the sort key
//! `(created_at, source, id)` of the last item: it is unique, so pages never repeat or skip an
//! item, even when many share a millisecond.

use std::collections::{BTreeMap, HashMap};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ob_core::api::history::{
    ActivityAuthor, ActivityItem, ActivityPage, ActivityPlace, ActivityRecord,
};
use ob_core::api::records::FieldChange;
use ob_core::field::Field;
use rusqlite::Connection;
use rusqlite::types::Value as Sql;

use crate::auth::Actor;
use crate::engine::write::user_timezone;
use crate::error::{AppError, AppResult};
use crate::perm::MEMBER_CAN_OPEN_BASE;
use crate::store::links::NameCache;
use crate::store::{history, schema};

/// Items returned when the request names no limit, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 200;

/// What `kind` filters on: the kinds of `record_history`, and `comment`.
pub const KINDS: &[&str] = &[
    history::CREATE,
    history::UPDATE,
    history::DELETE,
    history::RESTORE,
    COMMENT,
];
pub const COMMENT: &str = "comment";

/// Source numbers in the sort key: history entries before comments.
const HISTORY: u8 = 0;
const COMMENTS: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Newest,
    Oldest,
}

impl Order {
    pub fn parse(s: &str) -> AppResult<Order> {
        match s {
            "newest" => Ok(Order::Newest),
            "oldest" => Ok(Order::Oldest),
            other => Err(AppError::bad_request(format!(
                "unknown order '{other}' (newest or oldest)"
            ))),
        }
    }
}

/// `kind`, checked.
pub fn parse_kind(s: &str) -> AppResult<String> {
    if KINDS.contains(&s) {
        Ok(s.to_string())
    } else {
        Err(AppError::bad_request(format!(
            "unknown kind '{s}' ({})",
            KINDS.join(", ")
        )))
    }
}

/// The sort key of an item, and what a page cursor holds. `num` is the id of a history entry,
/// `txt` that of a comment (the other stays empty), so keys of one source compare by id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cursor {
    created_at: i64,
    source: u8,
    num: i64,
    txt: String,
}

impl Cursor {
    pub fn encode(&self) -> String {
        let id = if self.source == HISTORY {
            self.num.to_string()
        } else {
            self.txt.clone()
        };
        URL_SAFE_NO_PAD.encode(format!("{}:{}:{id}", self.created_at, self.source))
    }

    pub fn decode(raw: &str) -> AppResult<Cursor> {
        let bad = || AppError::bad_request("before is not a cursor from this feed");
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| bad())?;
        let text = String::from_utf8(bytes).map_err(|_| bad())?;
        let mut parts = text.splitn(3, ':');
        let (Some(at), Some(source), Some(id)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(bad());
        };
        let created_at: i64 = at.parse().map_err(|_| bad())?;
        match source {
            "0" => Ok(Cursor {
                created_at,
                source: HISTORY,
                num: id.parse().map_err(|_| bad())?,
                txt: String::new(),
            }),
            "1" if !id.is_empty() => Ok(Cursor {
                created_at,
                source: COMMENTS,
                num: 0,
                txt: id.to_string(),
            }),
            _ => Err(bad()),
        }
    }
}

/// What to list.
#[derive(Debug, Clone)]
pub struct Filter {
    pub workspace_id: Option<String>,
    pub base_id: Option<String>,
    pub table_id: Option<String>,
    /// The author.
    pub user_id: Option<String>,
    /// One of [`KINDS`].
    pub kind: Option<String>,
    pub order: Order,
    pub before: Option<Cursor>,
    pub limit: usize,
}

/// Every table the caller can open, in sidebar order, optionally narrowed to a workspace, base
/// or table: skips trashed tables, bases and workspaces, and bases an API token does not reach.
pub fn accessible_places(
    conn: &Connection,
    actor: &Actor,
    workspace_id: Option<&str>,
    base_id: Option<&str>,
    table_id: Option<&str>,
) -> AppResult<Vec<ActivityPlace>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT w.id, w.name, w.color, b.id, b.name, b.icon, b.color, t.id, t.name
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id AND w.deleted_at IS NULL
         JOIN bases b ON b.workspace_id = w.id AND b.deleted_at IS NULL
         JOIN tables t ON t.base_id = b.id AND t.deleted_at IS NULL
         WHERE m.user_id = ?1 AND {MEMBER_CAN_OPEN_BASE}
           AND (?2 IS NULL OR w.id = ?2) AND (?3 IS NULL OR b.id = ?3) AND (?4 IS NULL OR t.id = ?4)
         ORDER BY w.created_at, w.id, b.position, b.created_at, b.id, t.position, t.created_at, t.id"
    ))?;
    let limit = actor
        .token_scope
        .as_ref()
        .and_then(|s| s.base_ids.as_deref());
    let rows = stmt.query_map(
        rusqlite::params![actor.user_id, workspace_id, base_id, table_id],
        |r| {
            Ok(ActivityPlace {
                workspace_id: r.get(0)?,
                workspace_name: r.get(1)?,
                workspace_color: r.get(2)?,
                base_id: r.get(3)?,
                base_name: r.get(4)?,
                base_icon: r.get(5)?,
                base_color: r.get(6)?,
                table_id: r.get(7)?,
                table_name: r.get(8)?,
            })
        },
    )?;
    let mut places = Vec::new();
    for place in rows {
        let place = place?;
        if limit.is_none_or(|ids| ids.contains(&place.base_id)) {
            places.push(place);
        }
    }
    Ok(places)
}

/// One row of either source.
struct Raw {
    key: Cursor,
    record_id: String,
    table_id: String,
    user_id: Option<String>,
    user_name: Option<String>,
    kind: String,
    changes: BTreeMap<String, FieldChange>,
    comment: Option<String>,
}

/// The page of the feed `filter` asks for.
pub fn feed(conn: &Connection, actor: &Actor, filter: &Filter) -> AppResult<ActivityPage> {
    let places = accessible_places(
        conn,
        actor,
        filter.workspace_id.as_deref(),
        filter.base_id.as_deref(),
        filter.table_id.as_deref(),
    )?;
    let empty = ActivityPage {
        items: Vec::new(),
        next: None,
        fields: BTreeMap::new(),
    };
    if places.is_empty() {
        return Ok(empty);
    }
    let table_ids = serde_json::to_string(&places.iter().map(|p| &p.table_id).collect::<Vec<_>>())?;

    // One more than a page, to know whether there is a next one.
    let want = filter.limit + 1;
    let kind = filter.kind.as_deref();
    let mut raws: Vec<Raw> = Vec::new();
    if kind != Some(COMMENT) {
        raws.extend(fetch(conn, HISTORY, &table_ids, filter, want)?);
    }
    if kind.is_none() || kind == Some(COMMENT) {
        raws.extend(fetch(conn, COMMENTS, &table_ids, filter, want)?);
    }
    raws.sort_by(|a, b| a.key.cmp(&b.key));
    if filter.order == Order::Newest {
        raws.reverse();
    }
    let more = raws.len() > filter.limit;
    raws.truncate(filter.limit);
    let next = more.then(|| raws.last().map(|r| r.key.encode())).flatten();

    let places: HashMap<&str, &ActivityPlace> =
        places.iter().map(|p| (p.table_id.as_str(), p)).collect();
    let names = NameCache::new(conn, user_timezone(conn, &actor.user_id));
    names.preload_info(raws.iter().map(|r| r.record_id.as_str()));

    // The fields (and link fields) of the tables the changes are in, read once per table.
    let mut table_fields: HashMap<String, Vec<Field>> = HashMap::new();
    let mut fields: BTreeMap<String, Field> = BTreeMap::new();
    let mut items = Vec::with_capacity(raws.len());
    for mut raw in raws {
        let Some(place) = places.get(raw.table_id.as_str()) else {
            continue;
        };
        if !raw.changes.is_empty() {
            if !table_fields.contains_key(&raw.table_id) {
                table_fields.insert(
                    raw.table_id.clone(),
                    schema::table_fields(conn, &raw.table_id)?,
                );
            }
            let known = &table_fields[&raw.table_id];
            let links = known
                .iter()
                .filter(|f| matches!(f.kind, ob_core::field::FieldKind::Link(_)))
                .map(|f| f.id.clone())
                .collect();
            history::link_refs(&mut raw.changes, &links, &names);
            for f in known.iter().filter(|f| raw.changes.contains_key(&f.id)) {
                fields.entry(f.id.clone()).or_insert_with(|| f.clone());
            }
        }
        let (name, deleted) = names
            .record_info(&raw.record_id)
            .unwrap_or_else(|| (String::new(), true));
        items.push(ActivityItem {
            id: if raw.key.source == HISTORY {
                raw.key.num.to_string()
            } else {
                raw.key.txt.clone()
            },
            kind: raw.kind,
            created_at: raw.key.created_at,
            author: match (raw.user_id, raw.user_name) {
                (Some(id), Some(name)) => Some(ActivityAuthor { id, name }),
                _ => None,
            },
            record: ActivityRecord {
                id: raw.record_id,
                name,
                deleted,
            },
            place: (*place).clone(),
            changes: raw.changes,
            comment: raw.comment,
        });
    }
    Ok(ActivityPage {
        items,
        next,
        fields,
    })
}

/// The first `want` rows of one source in the filter's order, after its cursor.
fn fetch(
    conn: &Connection,
    source: u8,
    table_ids: &str,
    filter: &Filter,
    want: usize,
) -> AppResult<Vec<Raw>> {
    let newest = filter.order == Order::Newest;
    let (columns, from, live) = if source == HISTORY {
        (
            "e.id, e.created_at, e.record_id, e.table_id, e.user_id, u.name, e.kind, e.changes",
            "record_history e LEFT JOIN users u ON u.id = e.user_id",
            "",
        )
    } else {
        (
            "e.id, e.created_at, e.record_id, r.table_id, e.user_id, u.name, 'comment', e.body",
            "comments e JOIN records r ON r.id = e.record_id LEFT JOIN users u ON u.id = e.user_id",
            "AND e.deleted_at IS NULL",
        )
    };
    let table_col = if source == HISTORY {
        "e.table_id"
    } else {
        "r.table_id"
    };
    let mut sql = format!(
        "SELECT {columns} FROM {from}
         WHERE {table_col} IN (SELECT value FROM json_each(?)) {live}"
    );
    let mut args: Vec<Sql> = vec![Sql::Text(table_ids.to_string())];
    if let Some(user) = &filter.user_id {
        sql.push_str(" AND e.user_id = ?");
        args.push(Sql::Text(user.clone()));
    }
    if source == HISTORY
        && let Some(kind) = &filter.kind
    {
        sql.push_str(" AND e.kind = ?");
        args.push(Sql::Text(kind.clone()));
    }
    if let Some(c) = &filter.before {
        // Rows that sort after the cursor in this order. A source that sorts after the
        // cursor's own, going this way, must also take rows that share its time.
        let op = if newest { "<" } else { ">" };
        let ties = if newest {
            source < c.source
        } else {
            source > c.source
        };
        if source == c.source {
            sql.push_str(&format!(" AND (e.created_at, e.id) {op} (?, ?)"));
            args.push(Sql::Integer(c.created_at));
            args.push(if source == HISTORY {
                Sql::Integer(c.num)
            } else {
                Sql::Text(c.txt.clone())
            });
        } else {
            sql.push_str(&format!(
                " AND e.created_at {op}{} ?",
                if ties { "=" } else { "" }
            ));
            args.push(Sql::Integer(c.created_at));
        }
    }
    let dir = if newest { "DESC" } else { "ASC" };
    sql.push_str(&format!(
        " ORDER BY e.created_at {dir}, e.id {dir} LIMIT {want}"
    ));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        let (num, txt) = if source == HISTORY {
            (r.get::<_, i64>(0)?, String::new())
        } else {
            (0, r.get::<_, String>(0)?)
        };
        let last: String = r.get(7)?;
        let (changes, comment) = if source == HISTORY {
            (serde_json::from_str(&last).unwrap_or_default(), None)
        } else {
            (BTreeMap::new(), Some(last))
        };
        Ok(Raw {
            key: Cursor {
                created_at: r.get(1)?,
                source,
                num,
                txt,
            },
            record_id: r.get(2)?,
            table_id: r.get(3)?,
            user_id: r.get(4)?,
            user_name: r.get(5)?,
            kind: r.get(6)?,
            changes,
            comment,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        let h = Cursor {
            created_at: 1_700_000_000_123,
            source: HISTORY,
            num: 42,
            txt: String::new(),
        };
        assert_eq!(Cursor::decode(&h.encode()).unwrap(), h);
        let c = Cursor {
            created_at: 5,
            source: COMMENTS,
            num: 0,
            txt: "cmtAb3".into(),
        };
        assert_eq!(Cursor::decode(&c.encode()).unwrap(), c);
        for bad in [
            "",
            "!!",
            &URL_SAFE_NO_PAD.encode("1:0:x"),
            &URL_SAFE_NO_PAD.encode("1:2:3"),
        ] {
            assert!(Cursor::decode(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_sort_by_time_then_source_then_id() {
        let key = |created_at, source, num, txt: &str| Cursor {
            created_at,
            source,
            num,
            txt: txt.to_string(),
        };
        assert!(key(1, COMMENTS, 0, "a") < key(2, HISTORY, 1, ""));
        assert!(key(1, HISTORY, 9, "") < key(1, COMMENTS, 0, "a"));
        assert!(key(1, HISTORY, 2, "") < key(1, HISTORY, 3, ""));
    }
}
