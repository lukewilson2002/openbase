//! The record write path.
//!
//! Everything that creates, edits, deletes, restores or reorders records goes
//! through this module: the HTTP API today, forms, CSV import, the Airtable
//! compatible API (W7) and automation actions (W8) tomorrow. Callers run
//! these functions inside their own write transaction (`Db::write`), check
//! permissions first (`perm::require_base`), and publish the returned
//! [`WriteOutcome`] as events *after* the transaction commits
//! ([`WriteOutcome::events`]). A failed call leaves nothing behind because
//! the caller's transaction rolls back.
//!
//! ```ignore
//! let ctx = WriteCtx::new(Some(&user_id), WriteSource::Import).typecast(true);
//! let outcome = write::create_records(tx, &ctx, &table_id, records, &CreateOpts::default())?;
//! // ... commit ...
//! for event in outcome.events() { state.events.publish(&outcome.base_id, client, user, event); }
//! ```
//!
//! # Rules every write follows
//!
//! 1. Unknown or computed fields are rejected with a 400 naming the field.
//! 2. With `typecast`, select names that do not exist yet become choices
//!    (the table is reported in [`WriteOutcome::schema_changed`]).
//! 3. Values go through `ob_core::cell::normalize`; link ids must be live
//!    records of the linked table, user ids must be collaborators of the base
//!    (ids already in the cell are always accepted), attachment ids must be
//!    uploads of this base (the stored reference is rebuilt from the
//!    `attachments` row, never taken from the client).
//! 4. Link cells are paired: adding/removing a record id on one side adds/
//!    removes this record's id on the inverse field of the linked record, in
//!    the same transaction (self-links included; new ids are appended).
//!    Trashed linked records keep their ids in the arrays so that restoring is
//!    trivial; an update of a multi-link cell keeps ids of trashed records the
//!    client cannot see.
//! 5. An update that changes nothing writes nothing: no history row, no
//!    `updated_at` bump, no event entry. `updated_at`/`updated_by` change only
//!    for records whose editable cells really changed (including the inverse
//!    side of a link).
//! 6. Computed fields are recomputed in the same transaction
//!    ([`super::recompute`]), across tables, with a hard cap on recomputed
//!    cells ([`WriteCtx::max_recomputes`], default
//!    [`DEFAULT_MAX_EVALS`](super::recompute::DEFAULT_MAX_EVALS)).
//! 7. `record_history` gets one row per create/update/delete/restore with the
//!    old/new JSON of the changed *editable* fields.
//! 8. Users newly added to a user field with `notify` get an "assigned"
//!    notification (not for assigning yourself), and people newly mentioned
//!    (`@[Name](usrXXXX)`) in a rich text cell get a "mention" notification
//!    ([`crate::store::mentions`]; not the author, and not for writes
//!    without an actor, such as anonymous form submissions).
//! 9. [`crate::automations::on_records_changed`] is called per table with the
//!    created records and the directly edited records (with the editable
//!    fields that changed). Records that only had computed values recomputed
//!    appear in [`TableOutcome::updated`] but not in `edited`.
//!    The call carries `by_automation` (the write's source is
//!    [`WriteSource::Automation`]; record triggers ignore such writes), the
//!    form view id of [`WriteSource::Form`] and, for every edited record, its
//!    `records.data` as it was before this write touched it, so
//!    `record_matches` triggers see exact "started matching" transitions
//!    (computed fields included).
//!
//! Deletes are soft (`deleted_at`); the trash purge job removes them for real
//! (and strips their ids from link arrays).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Deref;
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use ob_core::api::events::BaseEvent;
use ob_core::api::records::{MoveRecords, NewRecord, RecordPatch};
use ob_core::cell::{CellCtx, missing_choices, normalize};
use ob_core::field::{Field, FieldKind, SelectChoice, default_choice_color};
use ob_core::ids;
use ob_core::limits;
use rusqlite::{Connection, Transaction};
use serde_json::{Map, Value as Json, json};

use crate::automations::{self, RecordChanges};
use crate::engine::recompute::{DEFAULT_MAX_EVALS, Session, same_json};
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::links::{self, dedupe, ids_json, ids_of, link_ids};
use crate::store::records::{self, Place, RecordRow};
use crate::store::schema::{self, TableRow};
use crate::store::{attachments, history, mentions, notifications};

// ------------------------------------------------------------------ context

/// Where a write came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteSource {
    /// The signed-in web client or a personal access token.
    Api,
    /// A public form submission (the form view id); the actor is usually None.
    Form {
        view_id: String,
    },
    Automation,
    Import,
}

/// Who writes, when, and how values are interpreted.
#[derive(Debug, Clone)]
pub struct WriteCtx {
    /// The acting user; `None` for anonymous form submissions.
    pub actor: Option<String>,
    /// Timestamp for `created_at`/`updated_at`, the `NOW()` of formulas
    /// evaluated by this write and the history rows.
    pub now: DateTime<Utc>,
    /// Zone used to interpret wall-clock date input.
    pub timezone: Tz,
    /// Lenient Airtable-style coercion; creates missing select choices.
    pub typecast: bool,
    pub source: WriteSource,
    /// Recomputed cells allowed before the write fails with a 409.
    pub max_recomputes: usize,
}

impl WriteCtx {
    pub fn new(actor: Option<&str>, source: WriteSource) -> WriteCtx {
        WriteCtx {
            actor: actor.map(str::to_string),
            now: Utc::now(),
            timezone: Tz::UTC,
            typecast: false,
            source,
            max_recomputes: DEFAULT_MAX_EVALS,
        }
    }

    /// A context for `user_id` using the zone from their profile.
    pub fn for_user(conn: &Connection, user_id: &str, source: WriteSource) -> AppResult<WriteCtx> {
        let mut ctx = WriteCtx::new(Some(user_id), source);
        ctx.timezone = user_timezone(conn, user_id);
        Ok(ctx)
    }

