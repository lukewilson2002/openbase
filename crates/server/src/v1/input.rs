//! Request cells in Airtable's shapes → the internal API's values.
//!
//! Keys of a `fields` object may be field names or field ids. The result is
//! keyed by field id and goes to the record write engine, which normalizes
//! every value (typecast aware) and writes in one transaction.
//!
//! Differences from Airtable are deliberate and documented in `docs/api.md`:
//! attachments are added by the `id` of a file uploaded to the base (the
//! server never fetches URLs on a client's behalf), and collaborators are
//! `{id}` or `{email}` of a collaborator on the base.

use std::collections::{BTreeMap, HashMap};

use axum::http::StatusCode;
use ob_core::cell::missing_choices;
use ob_core::field::{Field, FieldKind};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json, json};

use crate::v1::error::{V1Error, V1Result};

/// Fields of a table by id and by name.
pub struct FieldIndex<'a> {
    by_id: HashMap<&'a str, &'a Field>,
    by_name: HashMap<&'a str, &'a Field>,
}

impl<'a> FieldIndex<'a> {
    pub fn new(fields: &'a [Field]) -> FieldIndex<'a> {
        FieldIndex {
            by_id: fields.iter().map(|f| (f.id.as_str(), f)).collect(),
            by_name: fields.iter().map(|f| (f.name.as_str(), f)).collect(),
        }
    }

    /// A field named by id or by (exact) name; ids win.
    pub fn resolve(&self, key: &str) -> Option<&'a Field> {
        self.by_id
            .get(key)
            .or_else(|| self.by_name.get(key))
            .copied()
    }

    /// Like [`resolve`](Self::resolve), or 422 `UNKNOWN_FIELD_NAME`.
    pub fn require(&self, key: &str) -> V1Result<&'a Field> {
        self.resolve(key).ok_or_else(|| V1Error::unknown_field(key))
    }
}

/// Convert the `fields` object of one record. With `replace`, every editable
/// field the object does not mention is cleared (`PUT` semantics).
pub fn convert_fields(
    conn: &Connection,
    base_id: &str,
    fields: &[Field],
    given: &Map<String, Json>,
    typecast: bool,
    replace: bool,
) -> V1Result<BTreeMap<String, Json>> {
    let index = FieldIndex::new(fields);
    let mut out: BTreeMap<String, Json> = BTreeMap::new();
    for (key, value) in given {
        let field = index.require(key)?;
        if field.field_type().is_computed() {
            return Err(V1Error::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_VALUE_FOR_COLUMN",
                format!(
                    "Field \"{}\" cannot accept a value because the field is computed",
                    field.name
                ),
            ));
        }
        if out.contains_key(&field.id) {
            return Err(V1Error::invalid(format!(
                "Field \"{}\" is given more than once (by name and by id)",
                field.name
            )));
        }
        let converted = convert_value(conn, base_id, field, value)
            .map_err(|why| V1Error::invalid_value(&field.name, why))?;
        if !typecast && let Some(name) = missing_choices(field, &converted).first() {
            return Err(V1Error::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_MULTIPLE_CHOICE_OPTIONS",
                format!(
                    "Insufficient permissions to create new select option \"{name}\" \
                     (send \"typecast\": true to create options)"
                ),
            ));
        }
        out.insert(field.id.clone(), converted);
    }
    if replace {
        for f in fields {
            if !f.field_type().is_computed() && !out.contains_key(&f.id) {
                out.insert(f.id.clone(), Json::Null);
            }
        }
    }
    Ok(out)
}

fn convert_value(
    conn: &Connection,
    base_id: &str,
    field: &Field,
    v: &Json,
) -> Result<Json, String> {
    if v.is_null() {
        return Ok(Json::Null);
    }
    match &field.kind {
        FieldKind::User(_) => collaborators(conn, base_id, v),
        FieldKind::Attachment(_) => attachment_refs(v),
        _ => Ok(v.clone()),
    }
}

/// `{id}` / `{email}` objects (or bare id / email strings), single or in an
/// array, → an array of user ids.
fn collaborators(conn: &Connection, base_id: &str, v: &Json) -> Result<Json, String> {
    let items: Vec<&Json> = match v {
        Json::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    let mut ids = Vec::new();
    for item in items {
        let (id, email) = match item {
            Json::String(s) if s.contains('@') => (None, Some(s.as_str())),
            Json::String(s) => (Some(s.as_str()), None),
            Json::Object(o) => (
                o.get("id").and_then(Json::as_str),
                o.get("email").and_then(Json::as_str),
            ),
            _ => return Err("expected a collaborator object with an id or an email".into()),
        };
        match (id, email) {
            (Some(id), _) => ids.push(json!(id)),
            (None, Some(email)) => {
                let found: Option<String> = conn
                    .query_row(
                        &format!(
                            "SELECT u.id FROM users u
                             JOIN workspace_members m ON m.user_id = u.id
                             JOIN bases b ON b.workspace_id = m.workspace_id
                             WHERE lower(u.email) = lower(?2) AND u.is_active = 1 AND b.id = ?1
                               AND {}",
                            crate::perm::MEMBER_CAN_OPEN_BASE
                        ),
                        [base_id, email.trim()],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                match found {
                    Some(id) => ids.push(json!(id)),
                    None => return Err(format!("{email} is not a collaborator on this base")),
                }
            }
            (None, None) => {
                return Err("expected a collaborator object with an id or an email".into());
            }
        }
    }
    Ok(Json::Array(ids))
}

/// Attachment objects → the stored reference shape. Only the `id` of an
/// uploaded file counts; the server rebuilds the reference from its own
/// record of the file.
fn attachment_refs(v: &Json) -> Result<Json, String> {
    let Some(items) = v.as_array() else {
        return Err("expected a list of attachment objects".into());
    };
    let mut out = Vec::new();
    for item in items {
        let Some(o) = item.as_object() else {
            return Err("expected attachment objects like {\"id\": \"att...\"}".into());
        };
        let Some(id) = o.get("id").and_then(Json::as_str) else {
            return Err(
                "attachments are added by the id of a file uploaded to the base \
                 (POST /api/bases/{id}/attachments); URLs are not fetched"
                    .into(),
            );
        };
        out.push(json!({
            "id": id,
            "filename": o.get("filename").and_then(Json::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("file"),
            "mime": o.get("type").or_else(|| o.get("mime")).and_then(Json::as_str).filter(|s| s.contains('/')).unwrap_or("application/octet-stream"),
            "size": o.get("size").and_then(Json::as_u64).unwrap_or(0),
        }));
    }
    Ok(Json::Array(out))
}
