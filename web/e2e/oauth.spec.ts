import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * An MCP OAuth client in a real browser against the real server, the way Claude Code or another
 * desktop app connects:
 *   - register with dynamic client registration and a loopback redirect address served by this test;
 *   - open /oauth/authorize in the browser, get sent to the login (nobody is signed in), sign in, land
 *     on the consent page, choose "Read & edit" and approve;
 *   - the browser is sent to the loopback listener, which captures the code; exchange it with PKCE;
 *   - call /mcp: tools/list shows the tools of a write grant, a write tool changes data, a manage
 *     tool is refused with 403 insufficient_scope, the REST API refuses the token;
 *   - find the app under Account -> API tokens -> Connected apps, revoke it there, and see the
 *     access token and the refresh token rejected.
 * A second test refuses an app on the consent page. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1360, height: 860 } });

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Callback {
  url: URL;
}

/** A loopback listener like the one a desktop app opens: it records the redirect and shows a page. */
async function listen(): Promise<{ server: Server; port: number; next: () => Promise<Callback> }> {
  const waiting: ((c: Callback) => void)[] = [];
  const seen: Callback[] = [];
  const server = createServer((req, res) => {
    const callback = { url: new URL(req.url ?? "/", "http://127.0.0.1") };
    if (callback.url.pathname === "/callback") {
      const w = waiting.shift();
      if (w) w(callback);
      else seen.push(callback);
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>Connected</title><p>You can close this tab and go back to the app.</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const next = () => new Promise<Callback>((resolve) => (seen.length > 0 ? resolve(seen.shift()!) : void waiting.push(resolve)));
  return { server, port, next };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function signUp(request: APIRequestContext, email: string): Promise<{ baseId: string; baseName: string }> {
  const res = await request.post("/api/auth/signup", { data: { email, name: "OAuth E2E", password: PASSWORD }, headers: CSRF });
  expect(res.ok(), await res.text()).toBeTruthy();
  const ws = await (await request.post("/api/workspaces", { data: { name: "OAuth workspace" }, headers: CSRF })).json();
  const base = await (await request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "OAuth base" }, headers: CSRF })).json();
  return { baseId: base.id, baseName: "OAuth base" };
}

async function register(request: APIRequestContext, name: string, redirect: string): Promise<string> {
  const res = await request.post("/oauth/register", { data: { client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  expect(res.status()).toBe(201);
  return (await res.json()).client_id;
}

function authorizeUrl(clientId: string, redirect: string, challenge: string, state: string, resource: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
    scope: "openbase:read openbase:write",
  });
  return `/oauth/authorize?${q}`;
}

async function mcp(request: APIRequestContext, token: string, method: string, params: object = {}) {
  return request.post("/mcp", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    data: { jsonrpc: "2.0", id: 1, method, params },
    failOnStatusCode: false,
  });
}

test("an MCP client connects through the browser, works with its token, and is revoked from the account page", async ({ page, request, baseURL }) => {
  const email = `e2e-oauth-${randomBytes(4).toString("hex")}@example.com`;
  const { baseId } = await signUp(request, email);
  const listener = await listen();
  try {
    const redirect = `http://127.0.0.1:${listener.port}/callback`;
    const name = "E2E Agent";
    const clientId = await register(request, name, redirect);
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString("hex");
    const resource = `${baseURL}/mcp`;

    // The app opens the authorization URL in the browser. Nobody is signed in: the login comes first.
    await page.goto(authorizeUrl(clientId, redirect, challenge, state, resource));
    await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fconsent%3Frequest%3Doar/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();

    // Back on the consent page: the app's name and where the access goes are prominent.
    await expect(page).toHaveURL(/\/oauth\/consent\?request=oar/);
    await expect(page.getByRole("heading", { name: `Allow ${name} to use your OpenBase?` })).toBeVisible();
    await expect(page.getByTestId("redirect-host")).toHaveText(`127.0.0.1:${listener.port}`);
    await expect(page.getByText("This app runs on your own computer")).toHaveCount(2); // the label and the warning
    await expect(page.getByLabel(/Read only/)).not.toBeChecked();
    await expect(page.getByLabel(/Read & edit/)).toBeChecked(); // the app asked for write
    await expect(page.getByLabel(/Full control/)).toHaveCount(0); // it asked for no more than that

    // The consent page cannot be framed.
    const consentUrl = page.url();
    const headers = (await page.request.get(consentUrl)).headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");

    await page.getByLabel(/Read & edit/).check();
    await page.getByRole("button", { name: "Approve" }).click();

    // The browser goes to the app's loopback address with the code, the state and the issuer.
    const callback = await listener.next();
    expect(callback.url.searchParams.get("state")).toBe(state);
    expect(callback.url.searchParams.get("iss")).toBe(baseURL);
    const code = callback.url.searchParams.get("code")!;
    expect(code).toMatch(/^ocd/);
    await expect(page.getByText("You can close this tab and go back to the app.")).toBeVisible();

    // Exchange the code (PKCE). A wrong verifier would fail; the right one yields the tokens.
    const exchange = (v: string, c: string) =>
      request.post("/oauth/token", { form: { grant_type: "authorization_code", client_id: clientId, code: c, redirect_uri: redirect, code_verifier: v, resource }, failOnStatusCode: false });
    const tokens = await (await exchange(verifier, code)).json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "openbase:read openbase:write" });
    const access: string = tokens.access_token;
    const refresh: string = tokens.refresh_token;

    // tools/list: the tools of a write grant; a write tool really writes; manage is refused.
    const listed = await mcp(request, access, "tools/list");
    expect(listed.status(), await listed.text()).toBe(200);
    const list = await listed.json();
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("create_table");
    expect(names).toContain("list_records");
    expect(names).not.toContain("create_workspace");
    const created = await mcp(request, access, "tools/call", { name: "create_table", arguments: { base_id: baseId, name: "Made over OAuth" } });
    expect(created.status()).toBe(200);
    expect((await created.json()).result.isError).toBe(false);
    const schema = await (await request.get(`/api/bases/${baseId}`)).json();
    expect(schema.tables.map((t: { name: string }) => t.name)).toContain("Made over OAuth");
    const manage = await mcp(request, access, "tools/call", { name: "create_workspace", arguments: { name: "No" } });
    expect(manage.status()).toBe(403);
    expect(manage.headers()["www-authenticate"]).toContain('error="insufficient_scope"');
    // The token is for /mcp only.
    expect((await request.get("/api/auth/me", { headers: { authorization: `Bearer ${access}` }, failOnStatusCode: false })).status()).toBe(401);

    // The app shows up under Connected apps, with what it was given.
    await page.goto("/account?tab=tokens");
    const apps = page.getByRole("list", { name: "Connected apps" });
    const row = apps.getByRole("listitem").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Read & edit");
    await expect(row).toContainText(`Connects from 127.0.0.1:${listener.port}`);
    await expect(row).toContainText("all bases");
    await expect(row).toContainText(/last used/);

    // Revoke it there: the tokens stop working at once.
    await page.getByRole("button", { name: `Revoke ${name}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke access" }).click();
    await expect(page.getByText("No connected apps")).toBeVisible();
    expect((await mcp(request, access, "tools/list")).status()).toBe(401);
    const refreshed = await request.post("/oauth/token", { form: { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh }, failOnStatusCode: false });
    expect(refreshed.status()).toBe(400);
    expect((await refreshed.json()).error).toBe("invalid_grant");
  } finally {
    listener.server.close();
  }
});

test("refusing an app sends it an access_denied error and shares nothing", async ({ page, request, baseURL }) => {
  const email = `e2e-oauth-deny-${randomBytes(4).toString("hex")}@example.com`;
  await signUp(request, email);
  const listener = await listen();
  try {
    const redirect = `http://127.0.0.1:${listener.port}/callback`;
    const clientId = await register(request, "Claude", redirect);
    const { challenge } = pkce();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/login/);

    await page.goto(authorizeUrl(clientId, redirect, challenge, "deny-state", `${baseURL}/mcp`));
    // An app called "Claude" that is not on claude.ai gets the loudest warning.
    await expect(page.getByRole("alert").filter({ hasText: "calls itself Claude" })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    const callback = await listener.next();
    expect(callback.url.searchParams.get("error")).toBe("access_denied");
    expect(callback.url.searchParams.get("state")).toBe("deny-state");
    expect(callback.url.searchParams.has("code")).toBe(false);
    // Let the listener's page finish loading before leaving it.
    await expect(page.getByText("You can close this tab and go back to the app.")).toBeVisible();
    await page.goto("/account?tab=tokens");
    await expect(page.getByText("No connected apps")).toBeVisible();
  } finally {
    listener.server.close();
  }
});