    pub fn typecast(mut self, on: bool) -> Self {
        self.typecast = on;
        self
    }
    pub fn at(mut self, now: DateTime<Utc>) -> Self {
        self.now = now;
        self
    }
    pub fn in_timezone(mut self, tz: Tz) -> Self {
        self.timezone = tz;
        self
    }
    pub fn with_max_recomputes(mut self, max: usize) -> Self {
        self.max_recomputes = max;
        self
    }

    fn now_ms(&self) -> i64 {
        self.now.timestamp_millis()
    }

    fn actor_str(&self) -> Option<&str> {
        self.actor.as_deref()
    }
}

/// The timezone from a user's profile (UTC when unset or unreadable).
pub fn user_timezone(conn: &Connection, user_id: &str) -> Tz {
    let tz: Option<String> = conn
        .query_row("SELECT timezone FROM users WHERE id = ?1", [user_id], |r| {
            r.get(0)
        })
        .unwrap_or(None);
    tz.and_then(|z| z.parse().ok()).unwrap_or(Tz::UTC)
}

/// Options of [`create_records`].
#[derive(Debug, Clone, Default)]
pub struct CreateOpts {
    /// Insert after this record in manual order (default: at the end).
    pub after_record_id: Option<String>,
    /// Insert before this record in manual order; not together with
    /// `after_record_id`.
    pub before_record_id: Option<String>,
}

// ------------------------------------------------------------------ outcome

/// An ordered set of record ids.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdList {
    items: Vec<String>,
    seen: HashSet<String>,
}

impl IdList {
    pub fn push(&mut self, id: &str) {
        if self.seen.insert(id.to_string()) {
            self.items.push(id.to_string());
        }
    }
    pub fn remove(&mut self, id: &str) {
        if self.seen.remove(id) {
            self.items.retain(|i| i != id);
        }
    }
}

impl Deref for IdList {
    type Target = Vec<String>;
    fn deref(&self) -> &Vec<String> {
        &self.items
    }
}

/// What happened to the records of one table.
#[derive(Debug, Clone, Default)]
pub struct TableOutcome {
    pub table_id: String,
    /// Created records in input order.
    pub created: IdList,
    /// Records whose stored data changed: edits, inverse-link updates and
    /// records that only had computed values recalculated (moved records
    /// too). Never contains created or deleted records.
    pub updated: IdList,
    pub deleted: IdList,
    pub restored: IdList,
    /// Directly edited records (updates and inverse-link sides) with the
    /// editable field ids whose values changed.
    pub edited: BTreeMap<String, BTreeSet<String>>,
}

/// Everything a write changed, for events, history and automations.
#[derive(Debug, Clone, Default)]
pub struct WriteOutcome {
    pub base_id: String,
    /// The table the call targeted.
    pub table_id: String,
    /// Affected tables, the target first; includes tables whose records only
    /// had computed fields recalculated.
    pub tables: Vec<TableOutcome>,
    /// Tables whose select choices were extended by `typecast`.
    pub schema_changed: Vec<String>,
}

impl WriteOutcome {
    fn new(base_id: &str, table_id: &str) -> WriteOutcome {
        let mut o = WriteOutcome {
            base_id: base_id.to_string(),
            table_id: table_id.to_string(),
            ..Default::default()
        };
        o.table_mut(table_id);
        o
    }

    pub fn table(&self, table_id: &str) -> Option<&TableOutcome> {
        self.tables.iter().find(|t| t.table_id == table_id)
    }

    pub fn table_mut(&mut self, table_id: &str) -> &mut TableOutcome {
        if let Some(i) = self.tables.iter().position(|t| t.table_id == table_id) {
            return &mut self.tables[i];
        }
        self.tables.push(TableOutcome {
            table_id: table_id.to_string(),
            ..Default::default()
        });
        self.tables.last_mut().expect("just pushed")
    }

    /// The outcome of the targeted table.
    pub fn target(&self) -> &TableOutcome {
        self.table(&self.table_id)
            .expect("the target table is always present")
    }

    /// Ids of every record whose stored data changed in any table.
    pub fn all_updated(&self) -> Vec<(String, String)> {
        self.tables
            .iter()
            .flat_map(|t| t.updated.iter().map(|r| (t.table_id.clone(), r.clone())))
            .collect()
    }

    /// The events to publish after the transaction committed: one
    /// `RecordsChanged` per affected table (restored records count as
    /// created) and a `SchemaChanged` per table that gained choices.
    pub fn events(&self) -> Vec<BaseEvent> {
        let mut out = Vec::new();
        for t in &self.schema_changed {
            out.push(BaseEvent::SchemaChanged {
                table_id: Some(t.clone()),
            });
        }
        for t in &self.tables {
            let mut created: Vec<String> = t.created.to_vec();
            created.extend(t.restored.iter().cloned());
            if created.is_empty() && t.updated.is_empty() && t.deleted.is_empty() {
                continue;
            }
            out.push(BaseEvent::RecordsChanged {
                table_id: t.table_id.clone(),
                created,
                updated: t.updated.to_vec(),
                deleted: t.deleted.to_vec(),
            });
        }
        out
    }

    fn finalize(&mut self) {
        for t in &mut self.tables {
            let skip: Vec<String> = t.created.iter().chain(t.deleted.iter()).cloned().collect();
            for id in skip {
                t.updated.remove(&id);
            }
        }
    }
}

// ------------------------------------------------------------ test seam

/// One call to the automations hook, as recorded for tests.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedChange {
    pub base_id: String,
    pub table_id: String,
    pub created: Vec<String>,
    pub updated: Vec<(String, Vec<String>)>,
    pub form_view_id: Option<String>,
    pub user_id: Option<String>,
}

