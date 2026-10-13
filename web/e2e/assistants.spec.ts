import { randomBytes } from "node:crypto";
import type { Cookie } from "@playwright/test";
import { expect, newClientContext, test } from "./fixtures";

/**
 * The "AI assistants" tab of the account page against the real server: the MCP address comes from
 * the server's configured public URL and is a live MCP endpoint, Claude is open by default and the
 * sections behave as an accordion, the copy buttons put the right text on the real clipboard, the
 * token variants stay collapsed until asked for, the plain-http server gets the public-address
 * warning, and the page fits a phone in both themes. Signs up one user for all its tests. Runs only with
 * OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

/** One signed-in session for all tests (signup is rate limited per address), added to each test's context. */
let session: Cookie[] = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL: process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080", storageState: { cookies: [], origins: [] } }, "signup");
  const email = `e2e-assistants-${randomBytes(4).toString("hex")}@example.com`;
  const res = await ctx.request.post("/api/auth/signup", { data: { email, name: "Assistants E2E", password: PASSWORD }, headers: CSRF });
  expect(res.ok(), await res.text()).toBeTruthy();
  session = await ctx.cookies();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

test("the AI assistants tab shows the server's MCP address, collapsible instructions and working copy buttons", async ({ page, request, baseURL }) => {
  const mcp = `${baseURL}/mcp`;

  await page.goto("/account?tab=assistants");
  await expect(page.getByText("Let an AI assistant work in OpenBase for you.")).toBeVisible();
  const address = page.getByLabel("MCP address", { exact: true });
  await expect(address).toHaveValue(mcp);

  // The e2e server runs on plain http at a loopback address: the one-line warning is shown.
  await expect(page.getByText(/need OpenBase at a public https address/)).toBeVisible();

  // The address is a real MCP endpoint: without credentials it points at the sign-in metadata.
  const probe = await request.post(mcp, { data: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream" }, failOnStatusCode: false });
  expect(probe.status()).toBe(401);
  expect(probe.headers()["www-authenticate"]).toContain("resource_metadata=");

  // Claude is open, with the desktop steps before Claude Code; the others are closed.
  const claude = page.getByRole("button", { name: "Claude", exact: true });
  const chatgpt = page.getByRole("button", { name: "ChatGPT", exact: true });
  const others = page.getByRole("button", { name: "Others", exact: true });
  await expect(claude).toHaveAttribute("aria-expanded", "true");
  await expect(chatgpt).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { level: 4 })).toHaveText(["Claude Desktop & claude.ai", "Claude Code"]);

  // Copy buttons write the real clipboard and say so.
  await page.getByRole("button", { name: "Copy MCP address" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcp);
  await page.getByRole("button", { name: "Copy connector URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcp);
  await page.getByRole("button", { name: "Copy command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http openbase ${mcp}`);

  // The token variant is collapsed until asked for.
  const token = page.getByRole("button", { name: "Use a token instead" });
  await expect(token).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("YOUR_TOKEN")).toHaveCount(0);
  await token.click();
  await page.getByRole("button", { name: "Copy token command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http openbase ${mcp} --header "Authorization: Bearer YOUR_TOKEN"`);

  // One section at a time, from the keyboard too.
  await chatgpt.click();
  await expect(chatgpt).toHaveAttribute("aria-expanded", "true");
  await expect(claude).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(/Developer mode/)).toBeVisible();
  await others.focus();
  await page.keyboard.press("Enter");
  await expect(others).toHaveAttribute("aria-expanded", "true");
  await expect(chatgpt).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(/supports remote HTTP servers/)).toBeVisible();
  await page.getByRole("button", { name: "Use a token instead" }).click();
  await page.getByRole("button", { name: "Copy configuration" }).click();
  const config = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(config.mcpServers.openbase.url).toBe(mcp);

  // Connected apps are on this tab, below the sections.
  await expect(page.getByRole("heading", { name: "Connected apps" })).toBeVisible();
  await expect(page.getByText("No connected apps yet.")).toBeVisible();

  // The token link leads to the Tokens tab.
  await page.getByRole("link", { name: "API tokens" }).click();
  await expect(page).toHaveURL(/tab=tokens/);
  await expect(page.getByRole("heading", { name: "Personal access tokens" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`the tab fits a phone in the ${theme} theme, with every section reachable`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((t) => localStorage.setItem("ob-theme", t), theme);

    await page.goto("/account?tab=assistants");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByLabel("MCP address", { exact: true })).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const name of ["ChatGPT", "Others", "Claude"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-expanded", "true");
      expect(await overflow(), `${name} open at 375px`).toBeLessThanOrEqual(0);
    }
    // Long commands scroll inside their own box, not the page.
    await page.getByRole("button", { name: "Use a token instead" }).click();
    await expect(page.getByRole("button", { name: "Copy token command" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
}
