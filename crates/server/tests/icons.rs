//! Icons on workspaces, bases and tables: validation, set / clear / unchanged
//! PATCH semantics, who may change them, duplication, trash listing and the
//! public / invite payloads that carry them.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use openbase::perm::Role;
use serde_json::{Value, json};
use share_support::*;

fn ws_path(f: &Fixture) -> String {
    format!("/api/workspaces/{}", f.ws)
}

fn base_path(f: &Fixture) -> String {
    format!("/api/bases/{}", f.base_id)
}

fn table_path(f: &Fixture) -> String {
    format!("/api/tables/{}", f.table_id)
}

/// The fixture workspace as listed for its owner.
async fn listed_workspace(f: &Fixture) -> Value {
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    list.assert_status(200);
    list.body[0].clone()
}

const BAD_ICONS: [&str; 7] = [
    "",
    "Briefcase",
    "chart column",
    "chart_column",
    "caf\u{e9}",
    "\u{1F4BC}",
    "a-very-long-icon-name-that-goes-on-and-on-past-the-limit-of-sixty-four-characters",
];

#[tokio::test]
async fn workspace_icon_set_clear_and_unchanged() {
    let f = Fixture::new().await;
    // new workspace: no icon
    assert!(listed_workspace(&f).await["icon"].is_null());

    // set
    let r = f
        .app
        .patch(&f.owner, &ws_path(&f), json!({ "icon": "briefcase" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["icon"], "briefcase");
    assert_eq!(listed_workspace(&f).await["icon"], "briefcase");

    // absent = unchanged (a rename must not touch the icon)
    let r = f
        .app
        .patch(&f.owner, &ws_path(&f), json!({ "name": "Renamed" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["name"], "Renamed");
    assert_eq!(r.body["icon"], "briefcase");
    f.app
        .patch(&f.owner, &ws_path(&f), json!({}))
        .await
        .assert_status(200);
    assert_eq!(listed_workspace(&f).await["icon"], "briefcase");

    // name and icon together
    let r = f
        .app
        .patch(
            &f.owner,
            &ws_path(&f),
            json!({ "name": "Both", "icon": "building-2" }),
        )
        .await;
    assert_eq!(
        (&r.body["name"], &r.body["icon"]),
        (&json!("Both"), &json!("building-2"))
    );

    // null = clear
    let r = f
        .app
        .patch(&f.owner, &ws_path(&f), json!({ "icon": null }))
        .await;
    r.assert_status(200);
    assert!(r.body["icon"].is_null());
    assert!(listed_workspace(&f).await["icon"].is_null());
}

#[tokio::test]
async fn workspace_icon_on_create_and_validation() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let r = app
        .post(
            &alice,
            "/api/workspaces",
            json!({ "name": "Acme", "icon": "store" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["icon"], "store");
    let none = app
        .post(&alice, "/api/workspaces", json!({ "name": "Plain" }))
        .await;
    none.assert_status(201);
    assert!(none.body["icon"].is_null());
    let explicit_null = app
        .post(
            &alice,
            "/api/workspaces",
            json!({ "name": "Null", "icon": null }),
        )
        .await;
    explicit_null.assert_status(201);
    assert!(explicit_null.body["icon"].is_null());

    let id = r.body["id"].as_str().unwrap();
    for bad in BAD_ICONS {
        let r = app
            .post(
                &alice,
                "/api/workspaces",
                json!({ "name": "x", "icon": bad }),
            )
            .await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request", "{bad:?}");
        app.patch(
            &alice,
            &format!("/api/workspaces/{id}"),
            json!({ "icon": bad }),
        )
        .await
        .assert_status(400);
    }
    // a non-string icon is a malformed body
    app.patch(
        &alice,
        &format!("/api/workspaces/{id}"),
        json!({ "icon": 7 }),
    )
    .await
    .assert_status(400);
    // the longest valid name (64 characters) is accepted
    let max = format!("a{}", "-b".repeat(31)) + "c";
    assert_eq!(max.len(), 64);
    app.patch(
        &alice,
        &format!("/api/workspaces/{id}"),
        json!({ "icon": max }),
    )
    .await
    .assert_status(200);
    // a failed update changes nothing
    let list = app.get(&alice, "/api/workspaces").await;
    let ws = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == id)
        .unwrap();
    assert_eq!(ws["icon"], max.as_str());
}

#[tokio::test]
async fn base_icon_set_clear_unchanged_and_validation() {
    let f = Fixture::new().await;
    let path = base_path(&f);
    assert!(f.schema().await["icon"].is_null());

    let r = f
        .app
        .patch(&f.owner, &path, json!({ "icon": "chart-column" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["icon"], "chart-column");
    // listed in the workspace summary
    assert_eq!(
        listed_workspace(&f).await["bases"][0]["icon"],
        "chart-column"
    );

    // unchanged by other updates
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "name": "Renamed", "color": "red" }),
        )
        .await;
    assert_eq!(r.body["icon"], "chart-column");

    // null clears
    let r = f.app.patch(&f.owner, &path, json!({ "icon": null })).await;
    r.assert_status(200);
    assert!(r.body["icon"].is_null());
    assert!(listed_workspace(&f).await["bases"][0]["icon"].is_null());

    for bad in BAD_ICONS {
        let r = f.app.patch(&f.owner, &path, json!({ "icon": bad })).await;
        r.assert_status(400);
    }
    let create_url = format!("/api/workspaces/{}/bases", f.ws);
    for bad in BAD_ICONS {
        f.app
            .post(&f.owner, &create_url, json!({ "name": "x", "icon": bad }))
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn table_icon_create_set_clear_unchanged_and_validation() {
    let f = Fixture::new().await;
    let tables_url = format!("/api/bases/{}/tables", f.base_id);

    // created with an icon, and without
    let r = f
        .app
        .post(
            &f.owner,
            &tables_url,
            json!({ "name": "Orders", "icon": "shopping-cart" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["icon"], "shopping-cart");
    let id = r.body["id"].as_str().unwrap().to_string();
    let plain = f.add_table("Plain").await;
    assert!(plain["icon"].is_null());
    // the starter table has no icon
    assert!(f.table(&f.table_id).await["icon"].is_null());

    // visible in the base schema
    assert_eq!(f.table(&id).await["icon"], "shopping-cart");

    let path = format!("/api/tables/{id}");
    // set
    let r = f
        .app
        .patch(&f.owner, &path, json!({ "icon": "truck" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["icon"], "truck");
    // unchanged: rename, description and an empty body
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "name": "Shipments", "description": "d" }),
        )
        .await;
    assert_eq!(r.body["icon"], "truck");
    let r = f.app.patch(&f.owner, &path, json!({})).await;
    assert_eq!(r.body["icon"], "truck");
    // clear
    let r = f.app.patch(&f.owner, &path, json!({ "icon": null })).await;
    r.assert_status(200);
    assert!(r.body["icon"].is_null());
    assert!(f.table(&id).await["icon"].is_null());

    for bad in BAD_ICONS {
        f.app
            .patch(&f.owner, &path, json!({ "icon": bad }))
            .await
            .assert_status(400);
        f.app
            .post(&f.owner, &tables_url, json!({ "name": "x", "icon": bad }))
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn only_roles_that_can_rename_can_change_an_icon() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        // workspace: owner only
        let u = f.member("m@example.com", role);
        let r = f
            .app
            .patch(&u, &ws_path(&f), json!({ "icon": "star" }))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if role == Role::Owner { 200 } else { 403 },
            "workspace {role:?}"
        );
        // base and table: creator and up
        let r = f
            .app
            .patch(&u, &base_path(&f), json!({ "icon": "star" }))
            .await;
        let creator_up = role >= Role::Creator;
        assert_eq!(
            r.status.as_u16(),
            if creator_up { 200 } else { 403 },
            "base {role:?}"
        );
        let r = f
            .app
            .patch(&u, &table_path(&f), json!({ "icon": "star" }))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if creator_up { 200 } else { 403 },
            "table {role:?}"
        );
        // everybody who can see an entity sees its icon
        let schema = f.app.get(&u, &base_path(&f)).await;
        assert_eq!(
            schema.body["icon"] == "star",
            creator_up,
            "base icon visible {role:?}"
        );
    }
}

#[tokio::test]
async fn duplicate_base_and_table_copy_icons() {
    let f = Fixture::new().await;
    f.app
        .patch(&f.owner, &base_path(&f), json!({ "icon": "store" }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &table_path(&f), json!({ "icon": "package" }))
        .await
        .assert_status(200);
    let second = f.add_table("Second").await;
    // no icon on the second table: the copy has none either
    let plain = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/duplicate", second["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    plain.assert_status(201);
    assert!(plain.body["icon"].is_null());

    // table copy keeps the icon (with and without records)
    for include_records in [true, false] {
        let r = f
            .app
            .post(
                &f.owner,
                &format!("/api/tables/{}/duplicate", f.table_id),
                json!({ "include_records": include_records }),
            )
            .await;
        r.assert_status(201);
        assert_eq!(
            r.body["icon"], "package",
            "include_records={include_records}"
        );
    }

    // base copy keeps the base icon and every table icon
    let r = f
        .app
        .post(&f.owner, &format!("{}/duplicate", base_path(&f)), json!({}))
        .await;
    r.assert_status(201);
    assert_eq!(r.body["icon"], "store");
    let tables = r.body["tables"].as_array().unwrap();
    let icon_of = |name: &str| {
        tables
            .iter()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("no table {name}"))["icon"]
            .clone()
    };
    assert_eq!(icon_of("Table 1"), "package");
    assert_eq!(icon_of("Table 1 copy"), "package");
    assert!(icon_of("Second").is_null());
    // the copy's icons are independent of the source's
    let copy_id = r.body["id"].as_str().unwrap();
    f.app
        .patch(
            &f.owner,
            &format!("/api/bases/{copy_id}"),
            json!({ "icon": null }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.schema().await["icon"], "store");
}

#[tokio::test]
async fn trash_listing_carries_icons() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = t2["id"].as_str().unwrap().to_string();
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{t2id}"),
            json!({ "icon": "truck" }),
        )
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2id}"))
        .await
        .assert_status(200);
    let listing = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/trash", f.base_id))
        .await;
    listing.assert_status(200);
    let item = &listing.body["items"][0];
    assert_eq!(item["kind"], "table");
    assert_eq!(item["icon"], "truck");

    // base in the workspace trash, then the workspace itself
    f.app
        .patch(&f.owner, &base_path(&f), json!({ "icon": "store" }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &ws_path(&f), json!({ "icon": "briefcase" }))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &base_path(&f))
        .await
        .assert_status(200);
    let wt = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/trash", f.ws))
        .await;
    assert_eq!(wt.body["items"][0]["kind"], "base");
    assert_eq!(wt.body["items"][0]["icon"], "store");
    f.app
        .delete(&f.owner, &ws_path(&f))
        .await
        .assert_status(200);
    let deleted = f.app.get(&f.owner, "/api/trash/workspaces").await;
    deleted.assert_status(200);
    assert_eq!(deleted.body["items"][0]["kind"], "workspace");
    assert_eq!(deleted.body["items"][0]["icon"], "briefcase");
}

#[tokio::test]
async fn icons_survive_trash_and_restore() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t2id = t2["id"].as_str().unwrap().to_string();
    let path = format!("/api/tables/{t2id}");
    f.app
        .patch(&f.owner, &path, json!({ "icon": "truck" }))
        .await
        .assert_status(200);
    f.app.delete(&f.owner, &path).await.assert_status(200);
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "table", "id": t2id }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(&t2id).await["icon"], "truck");
}

