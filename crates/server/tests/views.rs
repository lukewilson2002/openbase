//! Views: creation (shared, personal, forms), permissions (personal, locked,
//! shared), config validation, delete protections, duplicate.

mod common;
mod schema_support;

use og_core::view::ViewType;
use opengrid::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn views_url(f: &Fixture) -> String {
    format!("/api/tables/{}/views", f.table_id)
}

fn view_path(id: &str) -> String {
    format!("/api/views/{id}")
}

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn shared_view(f: &Fixture, name: &str) -> Value {
    let r = f
        .app
        .post(
            &f.owner,
            &views_url(f),
            json!({ "name": name, "type": "grid" }),
        )
        .await;
    r.assert_status(201);
    r.body.clone()
}

#[tokio::test]
async fn every_view_type_can_be_created_with_default_config() {
    let f = Fixture::new().await;
    for t in ViewType::ALL {
        let tag = serde_json::to_value(t).unwrap();
        let r = f
            .app
            .post(
                &f.owner,
                &views_url(&f),
                json!({ "name": format!("v-{tag}"), "type": tag }),
            )
            .await;
        r.assert_status(201);
        assert_eq!(r.body["type"], tag);
        assert_eq!(r.body["personal"], false);
        assert_eq!(r.body["locked"], false);
        assert_eq!(r.body["table_id"], f.table_id.as_str());
    }
    let t = f.table(&f.table_id).await;
    assert_eq!(t["views"].as_array().unwrap().len(), 1 + 7);
}

#[tokio::test]
async fn new_forms_default_to_all_editable_fields_in_order() {
    let f = Fixture::new().await;
    f.add_field(
        &f.table_id,
        json!({ "name": "Qty", "type": "number", "options": {} }),
    )
    .await;
    f.add_field(
        &f.table_id,
        json!({ "name": "Auto", "type": "autonumber", "options": {} }),
    )
    .await;
    f.add_field(
        &f.table_id,
        json!({ "name": "Made", "type": "created_time", "options": {} }),
    )
    .await;
    f.add_field(
        &f.table_id,
        json!({ "name": "Formula", "type": "formula", "options": { "expression": "1" } }),
    )
    .await;
    let r = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "Intake", "type": "form" }),
        )
        .await;
    r.assert_status(201);
    let ids: Vec<&str> = r.body["config"]["form"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| sid(&x["field_id"]))
        .collect();
    let qty = f.table(&f.table_id).await["fields"][2]["id"].clone();
    assert_eq!(ids, [f.primary_id.as_str(), f.notes_id.as_str(), sid(&qty)]);
    assert_eq!(r.body["config"]["form"]["fields"][0]["required"], false);

    // an explicit config is respected as given
    let r = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "Short", "type": "form", "config": { "form": { "fields": [ { "field_id": f.primary_id, "required": true } ] } } }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(
        r.body["config"]["form"]["fields"].as_array().unwrap().len(),
        1
    );
    assert_eq!(r.body["config"]["form"]["fields"][0]["required"], true);
}

#[tokio::test]
async fn view_names_are_validated() {
    let f = Fixture::new().await;
    for bad in ["", "  ", "x".repeat(256).as_str()] {
        f.app
            .post(
                &f.owner,
                &views_url(&f),
                json!({ "name": bad, "type": "grid" }),
            )
            .await
            .assert_status(400);
    }
    f.app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "ok", "type": "carousel" }),
        )
        .await
        .assert_status(400);
    // two views may share a name
    shared_view(&f, "Same").await;
    shared_view(&f, "Same").await;
}

#[tokio::test]
async fn views_per_table_are_limited() {
    let f = Fixture::new().await;
    let table = f.table_id.clone();
    sql(&f.app, |tx| {
        for i in 0..(og_core::limits::MAX_VIEWS_PER_TABLE - 1) {
            tx.execute(
                "INSERT INTO views (id, table_id, name, type, position, created_at) VALUES (?1, ?2, 'v', 'grid', ?3, 1)",
                rusqlite::params![format!("viwfill{i}"), table, 10.0 + i as f64],
            )?;
        }
        Ok(())
    });
    let r = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "too many", "type": "grid" }),
        )
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("200"));
}

