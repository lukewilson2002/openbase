//! Files and bulk data: upload an attachment (from base64 or a public URL), export a view as
//! CSV text, import CSV text into a table or as a new table.
//!
//! Uploads and imports go through the REST API as the caller (same limits, sniffing, all-or-
//! nothing imports, record history and automations). URLs are fetched with the automations'
//! SSRF guard ([`crate::automations::download`]).

use base64::Engine;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::McpCtx;
use super::api::{self, ApiCall};
use super::resolve::{field_lookup, find_table, find_view, load_schema};
use super::support::*;
use super::tools::{ToolDef, ToolResult};
use crate::automations::download;

/// CSV text returned by `export_csv` is cut at this many bytes (the model's context is the
/// limit, not the server's).
const CSV_CAP: usize = 80_000;
/// Rows shown in an import failure.
const MAX_ROW_ERRORS: usize = 10;

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef::new(
            "upload_attachment",
            "Upload a file",
            "Upload a file to a base from base64 content or a public URL (the server fetches it, public http(s) addresses only) and get back an attachment reference. Put the reference into an attachment field with create_records/update_records, e.g. {\"Files\": [<reference>]}. The size limit is the server's upload limit (5 MB by default). Needs the editor role.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "filename": string("File name, e.g. invoice.pdf (required with content_base64; taken from the URL otherwise)."),
                    "content_base64": string("The file's bytes, base64-encoded."),
                    "url": string("Public http(s) URL to download the file from instead."),
                }),
                &["base_id"],
            ),
        )
        .write(),
        ToolDef::new(
            "export_csv",
            "Export a view as CSV",
            "Export a view as CSV text exactly as the web app's export does: the view's visible fields in view order, its filter, sort and grouping applied, dates in your time zone. Long exports are cut at about 80 KB at a row boundary with a note giving the totals; use a view with a filter, or query_view with offset, for the rest.",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "view": string("View name or id."),
                    "table": string("Table name or id; needed only when several tables have a view with this name."),
                }),
                &["base_id", "view"],
            ),
        ),
        ToolDef::new(
            "import_csv",
            "Import CSV",
            "Import CSV text into an existing table (rows become records; columns are matched to fields by header name, or by `mapping`) or, with new_table_name, create a new table from the CSV (fields and their types are inferred; the first column becomes the primary field; it starts with one grid view, so set up the others its purpose calls for). All or nothing: if any row is rejected nothing is written and the problem rows are listed. Values are read leniently like pasted text. Limits: 20 MB, 100,000 rows. Needs the editor role (creator for a new table).",
            object(
                json!({
                    "base_id": string(BASE_ID),
                    "csv_text": string("The CSV content, first row = header (unless has_header is false)."),
                    "table": string("Existing table (name or id) to add the rows to."),
                    "new_table_name": string("Create a new table with this name instead."),
                    "mapping": free_object("Existing table only: {\"CSV column\": \"Field name\" | null (skip)}. Columns not listed are matched by name. With has_header=false the keys are zero-based column numbers (\"0\", \"1\", ...)."),
                    "has_header": boolean("Whether the first row is a header (default true)."),
                }),
                &["base_id", "csv_text"],
            ),
        )
        .write(),
    ]
}

pub async fn run(ctx: &McpCtx, name: &str, args: &Value) -> Option<ToolResult> {
    macro_rules! with_args {
        ($t:ty, $f:expr) => {
            Some(match parse::<$t>(args.clone()) {
                Ok(a) => $f(ctx, a).await,
                Err(e) => e,
            })
        };
    }
    match name {
        "upload_attachment" => with_args!(UploadArgs, upload_attachment),
        "export_csv" => with_args!(ExportArgs, export_csv),
        "import_csv" => with_args!(ImportArgs, import_csv),
        _ => None,
    }
}

// ------------------------------------------------------------------------------- upload

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadArgs {
    base_id: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_base64: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A file name for a download: the last path segment of the URL.
fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let seg = parsed.path_segments()?.rev().find(|s| !s.is_empty())?;
    Some(api::percent_decode(seg))
}

/// Keep a file name safe inside a multipart header and a download URL.
fn clean_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '"' | '\\' | '/' | '\r' | '\n') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().chars().take(200).collect::<String>();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

