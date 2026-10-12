//! Bases: creation defaults, schema endpoint, update, delete, base-level
//! members and collaborators, role matrix.

mod common;
mod schema_support;

use opengrid::perm::Role;
use schema_support::*;
use serde_json::json;

#[tokio::test]
async fn new_base_has_starter_table_with_name_notes_and_grid_view() {
    let f = Fixture::new().await;
    let s = f.schema().await;
    assert_eq!(s["name"], "CRM");
    assert_eq!(s["color"], "blue");
    assert_eq!(s["role"], "owner");
    assert_eq!(s["workspace_id"], f.ws.as_str());
    let tables = s["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 1);
    let t = &tables[0];
    assert_eq!(t["name"], "Table 1");
    assert_eq!(t["base_id"], f.base_id.as_str());
    let fields = t["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0]["name"], "Name");
    assert_eq!(fields[0]["type"], "single_line_text");
    assert_eq!(fields[0]["id"], t["primary_field_id"]);
    assert_eq!(fields[1]["name"], "Notes");
    assert_eq!(fields[1]["type"], "long_text");
    let views = t["views"].as_array().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["name"], "Grid view");
    assert_eq!(views[0]["type"], "grid");
    assert_eq!(views[0]["personal"], false);
    assert_eq!(views[0]["locked"], false);
}

#[tokio::test]
async fn create_base_options_and_validation() {
    let f = Fixture::new().await;
    let url = format!("/api/workspaces/{}/bases", f.ws);
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": " Sales ", "color": "red", "icon": "briefcase" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["name"], "Sales");
    assert_eq!(r.body["color"], "red");
    assert_eq!(r.body["icon"], "briefcase");
    for bad in [
        json!({ "name": "" }),
        json!({ "name": "x", "color": "chartreuse" }),
        json!({ "name": "x", "icon": "i".repeat(65) }),
        json!({}),
    ] {
        f.app.post(&f.owner, &url, bad).await.assert_status(400);
    }
    // unknown workspace -> 404
    f.app
        .post(
            &f.owner,
            "/api/workspaces/wspNOPE/bases",
            json!({ "name": "x" }),
        )
        .await
        .assert_status(404);
}

#[tokio::test]
async fn creating_bases_requires_workspace_creator() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.member("u@example.com", role);
        let r = f
            .app
            .post(
                &u,
                &format!("/api/workspaces/{}/bases", f.ws),
                json!({ "name": "B" }),
            )
            .await;
        let expected = if role >= Role::Creator { 201 } else { 403 };
        assert_eq!(r.status.as_u16(), expected, "{role:?}");
        if expected == 201 {
            assert_eq!(r.body["role"], role.as_str());
        }
    }
}

