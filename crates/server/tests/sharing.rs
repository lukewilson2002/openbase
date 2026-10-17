//! Share links: management API (roles, kinds, lifecycle) and the public view
//! endpoints (field visibility, no leaks, passwords, 404s, rate limits,
//! attachments through `?share=`).

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use openbase::perm::Role;
use serde_json::{Value, json};
use share_support::*;

/// People + a hidden number/formula, a user field and a created-by field,
/// with a grid view that hides the secrets and reorders the rest.
struct Shared {
    p: People,
    secret: String,
    dbl: String,
    assignee: String,
    made_by: String,
    view: String,
    share: Value,
    token: String,
}

async fn setup() -> Shared {
    let p = people().await;
    let t = p.f.table_id.clone();
    let secret = id_of(&p.f.number(&t, "Secret").await);
    let dbl = id_of(&p.f.formula(&t, "Dbl", "{Secret} * 2").await);
    let assignee = id_of(
        &p.f.add_field(
            &t,
            json!({ "name": "Assignee", "type": "user", "options": { "multiple": false } }),
        )
        .await,
    );
    let made_by = id_of(
        &p.f.add_field(
            &t,
            json!({ "name": "Made by", "type": "created_by", "options": {} }),
        )
        .await,
    );
    let owner_id = p.f.owner.user_id.clone().unwrap();
    for (i, id) in p.ids.iter().enumerate() {
        p.f.set(
            &t,
            id,
            json!({ &secret: 100 + i as i64, &assignee: [&owner_id] }),
        )
        .await;
    }
    let view =
        p.f.view_of(
            &t,
            "Public",
            "grid",
            json!({
                "hidden_fields": [&secret, &dbl],
                "field_order": [&p.status, &p.name],
                "field_widths": { &p.name: 200, &secret: 90 },
            }),
        )
        .await;
    let share = p.f.share(&view, "view", None).await;
    let token = share["token"].as_str().unwrap().to_string();
    Shared {
        p,
        secret,
        dbl,
        assignee,
        made_by,
        view,
        share,
        token,
    }
}

impl Shared {
    fn app(&self) -> &common::TestApp {
        &self.p.f.app
    }
    fn info_path(&self) -> String {
        format!("/api/public/shares/{}", self.token)
    }
    fn query_path(&self) -> String {
        format!("/api/public/shares/{}/query", self.token)
    }
}

// ------------------------------------------------------------- management

