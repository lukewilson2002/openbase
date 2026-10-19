//! Cell values in Airtable's wire shapes.
//!
//! [`render`] turns internal [`Record`]s (values keyed by field id in the
//! internal JSON forms) into [`V1Record`]s:
//!
//! | field                          | value                                                    |
//! |--------------------------------|----------------------------------------------------------|
//! | text, email, url, phone        | string                                                   |
//! | barcode                        | `{"text"}`                                               |
//! | number, currency, percent (fraction), duration (seconds), rating, autonumber, count | number |
//! | checkbox                       | `true`, absent when unchecked                            |
//! | single / multiple select       | choice name / array of names                             |
//! | date / date with time          | `YYYY-MM-DD` / ISO 8601 UTC with milliseconds            |
//! | attachments                    | `[{id, url, filename, size, type, width?, height?, thumbnails?}]` |
//! | linked records                 | array of record ids                                      |
//! | collaborators, created/modified by | `{id, email, name}` (array for multiple)             |
//! | formula, lookup, rollup        | the materialized value                                   |
//! | button                         | `{label, url}`                                           |
//!
//! Empty cells are omitted, unless `include_empty` asks for them as `null`.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use ob_core::api::records::Record;
use ob_core::api::v1::V1Record;
use ob_core::field::{Field, FieldKind};
use ob_core::value::ResultType;
use rusqlite::Connection;
use serde_json::{Map, Value as Json, json};

use crate::store::attachments;

/// Longest side of the stored thumbnail (see `api::attachments`).
const THUMB_SIZE: u32 = crate::previews::THUMB_SIZE;

/// How to render a batch of records.
pub struct RenderOpts<'a> {
    /// Key `fields` by field id instead of field name.
    pub by_id: bool,
    /// Only these field ids (the `fields[]` parameter); `None` = all.
    pub only: Option<&'a HashSet<String>>,
    /// The configured public URL, for absolute attachment URLs.
    pub public_url: &'a str,
    /// Render linked records as `{id, name}` (the linked record's primary text) instead of
    /// bare ids. Airtable's shape is ids only; the MCP tools ask for names too.
    pub link_names: bool,
    /// Return a field with no value as `null` instead of leaving it out, so a client can infer
    /// the columns from the records. Airtable omits empty fields; this is opt-in.
    pub include_empty: bool,
}

struct Cx<'a> {
    conn: &'a Connection,
    public_url: &'a str,
    link_names: bool,
    users: HashMap<String, Option<Json>>,
}

impl Cx<'_> {
    fn user(&mut self, id: &str) -> Option<Json> {
        let conn = self.conn;
        self.users
            .entry(id.to_string())
            .or_insert_with(|| {
                conn.query_row(
                    "SELECT id, email, name FROM users WHERE id = ?1",
                    [id],
                    |r| {
                        Ok(json!({
                            "id": r.get::<_, String>(0)?,
                            "email": r.get::<_, String>(1)?,
                            "name": r.get::<_, String>(2)?,
                        }))
                    },
                )
                .ok()
            })
            .clone()
    }
}

/// Render `records` of a table with `fields`.
pub fn render(
    conn: &Connection,
    fields: &[Field],
    records: Vec<Record>,
    opts: &RenderOpts,
) -> Vec<V1Record> {
    let mut cx = Cx {
        conn,
        public_url: opts.public_url,
        link_names: opts.link_names,
        users: HashMap::new(),
    };
    records
        .into_iter()
        .map(|rec| {
            let mut out: BTreeMap<String, Json> = BTreeMap::new();
            for f in fields {
                if opts.only.is_some_and(|o| !o.contains(&f.id)) {
                    continue;
                }
                let rendered = rec.values.get(&f.id).and_then(|v| cell(&mut cx, f, v));
                let Some(j) = rendered.or(opts.include_empty.then_some(Json::Null)) else {
                    continue;
                };
                let key = if opts.by_id { &f.id } else { &f.name };
                out.insert(key.clone(), j);
            }
            V1Record {
                id: rec.id,
                created_time: iso(rec.created_at),
                fields: out,
            }
        })
        .collect()
}

/// ISO 8601 UTC with milliseconds.
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// An RFC 3339 instant re-formatted with milliseconds in UTC; anything else
/// is returned unchanged.
fn instant(s: &str) -> String {
    DateTime::parse_from_rfc3339(s).map_or_else(
        |_| s.to_string(),
        |d| {
            d.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        },
    )
}

