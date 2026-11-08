//! A collection's page: the rich text property that holds the body of its records
//! (`tables.body_field_id`, decision 2 of the UX overhaul spec), and the data fix of schema
//! version 16 that gives every existing table its page and its Home properties.

use ob_core::field::{Field, FieldKind};
use ob_core::limits;
use ob_core::value::ResultType;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::schema::{self, PositionScope, TableRow};

/// Name of the page property of a collection that has none yet. Another property of the table may
/// already use it; the new one is then called "Page 2", "Page 3" and so on.
pub const BODY_FIELD_NAME: &str = "Page";

/// The page property of `table_id`, if it has one.
pub fn body_field_id(conn: &Connection, table_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT body_field_id FROM tables WHERE id = ?1",
            [table_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

/// Create the page property of `table_id`: a rich text field named "Page" (or the first free
/// "Page N"), hidden in every view of the table, and make the table point at it. Returns its id,
/// or `None` when the table is at the field limit (it then stays without a page).
pub fn create_body_field(conn: &Connection, table_id: &str) -> AppResult<Option<String>> {
    let siblings = schema::table_fields(conn, table_id)?;
    if siblings.len() >= limits::MAX_FIELDS_PER_TABLE {
        return Ok(None);
    }
    let name = schema::uniquify(
        &schema::name_keys(siblings.iter().map(|f| f.name.as_str())),
        BODY_FIELD_NAME,
    );
    let field = Field {
        id: new_id(ob_core::ids::FIELD),
        table_id: table_id.to_string(),
        name,
        description: None,
        kind: FieldKind::RichText(Default::default()),
    };
    let position = schema::next_position(conn, PositionScope::FieldsIn(table_id))?;
    schema::insert_field(conn, &field, position, now_ms())?;
    conn.execute(
        "UPDATE tables SET body_field_id = ?2 WHERE id = ?1",
        params![table_id, field.id],
    )?;
    hide_in_every_view(conn, table_id, &field.id)?;
    Ok(Some(field.id))
}

/// The page property of `table_id`, created as "Page" when the table has none. The `bool` says
/// whether this call created it. This is the one schema change an editor can cause (decision 2):
/// the page of a record is written through it, see `PUT /api/tables/{id}/records/{rid}/page`.
pub fn ensure_body_field(conn: &Connection, table_id: &str) -> AppResult<(String, bool)> {
    if let Some(id) = body_field_id(conn, table_id)? {
        return Ok((id, false));
    }
    match create_body_field(conn, table_id)? {
        Some(id) => Ok((id, true)),
        None => Err(AppError::conflict(format!(
            "this collection already has {} properties, the most it can have, so there is no \
             room for a page; delete a property first",
            limits::MAX_FIELDS_PER_TABLE
        ))),
    }
}

/// Whether a property can be a collection's Home date (HOME-5): a date, a created or last
/// modified time, or a formula or rollup that gives a date. A lookup gives a list of dates,
/// which has no single date to order by.
pub fn is_date_like(kind: &FieldKind) -> bool {
    let gives_date = |t: &ResultType| matches!(t, ResultType::Date | ResultType::DateTime);
    match kind {
        FieldKind::Date(_) | FieldKind::CreatedTime(_) | FieldKind::LastModifiedTime(_) => true,
        FieldKind::Formula(o) => gives_date(&o.result_type),
        FieldKind::Rollup(o) => gives_date(&o.result_type),
        _ => false,
    }
}

fn is_checkbox(kind: &FieldKind) -> bool {
    matches!(kind, FieldKind::Checkbox(_))
}

fn is_rich_text(kind: &FieldKind) -> bool {
    matches!(kind, FieldKind::RichText(_))
}

/// A property of `table_id` that is not in the trash.
fn table_field(conn: &Connection, table_id: &str, field_id: &str) -> AppResult<Option<Field>> {
    Ok(schema::table_fields(conn, table_id)?
        .into_iter()
        .find(|f| f.id == field_id))
}

/// Make `field_id` the page of the table, or with `None` give the table no page property.
/// The property must be a rich text property of the table other than its title.
pub fn set_body_field(
    conn: &Connection,
    table_id: &str,
    field_id: Option<&str>,
) -> AppResult<TableRow> {
    let table = schema::live_table(conn, table_id)?;
    if let Some(id) = field_id {
        let field = table_field(conn, table_id, id)?.ok_or_else(|| AppError::not_found("field"))?;
        if !is_rich_text(&field.kind) {
            return Err(AppError::bad_request(format!(
                "a {} property cannot be the page; only rich text properties can",
                field.field_type().label()
            )));
        }
        if table.primary_field_id == field.id {
            return Err(AppError::bad_request(
                "the title property cannot also be the page; make another property the title first",
            ));
        }
    }
    conn.execute(
        "UPDATE tables SET body_field_id = ?2 WHERE id = ?1",
        params![table_id, field_id],
    )?;
    schema::live_table(conn, table_id)
}

/// Set the Home date of the table (`None` = no Home date): a date-like property of the table.
pub fn set_home_date_field(
    conn: &Connection,
    table_id: &str,
    field_id: Option<&str>,
) -> AppResult<()> {
    set_pointer(
        conn,
        table_id,
        "home_date_field_id",
        field_id,
        is_date_like,
        "Home date",
        "a date, created time or last modified time property, or a formula or rollup that gives a date",
    )
}

/// Set the Done property of the table (`None` = none): a checkbox property of the table.
pub fn set_done_field(conn: &Connection, table_id: &str, field_id: Option<&str>) -> AppResult<()> {
    set_pointer(
        conn,
        table_id,
        "done_field_id",
        field_id,
        is_checkbox,
        "Done property",
        "a checkbox property",
    )
}

fn set_pointer(
    conn: &Connection,
    table_id: &str,
    column: &str,
    field_id: Option<&str>,
    valid: fn(&FieldKind) -> bool,
    what: &str,
    wants: &str,
) -> AppResult<()> {
    if let Some(id) = field_id {
        let field = table_field(conn, table_id, id)?.ok_or_else(|| {
            AppError::bad_request(format!("the {what} must be a property of this table"))
        })?;
        if !valid(&field.kind) {
            return Err(AppError::bad_request(format!(
                "a {} property cannot be the {what}; it must be {wants}",
                field.field_type().label()
            )));
        }
    }
    // `column` is one of this file's constants, never client input.
    conn.execute(
        &format!("UPDATE tables SET {column} = ?2 WHERE id = ?1"),
        params![table_id, field_id],
    )?;
    Ok(())
}

/// Clear what the tables' settings point at when it is no longer there or no longer fits:
/// the page when its property is deleted, retyped away from rich text or made the title; the
/// Home date or Done property when theirs is deleted or retyped. Nothing is refused, so the
/// calls that delete or retype a property behave as they always did (FLD-4); run this after
/// them for every table they touched. A property cleared because it went to the trash is
/// marked with the setting it was, so [`restore_cleared_settings`] can give it back.
pub fn clear_stale_settings(conn: &Connection, table_ids: &[String]) -> AppResult<()> {
    for table_id in table_ids {
        let Some(table) = schema::table_any(conn, table_id)? else {
            continue;
        };
        let fields = schema::table_fields(conn, table_id)?;
        let fits = |pointer: &Option<String>, valid: &dyn Fn(&Field) -> bool| {
            pointer
                .as_deref()
                .is_none_or(|id| fields.iter().any(|f| f.id == id && valid(f)))
        };
        let checks = [
            (
                "body_field_id",
                &table.body_field_id,
                fits(&table.body_field_id, &|f| {
                    is_rich_text(&f.kind) && f.id != table.primary_field_id
                }),
            ),
            (
                "home_date_field_id",
                &table.home_date_field_id,
                fits(&table.home_date_field_id, &|f| is_date_like(&f.kind)),
            ),
            (
                "done_field_id",
                &table.done_field_id,
                fits(&table.done_field_id, &|f| is_checkbox(&f.kind)),
            ),
        ];
        for (column, pointer, ok) in checks {
            if !ok {
                conn.execute(
                    &format!("UPDATE tables SET {column} = NULL WHERE id = ?1"),
                    [table_id],
                )?;
                // Only a property in the trash can come back; a retyped one stays what it is.
                conn.execute(
                    "UPDATE fields SET trashed_setting = ?2 WHERE id = ?1 AND deleted_at IS NOT NULL",
                    params![pointer, column],
                )?;
            }
        }
    }
    Ok(())
}

/// After `field_ids` came back from the trash: give each back the setting it lost when it went
/// (page, Home date or Done property), unless the table has chosen another since or the property
/// no longer fits. Without this a restored page stays an ordinary hidden column and the next
/// page save starts a second "Page", leaving the original text out of sight.
pub fn restore_cleared_settings(conn: &Connection, field_ids: &[String]) -> AppResult<()> {
    for id in field_ids {
        let Some((table_id, column)) = conn
            .query_row(
                "SELECT table_id, trashed_setting FROM fields
                 WHERE id = ?1 AND deleted_at IS NULL AND trashed_setting IS NOT NULL",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            continue;
        };
        conn.execute(
            "UPDATE fields SET trashed_setting = NULL WHERE id = ?1",
            [id],
        )?;
        let (table, field) = (
            schema::table_any(conn, &table_id)?,
            table_field(conn, &table_id, id)?,
        );
        let (Some(table), Some(field)) = (table, field) else {
            continue;
        };
        let (current, fits) = match column.as_str() {
            "body_field_id" => (
                &table.body_field_id,
                is_rich_text(&field.kind) && field.id != table.primary_field_id,
            ),
            "home_date_field_id" => (&table.home_date_field_id, is_date_like(&field.kind)),
            "done_field_id" => (&table.done_field_id, is_checkbox(&field.kind)),
            _ => continue,
        };
        if current.is_none() && fits {
            // `column` was matched against this file's own names just above.
            conn.execute(
                &format!("UPDATE tables SET {column} = ?2 WHERE id = ?1"),
                params![table_id, id],
            )?;
        }
    }
    Ok(())
}

/// Validate and normalise what a record of the table is called: trimmed, at most
/// [`limits::MAX_RECORD_NOUN_LEN`] characters, no control characters; empty means "record".
pub fn validate_record_noun(raw: &str) -> AppResult<String> {
    let noun = raw.trim();
    if noun.chars().count() > limits::MAX_RECORD_NOUN_LEN {
        return Err(AppError::bad_request(format!(
            "the record name is too long (max {} characters)",
            limits::MAX_RECORD_NOUN_LEN
        )));
    }
    if noun.chars().any(char::is_control) {
        return Err(AppError::bad_request(
            "the record name cannot contain control characters",
        ));
    }
    Ok(noun.to_string())
}

/// Add `field_id` to the hidden fields of every view of the table: the ones people see, personal
/// ones and ones in the trash (a restored view must not show the page either). A view whose
/// config cannot be read is left alone.
fn hide_in_every_view(conn: &Connection, table_id: &str, field_id: &str) -> rusqlite::Result<()> {
    let views: Vec<(String, String)> = conn
        .prepare("SELECT id, config FROM views WHERE table_id = ?1")?
        .query_map([table_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, config) in views {
        let Ok(Value::Object(mut config)) = serde_json::from_str::<Value>(&config) else {
            continue;
        };
        let hidden = config.entry("hidden_fields").or_insert_with(|| json!([]));
        match hidden {
            Value::Array(ids) => {
                if !ids.iter().any(|i| i == field_id) {
                    ids.push(json!(field_id));
                }
            }
            other => *other = json!([field_id]),
        }
        conn.execute(
            "UPDATE views SET config = ?2 WHERE id = ?1",
            params![id, Value::Object(config).to_string()],
        )?;
    }
    Ok(())
}

/// Names (compared trimmed and case-insensitively) of the date properties Home reads, best first
/// (HOME-5). A table with a Due and a Start date takes Due.
const HOME_DATE_NAMES: [&str; 6] = ["due", "due date", "deadline", "date", "when", "start"];
/// Names of the checkbox properties that mark a record done, best first (HOME-5).
const DONE_NAMES: [&str; 3] = ["done", "complete", "completed"];

/// A field as the version 16 data fix reads it.
struct Stored {
    id: String,
    name: String,
    ty: String,
}

/// The first of `fields` (in table order) of type `ty` whose name is the earliest in `names`.
fn preset<'a>(fields: &'a [Stored], ty: &str, names: &[&str]) -> Option<&'a Stored> {
    names.iter().find_map(|wanted| {
        fields
            .iter()
            .find(|f| f.ty == ty && f.name.trim().to_lowercase() == *wanted)
    })
}

/// Data fix of schema version 16 (BE-1), run right after `0016_collections.sql`:
///
/// - `home_date_field_id` and `done_field_id` take the preset of HOME-5 when the table has such a
///   property, else stay empty. This covers trashed tables too, so a restored table behaves like
///   the others.
/// - `body_field_id` (decision 2): a live table with exactly one live rich text property other
///   than its title uses it as the page; any other live table gets a new one, unless it already
///   has the largest number of properties allowed. Tables in the trash keep none.
///
/// The SQL here names only the columns that existed in version 16, so that later migrations can
/// change the tables without breaking this function.
pub fn upgrade_to_v16(conn: &Connection) -> rusqlite::Result<()> {
    let tables: Vec<(String, String, bool)> = conn
        .prepare("SELECT id, primary_field_id, deleted_at IS NOT NULL FROM tables ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (table_id, primary_id, trashed) in tables {
        let fields: Vec<Stored> = conn
            .prepare(
                "SELECT id, name, type FROM fields WHERE table_id = ?1 AND deleted_at IS NULL
                 ORDER BY position, created_at, id",
            )?
            .query_map([&table_id], |r| {
                Ok(Stored {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    ty: r.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        let home = preset(&fields, "date", &HOME_DATE_NAMES).map(|f| f.id.as_str());
        let done = preset(&fields, "checkbox", &DONE_NAMES).map(|f| f.id.as_str());
        conn.execute(
            "UPDATE tables SET home_date_field_id = ?2, done_field_id = ?3 WHERE id = ?1",
            params![table_id, home, done],
        )?;

        if trashed {
            continue;
        }
        let candidates: Vec<&Stored> = fields
            .iter()
            .filter(|f| f.ty == "rich_text" && f.id != primary_id)
            .collect();
        if let [only] = candidates.as_slice() {
            conn.execute(
                "UPDATE tables SET body_field_id = ?2 WHERE id = ?1",
                params![table_id, only.id],
            )?;
        } else if fields.len() < limits::MAX_FIELDS_PER_TABLE {
            add_page_field_v16(conn, &table_id, &fields)?;
        }
    }
    Ok(())
}

/// The page property of a table that needs a new one, as version 16 stored fields.
fn add_page_field_v16(conn: &Connection, table_id: &str, live: &[Stored]) -> rusqlite::Result<()> {
    let taken: std::collections::HashSet<String> =
        live.iter().map(|f| f.name.to_lowercase()).collect();
    let name = (1..)
        .map(|n| match n {
            1 => BODY_FIELD_NAME.to_string(),
            n => format!("{BODY_FIELD_NAME} {n}"),
        })
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .expect("an unbounded range has a free name");
    let id = new_id(ob_core::ids::FIELD);
    let position: f64 = conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM fields WHERE table_id = ?1",
        [table_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
         VALUES (?1, ?2, ?3, 'rich_text', '{}', ?4, ?5)",
        params![id, table_id, name, position, now_ms()],
    )?;
    conn.execute(
        "UPDATE tables SET body_field_id = ?2 WHERE id = ?1",
        params![table_id, id],
    )?;
    hide_in_every_view(conn, table_id, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(id: &str, name: &str, ty: &str) -> Stored {
        Stored {
            id: id.into(),
            name: name.into(),
            ty: ty.into(),
        }
    }

    #[test]
    fn the_home_date_goes_by_name_then_table_order() {
        let fields = [
            field("a", "Start", "date"),
            field("b", " due DATE ", "date"),
            field("c", "Due", "text"),
            field("d", "Date", "date"),
            field("e", "Due", "date"),
        ];
        // "Due date" beats "Date" and "Start"; the text field called "Due" is not a date.
        assert_eq!(preset(&fields, "date", &HOME_DATE_NAMES).unwrap().id, "e");
        assert_eq!(
            preset(&fields[..2], "date", &HOME_DATE_NAMES).unwrap().id,
            "b"
        );
        assert!(preset(&fields[2..3], "date", &HOME_DATE_NAMES).is_none());
        assert!(preset(&[], "date", &HOME_DATE_NAMES).is_none());
    }

    #[test]
    fn done_is_a_checkbox_called_done_complete_or_completed() {
        let fields = [
            field("a", "Completed", "checkbox"),
            field("b", "COMPLETE", "checkbox"),
            field("c", "Done", "number"),
        ];
        assert_eq!(preset(&fields, "checkbox", &DONE_NAMES).unwrap().id, "b");
        assert!(preset(&fields[2..], "checkbox", &DONE_NAMES).is_none());
    }
}