static RECORDER: LazyLock<Mutex<HashMap<String, Vec<RecordedChange>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Test seam: record the arguments of every [`automations::on_records_changed`]
/// call for `base_id` until [`stop_recording`]. Keyed by base id so parallel
/// tests do not interfere.
pub fn start_recording(base_id: &str) {
    RECORDER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(base_id.to_string(), Vec::new());
}

/// Recorded hook calls so far (drained).
pub fn take_recorded(base_id: &str) -> Vec<RecordedChange> {
    RECORDER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(base_id)
        .map(std::mem::take)
        .unwrap_or_default()
}

pub fn stop_recording(base_id: &str) {
    RECORDER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(base_id);
}

fn record_call(change: &RecordedChange) {
    let mut map = RECORDER.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(log) = map.get_mut(&change.base_id) {
        log.push(change.clone());
    }
}

// ------------------------------------------------------------------- writer

struct Notice {
    user_id: String,
    record_id: String,
    field_id: String,
}

/// People newly mentioned in a rich text cell.
struct MentionNotice {
    record_id: String,
    field_id: String,
    text: String,
    mentioned: Vec<mentions::Mention>,
}

struct Writer<'a> {
    tx: &'a Transaction<'a>,
    ctx: &'a WriteCtx,
    sess: Session<'a>,
    table: TableRow,
    out: WriteOutcome,
    collaborators: Option<HashSet<String>>,
    notices: Vec<Notice>,
    mention_notices: Vec<MentionNotice>,
    /// `records.data` of each directly edited record as it was before this
    /// write touched it (first edit wins), per table. Feeds the `before`
    /// snapshot of [`RecordChanges`].
    before: HashMap<(String, String), Map<String, Json>>,
}

/// The message for a rich-text reference to a file that is not the project's.
pub fn not_a_project_file(id: &str) -> String {
    format!(
        "attachment {id} is not a file of this project; upload the file to this project to \
         embed or link it"
    )
}

fn field_error(field: &Field, msg: impl std::fmt::Display) -> AppError {
    AppError::bad_request(format!("field \"{}\": {msg}", field.name))
}

impl<'a> Writer<'a> {
    fn begin(tx: &'a Transaction<'a>, ctx: &'a WriteCtx, table_id: &str) -> AppResult<Writer<'a>> {
        let table = schema::live_table(tx, table_id)?;
        let conn: &Connection = tx;
        let sess = Session::new(
            conn,
            &table.base_id,
            ctx.now,
            ctx.timezone,
            ctx.max_recomputes,
        )?;
        let out = WriteOutcome::new(&table.base_id, table_id);
        Ok(Writer {
            tx,
            ctx,
            sess,
            table,
            out,
            collaborators: None,
            notices: Vec::new(),
            mention_notices: Vec::new(),
            before: HashMap::new(),
        })
    }

    fn conn(&self) -> &'a Connection {
        self.sess.conn
    }

    fn check_batch(&self, n: usize, what: &str) -> AppResult<()> {
        if n == 0 {
            return Err(AppError::bad_request(format!(
                "at least one {what} is required"
            )));
        }
        if n > limits::MAX_RECORDS_PER_BATCH {
            return Err(AppError::bad_request(format!(
                "a request can change at most {} records",
                limits::MAX_RECORDS_PER_BATCH
            )));
        }
        Ok(())
    }

    /// An editable field of the target table.
    fn editable(&self, field_id: &str) -> AppResult<Field> {
        match self.sess.schema.fields.get(field_id) {
            Some(f) if f.table_id == self.table.id => {
                if f.field_type().is_computed() {
                    Err(AppError::bad_request(format!(
                        "field \"{}\" is computed and cannot be edited",
                        f.name
                    )))
                } else {
                    Ok(f.clone())
                }
            }
            _ => Err(AppError::bad_request(format!(
                "unknown field \"{field_id}\""
            ))),
        }
    }

    fn cell_ctx(&self) -> CellCtx {
        CellCtx {
            now: self.ctx.now,
            timezone: self.ctx.timezone,
            typecast: self.ctx.typecast,
        }
    }

    // ---- typecast: select choices

