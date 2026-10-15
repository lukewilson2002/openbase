//! Workspaces: CRUD, membership, base access (all bases or a picked list),
//! last-owner protection, and the role matrix.

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
async fn list_includes_bases_with_the_member_role_people_and_counts() {
    let f = Fixture::new().await;
    let editor = f.member("ed@example.com", Role::Editor);
    f.app
        .post(
            &f.owner,
            &format!("/api/workspaces/{}/invites", f.ws),
            json!({ "role": "viewer", "email": "new@example.com" }),
        )
        .await
        .assert_status(201);
    let list = f.app.get(&editor, "/api/workspaces").await;
    list.assert_status(200);
    let ws = &list.body[0];
    assert_eq!(ws["role"], "editor");
    assert_eq!(ws["member_count"], 2);
    assert_eq!(ws["pending_invite_count"], 1);
    let base = &ws["bases"][0];
    assert_eq!(base["id"], f.base_id.as_str());
    assert_eq!(base["role"], "editor");
    assert_eq!(base["name"], "CRM");
    let people = base["people"].as_array().unwrap();
    assert_eq!(people.len(), 3, "{people:?}");
    assert_eq!(people[0]["email"], "owner@example.com");
    assert_eq!(people[0]["pending"], false);
    assert_eq!(people[1]["email"], "ed@example.com");
    assert_eq!(people[1]["role"], "editor");
    assert_eq!(people[2]["email"], "new@example.com");
    assert_eq!(people[2]["name"], "new@example.com");
    assert_eq!(people[2]["pending"], true);
    assert!(people[2]["user_id"].is_null());
}

