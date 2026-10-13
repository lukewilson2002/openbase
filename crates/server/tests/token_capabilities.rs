//! Table-driven proof of the token capability policy (`auth::Capability`):
//!
//! - every manage-gated route works for a session and for a `manage` token exactly as far as the
//!   caller's role goes, and is refused (403) for write tokens without `manage`, read-only tokens
//!   and `manage` without `write`;
//! - every session-only route is refused for a `manage` token, whatever else the token may do;
//! - admin routes work for an administrator's `manage` token, are audited, and are refused for
//!   everyone else;
//! - the credential parts of the admin routes (password-reset links, a user's password and 2FA,
//!   the SMTP password) are session-only even for an administrator's `manage` token.
//!
//! `CASES`, `SESSION_ONLY`, `ADMIN_SESSION_ONLY` and `ADMIN` are also compared with the endpoint catalogue of the MCP
//! server (`mcp::catalogue`), so a route cannot change its capability without this test (and the
//! documentation) noticing.

mod common;

use common::{Client, TestApp};
use opengrid::perm::Role;
use serde_json::{Value, json};

const ROLES: [Role; 5] = [
    Role::Viewer,
    Role::Commenter,
    Role::Editor,
    Role::Creator,
    Role::Owner,
];

/// Ids of the objects every case can aim at.
struct Ids {
    ws: String,
    base: String,
    member: String,
    ws_invite: String,
    base_invite: String,
    accept_token: String,
    ws_deleted: String,
    base_deleted: String,
}

struct Fx {
    app: TestApp,
    owner: Client,
    ids: Ids,
}

fn invite_token(url: &str) -> String {
    url.rsplit('/').next().unwrap().to_string()
}

impl Fx {
    async fn new() -> Fx {
        let app = TestApp::new();
        let owner = app.admin("owner@example.com", "Owner");
        let (ws, base) = app.workspace_with_base(&owner, "Acme");
        let member = app.user("member@example.com", "Member");
        app.grant_workspace_role(&member, &ws, "editor");
        app.grant_base_role(&member, &base, "viewer");
        let ws_invite = app
            .post(
                &owner,
                &format!("/api/workspaces/{ws}/invites"),
                json!({"role": "viewer"}),
            )
            .await;
        ws_invite.assert_status(201);
        let base_invite = app
            .post(
                &owner,
                &format!("/api/bases/{base}/invites"),
                json!({"role": "viewer"}),
            )
            .await;
        base_invite.assert_status(201);
        // A workspace somebody else can be invited to.
        let (ws3, _) = app.workspace_with_base(&owner, "Third");
        let accept = app
            .post(
                &owner,
                &format!("/api/workspaces/{ws3}/invites"),
                json!({"role": "viewer"}),
            )
            .await;
        accept.assert_status(201);
        // A deleted workspace and a deleted base to restore.
        let (ws_deleted, _) = app.workspace_with_base(&owner, "Gone");
        app.delete(&owner, &format!("/api/workspaces/{ws_deleted}"))
            .await
            .assert_status(200);
        let extra = app
            .post(
                &owner,
                &format!("/api/workspaces/{ws}/bases"),
                json!({"name": "Old"}),
            )
            .await;
        extra.assert_status(201);
        let base_deleted = extra.body["id"].as_str().unwrap().to_string();
        app.delete(&owner, &format!("/api/bases/{base_deleted}"))
            .await
            .assert_status(200);
        let ids = Ids {
            member: member.user_id.clone().unwrap(),
            ws_invite: ws_invite.body["info"]["id"].as_str().unwrap().to_string(),
            base_invite: base_invite.body["info"]["id"].as_str().unwrap().to_string(),
            accept_token: invite_token(accept.body["url"].as_str().unwrap()),
            ws,
            base,
            ws_deleted,
            base_deleted,
        };
        Fx { app, owner, ids }
    }

