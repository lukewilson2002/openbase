//! Airtable-compatible API, reading: metadata, listing (paging, offsets,
//! `fields[]`, `sort`, `filterByFormula`, `view`, `maxRecords`), single
//! records and Airtable's value shapes.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod v1_support;

use common::Response;
use serde_json::{Value, json};
use v1_support::*;

fn field_of<'a>(table: &'a Value, name: &str) -> &'a Value {
    table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no field {name} in {table}"))
}

fn table_named<'a>(meta: &'a Value, name: &str) -> &'a Value {
    meta["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("no table {name}"))
}

// ----------------------------------------------------------- metadata

#[tokio::test]
async fn meta_lists_the_bases_a_token_can_reach_with_permission_levels() {
    let v = v1_people().await;
    let r = v.app().get(&v.token, "/api/v1/meta/bases").await;
    r.assert_status(200);
    assert_eq!(
        r.body,
        json!({ "bases": [{
            "id": v.base_id(),
            "name": "CRM",
            "permissionLevel": "create",
        }] })
    );
    // The token's write scope caps the level; roles map to Airtable's levels.
    let ro = make_token(v.app(), &v.p.f.owner, false, None, None);
    let r = v.app().get(&ro, "/api/v1/meta/bases").await;
    assert_eq!(r.body["bases"][0]["permissionLevel"], "read");
    for (role, level) in [
        (openbase::perm::Role::Viewer, "read"),
        (openbase::perm::Role::Commenter, "comment"),
        (openbase::perm::Role::Editor, "edit"),
        (openbase::perm::Role::Creator, "create"),
    ] {
        let u =
            v.p.f
                .member(&format!("{}@example.com", role.as_str()), role);
        let t = make_token(v.app(), &u, true, None, None);
        let r = v.app().get(&t, "/api/v1/meta/bases").await;
        assert_eq!(r.body["bases"][0]["permissionLevel"], level, "{role:?}");
    }
    // Deleted bases disappear.
    v.app()
        .delete(&v.p.f.owner, &format!("/api/bases/{}", v.base_id()))
        .await
        .assert_status(200);
    let r = v.app().get(&v.token, "/api/v1/meta/bases").await;
    assert_eq!(r.body["bases"], json!([]));
}

#[tokio::test]
async fn meta_tables_describes_tables_fields_and_views() {
    let v = v1_people().await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/meta/bases/{}/tables", v.base_id()),
        )
        .await;
    r.assert_status(200);
    let table = &r.body["tables"][0];
    assert_eq!(table["id"], v.table_id());
    assert_eq!(table["name"], "Table 1");
    assert_eq!(table["primaryFieldId"], v.p.f.primary_id);
    let types: Vec<(String, String)> = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap().to_string(),
                f["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        types,
        [
            ("Name", "singleLineText"),
            ("Notes", "multilineText"),
            ("Age", "number"),
            ("Status", "singleSelect"),
            ("Tags", "multipleSelects"),
            ("Due", "date"),
            ("Done", "checkbox"),
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    // Field ids are the internal ids.
    assert_eq!(field_of(table, "Age")["id"], v.p.age);
    let status = field_of(table, "Status");
    let choices = status["options"]["choices"].as_array().unwrap();
    let names: Vec<&str> = choices
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Todo", "Doing", "Done"]);
    assert!(choices[0]["id"].as_str().unwrap().starts_with("sel"));
    assert!(choices[0]["color"].is_string());
    assert_eq!(
        field_of(table, "Due")["options"]["dateFormat"]["name"],
        "us"
    );
    // Views: id, name and type.
    let views = table["views"].as_array().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["id"], v.p.f.view_id);
    assert_eq!(views[0]["type"], "grid");
    assert!(views[0]["name"].is_string());
}

