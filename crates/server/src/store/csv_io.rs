//! CSV reading, column type inference, cell escaping for export and the
//! all-or-nothing import runner.
//!
//! Reading is deliberately forgiving about what spreadsheets produce and
//! strict about size: a UTF-8 BOM is skipped, files that are not UTF-8 are
//! read as Latin-1, the delimiter (`,` `;` or tab) is detected from the first
//! line, `\r\n`, `\n` and `\r` line ends and quoted newlines work, ragged rows
//! are padded, completely blank rows are dropped (but keep their row numbers
//! in error messages).
//!
//! Importing goes through [`crate::engine::write::create_records`] in batches
//! of [`limits::MAX_RECORDS_PER_BATCH`] inside one transaction. When a batch
//! fails, its rows are bisected (in savepoints) to find which rows are
//! wrong; the scan continues so that up to [`MAX_ROW_ERRORS`] bad rows are
//! reported at once, then everything is rolled back. Nothing is written
//! unless every row is accepted.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use og_core::api::records::NewRecord;
use og_core::api::sharing::ImportRowError;
use og_core::cell::{CellCtx, normalize};
use og_core::field::{
    CurrencyOptions, DateFormat, DateOptions, Field, FieldKind, NumberOptions, SelectChoice,
    SelectOptions, TextOptions, TimeFormat,
};
use og_core::limits;
use regex::Regex;
use rusqlite::Transaction;
use serde_json::Value as Json;

use crate::engine::write::{CreateOpts, WriteCtx, WriteOutcome, create_records};
use crate::error::{AppError, AppResult};
use crate::store::records;
use crate::store::schema;

/// Largest accepted CSV file.
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Most data rows in one import.
pub const MAX_ROWS: usize = 100_000;
/// Most columns in one import.
pub const MAX_COLUMNS: usize = 500;
/// Most cells (rows x columns, counting the header row and every short row
/// as padded to the widest one) in one import. Each cell is a heap `String`,
/// so this bounds the parse at roughly 150-250 MB however the 20 MB file is
/// shaped (`a,a,a,...` or one wide row plus many short ones).
pub const MAX_CELLS: usize = 3_000_000;
/// Row errors reported before the scan stops.
pub const MAX_ROW_ERRORS: usize = 50;
/// A text column with at most this many distinct values (and repeated
/// values) becomes a single select.
pub const MAX_SELECT_CHOICES: usize = 12;

// ----------------------------------------------------------------- reading

/// One data row of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvRow {
    /// 1-based position among the file's records (the header is row 1).
    pub number: usize,
    /// Always exactly [`Csv::columns`] cells.
    pub cells: Vec<String>,
}

/// A parsed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Csv {
    pub has_header: bool,
    /// One name per column: the header text (trimmed, de-duplicated) or
    /// `Column N` when the file has no header or the cell is empty.
    pub header: Vec<String>,
    pub rows: Vec<CsvRow>,
}

impl Csv {
    pub fn columns(&self) -> usize {
        self.header.len()
    }
}

fn decode(bytes: &[u8]) -> AppResult<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::bad_request(
            "this file is UTF-16; save it as CSV UTF-8 and try again",
        ));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        // Not UTF-8 (typically a legacy Excel export): read as Latin-1.
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    };
    Ok(text.replace('\0', ""))
}

/// Pick `,`, `;` or tab by counting them (outside quotes) on the first record.
fn detect_delimiter(text: &str) -> u8 {
    let mut counts = [0usize; 3];
    let mut in_quotes = false;
    for c in text.chars().take(64 * 1024) {
        match c {
            '"' => in_quotes = !in_quotes,
            '\n' | '\r' if !in_quotes => break,
            ',' if !in_quotes => counts[0] += 1,
            ';' if !in_quotes => counts[1] += 1,
            '\t' if !in_quotes => counts[2] += 1,
            _ => {}
        }
    }
    let best = counts
        .iter()
        .enumerate()
        .max_by_key(|(i, n)| (**n, std::cmp::Reverse(*i)))
        .map(|(i, _)| i)
        .unwrap_or(0);
    if counts[best] == 0 {
        return b',';
    }
    b",;\t"[best]
}

fn clean_header_name(raw: &str, index: usize) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return format!("Column {}", index + 1);
    }
    trimmed.chars().take(limits::MAX_NAME_LEN).collect()
}

