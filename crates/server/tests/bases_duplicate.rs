//! Duplicating a base: fresh ids everywhere, every reference remapped, link
//! pairs and record link arrays consistent, optional record copy.

mod common;
mod schema_support;

use std::collections::HashSet;

use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn table<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap()
}

fn field<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no field {name}"))
}

fn view<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap_or_else(|| panic!("no view {name}"))
}

async fn duplicate(r: &Rich, body: Value) -> Value {
    let res =
        r.f.app
            .post(
                &r.f.owner,
                &format!("/api/bases/{}/duplicate", r.f.base_id),
                body,
            )
            .await;
    res.assert_status(201);
    res.body.clone()
}

/// Every id string appearing in a schema document except the (shared) workspace id.
fn schema_ids(schema: &Value) -> HashSet<String> {
    let mut all = Vec::new();
    ids_in(schema, &mut all);
    let ws = sid(&schema["workspace_id"]).to_string();
    all.into_iter()
        .filter(|s| {
            s.len() >= 17
                && ["app", "tbl", "fld", "viw", "sel"]
                    .iter()
                    .any(|p| s.starts_with(p))
                && *s != ws
        })
        .collect()
}

#[tokio::test]
async fn duplicate_without_records_copies_the_schema_with_fresh_ids() {
    let r = rich_base().await;
    let before = r.f.schema().await;
    let copy = duplicate(&r, json!({ "include_records": false })).await;

    assert_eq!(copy["name"], "CRM copy");
    assert_eq!(copy["workspace_id"], before["workspace_id"]);
    assert_eq!(copy["role"], "owner");
    assert_ne!(copy["id"], before["id"]);
    assert_eq!(copy["color"], before["color"]);

    // the same shape ...
    let names = |s: &Value| -> Vec<(String, Vec<String>)> {
        s["tables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| (sid(&t["name"]).to_string(), Fixture::field_names(t)))
            .collect()
    };
    assert_eq!(names(&copy), names(&before));
    // ... but no id in common
    let (a, b) = (schema_ids(&before), schema_ids(&copy));
    assert!(
        a.len() > 20 && b.len() == a.len(),
        "{} vs {}",
        a.len(),
        b.len()
    );
    assert_eq!(
        a.intersection(&b).count(),
        0,
        "copy shares ids with the source: {:?}",
        a.intersection(&b).collect::<Vec<_>>()
    );

    assert!(
        assert_link_pairs_consistent(&copy) >= 4,
        "orders pair + self-link pair"
    );

    // the source is untouched
    assert_eq!(r.f.schema().await, before);

    // no records were copied
    assert!(dump_records(&r.f.app, sid(&copy["id"])).is_empty());
    // the copy shows up next to the original
    let list = r.f.app.get(&r.f.owner, "/api/workspaces").await;
    let names: Vec<&str> = list.body[0]["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| sid(&b["name"]))
        .collect();
    assert_eq!(names, ["CRM", "CRM copy"]);
}

#[tokio::test]
async fn every_reference_is_remapped_into_the_copy() {
    let r = rich_base().await;
    let copy = duplicate(
        &r,
        json!({ "name": "  Staging  ", "include_records": false }),
    )
    .await;
    assert_eq!(copy["name"], "Staging");
    let (t1, t2) = (table(&copy, "Table 1"), table(&copy, "Orders"));
    assert_eq!(t1["base_id"], copy["id"]);

    // primary field
    assert_eq!(t1["primary_field_id"], field(t1, "Name")["id"]);
    assert_eq!(t2["primary_field_id"], field(t2, "Name")["id"]);

    // link, lookup, rollup, count
    let orders = field(t1, "Orders");
    assert_eq!(orders["options"]["linked_table_id"], t2["id"]);
    assert_eq!(
        orders["options"]["inverse_field_id"],
        field(t2, "Table 1")["id"]
    );
    let price = field(t2, "Price");
    let lookup = field(t1, "Prices");
    assert_eq!(lookup["options"]["link_field_id"], orders["id"]);
    assert_eq!(lookup["options"]["target_field_id"], price["id"]);
    let rollup = field(t1, "Total");
    assert_eq!(rollup["options"]["link_field_id"], orders["id"]);
    assert_eq!(rollup["options"]["target_field_id"], price["id"]);
    assert_eq!(rollup["options"]["expression"], "SUM(values)");
    assert_eq!(field(t1, "N")["options"]["link_field_id"], orders["id"]);
    // self link stays inside the copied table
    let parent = field(t2, "Parent");
    assert_eq!(parent["options"]["linked_table_id"], t2["id"]);
    assert_eq!(
        parent["options"]["inverse_field_id"],
        field(t2, "Orders")["id"]
    );
    assert!(assert_link_pairs_consistent(&copy) >= 4);

    // formulas keep their {fldXXX} references pointing at the copy
    let copy_formula_expr: String = {
        let table_id = sid(&t2["id"]).to_string();
        sql(&r.f.app, move |tx| {
            tx.query_row(
                "SELECT options FROM fields WHERE table_id = ?1 AND name = 'Double'",
                [&table_id],
                |row| row.get(0),
            )
        })
    };
    let expr = serde_json::from_str::<Value>(&copy_formula_expr).unwrap();
    assert_eq!(expr["expression"], format!("{{{}}} * 2", sid(&price["id"])));
    assert!(!sid(&expr["expression"]).contains(sid(&r.price["id"])));
    assert_ne!(sid(&field(t2, "Double")["id"]), r.double_id);

    // select choices: fresh ids, same names and colours
    let status = field(t1, "Status");
    let old_status = &r.status;
    for (new, old) in status["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .zip(old_status["options"]["choices"].as_array().unwrap())
    {
        assert_ne!(new["id"], old["id"]);
        assert_eq!(new["name"], old["name"]);
        assert_eq!(new["color"], old["color"]);
    }

    // view configs: filter operand (a choice id), sorts, hidden fields, widths, summaries
    let grid = view(t1, "Grid view");
    let todo = &status["options"]["choices"][0]["id"];
    assert_eq!(
        grid["config"]["filter"]["items"][0]["field_id"],
        status["id"]
    );
    assert_eq!(grid["config"]["filter"]["items"][0]["value"], json!([todo]));
    assert_eq!(
        grid["config"]["sorts"][0]["field_id"],
        field(t1, "Qty")["id"]
    );
    assert_eq!(grid["config"]["sorts"][0]["direction"], "desc");
    assert_eq!(
        grid["config"]["hidden_fields"],
        json!([field(t1, "Tags")["id"]])
    );
    assert_eq!(
        grid["config"]["field_widths"][sid(&field(t1, "Qty")["id"])],
        120
    );
    assert_eq!(
        grid["config"]["summaries"][sid(&field(t1, "Qty")["id"])],
        "sum"
    );
    let board = view(t1, "Board");
    assert_eq!(board["config"]["kanban"]["stack_field_id"], status["id"]);
    assert_eq!(board["config"]["kanban"]["stack_order"], json!([todo]));
    let intake_fields: Vec<&str> = view(t1, "Intake")["config"]["form"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| sid(&f["field_id"]))
        .collect();
    let copy_field_ids: HashSet<&str> = t1["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| sid(&f["id"]))
        .collect();
    assert!(
        !intake_fields.is_empty() && intake_fields.iter().all(|id| copy_field_ids.contains(id))
    );
}

#[tokio::test]
async fn personal_views_are_copied_only_for_the_person_copying() {
    let r = rich_base().await;
    let copy = duplicate(&r, json!({ "include_records": false })).await;
    let t1 = table(&copy, "Table 1");
    let names: Vec<&str> = t1["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| sid(&v["name"]))
        .collect();
    assert_eq!(
        names,
        ["Default grid", "Grid view", "Board", "Intake", "Mine"]
    );
    assert_eq!(view(t1, "Default grid")["is_default"], true);
    assert_eq!(view(t1, "Grid view")["is_default"], false);
    assert_eq!(view(t1, "Mine")["personal"], true);
    assert_eq!(view(t1, "Grid view")["personal"], false);
    // the other user's personal view did not leak into the copy
    let copy_id = sid(&copy["id"]).to_string();
    let n = count(
        &r.f.app,
        "SELECT count(*) FROM views v JOIN tables t ON t.id = v.table_id WHERE t.base_id = ?1 AND v.name = 'Theirs'",
        &copy_id,
    );
    assert_eq!(n, 0);
    // and the owner's personal view is owned by the owner
    let owner = r.f.owner.user_id.clone().unwrap();
    let owned = count(
        &r.f.app,
        &format!(
            "SELECT count(*) FROM views v JOIN tables t ON t.id = v.table_id WHERE t.base_id = ?1 AND v.name = 'Mine' AND v.personal_owner_id = '{owner}'"
        ),
        &copy_id,
    );
    assert_eq!(owned, 1);
}

#[tokio::test]
async fn duplicate_with_records_remaps_data_and_keeps_links_consistent() {
    let r = rich_base().await;
    let source_before = dump_records(&r.f.app, &r.f.base_id);
    let copy = duplicate(&r, json!({ "include_records": true })).await;
    let copy_id = sid(&copy["id"]).to_string();
    let (t1, t2) = (table(&copy, "Table 1"), table(&copy, "Orders"));

    let records = dump_records(&r.f.app, &copy_id);
    // 5 live source records minus nothing: r1, r2, o1, o2 (the trashed o3 is not copied)
    assert_eq!(records.len(), 4);
    assert!(records.values().all(|(_, _, deleted)| deleted.is_none()));
    // fresh ids
    assert!(records.keys().all(|id| !source_before.contains_key(id)));

    let by_name = |table: &Value, name: &str| -> (String, Value) {
        let primary = sid(&table["primary_field_id"]);
        records
            .iter()
            .find(|(_, (t, data, _))| t == sid(&table["id"]) && data[primary] == name)
            .map(|(id, (_, data, _))| (id.clone(), data.clone()))
            .unwrap_or_else(|| panic!("no record {name}"))
    };
    let (r1, r1d) = by_name(t1, "Alice");
    let (_, r2d) = by_name(t1, "Bob");
    let (o1, o1d) = by_name(t2, "Order 1");
    let (o2, o2d) = by_name(t2, "Order 2");

    let fid = |t: &Value, n: &str| sid(&field(t, n)["id"]).to_string();
    let choice = |t: &Value, n: &str, i: usize| field(t, n)["options"]["choices"][i]["id"].clone();
    // editable cells: keys are copy field ids, choices are copy choices
    assert_eq!(r1d[fid(t1, "Status")], choice(t1, "Status", 0));
    assert_eq!(
        r1d[fid(t1, "Tags")],
        json!([choice(t1, "Tags", 0), choice(t1, "Tags", 1)])
    );
    assert_eq!(r1d[fid(t1, "Qty")], 3);
    assert_eq!(r2d[fid(t1, "Status")], choice(t1, "Status", 1));
    // link arrays are remapped; the link to a trashed record is dropped
    assert_eq!(r1d[fid(t1, "Orders")], json!([o1, o2]));
    assert!(r2d.get(fid(t1, "Orders")).is_none());
    assert_eq!(o1d[fid(t2, "Table 1")], json!([r1]));
    assert_eq!(o2d[fid(t2, "Table 1")], json!([r1]));
    assert_eq!(o1d[fid(t2, "Parent")], json!([o2]));
    assert_eq!(
        o2d[sid(&field(t2, "Parent")["options"]["inverse_field_id"])],
        json!([o1])
    );
    // materialized computed values travel with the record
    assert_eq!(r1d[fid(t1, "Prices")], json!([10, 20]));
    assert_eq!(r1d[fid(t1, "N")], 2);
    // no source id remains anywhere in the copy's data
    let mut strings = Vec::new();
    records
        .values()
        .for_each(|(_, d, _)| ids_in(d, &mut strings));
    let src: HashSet<&String> = source_before.keys().collect();
    assert!(
        strings.iter().all(|s| !src.contains(s)),
        "source record ids leaked into the copy"
    );
    let src_fields = schema_ids(&r.f.schema().await);
    let mut keys = Vec::new();
    records
        .values()
        .for_each(|(_, d, _)| keys.extend(d.as_object().unwrap().keys().cloned()));
    assert!(
        keys.iter().all(|k| !src_fields.contains(k)),
        "source field ids leaked into record keys"
    );

    assert!(assert_link_arrays_consistent(&copy, &records) >= 6);

    // the source is untouched, trashed record included
    assert_eq!(dump_records(&r.f.app, &r.f.base_id), source_before);
    assert_eq!(source_before[&r.o3_trashed].2, Some(5));
}

#[tokio::test]
async fn autonumbers_and_order_are_preserved() {
    let r = rich_base().await;
    let copy = duplicate(&r, json!({ "include_records": true })).await;
    let copy_id = sid(&copy["id"]).to_string();
    let rows = |base: &str, table: &str| -> Vec<(i64, f64)> {
        let (b, t) = (base.to_string(), table.to_string());
        sql(&r.f.app, move |tx| {
            let mut s = tx.prepare(
                "SELECT r.autonumber, r.position FROM records r JOIN tables t ON t.id = r.table_id
                 WHERE t.base_id = ?1 AND t.name = ?2 AND r.deleted_at IS NULL ORDER BY r.position",
            )?;
            let v = s
                .query_map([&b, &t], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(v)
        })
    };
    for name in ["Table 1", "Orders"] {
        assert_eq!(rows(&r.f.base_id, name), rows(&copy_id, name), "{name}");
    }
    let next = |base: &str, table: &str| -> i64 {
        let (b, t) = (base.to_string(), table.to_string());
        sql(&r.f.app, move |tx| {
            tx.query_row(
                "SELECT next_autonumber FROM tables WHERE base_id = ?1 AND name = ?2",
                [&b, &t],
                |row| row.get(0),
            )
        })
    };
    assert_eq!(next(&r.f.base_id, "Table 1"), next(&copy_id, "Table 1"));
    // without records a copy starts counting from 1
    let empty = duplicate(&r, json!({})).await;
    assert_eq!(next(sid(&empty["id"]), "Table 1"), 1);
}

#[tokio::test]
async fn attachments_are_copied_so_deleting_the_source_cannot_break_the_copy() {
    let r = rich_base().await;
    let copy = duplicate(&r, json!({ "include_records": true })).await;
    let copy_id = sid(&copy["id"]).to_string();
    let t1 = table(&copy, "Table 1");
    let records = dump_records(&r.f.app, &copy_id);
    let (_, data, _) = records
        .values()
        .find(|(t, d, _)| t == sid(&t1["id"]) && d[sid(&t1["primary_field_id"])] == "Alice")
        .unwrap();
    let new_att = &data[sid(&field(t1, "Files")["id"])][0];
    assert_ne!(new_att["id"], r.att_id.as_str());
    assert_eq!(new_att["filename"], "doc.pdf");
    let nid = sid(&new_att["id"]).to_string();
    let row: (String, String) = sql(&r.f.app, |tx| {
        tx.query_row(
            "SELECT sha256, base_id FROM attachments WHERE id = ?1",
            [&nid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    });
    assert_eq!(row, ("abc123".to_string(), copy_id));
    // the source row is still there and still belongs to the source
    assert_eq!(
        count(
            &r.f.app,
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id = (SELECT id FROM bases WHERE name = 'CRM')",
            &r.att_id
        ),
        1
    );
}

#[tokio::test]
async fn duplicating_requires_creator_on_the_base_and_its_workspace() {
    let r = rich_base().await;
    let f = &r.f;
    let url = format!("/api/bases/{}/duplicate", f.base_id);
    for role in ALL_ROLES {
        let u = f.member(&format!("{}-ws@example.com", role.as_str()), role);
        let res = f.app.post(&u, &url, json!({})).await;
        assert_eq!(
            res.status.as_u16(),
            if role >= Role::Creator { 201 } else { 403 },
            "workspace role {role:?}"
        );
    }
    // a creator limited to this base may copy it, and can open the copy
    let guest = f.base_guest("guest@example.com", Role::Creator);
    let res = f.app.post(&guest, &url, json!({})).await;
    res.assert_status(201);
    f.app
        .get(
            &guest,
            &format!("/api/bases/{}", res.body["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
    // a limited editor may not
    let ed = f.base_guest("ed-guest@example.com", Role::Editor);
    f.app.post(&ed, &url, json!({})).await.assert_status(403);
    // outsiders
    let outsider = f.app.user("o@example.com", "O");
    f.app
        .post(&outsider, &url, json!({}))
        .await
        .assert_status(404);
    // tokens are for the API, not workspace management
    let token = token_client(&f.app, &f.owner, true);
    f.app.post(&token, &url, json!({})).await.assert_status(403);
    // bad names
    f.app
        .post(&f.owner, &url, json!({ "name": "  " }))
        .await
        .assert_status(400);
    // the body is optional
    f.app
        .request(&f.owner, "POST", &url, None)
        .await
        .assert_status(201);
}

#[tokio::test]
async fn copies_are_independent_of_the_source() {
    let r = rich_base().await;
    let copy = duplicate(&r, json!({ "include_records": true })).await;
    let copy_id = sid(&copy["id"]).to_string();
    // delete a field and a table in the copy; the source schema and data stay put
    let before = r.f.schema().await;
    let records_before = dump_records(&r.f.app, &r.f.base_id);
    let t1 = table(&copy, "Table 1");
    r.f.app
        .delete(
            &r.f.owner,
            &format!("/api/fields/{}", sid(&field(t1, "Qty")["id"])),
        )
        .await
        .assert_status(200);
    r.f.app
        .delete(
            &r.f.owner,
            &format!("/api/tables/{}", sid(&table(&copy, "Orders")["id"])),
        )
        .await
        .assert_status(200);
    r.f.app
        .delete(&r.f.owner, &format!("/api/bases/{copy_id}"))
        .await
        .assert_status(200);
    assert_eq!(r.f.schema().await, before);
    assert_eq!(dump_records(&r.f.app, &r.f.base_id), records_before);
}