    /// With typecast, add the select choices named in `inputs` that do not
    /// exist yet (one schema update per field for the whole batch).
    fn ensure_choices<'v>(
        &mut self,
        inputs: impl Iterator<Item = (&'v String, &'v Json)>,
    ) -> AppResult<()> {
        if !self.ctx.typecast {
            return Ok(());
        }
        let mut wanted: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (field_id, value) in inputs {
            let Some(field) = self.sess.schema.fields.get(field_id) else {
                continue;
            };
            if field.table_id != self.table.id {
                continue;
            }
            let names = missing_choices(field, value);
            if names.is_empty() {
                continue;
            }
            let list = wanted.entry(field_id.clone()).or_default();
            for n in names {
                if !list.iter().any(|x| x.to_lowercase() == n.to_lowercase()) {
                    list.push(n);
                }
            }
        }
        if wanted.is_empty() {
            return Ok(());
        }
        for (field_id, names) in wanted {
            let mut field = self.sess.schema.fields[&field_id].clone();
            let choices = match &mut field.kind {
                FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => &mut o.choices,
                _ => continue,
            };
            if choices.len() + names.len() > limits::MAX_CHOICES_PER_FIELD {
                return Err(field_error(
                    &field,
                    format!(
                        "a select field can have at most {} choices",
                        limits::MAX_CHOICES_PER_FIELD
                    ),
                ));
            }
            for name in names {
                let name = schema::validate_name(&name, "choice")?;
                let color = default_choice_color(&name, choices.len()).to_string();
                choices.push(SelectChoice {
                    id: new_id(ids::CHOICE),
                    name,
                    color,
                });
            }
            schema::save_field(self.conn(), &field, None)?;
        }
        if !self.out.schema_changed.contains(&self.table.id) {
            self.out.schema_changed.push(self.table.id.clone());
        }
        self.sess.reload_schema()
    }

    // ---- normalization

    fn collaborators(&mut self) -> AppResult<&HashSet<String>> {
        if self.collaborators.is_none() {
            let mut stmt = self.conn().prepare(&format!(
                "SELECT u.id FROM users u
                 JOIN workspace_members m ON m.user_id = u.id
                 JOIN bases b ON b.workspace_id = m.workspace_id
                 WHERE u.is_active = 1 AND b.id = ?1 AND {}",
                crate::perm::MEMBER_CAN_OPEN_BASE
            ))?;
            let set: HashSet<String> = stmt
                .query_map([&self.table_base()], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            self.collaborators = Some(set);
        }
        Ok(self.collaborators.as_ref().expect("just set"))
    }

    fn table_base(&self) -> String {
        self.table.base_id.clone()
    }

    /// Normalize one client value and check what refers to other data.
    /// `old` is the cell's current stored value.
    fn cell(&mut self, field: &Field, input: &Json, old: Option<&Json>) -> AppResult<Option<Json>> {
        let normalized =
            normalize(field, input, &self.cell_ctx()).map_err(|e| field_error(field, e))?;
        let Some(value) = normalized else {
            // Cleared. A multi-link keeps the ids of trashed records it holds.
            if let (FieldKind::Link(o), Some(old)) = (&field.kind, old)
                && !o.single
            {
                let hidden = self.trashed_among(&ids_of(old))?;
                if !hidden.is_empty() {
                    return Ok(Some(ids_json(&hidden)));
                }
            }
            return Ok(None);
        };
        match &field.kind {
            FieldKind::Link(o) => {
                let ids = dedupe(ids_of(&value));
                if o.single && ids.len() > 1 {
                    return Err(field_error(field, "this field links to a single record"));
                }
                // Ids the cell already holds are fine even if their record has
                // been trashed since the client loaded it; new ones must be live.
                let held: HashSet<String> =
                    old.map(ids_of).unwrap_or_default().into_iter().collect();
                let fresh: Vec<String> =
                    ids.iter().filter(|i| !held.contains(*i)).cloned().collect();
                links::require_live_targets(self.conn(), field, &o.linked_table_id, &fresh)?;
                let mut all = ids;
                if !o.single
                    && let Some(old) = old
                {
                    let keep: Vec<String> = self
                        .trashed_among(&ids_of(old))?
                        .into_iter()
                        .filter(|i| !all.contains(i))
                        .collect();
                    all.extend(keep);
                }
                if all.len() > limits::MAX_LINKS_PER_CELL {
                    return Err(field_error(
                        field,
                        format!("too many links (maximum {})", limits::MAX_LINKS_PER_CELL),
                    ));
                }
                Ok((!all.is_empty()).then(|| ids_json(&all)))
            }
            FieldKind::User(_) => {
                let ids = dedupe(ids_of(&value));
                let existing: HashSet<String> =
                    old.map(ids_of).unwrap_or_default().into_iter().collect();
                let collaborators = self.collaborators()?;
                if let Some(bad) = ids
                    .iter()
                    .find(|u| !existing.contains(*u) && !collaborators.contains(*u))
                {
                    return Err(field_error(
                        field,
                        format!("user {bad} is not a collaborator on this base"),
                    ));
                }
                Ok((!ids.is_empty()).then(|| ids_json(&ids)))
            }
            FieldKind::Attachment(_) => {
                let Some(items) = value.as_array() else {
                    return Ok(None);
                };
                let mut refs = Vec::new();
                let mut seen = HashSet::new();
                for item in items {
                    let id = item.get("id").and_then(Json::as_str).unwrap_or_default();
                    if !seen.insert(id.to_string()) {
                        continue;
                    }
                    let row = attachments::get(self.conn(), id)?
                        .filter(|a| a.base_id.as_deref() == Some(self.table.base_id.as_str()))
                        .ok_or_else(|| {
                            field_error(
                                field,
                                format!("attachment {id} was not found in this base"),
                            )
                        })?;
                    refs.push(serde_json::to_value(row.to_ref())?);
                }
                Ok((!refs.is_empty()).then_some(Json::Array(refs)))
            }
            FieldKind::RichText(_) => {
                // Files embedded or linked in the text (`/api/attachments/<id>/...`) must be
                // files of this project, like the files of an attachment cell. A reference
                // the cell already holds is left alone.
                if let Some(text) = value.as_str()
                    && let Some(bad) = attachments::first_foreign_ref(
                        self.conn(),
                        &self.table.base_id,
                        text,
                        old.and_then(Json::as_str),
                    )?
                {
                    return Err(field_error(field, not_a_project_file(&bad)));
                }
                Ok(Some(value))
            }
            _ => Ok(Some(value)),
        }
    }

    /// The ids among `ids` whose records are in the trash (not live, not purged).
    fn trashed_among(&self, ids: &[String]) -> AppResult<Vec<String>> {
        let trashed: HashSet<String> = records::get_many(self.conn(), ids)?
            .into_iter()
            .filter(|r| r.deleted_at.is_some())
            .map(|r| r.id)
            .collect();
        Ok(ids
            .iter()
            .filter(|i| trashed.contains(*i))
            .cloned()
            .collect())
    }

    /// Defaults for editable fields the new record does not mention.
    fn defaults(
        &mut self,
        given: &BTreeMap<String, Json>,
    ) -> AppResult<Vec<(String, Option<Json>)>> {
        let mut out = Vec::new();
        let fields: Vec<Field> = self.sess.schema.fields_of(&self.table.id).to_vec();
        for f in fields {
            if given.contains_key(&f.id) {
                continue;
            }
            let default = match &f.kind {
                FieldKind::Text(o) => o.default.clone().map(Json::String),
                FieldKind::Number(o) | FieldKind::Percent(o) => o.default.map(|d| json!(d)),
                _ => None,
            };
            if let Some(d) = default {
                let cell = self.cell(&f, &d, None)?;
                if cell.is_some() {
                    out.push((f.id.clone(), cell));
                }
            }
        }
        Ok(out)
    }

    // ---- link pairs and row edits

    /// Apply a link change on `record_id`'s cell to the inverse field of the
    /// records involved.
    fn sync_inverse(
        &mut self,
        record_id: &str,
        link: &Field,
        added: &[String],
        removed: &[String],
    ) -> AppResult<()> {
        let FieldKind::Link(lo) = &link.kind else {
            return Ok(());
        };
        let Some(inv) = self.sess.schema.inverse.get(&link.id).cloned() else {
            tracing::warn!(field = %link.id, "link field has no live inverse; not syncing");
            return Ok(());
        };
        let linked_table = lo.linked_table_id.clone();
        for (ids, add) in [(removed, false), (added, true)] {
            for target in ids {
                let Some(row) = self.sess.rows.get(self.conn(), target)? else {
                    continue;
                };
                if row.table_id != linked_table {
                    continue;
                }
                let mut current = link_ids(&row.data, &inv);
                let before = current.clone();
                if add {
                    if !current.iter().any(|i| i == record_id) {
                        current.push(record_id.to_string());
                    }
                } else {
                    current.retain(|i| i != record_id);
                }
                if current == before {
                    continue;
                }
                let mut data = row.data.clone();
                let old = data.get(&inv).cloned();
                let new = (!current.is_empty()).then(|| ids_json(&current));
                match &new {
                    Some(v) => data.insert(inv.clone(), v.clone()),
                    None => data.remove(&inv),
                };
                let mut changes = Map::new();
                changes.insert(inv.clone(), history::change(old.as_ref(), new.as_ref()));
                self.commit_edit(&row, data, &changes, std::slice::from_ref(&inv))?;
            }
        }
        Ok(())
    }

    /// Save an edited row: data, edit stamp, history, caches, outcome and
    /// recompute seeds. `changed` lists the editable fields that changed.
    fn commit_edit(
        &mut self,
        row: &RecordRow,
        data: Map<String, Json>,
        changes: &Map<String, Json>,
        changed: &[String],
    ) -> AppResult<()> {
        let at = self.ctx.now_ms();
        self.before
            .entry((row.table_id.clone(), row.id.clone()))
            .or_insert_with(|| row.data.clone());
        records::save_edit(self.conn(), &row.id, &data, at, self.ctx.actor_str())?;
        history::record(
            self.conn(),
            &row.id,
            &row.table_id,
            self.ctx.actor_str(),
            history::UPDATE,
            changes,
            at,
        )?;
        let mut next = row.clone();
        next.data = data;
        next.updated_at = at;
        next.updated_by = self.ctx.actor.clone();
        self.sess.rows.put(next);
        self.sess.names.invalidate(&row.id);
        let t = self.out.table_mut(&row.table_id);
        t.updated.push(&row.id);
        t.edited
            .entry(row.id.clone())
            .or_default()
            .extend(changed.iter().cloned());
        self.sess
            .mark_edited(&row.table_id, &row.id, changed, false)
    }

    fn note_new_users(
        &mut self,
        field: &Field,
        record_id: &str,
        old: Option<&Json>,
        new: Option<&Json>,
    ) {
        let FieldKind::User(o) = &field.kind else {
            return;
        };
        if !o.notify {
            return;
        }
        let before: HashSet<String> = old.map(ids_of).unwrap_or_default().into_iter().collect();
        for u in new.map(ids_of).unwrap_or_default() {
            if !before.contains(&u) && Some(u.as_str()) != self.ctx.actor_str() {
                self.notices.push(Notice {
                    user_id: u,
                    record_id: record_id.to_string(),
                    field_id: field.id.clone(),
                });
            }
        }
    }

    /// Remember who a rich text cell newly mentions, to notify them once the
    /// write is done. Without an actor there is no author to name, so nobody is.
    fn note_new_mentions(
        &mut self,
        field: &Field,
        record_id: &str,
        old: Option<&Json>,
        new: Option<&Json>,
    ) {
        let (FieldKind::RichText(_), Some(text), Some(_)) =
            (&field.kind, new.and_then(Json::as_str), &self.ctx.actor)
        else {
            return;
        };
        let mentioned = mentions::added(old.and_then(Json::as_str), text);
        if !mentioned.is_empty() {
            self.mention_notices.push(MentionNotice {
                record_id: record_id.to_string(),
                field_id: field.id.clone(),
                text: text.to_string(),
                mentioned,
            });
        }
    }

    // ---- loading

    fn live_row(&mut self, id: &str) -> AppResult<std::sync::Arc<RecordRow>> {
        match self.sess.rows.get(self.conn(), id)? {
            Some(r) if r.table_id == self.table.id && r.deleted_at.is_none() => Ok(r),
            _ => Err(AppError::not_found(format!("record {id}"))),
        }
    }

    // ---- finishing

    fn finish(mut self) -> AppResult<WriteOutcome> {
        self.sess.run()?;
        for (table, ids) in self.sess.updated().clone() {
            let t = self.out.table_mut(&table);
            for id in ids {
                t.updated.push(&id);
            }
        }
        self.out.finalize();
        self.send_notifications()?;
        self.call_automations()?;
        Ok(self.out)
    }

    fn send_notifications(&mut self) -> AppResult<()> {
        if let Some(author) = self.ctx.actor.clone() {
            // One notification per person and record, however many cells mention them.
            let mut told: HashSet<(String, String)> = HashSet::new();
            for mut n in std::mem::take(&mut self.mention_notices) {
                n.mentioned
                    .retain(|m| told.insert((m.user_id.clone(), n.record_id.clone())));
                let field_name = self
                    .sess
                    .schema
                    .fields
                    .get(&n.field_id)
                    .map(|f| f.name.clone())
                    .unwrap_or_default();
                mentions::notify(
                    self.conn(),
                    &n.record_id,
                    &author,
                    &n.text,
                    &n.mentioned,
                    mentions::Place::Field {
                        id: &n.field_id,
                        name: &field_name,
                    },
                )?;
            }
        }
        if self.notices.is_empty() {
            return Ok(());
        }
        let (base_name, base_icon): (String, Option<String>) = self
            .conn()
            .query_row(
                "SELECT name, icon FROM bases WHERE id = ?1",
                [&self.table.base_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default();
        let field_names: HashMap<String, String> = self
            .sess
            .schema
            .fields
            .values()
            .map(|f| (f.id.clone(), f.name.clone()))
            .collect();
        let notices = std::mem::take(&mut self.notices);
        let mut done: HashSet<(String, String, String)> = HashSet::new();
        for n in notices {
            if !done.insert((n.user_id.clone(), n.record_id.clone(), n.field_id.clone())) {
                continue;
            }
            self.sess.names.invalidate(&n.record_id);
            let record_name = self
                .sess
                .names
                .record_text(&n.record_id)
                .unwrap_or_default();
            notifications::create(
                self.conn(),
                &n.user_id,
                "assigned",
                &json!({
                    "base_id": self.table.base_id,
                    "base_name": base_name,
                    "base_icon": base_icon,
                    "table_id": self.table.id,
                    "table_name": self.table.name,
                    "table_icon": self.table.icon,
                    "record_id": n.record_id,
                    "record_name": record_name,
                    "field_id": n.field_id,
                    "field_name": field_names.get(&n.field_id).cloned().unwrap_or_default(),
                    "assigned_by": self.ctx.actor,
                }),
            )?;
        }
        Ok(())
    }

    fn call_automations(&self) -> AppResult<()> {
        let form_view = match &self.ctx.source {
            WriteSource::Form { view_id } => Some(view_id.as_str()),
            _ => None,
        };
        for t in &self.out.tables {
            let edited: Vec<(String, Vec<String>)> = t
                .edited
                .iter()
                .filter(|(id, _)| !t.created.contains(id))
                .map(|(id, f)| (id.clone(), f.iter().cloned().collect()))
                .collect();
            if t.created.is_empty() && edited.is_empty() {
                continue;
            }
            record_call(&RecordedChange {
                base_id: self.out.base_id.clone(),
                table_id: t.table_id.clone(),
                created: t.created.to_vec(),
                updated: edited.clone(),
                form_view_id: form_view.map(str::to_string),
                user_id: self.ctx.actor.clone(),
            });
            let before: Vec<(String, Map<String, Json>)> = edited
                .iter()
                .filter_map(|(id, _)| {
                    self.before
                        .get(&(t.table_id.clone(), id.clone()))
                        .map(|d| (id.clone(), d.clone()))
                })
                .collect();
            automations::on_records_changed(
                self.tx,
                &RecordChanges {
                    base_id: &self.out.base_id,
                    table_id: &t.table_id,
                    created: &t.created,
                    updated: &edited,
                    form_view_id: form_view,
                    user_id: self.ctx.actor_str(),
                    by_automation: matches!(self.ctx.source, WriteSource::Automation),
                    before: &before,
                },
            )?;
        }
        Ok(())
    }
}

// ----------------------------------------------------------------- create

/// Create records. Returns the outcome; the new ids are in
/// `outcome.target().created`, in input order.
pub fn create_records(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    new_records: Vec<NewRecord>,
    opts: &CreateOpts,
) -> AppResult<WriteOutcome> {
    if opts.after_record_id.is_some() && opts.before_record_id.is_some() {
        return Err(AppError::bad_request(
            "give either before_record_id or after_record_id, not both",
        ));
    }
    let mut w = Writer::begin(tx, ctx, table_id)?;
    w.check_batch(new_records.len(), "record")?;
    let live = records::live_count(w.conn(), table_id)?;
    if live + new_records.len() > limits::MAX_RECORDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "a table can have at most {} records",
            limits::MAX_RECORDS_PER_TABLE
        )));
    }
    w.ensure_choices(new_records.iter().flat_map(|r| r.values.iter()))?;

    // Normalize everything before writing anything.
    let mut prepared: Vec<Vec<(Field, Option<Json>)>> = Vec::with_capacity(new_records.len());
    for rec in &new_records {
        let mut cells = Vec::new();
        for (fid, input) in &rec.values {
            let field = w.editable(fid)?;
            let cell = w.cell(&field, input, None)?;
            cells.push((field, cell));
        }
        for (fid, cell) in w.defaults(&rec.values)? {
            let field = w.editable(&fid)?;
            cells.push((field, cell));
        }
        prepared.push(cells);
    }

    let n = prepared.len();
    let exclude = HashSet::new();
    let place = match (
        opts.after_record_id.as_deref(),
        opts.before_record_id.as_deref(),
    ) {
        (Some(anchor), _) => Place::After(anchor),
        (None, Some(anchor)) => Place::Before(anchor),
        (None, None) => Place::End,
    };
    let positions = records::positions_for(w.conn(), table_id, place, n, &exclude)?;
    let first_auto = records::reserve_autonumbers(w.conn(), table_id, n)?;
    let at = ctx.now_ms();

    for (i, cells) in prepared.into_iter().enumerate() {
        let id = new_id(ids::RECORD);
        let mut data = Map::new();
        let mut changes = Map::new();
        let mut changed = Vec::new();
        for (field, cell) in &cells {
            if let Some(v) = cell {
                data.insert(field.id.clone(), v.clone());
                changes.insert(field.id.clone(), history::change(None, Some(v)));
                changed.push(field.id.clone());
            }
        }
        let row = RecordRow {
            id: id.clone(),
            table_id: table_id.to_string(),
            data,
            position: positions[i],
            autonumber: first_auto + i as i64,
            created_at: at,
            created_by: ctx.actor.clone(),
            updated_at: at,
            updated_by: ctx.actor.clone(),
            deleted_at: None,
        };
        records::insert(w.conn(), &row)?;
        history::record(
            w.conn(),
            &id,
            table_id,
            ctx.actor_str(),
            history::CREATE,
            &changes,
            at,
        )?;
        w.sess.rows.put(row);
        w.out.table_mut(table_id).created.push(&id);
        for (field, cell) in &cells {
            w.note_new_users(field, &id, None, cell.as_ref());
            w.note_new_mentions(field, &id, None, cell.as_ref());
            if let (FieldKind::Link(_), Some(v)) = (&field.kind, cell) {
                let ids = ids_of(v);
                w.sync_inverse(&id, field, &ids, &[])?;
            }
        }
        w.sess.mark_edited(table_id, &id, &changed, true)?;
    }
    w.finish()
}