/// Row numbers (1-based, every line counts, including empty ones) of the
/// records the CSV reader will return, which skips empty lines. Quoted fields
/// may contain line breaks; a quote only opens a quoted field at its start.
fn record_numbers(text: &str, delimiter: u8) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut numbers = Vec::new();
    let (mut row, mut line_len) = (1usize, 0usize);
    let (mut field_start, mut in_quotes) = (true, false);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_quotes {
            line_len += 1;
            if b == b'"' {
                if bytes.get(i + 1) == Some(&b'"') {
                    i += 1;
                    line_len += 1;
                } else {
                    in_quotes = false;
                }
            }
        } else if b == b'\n' || b == b'\r' {
            if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            if line_len > 0 {
                numbers.push(row);
            }
            row += 1;
            line_len = 0;
            field_start = true;
        } else if b == delimiter {
            line_len += 1;
            field_start = true;
        } else if b == b'"' && field_start {
            line_len += 1;
            in_quotes = true;
            field_start = false;
        } else {
            line_len += 1;
            field_start = false;
        }
        i += 1;
    }
    if line_len > 0 {
        numbers.push(row);
    }
    numbers
}

/// Parse CSV bytes. Fails with a 400 when the file is empty, unreadable or
/// over the row/column limits.
pub fn parse(bytes: &[u8], has_header: bool) -> AppResult<Csv> {
    let text = decode(bytes)?;
    let delimiter = detect_delimiter(&text);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records: Vec<(usize, Vec<String>)> = Vec::new();
    let mut width = 0usize;
    // The reader drops empty lines silently; spreadsheets count them as rows,
    // so row numbers come from a separate scan of the text.
    let numbers = record_numbers(&text, delimiter);
    let mut rec = csv::StringRecord::new();
    loop {
        let more = reader
            .read_record(&mut rec)
            .map_err(|e| AppError::bad_request(format!("could not read the CSV: {e}")))?;
        if !more {
            break;
        }
        let row_number = numbers
            .get(records.len())
            .copied()
            .unwrap_or(records.len() + 1);
        if records.len() > MAX_ROWS + 1 {
            return Err(AppError::bad_request(format!(
                "a CSV import can have at most {MAX_ROWS} rows"
            )));
        }
        width = width.max(rec.len());
        if width > MAX_COLUMNS {
            return Err(AppError::bad_request(format!(
                "a CSV import can have at most {MAX_COLUMNS} columns"
            )));
        }
        // Rows are padded to the widest row, so rows x width (which only
        // grows) is the final cell count; refuse before allocating it.
        if (records.len() + 1).saturating_mul(width) > MAX_CELLS {
            return Err(AppError::bad_request(format!(
                "a CSV import can have at most {MAX_CELLS} cells (rows x columns); \
                 split the file or drop unused columns"
            )));
        }
        records.push((row_number, rec.iter().map(str::to_string).collect()));
    }
    if records.is_empty() || width == 0 {
        return Err(AppError::bad_request("the CSV file is empty"));
    }
    let mut rest = records.into_iter();
    let header_cells: Vec<String> = if has_header {
        rest.next().map(|(_, c)| c).unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut seen: HashSet<String> = HashSet::new();
    let header: Vec<String> = (0..width)
        .map(|i| {
            let raw = if has_header {
                header_cells.get(i).map(String::as_str).unwrap_or("")
            } else {
                ""
            };
            let name = schema::uniquify(&seen, &clean_header_name(raw, i));
            seen.insert(schema::name_key(&name));
            name
        })
        .collect();
    let mut rows = Vec::new();
    for (number, mut cells) in rest {
        if cells.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        cells.resize(width, String::new());
        rows.push(CsvRow { number, cells });
    }
    if rows.len() > MAX_ROWS {
        return Err(AppError::bad_request(format!(
            "a CSV import can have at most {MAX_ROWS} rows"
        )));
    }
    Ok(Csv {
        has_header,
        header,
        rows,
    })
}

// ----------------------------------------------------------- export cells

/// Whether a spreadsheet would read `text` as a number (so a leading `-` is
/// just a sign, not a formula).
fn is_plain_number(text: &str) -> bool {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^-?[0-9][0-9.,]*%?$").expect("valid regex"));
    RE.is_match(text)
}

/// Protect against formula injection when the file is opened in a
/// spreadsheet: a cell starting with `=`, `+`, `-`, `@`, tab or carriage
/// return gets a leading single quote. Numbers keep their sign when
/// `numeric` says the cell holds a number.
pub fn guard_cell(text: String, numeric: bool) -> String {
    match text.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') if !(numeric && is_plain_number(&text)) => {
            format!("'{text}")
        }
        _ => text,
    }
}