#[tokio::test]
async fn schema_reports_callers_effective_role_and_hides_other_people() {
    let f = Fixture::new().await;
    for role in ALL_ROLES {
        let u = f.member(&format!("{}-user@example.com", role.as_str()), role);
        let r = f.app.get(&u, &format!("/api/bases/{}", f.base_id)).await;
        r.assert_status(200);
        assert_eq!(r.body["role"], role.as_str());
    }
    let outsider = f.app.user("out@example.com", "Out");
    f.app
        .get(&outsider, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    f.app
        .get(&outsider, "/api/bases/appNOPE")
        .await
        .assert_status(404);
}

#[tokio::test]
async fn schema_orders_by_position_and_skips_deleted_items() {
    let f = Fixture::new().await;
    let t2 = f.add_table("Second").await;
    let t3 = f.add_table("Third").await;
    let t2_id = t2["id"].as_str().unwrap();
    // move the third table to the front
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{}", t3["id"].as_str().unwrap()),
            json!({ "position": -5.5 }),
        )
        .await
        .assert_status(200);
    let names: Vec<String> = f.schema().await["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Third", "Table 1", "Second"]);

    // deleted table and field vanish from the schema
    f.app
        .delete(&f.owner, &format!("/api/tables/{t2_id}"))
        .await
        .assert_status(200);
    let extra = f
        .add_field(
            &f.table_id,
            json!({ "name": "Extra", "type": "number", "options": {} }),
        )
        .await;
    f.app
        .delete(
            &f.owner,
            &format!("/api/fields/{}", extra["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
    let s = f.schema().await;
    let names: Vec<&str> = s["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Third", "Table 1"]);
    let t1 = f.table(&f.table_id).await;
    assert_eq!(Fixture::field_names(&t1), ["Name", "Notes"]);
}

#[tokio::test]
async fn schema_shows_shared_views_plus_only_own_personal_views() {
    let f = Fixture::new().await;
    let ed1 = f.member("ed1@example.com", Role::Editor);
    let ed2 = f.member("ed2@example.com", Role::Editor);
    let url = format!("/api/tables/{}/views", f.table_id);
    f.app
        .post(
            &ed1,
            &url,
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await
        .assert_status(201);
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Shared", "type": "kanban" }),
        )
        .await
        .assert_status(201);

    let names = |v: &serde_json::Value| -> Vec<String> {
        v["tables"][0]["views"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["name"].as_str().unwrap().to_string())
            .collect()
    };
    let path = format!("/api/bases/{}", f.base_id);
    assert_eq!(
        names(&f.app.get(&ed1, &path).await.body),
        ["Grid view", "Mine", "Shared"]
    );
    assert_eq!(
        names(&f.app.get(&ed2, &path).await.body),
        ["Grid view", "Shared"]
    );
    assert_eq!(
        names(&f.app.get(&f.owner, &path).await.body),
        ["Grid view", "Shared"]
    );
}

#[tokio::test]
async fn update_base_name_color_icon_position() {
    let f = Fixture::new().await;
    let path = format!("/api/bases/{}", f.base_id);
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "name": " Renamed ", "color": "teal_dark", "icon": "star", "position": 7.5 }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["name"], "Renamed");
    assert_eq!(r.body["color"], "teal_dark");
    assert_eq!(r.body["icon"], "star");
    // an empty icon clears it
    let r = f.app.patch(&f.owner, &path, json!({ "icon": "" })).await;
    assert!(r.body["icon"].is_null());
    for bad in [
        json!({ "name": "" }),
        json!({ "color": "nope" }),
        json!({ "icon": "x".repeat(100) }),
    ] {
        f.app.patch(&f.owner, &path, bad).await.assert_status(400);
    }
    f.app
        .patch(&f.owner, &path, json!({ "position": "NaN" }))
        .await
        .assert_status(400);
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    assert_eq!(list.body[0]["bases"][0]["name"], "Renamed");
}

#[tokio::test]
async fn base_position_orders_the_workspace_listing() {
    let f = Fixture::new().await;
    let b2 = base(&f.app, &f.owner, &f.ws, "Second").await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/bases/{}", b2["id"].as_str().unwrap()),
            json!({ "position": -1 }),
        )
        .await
        .assert_status(200);
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    let names: Vec<&str> = list.body[0]["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Second", "CRM"]);
}

#[tokio::test]
async fn role_matrix_for_base_update_and_delete() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.base_guest("g@example.com", role);
        let path = format!("/api/bases/{}", f.base_id);
        let r = f.app.patch(&u, &path, json!({ "name": "X" })).await;
        assert_eq!(
            r.status.as_u16(),
            if role >= Role::Creator { 200 } else { 403 },
            "patch {role:?}"
        );
        let r = f.app.delete(&u, &path).await;
        assert_eq!(
            r.status.as_u16(),
            if role == Role::Owner { 200 } else { 403 },
            "delete {role:?}"
        );
    }
    let f = Fixture::new().await;
    let outsider = f.app.user("o@example.com", "O");
    let path = format!("/api/bases/{}", f.base_id);
    f.app
        .patch(&outsider, &path, json!({ "name": "X" }))
        .await
        .assert_status(404);
    f.app.delete(&outsider, &path).await.assert_status(404);
}