// ----------------------------------------------------------------- update

/// Apply field patches to records. Patches that change nothing are skipped
/// entirely. The updated records are `outcome.target().edited` /
/// `.updated`; every patched record is listed in the response even when it
/// did not change, so callers should re-read records by the ids they sent.
pub fn update_records(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    patches: Vec<RecordPatch>,
) -> AppResult<WriteOutcome> {
    let mut w = Writer::begin(tx, ctx, table_id)?;
    w.check_batch(patches.len(), "record")?;
    let mut seen = HashSet::new();
    for p in &patches {
        if !seen.insert(p.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "record {} appears more than once",
                p.id
            )));
        }
    }
    w.ensure_choices(patches.iter().flat_map(|p| p.values.iter()))?;

    for patch in &patches {
        let row = w.live_row(&patch.id)?;
        let mut data = row.data.clone();
        let mut changes = Map::new();
        let mut changed = Vec::new();
        let mut link_changes: Vec<(Field, Vec<String>, Vec<String>)> = Vec::new();
        let mut user_changes: Vec<(Field, Option<Json>, Option<Json>)> = Vec::new();
        let mut text_changes: Vec<(Field, Option<Json>, Option<Json>)> = Vec::new();
        for (fid, input) in &patch.values {
            let field = w.editable(fid)?;
            let old = data.get(fid).cloned();
            let new = w.cell(&field, input, old.as_ref())?;
            if same_json(old.as_ref(), new.as_ref()) {
                continue;
            }
            match &new {
                Some(v) => data.insert(fid.clone(), v.clone()),
                None => data.remove(fid),
            };
            changes.insert(fid.clone(), history::change(old.as_ref(), new.as_ref()));
            changed.push(fid.clone());
            match &field.kind {
                FieldKind::Link(_) => {
                    let before = old.as_ref().map(ids_of).unwrap_or_default();
                    let after = new.as_ref().map(ids_of).unwrap_or_default();
                    let (added, removed) = links::diff(&before, &after);
                    link_changes.push((field, added, removed));
                }
                FieldKind::User(_) => user_changes.push((field, old, new)),
                FieldKind::RichText(_) => text_changes.push((field, old, new)),
                _ => {}
            }
        }
        if changed.is_empty() {
            continue;
        }
        w.commit_edit(&row, data, &changes, &changed)?;
        for (field, old, new) in user_changes {
            w.note_new_users(&field, &row.id, old.as_ref(), new.as_ref());
        }
        for (field, old, new) in text_changes {
            w.note_new_mentions(&field, &row.id, old.as_ref(), new.as_ref());
        }
        for (field, added, removed) in link_changes {
            w.sync_inverse(&row.id, &field, &added, &removed)?;
        }
    }
    w.finish()
}

