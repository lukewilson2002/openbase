import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * Comments and History on the record page, and new records (REC-7, REC-8, COL-8), against a live server: the 360 px
 * panel a desktop remembers, the full-screen sheets of a phone, and a record added from a collection that is taken
 * back when it is left empty (Escape, back, a route change, closing the tab). Runs only with OPENBASE_E2E=1 (see
 * playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=record-panels --no-deps
 *
 * It signs up its own user. What was kept or taken back is asserted against the server (the records API).
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-panels@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Fixture {
  baseId: string;
  tasksId: string;
  viewId: string;
  nameField: string;
  /** One record per test that writes to it. */
  records: string[];
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type TableDto = { id: string; primary_field_id: string; views: { id: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Panels", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E panels ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Panels E2E" });
  const tasks = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Tasks" }));
  const made = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${tasks.id}/records`, {
    typecast: true,
    records: ["Panel task 1", "Panel task 2", "Panel task 3"].map((n) => ({ values: { [tasks.primary_field_id]: n } })),
  });
  const records = made.records.map((r) => r.id);
  // A thread of one comment and a change to read in History on the first record.
  await call(req, "post", `/api/records/${records[0]}/comments`, { body: "First thought" });
  await call(req, "patch", `/api/tables/${tasks.id}/records`, { typecast: true, records: [{ id: records[0], values: { [tasks.primary_field_id]: "Panel task one" } }] });
  return { baseId: base.id, tasksId: tasks.id, viewId: tasks.views[0]!.id, nameField: tasks.primary_field_id, records };
}

/** How many records the collection has, as the server says. */
async function total(page: Page): Promise<number> {
  const res = await call<{ total: number }>(page.request, "post", `/api/views/${fx.viewId}/query`, {});
  return res.total;
}

async function exists(page: Page, recordId: string): Promise<boolean> {
  const res = await page.request.get(`/api/tables/${fx.tasksId}/records/${recordId}`);
  return res.ok();
}

const idOf = (page: Page) => new URL(page.url()).pathname.split("/r/")[1]!;

test.beforeAll(async ({ browser }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL: process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080", storageState: { cookies: [], origins: [] } }, "seed");
  const page = await ctx.newPage();
  fx = await seed(page);
  session = await ctx.cookies();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

const recordUrl = (recordId: string) => `/base/${fx.baseId}/${fx.tasksId}/r/${recordId}`;
const collectionUrl = () => `/base/${fx.baseId}/${fx.tasksId}/${fx.viewId}`;
const title = (page: Page) => page.getByRole("textbox", { name: "Name" });

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Comments opens a 360 px panel with the count on its button, and the panel is remembered across a reload", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    const button = page.getByRole("button", { name: "Comments, 1" });
    await expect(button).toBeVisible();
    await expect(button).toHaveText("1");
    await button.click();
    const panel = page.getByRole("complementary", { name: "Comments" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("First thought")).toBeVisible();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(360);
    // The page is beside it, not covered.
    await expect(title(page)).toBeVisible();

    const box = panel.getByRole("textbox", { name: "Write a comment" });
    await box.click();
    await page.keyboard.type("Second thought");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(panel.getByText("Second thought")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comments, 2" })).toBeVisible();

    // Remembered per device: it is open again, and the keyboard is where the page left it.
    await page.reload();
    await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside"))).toBe(false);
  });

  test("History is in the same panel, remembered too, and closing it is remembered as well", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    await page.getByRole("button", { name: "History" }).click();
    const panel = page.getByRole("complementary", { name: "History" });
    await expect(panel.getByRole("list", { name: "Revision history" })).toBeVisible();
    await expect(panel.getByText("Panel task one")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("complementary", { name: "History" })).toBeVisible();
    await page.getByRole("button", { name: "Close history" }).click();
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await page.reload();
    await expect(title(page)).toBeVisible();
    await expect(page.getByRole("complementary")).toHaveCount(0);
  });

  test("a record added from the header opens as its page with the title focused, and Escape takes it back", async ({ page }) => {
    await page.goto(collectionUrl());
    const before = await total(page);
    await page.getByRole("main").locator("header").first().getByRole("button", { name: "New record" }).click();
    await expect(page).toHaveURL(/\/r\/rec/);
    await expect(title(page)).toBeFocused();
    const made = idOf(page);
    expect(await exists(page, made)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/${fx.viewId}$`));
    await expect.poll(() => exists(page, made)).toBe(false);
    expect(await total(page)).toBe(before);
  });

  test("going back takes an empty new record back, and one with a title typed in stays", async ({ page }) => {
    await page.goto(collectionUrl());
    const before = await total(page);
    const header = page.getByRole("main").locator("header").first();
    await header.getByRole("button", { name: "New record" }).click();
    await expect(title(page)).toBeFocused();
    const empty = idOf(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${fx.viewId}$`));
    await expect.poll(() => exists(page, empty)).toBe(false);

    await header.getByRole("button", { name: "New record" }).click();
    await expect(title(page)).toBeFocused();
    const kept = idOf(page);
    await page.keyboard.type("Kept for later");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${fx.tasksId}/records/${kept}`)).values[fx.nameField]).toBe("Kept for later");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${fx.viewId}$`));
    await page.waitForTimeout(500);
    expect(await exists(page, kept)).toBe(true);
    expect(await total(page)).toBe(before + 1);
  });

  test("a route change to another screen takes it back too", async ({ page }) => {
    await page.goto(collectionUrl());
    await page.getByRole("main").locator("header").first().getByRole("button", { name: "New record" }).click();
    await expect(title(page)).toBeFocused();
    const made = idOf(page);
    // The sidebar's Home link is a route change inside the app.
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await expect(page).not.toHaveURL(/\/r\//);
    await expect.poll(() => exists(page, made)).toBe(false);
  });

  test("closing the tab takes an empty new record back, and leaves one with text typed in", async ({ page, context }) => {
    await page.goto(collectionUrl());
    const header = page.getByRole("main").locator("header").first();
    await header.getByRole("button", { name: "New record" }).click();
    await expect(title(page)).toBeFocused();
    const empty = idOf(page);
    await page.close();
    const other = await context.newPage();
    await expect.poll(() => exists(other, empty), { timeout: 10_000 }).toBe(false);

    await other.goto(collectionUrl());
    await other.getByRole("main").locator("header").first().getByRole("button", { name: "New record" }).click();
    await expect(title(other)).toBeFocused();
    const typed = idOf(other);
    // Half-typed text is not given up on: the record stays, so it can be found and named.
    await other.keyboard.type("Half a na");
    await other.close();
    const third = await context.newPage();
    await third.waitForTimeout(1_000);
    expect(await exists(third, typed)).toBe(true);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Comments and History are full-screen sheets, with the box to write in kept in view, and nothing is remembered", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    await expect(title(page)).toBeVisible();
    const comments = page.getByRole("button", { name: /^Comments, / });
    await expect(comments).toHaveText(/\d/);
    const size = (await comments.boundingBox())!;
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    await comments.tap();
    const sheet = page.getByRole("dialog", { name: "Comments" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("First thought")).toBeVisible();
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBe(390);
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBeGreaterThanOrEqual(840);
    const composer = (await sheet.getByRole("textbox", { name: "Write a comment" }).boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await sheet.getByRole("button", { name: "Close" }).tap();
    await expect(sheet).toHaveCount(0);

    await page.getByRole("button", { name: "More" }).tap();
    await page.getByRole("button", { name: "History" }).tap();
    const history = page.getByRole("dialog", { name: "History" });
    await expect(history.getByRole("list", { name: "Revision history" })).toBeVisible();
    await history.getByRole("button", { name: "Close" }).tap();
    // A sheet that opened by itself would cover the page it was opened on.
    await page.reload();
    await expect(title(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the header's + opens the new record as a screen with the title focused, and the back link takes an empty one back", async ({ page }) => {
    await page.goto(collectionUrl());
    const before = await total(page);
    await page.getByRole("main").locator("header").first().getByRole("button", { name: "New record" }).tap();
    await expect(page).toHaveURL(/\/r\/rec/);
    await expect(title(page)).toBeFocused();
    const made = idOf(page);
    await page.getByRole("link", { name: /Back to/ }).tap();
    await expect(page).toHaveURL(new RegExp(`/${fx.tasksId}(/${fx.viewId})?$`));
    await expect.poll(() => exists(page, made)).toBe(false);
    expect(await total(page)).toBe(before);
  });
});