fn non_empty_str(v: &Json) -> Option<Json> {
    v.as_str().filter(|s| !s.is_empty()).map(|s| json!(s))
}

fn string_items(v: &Json) -> Vec<&str> {
    match v {
        Json::String(s) => vec![s.as_str()],
        Json::Array(a) => a.iter().filter_map(Json::as_str).collect(),
        _ => Vec::new(),
    }
}

fn non_empty_array(items: Vec<Json>) -> Option<Json> {
    (!items.is_empty()).then_some(Json::Array(items))
}

fn cell(cx: &mut Cx, field: &Field, v: &Json) -> Option<Json> {
    if v.is_null() {
        return None;
    }
    match &field.kind {
        FieldKind::SingleLineText(_)
        | FieldKind::LongText(_)
        | FieldKind::Email(_)
        | FieldKind::Url(_)
        | FieldKind::Phone(_) => non_empty_str(v),
        FieldKind::Barcode(_) => non_empty_str(v).map(|s| json!({ "text": s })),
        FieldKind::Number(_)
        | FieldKind::Currency(_)
        | FieldKind::Percent(_)
        | FieldKind::Duration(_)
        | FieldKind::Rating(_)
        | FieldKind::Autonumber(_)
        | FieldKind::Count(_) => v.is_number().then(|| v.clone()),
        FieldKind::Checkbox(_) => (v == &Json::Bool(true)).then_some(Json::Bool(true)),
        FieldKind::SingleSelect(o) => {
            let id = v.as_str()?;
            o.choices.iter().find(|c| c.id == id).map(|c| json!(c.name))
        }
        FieldKind::MultipleSelect(o) => non_empty_array(
            string_items(v)
                .into_iter()
                .filter_map(|id| o.choices.iter().find(|c| c.id == id))
                .map(|c| json!(c.name))
                .collect(),
        ),
        FieldKind::Date(o) => {
            let s = v.as_str().filter(|s| !s.is_empty())?;
            Some(json!(if o.include_time {
                instant(s)
            } else {
                s.to_string()
            }))
        }
        FieldKind::CreatedTime(_) | FieldKind::LastModifiedTime(_) => {
            non_empty_str(v).map(|s| json!(instant(s.as_str().unwrap_or_default())))
        }
        FieldKind::Attachment(_) => {
            let items = v.as_array()?;
            non_empty_array(
                items
                    .iter()
                    .filter_map(|a| attachment(cx, a))
                    .collect::<Vec<_>>(),
            )
        }
        FieldKind::Link(_) => non_empty_array(
            v.as_array()?
                .iter()
                .filter_map(|r| {
                    let id = r.get("id").and_then(Json::as_str)?;
                    Some(if cx.link_names {
                        json!({ "id": id, "name": r.get("name").and_then(Json::as_str).unwrap_or(id) })
                    } else {
                        json!(id)
                    })
                })
                .collect(),
        ),
        FieldKind::User(o) => {
            let users: Vec<Json> = string_items(v)
                .into_iter()
                .filter_map(|id| cx.user(id))
                .collect();
            if o.multiple {
                non_empty_array(users)
            } else {
                users.into_iter().next()
            }
        }
        FieldKind::CreatedBy(_) | FieldKind::LastModifiedBy(_) => cx.user(v.as_str()?),
        FieldKind::Formula(o) => computed(v, &o.result_type),
        FieldKind::Rollup(o) => computed(v, &o.result_type),
        FieldKind::Lookup(o) => computed(v, &o.result_type),
        FieldKind::Button(o) => {
            let url = non_empty_str(v)?;
            Some(json!({ "label": o.label, "url": url }))
        }
    }
}

/// A materialized computed value: empty results are omitted, instants get
/// millisecond precision, everything else passes through.
fn computed(v: &Json, ty: &ResultType) -> Option<Json> {
    match v {
        Json::Null => None,
        Json::String(s) if s.is_empty() => None,
        Json::Array(a) if a.is_empty() => None,
        Json::String(s) if *ty == ResultType::DateTime => Some(json!(instant(s))),
        other => Some(other.clone()),
    }
}

/// The size a thumbnail of a `w` x `h` image is stored at (fit within
/// [`THUMB_SIZE`], keeping the aspect ratio).
pub fn thumbnail_size(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    let ratio = (f64::from(THUMB_SIZE) / f64::from(w)).min(f64::from(THUMB_SIZE) / f64::from(h));
    let scale = |n: u32| ((f64::from(n) * ratio).round() as u32).max(1);
    (scale(w), scale(h))
}