#[tokio::test]
async fn public_view_and_form_carry_base_and_table_icons() {
    let f = Fixture::new().await;
    f.app
        .patch(&f.owner, &base_path(&f), json!({ "icon": "store" }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &table_path(&f), json!({ "icon": "package" }))
        .await
        .assert_status(200);

    let share = f.share(&f.view_id, "view", None).await;
    let r = pub_get(
        &f.app,
        &format!("/api/public/shares/{}", share["token"].as_str().unwrap()),
    )
    .await;
    r.assert_status(200);
    assert_eq!(r.body["base_icon"], "store");
    assert_eq!(r.body["table_icon"], "package");

    let form_view = f.view_of(&f.table_id, "Intake", "form", Value::Null).await;
    let form = f.share(&form_view, "form", None).await;
    let r = pub_get(
        &f.app,
        &format!("/api/public/forms/{}", form["token"].as_str().unwrap()),
    )
    .await;
    r.assert_status(200);
    assert_eq!(r.body["base_icon"], "store");
    assert_eq!(r.body["table_icon"], "package");

    // cleared icons are null in the public payloads too
    f.app
        .patch(&f.owner, &table_path(&f), json!({ "icon": null }))
        .await
        .assert_status(200);
    let r = pub_get(
        &f.app,
        &format!("/api/public/forms/{}", form["token"].as_str().unwrap()),
    )
    .await;
    assert!(r.body["table_icon"].is_null());
}

#[tokio::test]
async fn invite_preview_carries_the_target_icon() {
    let f = Fixture::new().await;
    f.app
        .patch(&f.owner, &ws_path(&f), json!({ "icon": "briefcase" }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &base_path(&f), json!({ "icon": "store" }))
        .await
        .assert_status(200);
    for (url, icon) in [
        (format!("/api/workspaces/{}/invites", f.ws), "briefcase"),
        (format!("/api/bases/{}/invites", f.base_id), "store"),
    ] {
        let res = f
            .app
            .post(&f.owner, &url, json!({ "role": "viewer" }))
            .await;
        res.assert_status(201);
        let token = res.body["url"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap()
            .to_string();
        let p = f
            .app
            .get(&f.app.anon(), &format!("/api/invites/by-token/{token}"))
            .await;
        p.assert_status(200);
        assert_eq!(p.body["target_icon"], icon);
    }
}