// ----------------------------------------------------------------- delete

fn distinct_ids(ids: &[String]) -> AppResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id.as_str()) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

impl Writer<'_> {
    /// After `row` became hidden or visible, the records it links to see a
    /// different set of linked records: queue what depends on their link cell.
    fn mark_link_neighbours(&mut self, row: &RecordRow) -> AppResult<()> {
        let links: Vec<Field> = self
            .sess
            .schema
            .fields_of(&row.table_id)
            .iter()
            .filter(|f| matches!(f.kind, FieldKind::Link(_)))
            .cloned()
            .collect();
        for f in links {
            let FieldKind::Link(lo) = &f.kind else {
                continue;
            };
            let Some(inv) = self.sess.schema.inverse.get(&f.id).cloned() else {
                continue;
            };
            let Some(stored) = row.data.get(&f.id) else {
                continue;
            };
            for other in self.sess.names.live_ids(stored) {
                self.sess.mark_changed(&lo.linked_table_id, &other, &inv)?;
            }
        }
        Ok(())
    }
}

/// Move records to the trash. Their link cells stay intact; linked records
/// stop counting them (counts, lookups, rollups and formulas are recomputed).
pub fn delete_records(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    ids: &[String],
) -> AppResult<WriteOutcome> {
    let mut w = Writer::begin(tx, ctx, table_id)?;
    w.check_batch(ids.len(), "record id")?;
    let ids = distinct_ids(ids)?;
    let mut rows = Vec::new();
    for id in &ids {
        rows.push(w.live_row(id)?);
    }
    let at = ctx.now_ms();
    for row in rows {
        records::set_deleted_at(w.conn(), &row.id, Some(at), ctx.actor_str())?;
        history::record(
            w.conn(),
            &row.id,
            table_id,
            ctx.actor_str(),
            history::DELETE,
            &Map::new(),
            at,
        )?;
        let mut next = (*row).clone();
        next.deleted_at = Some(at);
        let next = w.sess.rows.put(next);
        w.sess.names.invalidate(&row.id);
        w.out.table_mut(table_id).deleted.push(&row.id);
        w.mark_link_neighbours(&next)?;
    }
    w.finish()
}