/// The absolute URL of an attachment download (`/api/attachments/{id}/{name}`).
pub fn attachment_url(public_url: &str, id: &str, filename: &str, thumb: bool) -> String {
    let fallback = || {
        let base = public_url.trim_end_matches('/');
        if thumb {
            format!("{base}/api/attachments/{id}/thumb")
        } else {
            format!("{base}/api/attachments/{id}/file")
        }
    };
    let Ok(mut url) = url::Url::parse(public_url) else {
        return fallback();
    };
    {
        let Ok(mut segments) = url.path_segments_mut() else {
            return fallback();
        };
        segments.pop_if_empty().extend(["api", "attachments", id]);
        segments.push(if thumb { "thumb" } else { filename });
    }
    url.to_string()
}

fn attachment(cx: &mut Cx, a: &Json) -> Option<Json> {
    let id = a.get("id")?.as_str()?;
    let filename = a.get("filename").and_then(Json::as_str).unwrap_or("file");
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert(
        "url".into(),
        json!(attachment_url(cx.public_url, id, filename, false)),
    );
    out.insert("filename".into(), json!(filename));
    out.insert("size".into(), a.get("size").cloned().unwrap_or(json!(0)));
    out.insert(
        "type".into(),
        a.get("mime")
            .cloned()
            .unwrap_or(json!("application/octet-stream")),
    );
    let (w, h) = (
        a.get("width").and_then(Json::as_u64),
        a.get("height").and_then(Json::as_u64),
    );
    if let (Some(w), Some(h)) = (w, h) {
        out.insert("width".into(), json!(w));
        out.insert("height".into(), json!(h));
        let has_thumb = attachments::get(cx.conn, id)
            .ok()
            .flatten()
            .is_some_and(|row| row.has_thumb);
        if has_thumb {
            let (tw, th) = thumbnail_size(w as u32, h as u32);
            let thumb = json!({
                "url": attachment_url(cx.public_url, id, filename, true),
                "width": tw,
                "height": th,
            });
            out.insert(
                "thumbnails".into(),
                json!({
                    "small": thumb,
                    "large": thumb,
                    "full": {
                        "url": attachment_url(cx.public_url, id, filename, false),
                        "width": w,
                        "height": h,
                    },
                }),
            );
        }
    }
    Some(Json::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_get_milliseconds_and_utc() {
        assert_eq!(instant("2026-03-01T12:00:00Z"), "2026-03-01T12:00:00.000Z");
        assert_eq!(
            instant("2026-03-01T12:00:00+02:00"),
            "2026-03-01T10:00:00.000Z"
        );
        assert_eq!(instant("not a date"), "not a date");
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn thumbnails_fit_within_the_stored_size() {
        assert_eq!(thumbnail_size(100, 1000), (40, 400));
        assert_eq!(thumbnail_size(1000, 500), (400, 200));
        assert_eq!(thumbnail_size(800, 800), (400, 400));
        assert_eq!(thumbnail_size(0, 5), (0, 5));
    }

    #[test]
    fn attachment_urls_are_absolute_and_escaped() {
        assert_eq!(
            attachment_url("https://base.example.com", "attX", "my file#1.png", false),
            "https://base.example.com/api/attachments/attX/my%20file%231.png"
        );
        assert_eq!(
            attachment_url("http://localhost:8080/", "attX", "a/b.png", false),
            "http://localhost:8080/api/attachments/attX/a%2Fb.png"
        );
        assert_eq!(
            attachment_url("https://g.example.com/sub", "attX", "x.png", true),
            "https://g.example.com/sub/api/attachments/attX/thumb"
        );
    }

    #[test]
    fn computed_values_drop_empties() {
        assert_eq!(computed(&json!(""), &ResultType::Text), None);
        assert_eq!(computed(&json!([]), &ResultType::Text), None);
        assert_eq!(computed(&Json::Null, &ResultType::Number), None);
        assert_eq!(computed(&json!(0), &ResultType::Number), Some(json!(0)));
        assert_eq!(
            computed(&json!(false), &ResultType::Bool),
            Some(json!(false))
        );
        assert_eq!(
            computed(&json!("2026-03-01T00:00:00Z"), &ResultType::DateTime),
            Some(json!("2026-03-01T00:00:00.000Z"))
        );
    }
}
