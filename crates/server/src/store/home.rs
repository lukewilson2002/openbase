//! A workspace's Home (`GET /api/workspaces/{id}/home`): the records that are due soon, the
//! records that changed lately and the caller's inbox drafts, from one read.
//!
//! Access is decided as for opening things: only projects the caller can open
//! (`perm::require_base`, which also applies an API token's project limit and read-only cap) are
//! read, so a member limited to some folders sees only those.
//!
//! **Due soon.** Only collections with a Home date (`tables.home_date_field_id`) are read, and
//! only while that property is still a live date-like one. A record is due when its date falls
//! from [`ob_core::query::HOME_DAYS_BEFORE`] days ago to [`ob_core::query::HOME_DAYS_AFTER`] days
//! ahead, counted in the caller's time zone (a date property with a fixed zone keeps its own),
//! and the collection's Done checkbox, when it has one, is not ticked. Record cells have no
//! index, so the scan is narrowed in SQL to the stored dates near the window (a string compare
//! on the ISO text, or on the creation or edit time for those system properties) and only the
//! survivors are read the way the grid reads them. That keeps a workspace of 100,000 records
//! well inside the 300 ms HOME-11 asks for. The budget works as search's does, but a collection is
//! either read whole or not at all (and `truncated` says so), so what the list shows never
//! depends on where in a collection the budget happened to end.
//!
//! **Recent.** The latest history entries of the openable collections, newest first, folded to
//! one row per live record. The history table is indexed by time, not by collection, so the
//! walk is capped; a workspace whose changes are all older than that many entries of other
//! workspaces shows fewer than ten.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Days, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use ob_core::api::history::ActivityAuthor;
use ob_core::api::home::{HomeDue, HomeRecent, HomeResponse};
use ob_core::field::{Field, FieldKind};
use ob_core::query::{CellWhen, cell_when, home_window};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde_json::Value as Json;

use crate::auth::Actor;
use crate::engine::query::is_date_like;
use crate::engine::write::user_timezone;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::store::links::NameCache;
use crate::store::records::{self, RecordRow};
use crate::store::{bases, history, inbox, schema, search};

/// Due items returned, the oldest first.
pub const MAX_DUE: usize = 50;
/// Recently changed records returned.
pub const MAX_RECENT: usize = 10;
/// History entries read to find them, so a quiet workspace on a busy server cannot make the
/// walk long.
const MAX_HISTORY_READ: usize = 5_000;

/// What one Home request may read: records across collections, and collections. Search's budget
/// by default ([`search::MAX_RECORDS_SCANNED`], [`search::MAX_TABLES_SCANNED`]).
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub records: usize,
    pub tables: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            records: search::MAX_RECORDS_SCANNED,
            tables: search::MAX_TABLES_SCANNED,
        }
    }
}

/// A collection of an openable project, with what a row of it needs.
struct Place {
    table: schema::TableRow,
    base_name: String,
    can_edit: bool,
}

/// Where a due date is stored, which decides how the scan is narrowed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    /// An ISO string in the record's data (a date, or a formula or rollup that gives one).
    Stored,
    /// The record's creation time.
    Created,
    /// The record's last edit time.
    Modified,
    /// A last-modified time that watches some properties: it comes from the history, so every
    /// record is read the long way.
    Watched,
}

/// A collection whose records Home reads.
struct Dated<'a> {
    place: &'a Place,
    date: Field,
    source: Source,
    done_field_id: Option<String>,
}

/// A record found inside the window.
struct Hit {
    id: String,
    when: CellWhen,
    /// Collection order, then manual order: the tie-breakers of the sort.
    table_rank: usize,
    position: f64,
}

pub fn home(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
    now: DateTime<Utc>,
    budget: Budget,
) -> AppResult<HomeResponse> {
    perm::workspace_role(conn, &actor.user_id, workspace_id)?
        .ok_or_else(|| AppError::not_found("workspace"))?;
    let base_limited = actor
        .token_scope
        .as_ref()
        .is_some_and(|s| s.base_ids.is_some());

    let mut places: Vec<Place> = Vec::new();
    let mut openable = 0;
    for base in bases::live_bases_in(conn, workspace_id)? {
        let Ok(role) = perm::require_base(conn, actor, &base.id, Role::Viewer) else {
            continue;
        };
        openable += 1;
        for table in schema::live_tables(conn, &base.id)? {
            places.push(Place {
                table,
                base_name: base.name.clone(),
                can_edit: role >= Role::Editor,
            });
        }
    }
    // Like the workspace listing: a token limited to some projects does not see the workspaces
    // that hold none of them.
    if base_limited && openable == 0 {
        return Err(AppError::not_found("workspace"));
    }

    let tz = user_timezone(conn, &actor.user_id);
    let today = now.with_timezone(&tz).date_naive();
    let names = NameCache::new(conn, tz);

    let (due, truncated) = due_soon(conn, &places, today, tz, budget, &names)?;
    let recent = recent(conn, &places, &names)?;
    let drafts = if base_limited {
        Vec::new()
    } else {
        inbox::list(conn, &actor.user_id)?
    };
    Ok(HomeResponse {
        today: today.to_string(),
        timezone: tz.name().to_string(),
        due,
        truncated,
        recent,
        drafts,
    })
}