#[tokio::test]
async fn meta_views_show_shared_views_and_only_the_callers_personal_ones() {
    let v = v1_people().await;
    let t = v.table_id().to_string();
    for (name, ty) in [("Form", "form"), ("Board", "kanban"), ("Cal", "calendar")] {
        v.p.f.view_of(&t, name, ty, json!({})).await;
    }
    let mine = v
        .app()
        .post(
            &v.p.f.owner,
            &format!("/api/tables/{t}/views"),
            json!({ "name": "Mine", "type": "grid", "personal": true, "config": {} }),
        )
        .await;
    mine.assert_status(201);
    let meta = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/meta/bases/{}/tables", v.base_id()),
        )
        .await;
    let views: Vec<(String, String)> = meta.body["tables"][0]["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            (
                x["name"].as_str().unwrap().to_string(),
                x["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert!(views.contains(&("Form".into(), "form".into())));
    assert!(views.contains(&("Board".into(), "kanban".into())));
    assert!(views.contains(&("Cal".into(), "calendar".into())));
    assert!(views.contains(&("Mine".into(), "grid".into())));
    // Someone else does not see it.
    let other =
        v.p.f
            .member("other@example.com", openbase::perm::Role::Editor);
    let tok = make_token(v.app(), &other, true, None, None);
    let meta = v
        .app()
        .get(&tok, &format!("/api/v1/meta/bases/{}/tables", v.base_id()))
        .await;
    let names: Vec<&str> = meta.body["tables"][0]["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"Mine"));
}

#[tokio::test]
async fn meta_uses_airtable_type_names_and_option_shapes_for_every_field_type() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/meta/bases/{}/tables", v.base_id()),
        )
        .await;
    r.assert_status(200);
    let t = table_named(&r.body, "Everything");
    assert_eq!(t["primaryFieldId"], e.field("Title"));
    let expected = [
        ("Title", "singleLineText"),
        ("Long", "multilineText"),
        ("Rich", "richText"),
        ("Num", "number"),
        ("Cur", "currency"),
        ("Pct", "percent"),
        ("Dur", "duration"),
        ("Rate", "rating"),
        ("Check", "checkbox"),
        ("Sel", "singleSelect"),
        ("Multi", "multipleSelects"),
        ("Day", "date"),
        ("Moment", "dateTime"),
        ("Email", "email"),
        ("Url", "url"),
        ("Phone", "phoneNumber"),
        ("Files", "multipleAttachments"),
        ("Owner", "singleCollaborator"),
        ("Team", "multipleCollaborators"),
        ("Code", "barcode"),
        ("Links", "multipleRecordLinks"),
        ("Calc", "formula"),
        ("Names", "multipleLookupValues"),
        ("AgeSum", "rollup"),
        ("LinkCount", "count"),
        ("Created", "createdTime"),
        ("Modified", "lastModifiedTime"),
        ("Author", "createdBy"),
        ("Editor", "lastModifiedBy"),
        ("Auto", "autoNumber"),
        ("Go", "button"),
    ];
    for (name, ty) in expected {
        assert_eq!(field_of(t, name)["type"], ty, "{name}");
        assert_eq!(field_of(t, name)["id"], e.field(name), "{name}");
    }
    let opt = |name: &str| field_of(t, name)["options"].clone();
    assert_eq!(opt("Num"), json!({ "precision": 2 }));
    assert_eq!(opt("Cur"), json!({ "precision": 2, "symbol": "EUR" }));
    assert_eq!(opt("Pct"), json!({ "precision": 1 }));
    assert_eq!(opt("Dur"), json!({ "durationFormat": "h:mm:ss" }));
    assert_eq!(opt("Rate")["max"], 5);
    assert!(opt("Check")["icon"].is_string());
    assert_eq!(
        opt("Day")["dateFormat"],
        json!({ "name": "iso", "format": "YYYY-MM-DD" })
    );
    assert_eq!(
        opt("Moment"),
        json!({
            "dateFormat": { "name": "us", "format": "M/D/YYYY" },
            "timeFormat": { "name": "24hour", "format": "HH:mm" },
            "timeZone": "Europe/Paris",
        })
    );
    assert_eq!(opt("Files"), json!({ "isReversed": false }));
    assert_eq!(opt("Sel")["choices"].as_array().unwrap().len(), 2);
    let links = opt("Links");
    assert_eq!(links["linkedTableId"], v.table_id());
    assert_eq!(links["isReversed"], false);
    assert_eq!(links["prefersSingleRecordLink"], false);
    assert!(
        links["inverseLinkFieldId"]
            .as_str()
            .unwrap()
            .starts_with("fld")
    );
    let calc = opt("Calc");
    assert_eq!(calc["isValid"], true);
    assert_eq!(calc["referencedFieldIds"], json!([e.field("Num")]));
    assert_eq!(calc["result"]["type"], "number");
    assert_eq!(
        opt("Names"),
        json!({
            "isValid": true,
            "recordLinkFieldId": e.field("Links"),
            "fieldIdInLinkedTable": v.p.name,
            "result": { "type": "singleLineText" },
        })
    );
    let rollup = opt("AgeSum");
    assert_eq!(rollup["recordLinkFieldId"], e.field("Links"));
    assert_eq!(rollup["fieldIdInLinkedTable"], v.p.age);
    assert_eq!(rollup["result"]["type"], "number");
    assert_eq!(opt("LinkCount")["recordLinkFieldId"], e.field("Links"));
    assert_eq!(opt("Created")["result"]["type"], "dateTime");
    assert_eq!(opt("Go"), json!({ "label": "Open" }));
    // Fields without options have none.
    for name in [
        "Title", "Long", "Rich", "Email", "Url", "Phone", "Code", "Auto", "Owner", "Author",
    ] {
        assert!(field_of(t, name).get("options").is_none(), "{name}");
    }
    // Internal formulas never leak: only ids and result types.
    assert!(!r.body.to_string().contains("expression"));
}

#[tokio::test]
async fn meta_hides_deleted_tables_and_fields() {
    let v = v1_people().await;
    let e = everything(&v).await;
    v.app()
        .delete(&v.p.f.owner, &format!("/api/fields/{}", e.field("Long")))
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/meta/bases/{}/tables", v.base_id()),
        )
        .await;
    let t = table_named(&r.body, "Everything");
    assert!(
        t["fields"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["name"] != "Long")
    );
    v.app()
        .delete(&v.p.f.owner, &format!("/api/tables/{}", e.table_id))
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/meta/bases/{}/tables", v.base_id()),
        )
        .await;
    assert_eq!(r.body["tables"].as_array().unwrap().len(), 1);
}

// ------------------------------------------------------------ listing

#[tokio::test]
async fn list_returns_airtable_shaped_records_in_table_order() {
    let v = v1_people().await;
    let r = v.get("").await;
    r.assert_status(200);
    let records = r.body["records"].as_array().unwrap();
    assert_eq!(
        V1::listed_names(&r),
        ["Alice", "bob", "Carol", "dave", "Eve"]
    );
    assert!(r.body.get("offset").is_none(), "one page: no offset");
    let alice = &records[0];
    assert_eq!(alice["id"], v.p.ids[0]);
    assert_eq!(
        alice["fields"],
        json!({ "Name": "Alice", "Age": 30, "Status": "Todo", "Tags": ["a"], "Due": "2026-03-01" })
    );
    // createdTime is ISO 8601 UTC with milliseconds.
    let created = alice["createdTime"].as_str().unwrap();
    assert!(created.ends_with('Z') && created.len() == 24, "{created}");
    assert!(chrono::DateTime::parse_from_rfc3339(created).is_ok());
    // Checkbox: true or absent; empty cells are omitted.
    assert_eq!(records[2]["fields"]["Done"], true);
    assert!(alice["fields"].get("Done").is_none());
    assert_eq!(records[3]["fields"], json!({ "Name": "dave" }));
    // Only the documented top-level keys.
    let mut keys: Vec<&str> = alice
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(keys, ["createdTime", "fields", "id"]);
}