// --------------------------------------------------------------- discard

/// How long after its creation a record can still be taken back with [`discard_record`].
pub const DISCARD_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Take back a record nobody has touched: remove it for good, with its history, as if it had
/// never been created. Unlike [`delete_records`] nothing lands in the trash.
///
/// It is removed only when the caller created it less than [`DISCARD_WINDOW_MS`] ago, its only
/// history entry is that creation, `updated_at` still equals `created_at`, it has no comments
/// (deleted ones included), no attachment or link cell of its own, and no other record links
/// to it. Otherwise nothing changes and the answer is `None`. Notifications that name the
/// record go with it. Automations that already ran when it was created are not undone, and
/// their run logs keep the record id.
pub fn discard_record(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    id: &str,
) -> AppResult<Option<WriteOutcome>> {
    let w = Writer::begin(tx, ctx, table_id)?;
    let conn = w.conn();
    let Some(row) = records::get(conn, id)? else {
        return Err(AppError::not_found(format!("record {id}")));
    };
    if row.table_id != table_id || row.deleted_at.is_some() {
        return Err(AppError::not_found(format!("record {id}")));
    }
    let Some(actor) = ctx.actor_str() else {
        return Ok(None);
    };
    if row.created_by.as_deref() != Some(actor)
        || ctx.now_ms() - row.created_at > DISCARD_WINDOW_MS
        || row.updated_at != row.created_at
    {
        return Ok(None);
    }
    // One history entry, the creation (by the caller).
    let (entries, creates): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(kind = 'create' AND user_id IS ?2), 0)
         FROM record_history WHERE record_id = ?1",
        rusqlite::params![id, actor],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if entries != 1 || creates != 1 {
        return Ok(None);
    }
    let commented: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM comments WHERE record_id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if commented {
        return Ok(None);
    }
    // Its own link and attachment cells; links from other records in the project.
    let holds_refs = schema::table_fields(conn, table_id)?.iter().any(|f| {
        matches!(f.kind, FieldKind::Link(_) | FieldKind::Attachment(_))
            && row.data.get(&f.id).is_some_and(|v| match v {
                Json::Array(a) => !a.is_empty(),
                Json::Null => false,
                _ => true,
            })
    });
    if holds_refs {
        return Ok(None);
    }
    let linked: bool = conn.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM records r JOIN tables t ON t.id = r.table_id
             WHERE t.base_id = ?2 AND r.id != ?1 AND instr(r.data, ?1) > 0)",
        rusqlite::params![id, w.table.base_id],
        |r| r.get(0),
    )?;
    if linked {
        return Ok(None);
    }
    conn.execute("DELETE FROM record_history WHERE record_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM notifications WHERE instr(payload, ?1) > 0",
        [id],
    )?;
    conn.execute("DELETE FROM records WHERE id = ?1", [id])?;
    let mut out = WriteOutcome::new(&w.table.base_id, table_id);
    out.table_mut(table_id).deleted.push(id);
    Ok(Some(out))
}

