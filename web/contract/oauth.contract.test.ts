/**
 * OAuth against the real Rust server, driven by the official MCP TypeScript SDK: its
 * `StreamableHTTPClientTransport` with an `OAuthClientProvider` discovers the authorization server
 * from the 401 of `/mcp`, registers itself (RFC 7591), builds the PKCE authorization URL and
 * exchanges the code. The "browser" part (login, consent) is played by a signed-in profile calling
 * the same API the consent page uses. Everything the server answers is checked against the
 * generated bindings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { api } from "../src/api/endpoints";
import { adminProfile, expectError, failure, newUser, rand, seeded, type Profile } from "./support";
import { parse, parseList } from "./typecheck";

const MCP = `${seeded.baseUrl}/mcp`;
const REDIRECT = "http://127.0.0.1:53199/callback";

/** What a desktop app would keep in memory: its registration, tokens and PKCE verifier. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;

  constructor(private readonly name: string) {}

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  /** Called by the SDK when the server says stored credentials are no longer valid. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.saved = undefined;
    if (scope === "all" || scope === "client") this.info = undefined;
  }
}

function connectWith(provider: OAuthClientProvider) {
  const client = new Client({ name: "sdk-contract", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  return { client, transport, connect: () => client.connect(transport) };
}

describe("OAuth with the official MCP TypeScript SDK", () => {
  let admin: Profile;
  let baseId = "";
  const provider = new MemoryProvider(`SDK contract test ${rand()}`);

  beforeAll(async () => {
    admin = await adminProfile();
    const ws = await admin.run(() => api.workspaces.create(`OAuth ${rand()}`));
    const base = await admin.run(() => api.bases.create(ws.id, { name: "OAuth base", color: null, icon: null }));
    baseId = base.id;
  });

  afterAll(async () => {
    for (const g of parseList("GrantInfo", await admin.run(api.oauth.grants))) await admin.run(() => api.oauth.revokeGrant(g.id));
  });

  /** The session cookie of the signed-in "browser" that opens the authorization URL. */
  const browserCookie = () => [...admin.jar.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  /** The browser's part: open the authorization URL, sign in (already), approve at the consent step. */
  async function approve(url: URL, access: "read" | "write" | "manage", baseIds: string[] | null = null) {
    // Nobody signed in: nothing is stored, the visitor is sent to log in and back to this request.
    const anonymous = await fetch(url, { redirect: "manual" });
    expect(anonymous.status).toBe(302);
    const login = new URL(anonymous.headers.get("location")!, seeded.baseUrl);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(`${url.pathname}${url.search}`);
    // With the session the request is validated in full and stored.
    const res = await fetch(url, { redirect: "manual", headers: { cookie: browserCookie() } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/oauth\/consent\?request=oar/);
    const id = new URL(location, seeded.baseUrl).searchParams.get("request")!;
    const request = parse("ConsentRequest", await admin.run(() => api.oauth.request(id)));
    const outcome = parse("ConsentOutcome", await admin.run(() => api.oauth.decide(id, { decision: "approve", access, base_ids: baseIds })));
    const back = new URL(outcome.redirect_to);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    return { request, code: back.searchParams.get("code")!, iss: back.searchParams.get("iss"), state: back.searchParams.get("state") };
  }

  it("discovers, registers, authorizes with PKCE and connects", async () => {
    const first = connectWith(provider);
    await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);

    // The SDK found the authorization server through the 401 and the protected resource metadata,
    // registered itself and built a standard authorization request.
    expect(provider.info?.client_id).toMatch(/^ocl/);
    const url = provider.authorizationUrl!;
    expect(url.origin + url.pathname).toBe(`${seeded.baseUrl}/oauth/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(provider.info!.client_id);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("resource")).toBe(MCP);

    const { request, code, iss } = await approve(url, "write", [baseId]);
    // The 401 challenge names "openbase:read openbase:write", which is what a compliant client
    // asks for: the page offers up to "Read & edit", preselects "Read only" and does not offer
    // "Full control" to an app that did not ask for it.
    expect(request).toMatchObject({
      client_name: provider.clientMetadata.client_name,
      client_source: "dcr",
      loopback: true,
      trusted_host: false,
      redirect_host: "127.0.0.1:53199",
      requested_access: "write",
      max_access: "manage",
      default_access: "write",
    });
    expect(url.searchParams.get("scope")).toBe("openbase:read openbase:write");
    expect(iss).toBe(seeded.baseUrl);
    await first.transport.finishAuth(code);
    expect(provider.saved).toMatchObject({ token_type: "Bearer", scope: "openbase:read openbase:write" });
    expect(provider.saved!.access_token).toMatch(/^oat/);
    expect(provider.saved!.refresh_token).toMatch(/^ort/);
    expect(provider.saved!.expires_in).toBe(3600);

    // Connected: the handshake, the tools of a write grant limited to one base, and a write.
    const second = connectWith(provider);
    await second.connect();
    const tools = (await second.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("create_table");
    expect(tools).not.toContain("create_workspace");
    const bases = await second.client.callTool({ name: "list_bases", arguments: {} });
    expect(bases.isError).toBeFalsy();
    const table = await second.client.callTool({ name: "create_table", arguments: { base_id: baseId, name: "Made by SDK" } });
    expect(table.isError, JSON.stringify(table.content)).toBeFalsy();
    const schema = await admin.run(() => api.bases.get(baseId));
    expect(schema.tables.map((t) => t.name)).toContain("Made by SDK");
    await second.client.close();
  });

  it("lists the connection with its access, bases and last use", async () => {
    const grants = parseList("GrantInfo", await admin.run(api.oauth.grants));
    const mine = grants.find((g) => g.client_name === provider.clientMetadata.client_name)!;
    expect(mine).toMatchObject({ write: true, manage: false, client_source: "dcr", redirect_host: "127.0.0.1:53199" });
    expect(mine.bases?.map((b) => b.id)).toEqual([baseId]);
    expect(mine.last_used_at).not.toBeNull();
  });

  it("refreshes an expired access token by itself and rotates the refresh token", async () => {
    const before = provider.saved!;
    provider.saveTokens({ ...before, access_token: "oat-no-longer-valid" });
    const again = connectWith(provider);
    await again.connect();
    expect((await again.client.listTools()).tools.length).toBeGreaterThan(5);
    expect(provider.saved!.access_token).not.toBe("oat-no-longer-valid");
    expect(provider.saved!.refresh_token).toMatch(/^ort/);
    expect(provider.saved!.refresh_token).not.toBe(before.refresh_token);
    await again.client.close();

    // The old refresh token is dead. Presented again right away (an app racing itself) it is refused
    // with invalid_grant but the connection lives on; reuse after the 30 second grace window revokes
    // it (covered by crates/server/tests/oauth_flow.rs, which can move the clock).
    const res = await fetch(`${seeded.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: provider.info!.client_id, refresh_token: before.refresh_token! }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    const after = connectWith(provider);
    await after.connect();
    expect((await after.client.listTools()).tools.length).toBeGreaterThan(5);
    await after.client.close();
    expect(parseList("GrantInfo", await admin.run(api.oauth.grants)).filter((g) => g.client_name === provider.clientMetadata.client_name)).toHaveLength(1);
  });

  it("answers a tool the grant does not allow with 403 insufficient_scope and a challenge the SDK understands", async () => {
    const readOnly = new MemoryProvider(`SDK read only ${rand()}`);
    const first = connectWith(readOnly);
    await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    const { code } = await approve(readOnly.authorizationUrl!, "read");
    await first.transport.finishAuth(code);

    // Talk to the endpoint the way the SDK does, with the access token.
    const call = (name: string) =>
      fetch(MCP, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${readOnly.saved!.access_token}`, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { base_id: baseId, name: "Nope" } } }),
      });
    const refused = await call("create_table");
    expect(refused.status).toBe(403);
    const challenge = refused.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="openbase:read openbase:write"');
    expect(challenge).toContain(`resource_metadata="${seeded.baseUrl}/.well-known/oauth-protected-resource/mcp"`);
    expect((await call("list_records")).status).toBe(200);

    // Through the SDK client the call fails instead of changing anything.
    const second = connectWith(readOnly);
    await second.connect();
    const tools = (await second.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_records");
    expect(tools).not.toContain("create_table");
    await second.client.close();
    for (const g of parseList("GrantInfo", await admin.run(api.oauth.grants))) await admin.run(() => api.oauth.revokeGrant(g.id));
  });

  it("is revoked from the connected-apps list at once", async () => {
    const p = new MemoryProvider(`SDK revoked ${rand()}`);
    const first = connectWith(p);
    await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    const { code } = await approve(p.authorizationUrl!, "write");
    await first.transport.finishAuth(code);
    const live = connectWith(p);
    await live.connect();
    expect((await live.client.listTools()).tools.length).toBeGreaterThan(5);

    const grant = parseList("GrantInfo", await admin.run(api.oauth.grants)).find((g) => g.client_name === p.clientMetadata.client_name)!;
    await admin.run(() => api.oauth.revokeGrant(grant.id));
    // The next request is refused; the SDK tries to refresh, fails and sends the user to authorize again.
    p.authorizationUrl = undefined;
    await expect(live.client.listTools()).rejects.toBeDefined();
    const retry = connectWith(p);
    await retry.connect().catch(() => undefined);
    const again = connectWith(p);
    await expect(again.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(p.authorizationUrl).toBeDefined();
  });

  it("keeps OAuth tokens off the REST API", async () => {
    const p = new MemoryProvider(`SDK rest ${rand()}`);
    const first = connectWith(p);
    await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);
    const { code } = await approve(p.authorizationUrl!, "write");
    await first.transport.finishAuth(code);
    const auth = { authorization: `Bearer ${p.saved!.access_token}` };
    for (const path of ["/api/auth/me", "/api/workspaces", "/api/tokens/whoami", "/api/v1/meta/bases", "/api/oauth/grants"]) {
      const res = await fetch(`${seeded.baseUrl}${path}`, { headers: auth });
      expect(res.status, path).toBe(401);
    }
    // It works on the MCP endpoint, including the generic request tool, which runs as the grant.
    const live = connectWith(p);
    await live.connect();
    const me = await live.client.callTool({ name: "api_request", arguments: { method: "GET", path: "/api/auth/me" } });
    expect(me.isError, JSON.stringify(me.content)).toBeFalsy();
    const creds = await live.client.callTool({ name: "api_request", arguments: { method: "GET", path: "/api/tokens" } });
    expect(creds.isError).toBe(true);
    // The Airtable-compatible API takes a personal access token only: refused up front, with the reason.
    const v1 = await live.client.callTool({ name: "api_request", arguments: { method: "GET", path: "/api/v1/meta/bases" } });
    expect(v1.isError).toBe(true);
    expect(JSON.stringify(v1.content)).toContain("not available to apps connected through OAuth");
    await live.client.close();
  });

  describe("Change access", () => {
    /** Connect a fresh app and approve it at `access`; returns it with a live SDK client. */
    async function connected(label: string, access: "read" | "write" | "manage", baseIds: string[] | null = null) {
      const p = new MemoryProvider(`${label} ${rand()}`);
      const first = connectWith(p);
      await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);
      const { code } = await approve(p.authorizationUrl!, access, baseIds);
      await first.transport.finishAuth(code);
      const live = connectWith(p);
      await live.connect();
      const grant = parseList("GrantInfo", await admin.run(api.oauth.grants)).find((g) => g.client_name === p.clientMetadata.client_name)!;
      return { p, live, grant };
    }
    const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    const text = (r: unknown) => JSON.stringify((r as { content?: unknown }).content);
    /** A tool call the way the SDK sends it, to see the status the endpoint answers without the SDK retrying. */
    const rawCall = (accessToken: string, name: string, args: Record<string, unknown>) =>
      fetch(MCP, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}`, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
    const expectNeedsMoreAccess = async (accessToken: string, name: string, args: Record<string, unknown>) => {
      const res = await rawCall(accessToken, name, args);
      expect(res.status, name).toBe(403);
      expect(res.headers.get("www-authenticate"), name).toContain('error="insufficient_scope"');
    };

    it("lets an app that was connected without full control delete once it is upgraded, with the token it already holds", async () => {
      const ws = await admin.run(() => api.workspaces.create(`Upgrade ${rand()}`));
      const folder = parse("BaseSchema", await admin.run(() => api.bases.create(ws.id, { name: "Folder", color: null, icon: null })));
      const { p, live, grant } = await connected("SDK upgrade", "write");
      const token = p.saved!.access_token;

      // Read and write: it can build, but the manage tools are not offered and a delete is refused.
      expect(grant).toMatchObject({ write: true, manage: false });
      const before = await toolNames(live.client);
      expect(before).toContain("create_table");
      for (const name of ["delete_project", "delete_workspace", "create_workspace"]) expect(before, name).not.toContain(name);
      await expectNeedsMoreAccess(token, "delete_project", { project_id: folder.id });
      await expectNeedsMoreAccess(token, "create_workspace", { name: "Nope" });
      expect((await admin.run(() => api.bases.get(folder.id))).id).toBe(folder.id);

      // The person gives it full control from Account, AI assistants: no reconnect, the same access token.
      const upgraded = parse("GrantInfo", await admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "manage" })));
      expect(upgraded).toMatchObject({ id: grant.id, write: true, manage: true });
      expect(parseList("GrantInfo", await admin.run(api.oauth.grants)).find((g) => g.id === grant.id)).toMatchObject({ write: true, manage: true });
      expect(p.saved!.access_token).toBe(token);
      expect(await toolNames(live.client)).toEqual(expect.arrayContaining(["delete_project", "delete_workspace", "create_workspace"]));

      // Now it can delete the folder, and the delete can be undone from the trash.
      const deleted = await live.client.callTool({ name: "delete_project", arguments: { project_id: folder.id } });
      expect(deleted.isError, text(deleted)).toBeFalsy();
      const receipt = deleted.structuredContent as { trashed: { kind: string; id: string }; restore_with: { tool: string; arguments: Record<string, unknown> } };
      expect(receipt.trashed).toMatchObject({ kind: "project", id: folder.id });
      expect(parseList("WorkspaceSummary", await admin.run(api.workspaces.list)).find((w) => w.id === ws.id)!.bases.map((b) => b.id)).not.toContain(folder.id);
      const restored = await live.client.callTool({ name: receipt.restore_with.tool, arguments: receipt.restore_with.arguments });
      expect(restored.isError, text(restored)).toBeFalsy();
      expect((await admin.run(() => api.bases.get(folder.id))).id).toBe(folder.id);

      // The top level stays protected, whatever the access.
      const top = parseList("WorkspaceSummary", await admin.run(api.workspaces.list)).find((w) => w.id === ws.id)!.root_base_id!;
      const topRefused = await live.client.callTool({ name: "delete_project", arguments: { project_id: top } });
      expect(topRefused.isError).toBe(true);
      expect(text(topRefused)).toContain("Make another folder the top level first, or delete the workspace");

      // And down again: the next request is back to writing only.
      const downgraded = parse("GrantInfo", await admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "write" })));
      expect(downgraded).toMatchObject({ write: true, manage: false });
      expect(await toolNames(live.client)).not.toContain("delete_project");
      await expectNeedsMoreAccess(p.saved!.access_token, "delete_project", { project_id: folder.id });
      const toRead = parse("GrantInfo", await admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "read" })));
      expect(toRead).toMatchObject({ write: false, manage: false });
      expect(await toolNames(live.client)).not.toContain("create_table");
      await live.client.close();
      await admin.run(() => api.workspaces.remove(ws.id));
    });

    it("writes the change to the audit log and refuses anything but the person's own session", async () => {
      const { p, live, grant } = await connected("SDK audit", "write");
      await admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "manage" }));
      const entry = parse("AuditPage", await admin.run(() => api.admin.audit({ limit: 20 }))).entries.find((e) => e.action === "oauth_grant_update" && e.target === grant.id);
      expect(entry?.detail).toMatchObject({ client: p.clientMetadata.client_name, from: "write", to: "manage" });

      // The app cannot raise its own access: its token is refused on the REST API, and the endpoint is session-only.
      const self = await fetch(`${seeded.baseUrl}/api/oauth/grants/${grant.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${p.saved!.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ access: "manage" }),
      });
      expect(self.status).toBe(401);
      const viaTool = await live.client.callTool({ name: "api_request", arguments: { method: "PATCH", path: `/api/oauth/grants/${grant.id}`, body: { access: "read" } } });
      expect(viaTool.isError).toBe(true);
      expect(parseList("GrantInfo", await admin.run(api.oauth.grants)).find((g) => g.id === grant.id)).toMatchObject({ write: true, manage: true });

      // Without the CSRF header a cookie request is refused, so another site cannot do it for the person.
      const noCsrf = await fetch(`${seeded.baseUrl}/api/oauth/grants/${grant.id}`, {
        method: "PATCH",
        headers: { cookie: browserCookie(), "content-type": "application/json" },
        body: JSON.stringify({ access: "read" }),
      });
      expect(noCsrf.status).toBe(403);
      await live.client.close();
    });

    it("answers a level it does not know, and a grant that is not the person's, with errors", async () => {
      const { grant, live } = await connected("SDK errors", "write");
      expectError(await failure(admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "root" }))), 400, "bad_request");
      expectError(await failure(admin.run(() => api.oauth.changeGrantAccess("ogrNotAGrant", { access: "read" }))), 404, "not_found");
      const other = await newUser(admin, "grant-thief");
      expectError(await failure(other.run(() => api.oauth.changeGrantAccess(grant.id, { access: "manage" }))), 404, "not_found");
      expect(parseList("GrantInfo", await admin.run(api.oauth.grants)).find((g) => g.id === grant.id)).toMatchObject({ manage: false });
      await live.client.close();
    });

    it("does not give Full control to an app limited to some folders, but lets it be narrowed or widened up to writing", async () => {
      const { grant, live } = await connected("SDK limited", "read", [baseId]);
      const refused = await failure(admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "manage" })));
      expectError(refused, 400, "bad_request");
      expect(refused.message).toContain("limited to some projects");
      const widened = parse("GrantInfo", await admin.run(() => api.oauth.changeGrantAccess(grant.id, { access: "write" })));
      expect(widened).toMatchObject({ write: true, manage: false });
      expect(widened.bases?.map((b) => b.id)).toEqual([baseId]);
      await live.client.close();
    });

    it("gives more than the app asked for only when the person chooses it, and reports what was granted", async () => {
      const p = new MemoryProvider(`SDK beyond ${rand()}`);
      const first = connectWith(p);
      await expect(first.connect()).rejects.toBeInstanceOf(UnauthorizedError);
      expect(p.authorizationUrl!.searchParams.get("scope")).toBe("openbase:read openbase:write");
      const { request, code } = await approve(p.authorizationUrl!, "manage");
      // Every level is on offer, and the one preselected is what the app asked for.
      expect(request).toMatchObject({ requested_access: "write", default_access: "write", max_access: "manage" });
      await first.transport.finishAuth(code);
      expect(p.saved!.scope?.split(" ").sort()).toEqual(["openbase:manage", "openbase:read", "openbase:write"]);
      const entry = parse("AuditPage", await admin.run(() => api.admin.audit({ limit: 20 }))).entries.find((e) => e.action === "oauth_approve" && (e.detail as { client?: string } | null)?.client === p.clientMetadata.client_name);
      expect(entry?.detail).toMatchObject({ access: "manage", requested: "write", beyond_request: true });
      const live = connectWith(p);
      await live.connect();
      expect(await toolNames(live.client)).toContain("delete_workspace");
      await live.client.close();
    });
  });

  it("serves discovery documents readable from any origin", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
      const res = await fetch(`${seeded.baseUrl}${path}`, { headers: { origin: "https://inspector.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const meta = await (await fetch(`${seeded.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({ issuer: seeded.baseUrl, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
  });
});