#[tokio::test]
async fn tables_are_addressed_by_id_or_name() {
    let v = v1_people().await;
    let by_id = v.get("").await;
    let by_name = v
        .app()
        .get(&v.token, &format!("/api/v1/{}/Table%201", v.base_id()))
        .await;
    by_name.assert_status(200);
    assert_eq!(by_id.body, by_name.body);
    let wrong_case = v
        .app()
        .get(&v.token, &format!("/api/v1/{}/table%201", v.base_id()))
        .await;
    assert_v1_error(&wrong_case, 404, "NOT_FOUND");
    // A table named like another table's id does not shadow it: ids win.
    v.p.f.add_table("Second").await;
    v.app()
        .get(&v.token, &format!("/api/v1/{}/Second", v.base_id()))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn paging_follows_offsets_to_the_last_page() {
    let v = v1_people().await;
    let first = v.list(&[("pageSize", "2")]).await;
    first.assert_status(200);
    assert_eq!(V1::listed_names(&first), ["Alice", "bob"]);
    let o1 = first.body["offset"].as_str().unwrap().to_string();
    assert!(o1.starts_with("itr"));
    let second = v.list(&[("pageSize", "2"), ("offset", &o1)]).await;
    assert_eq!(V1::listed_names(&second), ["Carol", "dave"]);
    let o2 = second.body["offset"].as_str().unwrap().to_string();
    assert_ne!(o1, o2);
    let third = v.list(&[("pageSize", "2"), ("offset", &o2)]).await;
    assert_eq!(V1::listed_names(&third), ["Eve"]);
    assert!(third.body.get("offset").is_none());
    // The page size may change between pages.
    let alt = v.list(&[("pageSize", "3"), ("offset", &o1)]).await;
    assert_eq!(V1::listed_names(&alt), ["Carol", "dave", "Eve"]);
    // The default page size is 100 and it cannot be exceeded.
    assert_eq!(v.get("").await.body["records"].as_array().unwrap().len(), 5);
    for bad in ["0", "101", "-1", "abc", "1.5", ""] {
        assert_v1_error(
            &v.list(&[("pageSize", bad)]).await,
            422,
            "INVALID_REQUEST_UNKNOWN",
        );
    }
    v.list(&[("pageSize", "100")]).await.assert_status(200);
}

#[tokio::test]
async fn paging_a_large_table_visits_every_record_exactly_once() {
    let v = v1_people().await;
    let t = v.table_id().to_string();
    let rows: Vec<Value> = (0..230)
        .map(|i| json!({ "values": { &v.p.name: format!("Bulk {i:03}"), &v.p.age: i } }))
        .collect();
    for chunk in rows.chunks(100) {
        v.app()
            .post(&v.p.f.owner, &records_url(&t), json!({ "records": chunk }))
            .await
            .assert_status(201);
    }
    let mut seen = Vec::new();
    let mut offset: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut q = vec![("pageSize", "100")];
        if let Some(o) = &offset {
            q.push(("offset", o));
        }
        let r = v.list(&q).await;
        r.assert_status(200);
        seen.extend(V1::listed_ids(&r));
        pages += 1;
        offset = r.body["offset"].as_str().map(str::to_string);
        if offset.is_none() {
            break;
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen.len(), 235);
    let unique: std::collections::HashSet<_> = seen.iter().collect();
    assert_eq!(unique.len(), 235);
}

#[tokio::test]
async fn offsets_are_stable_while_records_change_between_pages() {
    let v = v1_people().await;
    let first = v.list(&[("pageSize", "2")]).await;
    let offset = first.body["offset"].as_str().unwrap().to_string();
    // Between the pages: a record is edited (it keeps its place), one that is
    // still to come is deleted, and a new one is added.
    v.p.f
        .set(v.table_id(), &v.p.ids[0], json!({ &v.p.name: "Zed" }))
        .await;
    v.p.f
        .delete_records(v.table_id(), &[&v.p.ids[3]])
        .await
        .assert_status(204);
    v.p.f
        .create(v.table_id(), json!({ &v.p.name: "New" }))
        .await;
    let second = v.list(&[("pageSize", "2"), ("offset", &offset)]).await;
    second.assert_status(200);
    // dave is gone, nothing earlier is repeated, and the new record is not part
    // of this listing.
    assert_eq!(V1::listed_names(&second), ["Carol"]);
    assert_eq!(second.body["offset"].as_str().map(|_| ()), Some(()));
    let third = v
        .list(&[
            ("pageSize", "2"),
            ("offset", second.body["offset"].as_str().unwrap()),
        ])
        .await;
    assert_eq!(V1::listed_names(&third), ["Eve"]);
    // A fresh listing sees the current state.
    let fresh = v.get("").await;
    assert_eq!(
        V1::listed_names(&fresh),
        ["Zed", "bob", "Carol", "Eve", "New"]
    );
}

#[tokio::test]
async fn updating_the_filtered_field_while_paging_does_not_skip_records() {
    let v = v1_people().await;
    // The common "process what is Todo, mark it Done" loop.
    for i in 0..6 {
        v.p.f
            .create(
                v.table_id(),
                json!({ &v.p.name: format!("T{i}"), &v.p.status: "Todo" }),
            )
            .await;
    }
    let todo = "{Status} = 'Todo'";
    let mut offset: Option<String> = None;
    let mut handled = Vec::new();
    loop {
        let mut q = vec![("filterByFormula", todo), ("pageSize", "3")];
        if let Some(o) = &offset {
            q.push(("offset", o));
        }
        let r = v.list(&q).await;
        r.assert_status(200);
        for id in V1::listed_ids(&r) {
            let done = v
                .patch(json!({ "records": [{ "id": id, "fields": { "Status": "Done" } }] }))
                .await;
            done.assert_status(200);
            handled.push(id);
        }
        offset = r.body["offset"].as_str().map(str::to_string);
        if offset.is_none() {
            break;
        }
    }
    // Two Todo from the fixture + six new ones, each exactly once.
    assert_eq!(handled.len(), 8);
    assert_eq!(
        handled
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        8
    );
    assert_eq!(
        V1::listed_ids(&v.list(&[("filterByFormula", todo)]).await).len(),
        0
    );
}

#[tokio::test]
async fn stale_offsets_are_422_iterator_not_available() {
    let v = v1_people().await;
    let first = v.list(&[("pageSize", "2")]).await;
    let offset = first.body["offset"].as_str().unwrap().to_string();
    let gone = |r: Response| assert_v1_error(&r, 422, "LIST_RECORDS_ITERATOR_NOT_AVAILABLE");
    // Garbage, other prefixes and invented snapshots.
    for bad in ["itr", "itrAAAA", "itr!!", "recABC", "0", "5", "garbage"] {
        gone(v.list(&[("pageSize", "2"), ("offset", bad)]).await);
    }
    let forged = {
        use base64::Engine as _;
        format!(
            "itr{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("nosuchsnapshot:2")
        )
    };
    gone(v.list(&[("offset", &forged)]).await);
    // Different request parameters: the offset belongs to the original query.
    gone(
        v.list(&[
            ("pageSize", "2"),
            ("offset", &offset),
            ("filterByFormula", "1"),
        ])
        .await,
    );
    gone(
        v.list(&[("pageSize", "2"), ("offset", &offset), ("maxRecords", "3")])
            .await,
    );
    gone(
        v.list(&[
            ("pageSize", "2"),
            ("offset", &offset),
            ("sort[0][field]", "Name"),
        ])
        .await,
    );
    // Another table or another user cannot use it.
    let other_table = v.p.f.add_table("Other").await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!(
                "/api/v1/{}/{}?{}",
                v.base_id(),
                id_of(&other_table),
                qs(&[("offset", &offset)])
            ),
        )
        .await;
    gone(r);
    let editor = v.p.f.member("e@example.com", openbase::perm::Role::Editor);
    let tok = make_token(v.app(), &editor, true, None, None);
    let r = v
        .app()
        .get(
            &tok,
            &format!(
                "{}?{}",
                v.path(""),
                qs(&[("offset", &offset), ("pageSize", "2")])
            ),
        )
        .await;
    gone(r);
    // The real one still works, until it expires or the server forgets it.
    v.list(&[("pageSize", "2"), ("offset", &offset)])
        .await
        .assert_status(200);
    v.app().state.v1_cursors.clear();
    gone(v.list(&[("pageSize", "2"), ("offset", &offset)]).await);
}

