//! Workspaces: CRUD, membership, last-owner protection, base-level sharing in
//! the workspace list, and the role matrix.

mod common;
mod schema_support;

use openbase::perm::Role;
use schema_support::*;
use serde_json::json;

#[tokio::test]
async fn creator_becomes_owner_and_sees_workspace_in_list() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    let r = app
        .post(&alice, "/api/workspaces", json!({ "name": "  Acme Inc  " }))
        .await;
    r.assert_status(201);
    assert_eq!(r.body["name"], "Acme Inc", "name is trimmed");
    assert_eq!(r.body["role"], "owner");
    assert_eq!(r.body["bases"], json!([]));

    let list = app.get(&alice, "/api/workspaces").await;
    list.assert_status(200);
    assert_eq!(list.body.as_array().unwrap().len(), 1);
    assert_eq!(list.body[0]["id"], r.body["id"]);

    let bob = app.user("bob@example.com", "Bob");
    assert_eq!(app.get(&bob, "/api/workspaces").await.body, json!([]));
}

#[tokio::test]
async fn anonymous_requests_are_rejected() {
    let app = new_app();
    app.get(&app.anon(), "/api/workspaces")
        .await
        .assert_status(401);
    app.post(&app.anon(), "/api/workspaces", json!({ "name": "x" }))
        .await
        .assert_status(401);
}

#[tokio::test]
async fn workspace_name_validation() {
    let app = new_app();
    let alice = app.user("alice@example.com", "Alice");
    for bad in ["", "   ", "tab\there"] {
        let r = app
            .post(&alice, "/api/workspaces", json!({ "name": bad }))
            .await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request");
    }
    let long = "x".repeat(256);
    app.post(&alice, "/api/workspaces", json!({ "name": long }))
        .await
        .assert_status(400);
    // malformed JSON and missing fields use the standard error format too
    let r = app.post(&alice, "/api/workspaces", json!({})).await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn list_includes_bases_with_effective_role() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    // direct base share raises the effective role to the max of both
    add_base_member(&f.app, &f.base_id, &editor, Role::Creator);
    let list = f.app.get(&editor, "/api/workspaces").await;
    list.assert_status(200);
    assert_eq!(list.body[0]["role"], "editor");
    assert_eq!(list.body[0]["bases"][0]["id"], f.base_id.as_str());
    assert_eq!(list.body[0]["bases"][0]["role"], "creator");
    assert_eq!(list.body[0]["bases"][0]["name"], "CRM");
}

#[tokio::test]
async fn base_sharing_shows_only_the_shared_base_with_null_workspace_role() {
    let f = Fixture::new().await;
    let other = base(&f.app, &f.owner, &f.ws, "Secret").await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);

    let list = f.app.get(&guest, "/api/workspaces").await;
    list.assert_status(200);
    let ws = &list.body[0];
    assert_eq!(ws["id"], f.ws.as_str());
    assert!(ws["role"].is_null(), "no workspace role");
    let bases = ws["bases"].as_array().unwrap();
    assert_eq!(bases.len(), 1, "only the shared base is listed");
    assert_eq!(bases[0]["id"], f.base_id.as_str());
    assert_eq!(bases[0]["role"], "viewer");

    // access follows the listing: shared base yes, the sibling base no
    f.app
        .get(&guest, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    f.app
        .get(
            &guest,
            &format!("/api/bases/{}", other["id"].as_str().unwrap()),
        )
        .await
        .assert_status(404);
    // and no workspace-level access
    f.app
        .get(&guest, &format!("/api/workspaces/{}/members", f.ws))
        .await
        .assert_status(404);
    f.app
        .post(
            &guest,
            &format!("/api/workspaces/{}/bases", f.ws),
            json!({ "name": "nope" }),
        )
        .await
        .assert_status(404);
}

#[tokio::test]
async fn deleted_workspace_and_bases_disappear_from_lists() {
    let f = Fixture::new().await;
    let guest = f.base_guest("guest@example.com", Role::Editor);
    let r = f
        .app
        .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
        .await;
    r.assert_status(200);
    assert_eq!(f.app.get(&f.owner, "/api/workspaces").await.body, json!([]));
    assert_eq!(f.app.get(&guest, "/api/workspaces").await.body, json!([]));
    f.app
        .get(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);

    // a deleted base alone disappears from the workspace listing
    let g = Fixture::new().await;
    g.app
        .delete(&g.owner, &format!("/api/bases/{}", g.base_id))
        .await
        .assert_status(200);
    let list = g.app.get(&g.owner, "/api/workspaces").await;
    assert_eq!(list.body[0]["bases"], json!([]));
}

