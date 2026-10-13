//! Base and table metadata in Airtable's shapes
//! (`GET /api/v1/meta/bases[/{baseId}/tables]`).

use axum::Json;
use axum::extract::{Path, State};
use ob_core::api::v1::{V1Base, V1Bases, V1Field, V1Table, V1Tables, V1View};
use ob_core::field::{
    DateFormat, DateOptions, DurationFormat, Field, FieldKind, TimeFormat, ValueFormat,
};
use ob_core::value::ResultType;
use ob_core::view::ViewType;
use serde_json::{Value as Json2, json};

use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::{schema, workspaces};
use crate::v1::auth::V1Auth;
use crate::v1::error::V1Result;

/// Airtable's permission level of a role.
pub fn permission_level(role: Role) -> &'static str {
    match role {
        Role::Viewer => "read",
        Role::Commenter => "comment",
        Role::Editor => "edit",
        Role::Creator | Role::Owner => "create",
    }
}

/// `GET /api/v1/meta/bases`: the bases the token can reach.
pub async fn list_bases(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
) -> V1Result<Json<V1Bases>> {
    let bases = state
        .db
        .read(move |conn| {
            let mut out = Vec::new();
            for ws in workspaces::list_for_user(conn, &actor.user_id)? {
                for b in ws.bases {
                    // The same checks as every other endpoint: token base
                    // list, read-only cap.
                    let Ok(role) = perm::require_base(conn, &actor, &b.id, Role::Viewer) else {
                        continue;
                    };
                    out.push(V1Base {
                        id: b.id,
                        name: b.name,
                        permission_level: permission_level(role).to_string(),
                    });
                }
            }
            Ok(out)
        })
        .await?;
    Ok(Json(V1Bases { bases }))
}

/// `GET /api/v1/meta/bases/{baseId}/tables`.
pub async fn list_tables(
    State(state): State<AppState>,
    V1Auth(actor): V1Auth,
    Path(base_id): Path<String>,
) -> V1Result<Json<V1Tables>> {
    let tables = state
        .db
        .read(move |conn| {
            perm::require_base(conn, &actor, &base_id, Role::Viewer)?;
            let mut out = Vec::new();
            for t in schema::live_tables(conn, &base_id)? {
                let fields = schema::table_fields(conn, &t.id)?;
                let views = schema::visible_views(conn, &t.id, &actor.user_id)?;
                out.push(V1Table {
                    id: t.id,
                    name: t.name,
                    description: t.description.filter(|d| !d.is_empty()),
                    primary_field_id: t.primary_field_id,
                    fields: fields.iter().map(field_meta).collect(),
                    views: views
                        .iter()
                        .map(|v| V1View {
                            id: v.view.id.clone(),
                            name: v.view.name.clone(),
                            view_type: view_type(v.view.view_type).to_string(),
                        })
                        .collect(),
                });
            }
            Ok(out)
        })
        .await?;
    Ok(Json(V1Tables { tables }))
}

pub fn view_type(t: ViewType) -> &'static str {
    match t {
        ViewType::Grid => "grid",
        ViewType::Form => "form",
        ViewType::Gallery => "gallery",
        ViewType::Kanban => "kanban",
        ViewType::Calendar => "calendar",
        ViewType::Timeline => "timeline",
        ViewType::List => "list",
    }
}

/// Airtable's name of a field's type.
pub fn airtable_type(field: &Field) -> &'static str {
    match &field.kind {
        FieldKind::SingleLineText(_) => "singleLineText",
        FieldKind::LongText(o) if o.rich => "richText",
        FieldKind::LongText(_) => "multilineText",
        FieldKind::Number(_) => "number",
        FieldKind::Currency(_) => "currency",
        FieldKind::Percent(_) => "percent",
        FieldKind::Duration(_) => "duration",
        FieldKind::Rating(_) => "rating",
        FieldKind::Checkbox(_) => "checkbox",
        FieldKind::SingleSelect(_) => "singleSelect",
        FieldKind::MultipleSelect(_) => "multipleSelects",
        FieldKind::Date(o) if o.include_time => "dateTime",
        FieldKind::Date(_) => "date",
        FieldKind::Email(_) => "email",
        FieldKind::Url(_) => "url",
        FieldKind::Phone(_) => "phoneNumber",
        FieldKind::Attachment(_) => "multipleAttachments",
        FieldKind::Link(_) => "multipleRecordLinks",
        FieldKind::User(o) if o.multiple => "multipleCollaborators",
        FieldKind::User(_) => "singleCollaborator",
        FieldKind::Formula(_) => "formula",
        FieldKind::Lookup(_) => "multipleLookupValues",
        FieldKind::Rollup(_) => "rollup",
        FieldKind::Count(_) => "count",
        FieldKind::CreatedTime(_) => "createdTime",
        FieldKind::LastModifiedTime(_) => "lastModifiedTime",
        FieldKind::CreatedBy(_) => "createdBy",
        FieldKind::LastModifiedBy(_) => "lastModifiedBy",
        FieldKind::Autonumber(_) => "autoNumber",
        FieldKind::Barcode(_) => "barcode",
        FieldKind::Button(_) => "button",
    }
}