// ---------------------------------------------------------------------- due soon

fn due_soon(
    conn: &Connection,
    places: &[Place],
    today: NaiveDate,
    tz: Tz,
    budget: Budget,
    names: &NameCache,
) -> AppResult<(Vec<HomeDue>, bool)> {
    let Some((from, to)) = home_window(today) else {
        return Ok((Vec::new(), false));
    };
    let mut counts: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut rows_left = budget.records;
    let mut tables_left = budget.tables;
    let mut truncated = false;
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned: Vec<Dated> = Vec::new();
    for place in places {
        let Some(dated) = Dated::of(conn, place)? else {
            continue;
        };
        let counts = match counts.get(&place.table.base_id) {
            Some(c) => c,
            None => counts
                .entry(place.table.base_id.clone())
                .or_insert(schema::record_counts_in_base(conn, &place.table.base_id)?),
        };
        let n = usize::try_from(counts.get(&place.table.id).copied().unwrap_or(0)).unwrap_or(0);
        if n == 0 {
            continue;
        }
        if tables_left == 0 || n > rows_left {
            truncated = true;
            continue;
        }
        tables_left -= 1;
        rows_left -= n;
        let rank = scanned.len();
        dated.scan(conn, rank, (from, to), tz, &mut hits)?;
        scanned.push(dated);
    }

    hits.sort_by(|a, b| {
        (a.when.day, a.when.time, a.table_rank)
            .cmp(&(b.when.day, b.when.time, b.table_rank))
            .then(a.position.total_cmp(&b.position))
            .then_with(|| a.id.cmp(&b.id))
    });
    hits.truncate(MAX_DUE);
    names.preload(hits.iter().map(|h| h.id.as_str()));
    let due = hits
        .into_iter()
        .filter_map(|h| {
            let d = &scanned[h.table_rank];
            let title = names.record_text(&h.id)?;
            Some(HomeDue {
                record_id: h.id,
                table_id: d.place.table.id.clone(),
                base_id: d.place.table.base_id.clone(),
                base_name: d.place.base_name.clone(),
                title,
                table_name: d.place.table.name.clone(),
                table_color: d.place.table.color.clone(),
                date: h.when.day.to_string(),
                has_time: h.when.time.is_some(),
                time: h.when.time.map(|t| t.format("%H:%M").to_string()),
                has_done: d.done_field_id.is_some(),
                done_field_id: d.done_field_id.clone(),
                overdue: h.when.day < today,
                can_edit: d.place.can_edit,
            })
        })
        .collect();
    Ok((due, truncated))
}

impl<'a> Dated<'a> {
    /// The collection's Home settings, when they still name a live date-like property. A Done
    /// setting that no longer names a live checkbox counts as none.
    fn of(conn: &Connection, place: &'a Place) -> AppResult<Option<Dated<'a>>> {
        let Some(date_id) = &place.table.home_date_field_id else {
            return Ok(None);
        };
        let fields = schema::table_fields(conn, &place.table.id)?;
        let Some(date) = fields
            .iter()
            .find(|f| &f.id == date_id && is_date_like(f))
            .cloned()
        else {
            return Ok(None);
        };
        let done_field_id = place
            .table
            .done_field_id
            .as_ref()
            .filter(|id| {
                fields
                    .iter()
                    .any(|f| &f.id == *id && matches!(f.kind, FieldKind::Checkbox(_)))
            })
            .cloned();
        let source = match &date.kind {
            FieldKind::CreatedTime(_) => Source::Created,
            FieldKind::LastModifiedTime(o) if o.fields.is_empty() => Source::Modified,
            FieldKind::LastModifiedTime(_) => Source::Watched,
            _ => Source::Stored,
        };
        Ok(Some(Dated {
            place,
            date,
            source,
            done_field_id,
        }))
    }

    /// Add the records of the collection whose date is in `[from, to]` and that are not done.
    fn scan(
        &self,
        conn: &Connection,
        rank: usize,
        (from, to): (NaiveDate, NaiveDate),
        tz: Tz,
        out: &mut Vec<Hit>,
    ) -> AppResult<()> {
        let table_id = &self.place.table.id;
        let done_path = self.done_field_id.as_deref().map(json_path);
        let mut push = |id: String, position: f64, stored: &Json| {
            if let Some(when) = cell_when(&self.date, Some(stored), tz)
                && when.day >= from
                && when.day <= to
            {
                out.push(Hit {
                    id,
                    when,
                    table_rank: rank,
                    position,
                });
            }
        };
        if self.source == Source::Watched {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {} FROM records WHERE table_id = ?1 AND deleted_at IS NULL",
                records::COLS
            ))?;
            let mut rows = stmt.query([table_id])?;
            while let Some(r) = rows.next()? {
                let row = RecordRow::from_sql(r)?;
                let done = self
                    .done_field_id
                    .as_ref()
                    .is_some_and(|id| row.data.get(id) == Some(&Json::Bool(true)));
                if done {
                    continue;
                }
                if let Some(stored) = records::system_cell(conn, &self.date, &row) {
                    push(row.id, row.position, &stored);
                }
            }
            return Ok(());
        }