#[tokio::test]
async fn rename_trims_validates_and_returns_summary() {
    let f = Fixture::new().await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}", f.ws),
            json!({ "name": " New " }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["name"], "New");
    assert_eq!(r.body["role"], "owner");
    assert_eq!(r.body["bases"][0]["name"], "CRM");
    f.app
        .patch(
            &f.owner,
            &format!("/api/workspaces/{}", f.ws),
            json!({ "name": " " }),
        )
        .await
        .assert_status(400);
    // no-op patch is fine
    f.app
        .patch(&f.owner, &format!("/api/workspaces/{}", f.ws), json!({}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn role_matrix_for_workspace_rename_delete_and_member_management() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.member(&format!("{}-user@example.com", role.as_str()), role);
        let target = f.member("target@example.com", Role::Viewer);
        let owner_only = role == Role::Owner;
        let expect = |ok: bool| if ok { 200 } else { 403 };

        let r = f
            .app
            .patch(
                &u,
                &format!("/api/workspaces/{}", f.ws),
                json!({ "name": "X" }),
            )
            .await;
        assert_eq!(r.status.as_u16(), expect(owner_only), "rename as {role:?}");

        let r = f
            .app
            .patch(
                &u,
                &format!(
                    "/api/workspaces/{}/members/{}",
                    f.ws,
                    target.user_id.clone().unwrap()
                ),
                json!({ "role": "editor" }),
            )
            .await;
        assert_eq!(
            r.status.as_u16(),
            expect(owner_only),
            "set role as {role:?}"
        );

        let r = f
            .app
            .delete(
                &u,
                &format!(
                    "/api/workspaces/{}/members/{}",
                    f.ws,
                    target.user_id.clone().unwrap()
                ),
            )
            .await;
        assert_eq!(
            r.status.as_u16(),
            expect(owner_only),
            "remove other as {role:?}"
        );

        // every member may read the member list
        f.app
            .get(&u, &format!("/api/workspaces/{}/members", f.ws))
            .await
            .assert_status(200);

        let r = f.app.delete(&u, &format!("/api/workspaces/{}", f.ws)).await;
        assert_eq!(r.status.as_u16(), expect(owner_only), "delete as {role:?}");
    }
}

#[tokio::test]
async fn non_members_get_404_everywhere() {
    let f = Fixture::new().await;
    let outsider = f.app.user("out@example.com", "Out");
    let ws = &f.ws;
    f.app
        .patch(
            &outsider,
            &format!("/api/workspaces/{ws}"),
            json!({ "name": "x" }),
        )
        .await
        .assert_status(404);
    f.app
        .delete(&outsider, &format!("/api/workspaces/{ws}"))
        .await
        .assert_status(404);
    f.app
        .get(&outsider, &format!("/api/workspaces/{ws}/members"))
        .await
        .assert_status(404);
    f.app
        .get(&outsider, &format!("/api/workspaces/{ws}/trash"))
        .await
        .assert_status(404);
    f.app
        .delete(
            &outsider,
            &format!(
                "/api/workspaces/{ws}/members/{}",
                outsider.user_id.clone().unwrap()
            ),
        )
        .await
        .assert_status(404);
}

#[tokio::test]
async fn member_list_shows_names_emails_and_roles() {
    let f = Fixture::new().await;
    let _ = f.member("ed@example.com", Role::Editor);
    let r = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/members", f.ws))
        .await;
    r.assert_status(200);
    let members = r.body.as_array().unwrap();
    assert_eq!(members.len(), 2);
    let owner = members.iter().find(|m| m["role"] == "owner").unwrap();
    assert_eq!(owner["email"], "owner@example.com");
    assert_eq!(owner["name"], "Owner");
    assert_eq!(owner["user_id"], f.owner.user_id.clone().unwrap().as_str());
    assert!(members.iter().any(|m| m["role"] == "editor"));
}