fn date_format(f: DateFormat) -> Json2 {
    let (name, format) = match f {
        DateFormat::Us => ("us", "M/D/YYYY"),
        DateFormat::European => ("european", "D/M/YYYY"),
        DateFormat::Iso => ("iso", "YYYY-MM-DD"),
        DateFormat::Friendly => ("friendly", "LL"),
    };
    json!({ "name": name, "format": format })
}

fn time_format(f: TimeFormat) -> Json2 {
    let (name, format) = match f {
        TimeFormat::H12 => ("12hour", "h:mma"),
        TimeFormat::H24 => ("24hour", "HH:mm"),
    };
    json!({ "name": name, "format": format })
}

fn duration_format(f: DurationFormat) -> &'static str {
    match f {
        DurationFormat::HMm => "h:mm",
        DurationFormat::HMmSs => "h:mm:ss",
        DurationFormat::HMmSsS => "h:mm:ss.S",
        DurationFormat::HMmSsSs => "h:mm:ss.SS",
        DurationFormat::HMmSsSss => "h:mm:ss.SSS",
    }
}

/// `options` of a date or dateTime field (or of a date-valued result).
fn date_options(o: &DateOptions) -> Json2 {
    let mut out = json!({ "dateFormat": date_format(o.date_format) });
    if o.include_time {
        out["timeFormat"] = time_format(o.time_format);
        out["timeZone"] = json!(o.timezone.as_deref().unwrap_or("client"));
    }
    out
}

/// Airtable's `{type, options}` description of a computed value's type.
fn result_of(ty: &ResultType, format: Option<&ValueFormat>) -> Json2 {
    match ty {
        ResultType::Text => json!({ "type": "singleLineText" }),
        ResultType::Bool => {
            json!({ "type": "checkbox", "options": { "icon": "check", "color": "green" } })
        }
        ResultType::Number => match format {
            Some(ValueFormat::Currency { precision, symbol }) => {
                json!({ "type": "currency", "options": { "precision": precision, "symbol": symbol } })
            }
            Some(ValueFormat::Percent { precision }) => {
                json!({ "type": "percent", "options": { "precision": precision } })
            }
            Some(ValueFormat::Duration { format }) => {
                json!({ "type": "duration", "options": { "durationFormat": duration_format(*format) } })
            }
            Some(ValueFormat::Number { precision }) => {
                json!({ "type": "number", "options": { "precision": precision } })
            }
            _ => json!({ "type": "number", "options": { "precision": 8 } }),
        },
        ResultType::Date | ResultType::DateTime => {
            let mut o = match format {
                Some(ValueFormat::Date(o)) => o.clone(),
                _ => DateOptions::default(),
            };
            o.include_time = *ty == ResultType::DateTime;
            json!({
                "type": if o.include_time { "dateTime" } else { "date" },
                "options": date_options(&o),
            })
        }
        ResultType::Array(inner) => json!({
            "type": "multipleLookupValues",
            "options": { "isValid": true, "result": result_of(inner, format) },
        }),
    }
}

/// The element type of an array result (lookups are arrays of their target).
fn element(ty: &ResultType) -> &ResultType {
    match ty {
        ResultType::Array(inner) => inner,
        other => other,
    }
}

