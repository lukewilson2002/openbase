//! Tables: create, update, delete, ordering, role matrix, events.

mod common;
mod schema_support;

use openbase::perm::Role;
use schema_support::*;
use serde_json::json;

fn tables_url(f: &Fixture) -> String {
    format!("/api/bases/{}/tables", f.base_id)
}

#[tokio::test]
async fn create_table_has_primary_name_field_and_grid_view() {
    let f = Fixture::new().await;
    let r = f
        .app
        .post(&f.owner, &tables_url(&f), json!({ "name": "  Contacts  " }))
        .await;
    r.assert_status(201);
    assert_eq!(r.body["name"], "Contacts");
    assert_eq!(r.body["base_id"], f.base_id.as_str());
    let fields = r.body["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0]["name"], "Name");
    assert_eq!(fields[0]["type"], "single_line_text");
    assert_eq!(fields[0]["id"], r.body["primary_field_id"]);
    let views = r.body["views"].as_array().unwrap();
    assert_eq!(views.len(), 1, "a new table has only its default grid");
    assert_eq!(views[0]["name"], "Default grid");
    assert_eq!(views[0]["type"], "grid");
    assert_eq!(views[0]["is_default"], true);

    // it is last in the schema
    let s = f.schema().await;
    assert_eq!(s["tables"][1]["id"], r.body["id"]);
    assert_eq!(s["tables"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn table_names_are_validated_and_unique_per_base_ignoring_case() {
    let f = Fixture::new().await;
    for bad in ["", "   ", "a\u{0007}b"] {
        f.app
            .post(&f.owner, &tables_url(&f), json!({ "name": bad }))
            .await
            .assert_status(400);
    }
    f.app
        .post(
            &f.owner,
            &tables_url(&f),
            json!({ "name": "x".repeat(256) }),
        )
        .await
        .assert_status(400);
    let r = f
        .app
        .post(&f.owner, &tables_url(&f), json!({ "name": "table 1" }))
        .await;
    r.assert_status(409);
    assert_eq!(r.body["error"]["code"], "conflict");
    // same name in another base is fine
    let other = base(&f.app, &f.owner, &f.ws, "Other").await;
    f.app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", other["id"].as_str().unwrap()),
            json!({ "name": "Table 1" }),
        )
        .await
        .assert_status(409); // the starter table of that base is also "Table 1"
    f.app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", other["id"].as_str().unwrap()),
            json!({ "name": "Table 2" }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn tables_per_base_are_limited() {
    let f = Fixture::new().await;
    let base_id = f.base_id.clone();
    sql(&f.app, |tx| {
        for i in 0..(ob_core::limits::MAX_TABLES_PER_BASE - 1) {
            tx.execute(
                "INSERT INTO tables (id, base_id, name, position, primary_field_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'x', 1)",
                rusqlite::params![
                    format!("tblfill{i}"),
                    base_id,
                    format!("Filler {i}"),
                    i as f64 + 10.0
                ],
            )?;
        }
        Ok(())
    });
    let r = f
        .app
        .post(&f.owner, &tables_url(&f), json!({ "name": "One too many" }))
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("200"));
}

#[tokio::test]
async fn update_table_name_description_position() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let path = format!("/api/tables/{}", t2["id"].as_str().unwrap());
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "name": "Renamed", "description": "  about it  ", "position": 0.5 }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["name"], "Renamed");
    assert_eq!(r.body["description"], "about it");
    let names: Vec<String> = f.schema().await["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Renamed", "Table 1"]);

    let r = f
        .app
        .patch(&f.owner, &path, json!({ "description": "" }))
        .await;
    assert!(r.body["description"].is_null());
    f.app
        .patch(&f.owner, &path, json!({ "name": "Table 1" }))
        .await
        .assert_status(409);
    // renaming to its own name in a different case is allowed
    f.app
        .patch(&f.owner, &path, json!({ "name": "RENAMED" }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &path, json!({ "name": " " }))
        .await
        .assert_status(400);
    f.app
        .patch(
            &f.owner,
            &path,
            json!({ "description": "d".repeat(20_001) }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, "/api/tables/tblNOPE", json!({ "name": "x" }))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn the_last_table_cannot_be_deleted() {
    let f = Fixture::new().await;
    let r = f
        .app
        .delete(&f.owner, &format!("/api/tables/{}", f.table_id))
        .await;
    r.assert_status(409);
    let t2 = f.add_table("Second").await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", f.table_id))
        .await
        .assert_status(200);
    // now Second is the last one
    f.app
        .delete(
            &f.owner,
            &format!("/api/tables/{}", t2["id"].as_str().unwrap()),
        )
        .await
        .assert_status(409);
    // deleted tables are gone: not found, and their name is free again
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", f.table_id))
        .await
        .assert_status(404);
    f.app
        .post(&f.owner, &tables_url(&f), json!({ "name": "Table 1" }))
        .await
        .assert_status(201);
}

#[tokio::test]
async fn role_matrix_for_table_endpoints() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.base_guest("g@example.com", role);
        let creator_up = role >= Role::Creator;
        let expect = |ok: bool| if ok { 200 } else { 403 };
        let r = f
            .app
            .post(&u, &tables_url(&f), json!({ "name": "T" }))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if creator_up { 201 } else { 403 },
            "create {role:?}"
        );
        let id = if creator_up {
            r.body["id"].as_str().unwrap().to_string()
        } else {
            f.add_table("T").await["id"].as_str().unwrap().to_string()
        };
        let r = f
            .app
            .patch(&u, &format!("/api/tables/{id}"), json!({ "name": "U" }))
            .await;
        assert_eq!(r.status.as_u16(), expect(creator_up), "patch {role:?}");
        let r = f
            .app
            .post(&u, &format!("/api/tables/{id}/duplicate"), json!({}))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if creator_up { 201 } else { 403 },
            "duplicate {role:?}"
        );
        let r = f.app.delete(&u, &format!("/api/tables/{id}")).await;
        assert_eq!(r.status.as_u16(), expect(creator_up), "delete {role:?}");
    }
    let f = Fixture::new().await;
    let outsider = f.app.user("o@example.com", "O");
    f.app
        .post(&outsider, &tables_url(&f), json!({ "name": "T" }))
        .await
        .assert_status(404);
    f.app
        .patch(
            &outsider,
            &format!("/api/tables/{}", f.table_id),
            json!({ "name": "T" }),
        )
        .await
        .assert_status(404);
    f.app
        .delete(&outsider, &format!("/api/tables/{}", f.table_id))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn schema_changes_publish_events_with_the_clients_id() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    // the harness cannot set arbitrary headers through `post`, so use `send`
    let req = axum::http::Request::builder()
        .method("POST")
        .uri(tables_url(&f))
        .header(
            "cookie",
            format!("ob_session={}", f.owner.cookie.clone().unwrap()),
        )
        .header("content-type", "application/json")
        .header("x-openbase-csrf", "1")
        .header("x-client-id", "client-42")
        .body(axum::body::Body::from(
            json!({ "name": "Evented" }).to_string(),
        ))
        .unwrap();
    let res = f.app.send(req).await;
    res.assert_status(201);
    let env = rx.try_recv().expect("schema event");
    assert_eq!(env.client_id.as_deref(), Some("client-42"));
    assert_eq!(env.user_id.as_deref(), f.owner.user_id.as_deref());
    assert_eq!(
        env.event,
        ob_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(res.body["id"].as_str().unwrap().to_string())
        }
    );
    // a failed write publishes nothing
    f.app
        .post(&f.owner, &tables_url(&f), json!({ "name": "Evented" }))
        .await
        .assert_status(409);
    assert!(rx.try_recv().is_err());
}