// ---------------------------------------------------------------- restore

/// Bring trashed records back. Their computed fields are recalculated and the
/// records they link to count them again.
pub fn restore_records(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    ids: &[String],
) -> AppResult<WriteOutcome> {
    let mut w = Writer::begin(tx, ctx, table_id)?;
    w.check_batch(ids.len(), "record id")?;
    let ids = distinct_ids(ids)?;
    let mut rows = Vec::new();
    for id in &ids {
        match w.sess.rows.get(w.conn(), id)? {
            Some(r) if r.table_id == table_id => {
                if r.deleted_at.is_none() {
                    return Err(AppError::conflict(format!(
                        "record {id} is not in the trash"
                    )));
                }
                rows.push(r);
            }
            _ => return Err(AppError::not_found(format!("record {id}"))),
        }
    }
    let live = records::live_count(w.conn(), table_id)?;
    if live + rows.len() > limits::MAX_RECORDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "a table can have at most {} records",
            limits::MAX_RECORDS_PER_TABLE
        )));
    }
    let at = ctx.now_ms();
    for row in rows {
        records::set_deleted_at(w.conn(), &row.id, None, None)?;
        history::record(
            w.conn(),
            &row.id,
            table_id,
            ctx.actor_str(),
            history::RESTORE,
            &Map::new(),
            at,
        )?;
        let mut next = (*row).clone();
        next.deleted_at = None;
        let next = w.sess.rows.put(next);
        w.sess.names.invalidate(&row.id);
        w.out.table_mut(table_id).restored.push(&row.id);
        w.sess.mark_all_computed(table_id, &row.id);
        w.mark_link_neighbours(&next)?;
    }
    w.finish()
}

// ------------------------------------------------------------------- move

/// Reorder records in the table's manual order: place `req.ids` (in the given
/// order) before `before_id` or after `after_id`; neither means the end of
/// the table.
pub fn move_records(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    req: &MoveRecords,
) -> AppResult<WriteOutcome> {
    let mut w = Writer::begin(tx, ctx, table_id)?;
    w.check_batch(req.ids.len(), "record id")?;
    if req.before_id.is_some() && req.after_id.is_some() {
        return Err(AppError::bad_request(
            "give either before_id or after_id, not both",
        ));
    }
    let ids = distinct_ids(&req.ids)?;
    for id in &ids {
        w.live_row(id)?;
    }
    let moving: HashSet<String> = ids.iter().cloned().collect();
    let place = match (&req.before_id, &req.after_id) {
        (Some(b), None) => Place::Before(b),
        (None, Some(a)) => Place::After(a),
        _ => Place::End,
    };
    if let Some(anchor) = req.before_id.as_ref().or(req.after_id.as_ref())
        && moving.contains(anchor)
    {
        return Err(AppError::bad_request(
            "the reference record cannot be one of the moved records",
        ));
    }
    let positions = records::positions_for(w.conn(), table_id, place, ids.len(), &moving)?;
    for (id, pos) in ids.iter().zip(positions) {
        records::set_position(w.conn(), id, pos)?;
        w.sess.rows.forget(id);
        w.out.table_mut(table_id).updated.push(id);
    }
    // A reorder is not an edit: no history, no automations, no recompute.
    w.out.finalize();
    Ok(w.out)
}