#[tokio::test]
async fn share_link_dto_and_lifecycle() {
    let f = Fixture::new().await;
    let share = f.share(&f.view_id, "view", None).await;
    let token = share["token"].as_str().unwrap();
    assert!(token.starts_with("shr_") && token.len() > 40, "{token}");
    assert!(share["id"].as_str().unwrap().starts_with("shr"));
    assert_eq!(share["kind"], "view");
    assert_eq!(share["view_id"], f.view_id);
    assert_eq!(share["enabled"], true);
    assert_eq!(share["has_password"], false);
    assert_eq!(share["path"], format!("/s/{token}"));
    assert_eq!(share["url"], format!("http://localhost:8080/s/{token}"));
    assert_eq!(share["created_by"], f.owner.user_id.clone().unwrap());
    assert!(share.get("password_hash").is_none());
    assert!(!share.to_string().contains("argon2"));

    // Two shares of one view get distinct tokens; the list shows both.
    let second = f.share(&f.view_id, "view", Some("hunter22")).await;
    assert_ne!(second["token"], share["token"]);
    assert_eq!(second["has_password"], true);
    let list = f
        .app
        .get(&f.owner, &format!("/api/views/{}/shares", f.view_id))
        .await;
    list.assert_status(200);
    let ids: Vec<&Value> = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|s| &s["id"])
        .collect();
    assert_eq!(ids, [&share["id"], &second["id"]]);

    // PATCH: disable, enable, set / clear the password.
    let sid = share["id"].as_str().unwrap();
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": false }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["enabled"], false);
    assert_eq!(r.body["token"], share["token"]);
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": true, "password": "correct horse" }),
        )
        .await;
    assert_eq!(
        (r.body["enabled"].clone(), r.body["has_password"].clone()),
        (json!(true), json!(true))
    );
    let r = f
        .app
        .patch(&f.owner, &format!("/api/shares/{sid}"), json!({}))
        .await;
    r.assert_status(200);
    assert_eq!(
        r.body["has_password"], true,
        "an empty patch changes nothing"
    );
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "password": null }),
        )
        .await;
    assert_eq!(r.body["has_password"], false);

    // DELETE answers 204; the link is gone.
    let r = f.app.delete(&f.owner, &format!("/api/shares/{sid}")).await;
    r.assert_status(204);
    assert!(r.bytes.is_empty());
    f.app
        .delete(&f.owner, &format!("/api/shares/{sid}"))
        .await
        .assert_status(404);
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": true }),
        )
        .await
        .assert_status(404);
    let list = f
        .app
        .get(&f.owner, &format!("/api/views/{}/shares", f.view_id))
        .await;
    assert_eq!(list.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_password_is_stored_as_an_argon2_hash() {
    let f = Fixture::new().await;
    let share = f.share(&f.view_id, "view", Some("secret-pass")).await;
    let id = share["id"].as_str().unwrap().to_string();
    let hash: String = schema_support::sql(&f.app, |tx| {
        tx.query_row(
            "SELECT password_hash FROM share_links WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )
    });
    assert!(hash.starts_with("$argon2id$"), "{hash}");
    assert!(!hash.contains("secret-pass"));
}

#[tokio::test]
async fn invalid_share_passwords_and_bodies_are_rejected() {
    let f = Fixture::new().await;
    let url = format!("/api/views/{}/shares", f.view_id);
    for body in [
        json!({ "kind": "view", "password": "abc" }),
        json!({ "kind": "view", "password": "x".repeat(300) }),
        json!({ "kind": "view", "password": "" }),
        json!({ "kind": "nope" }),
        json!({}),
    ] {
        let r = f.app.post(&f.owner, &url, body.clone()).await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request", "{body}");
    }
    let s = f.share(&f.view_id, "view", None).await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/shares/{}", s["id"].as_str().unwrap()),
            json!({ "password": "no" }),
        )
        .await;
    r.assert_status(400);
}

#[tokio::test]
async fn share_management_needs_a_creator() {
    let f = Fixture::new().await;
    let share = f.share(&f.view_id, "view", None).await;
    let sid = share["id"].as_str().unwrap().to_string();
    let url = format!("/api/views/{}/shares", f.view_id);
    for role in [Role::Viewer, Role::Commenter, Role::Editor] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        f.app.get(&u, &url).await.assert_status(403);
        f.app
            .post(&u, &url, json!({ "kind": "view" }))
            .await
            .assert_status(403);
        f.app
            .patch(
                &u,
                &format!("/api/shares/{sid}"),
                json!({ "enabled": false }),
            )
            .await
            .assert_status(403);
        f.app
            .delete(&u, &format!("/api/shares/{sid}"))
            .await
            .assert_status(403);
    }
    for role in [Role::Creator, Role::Owner] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        f.app.get(&u, &url).await.assert_status(200);
        f.app
            .post(&u, &url, json!({ "kind": "view" }))
            .await
            .assert_status(201);
    }
    // A base-level creator (no workspace role) works too.
    let guest = f.base_guest("guest@x.io", Role::Creator);
    f.app.get(&guest, &url).await.assert_status(200);
    // Strangers see nothing; anonymous callers must sign in.
    let stranger = f.app.user("stranger@x.io", "S");
    f.app.get(&stranger, &url).await.assert_status(404);
    f.app
        .patch(
            &stranger,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(404);
    f.app.get(&f.app.anon(), &url).await.assert_status(401);
    f.app
        .post(&f.app.anon(), &url, json!({ "kind": "view" }))
        .await
        .assert_status(401);
    // The link still works for everyone after all the failed attempts.
    pub_get(
        &f.app,
        &format!("/api/public/shares/{}", share["token"].as_str().unwrap()),
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn tokens_follow_their_scope_when_managing_shares() {
    let f = Fixture::new().await;
    let url = format!("/api/views/{}/shares", f.view_id);
    let write = token_client(&f.app, &f.owner, true);
    f.app
        .post(&write, &url, json!({ "kind": "view" }))
        .await
        .assert_status(201);
    // A read-only token acts as a viewer.
    let read = token_client(&f.app, &f.owner, false);
    f.app.get(&read, &url).await.assert_status(403);
    f.app
        .post(&read, &url, json!({ "kind": "view" }))
        .await
        .assert_status(403);
}

#[tokio::test]
async fn kinds_must_fit_the_view_type() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let form = f.view_of(&t, "Form", "form", json!({})).await;
    let url = |v: &str| format!("/api/views/{v}/shares");
    // Forms only on form views, read-only shares only on the others.
    f.app
        .post(&f.owner, &url(&f.view_id), json!({ "kind": "form" }))
        .await
        .assert_status(400);
    f.app
        .post(&f.owner, &url(&form), json!({ "kind": "view" }))
        .await
        .assert_status(400);
    f.share(&form, "form", None).await;
    for ty in ["gallery", "kanban", "calendar", "timeline", "list"] {
        let v = f.view_of(&t, ty, ty, json!({})).await;
        let s = f.share(&v, "view", None).await;
        assert_eq!(s["kind"], "view", "{ty}");
    }
    // Personal views cannot be shared.
    let personal = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{t}/views"),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    personal.assert_status(201);
    f.app
        .post(
            &f.owner,
            &url(&id_of(&personal.body)),
            json!({ "kind": "view" }),
        )
        .await
        .assert_status(400);
    // Unknown views.
    f.app
        .post(&f.owner, &url("viwNOPE"), json!({ "kind": "view" }))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn a_view_can_have_at_most_twenty_links() {
    let f = Fixture::new().await;
    for _ in 0..20 {
        f.share(&f.view_id, "view", None).await;
    }
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/views/{}/shares", f.view_id),
            json!({ "kind": "view" }),
        )
        .await;
    r.assert_status(400);
}

#[tokio::test]
async fn share_changes_are_audited_without_secrets() {
    let f = Fixture::new().await;
    let share = f.share(&f.view_id, "view", Some("audit-pass")).await;
    let sid = share["id"].as_str().unwrap();
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/shares/{sid}"))
        .await
        .assert_status(204);
    let sid = sid.to_string();
    let rows: Vec<(String, String)> = schema_support::sql(&f.app, |tx| {
        let mut stmt = tx.prepare(
            "SELECT action, COALESCE(detail, '') FROM audit_log WHERE target = ?1 ORDER BY id",
        )?;
        stmt.query_map([&sid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()
    });
    let actions: Vec<&str> = rows.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(actions, ["share_create", "share_update", "share_delete"]);
    assert!(rows.iter().all(|(_, d)| !d.contains("audit-pass")));
}

// ------------------------------------------------------------ public view

#[tokio::test]
async fn public_view_describes_only_the_visible_fields_in_view_order() {
    let s = setup().await;
    let r = pub_get(s.app(), &s.info_path()).await;
    r.assert_status(200);
    assert_eq!(r.body["kind"], "view");
    assert_eq!(r.body["name"], "Public");
    assert_eq!(r.body["type"], "grid");
    assert_eq!(r.body["table_name"], "Table 1");
    assert_eq!(r.body["base_name"], "CRM");
    let ids: Vec<&str> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    // field_order first (status, name), then the rest in table order, minus hidden.
    let p = &s.p;
    assert_eq!(
        ids,
        [
            p.status.as_str(),
            p.name.as_str(),
            p.f.notes_id.as_str(),
            p.age.as_str(),
            p.tags.as_str(),
            p.due.as_str(),
            p.done.as_str(),
            s.assignee.as_str(),
            s.made_by.as_str(),
        ]
    );
    let status = &r.body["fields"][0];
    assert_eq!(status["type"], "single_select");
    assert_eq!(status["name"], "Status");
    assert_eq!(status["options"]["choices"][0]["name"], "Todo");
    // Hidden fields leave no trace anywhere in the answer.
    let raw = r.body.to_string();
    for hidden in [&s.secret, &s.dbl] {
        assert!(!raw.contains(hidden.as_str()), "{hidden} leaked: {raw}");
    }
    assert!(!raw.contains("Secret") && !raw.contains("Dbl"));
    // Layout config keeps widths of visible fields only.
    assert_eq!(r.body["config"]["field_widths"][&p.name], 200);
    assert!(r.body["config"]["field_widths"].get(&s.secret).is_none());
    assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
}

#[tokio::test]
async fn public_view_hides_formula_and_link_internals() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&t, "Orders", &orders).await;
    let price = f.number(&orders, "Price").await;
    let lookup = f.lookup(&t, "Prices", &link, &price).await;
    let rollup = f.rollup(&t, "Total", &link, &price, "SUM(values)").await;
    let count = f.count(&t, "N", &link).await;
    let secret = f.number(&t, "Secret").await;
    let dbl = f.formula(&t, "Dbl", "{Secret} * 2").await;
    let view = f
        .new_view(&t, "Pub", json!({ "hidden_fields": [id_of(&secret)] }))
        .await;
    let share = f.share(&view, "view", None).await;
    let r = pub_get(
        &f.app,
        &format!("/api/public/shares/{}", share["token"].as_str().unwrap()),
    )
    .await;
    r.assert_status(200);
    let raw = r.body.to_string();
    // The formula depends on a hidden field: neither its source nor the
    // ids of linked tables / paired fields / targets may appear.
    for secret_text in [
        "Secret",
        "expression",
        id_of(&secret).as_str(),
        orders.as_str(),
        id_of(&link["inverse"]).as_str(),
        id_of(&price).as_str(),
        "link_field_id",
        "target_field_id",
        "linked_table_id",
        "picker_view_id",
    ] {
        assert!(!raw.contains(secret_text), "`{secret_text}` leaked: {raw}");
    }
    let field = |id: &Value| {
        r.body["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == *id)
            .cloned()
            .unwrap()
    };
    assert_eq!(field(&dbl["id"])["type"], "formula");
    assert_eq!(field(&dbl["id"])["options"]["result_type"], "number");
    assert_eq!(field(&link["id"])["options"], json!({ "single": false }));
    assert_eq!(field(&lookup["id"])["type"], "lookup");
    assert_eq!(field(&rollup["id"])["type"], "rollup");
    assert_eq!(field(&count["id"])["options"], json!({}));
}

#[tokio::test]
async fn public_query_returns_visible_values_and_never_leaks() {
    let s = setup().await;
    let r = pub_post(s.app(), &s.query_path(), json!({})).await;
    r.assert_status(200);
    assert_eq!(r.body["total"], 5);
    let raw = String::from_utf8(r.bytes.clone()).unwrap();

    // No ids of users, no e-mail addresses, no creator/editor metadata, no
    // hidden fields (id, name or value), no timestamps of other people's edits.
    let owner_id = s.p.f.owner.user_id.clone().unwrap();
    for leak in [
        owner_id.as_str(),
        "owner@example.com",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "autonumber",
        "table_id",
        s.secret.as_str(),
        s.dbl.as_str(),
    ] {
        assert!(!raw.contains(leak), "`{leak}` leaked: {raw}");
    }
    assert!(!raw.contains("\"usr"), "a user id leaked: {raw}");

    let alice = &r.body["records"][0];
    assert_eq!(alice["id"], s.p.ids[0]);
    assert_eq!(alice["values"][&s.p.name], "Alice");
    assert_eq!(alice["values"][&s.p.age], 30);
    // Selects are stored by choice id; the field description carries the names.
    assert!(alice["values"][&s.p.status].is_string());
    // User and created-by cells carry names only.
    assert_eq!(alice["values"][&s.assignee], json!([{ "name": "Owner" }]));
    assert_eq!(alice["values"][&s.made_by], json!({ "name": "Owner" }));
    // The keys of a record are a subset of the visible field ids.
    let info = pub_get(s.app(), &s.info_path()).await;
    let visible: Vec<&str> = info.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    for rec in r.body["records"].as_array().unwrap() {
        assert_eq!(
            rec.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "values"]
        );
        for k in rec["values"].as_object().unwrap().keys() {
            assert!(visible.contains(&k.as_str()), "{k} is not visible");
        }
    }
    assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
}

#[tokio::test]
async fn public_query_applies_the_views_filter_sort_search_and_paging() {
    let p = people().await;
    let t = p.f.table_id.clone();
    let view = p
        .f
        .view_of(
            &t,
            "Adults",
            "grid",
            json!({
                "filter": and(vec![cond(&p.age, "gte", json!(30))]),
                "sorts": [{ "field_id": p.age, "direction": "desc" }, { "field_id": p.name, "direction": "asc" }],
            }),
        )
        .await;
    let share = p.f.share(&view, "view", None).await;
    let path = format!(
        "/api/public/shares/{}/query",
        share["token"].as_str().unwrap()
    );
    let r = pub_post(&p.f.app, &path, json!({})).await;
    r.assert_status(200);
    assert_eq!(names(&p, &r.body), ["Carol", "Alice", "Eve"]);
    assert_eq!(r.body["total"], 3);
    // Paging and search.
    let r = pub_post(&p.f.app, &path, json!({ "offset": 1, "limit": 1 })).await;
    assert_eq!(names(&p, &r.body), ["Alice"]);
    assert_eq!(
        (r.body["total"].clone(), r.body["offset"].clone()),
        (json!(3), json!(1))
    );
    let r = pub_post(&p.f.app, &path, json!({ "search": "eve" })).await;
    assert_eq!(names(&p, &r.body), ["Eve"]);
    // A change in the table shows up immediately (the cache is invalidated).
    p.f.set(&t, &p.ids[3], json!({ &p.age: 99 })).await;
    let r = pub_post(&p.f.app, &path, json!({})).await;
    assert_eq!(names(&p, &r.body), ["dave", "Carol", "Alice", "Eve"]);
}

#[tokio::test]
async fn public_search_ignores_hidden_fields() {
    let s = setup().await;
    // Secret values are 100..104; the view hides the field.
    let r = pub_post(s.app(), &s.query_path(), json!({ "search": "103" })).await;
    r.assert_status(200);
    assert_eq!(r.body["total"], 0);
}

#[tokio::test]
async fn public_query_rejects_ranges_on_hidden_fields() {
    let p = people().await;
    let t = p.f.table_id.clone();
    let view =
        p.f.view_of(&t, "NoDue", "calendar", json!({ "hidden_fields": [p.due] }))
            .await;
    let share = p.f.share(&view, "view", None).await;
    let path = format!(
        "/api/public/shares/{}/query",
        share["token"].as_str().unwrap()
    );
    let probe = |end: Option<&str>| json!({ "range": { "field_id": p.due, "end_field_id": end, "from": "2026-03-01", "to": "2026-03-05" } });
    let r = pub_post(&p.f.app, &path, probe(None)).await;
    r.assert_status(400);
    // Nothing is learned about the hidden dates: no records in the answer.
    assert!(r.body.get("records").is_none());
    pub_post(&p.f.app, &path, probe(Some(&p.due)))
        .await
        .assert_status(400);
    // The same range on a visible date field works.
    let view2 =
        p.f.view_of(&t, "Cal", "calendar", json!({ "hidden_fields": [p.age] }))
            .await;
    let share2 = p.f.share(&view2, "view", None).await;
    let path2 = format!(
        "/api/public/shares/{}/query",
        share2["token"].as_str().unwrap()
    );
    let r = pub_post(&p.f.app, &path2, probe(None)).await;
    r.assert_status(200);
    assert_eq!(names(&p, &r.body), ["Alice"]);
}

#[tokio::test]
async fn public_groups_and_colors_only_use_visible_fields() {
    let p = people().await;
    let t = p.f.table_id.clone();
    // Grouped by Status (hidden) and coloured by it: nothing may reveal it.
    let hidden =
        p.f.view_of(
            &t,
            "G1",
            "grid",
            json!({
                "hidden_fields": [p.status],
                "groups": [{ "field_id": p.status, "direction": "asc" }],
                "row_color": { "mode": "by_select", "field_id": p.status },
            }),
        )
        .await;
    let token = p.f.share(&hidden, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = pub_post(
        &p.f.app,
        &format!("/api/public/shares/{token}/query"),
        json!({}),
    )
    .await;
    r.assert_status(200);
    assert_eq!(r.body["groups"], json!([]));
    assert_eq!(r.body["colors"], json!({}));
    assert!(!r.body.to_string().contains("Todo"));
    // The same on a visible field keeps both.
    let visible =
        p.f.view_of(
            &t,
            "G2",
            "grid",
            json!({
                "groups": [{ "field_id": p.status, "direction": "asc" }],
                "row_color": { "mode": "by_select", "field_id": p.status },
            }),
        )
        .await;
    let token = p.f.share(&visible, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = pub_post(
        &p.f.app,
        &format!("/api/public/shares/{token}/query"),
        json!({}),
    )
    .await;
    assert!(!r.body["groups"].as_array().unwrap().is_empty());
    assert!(!r.body["colors"].as_object().unwrap().is_empty());
}

#[tokio::test]
async fn public_description_only_names_a_visible_field() {
    let p = people().await;
    let t = p.f.table_id.clone();
    let notes = p.f.notes_id.clone();
    let info = async |hidden: Value| {
        let view =
            p.f.view_of(
                &t,
                "Board",
                "kanban",
                json!({
                    "hidden_fields": hidden,
                    "kanban": { "stack_field_id": p.status },
                    "description_field_id": notes,
                }),
            )
            .await;
        let token = p.f.share(&view, "view", None).await["token"]
            .as_str()
            .unwrap()
            .to_string();
        let r = pub_get(&p.f.app, &format!("/api/public/shares/{token}")).await;
        r.assert_status(200);
        r.body
    };
    let shown = info(json!([])).await;
    assert_eq!(shown["config"]["description_field_id"], notes);
    // Hidden in the view: the public page learns nothing about it.
    let hidden = info(json!([notes])).await;
    assert!(hidden["config"]["description_field_id"].is_null());
    assert!(!hidden.to_string().contains(notes.as_str()), "{hidden}");
}

#[tokio::test]
async fn public_links_show_names_and_nothing_else_about_the_linked_record() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&t, "Orders", &orders).await;
    let order_name = id_of(&f.field(&orders, "Name").await);
    let order = f.create(&orders, json!({ &order_name: "Order #1" })).await;
    f.set(
        &t,
        &p.ids[0],
        json!({ link["id"].as_str().unwrap(): [order["id"]] }),
    )
    .await;
    let view = f.new_view(&t, "Pub", json!({})).await;
    let token = f.share(&view, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = pub_post(
        &f.app,
        &format!("/api/public/shares/{token}/query"),
        json!({}),
    )
    .await;
    let cell = &r.body["records"][0]["values"][link["id"].as_str().unwrap()];
    assert_eq!(*cell, json!([{ "id": order["id"], "name": "Order #1" }]));
}

#[tokio::test]
async fn bad_public_queries_are_enveloped_errors() {
    let s = setup().await;
    let r = pub_post(s.app(), &s.query_path(), json!({ "offset": "x" })).await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
    let r = pub_post(s.app(), &s.query_path(), json!({ "timezone": "Mars/Base" })).await;
    r.assert_status(400);
}

// ----------------------------------------------------- 404s and passwords

#[tokio::test]
async fn unknown_disabled_and_wrong_kind_tokens_are_404() {
    let s = setup().await;
    let app = s.app();
    for path in [
        "/api/public/shares/shr_nope".to_string(),
        "/api/public/shares/".to_string() + &"x".repeat(500),
        format!("/api/public/forms/{}", s.token),
        format!("/api/public/shares/{}", s.token.to_uppercase()),
    ] {
        let r = pub_get(app, &path).await;
        assert_eq!(r.status, 404, "{path}");
        assert_eq!(r.body["error"]["code"], "not_found");
        assert!(
            r.headers[axum::http::header::CACHE_CONTROL] == "no-store",
            "{path}"
        );
    }
    pub_post(app, "/api/public/shares/shr_nope/query", json!({}))
        .await
        .assert_status(404);
    // Disabled: 404 on every endpoint, then back on again.
    let sid = s.share["id"].as_str().unwrap();
    s.p.f
        .app
        .patch(
            &s.p.f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    pub_get(app, &s.info_path()).await.assert_status(404);
    pub_post(app, &s.query_path(), json!({}))
        .await
        .assert_status(404);
    s.p.f
        .app
        .patch(
            &s.p.f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": true }),
        )
        .await
        .assert_status(200);
    pub_get(app, &s.info_path()).await.assert_status(200);
    // Deleted: gone for good.
    s.p.f
        .app
        .delete(&s.p.f.owner, &format!("/api/shares/{sid}"))
        .await
        .assert_status(204);
    pub_get(app, &s.info_path()).await.assert_status(404);
}

#[tokio::test]
async fn deleting_the_view_table_or_base_closes_the_link() {
    // View.
    let s = setup().await;
    s.p.f
        .app
        .delete(&s.p.f.owner, &format!("/api/views/{}", s.view))
        .await
        .assert_status(200);
    pub_get(s.app(), &s.info_path()).await.assert_status(404);
    pub_post(s.app(), &s.query_path(), json!({}))
        .await
        .assert_status(404);

    // Table (needs a second table so the first can go).
    let s = setup().await;
    s.p.f.add_table("Other").await;
    s.p.f
        .app
        .delete(&s.p.f.owner, &format!("/api/tables/{}", s.p.f.table_id))
        .await
        .assert_status(200);
    pub_get(s.app(), &s.info_path()).await.assert_status(404);

    // Base.
    let s = setup().await;
    s.p.f
        .app
        .delete(&s.p.f.owner, &format!("/api/bases/{}", s.p.f.base_id))
        .await
        .assert_status(200);
    pub_get(s.app(), &s.info_path()).await.assert_status(404);

    // Restoring the view brings the link back.
    let s = setup().await;
    let f = &s.p.f;
    f.app
        .delete(&f.owner, &format!("/api/views/{}", s.view))
        .await
        .assert_status(200);
    pub_get(s.app(), &s.info_path()).await.assert_status(404);
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "view", "id": s.view }),
        )
        .await
        .assert_status(200);
    pub_get(s.app(), &s.info_path()).await.assert_status(200);
}