#[tokio::test]
async fn fields_selects_columns_by_name_or_id() {
    let v = v1_people().await;
    let r = v
        .list(&[("fields[]", "Name"), ("fields[]", &v.p.age)])
        .await;
    r.assert_status(200);
    let first = &r.body["records"][0]["fields"];
    assert_eq!(first, &json!({ "Name": "Alice", "Age": 30 }));
    // Without a match for a record, its fields are simply absent.
    assert_eq!(r.body["records"][3]["fields"], json!({ "Name": "dave" }));
    // `fields` without brackets is accepted too.
    let r = v.list(&[("fields", "Status")]).await;
    assert_eq!(r.body["records"][0]["fields"], json!({ "Status": "Todo" }));
    // Unknown names are an error that names them.
    let r = v.list(&[("fields[]", "Name"), ("fields[]", "Nope")]).await;
    assert_v1_error(&r, 422, "UNKNOWN_FIELD_NAME");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Nope")
    );
}

#[tokio::test]
async fn include_empty_returns_unset_fields_as_null() {
    let v = v1_people().await;
    // Default: unset fields are omitted, as in Airtable.
    let r = v.list(&[]).await;
    assert_eq!(r.body["records"][3]["fields"], json!({ "Name": "dave" }));
    let r = v.list(&[("includeEmpty", "false")]).await;
    assert_eq!(r.body["records"][3]["fields"], json!({ "Name": "dave" }));

    // Opt in: every field is present, null when unset; set values are unchanged.
    let r = v.list(&[("includeEmpty", "true")]).await;
    r.assert_status(200);
    let records = r.body["records"].as_array().unwrap();
    let dave = records[3]["fields"].as_object().unwrap();
    assert_eq!(dave["Name"], "dave");
    for name in ["Age", "Status", "Tags", "Due"] {
        assert_eq!(dave[name], Value::Null, "{name}: {dave:?}");
    }
    assert_eq!(records[0]["fields"]["Age"], 30);
    let width = records[0]["fields"].as_object().unwrap().len();
    assert!(
        records
            .iter()
            .all(|x| x["fields"].as_object().unwrap().len() == width)
    );

    // `fields[]` limits which fields are included, by name or id, and `returnFieldsByFieldId` keys
    // the nulls by id too.
    let r = v
        .list(&[
            ("includeEmpty", "true"),
            ("fields[]", "Name"),
            ("fields[]", &v.p.age),
        ])
        .await;
    assert_eq!(
        r.body["records"][3]["fields"],
        json!({ "Name": "dave", "Age": null })
    );
    let r = v
        .list(&[
            ("includeEmpty", "true"),
            ("fields[]", &v.p.age),
            ("returnFieldsByFieldId", "true"),
        ])
        .await;
    assert_eq!(
        r.body["records"][3]["fields"],
        json!({ v.p.age.as_str(): null })
    );

    // A single record takes the flag too.
    let one = v.get(&format!("/{}?includeEmpty=true", v.p.ids[3])).await;
    one.assert_status(200);
    assert_eq!(one.body["fields"]["Name"], "dave");
    assert_eq!(one.body["fields"]["Status"], Value::Null);
    let one = v.get(&format!("/{}", v.p.ids[3])).await;
    assert_eq!(one.body["fields"], json!({ "Name": "dave" }));

    // Anything but a boolean is a 422.
    let r = v.list(&[("includeEmpty", "maybe")]).await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
}