        // The window with two days to spare on each side, so no zone, fixed or the caller's,
        // can pull a record in the window out of the narrowed set; `cell_when` then decides.
        let first = from.checked_sub_days(Days::new(2)).unwrap_or(from);
        let after = to.checked_add_days(Days::new(3)).unwrap_or(to);
        let (expr, date_arg, lo, hi) = match self.source {
            Source::Stored => (
                "json_extract(data, ?5)",
                Some(Sql::Text(json_path(&self.date.id))),
                Sql::Text(first.to_string()),
                Sql::Text(after.to_string()),
            ),
            _ => (
                if self.source == Source::Created {
                    "created_at"
                } else {
                    "updated_at"
                },
                None,
                Sql::Integer(midnight_ms(first)),
                Sql::Integer(midnight_ms(after)),
            ),
        };
        // `done` is 1 for a ticked checkbox (JSON true), NULL when there is none.
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT id, d, done, position FROM (
                 SELECT id, {expr} AS d, json_extract(data, ?2) AS done, position FROM records
                 WHERE table_id = ?1 AND deleted_at IS NULL)
             WHERE d >= ?3 AND d < ?4"
        ))?;
        let mut args = vec![
            Sql::Text(table_id.clone()),
            done_path.map_or(Sql::Null, Sql::Text),
            lo,
            hi,
        ];
        args.extend(date_arg);
        let mut rows = stmt.query(params_from_iter(args))?;
        while let Some(r) = rows.next()? {
            if r.get::<_, Sql>(2)? == Sql::Integer(1) {
                continue;
            }
            let stored = match r.get::<_, Sql>(1)? {
                Sql::Text(s) => Json::String(s),
                Sql::Integer(ms) => match records::instant_json(ms) {
                    Some(j) => j,
                    None => continue,
                },
                _ => continue,
            };
            push(r.get(0)?, r.get(3)?, &stored);
        }
        Ok(())
    }
}

/// `$."id"`: the SQLite JSON path of a key of a record's data.
fn json_path(field_id: &str) -> String {
    format!("$.\"{}\"", field_id.replace('"', ""))
}

fn midnight_ms(day: NaiveDate) -> i64 {
    Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).unwrap_or_default())
        .timestamp_millis()
}

// ---------------------------------------------------------------------- recent

fn recent(conn: &Connection, places: &[Place], names: &NameCache) -> AppResult<Vec<HomeRecent>> {
    if places.is_empty() {
        return Ok(Vec::new());
    }
    let by_table: HashMap<&str, &Place> = places.iter().map(|p| (p.table.id.as_str(), p)).collect();
    let table_ids = serde_json::to_string(&by_table.keys().collect::<Vec<_>>())?;
    // The activity feed's own read: the time index, newest first, the collections as a set.
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT e.record_id, e.table_id, e.user_id, u.name, e.kind, e.created_at
         FROM record_history e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.table_id IN (SELECT value FROM json_each(?1))
           AND e.kind IN ('{}', '{}', '{}')
         ORDER BY e.created_at DESC, e.id DESC",
        history::CREATE,
        history::UPDATE,
        history::RESTORE
    ))?;
    let mut rows = stmt.query([&table_ids])?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<HomeRecent> = Vec::new();
    let mut read = 0;
    while let Some(r) = rows.next()? {
        read += 1;
        let record_id: String = r.get(0)?;
        if seen.insert(record_id.clone())
            && let Some(place) = by_table.get(r.get::<_, String>(1)?.as_str())
            && let Some(title) = names.record_text(&record_id)
        {
            let author = match (
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ) {
                (Some(id), Some(name)) => Some(ActivityAuthor { id, name }),
                _ => None,
            };
            out.push(HomeRecent {
                record_id,
                table_id: place.table.id.clone(),
                base_id: place.table.base_id.clone(),
                base_name: place.base_name.clone(),
                title,
                table_name: place.table.name.clone(),
                table_color: place.table.color.clone(),
                kind: r.get(4)?,
                author,
                at: r.get(5)?,
            });
        }
        if out.len() >= MAX_RECENT || read >= MAX_HISTORY_READ {
            break;
        }
    }
    Ok(out)
}