#[tokio::test]
async fn set_role_validates_role_and_member() {
    let f = Fixture::new().await;
    let ed = f.member("ed@example.com", Role::Editor);
    let ed_id = ed.user_id.clone().unwrap();
    let path = |uid: &str| format!("/api/workspaces/{}/members/{uid}", f.ws);
    f.app
        .patch(&f.owner, &path(&ed_id), json!({ "role": "admin" }))
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, &path(&ed_id), json!({}))
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, &path("usrNOSUCH"), json!({ "role": "viewer" }))
        .await
        .assert_status(404);
    let r = f
        .app
        .patch(&f.owner, &path(&ed_id), json!({ "role": "creator" }))
        .await;
    r.assert_status(200);
    let members = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/members", f.ws))
        .await;
    assert!(
        members
            .body
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["user_id"] == ed_id.as_str() && m["role"] == "creator")
    );
}

#[tokio::test]
async fn last_owner_cannot_be_demoted_or_removed() {
    let f = Fixture::new().await;
    let me = f.owner.user_id.clone().unwrap();
    let path = format!("/api/workspaces/{}/members/{me}", f.ws);

    let r = f
        .app
        .patch(&f.owner, &path, json!({ "role": "creator" }))
        .await;
    r.assert_status(409);
    assert_eq!(r.body["error"]["code"], "conflict");
    f.app.delete(&f.owner, &path).await.assert_status(409);
    // still the owner
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    assert_eq!(list.body[0]["role"], "owner");

    // with a second owner, the first may step down; then the second is the last owner
    let second = f.member("second@example.com", Role::Owner);
    f.app
        .patch(&f.owner, &path, json!({ "role": "creator" }))
        .await
        .assert_status(200);
    let second_path = format!(
        "/api/workspaces/{}/members/{}",
        f.ws,
        second.user_id.clone().unwrap()
    );
    f.app
        .patch(&second, &second_path, json!({ "role": "viewer" }))
        .await
        .assert_status(409);
    f.app.delete(&second, &second_path).await.assert_status(409);
}

#[tokio::test]
async fn members_can_leave_but_not_remove_others_unless_owner() {
    let f = Fixture::new().await;
    let viewer = f.member("v@example.com", Role::Viewer);
    let other = f.member("o@example.com", Role::Editor);
    let vid = viewer.user_id.clone().unwrap();
    let oid = other.user_id.clone().unwrap();

    f.app
        .delete(&viewer, &format!("/api/workspaces/{}/members/{oid}", f.ws))
        .await
        .assert_status(403);
    f.app
        .delete(&viewer, &format!("/api/workspaces/{}/members/{vid}", f.ws))
        .await
        .assert_status(200);
    // the viewer is gone: no more access
    f.app
        .get(&viewer, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    f.app
        .get(&viewer, "/api/workspaces")
        .await
        .assert_status(200);
    assert_eq!(f.app.get(&viewer, "/api/workspaces").await.body, json!([]));
    // owner removes someone else
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}/members/{oid}", f.ws))
        .await
        .assert_status(200);
    // removing an unknown member
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}/members/{oid}", f.ws))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn api_tokens_without_manage_cannot_manage_workspaces() {
    let f = Fixture::new().await;
    let token = token_client(&f.app, &f.owner, true);
    // Listing is a read every token may do (the table-driven capability test in
    // tests/token_capabilities.rs covers every manage-gated route).
    f.app
        .get(&token, "/api/workspaces")
        .await
        .assert_status(200);
    f.app
        .post(&token, "/api/workspaces", json!({ "name": "x" }))
        .await
        .assert_status(403);
    f.app
        .patch(
            &token,
            &format!("/api/workspaces/{}", f.ws),
            json!({ "name": "x" }),
        )
        .await
        .assert_status(403);
    f.app
        .delete(&token, &format!("/api/workspaces/{}", f.ws))
        .await
        .assert_status(403);
    f.app
        .get(&token, &format!("/api/workspaces/{}/members", f.ws))
        .await
        .assert_status(403);
    // Adding a base is content creation: a write token may do it.
    f.app
        .post(
            &token,
            &format!("/api/workspaces/{}/bases", f.ws),
            json!({ "name": "x" }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn member_changes_notify_bases_of_the_workspace() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let ed = f.member("ed@example.com", Role::Editor);
    f.app
        .patch(
            &f.owner,
            &format!(
                "/api/workspaces/{}/members/{}",
                f.ws,
                ed.user_id.clone().unwrap()
            ),
            json!({ "role": "viewer" }),
        )
        .await
        .assert_status(200);
    let env = rx.try_recv().expect("BaseChanged event");
    assert_eq!(env.event, ob_core::api::events::BaseEvent::BaseChanged);
    assert_eq!(env.user_id.as_deref(), f.owner.user_id.as_deref());
}
