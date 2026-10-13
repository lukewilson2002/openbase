/**
 * The web API client against the real Rust server: setup, auth, 2FA, sessions, tokens, invites,
 * admin, audit and backups, in the order a new instance is used. Every response is checked
 * against the generated TypeScript bindings (see typecheck.ts), so a Rust DTO that drifts from
 * what the client expects fails here instead of in a browser.
 *
 * The steps share one server and build on each other; they are sequential on purpose.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ApiError, http, setApiBase } from "../src/api/client";
import { api } from "../src/api/endpoints";
import { as, createCookieJar, type CookieJar } from "./cookieJar";
import { totp } from "./totp";
import { parse, parseList } from "./typecheck";

const env = inject("contract");

const rand = () => randomBytes(6).toString("hex");
const adminEmail = `admin-${rand()}@example.test`;
const adminName = "Contract Admin";
let adminPassword = `pw-${rand()}-${rand()}`;
const secondEmail = `second-${rand()}@example.test`;
const secondPassword = `pw-${rand()}-${rand()}`;

/** Three browser profiles: the administrator, a regular user, and nobody. */
// Each gets its own client address (the server runs with OPENBASE_TRUST_PROXY, loopback only), so
// the per-IP rate limits of one profile never affect another.
const admin = createCookieJar("10.1.0.1");
const second = createCookieJar("10.1.0.2");
const anon = createCookieJar("10.1.0.3");
// Extra admin sessions created before 2FA is on, used for the session-revocation steps.
const adminB = createCookieJar("10.1.0.4");
const adminC = createCookieJar("10.1.0.5");

const asAdmin = <T>(fn: () => Promise<T>) => as(admin, fn);
const asSecond = <T>(fn: () => Promise<T>) => as(second, fn);
const asAnon = <T>(fn: () => Promise<T>) => as(anon, fn);

/** Await a call that must fail with an ApiError and return it. */
async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the request to fail, but it succeeded");
}

function expectError(e: ApiError, status: number, code: string): void {
  expect({ status: e.status, code: e.code }).toEqual({ status, code });
  expect(e.message.length).toBeGreaterThan(0);
  // A real envelope message, not the HTTP status text of a plain-text rejection.
  expect(e.message).not.toMatch(/^(Bad Request|Unprocessable Entity|Forbidden|Unauthorized)$/);
}

const sessionCookie = (jar: CookieJar) => jar.cookies.get("ob_session");

let adminId = "";
let secondId = "";
let workspaceId = "";
let baseId = "";
let totpSecret = "";

beforeAll(() => {
  setApiBase(env.baseUrl);
});

describe("setup and first administrator", () => {
  it("reports that setup is needed", async () => {
    const status = parse("SetupStatus", await asAnon(api.setup.status));
    // The contract server's public URL is an IP address, which WebAuthn cannot use.
    expect(status).toEqual({ needs_setup: true, open_signup: false, email_enabled: false, public_url: env.baseUrl, passkeys_enabled: false });
  });

  it("answers 401 with the error envelope before anyone is signed in", async () => {
    const e = await failure(asAnon(api.auth.me));
    expectError(e, 401, "unauthorized");
  });

  it("signs up the first user as administrator and signs them in", async () => {
    const user = parse("User", await asAdmin(() => api.auth.signup({ email: adminEmail, name: adminName, password: adminPassword, invite_token: null })));
    expect(user).toMatchObject({ email: adminEmail, name: adminName, is_admin: true, totp_enabled: false });
    expect(admin.lastStatus).toBe(200);
    expect(sessionCookie(admin)).toBeTruthy();
    adminId = user.id;
    expect(parse("SetupStatus", await asAnon(api.setup.status)).needs_setup).toBe(false);
  });

  it("returns the user from /me", async () => {
    const me = parse("User", await asAdmin(api.auth.me));
    expect(me.id).toBe(adminId);
    expect(me.email).toBe(adminEmail);
  });

  it("rejects a second signup without an invitation", async () => {
    const e = await failure(asAnon(() => api.auth.signup({ email: `x-${rand()}@example.test`, name: "X", password: `pw-${rand()}-${rand()}`, invite_token: null })));
    expectError(e, 403, "forbidden");
  });
});

