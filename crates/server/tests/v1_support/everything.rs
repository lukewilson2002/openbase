//! A table with one field of (nearly) every type and one filled record,
//! linked to the People table.
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::V1;
use crate::share_support::*;

pub struct Everything {
    pub table_id: String,
    /// Field name -> id.
    pub ids: BTreeMap<String, String>,
    pub record_id: String,
    pub attachment: Value,
}

impl Everything {
    pub fn field(&self, name: &str) -> &str {
        self.ids
            .get(name)
            .unwrap_or_else(|| panic!("no field {name}"))
    }
}

pub async fn everything(v: &V1) -> Everything {
    let f = &v.p.f;
    let table = f.add_table("Everything").await;
    let t = id_of(&table);
    let primary = table["primary_field_id"].as_str().unwrap().to_string();
    let rename = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{primary}"),
            json!({ "name": "Title" }),
        )
        .await;
    rename.assert_status(200);
    let mut ids = BTreeMap::new();
    ids.insert("Title".to_string(), primary);
    let specs = [
        json!({ "name": "Long", "type": "text", "options": { "multiline": true } }),
        json!({ "name": "Rich", "type": "rich_text", "options": {} }),
        json!({ "name": "Num", "type": "number", "options": { "precision": 2 } }),
        json!({ "name": "Cur", "type": "currency", "options": { "precision": 2, "symbol": "EUR" } }),
        json!({ "name": "Pct", "type": "percent", "options": { "precision": 1 } }),
        json!({ "name": "Dur", "type": "duration", "options": { "format": "h_mm_ss" } }),
        json!({ "name": "Rate", "type": "rating", "options": { "max": 5 } }),
        json!({ "name": "Check", "type": "checkbox", "options": {} }),
        json!({ "name": "Sel", "type": "single_select",
                "options": { "choices": [ { "name": "Red" }, { "name": "Green" } ] } }),
        json!({ "name": "Multi", "type": "multiple_select",
                "options": { "choices": [ { "name": "x" }, { "name": "y" }, { "name": "z" } ] } }),
        json!({ "name": "Day", "type": "date", "options": { "date_format": "iso" } }),
        json!({ "name": "Moment", "type": "date",
                "options": { "include_time": true, "time_format": "h24", "timezone": "Europe/Paris" } }),
        json!({ "name": "Email", "type": "email", "options": {} }),
        json!({ "name": "Url", "type": "url", "options": {} }),
        json!({ "name": "Phone", "type": "phone", "options": {} }),
        json!({ "name": "Files", "type": "attachment", "options": {} }),
        json!({ "name": "Owner", "type": "user", "options": { "multiple": false } }),
        json!({ "name": "Team", "type": "user", "options": { "multiple": true } }),
        json!({ "name": "Code", "type": "barcode", "options": {} }),
        json!({ "name": "Links", "type": "link", "options": { "linked_table_id": v.table_id() } }),
    ];
    for spec in specs {
        let created = f.add_field(&t, spec.clone()).await;
        ids.insert(spec["name"].as_str().unwrap().to_string(), id_of(&created));
    }
    let links = ids["Links"].clone();
    let computed = [
        json!({ "name": "Calc", "type": "formula", "options": { "expression": "{Num} * 2" } }),
        json!({ "name": "Names", "type": "lookup",
                "options": { "link_field_id": links, "target_field_id": v.p.name } }),
        json!({ "name": "AgeSum", "type": "rollup",
                "options": { "link_field_id": links, "target_field_id": v.p.age,
                             "expression": "SUM(values)" } }),
        json!({ "name": "LinkCount", "type": "count", "options": { "link_field_id": links } }),
        json!({ "name": "Created", "type": "created_time", "options": {} }),
        json!({ "name": "Modified", "type": "last_modified_time", "options": {} }),
        json!({ "name": "Author", "type": "created_by", "options": {} }),
        json!({ "name": "Editor", "type": "last_modified_by", "options": {} }),
        json!({ "name": "Auto", "type": "autonumber", "options": {} }),
        json!({ "name": "Go", "type": "button",
                "options": { "label": "Open", "url_formula": "\"https://example.com/\" & {Title}" } }),
    ];
    for spec in computed {
        let created = f.add_field(&t, spec.clone()).await;
        ids.insert(spec["name"].as_str().unwrap().to_string(), id_of(&created));
    }
    let attachment = f.upload("pic.png", &png(40, 20)).await;
    let owner_id = f.owner.user_id.clone().unwrap();
    let values = json!({
        &ids["Title"]: "Row 1",
        &ids["Long"]: "line one\nline two",
        &ids["Rich"]: "**bold** text",
        &ids["Num"]: 2.754,
        &ids["Cur"]: 12.5,
        &ids["Pct"]: 0.25,
        &ids["Dur"]: 3661,
        &ids["Rate"]: 4,
        &ids["Check"]: true,
        &ids["Sel"]: "Red",
        &ids["Multi"]: ["x", "z"],
        &ids["Day"]: "2026-04-01",
        &ids["Moment"]: "2026-04-01T09:30:00Z",
        &ids["Email"]: "ann@example.com",
        &ids["Url"]: "https://example.com/a",
        &ids["Phone"]: "+1 555 0100",
        &ids["Files"]: [attachment],
        &ids["Owner"]: [owner_id],
        &ids["Team"]: [owner_id],
        &ids["Code"]: "9780306406157",
        &ids["Links"]: [v.p.ids[0], v.p.ids[1]],
    });
    let rec = f.create(&t, values).await;
    Everything {
        table_id: t,
        ids,
        record_id: id_of(&rec),
        attachment,
    }
}