// --------------------------------------------------------------- inference

static RE_ISO_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("valid regex"));
static RE_ISO_DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
        .expect("valid regex")
});
static RE_SLASH_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{1,2})/(\d{1,2})/\d{4}$").expect("valid regex"));
static RE_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$").expect("valid regex"));
static RE_PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?\s?%$").expect("valid regex"));
static RE_CURRENCY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(-?)([$€£¥])\s?(-?)(0|[1-9][0-9]*|[1-9][0-9]{0,2}(,[0-9]{3})+)(\.[0-9]+)?$")
        .expect("valid regex")
});
static RE_EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").expect("valid regex"));
static RE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https?://[^\s]+$").expect("valid regex"));

const BOOLEAN_WORDS: [&str; 6] = ["true", "false", "yes", "no", "checked", "unchecked"];

fn decimals(text: &str) -> usize {
    text.split_once('.')
        .map(|(_, frac)| frac.chars().take_while(char::is_ascii_digit).count())
        .unwrap_or(0)
}

fn date_options(values: &[&str]) -> Option<DateOptions> {
    if values.iter().all(|v| RE_ISO_DATE.is_match(v)) {
        return Some(DateOptions {
            date_format: DateFormat::Iso,
            ..DateOptions::default()
        });
    }
    if values
        .iter()
        .all(|v| RE_ISO_DATE.is_match(v) || RE_ISO_DATETIME.is_match(v))
    {
        return Some(DateOptions {
            include_time: true,
            date_format: DateFormat::Iso,
            time_format: TimeFormat::H24,
            timezone: None,
        });
    }
    let mut first_over_12 = false;
    let mut second_over_12 = false;
    for v in values {
        let c = RE_SLASH_DATE.captures(v)?;
        first_over_12 |= c[1].parse::<u32>().ok()? > 12;
        second_over_12 |= c[2].parse::<u32>().ok()? > 12;
    }
    match (first_over_12, second_over_12) {
        (true, true) => None,
        (true, false) => Some(DateOptions {
            date_format: DateFormat::European,
            ..DateOptions::default()
        }),
        _ => Some(DateOptions {
            date_format: DateFormat::Us,
            ..DateOptions::default()
        }),
    }
}

fn currency_options(values: &[&str]) -> Option<CurrencyOptions> {
    let mut symbol: Option<String> = None;
    let mut max_decimals = 0;
    for v in values {
        let c = RE_CURRENCY.captures(v)?;
        // A sign before and after the symbol would be ambiguous.
        if !c[1].is_empty() && !c[3].is_empty() {
            return None;
        }
        match &symbol {
            Some(s) if *s != c[2] => return None,
            _ => symbol = Some(c[2].to_string()),
        }
        max_decimals = max_decimals.max(decimals(v));
    }
    Some(CurrencyOptions {
        precision: max_decimals.clamp(2, 8) as u8,
        symbol: symbol?,
        allow_negative: true,
    })
}

/// Digits are never worth more than ~15 significant figures in an f64.
fn short_number(v: &str) -> bool {
    v.chars().filter(char::is_ascii_digit).count() <= 15
}

fn select_choices(values: &[&str]) -> Option<Vec<SelectChoice>> {
    let mut order: Vec<&str> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for v in values {
        if v.chars().count() > 100 || v.contains(['\n', '\r']) {
            return None;
        }
        if seen.insert(v.to_lowercase()) {
            order.push(v);
            if order.len() > MAX_SELECT_CHOICES {
                return None;
            }
        }
    }
    // Every value must repeat on average, or it is free text.
    if values.len() < order.len() * 2 {
        return None;
    }
    Some(
        order
            .into_iter()
            .map(|name| SelectChoice {
                id: String::new(),
                name: name.to_string(),
                color: String::new(),
            })
            .collect(),
    )
}