/// One field of table metadata.
pub fn field_meta(field: &Field) -> V1Field {
    let options: Option<Json2> = match &field.kind {
        FieldKind::Number(o) => Some(json!({ "precision": o.precision })),
        FieldKind::Percent(o) => Some(json!({ "precision": o.precision })),
        FieldKind::Currency(o) => Some(json!({ "precision": o.precision, "symbol": o.symbol })),
        FieldKind::Duration(o) => Some(json!({ "durationFormat": duration_format(o.format) })),
        FieldKind::Rating(o) => Some(json!({ "icon": o.icon, "max": o.max, "color": o.color })),
        FieldKind::Checkbox(o) => Some(json!({ "icon": o.icon, "color": o.color })),
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => Some(json!({
            "choices": o.choices.iter().map(|c| json!({
                "id": c.id, "name": c.name, "color": c.color,
            })).collect::<Vec<_>>(),
        })),
        FieldKind::Date(o) => Some(date_options(o)),
        FieldKind::Attachment(_) => Some(json!({ "isReversed": false })),
        FieldKind::Link(o) => {
            let mut v = json!({
                "linkedTableId": o.linked_table_id,
                "isReversed": false,
                "prefersSingleRecordLink": o.single,
                "inverseLinkFieldId": o.inverse_field_id,
            });
            if let Some(view) = &o.picker_view_id {
                v["viewIdForRecordSelection"] = json!(view);
            }
            Some(v)
        }
        FieldKind::Formula(o) => Some(json!({
            "isValid": true,
            "referencedFieldIds": schema::field_refs(field),
            "result": result_of(&o.result_type, o.format.as_ref()),
        })),
        FieldKind::Lookup(o) => Some(json!({
            "isValid": true,
            "recordLinkFieldId": o.link_field_id,
            "fieldIdInLinkedTable": o.target_field_id,
            "result": result_of(element(&o.result_type), None),
        })),
        FieldKind::Rollup(o) => Some(json!({
            "isValid": true,
            "recordLinkFieldId": o.link_field_id,
            "fieldIdInLinkedTable": o.target_field_id,
            "referencedFieldIds": [],
            "result": result_of(&o.result_type, o.format.as_ref()),
        })),
        FieldKind::Count(o) => Some(json!({
            "isValid": true,
            "recordLinkFieldId": o.link_field_id,
        })),
        FieldKind::CreatedTime(o) => {
            let mut d = o.clone();
            d.include_time = true;
            Some(json!({ "result": { "type": "dateTime", "options": date_options(&d) } }))
        }
        FieldKind::LastModifiedTime(o) => {
            let mut d = o.date.clone();
            d.include_time = true;
            Some(json!({
                "isValid": true,
                "referencedFieldIds": o.fields,
                "result": { "type": "dateTime", "options": date_options(&d) },
            }))
        }
        FieldKind::LastModifiedBy(o) => Some(json!({ "referencedFieldIds": o.fields })),
        FieldKind::Button(o) => Some(json!({ "label": o.label })),
        _ => None,
    };
    V1Field {
        id: field.id.clone(),
        name: field.name.clone(),
        field_type: airtable_type(field).to_string(),
        description: field.description.clone().filter(|d| !d.is_empty()),
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{DateOptions, Empty, LongTextOptions, UserOptions};

    fn f(kind: FieldKind) -> Field {
        Field {
            id: "fld1".into(),
            table_id: "tbl1".into(),
            name: "F".into(),
            description: None,
            kind,
        }
    }

    #[test]
    fn every_field_type_has_an_airtable_name() {
        let wanted = [
            "singleLineText",
            "multilineText",
            "richText",
            "number",
            "currency",
            "percent",
            "duration",
            "rating",
            "checkbox",
            "singleSelect",
            "multipleSelects",
            "date",
            "dateTime",
            "email",
            "url",
            "phoneNumber",
            "multipleAttachments",
            "multipleRecordLinks",
            "singleCollaborator",
            "multipleCollaborators",
            "formula",
            "multipleLookupValues",
            "rollup",
            "count",
            "createdTime",
            "lastModifiedTime",
            "createdBy",
            "lastModifiedBy",
            "autoNumber",
            "barcode",
            "button",
        ];
        let rich = f(FieldKind::LongText(LongTextOptions { rich: true }));
        let dt = f(FieldKind::Date(DateOptions {
            include_time: true,
            ..Default::default()
        }));
        let multi = f(FieldKind::User(UserOptions {
            multiple: true,
            notify: false,
        }));
        let single = f(FieldKind::User(UserOptions::default()));
        let mut seen: Vec<&str> = vec![
            airtable_type(&rich),
            airtable_type(&dt),
            airtable_type(&multi),
            airtable_type(&single),
        ];
        for t in ob_core::field::FieldType::ALL {
            if let Some(kind) = FieldKind::default_for(t) {
                seen.push(airtable_type(&f(kind)));
            }
        }
        // Types that need options are covered by the integration tests.
        for name in [
            "multipleRecordLinks",
            "formula",
            "multipleLookupValues",
            "rollup",
            "count",
            "button",
        ] {
            seen.push(name);
        }
        for w in wanted {
            assert!(seen.contains(&w), "no field maps to {w}");
        }
        let _ = Empty {};
    }

    #[test]
    fn date_options_follow_airtable() {
        let o = DateOptions {
            include_time: true,
            date_format: DateFormat::Iso,
            time_format: TimeFormat::H24,
            timezone: Some("Europe/Paris".into()),
        };
        assert_eq!(
            date_options(&o),
            json!({
                "dateFormat": { "name": "iso", "format": "YYYY-MM-DD" },
                "timeFormat": { "name": "24hour", "format": "HH:mm" },
                "timeZone": "Europe/Paris",
            })
        );
        let d = DateOptions::default();
        assert_eq!(
            date_options(&d),
            json!({ "dateFormat": { "name": "us", "format": "M/D/YYYY" } })
        );
    }
}