#[tokio::test]
async fn deleting_a_base_hides_it_and_notifies_subscribers() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let r = f
        .app
        .request(
            &f.owner,
            "DELETE",
            &format!("/api/bases/{}", f.base_id),
            None,
        )
        .await;
    r.assert_status(200);
    f.app
        .get(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    let env = rx.try_recv().unwrap();
    assert_eq!(env.event, og_core::api::events::BaseEvent::BaseChanged);
    // deleting again is a 404, not a second event
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn token_scopes_apply_to_base_endpoints() {
    let f = Fixture::new().await;
    let read = token_client(&f.app, &f.owner, false);
    let write = token_client(&f.app, &f.owner, true);
    let path = format!("/api/bases/{}", f.base_id);
    f.app.get(&read, &path).await.assert_status(200);
    // read-only tokens act as viewers
    f.app
        .patch(&read, &path, json!({ "name": "x" }))
        .await
        .assert_status(403);
    f.app
        .patch(&write, &path, json!({ "name": "x" }))
        .await
        .assert_status(200);
    // deleting a base is for people, not tokens
    f.app.delete(&write, &path).await.assert_status(403);
    f.app.get(&f.owner, &path).await.assert_status(200);
}

#[tokio::test]
async fn base_members_list_and_manage_requires_owner() {
    let f = Fixture::new().await;
    let guest = f.base_guest("guest@example.com", Role::Editor);
    let gid = guest.user_id.clone().unwrap();
    let list = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/members", f.base_id))
        .await;
    list.assert_status(200);
    let members = list.body.as_array().unwrap();
    assert_eq!(members.len(), 1, "workspace members are not base members");
    assert_eq!(members[0]["user_id"], gid.as_str());
    assert_eq!(members[0]["role"], "editor");
    assert_eq!(members[0]["email"], "guest@example.com");

    let path = format!("/api/bases/{}/members/{gid}", f.base_id);
    f.app
        .patch(&f.owner, &path, json!({ "role": "bogus" }))
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, &path, json!({ "role": "creator" }))
        .await
        .assert_status(200);
    let r = f
        .app
        .get(&guest, &format!("/api/bases/{}", f.base_id))
        .await;
    assert_eq!(r.body["role"], "creator");
    f.app
        .patch(
            &f.owner,
            &format!("/api/bases/{}/members/usrNOPE", f.base_id),
            json!({ "role": "viewer" }),
        )
        .await
        .assert_status(404);
    f.app.delete(&f.owner, &path).await.assert_status(200);
    f.app
        .get(&guest, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    f.app.delete(&f.owner, &path).await.assert_status(404);
}

#[tokio::test]
async fn base_member_endpoints_role_matrix() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let target = f.base_guest("target@example.com", Role::Viewer);
        let tid = target.user_id.clone().unwrap();
        let u = f.member("u@example.com", role);
        let ok = role == Role::Owner;
        let expect = |ok: bool| if ok { 200 } else { 403 };
        let list = f
            .app
            .get(&u, &format!("/api/bases/{}/members", f.base_id))
            .await;
        assert_eq!(list.status.as_u16(), expect(ok), "list {role:?}");
        let r = f
            .app
            .patch(
                &u,
                &format!("/api/bases/{}/members/{tid}", f.base_id),
                json!({ "role": "editor" }),
            )
            .await;
        assert_eq!(r.status.as_u16(), expect(ok), "patch {role:?}");
        let r = f
            .app
            .delete(&u, &format!("/api/bases/{}/members/{tid}", f.base_id))
            .await;
        assert_eq!(r.status.as_u16(), expect(ok), "delete {role:?}");
    }
}

#[tokio::test]
async fn base_member_can_leave_a_shared_base() {
    let f = Fixture::new().await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let gid = guest.user_id.clone().unwrap();
    let other = f.base_guest("other@example.com", Role::Viewer);
    let oid = other.user_id.clone().unwrap();
    f.app
        .delete(&guest, &format!("/api/bases/{}/members/{oid}", f.base_id))
        .await
        .assert_status(403);
    f.app
        .delete(&guest, &format!("/api/bases/{}/members/{gid}", f.base_id))
        .await
        .assert_status(200);
    assert_eq!(f.app.get(&guest, "/api/workspaces").await.body, json!([]));
}

#[tokio::test]
async fn collaborators_are_active_workspace_and_base_members() {
    let f = Fixture::new().await;
    let ed = f.member("ed@example.com", Role::Editor);
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let gone = f.member("gone@example.com", Role::Editor);
    let outsider = f.app.user("out@example.com", "Out");
    let gone_id = gone.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&gone_id])
    });

    // a viewer can call it
    let viewer = f.member("v@example.com", Role::Viewer);
    for caller in [&viewer, &guest, &ed] {
        let r = f
            .app
            .get(caller, &format!("/api/bases/{}/collaborators", f.base_id))
            .await;
        r.assert_status(200);
        let emails: Vec<&str> = r
            .body
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["email"].as_str().unwrap())
            .collect();
        assert!(emails.contains(&"owner@example.com"));
        assert!(emails.contains(&"ed@example.com"));
        assert!(emails.contains(&"guest@example.com"));
        assert!(
            !emails.contains(&"gone@example.com"),
            "inactive users are hidden"
        );
        assert!(!emails.contains(&"out@example.com"));
        let r0 = &r.body[0];
        assert!(r0["id"].is_string() && r0["name"].is_string());
    }
    f.app
        .get(
            &outsider,
            &format!("/api/bases/{}/collaborators", f.base_id),
        )
        .await
        .assert_status(404);
}