async fn upload_attachment(ctx: &McpCtx, a: UploadArgs) -> ToolResult {
    let max = ctx.state.config.max_upload_bytes();
    let (bytes, content_type, filename) = match (&a.content_base64, &a.url) {
        (Some(_), Some(_)) => {
            return ToolResult::error("Give either content_base64 or url, not both.");
        }
        (None, None) => {
            return ToolResult::error(
                "Give the file as content_base64 (with filename) or as a public url.",
            );
        }
        (Some(b64), None) => {
            let Some(name) = a.filename.as_deref().filter(|n| !n.trim().is_empty()) else {
                return ToolResult::error("filename is required with content_base64.");
            };
            // Cheap size check before decoding (4 base64 characters carry 3 bytes).
            if (b64.len() as u64 / 4) * 3 > max.saturating_add(3) {
                return ToolResult::error(format!(
                    "The file is larger than the upload limit of {} MB.",
                    ctx.state.config.max_upload_mb
                ));
            }
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                Ok(b) => b,
                Err(e) => {
                    return ToolResult::error(format!(
                        "content_base64 is not valid base64 ({e}). Use standard base64 without line breaks."
                    ));
                }
            };
            (bytes, None, clean_filename(name))
        }
        (None, Some(url)) => {
            let fetched =
                download::download(url, ctx.state.config.allow_private_webhooks, max).await;
            match fetched {
                Ok(d) => {
                    let name = a
                        .filename
                        .as_deref()
                        .filter(|n| !n.trim().is_empty())
                        .map(str::to_string)
                        .or_else(|| filename_from_url(url))
                        .unwrap_or_else(|| "file".into());
                    (d.bytes, d.content_type, clean_filename(&name))
                }
                Err(e) => {
                    return ToolResult::error(format!("Could not fetch the URL: {}.", e.message));
                }
            }
        }
    };
    if bytes.is_empty() {
        return ToolResult::error("The file is empty.");
    }
    if bytes.len() as u64 > max {
        return ToolResult::error(format!(
            "The file is larger than the upload limit of {} MB.",
            ctx.state.config.max_upload_mb
        ));
    }
    let mut file = Map::new();
    file.insert("filename".into(), json!(filename));
    file.insert(
        "content_base64".into(),
        json!(base64::engine::general_purpose::STANDARD.encode(&bytes)),
    );
    if let Some(ct) = content_type.filter(|c| c.chars().all(|ch| ch.is_ascii_graphic())) {
        file.insert("content_type".into(), json!(ct));
    }
    let body = json!({ "multipart": { "file": Value::Object(file) } });
    match fetch(
        ctx,
        "POST",
        &base_path(&a.base_id, "/attachments"),
        None,
        Some(body),
    )
    .await
    {
        Ok(reference) => ToolResult::ok(json!({
            "attachment": reference,
            "usage": "Write it into an attachment field: create_records / update_records with {\"<field name>\": [{\"id\": \"<attachment id>\"}]}.",
        })),
        Err(e) => e,
    }
}

// -------------------------------------------------------------------------------- export

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportArgs {
    base_id: String,
    view: String,
    #[serde(default)]
    table: Option<String>,
}

/// `text` without a leading byte order mark.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Number of records in `csv` (header included), or `None` when it does not parse.
fn count_records(csv: &str) -> Option<usize> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(csv.as_bytes());
    let mut n = 0;
    for rec in reader.records() {
        rec.ok()?;
        n += 1;
    }
    Some(n)
}

/// Cut `csv` back to its last complete row.
fn cut_to_rows(csv: &str) -> &str {
    let mut end = csv.len();
    // Rows end with CRLF; step back to a row end that is not inside a quoted cell.
    for _ in 0..200 {
        match csv[..end].rfind("\r\n") {
            Some(i) => {
                let candidate = &csv[..i + 2];
                // Inside a quoted cell the number of quote characters so far is odd (a quote in a
                // cell is written doubled), so an even count means the cut is between rows.
                if candidate.matches('"').count() % 2 == 0 {
                    return candidate;
                }
                end = i;
            }
            None => return "",
        }
    }
    ""
}

async fn export_csv(ctx: &McpCtx, a: ExportArgs) -> ToolResult {
    let schema = match load_schema(ctx, &a.base_id).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let (table, view) = match find_view(&schema, a.table.as_deref(), &a.view) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let path = format!("/api/views/{}/export.csv", encode_segment(&view.id));
    let res = match api::execute_with(
        ctx,
        ApiCall {
            method: "GET".into(),
            path,
            query: None,
            body: None,
        },
        CSV_CAP,
        true,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return ToolResult::error(e),
    };
    if !res.ok() {
        return api_failure(ctx, &res);
    }
    let raw = res.text.clone().unwrap_or_default();
    let full = strip_bom(&raw);
    let shown = if res.truncated {
        cut_to_rows(full)
    } else {
        full
    };
    let rows = count_records(shown).unwrap_or(0).saturating_sub(1);
    // The exact total, from the same view query the app uses (a count-only request).
    let total = match fetch(
        ctx,
        "POST",
        &format!("/api/views/{}/query", encode_segment(&view.id)),
        None,
        Some(json!({ "limit": 0 })),
    )
    .await
    {
        Ok(v) => v["total"].as_u64().map(|n| n as usize),
        Err(_) => None,
    };
    let truncated = res.truncated || total.is_some_and(|t| t > rows);
    let mut text = shown.to_string();
    if truncated {
        text.push_str(&format!(
            "\n[cut: {rows} of {} rows shown. Use query_view with offset for the rest, or export a view with a narrower filter.]",
            total.map(|t| t.to_string()).unwrap_or_else(|| "more".into())
        ));
    }
    ToolResult {
        text,
        structured: Some(json!({
            "view": view.name,
            "table": table.name,
            "rows": rows,
            "total_rows": total,
            "truncated": truncated,
        })),
        is_error: false,
    }
}