fn text_kind(values: &[&str]) -> FieldKind {
    if values
        .iter()
        .any(|v| v.chars().count() > 255 || v.contains(['\n', '\r']))
    {
        FieldKind::LongText(Default::default())
    } else {
        FieldKind::SingleLineText(TextOptions::default())
    }
}

/// The field kind that fits every non-blank value of a column. `primary`
/// columns never become checkboxes (a primary field cannot be one).
pub fn infer_kind(cells: &[&str], primary: bool) -> FieldKind {
    let values: Vec<&str> = cells
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if values.is_empty() {
        return FieldKind::SingleLineText(TextOptions::default());
    }
    let candidate = || -> Option<FieldKind> {
        if !primary
            && values
                .iter()
                .all(|v| BOOLEAN_WORDS.contains(&v.to_lowercase().as_str()))
        {
            return Some(FieldKind::Checkbox(Default::default()));
        }
        if let Some(opts) = date_options(&values) {
            return Some(FieldKind::Date(opts));
        }
        if values.iter().all(|v| RE_PERCENT.is_match(v)) {
            let precision = values.iter().map(|v| decimals(v)).max().unwrap_or(0).min(8);
            return Some(FieldKind::Percent(NumberOptions {
                precision: precision as u8,
                ..NumberOptions::default()
            }));
        }
        if values
            .iter()
            .all(|v| RE_NUMBER.is_match(v) && short_number(v))
        {
            let precision = values.iter().map(|v| decimals(v)).max().unwrap_or(0);
            if precision <= 8 {
                return Some(FieldKind::Number(NumberOptions {
                    precision: precision as u8,
                    ..NumberOptions::default()
                }));
            }
        }
        if let Some(opts) = currency_options(&values) {
            return Some(FieldKind::Currency(opts));
        }
        if values.iter().all(|v| RE_EMAIL.is_match(v)) {
            return Some(FieldKind::Email(Default::default()));
        }
        if values.iter().all(|v| RE_URL.is_match(v)) {
            return Some(FieldKind::Url(Default::default()));
        }
        select_choices(&values).map(|choices| FieldKind::SingleSelect(SelectOptions { choices }))
    };
    let kind = candidate().unwrap_or_else(|| text_kind(&values));
    // The inferred type must accept every value as the importer will pass it.
    let probe = Field {
        id: "probe".into(),
        table_id: "probe".into(),
        name: "probe".into(),
        description: None,
        kind: kind.clone(),
    };
    let ctx = CellCtx::utc(chrono::Utc::now()).with_typecast(true);
    let ok = values
        .iter()
        .all(|v| normalize(&probe, &Json::String((*v).to_string()), &ctx).is_ok());
    if ok { kind } else { text_kind(&values) }
}

// ------------------------------------------------------------------ import

/// A CSV column mapped to a field.
#[derive(Debug, Clone)]
pub struct ImportColumn {
    pub column: usize,
    pub field: Field,
}

/// What an import did.
pub enum ImportOutcome {
    Imported {
        created: usize,
        outcomes: Vec<WriteOutcome>,
    },
    /// Nothing was written.
    Rejected {
        errors: Vec<ImportRowError>,
        /// More bad rows may exist beyond the ones listed.
        truncated: bool,
    },
}

/// Whether a field can receive CSV text.
pub fn importable(field: &Field) -> Result<(), String> {
    if field.field_type().is_computed() {
        return Err("it is computed".into());
    }
    match field.kind {
        FieldKind::Link(_) => Err("link fields cannot be imported from CSV".into()),
        FieldKind::User(_) => Err("user fields cannot be imported from CSV".into()),
        FieldKind::Attachment(_) => Err("attachments cannot be imported from CSV".into()),
        _ => Ok(()),
    }
}

fn new_record(columns: &[ImportColumn], row: &CsvRow) -> NewRecord {
    let mut values = std::collections::BTreeMap::new();
    for c in columns {
        let cell = &row.cells[c.column];
        if !cell.trim().is_empty() {
            values.insert(c.field.id.clone(), Json::String(cell.clone()));
        }
    }
    NewRecord { values }
}

fn exec(tx: &Transaction, sql: &str) -> AppResult<()> {
    tx.execute_batch(sql).map_err(AppError::from)
}