#[tokio::test]
async fn password_protected_links() {
    let p = people().await;
    let view = p.f.new_view(&p.f.table_id, "Locked", json!({})).await;
    let share = p.f.share(&view, "view", Some("open sesame")).await;
    let token = share["token"].as_str().unwrap().to_string();
    let info = format!("/api/public/shares/{token}");
    let query = format!("/api/public/shares/{token}/query");
    let app = &p.f.app;

    // No password.
    for r in [
        pub_get(app, &info).await,
        pub_post(app, &query, json!({})).await,
    ] {
        r.assert_status(401);
        assert_eq!(r.body["error"]["code"], "share_password_required");
        assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
        assert!(r.body.get("records").is_none());
    }
    // Wrong passwords (including near misses and an empty header).
    for wrong in ["open sesam", "OPEN SESAME", "open sesame ", "x"] {
        let r = pub_get_pw(app, &info, wrong).await;
        r.assert_status(401);
        assert_eq!(r.body["error"]["code"], "share_password_invalid", "{wrong}");
        let r = pub_post_pw(app, &query, json!({}), wrong).await;
        assert_eq!(r.body["error"]["code"], "share_password_invalid");
    }
    let r = pub_get_pw(app, &info, "").await;
    assert_eq!(r.body["error"]["code"], "share_password_required");
    // Right password.
    pub_get_pw(app, &info, "open sesame")
        .await
        .assert_status(200);
    let r = pub_post_pw(app, &query, json!({}), "open sesame").await;
    r.assert_status(200);
    assert_eq!(r.body["total"], 5);
    // The password is not accepted from the URL.
    pub_get(app, &format!("{info}?password=open%20sesame"))
        .await
        .assert_status(401);

    // Change it, then remove it.
    let sid = share["id"].as_str().unwrap();
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "password": "new-secret" }),
        )
        .await
        .assert_status(200);
    pub_get_pw(app, &info, "open sesame")
        .await
        .assert_status(401);
    pub_get_pw(app, &info, "new-secret")
        .await
        .assert_status(200);
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "password": null }),
        )
        .await
        .assert_status(200);
    pub_get(app, &info).await.assert_status(200);
    // A password sent to an open link is harmless.
    pub_get_pw(app, &info, "whatever").await.assert_status(200);
}