// -------------------------------------------------------------------------------- import

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportArgs {
    base_id: String,
    csv_text: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    new_table_name: Option<String>,
    #[serde(default)]
    mapping: Option<Value>,
    #[serde(default)]
    has_header: Option<bool>,
}

/// An import the server rejected (`422 import_failed` with the problem rows).
fn import_failure(ctx: &McpCtx, res: &api::ApiResponse) -> ToolResult {
    let rows = res
        .body
        .as_ref()
        .and_then(|b| b["error"]["rows"].as_array())
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return api_failure(ctx, res);
    }
    let shown: Vec<String> = rows
        .iter()
        .take(MAX_ROW_ERRORS)
        .map(|r| {
            format!(
                "row {}: {}",
                r["row"],
                r["message"].as_str().unwrap_or("rejected")
            )
        })
        .collect();
    let more = rows.len().saturating_sub(MAX_ROW_ERRORS);
    ToolResult::error(format!(
        "The import was rejected and nothing was written. {}{}",
        shown.join("; "),
        if more > 0 {
            format!("; and {more} more rows")
        } else {
            String::new()
        }
    ))
}

async fn import_csv(ctx: &McpCtx, a: ImportArgs) -> ToolResult {
    if a.csv_text.trim().is_empty() {
        return ToolResult::error("csv_text is empty.");
    }
    let mut parts = Map::new();
    parts.insert(
        "file".into(),
        json!({ "filename": "import.csv", "text": a.csv_text, "content_type": "text/csv" }),
    );
    if let Some(h) = a.has_header {
        parts.insert("has_header".into(), json!(h));
    }
    let path = match (&a.table, &a.new_table_name) {
        (Some(_), Some(_)) => {
            return ToolResult::error("Give either table or new_table_name, not both.");
        }
        (None, None) => {
            return ToolResult::error(
                "Say where the rows go: table (an existing table) or new_table_name (create one).",
            );
        }
        (None, Some(name)) => {
            if a.mapping.is_some() {
                return ToolResult::error(
                    "mapping applies to an existing table; a new table gets one field per column.",
                );
            }
            parts.insert("name".into(), json!(name));
            base_path(&a.base_id, "/import")
        }
        (Some(table), None) => {
            let schema = match load_schema(ctx, &a.base_id).await {
                Ok(s) => s,
                Err(e) => return e,
            };
            let table = match find_table(&schema, table) {
                Ok(t) => t,
                Err(e) => return e,
            };
            if let Some(mapping) = &a.mapping {
                let Some(map) = mapping.as_object() else {
                    return ToolResult::error(
                        "mapping must be an object {\"CSV column\": \"Field name\" | null}.",
                    );
                };
                let mut by_id = Map::new();
                for (column, target) in map {
                    match target {
                        Value::Null => {
                            by_id.insert(column.clone(), Value::Null);
                        }
                        Value::String(f) => match field_lookup(table, f) {
                            Ok(field) => {
                                by_id.insert(column.clone(), json!(field.id));
                            }
                            Err(e) => return ToolResult::error(format!("mapping: {e}")),
                        },
                        _ => {
                            return ToolResult::error(format!(
                                "mapping: the target of column '{column}' must be a field name or null."
                            ));
                        }
                    }
                }
                parts.insert("mapping".into(), json!(Value::Object(by_id).to_string()));
            }
            table_path(&table.id, "/import")
        }
    };
    let res = match call_api(
        ctx,
        "POST",
        &path,
        None,
        Some(json!({ "multipart": Value::Object(parts) })),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return e,
    };
    if !res.ok() {
        return import_failure(ctx, &res);
    }
    let mut out = res.body.unwrap_or(Value::Null);
    if let Some(fields) = out.get("fields").and_then(Value::as_array)
        && !fields.is_empty()
    {
        out["note"] = json!("A new table was created; get_base_schema shows it.");
        out["views_note"] = json!(super::views::NEW_TABLE_VIEWS);
    }
    ToolResult::ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_is_cut_at_row_boundaries() {
        let csv = "Name,Notes\r\nAda,\"multi\r\nline\"\r\nBob,x\r\nCarl,partial";
        assert_eq!(count_records("Name\r\nA\r\n"), Some(2));
        // Cut inside the last row: that row is dropped.
        assert_eq!(
            cut_to_rows(csv),
            "Name,Notes\r\nAda,\"multi\r\nline\"\r\nBob,x\r\n"
        );
        // Cut inside a quoted cell: stepping back until the text parses.
        let inside = "Name,Notes\r\nAda,x\r\nBob,\"multi\r\nli";
        assert_eq!(cut_to_rows(inside), "Name,Notes\r\nAda,x\r\n");
        assert_eq!(cut_to_rows("no line end"), "");
    }

    #[test]
    fn file_names_are_cleaned() {
        assert_eq!(clean_filename("a/b\\c\"d.txt"), "a_b_c_d.txt");
        assert_eq!(clean_filename("   "), "file");
        assert_eq!(
            filename_from_url("https://x.test/files/My%20Doc.pdf?x=1").as_deref(),
            Some("My Doc.pdf")
        );
        assert_eq!(filename_from_url("https://x.test/"), None);
    }
}