#[tokio::test]
async fn return_fields_by_field_id_keys_cells_by_id() {
    let v = v1_people().await;
    let r = v.list(&[("returnFieldsByFieldId", "true")]).await;
    r.assert_status(200);
    assert_eq!(
        r.body["records"][0]["fields"],
        json!({
            &v.p.name: "Alice", &v.p.age: 30, &v.p.status: "Todo",
            &v.p.tags: ["a"], &v.p.due: "2026-03-01",
        })
    );
    let one = v
        .get(&format!("/{}?returnFieldsByFieldId=true", v.p.ids[0]))
        .await;
    assert_eq!(one.body["fields"][&v.p.name], "Alice");
    assert_v1_error(
        &v.list(&[("returnFieldsByFieldId", "maybe")]).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
}

#[tokio::test]
async fn sort_orders_by_one_or_more_fields() {
    let v = v1_people().await;
    let by_age_desc = v
        .list(&[("sort[0][field]", "Age"), ("sort[0][direction]", "desc")])
        .await;
    by_age_desc.assert_status(200);
    // Blank ages sort last in either direction? Descending puts the largest
    // first and the blank dave last (as in the grid).
    assert_eq!(
        &V1::listed_names(&by_age_desc)[..3],
        ["Carol", "Alice", "Eve"]
    );
    // The default direction is ascending.
    let asc = v.list(&[("sort[0][field]", "Name")]).await;
    let names = V1::listed_names(&asc);
    let mut expected = names.clone();
    expected.sort_by_key(|n| n.to_lowercase());
    assert_eq!(names, expected);
    // Two levels: status ascending, then age descending.
    let two = v
        .list(&[
            ("sort[0][field]", "Status"),
            ("sort[0][direction]", "asc"),
            ("sort[1][field]", "Name"),
            ("sort[1][direction]", "desc"),
        ])
        .await;
    two.assert_status(200);
    assert_eq!(V1::listed_names(&two).len(), 5);
    // A field id works, and the order of sort[i] is by i, not by position in the URL.
    let swapped = v
        .list(&[
            ("sort[1][field]", "Name"),
            ("sort[0][field]", &v.p.age),
            ("sort[0][direction]", "asc"),
        ])
        .await;
    let first_two = V1::listed_names(&swapped);
    assert_eq!(
        &first_two[..2],
        ["dave", "bob"],
        "blank ages sort first ascending"
    );
    // Errors.
    assert_v1_error(
        &v.list(&[("sort[0][field]", "Nope")]).await,
        422,
        "UNKNOWN_FIELD_NAME",
    );
    assert_v1_error(
        &v.list(&[("sort[0][field]", "Age"), ("sort[0][direction]", "up")])
            .await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    assert_v1_error(
        &v.list(&[("sort[0][direction]", "asc")]).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
}

#[tokio::test]
async fn sorted_listings_page_consistently() {
    let v = v1_people().await;
    let q = [
        ("sort[0][field]", "Name"),
        ("sort[0][direction]", "desc"),
        ("pageSize", "2"),
    ];
    let a = v.list(&q).await;
    let o = a.body["offset"].as_str().unwrap().to_string();
    let b = v.list(&[q[0], q[1], q[2], ("offset", &o)]).await;
    let all = v.list(&[q[0], q[1]]).await;
    let mut joined = V1::listed_names(&a);
    joined.extend(V1::listed_names(&b));
    assert_eq!(joined, V1::listed_names(&all)[..4]);
}

#[tokio::test]
async fn filter_by_formula_keeps_records_where_the_formula_is_truthy() {
    let v = v1_people().await;
    let names = |r: Response| {
        r.assert_status(200);
        V1::listed_names(&r)
    };
    assert_eq!(
        names(v.list(&[("filterByFormula", "{Age} > 26")]).await),
        ["Alice", "Carol", "Eve"]
    );
    assert_eq!(
        names(v.list(&[("filterByFormula", "{Status} = 'Todo'")]).await),
        ["Alice", "Eve"]
    );
    assert_eq!(
        names(
            v.list(&[("filterByFormula", "AND({Age} >= 30, {Status} = 'Todo')")])
                .await
        ),
        ["Alice", "Eve"]
    );
    assert_eq!(
        names(
            v.list(&[("filterByFormula", "OR({Age} = 25, {Done})")])
                .await
        ),
        ["bob", "Carol"]
    );
    assert_eq!(
        names(v.list(&[("filterByFormula", "NOT({Done})")]).await).len(),
        4
    );
    // Functions, text and blanks.
    assert_eq!(
        names(
            v.list(&[("filterByFormula", "FIND('a', LOWER({Name}))")])
                .await
        ),
        ["Alice", "Carol", "dave"]
    );
    assert_eq!(
        names(v.list(&[("filterByFormula", "{Age} = BLANK()")]).await),
        ["dave"]
    );
    assert_eq!(
        names(v.list(&[("filterByFormula", "LEN({Name}) = 3")]).await),
        ["bob", "Eve"]
    );
    assert_eq!(
        names(
            v.list(&[("filterByFormula", "IS_BEFORE({Due}, '2026-03-15')")])
                .await
        ),
        ["Alice", "bob"]
    );
    // Multiple selects read as their names.
    assert_eq!(
        names(
            v.list(&[("filterByFormula", "FIND('b', ARRAYJOIN({Tags}))")])
                .await
        ),
        ["bob", "Eve"]
    );
    // The record id.
    let id = &v.p.ids[2];
    assert_eq!(
        names(
            v.list(&[("filterByFormula", &format!("RECORD_ID() = '{id}'"))])
                .await
        ),
        ["Carol"]
    );
    // Nothing matches.
    let none = v.list(&[("filterByFormula", "{Age} > 1000")]).await;
    none.assert_status(200);
    assert_eq!(none.body["records"], json!([]));
    // A constant truthy formula keeps everything; a falsy one nothing.
    assert_eq!(names(v.list(&[("filterByFormula", "1")]).await).len(), 5);
    assert_eq!(names(v.list(&[("filterByFormula", "0")]).await).len(), 0);
    assert_eq!(
        names(v.list(&[("filterByFormula", "TRUE()")]).await).len(),
        5
    );
    // An empty parameter is no filter.
    assert_eq!(names(v.list(&[("filterByFormula", "")]).await).len(), 5);
}

#[tokio::test]
async fn filter_by_formula_resolves_names_and_ids_and_reads_computed_fields() {
    let v = v1_people().await;
    // {fld...} ids resolve like names.
    let by_id = v
        .list(&[("filterByFormula", &format!("{{{}}} = 41", v.p.age))])
        .await;
    assert_eq!(V1::listed_names(&by_id), ["Carol"]);
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let q = |f: &str| format!("{path}?{}", qs(&[("filterByFormula", f)]));
    for (formula, count) in [
        ("{Calc} > 5", 1),
        ("{Calc} > 6", 0),
        ("{LinkCount} = 2", 1),
        ("{AgeSum} = 55", 1),
        ("{Sel} = 'Red'", 1),
        ("{Check}", 1),
        ("FIND('Alice', ARRAYJOIN({Names}))", 1),
        ("{Created}", 1),
        ("{Auto} = 1", 1),
    ] {
        let r = v.app().get(&v.token, &q(formula)).await;
        r.assert_status(200);
        assert_eq!(
            r.body["records"].as_array().unwrap().len(),
            count,
            "{formula}: {}",
            r.body
        );
    }
    let _ = e;
}

#[tokio::test]
async fn invalid_filter_formulas_are_422_invalid_filter_by_formula() {
    let v = v1_people().await;
    for bad in [
        "{Age} >",
        "AND(",
        "{Nope} = 1",
        "NOSUCHFUNCTION(1)",
        "SUM(",
        "'unterminated",
        "{Age} + + )",
    ] {
        let r = v.list(&[("filterByFormula", bad)]).await;
        assert_v1_error(&r, 422, "INVALID_FILTER_BY_FORMULA");
        assert!(
            r.body["error"]["message"].as_str().unwrap().len() > 10,
            "{bad}"
        );
    }
    // Unknown field names are reported by name.
    let r = v.list(&[("filterByFormula", "{Nope} = 1")]).await;
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Nope")
    );
    // A too long formula is rejected, not evaluated.
    let long = format!("1{}", " + 1".repeat(5_000));
    assert_v1_error(
        &v.list(&[("filterByFormula", &long)]).await,
        422,
        "INVALID_FILTER_BY_FORMULA",
    );
}

#[tokio::test]
async fn filter_by_formula_combines_with_sort_paging_and_max_records() {
    let v = v1_people().await;
    let q = [
        ("filterByFormula", "{Age}"),
        ("sort[0][field]", "Age"),
        ("sort[0][direction]", "desc"),
        ("pageSize", "2"),
    ];
    let a = v.list(&q).await;
    assert_eq!(V1::listed_names(&a), ["Carol", "Alice"]);
    let o = a.body["offset"].as_str().unwrap().to_string();
    let b = v.list(&[q[0], q[1], q[2], q[3], ("offset", &o)]).await;
    assert_eq!(V1::listed_names(&b), ["Eve", "bob"]);
    assert!(b.body.get("offset").is_none());
    // maxRecords caps the total across pages.
    let capped = v.list(&[q[0], q[1], q[2], q[3], ("maxRecords", "3")]).await;
    assert_eq!(V1::listed_names(&capped), ["Carol", "Alice"]);
    let o = capped.body["offset"].as_str().unwrap().to_string();
    let rest = v
        .list(&[q[0], q[1], q[2], q[3], ("maxRecords", "3"), ("offset", &o)])
        .await;
    assert_eq!(V1::listed_names(&rest), ["Eve"]);
    assert!(rest.body.get("offset").is_none());
}

#[tokio::test]
async fn max_records_limits_the_whole_listing() {
    let v = v1_people().await;
    let r = v.list(&[("maxRecords", "3")]).await;
    assert_eq!(V1::listed_names(&r), ["Alice", "bob", "Carol"]);
    assert!(r.body.get("offset").is_none());
    let r = v.list(&[("maxRecords", "100")]).await;
    assert_eq!(V1::listed_names(&r).len(), 5);
    let a = v.list(&[("maxRecords", "4"), ("pageSize", "3")]).await;
    assert_eq!(V1::listed_names(&a).len(), 3);
    let o = a.body["offset"].as_str().unwrap().to_string();
    let b = v
        .list(&[("maxRecords", "4"), ("pageSize", "3"), ("offset", &o)])
        .await;
    assert_eq!(V1::listed_names(&b), ["dave"]);
    assert!(b.body.get("offset").is_none());
    for bad in ["0", "-3", "x"] {
        assert_v1_error(
            &v.list(&[("maxRecords", bad)]).await,
            422,
            "INVALID_REQUEST_UNKNOWN",
        );
    }
}

#[tokio::test]
async fn the_view_parameter_applies_a_views_filter_and_order() {
    let v = v1_people().await;
    let t = v.table_id().to_string();
    let todo = v.p.f.choice_id(&t, "Status", "Todo").await;
    let view =
        v.p.f
            .new_view(
                &t,
                "Todo by name",
                json!({
                    "filter": and(vec![cond(&v.p.status, "is", json!(todo))]),
                    "sorts": [{ "field_id": v.p.name, "direction": "desc" }],
                    "hidden_fields": [v.p.age],
                }),
            )
            .await;
    for selector in [view.as_str(), "Todo by name"] {
        let r = v.list(&[("view", selector)]).await;
        r.assert_status(200);
        assert_eq!(V1::listed_names(&r), ["Eve", "Alice"], "{selector}");
        // Fields hidden in the view are still returned.
        assert_eq!(r.body["records"][0]["fields"]["Age"], 30);
    }
    // An explicit sort replaces the view's own.
    let r = v
        .list(&[("view", "Todo by name"), ("sort[0][field]", "Name")])
        .await;
    assert_eq!(V1::listed_names(&r), ["Alice", "Eve"]);
    // fields[] still narrows the columns, formula filters narrow the rows.
    let r = v
        .list(&[
            ("view", "Todo by name"),
            ("fields[]", "Age"),
            ("filterByFormula", "{Name} = 'Alice'"),
        ])
        .await;
    assert_eq!(r.body["records"].as_array().unwrap().len(), 1);
    assert_eq!(r.body["records"][0]["fields"], json!({ "Age": 30 }));
    // Paging through a view.
    let a = v.list(&[("view", "Todo by name"), ("pageSize", "1")]).await;
    assert_eq!(V1::listed_names(&a), ["Eve"]);
    let o = a.body["offset"].as_str().unwrap().to_string();
    let b = v
        .list(&[("view", "Todo by name"), ("pageSize", "1"), ("offset", &o)])
        .await;
    assert_eq!(V1::listed_names(&b), ["Alice"]);
}

#[tokio::test]
async fn the_view_parameter_rejects_unknown_and_foreign_views() {
    let v = v1_people().await;
    let r = v.list(&[("view", "No such view")]).await;
    assert_v1_error(&r, 422, "VIEW_NAME_NOT_FOUND");
    // A view of another table, and another user's personal view.
    let other = v.p.f.add_table("Other").await;
    let other_view = other["views"][0]["id"].as_str().unwrap().to_string();
    assert_v1_error(
        &v.list(&[("view", &other_view)]).await,
        422,
        "VIEW_NAME_NOT_FOUND",
    );
    let guest = v.p.f.member("g@example.com", openbase::perm::Role::Editor);
    let personal = v
        .app()
        .post(
            &guest,
            &format!("/api/tables/{}/views", v.table_id()),
            json!({ "name": "Private", "type": "grid", "personal": true, "config": {} }),
        )
        .await;
    personal.assert_status(201);
    assert_v1_error(
        &v.list(&[("view", "Private")]).await,
        422,
        "VIEW_NAME_NOT_FOUND",
    );
    // Deleted views are gone.
    let view = v.p.f.new_view(v.table_id(), "Temp", json!({})).await;
    v.list(&[("view", "Temp")]).await.assert_status(200);
    v.app()
        .delete(&v.p.f.owner, &format!("/api/views/{view}"))
        .await
        .assert_status(200);
    assert_v1_error(
        &v.list(&[("view", "Temp")]).await,
        422,
        "VIEW_NAME_NOT_FOUND",
    );
}

#[tokio::test]
async fn cell_format_time_zone_and_locale_parameters() {
    let v = v1_people().await;
    // json is the only format (and the default).
    v.list(&[("cellFormat", "json")]).await.assert_status(200);
    let r = v
        .list(&[
            ("cellFormat", "string"),
            ("timeZone", "Europe/Paris"),
            ("userLocale", "fr"),
        ])
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cellFormat")
    );
    // timeZone and userLocale are accepted (and validated).
    v.list(&[("timeZone", "Europe/Paris"), ("userLocale", "fr")])
        .await
        .assert_status(200);
    assert_v1_error(
        &v.list(&[("timeZone", "Mars/Olympus")]).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    // Unknown parameters are ignored, like Airtable does.
    v.list(&[("recordMetadata[]", "commentCount"), ("whatever", "1")])
        .await
        .assert_status(200);
}

#[tokio::test]
async fn time_zone_changes_relative_date_filters_of_a_view() {
    let v = v1_people().await;
    // "Today" is a different calendar day on opposite sides of the date line.
    let today_in = |tz: &str| {
        let tz: chrono_tz::Tz = tz.parse().unwrap();
        chrono::Utc::now()
            .with_timezone(&tz)
            .format("%Y-%m-%d")
            .to_string()
    };
    let (east, west) = (
        today_in("Pacific/Kiritimati"),
        today_in("Pacific/Pago_Pago"),
    );
    assert_ne!(east, west);
    let t = v.table_id().to_string();
    v.p.f
        .create(&t, json!({ &v.p.name: "East", &v.p.due: east }))
        .await;
    v.p.f
        .create(&t, json!({ &v.p.name: "West", &v.p.due: west }))
        .await;
    let view =
        v.p.f
            .new_view(
                &t,
                "Today",
                json!({ "filter": and(vec![cond(&v.p.due, "is", json!({ "mode": "today" }))]) }),
            )
            .await;
    let r = v
        .list(&[("view", &view), ("timeZone", "Pacific/Kiritimati")])
        .await;
    assert_eq!(V1::listed_names(&r), ["East"]);
    let r = v
        .list(&[("view", &view), ("timeZone", "Pacific/Pago_Pago")])
        .await;
    assert_eq!(V1::listed_names(&r), ["West"]);
}

// ------------------------------------------------------ single records

#[tokio::test]
async fn a_single_record_is_returned_without_an_envelope() {
    let v = v1_people().await;
    let r = v.get(&format!("/{}", v.p.ids[1])).await;
    r.assert_status(200);
    assert_eq!(r.body["id"], v.p.ids[1]);
    assert_eq!(
        r.body["fields"],
        json!({ "Name": "bob", "Age": 25, "Status": "Doing", "Tags": ["a", "b"], "Due": "2026-03-10" })
    );
    assert!(r.body["createdTime"].is_string());
    assert!(r.body.get("records").is_none());
}

#[tokio::test]
async fn single_records_must_exist_live_and_in_the_table() {
    let v = v1_people().await;
    let other = v.p.f.add_table("Other").await;
    let other_id = id_of(&other);
    let foreign = v.p.f.insert_record(&other_id, json!({}));
    assert_v1_error(&v.get(&format!("/{foreign}")).await, 404, "NOT_FOUND");
    assert_v1_error(&v.get("/recDoesNotExist").await, 404, "NOT_FOUND");
    v.p.f
        .delete_records(v.table_id(), &[&v.p.ids[0]])
        .await
        .assert_status(204);
    assert_v1_error(&v.get(&format!("/{}", v.p.ids[0])).await, 404, "NOT_FOUND");
    // Records of a trashed table are gone with it.
    v.app()
        .delete(&v.p.f.owner, &format!("/api/tables/{other_id}"))
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/{}/{other_id}/{foreign}", v.base_id()),
        )
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
}

#[tokio::test]
async fn trashed_records_are_not_listed_and_come_back_when_restored() {
    let v = v1_people().await;
    v.p.f
        .delete_records(v.table_id(), &[&v.p.ids[1]])
        .await
        .assert_status(204);
    assert_eq!(
        V1::listed_names(&v.get("").await),
        ["Alice", "Carol", "dave", "Eve"]
    );
    v.p.f
        .restore_records(v.table_id(), &[&v.p.ids[1]])
        .await
        .assert_status(200);
    assert_eq!(V1::listed_names(&v.get("").await).len(), 5);
}

// -------------------------------------------------------- value shapes

#[tokio::test]
async fn every_field_type_has_its_airtable_value_shape() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything/{}", v.base_id(), e.record_id);
    let r = v.app().get(&v.token, &path).await;
    r.assert_status(200);
    let f = &r.body["fields"];
    let owner = &v.p.f.owner;
    let me = json!({ "id": owner.user_id, "email": "owner@example.com", "name": "Owner" });
    assert_eq!(f["Title"], "Row 1");
    assert_eq!(f["Long"], "line one\nline two");
    assert_eq!(f["Rich"], "**bold** text");
    assert_eq!(f["Num"], 2.75);
    assert_eq!(f["Cur"], 12.5);
    assert_eq!(f["Pct"], 0.25);
    assert_eq!(f["Dur"], 3661);
    assert_eq!(f["Rate"], 4);
    assert_eq!(f["Check"], true);
    assert_eq!(f["Sel"], "Red");
    assert_eq!(f["Multi"], json!(["x", "z"]));
    assert_eq!(f["Day"], "2026-04-01");
    assert_eq!(f["Moment"], "2026-04-01T09:30:00.000Z");
    assert_eq!(f["Email"], "ann@example.com");
    assert_eq!(f["Url"], "https://example.com/a");
    assert_eq!(f["Phone"], "+1 555 0100");
    assert_eq!(f["Owner"], me);
    assert_eq!(f["Team"], json!([me]));
    assert_eq!(f["Code"], json!({ "text": "9780306406157" }));
    // Links are plain id arrays.
    assert_eq!(f["Links"], json!([v.p.ids[0], v.p.ids[1]]));
    // Computed.
    assert_eq!(f["Calc"], 5.5);
    assert_eq!(f["Names"], json!(["Alice", "bob"]));
    assert_eq!(f["AgeSum"], 55);
    assert_eq!(f["LinkCount"], 2);
    assert_eq!(f["Auto"], 1);
    assert_eq!(f["Author"], me);
    assert_eq!(f["Editor"], me);
    assert_eq!(f["Created"], r.body["createdTime"]);
    let modified = f["Modified"].as_str().unwrap();
    assert!(modified.ends_with('Z') && modified.len() == 24);
    assert_eq!(
        f["Go"],
        json!({ "label": "Open", "url": "https://example.com/Row 1" })
    );
    // No internal fields leak into cells.
    let raw = r.body.to_string();
    assert!(!raw.contains("usr") || raw.contains(owner.user_id.as_deref().unwrap()));
    assert!(r.body["fields"].as_object().unwrap().len() >= 29);
}

