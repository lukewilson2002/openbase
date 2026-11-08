import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * The record's Page (REC-5) against a live server: typed into with nothing but the keyboard (Markdown shortcuts, the
 * `/` block menu, the selection bubble, Ctrl+K for a link), saved 800 ms after typing pauses, and the phone's formatting
 * bar. Runs only with OPENBASE_E2E=1 (see playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=record-page --no-deps
 *
 * It signs up its own user. Results are asserted against the server (the Page property's Markdown), not against pixels.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-page@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };
const SAVE_WAIT = 5_000;

interface Fixture {
  baseId: string;
  tasksId: string;
  pageField: string;
  linkField: string;
  /** One record per test that writes, so they never read each other's text. */
  records: string[];
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get" | "put", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type TableDto = { id: string; body_field_id: string | null; fields: { id: string; name: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Page", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E page ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Page E2E" });
  const tasks = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Tasks" }));
  const people = await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "People" });
  const link = await call<{ id: string }>(req, "post", `/api/tables/${tasks.id}/fields`, { name: "Owner", type: "link", options: { linked_table_id: people.id, single: false } });
  // A new collection has its Page already (decision 2).
  const schema = await call<{ tables: TableDto[] }>(req, "get", `/api/bases/${base.id}`);
  const pageField = schema.tables.find((t) => t.id === tasks.id)!.body_field_id;
  expect(pageField, "a new collection has a Page property").toBeTruthy();
  const made = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${tasks.id}/records`, {
    typecast: true,
    records: Array.from({ length: 8 }, (_, i) => ({ values: { [tasks.fields[0]!.id]: `Page task ${i + 1}` } })),
  });
  return { baseId: base.id, tasksId: tasks.id, pageField: pageField!, linkField: link.id, records: made.records.map((r) => r.id) };
}

/** The Page property's Markdown as the server has it. */
async function pageText(page: Page, recordId: string): Promise<string> {
  const rec = await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${fx.tasksId}/records/${recordId}`);
  return (rec.values[fx.pageField] as string | undefined) ?? "";
}

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
const editor = (page: Page) => page.getByRole("textbox", { name: "Page" });

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1360, height: 820 } });

  test("is always editable below a rule, with no toolbar at rest, and saves 800 ms after typing pauses", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    const box = editor(page);
    await expect(box).toBeVisible();
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await expect(box.locator("p.is-editor-empty")).toHaveAttribute("data-placeholder", "Type / to add a heading, a list, a view or a property");
    // Text is 15/24 on a desktop.
    expect(await box.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(["15px", "24px"]);
    expect(await page.getByRole("region", { name: "Page" }).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
    await box.click();
    await page.keyboard.type("First thought");
    // Nothing is written while typing goes on.
    await page.waitForTimeout(300);
    expect(await pageText(page, fx.records[0]!)).toBe("");
    await expect.poll(() => pageText(page, fx.records[0]!), { timeout: SAVE_WAIT }).toBe("First thought");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(/Saved/);
    // It is the same text after a reload, and opening a page writes nothing by itself.
    await page.reload();
    await expect(editor(page)).toHaveText("First thought");
    const before = await call<{ updated_at: number }>(page.request, "get", `/api/tables/${fx.tasksId}/records/${fx.records[0]!}`);
    await page.waitForTimeout(1_200);
    const after = await call<{ updated_at: number }>(page.request, "get", `/api/tables/${fx.tasksId}/records/${fx.records[0]!}`);
    expect(after.updated_at).toBe(before.updated_at);
  });

  test("Enter in the title moves to the page", async ({ page }) => {
    await page.goto(recordUrl(fx.records[1]!));
    await page.getByRole("textbox", { name: "Name" }).click();
    await page.keyboard.press("Enter");
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("Typed after the title");
    await expect.poll(() => pageText(page, fx.records[1]!), { timeout: SAVE_WAIT }).toBe("Typed after the title");
  });

  test("Markdown shortcuts make headings, lists, quotes and marks as they are typed", async ({ page }) => {
    await page.goto(recordUrl(fx.records[2]!));
    await editor(page).click();
    await page.keyboard.type("# Plan");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> said **loudly**");
    await expect.poll(() => pageText(page, fx.records[2]!), { timeout: SAVE_WAIT }).toBe("# Plan\n\n- one\n- two\n\n> said **loudly**");
    await expect(editor(page).locator("h1")).toHaveText("Plan");
  });

  test("/ opens the block menu: narrow with typing, pick with Enter, Escape closes it", async ({ page }) => {
    await page.goto(recordUrl(fx.records[3]!));
    await editor(page).click();
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", { name: "Blocks" });
    await expect(menu.getByRole("option")).toHaveCount(15);
    await expect(menu.getByRole("option").first()).toContainText("Heading 1");
    await page.keyboard.type("head");
    await expect(menu.getByRole("option")).toHaveCount(3);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await page.keyboard.type("Subheading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Escape closed the menu only: the page is still open.
    await expect(editor(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/r/${fx.records[3]!}$`));
    await expect.poll(() => pageText(page, fx.records[3]!), { timeout: SAVE_WAIT }).toBe("## Subheading\n\n/");
  });

  test("Linked records writes the openbase block for the link property", async ({ page }) => {
    await page.goto(recordUrl(fx.records[4]!));
    await editor(page).click();
    await page.keyboard.type("/linked");
    await page.keyboard.press("Enter");
    await expect.poll(() => pageText(page, fx.records[4]!), { timeout: SAVE_WAIT }).toBe(`\`\`\`openbase\n{"embed":"linked","field":"${fx.linkField}"}\n\`\`\``);
  });

  test("selecting text shows the bubble, and Ctrl+K adds a link while the palette stays closed", async ({ page }) => {
    await page.goto(recordUrl(fx.records[5]!));
    await editor(page).click();
    await page.keyboard.type("read the docs here");
    // Select "docs" while the save of what was just typed is still on its way: it must not disturb the selection.
    await editor(page).getByText("read the docs here").dblclick({ position: { x: 62, y: 8 } });
    const bubble = page.getByRole("toolbar", { name: "Format selection" });
    await expect(bubble).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("docs");
    await expect(bubble).toBeVisible();
    await expect(bubble.getByRole("button")).toHaveCount(5);
    await page.keyboard.press("Control+k");
    const address = page.getByLabel("Link address");
    await expect(address).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Search everything" })).toHaveCount(0);
    await page.keyboard.type("example.com/docs");
    await page.keyboard.press("Enter");
    await expect(address).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await expect.poll(() => pageText(page, fx.records[5]!), { timeout: SAVE_WAIT }).toBe("read the [docs](https://example.com/docs) here");
    // Ctrl+K outside the page still opens the palette.
    await page.getByRole("textbox", { name: "Name" }).click();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search everything" })).toBeVisible();
  });

  test("the Property block opens the Add property box", async ({ page }) => {
    await page.goto(recordUrl(fx.records[6]!));
    await editor(page).click();
    await page.keyboard.type("/prop");
    await page.keyboard.press("Enter");
    const box = page.getByRole("group", { name: "Add property" });
    await expect(box).toBeVisible();
    await expect(box.getByRole("textbox", { name: "Name" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a formatting bar stands above the keyboard while the page has focus, with 44 px buttons and the block menu docked on it", async ({ page }) => {
    await page.goto(recordUrl(fx.records[7]!));
    const box = editor(page);
    await expect(box).toBeVisible();
    // 16/25 on a phone.
    expect(await box.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(["16px", "25px"]);
    await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
    await box.tap();
    const bar = page.getByRole("toolbar", { name: "Formatting" });
    await expect(bar).toBeVisible();
    for (const button of await bar.getByRole("button").all()) {
      const size = (await button.boundingBox())!;
      expect(size.width, (await button.getAttribute("aria-label")) ?? "").toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.type("Phone words");
    await page.keyboard.press("Shift+Home");
    await bar.getByRole("button", { name: "Bold" }).tap();
    await expect(box).toBeFocused();
    await bar.getByRole("button", { name: "Add block" }).tap();
    const menu = page.getByRole("listbox", { name: "Blocks" });
    await expect(menu).toBeVisible();
    // The menu sits on the bar, which sits at the bottom of the visible screen.
    const menuBox = (await menu.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(barBox.y + 1);
    await menu.getByRole("option", { name: /Bulleted list/ }).tap();
    await expect.poll(() => pageText(page, fx.records[7]!), { timeout: SAVE_WAIT }).toBe("- **Phone words**");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await bar.getByRole("button", { name: "Hide keyboard" }).tap();
    await expect(box).not.toBeFocused();
    await expect(bar).toHaveCount(0);
  });
});