#[tokio::test]
async fn a_limited_member_sees_only_their_bases() {
    let f = Fixture::new().await;
    let other = base(&f.app, &f.owner, &f.ws, "Secret").await;
    let other_id = other["id"].as_str().unwrap();
    let guest = f.base_guest("guest@example.com", Role::Viewer);

    let list = f.app.get(&guest, "/api/workspaces").await;
    list.assert_status(200);
    let ws = &list.body[0];
    assert_eq!(ws["id"], f.ws.as_str());
    assert_eq!(ws["role"], "viewer");
    let bases = ws["bases"].as_array().unwrap();
    assert_eq!(bases.len(), 1, "only the listed base is shown");
    assert_eq!(bases[0]["id"], f.base_id.as_str());
    assert_eq!(bases[0]["role"], "viewer");
    // The owner sees the limited member on the shared base only.
    let owner_list = f.app.get(&f.owner, "/api/workspaces").await;
    let people_of = |id: &str| -> Vec<String> {
        owner_list.body[0]["bases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == id)
            .unwrap()["people"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["email"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(people_of(&f.base_id).contains(&"guest@example.com".to_string()));
    assert!(!people_of(other_id).contains(&"guest@example.com".to_string()));

    // access follows the listing: listed base yes, the sibling base no
    f.app
        .get(&guest, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    f.app
        .get(&guest, &format!("/api/bases/{other_id}"))
        .await
        .assert_status(404);
    f.app
        .get(&guest, &format!("/api/bases/{other_id}/members"))
        .await
        .assert_status(404);
    // as a workspace member they may see who else is in it, but not add bases
    f.app
        .get(&guest, &format!("/api/workspaces/{}/members", f.ws))
        .await
        .assert_status(200);
    f.app
        .post(
            &guest,
            &format!("/api/workspaces/{}/bases", f.ws),
            json!({ "name": "nope" }),
        )
        .await
        .assert_status(403);
}

#[tokio::test]
async fn an_all_bases_member_sees_new_bases_and_a_limited_one_does_not() {
    let f = Fixture::new().await;
    let all = f.member("all@example.com", Role::Viewer);
    let limited = f.base_guest("lim@example.com", Role::Viewer);
    let new = base(&f.app, &f.owner, &f.ws, "Later").await;
    let new_id = new["id"].as_str().unwrap();
    let ids = |body: &serde_json::Value| -> Vec<String> {
        body[0]["bases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["id"].as_str().unwrap().to_string())
            .collect()
    };
    let list = f.app.get(&all, "/api/workspaces").await;
    assert!(ids(&list.body).contains(&new_id.to_string()));
    f.app
        .get(&all, &format!("/api/bases/{new_id}"))
        .await
        .assert_status(200);
    let list = f.app.get(&limited, "/api/workspaces").await;
    assert_eq!(ids(&list.body), vec![f.base_id.clone()]);
    f.app
        .get(&limited, &format!("/api/bases/{new_id}"))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn a_limited_creator_can_open_the_base_they_create() {
    let f = Fixture::new().await;
    let creator = f.base_guest("cr@example.com", Role::Creator);
    let r = f
        .app
        .post(
            &creator,
            &format!("/api/workspaces/{}/bases", f.ws),
            json!({ "name": "Mine" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["role"], "creator");
    let id = r.body["id"].as_str().unwrap();
    f.app
        .get(&creator, &format!("/api/bases/{id}"))
        .await
        .assert_status(200);
    let members = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/members", f.ws))
        .await;
    let me = members
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "cr@example.com")
        .unwrap()
        .clone();
    assert_eq!(me["all_bases"], false);
    assert_eq!(me["base_ids"], json!([f.base_id, id]));
    // a duplicate is theirs too
    let r = f
        .app
        .post(&creator, &format!("/api/bases/{id}/duplicate"), json!({}))
        .await;
    r.assert_status(201);
    let copy = r.body["id"].as_str().unwrap();
    f.app
        .get(&creator, &format!("/api/bases/{copy}"))
        .await
        .assert_status(200);
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
        .patch(
            &f.owner,
            &path(&ed_id),
            json!({ "base_ids": ["appNOSUCH"] }),
        )
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

fn member_of(body: &serde_json::Value, email: &str) -> serde_json::Value {
    body.as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == email)
        .cloned()
        .unwrap_or_else(|| panic!("{email} not in {body}"))
}

#[tokio::test]
async fn patch_member_changes_base_access_and_tells_the_bases() {
    let f = Fixture::new().await;
    let second = base(&f.app, &f.owner, &f.ws, "Ops").await;
    let second_id = second["id"].as_str().unwrap().to_string();
    let ed = f.member("ed@example.com", Role::Editor);
    let path = format!(
        "/api/workspaces/{}/members/{}",
        f.ws,
        ed.user_id.clone().unwrap()
    );
    let members_path = format!("/api/workspaces/{}/members", f.ws);
    let m = member_of(
        &f.app.get(&f.owner, &members_path).await.body,
        "ed@example.com",
    );
    assert_eq!(m["all_bases"], true);
    assert_eq!(m["base_ids"], json!([]));

    let mut first_rx = f.app.state.events.subscribe(&f.base_id);
    let mut second_rx = f.app.state.events.subscribe(&second_id);
    f.app
        .patch(&f.owner, &path, json!({ "base_ids": [second_id] }))
        .await
        .assert_status(200);
    // Both bases are told: the one they lost (streams re-check access) and the other.
    for rx in [&mut first_rx, &mut second_rx] {
        let env = rx.try_recv().expect("BaseChanged event");
        assert_eq!(env.event, ob_core::api::events::BaseEvent::BaseChanged);
    }
    let m = member_of(
        &f.app.get(&f.owner, &members_path).await.body,
        "ed@example.com",
    );
    assert_eq!(m["all_bases"], false);
    assert_eq!(m["base_ids"], json!([second_id]));
    assert_eq!(m["role"], "editor");
    f.app
        .get(&ed, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(404);
    f.app
        .get(&ed, &format!("/api/bases/{second_id}"))
        .await
        .assert_status(200);

    // A role change alone keeps the list.
    f.app
        .patch(&f.owner, &path, json!({ "role": "viewer" }))
        .await
        .assert_status(200);
    let m = member_of(
        &f.app.get(&f.owner, &members_path).await.body,
        "ed@example.com",
    );
    assert_eq!(
        (m["role"].as_str(), m["base_ids"].clone()),
        (Some("viewer"), json!([second_id]))
    );

    // A limited member keeps at least one base.
    for body in [
        json!({ "base_ids": [] }),
        json!({ "all_bases": false, "base_ids": [] }),
    ] {
        f.app.patch(&f.owner, &path, body).await.assert_status(400);
    }
    // Bases of another workspace are refused.
    let (_, foreign) = f.app.workspace_with_base(&f.owner, "Elsewhere");
    f.app
        .patch(&f.owner, &path, json!({ "base_ids": [foreign] }))
        .await
        .assert_status(400);

    // Back to every base.
    f.app
        .patch(&f.owner, &path, json!({ "all_bases": true }))
        .await
        .assert_status(200);
    let m = member_of(
        &f.app.get(&f.owner, &members_path).await.body,
        "ed@example.com",
    );
    assert_eq!(m["all_bases"], true);
    f.app
        .get(&ed, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    // Switching an all-bases member to limited needs the list.
    f.app
        .patch(&f.owner, &path, json!({ "all_bases": false }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn owners_always_have_every_base() {
    let f = Fixture::new().await;
    let second = f.member("second@example.com", Role::Owner);
    let path = format!(
        "/api/workspaces/{}/members/{}",
        f.ws,
        second.user_id.clone().unwrap()
    );
    for body in [
        json!({ "base_ids": [f.base_id] }),
        json!({ "all_bases": false, "base_ids": [f.base_id] }),
        json!({ "role": "owner", "base_ids": [f.base_id] }),
    ] {
        f.app.patch(&f.owner, &path, body).await.assert_status(400);
    }
    // Making a limited member an owner gives them every base.
    let limited = f.base_guest("lim@example.com", Role::Editor);
    let other = base(&f.app, &f.owner, &f.ws, "Other").await;
    f.app
        .patch(
            &f.owner,
            &format!(
                "/api/workspaces/{}/members/{}",
                f.ws,
                limited.user_id.clone().unwrap()
            ),
            json!({ "role": "owner" }),
        )
        .await
        .assert_status(200);
    let m = member_of(
        &f.app
            .get(&f.owner, &format!("/api/workspaces/{}/members", f.ws))
            .await
            .body,
        "lim@example.com",
    );
    assert_eq!(
        (m["role"].as_str(), &m["all_bases"]),
        (Some("owner"), &json!(true))
    );
    f.app
        .get(
            &limited,
            &format!("/api/bases/{}", other["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
}