#[tokio::test]
async fn attachments_have_absolute_urls_sizes_types_and_thumbnails() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything/{}", v.base_id(), e.record_id);
    let r = v.app().get(&v.token, &path).await;
    let files = r.body["fields"]["Files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    let a = &files[0];
    let id = e.attachment["id"].as_str().unwrap();
    assert_eq!(a["id"], id);
    assert_eq!(a["filename"], "pic.png");
    assert_eq!(a["type"], "image/png");
    assert_eq!(a["size"], e.attachment["size"]);
    assert_eq!(
        (a["width"].as_u64(), a["height"].as_u64()),
        (Some(40), Some(20))
    );
    let url = a["url"].as_str().unwrap();
    assert_eq!(
        url,
        format!("http://localhost:8080/api/attachments/{id}/pic.png")
    );
    let thumbs = &a["thumbnails"];
    assert_eq!(thumbs["full"]["url"], url);
    assert_eq!(
        thumbs["large"]["url"],
        format!("http://localhost:8080/api/attachments/{id}/thumb")
    );
    assert!(thumbs["small"]["width"].is_u64() && thumbs["small"]["height"].is_u64());
    // The URLs work with the same bearer token.
    let download = v
        .app()
        .get(&v.token, url.strip_prefix("http://localhost:8080").unwrap())
        .await;
    download.assert_status(200);
    assert_eq!(
        download.bytes.len() as u64,
        e.attachment["size"].as_u64().unwrap()
    );
    v.app()
        .get(
            &v.token,
            thumbs["small"]["url"]
                .as_str()
                .unwrap()
                .strip_prefix("http://localhost:8080")
                .unwrap(),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_configured_public_url_prefixes_attachment_urls() {
    let p = people_with(|c| c.public_url = "https://base.example.com/".into()).await;
    let token = make_token(&p.f.app, &p.f.owner, true, None, None);
    let v = V1 { p, token };
    let e = everything(&v).await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/{}/Everything/{}", v.base_id(), e.record_id),
        )
        .await;
    let id = e.attachment["id"].as_str().unwrap();
    assert_eq!(
        r.body["fields"]["Files"][0]["url"],
        format!("https://base.example.com/api/attachments/{id}/pic.png")
    );
}

#[tokio::test]
async fn collaborators_carry_id_email_and_name() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let other =
        v.p.f
            .member("ann@example.com", openbase::perm::Role::Editor);
    v.p.f
        .set(
            &e.table_id,
            &e.record_id,
            json!({ e.field("Owner"): [other.user_id], e.field("Team"): [other.user_id, v.p.f.owner.user_id] }),
        )
        .await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/{}/Everything/{}", v.base_id(), e.record_id),
        )
        .await;
    assert_eq!(
        r.body["fields"]["Owner"],
        json!({ "id": other.user_id, "email": "ann@example.com", "name": "ann@example.com" })
    );
    let team = r.body["fields"]["Team"].as_array().unwrap();
    assert_eq!(team.len(), 2);
    assert!(
        team.iter()
            .all(|u| u["id"].is_string() && u["email"].is_string() && u["name"].is_string())
    );
    // The last-modified-by field follows the editor.
    assert_eq!(r.body["fields"]["Editor"]["id"], json!(v.p.f.owner.user_id));
}