describe("login, logout and the profile", () => {
  it("logs out with {ok: true} and clears the session", async () => {
    const res = parse("OkResponse", await asAdmin(api.auth.logout));
    expect(res).toEqual({ ok: true });
    expect(sessionCookie(admin)).toBeUndefined();
    expectError(await failure(asAdmin(api.auth.me)), 401, "unauthorized");
  });

  it("answers a wrong password with a 401 error envelope", async () => {
    const e = await failure(asAdmin(() => api.auth.login({ email: adminEmail, password: "definitely wrong" })));
    expectError(e, 401, "invalid_credentials");
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    const e = await failure(asAnon(() => api.auth.login({ email: `nobody-${rand()}@example.test`, password: "definitely wrong" })));
    expectError(e, 401, "invalid_credentials");
  });

  it("logs in and returns LoginResponse with the user", async () => {
    const res = parse("LoginResponse", await asAdmin(() => api.auth.login({ email: adminEmail, password: adminPassword })));
    expect(res.two_factor_required).toBe(false);
    expect(res.user?.id).toBe(adminId);
    expect(sessionCookie(admin)).toBeTruthy();
  });

  it("updates and clears the time zone", async () => {
    const set = parse("User", await asAdmin(() => api.auth.updateMe({ name: "Contract Admin", timezone: "Europe/Berlin" })));
    expect(set.timezone).toBe("Europe/Berlin");
    const cleared = parse("User", await asAdmin(() => api.auth.updateMe({ timezone: "" })));
    expect(cleared.timezone ?? null).toBeNull();
    const e = await failure(asAdmin(() => api.auth.updateMe({ timezone: "Mars/Olympus" })));
    expectError(e, 400, "bad_request");
  });

  it("changes the password and keeps the current session", async () => {
    const e = await failure(asAdmin(() => api.auth.changePassword({ current_password: "not it", new_password: `pw-${rand()}-${rand()}` })));
    expectError(e, 403, "forbidden");
    const weak = await failure(asAdmin(() => api.auth.changePassword({ current_password: adminPassword, new_password: "short" })));
    expectError(weak, 400, "bad_request");

    const next = `pw-${rand()}-${rand()}`;
    const res = parse("OkResponse", await asAdmin(() => api.auth.changePassword({ current_password: adminPassword, new_password: next })));
    expect(res).toEqual({ ok: true });
    expectError(await failure(asAnon(() => api.auth.login({ email: adminEmail, password: adminPassword }))), 401, "invalid_credentials");
    adminPassword = next;
    parse("User", await asAdmin(api.auth.me)); // still signed in
  });

  it("answers a password-reset request with {ok: true} whether or not the account exists", async () => {
    // Email is not configured on the test server, so nothing is sent; the answer must not leak.
    expect(parse("OkResponse", await asAnon(() => api.auth.requestPasswordReset(adminEmail)))).toEqual({ ok: true });
    expect(parse("OkResponse", await asAnon(() => api.auth.requestPasswordReset(`nobody-${rand()}@example.test`)))).toEqual({ ok: true });
    const e = await failure(asAnon(() => api.auth.confirmPasswordReset({ token: "rst_not_a_real_token", new_password: `pw-${rand()}-${rand()}` })));
    expectError(e, 400, "bad_request");
  });
});