/// Create one record per row, all or nothing. See the module docs.
pub fn import_rows(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    columns: &[ImportColumn],
    rows: &[CsvRow],
) -> AppResult<ImportOutcome> {
    let live = records::live_count(tx, table_id)?;
    if live + rows.len() > limits::MAX_RECORDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "importing {} rows would exceed the limit of {} records per table",
            rows.len(),
            limits::MAX_RECORDS_PER_TABLE
        )));
    }
    exec(tx, "SAVEPOINT og_import")?;
    let result = import_in_savepoint(tx, ctx, table_id, columns, rows);
    match &result {
        Ok(ImportOutcome::Imported { .. }) => exec(tx, "RELEASE og_import")?,
        _ => {
            exec(tx, "ROLLBACK TO og_import")?;
            exec(tx, "RELEASE og_import")?;
        }
    }
    result
}

/// Collected while importing: the created outcomes and the bad rows.
struct Scan {
    outcomes: Vec<WriteOutcome>,
    errors: Vec<ImportRowError>,
    truncated: bool,
}

thread_local! {
    static CREATE_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Diagnostics (used by tests): how many `create_records` calls imports on
/// the current thread have made so far.
pub fn create_calls_on_this_thread() -> usize {
    CREATE_CALLS.with(std::cell::Cell::get)
}

/// Create `rows` in one savepoint. When that fails with a row problem the
/// rows are halved and each half retried, so finding `k` bad rows costs
/// about `2 k log2(n)` creates instead of replaying every row of the batch
/// one by one (which held the single writer for ages). Returns `true` when
/// the scan must stop because [`MAX_ROW_ERRORS`] was reached.
fn try_rows(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    columns: &[ImportColumn],
    rows: &[CsvRow],
    scan: &mut Scan,
) -> AppResult<bool> {
    exec(tx, "SAVEPOINT og_batch")?;
    let batch: Vec<NewRecord> = rows.iter().map(|r| new_record(columns, r)).collect();
    CREATE_CALLS.with(|c| c.set(c.get() + 1));
    match create_records(tx, ctx, table_id, batch, &CreateOpts::default()) {
        Ok(outcome) => {
            exec(tx, "RELEASE og_batch")?;
            scan.outcomes.push(outcome);
            Ok(false)
        }
        Err(AppError::BadRequest(message)) => {
            exec(tx, "ROLLBACK TO og_batch")?;
            exec(tx, "RELEASE og_batch")?;
            if let [row] = rows {
                scan.errors.push(ImportRowError {
                    row: row.number,
                    message,
                });
                if scan.errors.len() >= MAX_ROW_ERRORS {
                    scan.truncated = true;
                    return Ok(true);
                }
                return Ok(false);
            }
            let (left, right) = rows.split_at(rows.len() / 2);
            if try_rows(tx, ctx, table_id, columns, left, scan)? {
                return Ok(true);
            }
            try_rows(tx, ctx, table_id, columns, right, scan)
        }
        Err(other) => Err(other),
    }
}

fn import_in_savepoint(
    tx: &Transaction,
    ctx: &WriteCtx,
    table_id: &str,
    columns: &[ImportColumn],
    rows: &[CsvRow],
) -> AppResult<ImportOutcome> {
    let mut scan = Scan {
        outcomes: Vec::new(),
        errors: Vec::new(),
        truncated: false,
    };
    for chunk in rows.chunks(limits::MAX_RECORDS_PER_BATCH) {
        if try_rows(tx, ctx, table_id, columns, chunk, &mut scan)? {
            break;
        }
    }
    if scan.errors.is_empty() {
        let created = rows.len();
        Ok(ImportOutcome::Imported {
            created,
            outcomes: scan.outcomes,
        })
    } else {
        // The caller rolls everything back; whether more rows would have
        // failed is unknown when the scan stopped early.
        Ok(ImportOutcome::Rejected {
            errors: scan.errors,
            truncated: scan.truncated,
        })
    }
}

/// Map `{csv column name -> field id | null}` onto the table's fields.
/// Keys are header names (or zero-based column numbers when the file has no
/// header). Unknown columns, unknown or non-importable fields and two
/// columns for one field are errors.
pub fn resolve_mapping(
    csv: &Csv,
    mapping: &HashMap<String, Option<String>>,
    fields: &[Field],
) -> AppResult<Vec<ImportColumn>> {
    let by_id: HashMap<&str, &Field> = fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let key_of = |i: usize| -> String {
        if csv.has_header {
            csv.header[i].clone()
        } else {
            i.to_string()
        }
    };
    let keys: HashMap<String, usize> = (0..csv.columns()).map(|i| (key_of(i), i)).collect();
    let mut chosen: Vec<ImportColumn> = Vec::new();
    let mut used: HashSet<&str> = HashSet::new();
    let mut entries: Vec<(&String, &Option<String>)> = mapping.iter().collect();
    entries.sort_by_key(|(k, _)| keys.get(*k).copied().unwrap_or(usize::MAX));
    for (key, target) in entries {
        let Some(&column) = keys.get(key) else {
            return Err(AppError::bad_request(format!(
                "the file has no column \"{key}\""
            )));
        };
        let Some(field_id) = target else { continue };
        let field = by_id
            .get(field_id.as_str())
            .ok_or_else(|| AppError::bad_request(format!("unknown field \"{field_id}\"")))?;
        importable(field).map_err(|why| {
            AppError::bad_request(format!(
                "field \"{}\" cannot be imported: {why}",
                field.name
            ))
        })?;
        if !used.insert(field_id.as_str()) {
            return Err(AppError::bad_request(format!(
                "more than one column is mapped to field \"{}\"",
                field.name
            )));
        }
        chosen.push(ImportColumn {
            column,
            field: (*field).clone(),
        });
    }
    if chosen.is_empty() {
        return Err(AppError::bad_request("map at least one column to a field"));
    }
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(values: &[&str]) -> &'static str {
        match infer_kind(values, false) {
            FieldKind::SingleLineText(_) => "text",
            FieldKind::LongText(_) => "long_text",
            FieldKind::Number(_) => "number",
            FieldKind::Currency(_) => "currency",
            FieldKind::Percent(_) => "percent",
            FieldKind::Checkbox(_) => "checkbox",
            FieldKind::Date(_) => "date",
            FieldKind::Email(_) => "email",
            FieldKind::Url(_) => "url",
            FieldKind::SingleSelect(_) => "select",
            _ => "other",
        }
    }

    #[test]
    fn parses_bom_crlf_quotes_and_ragged_rows() {
        let data = "\u{FEFF}name,note,n\r\n\"Smith, J\",\"line1\nline2\",1\r\nplain,\"say \"\"hi\"\"\"\r\n\r\n,,\r\nlast,x,3,extra\r\n";
        let csv = parse(data.as_bytes(), true).unwrap();
        assert_eq!(csv.header, ["name", "note", "n", "Column 4"]);
        assert_eq!(csv.rows.len(), 3);
        assert_eq!(csv.rows[0].cells, ["Smith, J", "line1\nline2", "1", ""]);
        assert_eq!(csv.rows[1].cells, ["plain", "say \"hi\"", "", ""]);
        // The blank row is dropped but numbering still counts it.
        assert_eq!(
            csv.rows.iter().map(|r| r.number).collect::<Vec<_>>(),
            [2, 3, 6]
        );
        assert_eq!(csv.rows[2].cells, ["last", "x", "3", "extra"]);
    }

    #[test]
    fn row_numbers_count_blank_lines_and_quoted_line_breaks() {
        // Quoted line breaks stay inside one row; every blank line is a row.
        let text = "h1,h2\n\n\"a\nb\",x\n\n\n\"\",y\n";
        assert_eq!(record_numbers(text, b','), [1, 3, 6]);
        // CR, LF and CRLF all end a row.
        assert_eq!(record_numbers("a\rb\r\n\rc\nd", b','), [1, 2, 4, 5]);
        // A quote inside an unquoted field is literal, so it opens no quotes.
        assert_eq!(record_numbers("5\" pipe,x\nnext,y\n", b','), [1, 2]);
        // `""` escapes and delimiters in quotes do not confuse the scan.
        assert_eq!(record_numbers("\"a \"\"q,\"\" b\",c\n\nz\n", b','), [1, 3]);
        assert_eq!(record_numbers("", b','), Vec::<usize>::new());
        assert_eq!(record_numbers("\n\n", b','), Vec::<usize>::new());
        // The scan agrees with the reader about how many rows there are.
        for data in ["a,b\n\n1,2\n\n", "a;b\r\n1;\"x\r\ny\"\r\n", "a\n\"\"\n \n"] {
            let csv = parse(data.as_bytes(), false).unwrap();
            let numbers = record_numbers(data, detect_delimiter(data));
            let mut seen: Vec<usize> = vec![];
            for row in &csv.rows {
                seen.push(row.number);
            }
            assert!(seen.iter().all(|n| numbers.contains(n)), "{data:?}");
        }
    }

    #[test]
    fn detects_semicolon_and_tab_and_latin1() {
        let csv = parse(b"a;b\n1;2\n", true).unwrap();
        assert_eq!(csv.header, ["a", "b"]);
        assert_eq!(csv.rows[0].cells, ["1", "2"]);
        let csv = parse(b"a\tb\n1\t2\n", true).unwrap();
        assert_eq!(csv.rows[0].cells, ["1", "2"]);
        // A comma inside quotes does not make the delimiter a comma.
        let csv = parse(b"\"a,b\";c\n1;2\n", true).unwrap();
        assert_eq!(csv.header, ["a,b", "c"]);
        let csv = parse(b"name\ncaf\xe9\n", true).unwrap();
        assert_eq!(csv.rows[0].cells, ["café"]);
        assert!(parse(&[0xFF, 0xFE, b'a', 0], true).is_err());
    }

    #[test]
    fn header_names_are_cleaned_and_unique() {
        let csv = parse(b"a,,A, a \n1,2,3,4\n", true).unwrap();
        assert_eq!(csv.header, ["a", "Column 2", "A 2", "a 3"]);
        let csv = parse(b"1,2\n3,4\n", false).unwrap();
        assert_eq!(csv.header, ["Column 1", "Column 2"]);
        assert_eq!(csv.rows.len(), 2);
        assert_eq!(csv.rows[0].number, 1);
    }

    #[test]
    fn rejects_empty_and_oversized_files() {
        assert!(parse(b"", true).is_err());
        assert!(parse(b"\n\n", true).is_err());
        let wide = vec!["x"; MAX_COLUMNS + 1].join(",");
        assert!(parse(wide.as_bytes(), true).is_err());
        let ok = vec!["x"; MAX_COLUMNS].join(",");
        assert!(parse(ok.as_bytes(), true).is_ok());
        let mut many = String::from("a\n");
        many.push_str(&"1\n".repeat(MAX_ROWS + 1));
        assert!(parse(many.as_bytes(), true).is_err());
    }

    #[test]
    fn guards_formula_injection_but_not_numbers() {
        for bad in ["=1+1", "+cmd", "-cmd", "@SUM(A1)", "\tx", "\rx"] {
            assert_eq!(guard_cell(bad.to_string(), false), format!("'{bad}"));
        }
        assert_eq!(guard_cell("-5".into(), true), "-5");
        assert_eq!(guard_cell("-12.50%".into(), true), "-12.50%");
        // A numeric field's text that is not a plain number is still guarded.
        assert_eq!(guard_cell("-=1".into(), true), "'-=1");
        assert_eq!(guard_cell("-5".into(), false), "'-5");
        assert_eq!(guard_cell("safe".into(), false), "safe");
        assert_eq!(guard_cell(String::new(), false), "");
    }

    #[test]
    fn infers_column_types() {
        assert_eq!(kind_of(&["1", "2.5", "-3", ""]), "number");
        assert_eq!(kind_of(&["12%", "7.5 %"]), "percent");
        assert_eq!(kind_of(&["$1,200.50", "$3"]), "currency");
        assert_eq!(kind_of(&["$1", "€2"]), "text");
        assert_eq!(kind_of(&["true", "No", "yes", ""]), "checkbox");
        assert_eq!(kind_of(&["2026-03-01", "2026-12-31"]), "date");
        assert_eq!(kind_of(&["2026-03-01T10:00:00Z", "2026-03-02"]), "date");
        assert_eq!(kind_of(&["03/25/2026", "01/02/2026"]), "date");
        assert_eq!(kind_of(&["25/03/2026", "01/02/2026"]), "date");
        assert_eq!(kind_of(&["25/03/2026", "03/25/2026"]), "text");
        assert_eq!(kind_of(&["a@b.co", "c@d.org"]), "email");
        assert_eq!(kind_of(&["https://a.b/c", "http://x.y"]), "url");
        assert_eq!(kind_of(&[]), "text");
        assert_eq!(kind_of(&["", " "]), "text");
        // Identifiers that look like numbers stay text.
        assert_eq!(kind_of(&["02134", "10001"]), "text");
        assert_eq!(kind_of(&["12345678901234567890"]), "text");
        assert_eq!(kind_of(&["1.123456789"]), "text");
        // Years alone are numbers, not dates.
        assert_eq!(kind_of(&["2026", "2027"]), "number");
        assert_eq!(kind_of(&["+1 555 0100", "+1 555 0101"]), "text");
    }

    #[test]
    fn infers_selects_for_repeating_few_values_and_long_text() {
        let col = [
            "Todo", "Done", "todo", "Todo", "Done", "Doing", "Doing", "Done",
        ];
        match infer_kind(&col, false) {
            FieldKind::SingleSelect(o) => {
                let names: Vec<_> = o.choices.iter().map(|c| c.name.as_str()).collect();
                assert_eq!(names, ["Todo", "Done", "Doing"]);
            }
            other => panic!("{other:?}"),
        }
        // All distinct: free text.
        assert_eq!(kind_of(&["a b", "c d", "e f"]), "text");
        let long = "x".repeat(300);
        assert_eq!(kind_of(&[long.as_str(), "short"]), "long_text");
        assert_eq!(kind_of(&["line1\nline2", "b"]), "long_text");
        // Checkbox words as primary stay text/select, never checkbox.
        assert!(!matches!(
            infer_kind(&["yes", "no", "yes", "no"], true),
            FieldKind::Checkbox(_)
        ));
    }

    #[test]
    fn inferred_precision_follows_the_data() {
        match infer_kind(&["1.5", "2.25", "3"], false) {
            FieldKind::Number(o) => assert_eq!(o.precision, 2),
            other => panic!("{other:?}"),
        }
        match infer_kind(&["$1", "$2"], false) {
            FieldKind::Currency(o) => assert_eq!((o.precision, o.symbol.as_str()), (2, "$")),
            other => panic!("{other:?}"),
        }
        match infer_kind(&["12.5%", "3%"], false) {
            FieldKind::Percent(o) => assert_eq!(o.precision, 1),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn mapping_rules() {
        let csv = parse(b"a,b,c\n1,2,3\n", true).unwrap();
        let mk = |id: &str, kind: FieldKind| Field {
            id: id.into(),
            table_id: "t".into(),
            name: id.into(),
            description: None,
            kind,
        };
        let fields = vec![
            mk("fa", FieldKind::SingleLineText(TextOptions::default())),
            mk("fb", FieldKind::Number(NumberOptions::default())),
            mk("auto", FieldKind::Autonumber(Default::default())),
        ];
        let map = |pairs: &[(&str, Option<&str>)]| -> HashMap<String, Option<String>> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.map(str::to_string)))
                .collect()
        };
        let ok = resolve_mapping(
            &csv,
            &map(&[("a", Some("fa")), ("b", Some("fb")), ("c", None)]),
            &fields,
        )
        .unwrap();
        assert_eq!(ok.len(), 2);
        assert_eq!((ok[0].column, ok[1].column), (0, 1));
        assert!(resolve_mapping(&csv, &map(&[("zzz", Some("fa"))]), &fields).is_err());
        assert!(resolve_mapping(&csv, &map(&[("a", Some("nope"))]), &fields).is_err());
        assert!(resolve_mapping(&csv, &map(&[("a", Some("auto"))]), &fields).is_err());
        assert!(
            resolve_mapping(&csv, &map(&[("a", Some("fa")), ("b", Some("fa"))]), &fields).is_err()
        );
        assert!(resolve_mapping(&csv, &map(&[("a", None)]), &fields).is_err());
        assert!(resolve_mapping(&csv, &map(&[]), &fields).is_err());
        let headless = parse(b"1,2\n", false).unwrap();
        assert!(resolve_mapping(&headless, &map(&[("1", Some("fb"))]), &fields).is_ok());
        assert!(resolve_mapping(&headless, &map(&[("Column 1", Some("fb"))]), &fields).is_err());
    }
}
