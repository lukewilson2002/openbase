//! Workspaces, members, invites and the admin tools; and the permission errors every tool gives
//! (missing role vs missing token capability), checked from the model's side.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::json;

#[tokio::test]
async fn workspaces_can_be_renamed_deleted_and_restored() {
    let r = Rig::new().await;
    let a = &r.agent;
    let renamed = a
        .call(
            "rename_workspace",
            json!({"workspace_id": r.ws, "name": "Renamed"}),
        )
        .await;
    assert_eq!(renamed["workspace"]["name"], "Renamed");
    assert_eq!(
        a.call("list_workspaces", json!({})).await["workspaces"][0]["name"],
        "Renamed"
    );

    let extra = a.call("create_workspace", json!({"name": "Scratch"})).await["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let del = a
        .call("delete_workspace", json!({"workspace_id": extra}))
        .await;
    assert!(del["note"].as_str().unwrap().contains("restore_from_trash"));
    let names: Vec<String> = a.call("list_workspaces", json!({})).await["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Renamed"]);
    let trash = a.call("list_trash", json!({})).await;
    assert!(
        trash["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "workspace" && i["id"] == extra),
        "{trash}"
    );
    a.call(
        "restore_from_trash",
        json!({"kind": "workspace", "id": extra}),
    )
    .await;
    assert_eq!(
        a.call("list_workspaces", json!({})).await["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Unknown ids and empty renames are explained.
    let e = a
        .fails(
            "rename_workspace",
            json!({"workspace_id": "wspNope", "name": "x"}),
        )
        .await;
    assert!(e.contains("not found"), "{e}");
}

#[tokio::test]
async fn members_and_invites_for_workspaces_and_bases() {
    let r = Rig::new().await;
    let a = &r.agent;

    // A base invite: the person gets that base only.
    let invite = a
        .call(
            "create_invite",
            json!({"scope": "base", "id": r.base, "role": "commenter"}),
        )
        .await;
    let url = invite["url"].as_str().unwrap().to_string();
    assert!(url.contains("/invite/"), "{url}");
    let token = url.rsplit('/').next().unwrap();
    let (res, guest) = r
        .app()
        .signup("guest@example.com", "guest password 12345", Some(token))
        .await;
    res.assert_status(200);
    let guest_id = guest.user_id.clone().unwrap();

    let members = a
        .call("list_members", json!({"scope": "base", "id": r.base}))
        .await;
    let row = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == guest_id)
        .unwrap_or_else(|| panic!("guest in {members}"));
    assert_eq!(row["role"], "commenter");
    let collab = a
        .call("list_collaborators", json!({"base_id": r.base}))
        .await;
    assert!(
        collab["collaborators"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["email"] == "guest@example.com")
    );

    a.call(
        "set_member_role",
        json!({"scope": "base", "id": r.base, "user_id": guest_id, "role": "editor"}),
    )
    .await;
    let members = a
        .call("list_members", json!({"scope": "base", "id": r.base}))
        .await;
    assert_eq!(
        members["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["user_id"] == guest_id)
            .unwrap()["role"],
        "editor"
    );
    a.call(
        "remove_member",
        json!({"scope": "base", "id": r.base, "user_id": guest_id}),
    )
    .await;
    let members = a
        .call("list_members", json!({"scope": "base", "id": r.base}))
        .await;
    assert!(
        !members["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["user_id"] == guest_id)
    );
    assert_eq!(
        r.app()
            .get(&guest, &format!("/api/bases/{}", r.base))
            .await
            .status
            .as_u16(),
        404,
        "the removed member lost access"
    );

    // Workspace invites can be listed and revoked; a revoked link no longer works.
    let invite = a
        .call(
            "create_invite",
            json!({"scope": "workspace", "id": r.ws, "role": "viewer"}),
        )
        .await;
    let invite_id = invite["info"]["id"].as_str().unwrap().to_string();
    let revoked_token = invite["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let pending = a
        .call("list_invites", json!({"scope": "workspace", "id": r.ws}))
        .await;
    assert!(
        pending["invites"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == invite_id)
    );
    a.call("revoke_invite", json!({"invite_id": invite_id}))
        .await;
    let pending = a
        .call("list_invites", json!({"scope": "workspace", "id": r.ws}))
        .await;
    assert!(
        !pending["invites"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == invite_id),
        "{pending}"
    );
    let (res, _) = r
        .app()
        .signup(
            "late@example.com",
            "late password 12345",
            Some(&revoked_token),
        )
        .await;
    assert!(
        res.status.as_u16() >= 400,
        "a revoked invite cannot be used: {}",
        res.body
    );

    // Roles are validated, and a workspace keeps an owner.
    let e = a
        .fails(
            "create_invite",
            json!({"scope": "workspace", "id": r.ws, "role": "boss"}),
        )
        .await;
    assert!(
        e.contains("Invalid arguments") || e.to_lowercase().contains("role"),
        "{e}"
    );
    let me = r.admin.user_id.clone().unwrap();
    let e = a
        .fails(
            "set_member_role",
            json!({"scope": "workspace", "id": r.ws, "user_id": me, "role": "viewer"}),
        )
        .await;
    assert!(e.to_lowercase().contains("owner"), "{e}");
}

// ----------------------------------------------------------------- permission errors

#[tokio::test]
async fn permission_errors_say_whether_the_role_or_the_token_is_missing() {
    let r = Rig::new().await;
    r.table("T").await;
    r.field("T", "N", "number", json!({})).await;
    let b = r.base.as_str();

    // -- token capability: hidden from the list, refused when called by name
    let read = r.agent_with(json!({"write": false})).await;
    let write = r.agent_with(json!({"write": true})).await;
    let read_tools = read.tool_names().await;
    let write_tools = write.tool_names().await;
    assert!(!read_tools.contains(&"create_field".to_string()));
    assert!(write_tools.contains(&"create_field".to_string()));
    assert!(!write_tools.contains(&"rename_workspace".to_string()));
    let e = read
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "X", "type": "number"}),
        )
        .await;
    assert!(
        e.contains("write access") && e.contains("not read-only"),
        "{e}"
    );
    let e = write
        .fails(
            "rename_workspace",
            json!({"workspace_id": r.ws, "name": "x"}),
        )
        .await;
    assert!(
        e.contains("'manage' permission") && e.contains("Allow managing"),
        "{e}"
    );
    let e = write.fails("admin_stats", json!({})).await;
    assert!(e.contains("manage") && e.contains("administrator"), "{e}");
    // ...and nothing happened.
    let schema = r.schema().await;
    assert_eq!(schema["tables"][0]["fields"].as_array().unwrap().len(), 3);

    // -- role: a token only ever acts as its user
    let (_, viewer) = r
        .teammate("viewer@example.com", "viewer", json!({"write": true}))
        .await;
    let e = viewer
        .fails(
            "create_field",
            json!({"base_id": b, "table": "T", "name": "X", "type": "number"}),
        )
        .await;
    assert!(e.contains("requires the creator role"), "{e}");
    let e = viewer
        .fails(
            "create_records",
            json!({"base_id": b, "table": "T", "records": [{"fields": {"Name": "x"}}]}),
        )
        .await;
    assert!(e.contains("editor role") || e.contains("requires"), "{e}");
    let (_, editor) = r
        .teammate("editor@example.com", "editor", json!({"write": true}))
        .await;
    editor
        .call(
            "create_records",
            json!({"base_id": b, "table": "T", "records": [{"fields": {"Name": "x"}}]}),
        )
        .await;
    let e = editor
        .fails(
            "update_field",
            json!({"base_id": b, "table": "T", "field": "N", "name": "M"}),
        )
        .await;
    assert!(e.contains("requires the creator role"), "{e}");
    let e = editor
        .fails("delete_table", json!({"base_id": b, "table": "T"}))
        .await;
    assert!(e.contains("requires the creator role"), "{e}");
    let e = editor
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "a", "trigger": {"type": "webhook"}, "actions": []}),
        )
        .await;
    assert!(e.contains("creator role"), "{e}");
    let e = editor.fails("list_trash", json!({"base_id": b})).await;
    assert!(e.contains("creator role"), "{e}");
    // Manage token, but only a creator on the workspace: owner-only actions are refused.
    let (_, creator) = r
        .teammate(
            "creator@example.com",
            "creator",
            json!({"write": true, "manage": true}),
        )
        .await;
    let e = creator
        .fails(
            "rename_workspace",
            json!({"workspace_id": r.ws, "name": "x"}),
        )
        .await;
    assert!(e.contains("requires the owner role"), "{e}");
    let e = creator.fails("delete_base", json!({"base_id": b})).await;
    assert!(e.contains("owner role"), "{e}");
    let e = creator
        .fails(
            "set_member_role",
            json!({"scope": "base", "id": b, "user_id": "usrX", "role": "viewer"}),
        )
        .await;
    assert!(e.contains("owner role"), "{e}");
    // A user without any access cannot even tell the base exists.
    let outsider = r.app().user("outsider@example.com", "Outsider");
    let tok = r
        .app()
        .api_token(
            &outsider,
            json!({"name": "o", "write": true, "manage": true}),
        )
        .await;
    let out = r.live.agent(tok.bearer.as_deref().unwrap());
    for tool in ["get_base_schema", "list_collaborators"] {
        let e = out.fails(tool, json!({"base_id": b})).await;
        assert!(
            e.contains("not found, or you have no access") || e.contains("not found"),
            "{tool}: {e}"
        );
    }
    let e = out
        .fails("create_table", json!({"base_id": b, "name": "Sneaky"}))
        .await;
    assert!(e.contains("not found"), "{e}");

    // -- a token limited to one base
    let other = r
        .agent
        .call(
            "create_base",
            json!({"workspace_id": r.ws, "name": "Other"}),
        )
        .await["base"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let limited = r
        .agent_with(json!({"write": true, "manage": true, "base_ids": [b]}))
        .await;
    let listed = limited.call("list_bases", json!({})).await;
    let seen: Vec<&str> = listed["workspaces"][0]["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert_eq!(seen, [b]);
    let e = limited
        .fails("get_base_schema", json!({"base_id": other}))
        .await;
    assert!(e.contains("not found"), "{e}");
    let e = limited
        .fails("create_workspace", json!({"name": "Nope"}))
        .await;
    assert!(e.contains("limited to specific bases"), "{e}");
    let e = limited
        .fails("create_base", json!({"workspace_id": r.ws, "name": "Nope"}))
        .await;
    assert!(e.contains("limited to specific bases"), "{e}");
    limited
        .call("create_table", json!({"base_id": b, "name": "Allowed"}))
        .await;
    let e = limited
        .fails("create_table", json!({"base_id": other, "name": "Denied"}))
        .await;
    assert!(e.contains("not found"), "{e}");
}

#[tokio::test]
async fn credentials_sessions_and_tokens_are_out_of_reach() {
    let r = Rig::new().await;
    let a = &r.agent;
    let tools = a.tool_names().await;
    for t in &tools {
        for bad in ["token", "password", "session", "2fa", "credential", "login"] {
            assert!(!t.contains(bad), "no tool for {bad}: {t}");
        }
    }
    // The admin tools have no way to set a password or switch off someone's 2FA.
    let (status, body) = a.rpc("tools/list", json!({})).await;
    assert_eq!(status, 200);
    let props = |name: &str| -> Vec<String> {
        body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    assert!(!props("admin_create_user").contains(&"password".to_string()));
    assert!(!props("admin_update_user").contains(&"disable_2fa".to_string()));
    let e = a
        .fails(
            "admin_create_user",
            json!({"email": "x@example.com", "name": "X", "password": "hunter2hunter2"}),
        )
        .await;
    assert!(
        e.contains("Invalid arguments") && e.contains("password"),
        "{e}"
    );
    // The generic tool refuses them too.
    for (m, p) in [
        ("POST", "/api/auth/password"),
        ("GET", "/api/tokens"),
        ("POST", "/api/tokens"),
        ("POST", "/api/auth/2fa/disable"),
        ("GET", "/api/auth/sessions"),
        ("POST", "/api/admin/users/usrX/reset-link"),
    ] {
        let e = a
            .fails("api_request", json!({"method": m, "path": p, "body": {}}))
            .await;
        assert!(e.contains("not available through MCP"), "{m} {p}: {e}");
    }
    assert_eq!(
        r.app().query_i64("SELECT count(*) FROM api_tokens", &[]),
        1,
        "only the token that was created on the account page"
    );

    // Credential parts of otherwise allowed admin requests are refused by the server, whatever
    // the tool: a password for a new user, switching off someone's 2FA, and the SMTP password.
    let other = r.app().user("other@example.com", "Other");
    let other_id = other.user_id.clone().unwrap();
    r.app()
        .state
        .db
        .write_sync(|tx| Ok(tx.execute("UPDATE users SET totp_enabled = 1 WHERE id != ''", [])?))
        .unwrap();
    for (m, p, body, what) in [
        (
            "POST",
            "/api/admin/users".to_string(),
            json!({"email": "x@example.com", "name": "X", "password": "a long enough password"}),
            "set a user's password",
        ),
        (
            "PATCH",
            format!("/api/admin/users/{other_id}"),
            json!({"disable_2fa": true}),
            "two-factor",
        ),
        (
            "PATCH",
            "/api/admin/email".to_string(),
            json!({"password": "smtp-secret"}),
            "SMTP password",
        ),
    ] {
        let e = a
            .fails("api_request", json!({"method": m, "path": p, "body": body}))
            .await;
        assert!(e.contains("API tokens can never"), "{m} {p}: {e}");
        assert!(e.contains(what), "{m} {p}: {e}");
    }
    assert_eq!(
        r.app().query_i64(
            "SELECT totp_enabled FROM users WHERE id = ?1",
            &[other_id.as_str()]
        ),
        1,
        "2FA is still on"
    );
    assert_eq!(
        r.app().query_i64("SELECT count(*) FROM users", &[]),
        2,
        "no user was created"
    );
}

// ------------------------------------------------------------------------------- admin

#[tokio::test]
async fn admin_tools_manage_users_without_touching_credentials() {
    let r = Rig::new().await;
    let a = &r.agent;

    let created = a
        .call(
            "admin_create_user",
            json!({"email": "new.person@example.com", "name": "New Person"}),
        )
        .await;
    assert_eq!(created["user"]["email"], "new.person@example.com");
    assert_eq!(created["user"]["is_admin"], false);
    // An API token never receives a reset link, and says what to do instead.
    assert!(created.get("reset_link").is_none(), "{created}");
    let note = created["note"].as_str().unwrap();
    assert!(note.contains("without a usable password"), "{note}");
    assert!(note.contains("Admin > Users"), "{note}");
    assert!(
        note.contains("Email is not configured"),
        "email is off in this rig: {note}"
    );
    let new_id = created["user"]["id"].as_str().unwrap().to_string();
    // The account cannot be signed in to yet.
    let (login, _) = r
        .app()
        .login("new.person@example.com", "a brand new password 99")
        .await;
    login.assert_status(401);
    // What the human administrator does in the web app (a session): create the reset link and
    // hand it over; the person sets a password with it.
    let link = r
        .app()
        .post(
            &r.admin,
            &format!("/api/admin/users/{new_id}/reset-link"),
            json!({}),
        )
        .await;
    link.assert_status(200);
    let reset = link.body["url"].as_str().unwrap().to_string();
    assert!(reset.contains("/reset-password?token="), "{reset}");
    let reset_token = reset.rsplit("token=").next().unwrap();
    r.app()
        .post(
            &r.app().anon(),
            "/api/auth/password-reset/confirm",
            json!({"token": reset_token, "new_password": "a brand new password 99"}),
        )
        .await
        .assert_status(200);
    let (login, person) = r
        .app()
        .login("new.person@example.com", "a brand new password 99")
        .await;
    login.assert_status(200);
    let ptoken = r
        .app()
        .api_token(&person, json!({"name": "p", "write": false}))
        .await;
    let person_agent = r.live.agent(ptoken.bearer.as_deref().unwrap());
    person_agent.call("list_bases", json!({})).await;

    let e = a
        .fails(
            "admin_create_user",
            json!({"email": "new.person@example.com", "name": "Again"}),
        )
        .await;
    assert!(
        e.to_lowercase().contains("already") || e.to_lowercase().contains("exists"),
        "{e}"
    );

    let users = a.call("admin_list_users", json!({})).await;
    assert_eq!(users["users"].as_array().unwrap().len(), 2);

    // Deactivating cuts off the user's tokens; reactivating restores them.
    let off = a
        .call(
            "admin_update_user",
            json!({"user_id": new_id, "is_active": false}),
        )
        .await;
    assert_eq!(off["user"]["is_active"], false);
    let (status, _) = person_agent.rpc("tools/list", json!({})).await;
    assert_eq!(status, 401, "a deactivated user's token stops working");
    a.call(
        "admin_update_user",
        json!({"user_id": new_id, "is_active": true}),
    )
    .await;
    let (status, _) = person_agent.rpc("tools/list", json!({})).await;
    assert_eq!(status, 200);

    // Promote, rename, demote; the last administrator cannot be demoted.
    let up = a
        .call(
            "admin_update_user",
            json!({"user_id": new_id, "is_admin": true, "name": "Boss"}),
        )
        .await;
    assert_eq!(up["user"]["is_admin"], true);
    assert_eq!(up["user"]["name"], "Boss");
    a.call(
        "admin_update_user",
        json!({"user_id": new_id, "is_admin": false}),
    )
    .await;
    let me = r.admin.user_id.clone().unwrap();
    let e = a
        .fails(
            "admin_update_user",
            json!({"user_id": me, "is_admin": false}),
        )
        .await;
    assert!(e.to_lowercase().contains("admin"), "{e}");
    assert!(
        a.fails("admin_update_user", json!({"user_id": new_id}))
            .await
            .contains("Give something")
    );

    // Audit log and stats; every admin call by token was audited, naming the token.
    let log = a.call("admin_audit_log", json!({"limit": 5})).await;
    let entries = log["entries"].as_array().unwrap();
    assert!(entries.len() <= 5);
    assert!(
        entries.iter().any(|e| e["action"] == "admin_token_use"),
        "{log}"
    );
    let all = a.call("admin_audit_log", json!({"limit": 200})).await;
    let actions: Vec<&str> = all["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(
        actions.contains(&"admin_user_create") && actions.contains(&"admin_user_update"),
        "{actions:?}"
    );
    let stats = a.call("admin_stats", json!({})).await;
    assert_eq!(stats["stats"]["users"], 2);
    assert_eq!(stats["stats"]["workspaces"], 1);

    // Backups
    assert_eq!(
        a.call("admin_list_backups", json!({})).await["backups"],
        json!([])
    );
    let b = a.call("admin_create_backup", json!({})).await;
    let name = b["backup"]["name"].as_str().unwrap();
    assert!(!name.is_empty());
    let list = a.call("admin_list_backups", json!({})).await;
    assert_eq!(list["backups"][0]["name"], name);
    assert!(list["backups"][0]["size"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn admin_tools_need_an_administrator_with_a_manage_token() {
    let r = Rig::new().await;
    // A non-administrator with a manage token does not see (or get) the admin tools.
    let (_, mate) = r
        .teammate(
            "mate@example.com",
            "owner",
            json!({"write": true, "manage": true}),
        )
        .await;
    let tools = mate.tool_names().await;
    assert!(tools.contains(&"create_workspace".to_string()));
    assert!(
        !tools.iter().any(|t| t.starts_with("admin_")),
        "no admin tools for a non-administrator: {tools:?}"
    );
    for t in [
        "admin_list_users",
        "admin_stats",
        "admin_create_backup",
        "admin_audit_log",
    ] {
        let e = mate.fails(t, json!({})).await;
        assert!(e.contains("instance administrator"), "{t}: {e}");
    }
    // The administrator sees all ten with a manage token, none with a write-only token.
    let admin_tools: Vec<String> = r
        .agent
        .tool_names()
        .await
        .into_iter()
        .filter(|t| t.starts_with("admin_"))
        .collect();
    assert_eq!(admin_tools.len(), 10, "{admin_tools:?}");
    let write_only = r.agent_with(json!({"write": true})).await;
    assert!(
        !write_only
            .tool_names()
            .await
            .iter()
            .any(|t| t.starts_with("admin_"))
    );
    // A manage token limited to a base is refused workspace-level and admin actions.
    let limited = r
        .agent_with(json!({"write": true, "manage": true, "base_ids": [r.base]}))
        .await;
    let e = limited.fails("admin_stats", json!({})).await;
    assert!(
        e.contains("limited to specific bases") || e.contains("beyond single bases"),
        "{e}"
    );
}