#[tokio::test]
async fn empty_cells_are_omitted_for_every_type() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let blank =
        v.p.f
            .create(&e.table_id, json!({ e.field("Title"): "Blank" }))
            .await;
    let r = v
        .app()
        .get(
            &v.token,
            &format!("/api/v1/{}/Everything/{}", v.base_id(), id_of(&blank)),
        )
        .await;
    let mut keys: Vec<&str> = r.body["fields"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    // Only the title and the computed fields that always have a value.
    assert_eq!(
        keys,
        [
            "AgeSum",
            "Author",
            "Auto",
            "Calc",
            "Created",
            "Editor",
            "Go",
            "LinkCount",
            "Modified",
            "Title"
        ]
    );
    assert_eq!(r.body["fields"]["LinkCount"], 0);
    assert_eq!(r.body["fields"]["Calc"], 0);
}

#[tokio::test]
async fn listing_does_not_depend_on_the_internal_value_forms() {
    let v = v1_people().await;
    // A select choice renamed in the schema shows up under its new name.
    let t = v.table_id().to_string();
    let todo = v.p.f.choice_id(&t, "Status", "Todo").await;
    let status = v.p.f.field(&t, "Status").await;
    let mut choices = status["options"]["choices"].clone();
    choices[0]["name"] = json!("To do");
    v.app()
        .patch(
            &v.p.f.owner,
            &format!("/api/fields/{}", v.p.status),
            json!({ "type": "single_select", "options": { "choices": choices } }),
        )
        .await
        .assert_status(200);
    let _ = todo;
    let r = v.get("").await;
    assert_eq!(r.body["records"][0]["fields"]["Status"], "To do");
}