    /// A user with `role` on the workspaces and bases of the fixture.
    fn user_with(&self, role: Option<Role>) -> Client {
        let n = opengrid::ids::new_id("u");
        let u = self.app.user(&format!("{n}@example.com"), "Actor");
        if let Some(role) = role {
            for ws in [&self.ids.ws, &self.ids.ws_deleted] {
                self.app.grant_workspace_role(&u, ws, role.as_str());
            }
        }
        u
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Min {
    /// No role needed (any signed-in user may try; the action is about the caller themself).
    Anyone,
    Role(Role),
}

/// How a `manage` token limited to one base fares.
#[derive(Clone, Copy, PartialEq)]
enum Scoped {
    /// Works on bases in scope (base-level action).
    Allowed,
    /// Refused: the action reaches beyond a single base.
    Refused,
    /// The target base is not one the token may see: 404, like any other base outside its scope.
    OutOfScope,
}

struct Case {
    name: &'static str,
    method: &'static str,
    /// The route template as registered and catalogued.
    template: &'static str,
    path: fn(&Ids) -> String,
    body: fn(&Ids) -> Option<Value>,
    min: Min,
    ok: u16,
    scoped: Scoped,
}

fn no_body(_: &Ids) -> Option<Value> {
    None
}

const CASES: &[Case] = &[
    Case {
        name: "create workspace",
        method: "POST",
        template: "/api/workspaces",
        path: |_| "/api/workspaces".into(),
        body: |_| Some(json!({"name": "New"})),
        min: Min::Anyone,
        ok: 201,
        scoped: Scoped::Refused,
    },
    Case {
        name: "rename workspace",
        method: "PATCH",
        template: "/api/workspaces/{id}",
        path: |i| format!("/api/workspaces/{}", i.ws),
        body: |_| Some(json!({"name": "Renamed"})),
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "delete workspace",
        method: "DELETE",
        template: "/api/workspaces/{id}",
        path: |i| format!("/api/workspaces/{}", i.ws),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "list workspace members",
        method: "GET",
        template: "/api/workspaces/{id}/members",
        path: |i| format!("/api/workspaces/{}/members", i.ws),
        body: no_body,
        min: Min::Role(Role::Viewer),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "change workspace member role",
        method: "PATCH",
        template: "/api/workspaces/{id}/members/{user_id}",
        path: |i| format!("/api/workspaces/{}/members/{}", i.ws, i.member),
        body: |_| Some(json!({"role": "viewer"})),
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "remove workspace member",
        method: "DELETE",
        template: "/api/workspaces/{id}/members/{user_id}",
        path: |i| format!("/api/workspaces/{}/members/{}", i.ws, i.member),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "list workspace invites",
        method: "GET",
        template: "/api/workspaces/{id}/invites",
        path: |i| format!("/api/workspaces/{}/invites", i.ws),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "create workspace invite",
        method: "POST",
        template: "/api/workspaces/{id}/invites",
        path: |i| format!("/api/workspaces/{}/invites", i.ws),
        body: |_| Some(json!({"role": "viewer"})),
        min: Min::Role(Role::Owner),
        ok: 201,
        scoped: Scoped::Refused,
    },
    Case {
        name: "list workspace trash",
        method: "GET",
        template: "/api/workspaces/{id}/trash",
        path: |i| format!("/api/workspaces/{}/trash", i.ws),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "list deleted workspaces",
        method: "GET",
        template: "/api/trash/workspaces",
        path: |_| "/api/trash/workspaces".into(),
        body: no_body,
        min: Min::Anyone,
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "restore workspace",
        method: "POST",
        template: "/api/trash/restore",
        path: |_| "/api/trash/restore".into(),
        body: |i| Some(json!({"kind": "workspace", "id": i.ws_deleted})),
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "restore base",
        method: "POST",
        template: "/api/trash/restore",
        path: |_| "/api/trash/restore".into(),
        body: |i| Some(json!({"kind": "base", "id": i.base_deleted})),
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::OutOfScope,
    },
    Case {
        name: "accept invite",
        method: "POST",
        template: "/api/invites/by-token/{token}/accept",
        path: |i| format!("/api/invites/by-token/{}/accept", i.accept_token),
        body: no_body,
        min: Min::Anyone,
        ok: 200,
        scoped: Scoped::Refused,
    },
    Case {
        name: "revoke workspace invite",
        method: "DELETE",
        template: "/api/invites/{id}",
        path: |i| format!("/api/invites/{}", i.ws_invite),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 204,
        scoped: Scoped::Refused,
    },
    Case {
        name: "revoke base invite",
        method: "DELETE",
        template: "/api/invites/{id}",
        path: |i| format!("/api/invites/{}", i.base_invite),
        body: no_body,
        min: Min::Role(Role::Creator),
        ok: 204,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "delete base",
        method: "DELETE",
        template: "/api/bases/{id}",
        path: |i| format!("/api/bases/{}", i.base),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "duplicate base",
        method: "POST",
        template: "/api/bases/{id}/duplicate",
        path: |i| format!("/api/bases/{}/duplicate", i.base),
        body: |_| Some(json!({})),
        min: Min::Role(Role::Creator),
        ok: 201,
        scoped: Scoped::Refused,
    },
    Case {
        name: "list base members",
        method: "GET",
        template: "/api/bases/{id}/members",
        path: |i| format!("/api/bases/{}/members", i.base),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "change base member role",
        method: "PATCH",
        template: "/api/bases/{id}/members/{user_id}",
        path: |i| format!("/api/bases/{}/members/{}", i.base, i.member),
        body: |_| Some(json!({"role": "commenter"})),
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "remove base member",
        method: "DELETE",
        template: "/api/bases/{id}/members/{user_id}",
        path: |i| format!("/api/bases/{}/members/{}", i.base, i.member),
        body: no_body,
        min: Min::Role(Role::Owner),
        ok: 200,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "list base invites",
        method: "GET",
        template: "/api/bases/{id}/invites",
        path: |i| format!("/api/bases/{}/invites", i.base),
        body: no_body,
        min: Min::Role(Role::Creator),
        ok: 200,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "create base invite",
        method: "POST",
        template: "/api/bases/{id}/invites",
        path: |i| format!("/api/bases/{}/invites", i.base),
        body: |_| Some(json!({"role": "viewer"})),
        min: Min::Role(Role::Creator),
        ok: 201,
        scoped: Scoped::Allowed,
    },
    Case {
        name: "update own profile",
        method: "PATCH",
        template: "/api/auth/me",
        path: |_| "/api/auth/me".into(),
        body: |_| Some(json!({"name": "New Name"})),
        min: Min::Anyone,
        ok: 200,
        scoped: Scoped::Allowed,
    },
];

/// Routes no token can ever use. (method, template, concrete path, body)
const SESSION_ONLY: &[(&str, &str, &str, Option<&str>)] = &[
    ("GET", "/api/tokens", "/api/tokens", None),
    (
        "POST",
        "/api/tokens",
        "/api/tokens",
        Some(r#"{"name":"child","write":true,"manage":true}"#),
    ),
    ("DELETE", "/api/tokens/{id}", "/api/tokens/patNope", None),
    (
        "POST",
        "/api/auth/password",
        "/api/auth/password",
        Some(r#"{"current_password":"password1234","new_password":"another password 1"}"#),
    ),
    (
        "POST",
        "/api/auth/2fa/setup",
        "/api/auth/2fa/setup",
        Some("{}"),
    ),
    (
        "POST",
        "/api/auth/2fa/enable",
        "/api/auth/2fa/enable",
        Some(r#"{"code":"000000"}"#),
    ),
    (
        "POST",
        "/api/auth/2fa/disable",
        "/api/auth/2fa/disable",
        Some(r#"{"password":"password1234","code":"000000"}"#),
    ),
    ("GET", "/api/auth/sessions", "/api/auth/sessions", None),
    (
        "POST",
        "/api/auth/sessions/revoke-others",
        "/api/auth/sessions/revoke-others",
        Some("{}"),
    ),
    (
        "DELETE",
        "/api/auth/sessions/{id}",
        "/api/auth/sessions/abcdef0123456789",
        None,
    ),
];

/// Admin routes no token can ever use, not even an administrator's `manage` token: whoever holds a
/// password-reset link can set the user's password. (method, template, concrete path, body)
const ADMIN_SESSION_ONLY: &[(&str, &str, &str, Option<&str>)] = &[(
    "POST",
    "/api/admin/users/{id}/reset-link",
    "/api/admin/users/usrNope/reset-link",
    Some("{}"),
)];

async fn call(
    app: &TestApp,
    c: &Client,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> common::Response {
    app.request(c, method, path, body).await
}

fn assert_manage_message(res: &common::Response, what: &str) {
    let msg = res.body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        msg.contains("'manage' permission"),
        "{what}: the refusal must name the 'manage' permission, got {msg:?}"
    );
}

/// Sessions and `manage` tokens succeed exactly as far as the role goes.
async fn run_role_matrix(kind: &str, cases: &[&Case]) {
    for case in cases {
        let roles: Vec<Option<Role>> = match case.min {
            Min::Anyone => vec![None],
            Min::Role(_) => ROLES.iter().copied().map(Some).collect(),
        };
        for role in roles {
            let fx = Fx::new().await;
            let user = fx.user_with(role);
            let actor = if kind == "session" {
                user.clone()
            } else {
                fx.app
                    .api_token(&user, json!({"name": "m", "write": true, "manage": true}))
                    .await
            };
            let expected = match (case.min, role) {
                (Min::Role(min), Some(r)) if r < min => 403,
                _ => case.ok,
            };
            let res = call(
                &fx.app,
                &actor,
                case.method,
                &(case.path)(&fx.ids),
                (case.body)(&fx.ids),
            )
            .await;
            assert_eq!(
                res.status.as_u16(),
                expected,
                "{kind} as {role:?}: {} {} -> {}",
                case.method,
                (case.path)(&fx.ids),
                res.body
            );
        }
    }
}

fn split(cases: &'static [Case], part: usize, of: usize) -> Vec<&'static Case> {
    cases.iter().skip(part).step_by(of).collect()
}

macro_rules! matrix_tests {
    ($($name:ident: $kind:literal, $part:literal;)*) => {$(
        #[tokio::test]
        async fn $name() {
            run_role_matrix($kind, &split(CASES, $part, 4)).await;
        }
    )*};
}

matrix_tests! {
    session_follows_roles_0: "session", 0;
    session_follows_roles_1: "session", 1;
    session_follows_roles_2: "session", 2;
    session_follows_roles_3: "session", 3;
    manage_token_follows_roles_0: "token", 0;
    manage_token_follows_roles_1: "token", 1;
    manage_token_follows_roles_2: "token", 2;
    manage_token_follows_roles_3: "token", 3;
}

#[tokio::test]
async fn tokens_without_the_manage_permission_are_refused_everywhere() {
    for case in CASES {
        let fx = Fx::new().await;
        // The strongest caller possible, so that only the token's scope can be the reason.
        let owner = fx.owner.clone();
        let write_only = fx
            .app
            .api_token(&owner, json!({"name": "w", "write": true}))
            .await;
        let read_only = fx
            .app
            .api_token(&owner, json!({"name": "r", "write": false}))
            .await;
        // Shapes the API refuses to create but old or hand-edited rows could have.
        let manage_without_write = fx.app.raw_token(
            &owner,
            json!({"write": false, "manage": true, "base_ids": null}),
        );
        let legacy_row = fx
            .app
            .raw_token(&owner, json!({"write": true, "base_ids": null}));
        for (label, token) in [
            ("write token", &write_only),
            ("read-only token", &read_only),
            ("manage without write", &manage_without_write),
            ("token row without manage", &legacy_row),
        ] {
            let res = call(
                &fx.app,
                token,
                case.method,
                &(case.path)(&fx.ids),
                (case.body)(&fx.ids),
            )
            .await;
            assert_eq!(
                res.status.as_u16(),
                403,
                "{label}: {} {} ({}) -> {}",
                case.method,
                (case.path)(&fx.ids),
                case.name,
                res.body
            );
            if label == "write token" || label == "token row without manage" {
                assert_manage_message(&res, label);
            }
        }
        // Nothing changed: a session can still do the same thing the refused tokens tried.
        let control = match case.min {
            Min::Anyone => fx.user_with(None),
            Min::Role(_) => fx.owner.clone(),
        };
        let res = call(
            &fx.app,
            &control,
            case.method,
            &(case.path)(&fx.ids),
            (case.body)(&fx.ids),
        )
        .await;
        assert_eq!(res.status.as_u16(), case.ok, "{}: {}", case.name, res.body);
    }
}

#[tokio::test]
async fn base_limited_manage_tokens_only_manage_their_bases() {
    for case in CASES {
        let fx = Fx::new().await;
        // Owner of the fixture's workspace, so only the token's scope can be the reason for a refusal.
        let user = fx.user_with(Some(Role::Owner));
        let token = fx
            .app
            .api_token(
                &user,
                json!({"name": "lim", "write": true, "manage": true, "base_ids": [fx.ids.base]}),
            )
            .await;
        let res = call(
            &fx.app,
            &token,
            case.method,
            &(case.path)(&fx.ids),
            (case.body)(&fx.ids),
        )
        .await;
        match case.scoped {
            Scoped::Allowed => assert!(
                res.status.as_u16() == case.ok,
                "{}: expected {} got {} {}",
                case.name,
                case.ok,
                res.status,
                res.body
            ),
            Scoped::OutOfScope => {
                res.assert_status(404);
            }
            Scoped::Refused => {
                res.assert_status(403);
                let msg = res.body["error"]["message"].as_str().unwrap_or_default();
                assert!(
                    msg.contains("limited to specific bases"),
                    "{}: {msg:?}",
                    case.name
                );
            }
        }
    }
}

#[tokio::test]
async fn base_limited_manage_tokens_cannot_reach_other_bases() {
    let fx = Fx::new().await;
    let (_, other_base) = fx.app.workspace_with_base(&fx.owner, "Other");
    let token = fx
        .app
        .api_token(
            &fx.owner,
            json!({"name": "lim", "write": true, "manage": true, "base_ids": [fx.ids.base]}),
        )
        .await;
    for (method, path, body) in [
        ("GET", format!("/api/bases/{other_base}/members"), None),
        ("DELETE", format!("/api/bases/{other_base}"), None),
        (
            "POST",
            format!("/api/bases/{other_base}/invites"),
            Some(json!({"role": "viewer"})),
        ),
        (
            "POST",
            "/api/trash/restore".to_string(),
            Some(json!({"kind": "base", "id": other_base})),
        ),
    ] {
        let res = call(&fx.app, &token, method, &path, body).await;
        res.assert_status(404);
    }
    assert_eq!(
        fx.app.query_i64(
            "SELECT count(*) FROM bases WHERE id = ?1 AND deleted_at IS NULL",
            &[&other_base]
        ),
        1,
        "the other base is untouched"
    );
}

#[tokio::test]
async fn session_only_routes_refuse_every_token() {
    for (method, _template, path, body) in SESSION_ONLY.iter().chain(ADMIN_SESSION_ONLY) {
        // A fresh instance per route: a successful session call (password change, revoking
        // sessions) legitimately deletes the tokens used before it.
        let fx = Fx::new().await;
        let manage = fx
            .app
            .api_token(
                &fx.owner,
                json!({"name": "m", "write": true, "manage": true}),
            )
            .await;
        let limited = fx
            .app
            .api_token(
                &fx.owner,
                json!({"name": "m2", "write": true, "manage": true, "base_ids": [fx.ids.base]}),
            )
            .await;
        let write_only = fx
            .app
            .api_token(&fx.owner, json!({"name": "w", "write": true}))
            .await;
        let read_only = fx
            .app
            .api_token(&fx.owner, json!({"name": "r", "write": false}))
            .await;
        let tokens_before = fx.app.query_i64("SELECT count(*) FROM api_tokens", &[]);
        let body: Option<Value> = body.map(|b| serde_json::from_str(b).unwrap());
        for (label, token) in [
            ("manage", &manage),
            ("base-limited manage", &limited),
            ("write", &write_only),
            ("read-only", &read_only),
        ] {
            let res = call(&fx.app, token, method, path, body.clone()).await;
            assert_eq!(
                res.status.as_u16(),
                403,
                "{label} token on {method} {path}: {}",
                res.body
            );
        }
        // With the manage token the refusal is the capability, not a role or validation error.
        let res = call(&fx.app, &manage, method, path, body.clone()).await;
        let msg = res.body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            msg.contains("API tokens can never use this endpoint"),
            "{method} {path}: {msg:?}"
        );
        // Nothing was changed by any of it.
        assert_eq!(
            fx.app.query_i64("SELECT count(*) FROM api_tokens", &[]),
            tokens_before,
            "{method} {path}: no token minted or deleted through a token"
        );
        // A session is not refused for that reason.
        let res = call(&fx.app, &fx.owner, method, path, body.clone()).await;
        let msg = res.body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !msg.contains("API tokens can never use this endpoint"),
            "session on {method} {path}: {msg:?}"
        );
    }
}

/// A base-limited manage token can restore a base that was inside its scope when it was deleted.
#[tokio::test]
async fn base_limited_manage_token_restores_its_own_base() {
    let fx = Fx::new().await;
    let created = fx
        .app
        .post(
            &fx.owner,
            &format!("/api/workspaces/{}/bases", fx.ids.ws),
            json!({"name": "Scoped"}),
        )
        .await;
    created.assert_status(201);
    let base = created.body["id"].as_str().unwrap().to_string();
    let token = fx
        .app
        .api_token(
            &fx.owner,
            json!({"name": "lim", "write": true, "manage": true, "base_ids": [base]}),
        )
        .await;
    call(
        &fx.app,
        &token,
        "DELETE",
        &format!("/api/bases/{base}"),
        None,
    )
    .await
    .assert_status(200);
    call(
        &fx.app,
        &token,
        "POST",
        "/api/trash/restore",
        Some(json!({"kind": "base", "id": base})),
    )
    .await
    .assert_status(200);
    call(&fx.app, &token, "GET", &format!("/api/bases/{base}"), None)
        .await
        .assert_status(200);
}

/// Admin routes: (method, template, path builder, body, expected status).
struct AdminCase {
    method: &'static str,
    template: &'static str,
    path: fn(&AdminIds) -> String,
    body: fn(&AdminIds, usize) -> Option<Value>,
    ok: u16,
}

struct AdminIds {
    user: String,
    backup: String,
}

const ADMIN: &[AdminCase] = &[
    AdminCase {
        method: "GET",
        template: "/api/admin/users",
        path: |_| "/api/admin/users".into(),
        body: |_, _| None,
        ok: 200,
    },
    AdminCase {
        method: "POST",
        template: "/api/admin/users",
        path: |_| "/api/admin/users".into(),
        // No password: a token cannot set one (see admin_credential_actions_are_session_only).
        body: |_, attempt| {
            Some(
                json!({"email": format!("new{attempt}@example.com"), "name": "New", "is_admin": false}),
            )
        },
        ok: 201,
    },
    AdminCase {
        method: "PATCH",
        template: "/api/admin/users/{id}",
        path: |i| format!("/api/admin/users/{}", i.user),
        body: |_, _| Some(json!({"name": "Renamed"})),
        ok: 200,
    },
    AdminCase {
        method: "GET",
        template: "/api/admin/email",
        path: |_| "/api/admin/email".into(),
        body: |_, _| None,
        ok: 200,
    },
    AdminCase {
        method: "PATCH",
        template: "/api/admin/email",
        path: |_| "/api/admin/email".into(),
        body: |_, _| Some(json!({"from": "Grid <grid@example.com>"})),
        ok: 200,
    },
    AdminCase {
        method: "POST",
        template: "/api/admin/email/test",
        path: |_| "/api/admin/email/test".into(),
        body: |_, _| Some(json!({})),
        ok: 200,
    },
    AdminCase {
        method: "GET",
        template: "/api/admin/audit",
        path: |_| "/api/admin/audit".into(),
        body: |_, _| None,
        ok: 200,
    },
    AdminCase {
        method: "GET",
        template: "/api/admin/stats",
        path: |_| "/api/admin/stats".into(),
        body: |_, _| None,
        ok: 200,
    },
    AdminCase {
        method: "GET",
        template: "/api/admin/backups",
        path: |_| "/api/admin/backups".into(),
        body: |_, _| None,
        ok: 200,
    },
    AdminCase {
        method: "POST",
        template: "/api/admin/backups",
        path: |_| "/api/admin/backups".into(),
        body: |_, _| Some(json!({})),
        ok: 200,
    },
    AdminCase {
        method: "GET",
        template: "/api/admin/backups/{name}",
        path: |i| format!("/api/admin/backups/{}", i.backup),
        body: |_, _| None,
        ok: 200,
    },
];

#[tokio::test]
async fn admin_routes_work_for_admin_manage_tokens_and_are_audited() {
    for case in ADMIN {
        let app = TestApp::new();
        let admin = app.admin("admin@example.com", "Admin");
        let plain = app.user("plain@example.com", "Plain");
        let backup = app.post(&admin, "/api/admin/backups", json!({})).await;
        backup.assert_status(200);
        let ids = AdminIds {
            user: plain.user_id.clone().unwrap(),
            backup: backup.body["name"].as_str().unwrap().to_string(),
        };
        let path = (case.path)(&ids);
        let attempt = std::cell::Cell::new(0usize);
        let go = |c: Client| {
            let (app, path) = (&app, path.clone());
            attempt.set(attempt.get() + 1);
            let body = (case.body)(&ids, attempt.get());
            async move { call(app, &c, case.method, &path, body).await }
        };

        // Admin session.
        let res = go(admin.clone()).await;
        assert_eq!(
            res.status.as_u16(),
            case.ok,
            "session {} {path}: {}",
            case.method,
            res.body
        );

        // Admin's manage token: allowed, and every such request leaves an audit entry naming the token.
        let manage = app
            .api_token(&admin, json!({"name": "m", "write": true, "manage": true}))
            .await;
        let before = app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'admin_token_use'",
            &[],
        );
        let res = go(manage.clone()).await;
        assert_eq!(
            res.status.as_u16(),
            case.ok,
            "manage token {} {path}: {}",
            case.method,
            res.body
        );
        let after = app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action = 'admin_token_use'",
            &[],
        );
        assert_eq!(
            after,
            before + 1,
            "{} {path} must be audited",
            case.template
        );
        let target_is_token = app.query_i64(
            "SELECT count(*) FROM audit_log a JOIN api_tokens t ON t.id = a.target
             WHERE a.action = 'admin_token_use' AND a.user_id = t.user_id",
            &[],
        );
        assert_eq!(target_is_token, 1, "the audit entry names the token");

        // Everyone else is refused.
        let write_only = app
            .api_token(&admin, json!({"name": "w", "write": true}))
            .await;
        let read_only = app
            .api_token(&admin, json!({"name": "r", "write": false}))
            .await;
        let plain_manage = app
            .api_token(&plain, json!({"name": "pm", "write": true, "manage": true}))
            .await;
        let (_, base) = app.workspace_with_base(&admin, "Acme");
        let scoped = app
            .api_token(
                &admin,
                json!({"name": "s", "write": true, "manage": true, "base_ids": [base]}),
            )
            .await;
        for (label, c) in [
            ("write token", write_only),
            ("read-only token", read_only),
            ("non-admin manage token", plain_manage),
            ("base-limited manage token", scoped),
            ("non-admin session", plain.clone()),
        ] {
            let res = go(c).await;
            assert_eq!(
                res.status.as_u16(),
                403,
                "{label}: {} {path}: {}",
                case.method,
                res.body
            );
        }
    }
}

/// Credential actions stay session-only for an administrator's `manage` token: the reset link,
/// a password for a new user, the reset link of a new user, switching off 2FA and the SMTP
/// password. A refused request changes nothing, even when it also asks for something allowed.
#[tokio::test]
async fn admin_credential_actions_are_session_only() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let victim = app.user("victim@example.com", "Victim");
    let victim_id = victim.user_id.clone().unwrap();
    app.state
        .db
        .write_sync(|tx| {
            Ok(tx.execute(
                "UPDATE users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?1",
                [&victim_id],
            )?)
        })
        .unwrap();
    let reset_tokens = || app.query_i64("SELECT count(*) FROM password_resets", &[]);
    let users = || app.query_i64("SELECT count(*) FROM users", &[]);
    let manage = app
        .api_token(&admin, json!({"name": "m", "write": true, "manage": true}))
        .await;
    let (_, base) = app.workspace_with_base(&admin, "Acme");
    let limited = app
        .api_token(
            &admin,
            json!({"name": "l", "write": true, "manage": true, "base_ids": [base]}),
        )
        .await;

    // 1. a reset link for an existing user: refused for every token, with the session-only message
    let before = reset_tokens();
    for (label, token) in [("manage", &manage), ("base-limited manage", &limited)] {
        let res = call(
            &app,
            token,
            "POST",
            &format!("/api/admin/users/{victim_id}/reset-link"),
            Some(json!({})),
        )
        .await;
        assert_eq!(res.status.as_u16(), 403, "{label}: {}", res.body);
        let msg = res.body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            msg.contains("API tokens can never use this endpoint"),
            "{label}: {msg}"
        );
    }
    assert_eq!(reset_tokens(), before, "no reset token was minted");
    // the signed-in administrator can
    let res = call(
        &app,
        &admin,
        "POST",
        &format!("/api/admin/users/{victim_id}/reset-link"),
        Some(json!({})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.body);
    assert_eq!(reset_tokens(), before + 1);

    // 2. switching off someone's 2FA: refused, also when combined with an allowed change
    for body in [
        json!({"disable_2fa": true}),
        json!({"name": "Renamed by token", "disable_2fa": true}),
    ] {
        let res = call(
            &app,
            &manage,
            "PATCH",
            &format!("/api/admin/users/{victim_id}"),
            Some(body.clone()),
        )
        .await;
        assert_eq!(res.status.as_u16(), 403, "{body}: {}", res.body);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("two-factor"),
            "{}",
            res.body
        );
    }
    assert_eq!(
        app.query_i64(
            "SELECT totp_enabled FROM users WHERE id = ?1 AND name = 'Victim'",
            &[victim_id.as_str()]
        ),
        1,
        "2FA still on and the combined rename did not happen"
    );
    // other admin updates still work for the token (and `disable_2fa: false` is not a change)
    let res = call(
        &app,
        &manage,
        "PATCH",
        &format!("/api/admin/users/{victim_id}"),
        Some(json!({"name": "Renamed", "disable_2fa": false})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.body);
    // the signed-in administrator can switch it off
    let res = call(
        &app,
        &admin,
        "PATCH",
        &format!("/api/admin/users/{victim_id}"),
        Some(json!({"disable_2fa": true})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.body);
    assert_eq!(res.body["totp_enabled"], false);

    // 3. creating users: no password from a token, and no reset link back to it
    let n = users();
    let res = call(
        &app,
        &manage,
        "POST",
        "/api/admin/users",
        Some(json!({"email": "p@example.com", "name": "P", "password": "a long enough password"})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 403, "{}", res.body);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("set a user's password"),
        "{}",
        res.body
    );
    assert_eq!(users(), n, "no user was created");
    for admin_flag in [false, true] {
        let res = call(
            &app,
            &manage,
            "POST",
            "/api/admin/users",
            Some(json!({"email": format!("new{admin_flag}@example.com"), "name": "New", "is_admin": admin_flag})),
        )
        .await;
        assert_eq!(res.status.as_u16(), 201, "{}", res.body);
        assert!(
            res.body["reset_link"].is_null(),
            "no link for a token: {}",
            res.body
        );
        assert_eq!(res.body["user"]["is_admin"], admin_flag);
    }
    assert_eq!(users(), n + 2);
    // ... the account exists but nobody can sign in to it, and no reset token exists for it
    let (login, _) = app
        .login("newfalse@example.com", "a long enough password")
        .await;
    login.assert_status(401);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email LIKE 'new%'",
            &[]
        ),
        0
    );
    // the signed-in administrator still gets the link, or can set a password directly
    let res = call(
        &app,
        &admin,
        "POST",
        "/api/admin/users",
        Some(json!({"email": "viasession@example.com", "name": "S"})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 201);
    assert!(res.body["reset_link"]["url"].is_string());
    let res = call(
        &app,
        &admin,
        "POST",
        "/api/admin/users",
        Some(json!({"email": "withpw@example.com", "name": "W", "password": "a long enough password"})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 201);
    assert!(res.body["reset_link"].is_null());

    // 4. the SMTP password: see tests/admin_email.rs for the full rules
    let res = call(
        &app,
        &manage,
        "PATCH",
        "/api/admin/email",
        Some(json!({"password": "smtp-secret"})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 403, "{}", res.body);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM settings WHERE key = 'smtp.password'",
            &[]
        ),
        0
    );
    let res = call(
        &app,
        &admin,
        "PATCH",
        "/api/admin/email",
        Some(json!({"password": "smtp-secret"})),
    )
    .await;
    assert_eq!(res.status.as_u16(), 200, "{}", res.body);
}

/// The tables above and the endpoint catalogue (which `api_reference` shows to agents and
/// `api_request` enforces up front) describe the same policy.
#[test]
fn the_capability_tables_match_the_endpoint_catalogue() {
    use opengrid::mcp::catalogue::{Access, ENDPOINTS};
    use std::collections::BTreeSet;

    let key = |m: &str, p: &str| (m.to_string(), p.to_string());
    let of = |wanted: &[Access]| -> BTreeSet<(String, String)> {
        ENDPOINTS
            .iter()
            .filter(|e| wanted.contains(&e.access))
            .map(|e| key(e.method, e.path))
            .collect()
    };

    // Manage-gated routes. Trash restore is a Write endpoint whose `workspace` and `base` kinds
    // need the manage permission: the two cases below exercise exactly that.
    let manage = of(&[Access::Manage, Access::ManageUnscoped]);
    let mut cases = BTreeSet::new();
    for case in CASES {
        if case.template == "/api/trash/restore" {
            let ep = ENDPOINTS
                .iter()
                .find(|e| e.method == "POST" && e.path == case.template)
                .unwrap();
            assert_eq!(ep.access, Access::Write);
            continue;
        }
        cases.insert(key(case.method, case.template));
        let ep = ENDPOINTS
            .iter()
            .find(|e| e.method == case.method && e.path == case.template)
            .unwrap_or_else(|| panic!("{} is not in the catalogue", case.name));
        let expected = match case.scoped {
            Scoped::Allowed | Scoped::OutOfScope => Access::Manage,
            Scoped::Refused => Access::ManageUnscoped,
        };
        // Revoking an invite is one catalogue entry for workspace and base invites.
        if case.template != "/api/invites/{id}" {
            assert_eq!(ep.access, expected, "{}", case.name);
        }
    }
    assert_eq!(
        cases, manage,
        "manage-gated routes: test table vs catalogue"
    );

    let admin: BTreeSet<_> = ADMIN.iter().map(|a| key(a.method, a.template)).collect();
    assert_eq!(admin, of(&[Access::Admin]), "admin routes");

    let session_only: BTreeSet<_> = SESSION_ONLY
        .iter()
        .map(|(m, t, ..)| key(m, t))
        .chain(ADMIN_SESSION_ONLY.iter().map(|(m, t, ..)| key(m, t)))
        .collect();
    assert_eq!(
        session_only,
        of(&[Access::SessionOnly]),
        "session-only routes"
    );
}