describe("two-factor authentication and sessions", () => {
  // TOTP codes are single use (the server remembers the last accepted 30 s step) and it accepts
  // the previous, current and next step. So after the enable step used the current window, the
  // sign-in uses the NEXT window's code, which is valid and newer.
  const nextWindow = (secret: string) => totp(secret, Date.now() / 1000 + 30);
  let usedCode = "";

  it("opens two more sessions (B and C) for the revocation steps below", async () => {
    for (const jar of [adminB, adminC]) {
      const res = parse("LoginResponse", await as(jar, () => api.auth.login({ email: adminEmail, password: adminPassword })));
      expect(res.user?.id).toBe(adminId);
    }
  });

  it("lists sessions as a bare array and marks the current one", async () => {
    const sessions = parseList("SessionInfo", await asAdmin(api.auth.sessions));
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
    // The server saw each jar's own address (via X-Forwarded-For).
    expect(sessions.find((s) => s.current)?.ip).toBe(admin.ip);
  });

  it("revokes one session by id (204)", async () => {
    const sessions = parseList("SessionInfo", await asAdmin(api.auth.sessions));
    expect(sessions).toHaveLength(3);
    const others = sessions.filter((s) => !s.current);
    // Sessions B and C were created before this one; either may be revoked first.
    const target = others[0]!;
    const res = await asAdmin(() => api.auth.revokeSession(target.id));
    expect(res).toBeUndefined();
    expect(admin.lastStatus).toBe(204);
    expectError(await failure(asAdmin(() => api.auth.revokeSession(target.id))), 404, "not_found");
    expectError(await failure(asAdmin(() => api.auth.revokeSession("not-a-session-id"))), 404, "not_found");
    expect(parseList("SessionInfo", await asAdmin(api.auth.sessions))).toHaveLength(2);
  });

  it("revokes all other sessions ({ok: true}) and keeps the current one", async () => {
    const res = parse("OkResponse", await asAdmin(api.auth.revokeOtherSessions));
    expect(res).toEqual({ ok: true });
    const after = parseList("SessionInfo", await asAdmin(api.auth.sessions));
    expect(after).toHaveLength(1);
    expect(after[0]?.current).toBe(true);
    for (const jar of [adminB, adminC]) expectError(await failure(as(jar, api.auth.me)), 401, "unauthorized");
  });

  it("opens another session (B) that turning on two-factor must sign out", async () => {
    const res = parse("LoginResponse", await as(adminB, () => api.auth.login({ email: adminEmail, password: adminPassword })));
    expect(res.user?.id).toBe(adminId);
    expect(parse("User", await as(adminB, api.auth.me)).id).toBe(adminId);
    expect(parseList("SessionInfo", await asAdmin(api.auth.sessions))).toHaveLength(2);
  });

  it("sets up two-factor and returns the secret and otpauth URL", async () => {
    const setup = parse("TwoFactorSetup", await asAdmin(api.auth.twoFactorSetup));
    expect(setup.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(setup.otpauth_url.startsWith("otpauth://totp/")).toBe(true);
    expect(setup.otpauth_url).toContain(`secret=${setup.secret}`);
    totpSecret = setup.secret;
  });

  it("rejects a wrong code, then enables with a correct one and returns the user", async () => {
    const good = totp(totpSecret);
    const wrong = good === "000000" ? "000001" : "000000";
    expectError(await failure(asAdmin(() => api.auth.twoFactorEnable(wrong))), 400, "bad_request");
    const user = parse("User", await asAdmin(() => api.auth.twoFactorEnable(good)));
    expect(user.totp_enabled).toBe(true);
    expect(user.id).toBe(adminId);
    expectError(await failure(asAdmin(api.auth.twoFactorSetup)), 409, "conflict");
    // Enabling signs out the user's other sessions and keeps the one that did it.
    expectError(await failure(as(adminB, api.auth.me)), 401, "unauthorized");
    const after = parseList("SessionInfo", await asAdmin(api.auth.sessions));
    expect(after).toHaveLength(1);
    expect(after[0]?.current).toBe(true);
  });

  it("asks for the second step at login and completes it", async () => {
    parse("OkResponse", await asAdmin(api.auth.logout));
    const pending = parse("LoginResponse", await asAdmin(() => api.auth.login({ email: adminEmail, password: adminPassword })));
    expect(pending.two_factor_required).toBe(true);
    expect(pending.user ?? null).toBeNull();
    expect(sessionCookie(admin)).toBeTruthy();
    // A pending session is not a signed-in session.
    expectError(await failure(asAdmin(api.auth.me)), 401, "unauthorized");

    expectError(await failure(asAdmin(() => api.auth.login2fa("12345"))), 401, "invalid_code");
    usedCode = nextWindow(totpSecret);
    const done = parse("LoginResponse", await asAdmin(() => api.auth.login2fa(usedCode)));
    expect(done.two_factor_required).toBe(false);
    expect(done.user).toMatchObject({ id: adminId, totp_enabled: true });
    expect(parse("User", await asAdmin(api.auth.me)).id).toBe(adminId);
  });

  it("refuses to accept the same code twice", async () => {
    const replay = createCookieJar("10.1.0.99");
    parse("LoginResponse", await as(replay, () => api.auth.login({ email: adminEmail, password: adminPassword })));
    expectError(await failure(as(replay, () => api.auth.login2fa(usedCode))), 401, "invalid_code");
    // Without a pending session the second step reports that the sign-in expired.
    expectError(await failure(asAnon(() => api.auth.login2fa(usedCode))), 401, "two_factor_expired");
  });
});

describe("personal access tokens", () => {
  let tokenId = "";
  let secret = "";

  it("creates a token (201) and shows its secret once", async () => {
    const created = parse("CreatedToken", await asAdmin(() => api.tokens.create({ name: "CI", write: false, manage: false, base_ids: null, expires_in_days: 30 })));
    expect(admin.lastStatus).toBe(201);
    expect(created.token).toMatch(/^pat/);
    expect(created.info).toMatchObject({ name: "CI", write: false, manage: false });
    expect(created.info.expires_at).toBeGreaterThan(Date.now());
    tokenId = created.info.id;
    secret = created.token;
  });

  it("rejects an invalid token request with the error envelope", async () => {
    const e = await failure(asAdmin(() => api.tokens.create({ name: "   ", write: true, manage: false, base_ids: null, expires_in_days: null })));
    expectError(e, 400, "bad_request");
  });

  it("lists tokens as a bare array without the secret", async () => {
    const list = parseList("TokenInfo", await asAdmin(api.tokens.list));
    expect(list.map((t) => t.id)).toContain(tokenId);
    expect(JSON.stringify(list)).not.toContain(secret);
  });

  it("identifies the caller with whoami: session and bearer token", async () => {
    const viaSession = parse("WhoAmI", await asAdmin(() => api.tokens.whoami()));
    expect(viaSession).toMatchObject({ user_id: adminId, email: adminEmail, via_token: false, write: true, manage: true });
    // The anonymous jar has no cookie, so this proves the bearer token alone authenticates.
    const viaToken = parse("WhoAmI", await asAnon(() => api.tokens.whoami(secret)));
    expect(viaToken).toMatchObject({ user_id: adminId, via_token: true, write: false, manage: false });
    expect(viaToken.base_ids ?? null).toBeNull();
  });

  it("keeps tokens away from session-only endpoints", async () => {
    const bearer = { headers: { Authorization: `Bearer ${secret}` } };
    expectError(await failure(asAnon(() => http.get("/api/tokens", bearer))), 403, "forbidden");
    expectError(await failure(asAnon(() => http.get("/api/auth/sessions", bearer))), 403, "forbidden");
    expectError(await failure(asAnon(() => http.get("/api/auth/passkeys", bearer))), 403, "forbidden");
    // Admin pages need the manage permission, which this read-only token lacks.
    expectError(await failure(asAnon(() => http.get("/api/admin/users", bearer))), 403, "forbidden");
  });

  it("lets a manage token do account-level work, but still not credentials or tokens", async () => {
    const created = parse("CreatedToken", await asAdmin(() => api.tokens.create({ name: "Agent", write: true, manage: true, base_ids: null, expires_in_days: null })));
    expect(created.info).toMatchObject({ write: true, manage: true });
    const bearer = { headers: { Authorization: `Bearer ${created.token}` } };
    // Admin pages and workspace management work; both are real endpoints, not mocks.
    await asAnon(() => http.get("/api/admin/stats", bearer));
    expect(anon.lastStatus).toBe(200);
    await asAnon(() => http.get("/api/workspaces", bearer));
    expect(anon.lastStatus).toBe(200);
    expectError(await failure(asAnon(() => http.get("/api/tokens", bearer))), 403, "forbidden");
    expectError(await failure(asAnon(() => http.post("/api/tokens", { name: "child", write: true }, bearer))), 403, "forbidden");
    await asAdmin(() => api.tokens.revoke(created.info.id));
  });

  it("deletes a token (204) and then rejects it", async () => {
    const res = await asAdmin(() => api.tokens.revoke(tokenId));
    expect(res).toBeUndefined();
    expect(admin.lastStatus).toBe(204);
    expectError(await failure(asAnon(() => api.tokens.whoami(secret))), 401, "unauthorized");
    expect(parseList("TokenInfo", await asAdmin(api.tokens.list)).map((t) => t.id)).not.toContain(tokenId);
    expectError(await failure(asAdmin(() => api.tokens.revoke(tokenId))), 404, "not_found");
  });
});

describe("invitations", () => {
  let workspaceInviteId = "";
  let workspaceInviteToken = "";
  let baseInviteToken = "";

  it("creates a workspace and a base through the workspace API", async () => {
    const ws = parse("WorkspaceSummary", await asAdmin(() => api.workspaces.create("Contract workspace")));
    expect(admin.lastStatus).toBe(201);
    expect(ws).toMatchObject({ name: "Contract workspace", role: "owner", bases: [] });
    workspaceId = ws.id;
    const created = parse("BaseSchema", await asAdmin(() => api.bases.create(workspaceId, { name: "Contract base" })));
    expect(admin.lastStatus).toBe(201);
    expect(created).toMatchObject({ workspace_id: workspaceId, name: "Contract base", role: "owner" });
    baseId = created.id;
    expect(workspaceId).toMatch(/^wsp/);
    expect(baseId).toMatch(/^app/);
  });

  it("creates a workspace invite (201) with a shareable URL", async () => {
    const created = parse("CreatedInvite", await asAdmin(() => api.invites.createForWorkspace(workspaceId, { role: "editor", email: null })));
    expect(admin.lastStatus).toBe(201);
    expect(created.url).toMatch(new RegExp(`^${env.baseUrl}/invite/[A-Za-z0-9_]+$`));
    expect(created.info).toMatchObject({ workspace_id: workspaceId, role: "editor" });
    expect(created.info.accepted_at ?? null).toBeNull();
    workspaceInviteId = created.info.id;
    workspaceInviteToken = created.url.split("/invite/")[1]!;
  });

  it("rejects roles above the inviter's and unknown roles", async () => {
    expectError(await failure(asAdmin(() => api.invites.createForWorkspace(workspaceId, { role: "overlord", email: null }))), 400, "bad_request");
    expectError(await failure(asAdmin(() => api.invites.createForWorkspace("wspDoesNotExist00", { role: "editor", email: null }))), 404, "not_found");
  });

  it("lists invites as a bare array", async () => {
    const list = parseList("InviteInfo", await asAdmin(() => api.invites.forWorkspace(workspaceId)));
    expect(list.map((i) => i.id)).toEqual([workspaceInviteId]);
  });

  it("previews an invite without signing in", async () => {
    const preview = parse("InvitePreview", await asAnon(() => api.invites.preview(workspaceInviteToken)));
    expect(preview).toMatchObject({ target_name: "Contract workspace", target_kind: "workspace", role: "editor", invited_by: adminName });
    expectError(await failure(asAnon(() => api.invites.preview("inv_not_a_real_token"))), 404, "not_found");
  });

  it("signs a new user up with the invite token", async () => {
    const user = parse("User", await asSecond(() => api.auth.signup({ email: secondEmail, name: "Second User", password: secondPassword, invite_token: workspaceInviteToken })));
    expect(user).toMatchObject({ email: secondEmail, is_admin: false });
    secondId = user.id;
    const list = parseList("InviteInfo", await asAdmin(() => api.invites.forWorkspace(workspaceId)));
    expect(list[0]?.accepted_at).toBeGreaterThan(0);
    // The token is used up.
    expectError(await failure(asAnon(() => api.invites.preview(workspaceInviteToken))), 404, "not_found");
  });

  it("lets only managers create invites", async () => {
    const e = await failure(asSecond(() => api.invites.createForWorkspace(workspaceId, { role: "viewer", email: null })));
    expectError(e, 403, "forbidden");
  });

  it("accepts a base invite as a signed-in user and returns the invite", async () => {
    const created = parse("CreatedInvite", await asAdmin(() => api.invites.createForBase(baseId, { role: "commenter", email: secondEmail })));
    expect(created.info).toMatchObject({ base_id: baseId, role: "commenter" });
    baseInviteToken = created.url.split("/invite/")[1]!;
    const accepted = parse("InviteInfo", await asSecond(() => api.invites.accept(baseInviteToken)));
    expect(accepted.base_id).toBe(baseId);
    expect(accepted.accepted_at).toBeGreaterThan(0);
  });

  it("revokes an invite (204)", async () => {
    const created = parse("CreatedInvite", await asAdmin(() => api.invites.createForBase(baseId, { role: "viewer", email: null })));
    const res = await asAdmin(() => api.invites.remove(created.info.id));
    expect(res).toBeUndefined();
    expect(admin.lastStatus).toBe(204);
    const list = parseList("InviteInfo", await asAdmin(() => api.invites.forBase(baseId)));
    expect(list.map((i) => i.id)).not.toContain(created.info.id);
    expectError(await failure(asAdmin(() => api.invites.remove(created.info.id))), 404, "not_found");
  });
});

describe("administration", () => {
  let created: ReturnType<typeof parse<"AdminCreatedUser">>;
  let invitedPassword = "";

  it("lists users as a bare array", async () => {
    const users = parseList("AdminUser", await asAdmin(api.admin.users));
    expect(users.map((u) => u.email).sort()).toEqual([adminEmail, secondEmail].sort());
    expect(users.find((u) => u.id === adminId)).toMatchObject({ is_admin: true, is_active: true, totp_enabled: true });
  });

  it("closes the admin API to regular users", async () => {
    expectError(await failure(asSecond(api.admin.users)), 403, "forbidden");
    expectError(await failure(asSecond(() => api.admin.audit({ limit: 5 }))), 403, "forbidden");
  });

  it("creates a user with a password (201): no reset link", async () => {
    const res = parse("AdminCreatedUser", await asAdmin(() => api.admin.createUser({ email: `made-${rand()}@example.test`, name: "Made", password: `pw-${rand()}-${rand()}`, is_admin: false })));
    expect(admin.lastStatus).toBe(201);
    expect(res.user.is_admin).toBe(false);
    expect(res.reset_link ?? null).toBeNull();
  });

  it("creates a user without a password (201): returns a reset link that works", async () => {
    created = parse("AdminCreatedUser", await asAdmin(() => api.admin.createUser({ email: `invited-${rand()}@example.test`, name: "Invited", password: null, is_admin: true })));
    expect(admin.lastStatus).toBe(201);
    expect(created.user.is_admin).toBe(true);
    expect(created.reset_link?.url).toMatch(new RegExp(`^${env.baseUrl}/reset-password\\?token=`));

    const token = new URL(created.reset_link!.url).searchParams.get("token")!;
    invitedPassword = `pw-${rand()}-${rand()}`;
    expect(parse("OkResponse", await asAnon(() => api.auth.confirmPasswordReset({ token, new_password: invitedPassword })))).toEqual({ ok: true });
    const login = parse("LoginResponse", await asAnon(() => api.auth.login({ email: created.user.email, password: invitedPassword })));
    expect(login.user?.id).toBe(created.user.id);
    // A reset link is single use.
    expectError(await failure(asAnon(() => api.auth.confirmPasswordReset({ token, new_password: `pw-${rand()}-${rand()}` }))), 400, "bad_request");
  });

  it("rejects duplicate emails", async () => {
    expectError(await failure(asAdmin(() => api.admin.createUser({ email: adminEmail, name: "Dup", password: null, is_admin: false }))), 409, "conflict");
  });

  it("issues a reset link for an existing user", async () => {
    const link = parse("ResetLink", await asAdmin(() => api.admin.resetLink(secondId)));
    expect(link.url).toContain("/reset-password?token=");
    expect(link.expires_at).toBeGreaterThan(Date.now());
  });

  it("updates a user and returns the AdminUser", async () => {
    const renamed = parse("AdminUser", await asAdmin(() => api.admin.updateUser(secondId, { name: "Second Renamed" })));
    expect(renamed).toMatchObject({ id: secondId, name: "Second Renamed", is_active: true });

    const off = parse("AdminUser", await asAdmin(() => api.admin.updateUser(secondId, { is_active: false })));
    expect(off.is_active).toBe(false);
    expectError(await failure(asSecond(api.auth.me)), 401, "unauthorized"); // sessions were revoked
    const blocked = await failure(asAnon(() => api.auth.login({ email: secondEmail, password: secondPassword })));
    expectError(blocked, 403, "forbidden");
    const on = parse("AdminUser", await asAdmin(() => api.admin.updateUser(secondId, { is_active: true })));
    expect(on.is_active).toBe(true);
    parse("LoginResponse", await asSecond(() => api.auth.login({ email: secondEmail, password: secondPassword })));
  });

  it("protects the administrator from locking themselves out", async () => {
    expectError(await failure(asAdmin(() => api.admin.updateUser(adminId, { is_active: false }))), 400, "bad_request");
    expectError(await failure(asAdmin(() => api.admin.updateUser(adminId, { is_admin: false }))), 400, "bad_request");
    expectError(await failure(asAdmin(() => api.admin.updateUser("usrDoesNotExist00", { name: "x" }))), 404, "not_found");
  });

  it("turns off another user's two-factor with disable_2fa (omitting the other fields)", async () => {
    const setup = parse("TwoFactorSetup", await asSecond(api.auth.twoFactorSetup));
    expect(parse("User", await asSecond(() => api.auth.twoFactorEnable(totp(setup.secret)))).totp_enabled).toBe(true);
    expect(parseList("AdminUser", await asAdmin(api.admin.users)).find((u) => u.id === secondId)?.totp_enabled).toBe(true);

    const updated = parse("AdminUser", await asAdmin(() => api.admin.updateUser(secondId, { disable_2fa: true })));
    expect(updated.totp_enabled).toBe(false);
    expect(parse("User", await asSecond(api.auth.me)).totp_enabled).toBe(false);
    // Sign-in no longer asks for a code.
    const login = parse("LoginResponse", await asAnon(() => api.auth.login({ email: secondEmail, password: secondPassword })));
    expect(login.two_factor_required).toBe(false);
  });

  it("turns 2FA off through the user's own password and a code", async () => {
    const setup = parse("TwoFactorSetup", await asSecond(api.auth.twoFactorSetup));
    parse("User", await asSecond(() => api.auth.twoFactorEnable(totp(setup.secret))));
    const code = totp(setup.secret, Date.now() / 1000 + 30); // next window: unused and newer
    expectError(await failure(asSecond(() => api.auth.twoFactorDisable({ password: "wrong password", code }))), 403, "forbidden");
    const off = parse("User", await asSecond(() => api.auth.twoFactorDisable({ password: secondPassword, code })));
    expect(off.totp_enabled).toBe(false);
  });

  it("has no passkeys, cannot register one at an IP address, and removes a user's passkeys for administrators only", async () => {
    expect(parseList("PasskeyInfo", await asSecond(api.auth.passkeys))).toEqual([]);
    // The server's public URL is an IP address here: there is no relying party to register with.
    const e = await failure(asSecond(() => api.auth.passkeyRegisterStart()));
    expectError(e, 400, "bad_request");
    expect(e.message).toContain("domain name");
    expectError(await failure(asAnon(api.auth.passkeyLoginStart)), 400, "bad_request");
    expect(parse("PasskeysRemoved", await asAdmin(() => api.admin.removePasskeys(secondId)))).toEqual({ removed: 0 });
    expectError(await failure(asSecond(() => api.admin.removePasskeys(adminId))), 403, "forbidden");
    expectError(await failure(asAdmin(() => api.admin.removePasskeys("usrNope"))), 404, "not_found");
    const users = parseList("AdminUser", await asAdmin(api.admin.users));
    expect(users.every((u) => u.passkey_count === 0)).toBe(true);
  });

  it("reports instance statistics", async () => {
    const stats = parse("InstanceStats", await asAdmin(api.admin.stats));
    expect(stats.users).toBe(4);
    expect(stats.workspaces).toBe(1);
    expect(stats.bases).toBe(1);
    expect(stats.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("audit log", () => {
  it("pages newest-first with a cursor", async () => {
    const seen: number[] = [];
    const actions = new Set<string>();
    let before: number | null = null;
    let pages = 0;
    do {
      const page = parse("AuditPage", await asAdmin(() => api.admin.audit({ before, limit: 7 })));
      pages++;
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(7);
      for (const e of page.entries) {
        seen.push(e.id);
        actions.add(e.action);
      }
      if (page.next_before != null) {
        expect(page.entries).toHaveLength(7);
        expect(page.next_before).toBe(page.entries[page.entries.length - 1]!.id);
      }
      before = page.next_before ?? null;
    } while (before !== null && pages < 50);

    expect(pages).toBeGreaterThan(2);
    expect(before).toBeNull(); // exhausted
    expect(new Set(seen).size).toBe(seen.length); // no entry twice
    expect(seen).toEqual([...seen].sort((a, b) => b - a)); // strictly newest first
    for (const a of ["signup", "login", "login_failed", "logout", "2fa_enable", "token_create", "token_delete", "invite_create", "invite_accept", "admin_user_create", "admin_user_update", "password_change"]) {
      expect(actions, `audit action ${a}`).toContain(a);
    }
  });

  it("returns the default page without parameters and an empty page past the end", async () => {
    const first = parse("AuditPage", await asAdmin(() => api.admin.audit()));
    expect(first.entries.length).toBeGreaterThan(0);
    const past = parse("AuditPage", await asAdmin(() => api.admin.audit({ before: 1 })));
    expect(past.entries).toEqual([]);
    expect(past.next_before ?? null).toBeNull();
  });
});

describe("backups", () => {
  let name = "";

  it("lists backups as a bare array", async () => {
    parseList("BackupInfo", await asAdmin(api.admin.backups));
  });

  it("creates a backup and returns its BackupInfo", async () => {
    const info = parse("BackupInfo", await asAdmin(api.admin.createBackup));
    expect(info.name).toMatch(/\.tar\.gz$/);
    expect(info.size).toBeGreaterThan(0);
    name = info.name;
    const list = parseList("BackupInfo", await asAdmin(api.admin.backups));
    expect(list.map((b) => b.name)).toContain(name);
    expect(parse("InstanceStats", await asAdmin(api.admin.stats)).last_backup_at).not.toBeNull();
  });

  it("downloads a backup through the URL the UI links to, for administrators only", async () => {
    const res = await admin.fetch(`${env.baseUrl}${api.admin.backupUrl(name)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(name);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // gzip
    const denied = await second.fetch(`${env.baseUrl}${api.admin.backupUrl(name)}`);
    expect(denied.status).toBe(403);
  });
});

describe("sign out", () => {
  it("ends the administrator session", async () => {
    expect(parse("OkResponse", await asAdmin(api.auth.logout))).toEqual({ ok: true });
    expectError(await failure(asAdmin(api.admin.users)), 401, "unauthorized");
  });
});