#[tokio::test]
async fn role_matrix_for_creating_views() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.base_guest("g@example.com", role);
        let shared = f
            .app
            .post(&u, &views_url(&f), json!({ "name": "S", "type": "grid" }))
            .await;
        assert_eq!(
            shared.status.as_u16(),
            if role >= Role::Creator { 201 } else { 403 },
            "shared {role:?}"
        );
        let personal = f
            .app
            .post(
                &u,
                &views_url(&f),
                json!({ "name": "P", "type": "grid", "personal": true }),
            )
            .await;
        assert_eq!(
            personal.status.as_u16(),
            if role >= Role::Editor { 201 } else { 403 },
            "personal {role:?}"
        );
        if role >= Role::Editor {
            assert_eq!(personal.body["personal"], true);
        }
    }
    let f = Fixture::new().await;
    let outsider = f.app.user("o@example.com", "O");
    f.app
        .post(
            &outsider,
            &views_url(&f),
            json!({ "name": "S", "type": "grid" }),
        )
        .await
        .assert_status(404);
}

#[tokio::test]
async fn config_must_only_reference_fields_of_the_table() {
    let f = Fixture::new().await;
    let other = f.add_table("Other").await;
    let foreign = sid(&other["primary_field_id"]).to_string();
    let url = views_url(&f);
    let bad_configs = [
        json!({ "sorts": [ { "field_id": "fldNOPE" } ] }),
        json!({ "sorts": [ { "field_id": foreign } ] }),
        json!({ "groups": [ { "field_id": "fldNOPE" } ] }),
        json!({ "filter": { "items": [ { "field_id": "fldNOPE", "op": "is_empty" } ] } }),
        json!({ "filter": { "items": [ { "conjunction": "or", "items": [ { "field_id": "fldNOPE", "op": "is_empty" } ] } ] } }),
        json!({ "hidden_fields": ["fldNOPE"] }),
        json!({ "field_order": ["fldNOPE"] }),
        json!({ "field_widths": { "fldNOPE": 100 } }),
        json!({ "summaries": { "fldNOPE": "sum" } }),
        json!({ "kanban": { "stack_field_id": "fldNOPE" } }),
        json!({ "calendar": { "date_field_id": "fldNOPE" } }),
        json!({ "timeline": { "dependency_field_id": "fldNOPE" } }),
        json!({ "gallery": { "cover_field_id": "fldNOPE" } }),
        json!({ "row_color": { "mode": "by_select", "field_id": "fldNOPE" } }),
        json!({ "form": { "fields": [ { "field_id": "fldNOPE" } ] } }),
    ];
    for (i, config) in bad_configs.into_iter().enumerate() {
        let r = f
            .app
            .post(
                &f.owner,
                &url,
                json!({ "name": format!("v{i}"), "type": "grid", "config": config.clone() }),
            )
            .await;
        assert_eq!(r.status.as_u16(), 400, "config {i}: {config}");
    }
    // real field ids pass
    let good = json!({
        "sorts": [ { "field_id": f.primary_id, "direction": "desc" } ],
        "groups": [ { "field_id": f.notes_id } ],
        "filter": { "conjunction": "or", "items": [ { "field_id": f.primary_id, "op": "contains", "value": "x" } ] },
        "hidden_fields": [f.notes_id],
        "frozen_columns": 1,
        "row_height": "tall"
    });
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "good", "type": "grid", "config": good.clone() }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["config"]["sorts"][0]["direction"], "desc");
    assert_eq!(r.body["config"]["row_height"], "tall");
    assert_eq!(r.body["config"]["filter"]["conjunction"], "or");
}