#[tokio::test]
async fn a_disabled_protected_link_is_404_not_a_password_prompt() {
    let p = people().await;
    let view = p.f.new_view(&p.f.table_id, "Locked", json!({})).await;
    let share = p.f.share(&view, "view", Some("open sesame")).await;
    let sid = share["id"].as_str().unwrap();
    p.f.app
        .patch(
            &p.f.owner,
            &format!("/api/shares/{sid}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    let r = pub_get(
        &p.f.app,
        &format!("/api/public/shares/{}", share["token"].as_str().unwrap()),
    )
    .await;
    r.assert_status(404);
}

// --------------------------------------------------------- rate limiting

#[tokio::test]
async fn public_requests_are_rate_limited_per_client_address() {
    let s = setup().await;
    let app = s.app();
    let limit = openbase::api::sharing::IP_LIMIT as usize;
    for i in 0..limit {
        let r = anon(app, "GET", &s.info_path(), None, &[], "203.0.113.7").await;
        assert_eq!(r.status, 200, "request {i}");
    }
    let r = anon(app, "GET", &s.info_path(), None, &[], "203.0.113.7").await;
    r.assert_status(429);
    assert_eq!(r.body["error"]["code"], "too_many_requests");
    assert!(r.headers[axum::http::header::CACHE_CONTROL] == "no-store");
    // Another address is unaffected, and so is the signed-in API.
    anon(app, "GET", &s.info_path(), None, &[], "203.0.113.8")
        .await
        .assert_status(200);
    app.get(&s.p.f.owner, &format!("/api/bases/{}", s.p.f.base_id))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn public_requests_are_rate_limited_per_token_across_addresses() {
    let s = setup().await;
    let app = s.app();
    let per_ip = openbase::api::sharing::IP_LIMIT as usize;
    let limit = openbase::api::sharing::TOKEN_LIMIT as usize;
    let mut sent = 0;
    let mut ip_n = 0;
    while sent < limit {
        ip_n += 1;
        let ip = format!("192.0.2.{ip_n}");
        for _ in 0..per_ip.min(limit - sent) {
            let r = anon(app, "GET", &s.info_path(), None, &[], &ip).await;
            assert_eq!(r.status, 200, "request {sent}");
            sent += 1;
        }
    }
    // A fresh address is under its own limit but the token is exhausted.
    let r = anon(app, "GET", &s.info_path(), None, &[], "192.0.2.200").await;
    r.assert_status(429);
    assert_eq!(r.body["error"]["code"], "too_many_requests");
    // Other tokens are unaffected.
    let other = s.p.f.share(&s.view, "view", None).await;
    let path = format!("/api/public/shares/{}", other["token"].as_str().unwrap());
    anon(app, "GET", &path, None, &[], "192.0.2.200")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn public_transient_overrides_may_only_use_shown_fields() {
    let s = setup().await;
    let q = s.query_path();
    // Filtering, sorting or grouping by a hidden field would reveal its values.
    let hidden_filter =
        json!({ "transient": { "filter": and(vec![cond(&s.secret, "gt", json!(102))]) } });
    let hidden_sort =
        json!({ "transient": { "sorts": [{ "field_id": s.secret, "direction": "desc" }] } });
    let hidden_group = json!({ "transient": { "groups": [{ "field_id": s.dbl }] } });
    let nested = json!({ "transient": { "filter": and(vec![
        or(vec![cond(&s.p.age, "gt", json!(1)), cond(&s.secret, "is", json!(103))]) ]) } });
    for body in [hidden_filter, hidden_sort, hidden_group, nested] {
        let r = pub_post(s.app(), &q, body).await;
        r.assert_status(400);
        assert!(r.body.get("records").is_none());
    }
    // The same override on a shown field works.
    let r = pub_post(
        s.app(),
        &q,
        json!({ "transient": {
            "filter": and(vec![cond(&s.p.age, "gt", json!(29))]),
            "sorts": [{ "field_id": s.p.age, "direction": "desc" }] } }),
    )
    .await;
    r.assert_status(200);
    assert_eq!(names(&s.p, &r.body), ["Carol", "Alice", "Eve"]);
}

#[tokio::test]
async fn public_group_headers_carry_no_user_ids_or_raw_values() {
    let s = setup().await;
    let owner_id = s.p.f.owner.user_id.clone().unwrap();
    for field in [&s.assignee, &s.made_by, &s.p.status] {
        let r = pub_post(
            s.app(),
            &s.query_path(),
            json!({ "transient": { "groups": [{ "field_id": field }] } }),
        )
        .await;
        r.assert_status(200);
        let raw = String::from_utf8(r.bytes.clone()).unwrap();
        assert!(!raw.contains(&owner_id), "user id in group headers: {raw}");
        assert!(!raw.contains("\"usr"), "user id in group headers: {raw}");
        let groups = r.body["groups"].as_array().unwrap();
        assert!(!groups.is_empty());
        for g in groups {
            // The raw value is only for dragging records between groups.
            assert_eq!(g["value"], Value::Null, "{g}");
        }
        if field != &s.p.status {
            assert_eq!(groups[0]["label"], "Owner");
            assert_eq!(groups[0]["count"], 5);
            assert!(
                groups[0]["key"].as_str().unwrap().starts_with("user-"),
                "{}",
                groups[0]
            );
        }
    }
}

#[tokio::test]
async fn public_group_headers_are_capped_and_truncated() {
    let s = setup().await;
    let t = s.p.f.table_id.clone();
    let name = s.p.name.clone();
    let max = openbase::engine::query::PUBLIC_MAX_GROUP_HEADERS;
    let text_cap = openbase::engine::query::PUBLIC_GROUP_TEXT_CHARS;
    // More distinct names than a response may carry headers for, one of
    // them very long.
    let mut records: Vec<Value> = (0..max + 50)
        .map(|i| json!({ "values": { &name: format!("name {i:05}") } }))
        .collect();
    records.push(json!({ "values": { &name: "a".repeat(5_000) } }));
    for chunk in records.chunks(500) {
        let r = s
            .app()
            .post(&s.p.f.owner, &records_url(&t), json!({ "records": chunk }))
            .await;
        r.assert_status(201);
    }

    let body = json!({ "limit": 1, "transient": { "groups": [{ "field_id": name }] } });
    let r = pub_post(s.app(), &s.query_path(), body).await;
    r.assert_status(200);
    let groups = r.body["groups"].as_array().unwrap();
    assert_eq!(groups.len(), max);
    assert_eq!(r.body["total"], 5 + max + 50 + 1);
    for g in groups {
        assert!(g["key"].as_str().unwrap().chars().count() <= text_cap);
        assert!(g["label"].as_str().unwrap().chars().count() <= text_cap);
    }
    // The signed-in view of the same query is unaffected: complete headers.
    let full =
        s.p.f
            .query(json!({ "limit": 1, "transient": { "groups": [{ "field_id": name }] } }))
            .await;
    assert_eq!(full["groups"].as_array().unwrap().len(), 5 + max + 50 + 1);
}

#[tokio::test]
async fn password_guessing_is_throttled() {
    let p = people().await;
    let view = p.f.new_view(&p.f.table_id, "Locked", json!({})).await;
    let token = p.f.share(&view, "view", Some("the-password")).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let path = format!("/api/public/shares/{token}");
    let limit = openbase::api::sharing::PASSWORD_LIMIT as usize;
    for i in 0..limit {
        let r = anon(
            &p.f.app,
            "GET",
            &path,
            None,
            &[("x-share-password", "wrong")],
            "198.51.100.1",
        )
        .await;
        assert_eq!(r.status, 401, "attempt {i}");
    }
    // Further guesses are refused without being checked, even the right one.
    let r = anon(
        &p.f.app,
        "GET",
        &path,
        None,
        &[("x-share-password", "the-password")],
        "198.51.100.1",
    )
    .await;
    r.assert_status(429);
    // Another client can still get in with the right password.
    let r = anon(
        &p.f.app,
        "GET",
        &path,
        None,
        &[("x-share-password", "the-password")],
        "198.51.100.2",
    )
    .await;
    r.assert_status(200);
}

// ----------------------------------------------------------- attachments

#[tokio::test]
async fn shared_views_serve_attachments_through_the_share_token() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let att = f.upload("hello.txt", b"hello shared world").await;
    f.set(&t, &p.ids[0], json!({ &files: [att] })).await;
    let view = f.new_view(&t, "Pub", json!({})).await;
    let share = f.share(&view, "view", Some("pw-1234")).await;
    let token = share["token"].as_str().unwrap().to_string();
    let att_url = format!("/api/attachments/{}/hello.txt", att["id"].as_str().unwrap());

    // The public query lists the attachment reference.
    let q = pub_post_pw(
        &f.app,
        &format!("/api/public/shares/{token}/query"),
        json!({}),
        "pw-1234",
    )
    .await;
    q.assert_status(200);
    assert_eq!(q.body["records"][0]["values"][&files][0]["id"], att["id"]);
    assert_eq!(
        q.body["records"][0]["values"][&files][0]["filename"],
        "hello.txt"
    );

    // Anonymous download needs the token and, here, the password.
    pub_get(&f.app, &att_url).await.assert_status(404);
    pub_get(&f.app, &format!("{att_url}?share={token}"))
        .await
        .assert_status(404);
    pub_get_pw(&f.app, &format!("{att_url}?share={token}"), "wrong")
        .await
        .assert_status(404);
    let ok = pub_get_pw(&f.app, &format!("{att_url}?share={token}"), "pw-1234").await;
    ok.assert_status(200);
    assert_eq!(ok.bytes, b"hello shared world");
    // A made-up token and a form token do not work.
    pub_get_pw(&f.app, &format!("{att_url}?share=shr_made_up"), "pw-1234")
        .await
        .assert_status(404);
    let form_view = f.view_of(&t, "Form", "form", json!({})).await;
    let form_token = f.share(&form_view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    pub_get(&f.app, &format!("{att_url}?share={form_token}"))
        .await
        .assert_status(404);

    // Disabling the share closes the download too.
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{}", share["id"].as_str().unwrap()),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    pub_get_pw(&f.app, &format!("{att_url}?share={token}"), "pw-1234")
        .await
        .assert_status(404);
}

#[tokio::test]
async fn a_share_does_not_open_attachments_of_other_bases() {
    let p = people().await;
    let f = &p.f;
    let token = f.share(&f.view_id, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    // A second base with its own upload.
    let other = base(&f.app, &f.owner, &f.ws, "Other").await;
    let other_base = other["id"].as_str().unwrap();
    let up = post_multipart(
        &f.app,
        &f.owner,
        &format!("/api/bases/{other_base}/attachments"),
        &[("file", Some("secret.txt"), b"nope")],
        &[],
    )
    .await;
    up.assert_status(200);
    let url = format!(
        "/api/attachments/{}/secret.txt?share={token}",
        up.body["id"].as_str().unwrap()
    );
    pub_get(&f.app, &url).await.assert_status(404);
}

// ------------------------------------------- share-scoped attachments (B2)

#[tokio::test]
async fn a_share_token_only_opens_attachments_its_view_shows() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let secret = id_of(&f.attachment_field(&t, "Secret files").await);
    let up = |name: &'static str| async move { f.upload(name, name.as_bytes()).await };
    let (shown, hidden, filtered, trashed, loose) = (
        up("shown.txt").await,
        up("hidden.txt").await,
        up("filtered.txt").await,
        up("trashed.txt").await,
        up("loose.txt").await,
    );
    let other_table = id_of(&f.add_table("Other").await);
    let other_files = id_of(&f.attachment_field(&other_table, "Files").await);
    let elsewhere = up("elsewhere.txt").await;
    f.create(&other_table, json!({ &other_files: [elsewhere.clone()] }))
        .await;
    let kept = f
        .create(
            &t,
            json!({ &p.name: "Kept", &p.age: 40, &files: [shown.clone()], &secret: [hidden.clone()] }),
        )
        .await;
    f.create(
        &t,
        json!({ &p.name: "Young", &p.age: 5, &files: [filtered.clone()] }),
    )
    .await;
    let gone = f
        .create(
            &t,
            json!({ &p.name: "Gone", &p.age: 50, &files: [trashed.clone()] }),
        )
        .await;
    f.delete_records(&t, &[gone["id"].as_str().unwrap()])
        .await
        .assert_status(204);

    let view = f
        .view_of(
            &t,
            "Public",
            "grid",
            json!({
                "filter": and(vec![cond(&p.age, "gte", json!(30))]),
                "hidden_fields": [secret],
            }),
        )
        .await;
    let token = f.share(&view, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let url = |att: &Value, name: &str| {
        format!(
            "/api/attachments/{}/{name}?share={token}",
            att["id"].as_str().unwrap()
        )
    };
    // What the view shows opens (file and thumbnail route alike).
    let ok = pub_get(&f.app, &url(&shown, "shown.txt")).await;
    ok.assert_status(200);
    assert_eq!(ok.bytes, b"shown.txt");
    // Nothing else of the base does, though the ids are real.
    for (att, name) in [
        (&hidden, "hidden.txt"),
        (&filtered, "filtered.txt"),
        (&trashed, "trashed.txt"),
        (&loose, "loose.txt"),
        (&elsewhere, "elsewhere.txt"),
    ] {
        pub_get(&f.app, &url(att, name)).await.assert_status(404);
    }
    // The owner still reads everything in the base.
    f.app
        .get(
            &f.owner,
            &format!(
                "/api/attachments/{}/hidden.txt",
                hidden["id"].as_str().unwrap()
            ),
        )
        .await
        .assert_status(200);

    // Taking the file off the record closes the download at once.
    f.set(&t, kept["id"].as_str().unwrap(), json!({ &files: [] }))
        .await;
    pub_get(&f.app, &url(&shown, "shown.txt"))
        .await
        .assert_status(404);
    f.set(
        &t,
        kept["id"].as_str().unwrap(),
        json!({ &files: [shown.clone()] }),
    )
    .await;
    pub_get(&f.app, &url(&shown, "shown.txt"))
        .await
        .assert_status(200);

    // Hiding the field in the view closes it too.
    f.configure_view(&view, json!({ "hidden_fields": [files, secret] }))
        .await;
    pub_get(&f.app, &url(&shown, "shown.txt"))
        .await
        .assert_status(404);
    f.configure_view(&view, json!({ "hidden_fields": [secret] }))
        .await;
    pub_get(&f.app, &url(&shown, "shown.txt"))
        .await
        .assert_status(200);

    // A trashed workspace takes its share links with it.
    let ws = f.ws.clone();
    schema_support::sql(&f.app, move |tx| {
        tx.execute("UPDATE workspaces SET deleted_at = 1 WHERE id = ?1", [&ws])
    });
    pub_get(&f.app, &url(&shown, "shown.txt"))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn a_file_uploaded_through_a_public_form_is_not_readable_with_a_view_share() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let form_view = f
        .view_of(
            &t,
            "Form",
            "form",
            json!({ "form": { "fields": [ { "field_id": files } ] } }),
        )
        .await;
    let form_token = f.share(&form_view, "form", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let view_token = f.share(&f.view_id, "view", None).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let up = post_multipart(
        &f.app,
        &f.app.anon(),
        &format!("/api/public/forms/{form_token}/attachments"),
        &[("file", Some("drive-by.txt"), b"mine")],
        &[],
    )
    .await;
    up.assert_status(200);
    let id = up.body["id"].as_str().unwrap();
    pub_get(
        &f.app,
        &format!("/api/attachments/{id}/drive-by.txt?share={view_token}"),
    )
    .await
    .assert_status(404);
}

#[tokio::test]
async fn attachment_password_guesses_are_rate_limited() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let att = f.upload("a.txt", b"a").await;
    f.set(&t, &p.ids[0], json!({ &files: [att.clone()] })).await;
    let token = f.share(&f.view_id, "view", Some("pw-1234")).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let url = format!(
        "/api/attachments/{}/a.txt?share={token}",
        att["id"].as_str().unwrap()
    );
    let mut statuses = Vec::new();
    for i in 0..(openbase::api::sharing::PASSWORD_LIMIT + 5) {
        let r = pub_get_pw(&f.app, &url, &format!("wrong-{i}")).await;
        statuses.push(r.status.as_u16());
    }
    let limit = openbase::api::sharing::PASSWORD_LIMIT as usize;
    assert!(statuses[..limit].iter().all(|s| *s == 404), "{statuses:?}");
    assert!(statuses[limit..].iter().all(|s| *s == 429), "{statuses:?}");
    // Even the right password waits for the window.
    pub_get_pw(&f.app, &url, "pw-1234").await.assert_status(429);
}
