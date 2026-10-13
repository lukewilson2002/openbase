/**
 * The built-in MCP server (`POST /mcp`) against the real Rust server: authentication, the
 * handshake, `tools/list`, and tool calls whose effects are then read back through the REST
 * API client the web app uses. A manage token is created the way the account page does it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { adminProfile, rand, seeded, type Profile } from "./support";
import { parse, parseList } from "./typecheck";

interface Rpc {
  status: number;
  headers: Headers;
  body: any;
}

let nextId = 1;

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Promise<Rpc> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${seeded.baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A tool call that must succeed; returns its structured result. */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  const result = res.body.result;
  expect(result.isError, `${name}: ${result.content?.[0]?.text}`).toBe(false);
  return result.structuredContent;
}

describe("MCP endpoint", () => {
  let admin: Profile;
  let tokenId = "";
  let token = "";

  beforeAll(async () => {
    admin = await adminProfile();
    const created = parse("CreatedToken", await admin.run(() => api.tokens.create({ name: `mcp-${rand()}`, write: true, manage: true, base_ids: null, expires_in_days: null })));
    token = created.token;
    tokenId = created.info.id;
  });

  afterAll(async () => {
    await admin.run(() => api.tokens.revoke(tokenId));
  });

  it("refuses requests without a personal access token", async () => {
    const none = await rpc(null, "tools/list");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const wrong = await rpc("pat_not_a_real_token", "tools/list");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("invalid_token");
    // A session cookie is not an MCP credential.
    const cookie = await rpc(null, "tools/list", {}, { cookie: "og_session=whatever" });
    expect(cookie.status).toBe(401);
    expect(cookie.body.error.message).toContain("personal access tokens only");
    // No event stream and no sessions to end.
    const get = await fetch(`${seeded.baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });

  it("answers initialize with the server's identity and guidance", async () => {
    const res = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "opengrid" }, capabilities: { tools: {} } });
    expect(res.body.result.instructions).toContain("list_bases");
    // The stateless revision needs no handshake at all.
    const discover = await rpc(
      token,
      "server/discover",
      { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    );
    expect(discover.status).toBe(200);
    expect(discover.body.result.supportedVersions).toContain("2026-07-28");
  });

  it("lists the tools of a manage token, each with a schema", async () => {
    const res = await rpc(token, "tools/list");
    expect(res.status).toBe(200);
    const tools: { name: string; description: string; inputSchema: { type: string } }[] = res.body.result.tools;
    const names = tools.map((t) => t.name);
    for (const expected of ["list_bases", "create_records", "create_table", "create_field", "create_view", "query_view", "create_workspace", "upload_attachment", "admin_stats", "list_icons", "admin_get_email_settings", "admin_update_email_settings", "admin_send_test_email"]) {
      expect(names).toContain(expected);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
    // A read-only token sees less.
    const reader = parse("CreatedToken", await admin.run(() => api.tokens.create({ name: `mcp-ro-${rand()}`, write: false, manage: false, base_ids: null, expires_in_days: null })));
    const limited = await rpc(reader.token, "tools/list");
    const readNames: string[] = limited.body.result.tools.map((t: { name: string }) => t.name);
    expect(readNames).toContain("list_records");
    expect(readNames).not.toContain("create_records");
    expect(readNames).not.toContain("create_workspace");
    await admin.run(() => api.tokens.revoke(reader.info.id));
  });

  it("builds a workspace, base, table, field and record through tools that the web client then sees", async () => {
    const name = `MCP ${rand()}`;
    const ws = await call(token, "create_workspace", { name });
    const base = await call(token, "create_base", { workspace_id: ws.workspace.id, name: "Agent base" });
    const baseId = base.base.id as string;
    await call(token, "create_table", { base_id: baseId, name: "Tasks" });
    const field = await call(token, "create_field", { base_id: baseId, table: "Tasks", name: "Points", type: "number", options: { precision: 0 } });
    expect(field.field).toMatchObject({ name: "Points", type: "number" });
    const created = await call(token, "create_records", { base_id: baseId, table: "Tasks", records: [{ fields: { Name: "Write tests", Points: 3 } }] });
    expect(created.created[0].fields).toMatchObject({ Name: "Write tests", Points: 3 });

    // The same data through the REST client the web app uses.
    const workspaces = parseList("WorkspaceSummary", await admin.run(api.workspaces.list));
    const mine = workspaces.find((w) => w.id === ws.workspace.id);
    expect(mine?.name).toBe(name);
    expect(mine?.bases.map((b) => b.id)).toContain(baseId);
    const schema = parse("BaseSchema", await admin.run(() => api.bases.get(baseId)));
    const tasks = schema.tables.find((t) => t.name === "Tasks");
    expect(tasks?.fields.map((f) => f.name)).toContain("Points");

    // A view is queried the way the app shows it.
    const q = await call(token, "query_view", { base_id: baseId, table: "Tasks", view: "Grid view" });
    expect(q.total).toBe(1);
    expect(q.records[0].fields.Name).toBe("Write tests");
  });

  it("sets, reads and clears icons that the web client then sees, and searches the icon names", async () => {
    const ws = await call(token, "create_workspace", { name: `Icons ${rand()}`, icon: "briefcase" });
    const base = await call(token, "create_base", { workspace_id: ws.workspace.id, name: "Shop", icon: "store" });
    const baseId = base.base.id as string;
    await call(token, "create_table", { base_id: baseId, name: "Orders", icon: "shopping-cart" });

    const seen = async () => {
      const workspaces = parseList("WorkspaceSummary", await admin.run(api.workspaces.list));
      const mine = workspaces.find((w) => w.id === ws.workspace.id)!;
      const schema = parse("BaseSchema", await admin.run(() => api.bases.get(baseId)));
      return { workspace: mine.icon ?? null, base: schema.icon ?? null, table: schema.tables.find((t) => t.name === "Orders")?.icon ?? null };
    };
    expect(await seen()).toEqual({ workspace: "briefcase", base: "store", table: "shopping-cart" });

    // the agent reads them back with its own tools
    const listed = await call(token, "list_bases", {});
    expect(listed.workspaces.find((w: { id: string }) => w.id === ws.workspace.id).icon).toBe("briefcase");
    const schema = await call(token, "get_base_schema", { base_id: baseId });
    expect(schema.icon).toBe("store");
    expect(schema.tables.find((t: { name: string }) => t.name === "Orders").icon).toBe("shopping-cart");

    // change one, keep another (absent), clear the third (null)
    await call(token, "rename_workspace", { workspace_id: ws.workspace.id, icon: "users" });
    await call(token, "rename_base", { base_id: baseId, name: "Shop 2" });
    await call(token, "rename_table", { base_id: baseId, table: "Orders", icon: null });
    expect(await seen()).toEqual({ workspace: "users", base: "store", table: null });

    // names are checked, with suggestions; searching finds the right ones
    const bad = await rpc(token, "tools/call", { name: "rename_base", arguments: { base_id: baseId, icon: "shoping-cart" } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toContain("Did you mean");
    expect(bad.body.result.content[0].text).toContain("shopping-cart");
    const found = await call(token, "list_icons", { query: "shopping cart", limit: 3 });
    expect(found.icons[0]).toBe("shopping-cart");
    expect(await seen()).toEqual({ workspace: "users", base: "store", table: null });
  });

  it("reads the email settings and refuses to change the password through a token", async () => {
    const before = await call(token, "admin_get_email_settings", {});
    expect(before.email).toMatchObject({ enabled: false, port: 587, password_set: false });
    const bad = await rpc(token, "tools/call", { name: "admin_update_email_settings", arguments: { password: "x" } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toContain("Invalid arguments");
    const test = await rpc(token, "tools/call", { name: "admin_send_test_email", arguments: {} });
    expect(test.body.result.isError).toBe(true);
    expect(test.body.result.content[0].text).toContain("no SMTP host");
  });

  it("returns problems as readable tool errors, and unknown tools as protocol errors", async () => {
    const bad = await rpc(token, "tools/call", { name: "get_base_schema", arguments: { base_id: "appDoesNotExist" } });
    expect(bad.status).toBe(200);
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toContain("not found");
    const unknown = await rpc(token, "tools/call", { name: "no_such_tool", arguments: {} });
    expect(unknown.body.error.code).toBe(-32602);
    // Credentials stay out of reach, even through the generic request tool.
    const creds = await rpc(token, "tools/call", { name: "api_request", arguments: { method: "POST", path: "/api/tokens", body: { name: "x", write: true } } });
    expect(creds.body.result.isError).toBe(true);
    expect(creds.body.result.content[0].text).toContain("not available through MCP");
  });
});