#[tokio::test]
async fn config_limits_and_form_rules() {
    let f = Fixture::new().await;
    let url = views_url(&f);
    let p = &f.primary_id;
    // sorts and groups name each field at most once, so the limits need many fields
    let mut sortable = vec![p.clone()];
    for i in 0..10 {
        let nf = f
            .add_field(
                &f.table_id,
                json!({ "name": format!("N{i}"), "type": "number", "options": {} }),
            )
            .await;
        sortable.push(nf["id"].as_str().unwrap().to_string());
    }
    let sorts = |n: usize| {
        json!(
            sortable
                .iter()
                .cycle()
                .take(n)
                .map(|id| json!({ "field_id": id }))
                .collect::<Vec<_>>()
        )
    };
    let post = |config: Value| {
        f.app.post(
            &f.owner,
            &url,
            json!({ "name": "v", "type": "grid", "config": config }),
        )
    };
    post(json!({ "sorts": sorts(10) })).await.assert_status(201);
    post(json!({ "sorts": sorts(11) })).await.assert_status(400);
    post(json!({ "groups": sorts(3) })).await.assert_status(201);
    post(json!({ "groups": sorts(4) })).await.assert_status(400);

    // filters nest at most 3 levels
    let cond = json!({ "field_id": p, "op": "is_not_empty" });
    let level3 = json!({ "items": [ { "items": [ { "items": [cond.clone()] } ] } ] });
    let level4 =
        json!({ "items": [ { "items": [ { "items": [ { "items": [cond.clone()] } ] } ] } ] });
    post(json!({ "filter": level3 })).await.assert_status(201);
    let r = post(json!({ "filter": level4 })).await;
    r.assert_status(400);
    // and hold at most 100 conditions
    let many = |n: usize| json!({ "items": (0..n).map(|_| cond.clone()).collect::<Vec<_>>() });
    post(json!({ "filter": many(100) }))
        .await
        .assert_status(201);
    post(json!({ "filter": many(101) }))
        .await
        .assert_status(400);

    // form redirect: http(s) only
    let form = |redirect: &str| json!({ "form": { "redirect_url": redirect, "fields": [ { "field_id": p } ] } });
    for ok in ["https://example.com/thanks", "http://example.com"] {
        post(form(ok)).await.assert_status(201);
    }
    for bad in [
        "javascript:alert(1)",
        "ftp://example.com",
        "data:text/html,hi",
        "//example.com",
        "not a url",
    ] {
        let r = post(form(bad)).await;
        assert_eq!(r.status.as_u16(), 400, "redirect {bad}");
    }
    // computed fields cannot be on a form; duplicates neither
    let auto = f
        .add_field(
            &f.table_id,
            json!({ "name": "Auto", "type": "autonumber", "options": {} }),
        )
        .await;
    post(json!({ "form": { "fields": [ { "field_id": auto["id"] } ] } }))
        .await
        .assert_status(400);
    post(json!({ "form": { "fields": [ { "field_id": p }, { "field_id": p } ] } }))
        .await
        .assert_status(400);
    // row colours must be palette colours
    let rule = |color: &str| json!({ "row_color": { "mode": "by_conditions", "rules": [ { "color": color, "filter": { "items": [cond.clone()] } } ] } });
    post(rule("red")).await.assert_status(201);
    post(rule("plaid")).await.assert_status(400);
}

#[tokio::test]
async fn updating_a_shared_view_by_editors_and_creators() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    let viewer = f.member("v@example.com", Role::Viewer);
    let v = shared_view(&f, "Board").await;
    let path = view_path(sid(&v["id"]));
    let cfg = json!({ "config": { "sorts": [ { "field_id": f.primary_id } ] } });

    // editors may change filters/sorts and rename an unlocked shared view
    let r = f.app.patch(&editor, &path, cfg.clone()).await;
    r.assert_status(200);
    assert_eq!(
        r.body["config"]["sorts"][0]["field_id"],
        f.primary_id.as_str()
    );
    f.app
        .patch(&editor, &path, json!({ "name": "Renamed" }))
        .await
        .assert_status(200);
    // ... but not reorder or lock it
    f.app
        .patch(&editor, &path, json!({ "position": 3 }))
        .await
        .assert_status(403);
    f.app
        .patch(&editor, &path, json!({ "locked": true }))
        .await
        .assert_status(403);
    // viewers cannot change anything
    f.app.patch(&viewer, &path, cfg).await.assert_status(403);
    // creators can do everything
    let r = f
        .app
        .patch(&f.owner, &path, json!({ "position": 0.25, "locked": true }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["locked"], true);
    // the config is a full replacement
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "config": { "frozen_columns": 2 } }),
        )
        .await;
    assert_eq!(r.body["config"]["sorts"], json!([]));
    assert_eq!(r.body["config"]["frozen_columns"], 2);
    // validation applies to updates as well
    f.app
        .patch(
            &f.owner,
            &path,
            json!({ "config": { "sorts": [ { "field_id": "fldNOPE" } ] } }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, &path, json!({ "name": " " }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn locked_views_can_only_be_changed_by_creators() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    let v = shared_view(&f, "Locked").await;
    let id = sid(&v["id"]).to_string();
    f.app
        .patch(&f.owner, &view_path(&id), json!({ "locked": true }))
        .await
        .assert_status(200);

    f.app
        .patch(
            &editor,
            &view_path(&id),
            json!({ "config": { "frozen_columns": 1 } }),
        )
        .await
        .assert_status(403);
    f.app
        .patch(&editor, &view_path(&id), json!({ "name": "Nope" }))
        .await
        .assert_status(403);
    f.app
        .patch(&editor, &view_path(&id), json!({ "locked": false }))
        .await
        .assert_status(403);
    // an empty patch by an editor is harmless
    f.app
        .patch(&editor, &view_path(&id), json!({}))
        .await
        .assert_status(200);
    // creators can edit and unlock
    f.app
        .patch(&f.owner, &view_path(&id), json!({ "name": "Still fine" }))
        .await
        .assert_status(200);
    let r = f
        .app
        .patch(&f.owner, &view_path(&id), json!({ "locked": false }))
        .await;
    assert_eq!(r.body["locked"], false);
    f.app
        .patch(
            &editor,
            &view_path(&id),
            json!({ "name": "Editor can now" }),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn personal_views_belong_to_their_owner() {
    let f = Fixture::new().await;
    let ed1 = f.member("ed1@example.com", Role::Editor);
    let ed2 = f.member("ed2@example.com", Role::Editor);
    let r = f
        .app
        .post(
            &ed1,
            &views_url(&f),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    r.assert_status(201);
    let id = sid(&r.body["id"]).to_string();

    // owner: update and lock rules
    f.app
        .patch(
            &ed1,
            &view_path(&id),
            json!({ "name": "Mine 2", "config": { "frozen_columns": 1 } }),
        )
        .await
        .assert_status(200);
    f.app
        .patch(&ed1, &view_path(&id), json!({ "locked": true }))
        .await
        .assert_status(400);
    // everybody else - other editors, even creators and owners - cannot see it
    for other in [&ed2, &f.owner] {
        f.app
            .patch(other, &view_path(&id), json!({ "name": "hijack" }))
            .await
            .assert_status(404);
        f.app
            .delete(other, &view_path(&id))
            .await
            .assert_status(404);
        f.app
            .post(other, &format!("{}/duplicate", view_path(&id)), json!({}))
            .await
            .assert_status(404);
    }
    // the owner can delete it and the shared views are unaffected
    f.app.delete(&ed1, &view_path(&id)).await.assert_status(200);
    assert_eq!(
        f.table(&f.table_id).await["views"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_user_demoted_to_viewer_can_still_delete_but_not_edit_their_personal_view() {
    let f = Fixture::new().await;
    let ed = f.member("ed@example.com", Role::Editor);
    let r = f
        .app
        .post(
            &ed,
            &views_url(&f),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    let id = sid(&r.body["id"]).to_string();
    add_ws_member(&f.app, &f.ws, &ed, Role::Viewer);
    f.app
        .patch(&ed, &view_path(&id), json!({ "name": "x" }))
        .await
        .assert_status(403);
    f.app.delete(&ed, &view_path(&id)).await.assert_status(200);
}

#[tokio::test]
async fn deleting_views() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    let extra = shared_view(&f, "Extra").await;
    // editors cannot delete shared views
    f.app
        .delete(&editor, &view_path(sid(&extra["id"])))
        .await
        .assert_status(403);
    f.app
        .delete(&f.owner, &view_path(sid(&extra["id"])))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &view_path(sid(&extra["id"])))
        .await
        .assert_status(404);
    // the last shared view of a table stays - personal views do not count
    f.app
        .post(
            &editor,
            &views_url(&f),
            json!({ "name": "P", "type": "grid", "personal": true }),
        )
        .await
        .assert_status(201);
    let r = f.app.delete(&f.owner, &view_path(&f.view_id)).await;
    r.assert_status(409);
    assert_eq!(r.body["error"]["code"], "conflict");
    // another table has its own last view
    let t2 = f.add_table("Second").await;
    f.app
        .delete(&f.owner, &view_path(sid(&t2["views"][0]["id"])))
        .await
        .assert_status(409);
}

#[tokio::test]
async fn duplicating_views() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    let v = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "Board", "type": "kanban", "config": { "frozen_columns": 2 } }),
        )
        .await;
    v.assert_status(201);
    let path = format!("{}/duplicate", view_path(sid(&v.body["id"])));

    // shared copy: creators only; name defaults to "<name> copy"
    let r = f.app.post(&f.owner, &path, json!({})).await;
    r.assert_status(201);
    assert_eq!(r.body["name"], "Board copy");
    assert_eq!(r.body["type"], "kanban");
    assert_eq!(r.body["config"]["frozen_columns"], 2);
    assert_eq!(r.body["personal"], false);
    assert_ne!(r.body["id"], v.body["id"]);
    f.app
        .post(&editor, &path, json!({}))
        .await
        .assert_status(403);
    // ... but editors can make a personal copy of a shared view
    let r = f
        .app
        .post(
            &editor,
            &path,
            json!({ "name": "My board", "personal": true }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["name"], "My board");
    assert_eq!(r.body["personal"], true);
    // a copy of a personal view is personal, even without asking
    let r2 = f
        .app
        .post(
            &editor,
            &format!("{}/duplicate", view_path(sid(&r.body["id"]))),
            json!({}),
        )
        .await;
    r2.assert_status(201);
    assert_eq!(r2.body["personal"], true);
    // copies of locked views start unlocked
    f.app
        .patch(
            &f.owner,
            &view_path(sid(&v.body["id"])),
            json!({ "locked": true }),
        )
        .await
        .assert_status(200);
    let r = f
        .app
        .post(&f.owner, &path, json!({ "name": "Copy of locked" }))
        .await;
    assert_eq!(r.body["locked"], false);
    f.app
        .post(&f.owner, &path, json!({ "name": "  " }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn view_changes_publish_schema_events() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let v = shared_view(&f, "A").await;
    assert!(rx.try_recv().is_ok());
    f.app
        .patch(&f.owner, &view_path(sid(&v["id"])), json!({ "name": "B" }))
        .await
        .assert_status(200);
    assert!(rx.try_recv().is_ok());
    f.app
        .delete(&f.owner, &view_path(sid(&v["id"])))
        .await
        .assert_status(200);
    let env = rx.try_recv().unwrap();
    assert_eq!(
        env.event,
        og_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(f.table_id.clone())
        }
    );
}

#[tokio::test]
async fn configs_that_still_mention_deleted_fields_can_be_saved_again() {
    let f = Fixture::new().await;
    let doomed = f
        .add_field(
            &f.table_id,
            json!({ "name": "Doomed", "type": "number", "options": {} }),
        )
        .await;
    let doomed_id = sid(&doomed["id"]).to_string();
    let v = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "V", "type": "grid", "config": {
                "hidden_fields": [doomed_id], "sorts": [ { "field_id": doomed_id } ],
                "field_widths": { &doomed_id: 150 } } }),
        )
        .await;
    v.assert_status(201);
    let path = view_path(sid(&v.body["id"]));
    f.app
        .delete(&f.owner, &format!("/api/fields/{doomed_id}"))
        .await
        .assert_status(200);

    // the client sends back the config it was given (still naming the deleted field) with one more change
    let mut config = v.body["config"].clone();
    config["frozen_columns"] = json!(1);
    f.app
        .patch(&f.owner, &path, json!({ "config": config.clone() }))
        .await
        .assert_status(200);
    // ... even after the field was purged for good
    set_deleted_at(&f.app, "fields", &doomed_id, 1);
    f.app
        .state
        .db
        .write_sync(|tx| opengrid::store::trash::purge_expired(tx, 1000))
        .unwrap();
    config["frozen_columns"] = json!(2);
    f.app
        .patch(&f.owner, &path, json!({ "config": config.clone() }))
        .await
        .assert_status(200);

    // but a *new* unknown id is still an error
    config["hidden_fields"] = json!([doomed_id, "fldNEVERHEREE"]);
    f.app
        .patch(&f.owner, &path, json!({ "config": config }))
        .await
        .assert_status(400);
    // and fresh views cannot start out referring to it
    f.app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "W", "type": "grid", "config": { "hidden_fields": [doomed_id] } }),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn editors_cannot_widen_what_a_public_link_shows() {
    let f = Fixture::new().await;
    let editor = f.member("ed2@example.com", Role::Editor);
    let v = shared_view(&f, "Public").await;
    let id = sid(&v["id"]).to_string();
    let secret = id_of(
        &f.add_field(
            &f.table_id,
            json!({ "name": "Secret", "type": "number", "options": {} }),
        )
        .await,
    );
    // The creator hides a field, then publishes the view.
    f.app
        .patch(
            &f.owner,
            &view_path(&id),
            json!({ "config": { "hidden_fields": [secret] } }),
        )
        .await
        .assert_status(200);
    let share = f
        .app
        .post(
            &f.owner,
            &format!("/api/views/{id}/shares"),
            json!({ "kind": "view" }),
        )
        .await;
    share.assert_status(201);
    // An editor cannot unhide it, reorder shown fields or change the filter.
    for config in [
        json!({ "hidden_fields": [] }),
        json!({ "hidden_fields": [secret], "field_order": [secret] }),
        json!({ "hidden_fields": [secret], "filter": { "op": "and", "items": [] } }),
    ] {
        f.app
            .patch(&editor, &view_path(&id), json!({ "config": config }))
            .await
            .assert_status(403);
    }
    // Layout changes that expose nothing new stay open to editors (the grid
    // saves column widths as you drag them), as do renames.
    f.app
        .patch(
            &editor,
            &view_path(&id),
            json!({ "config": { "hidden_fields": [secret], "frozen_columns": 1 } }),
        )
        .await
        .assert_status(200);
    f.app
        .patch(&editor, &view_path(&id), json!({ "name": "Renamed" }))
        .await
        .assert_status(200);
    // Creators can change anything; editors can copy it into a personal view.
    f.app
        .patch(
            &f.owner,
            &view_path(&id),
            json!({ "config": { "hidden_fields": [] } }),
        )
        .await
        .assert_status(200);
    f.app
        .post(
            &editor,
            &format!("/api/views/{id}/duplicate"),
            json!({ "personal": true }),
        )
        .await
        .assert_status(201);
    // Disabling the link frees the view again.
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{}", sid(&share.body["id"])),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    f.app
        .patch(
            &editor,
            &view_path(&id),
            json!({ "config": { "hidden_fields": [secret] } }),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn only_stale_references_are_forgiven_not_everything_the_old_config_mentions() {
    let f = Fixture::new().await;
    let n = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let n_id = sid(&n["id"]).to_string();
    let gt = |value: i64| {
        json!({ "conjunction": "and", "items": [ { "field_id": n_id, "op": "gt", "value": value } ] })
    };
    // The old config filters on Qty (valid for a number) and also hides it.
    let v = f
        .app
        .post(
            &f.owner,
            &views_url(&f),
            json!({ "name": "V", "type": "grid", "config": {
                "filter": gt(3), "hidden_fields": [n_id] } }),
        )
        .await;
    v.assert_status(201);
    let path = view_path(sid(&v.body["id"]));
    let save = |config: Value| f.app.patch(&f.owner, &path, json!({ "config": config }));

    // Still a number: an operator that does not fit is rejected even though the old config
    // mentioned the field twice (before: any mention excused anything).
    let mut contains = v.body["config"].clone();
    contains["filter"] = json!({ "conjunction": "and", "items": [
        { "field_id": n_id, "op": "contains", "value": "x" } ] });
    save(contains.clone()).await.assert_status(400);

    // Qty becomes text: `gt` no longer fits, and the saved view now holds a stale condition.
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{n_id}"),
            json!({ "type": "single_line_text", "options": {} }),
        )
        .await
        .assert_status(200);
    let current = v.body["config"].clone();

    // Sending the config back unchanged (plus an unrelated change) is accepted.
    let mut same = current.clone();
    same["frozen_columns"] = json!(1);
    save(same.clone()).await.assert_status(200);

    // A new or edited condition on that field is validated: `gt` on text is refused,
    // whether it is the old one with another operand or one in a place the old config
    // never used it (here: a row colour rule).
    let mut edited = same.clone();
    edited["filter"] = gt(4);
    save(edited).await.assert_status(400);
    let mut elsewhere = same.clone();
    elsewhere["row_color"] = json!({ "mode": "by_conditions", "rules": [
        { "color": "red", "filter": gt(9) } ] });
    save(elsewhere).await.assert_status(400);

    // And a fitting condition on the same field is fine.
    let mut fitting = same.clone();
    fitting["filter"] = json!({ "conjunction": "and", "items": [
        { "field_id": n_id, "op": "contains", "value": "x" } ] });
    save(fitting).await.assert_status(200);
}
