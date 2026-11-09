import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { clickGrid, expect, newClientContext, newRecordButton, openRecordId, openRecordPanel, skipIntro, test, typeToEdit, undo } from "./fixtures";

/**
 * The record page as a person uses it (REC-1 to REC-10, FLD-1, ledger 18 to 22), one flow per test against a live
 * server: a record opens from the grid and from the palette, Alt+Up and Alt+Down step through the view's records,
 * a value and the title are edited where they stand, a property is made from a value with a guessed type, the page
 * is typed into with the `/` menu and is still there after a reload, a view is embedded, the comments panel opens,
 * Escape goes back to the collection, a record that was added and left empty is taken back, and a viewer is shown
 * every value with nothing to change. The phone opens a record with one tap. Runs only with OPENBASE_E2E=1 (see
 * playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=record-flows --no-deps
 *
 * It signs up its own users. Results are asserted against the server (the records and schema APIs), not against pixels.
 * The deeper specs of each part are page.spec.ts (the page's editor), embeds.spec.ts, recordPanels.spec.ts and
 * linkedRecords.spec.ts; this one walks the screens together, the way the interaction targets table reads.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-record-flows@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const BASE_URL = process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080";
const CSRF = { "X-OpenBase-CSRF": "1" };
const SAVE_WAIT = 5_000;

// Grid geometry (see grid.spec.ts): the fixture's grid names its column widths and keeps the default Short rows.
const MARKER_W = 56;
const HEADER_H = 44;
const ROW_H = 36;
const NAME_W = 220;

const CLIENTS = ["Harper & Co", "Ibis Studio", "Juniper Labs", "Kestrel Foods", "Linden Works"];

interface Fixture {
  baseId: string;
  tableId: string;
  /** The grid the page is opened from: its order is the order Alt+Down follows. */
  gridId: string;
  listId: string;
  nameField: string;
  statusField: string;
  retainerField: string;
  pageField: string;
  /** The saved view the View block embeds. */
  activeView: string;
  /** In grid order. */
  records: string[];
  viewer: Cookie[];
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type TableDto = { id: string; primary_field_id: string; body_field_id: string | null; fields: { id: string; name: string; type: string }[]; views: { id: string; is_default: boolean; config: { field_order: string[] } }[] };

async function signUp(req: APIRequestContext, email: string, name: string): Promise<void> {
  const res = await req.post("/api/auth/signup", { data: { email, name, password: PASSWORD }, headers: CSRF });
  if (!res.ok()) {
    const login = await req.post("/api/auth/login", { data: { email, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
}

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const ctx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }, "seed");
  const req = ctx.request;
  await signUp(req, EMAIL, "E2E Flows");
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E flows ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Flows E2E" });
  const table = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Clients" }));
  await call(req, "patch", `/api/tables/${table.id}`, { name: "Clients" });
  const status = await call<{ id: string; options: { choices: { id: string; name: string }[] } }>(req, "post", `/api/tables/${table.id}/fields`, {
    name: "Status",
    type: "single_select",
    options: { choices: [{ id: "", name: "Lead", color: "blue" }, { id: "", name: "Active", color: "green" }] },
  });
  const retainer = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/fields`, { name: "Retainer", type: "number", options: { precision: 0, allow_negative: false } });
  const made = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${table.id}/records`, {
    typecast: true,
    records: CLIENTS.map((name, i) => ({ values: { [table.primary_field_id]: name, [status.id]: i % 2 === 0 ? "Active" : "Lead", [retainer.id]: (i + 1) * 100 } })),
  });
  const schema = await call<{ tables: TableDto[] }>(req, "get", `/api/bases/${base.id}`);
  const pageField = schema.tables.find((t) => t.id === table.id)!.body_field_id!;
  // A grid of its own, with known widths to click cells by position, and a List and a saved view to embed.
  const grid = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/views`, { name: "Grid", type: "grid", config: { field_widths: { [table.primary_field_id]: NAME_W } } });
  const list = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/views`, { name: "Everyone", type: "list", config: null });
  const active = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/views`, { name: "Active clients", type: "grid", config: { filter: { conjunction: "and", items: [{ field_id: status.id, op: "is", value: status.options.choices.find((c) => c.name === "Active")!.id }] } } });
  // A page for the viewer to read.
  const ids = made.records.map((r) => r.id);
  await call(req, "patch", `/api/tables/${table.id}/records`, { records: [{ id: ids[0], values: { [pageField]: "## Notes for the team\n\n- Renews in March" } }] });
  // A viewer, through an invite link.
  const invite = await call<{ url: string }>(req, "post", `/api/bases/${base.id}/invites`, { role: "viewer", email: null });
  const guest = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }, "viewer");
  await signUp(guest.request, `e2e-flows-viewer-${Date.now()}@example.com`, "Viewer Vera");
  const accept = await guest.request.post(`/api/invites/by-token/${invite.url.split("/invite/")[1]}/accept`, { data: {}, headers: CSRF });
  expect(accept.ok(), await accept.text()).toBeTruthy();
  fx = {
    baseId: base.id,
    tableId: table.id,
    gridId: grid.id,
    listId: list.id,
    nameField: table.primary_field_id,
    statusField: status.id,
    retainerField: retainer.id,
    pageField,
    activeView: active.id,
    records: ids,
    viewer: await guest.cookies(),
  };
  session = await ctx.cookies();
  await guest.close();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

const gridUrl = () => `/base/${fx.baseId}/${fx.tableId}/${fx.gridId}`;
const recordUrl = (recordId: string, viewId = fx.gridId) => `/base/${fx.baseId}/${fx.tableId}/${viewId}/r/${recordId}`;
const main = (page: Page) => page.getByRole("main", { name: "Record" });
const title = (page: Page) => main(page).getByRole("heading", { level: 1 });
const properties = (page: Page) => main(page).getByRole("region", { name: "Properties" });
/** The area of a value: it takes the click that starts an edit, and holds the value. The "Edit" button inside it is for the keyboard and is not drawn. */
const valueArea = (page: Page, property: string) => properties(page).locator("[data-edit-field]", { has: page.getByRole("button", { name: `Edit ${property}` }) });
const canvas = (page: Page) => page.locator("canvas[data-testid='data-grid-canvas']").first();

async function record(page: Page, recordId: string): Promise<{ values: Record<string, unknown> }> {
  return call(page.request, "get", `/api/tables/${fx.tableId}/records/${recordId}`);
}
const value = async (page: Page, recordId: string, fieldId: string) => (await record(page, recordId)).values[fieldId];

async function total(page: Page): Promise<number> {
  return (await call<{ total: number }>(page.request, "post", `/api/views/${fx.gridId}/query`, {})).total;
}

/** Click the name cell of the grid's `row` (0-based). */
async function clickName(page: Page, row: number): Promise<void> {
  const box = await canvas(page).boundingBox();
  expect(box, "the grid canvas is not on screen").not.toBeNull();
  await clickGrid(page, box!.x + MARKER_W + NAME_W / 2, box!.y + HEADER_H + row * ROW_H + ROW_H / 2);
}

async function openGrid(page: Page): Promise<void> {
  await page.goto(gridUrl());
  await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
  await expect(canvas(page)).toBeVisible();
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a record opens from the grid with one shortcut and from the palette with Enter, and Escape goes back to the collection", async ({ page }) => {
    await openGrid(page);
    await clickName(page, 1);
    await page.keyboard.press("Shift+Space");
    await expect(page).toHaveURL(new RegExp(`/${fx.gridId}/r/${fx.records[1]}$`));
    await expect(title(page)).toHaveText("Ibis Studio");
    // The page is a screen of its own: the breadcrumb leads back to the grid it was opened from, and so does Escape.
    await expect(main(page).getByRole("navigation", { name: "Breadcrumb" }).locator(`a[href="${gridUrl()}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`${gridUrl()}$`));
    await expect(canvas(page)).toBeVisible();

    // The palette, from the collection: type, then Enter on the first result.
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Search everything" });
    const box = dialog.getByRole("combobox", { name: "Search" });
    await expect(box).toBeFocused();
    await box.fill("Kestrel");
    await expect(dialog.getByRole("listbox", { name: "Results" }).getByRole("option", { name: /Kestrel Foods/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/r/${fx.records[3]}$`));
    await expect(title(page)).toHaveText("Kestrel Foods");
    await expect(dialog).toHaveCount(0);
  });

  test("Escape from a page lands the grid where it was scrolled to (PH-4), and Ctrl+Z still reverts an edit made before the page was opened", async ({ page }) => {
    // A collection long enough to scroll, of its own so no other test sees its records.
    const long = await call<TableDto>(page.request, "post", `/api/bases/${fx.baseId}/tables`, { name: "Long list" });
    try {
      const made = await call<{ records: { id: string }[] }>(page.request, "post", `/api/tables/${long.id}/records`, {
        typecast: true,
        records: Array.from({ length: 120 }, (_, i) => ({ values: { [long.primary_field_id]: `Row ${String(i).padStart(3, "0")}` } })),
      });
      // A grid with the fixture's geometry, to click cells by position.
      const view = await call<{ id: string }>(page.request, "post", `/api/tables/${long.id}/views`, { name: "Grid", type: "grid", config: { field_widths: { [long.primary_field_id]: NAME_W } } });
      await page.goto(`/base/${fx.baseId}/${long.id}/${view.id}`);
      const scroller = page.locator(".dvn-scroller").first();
      await expect(canvas(page)).toBeVisible();
      const box = await canvas(page).boundingBox();
      // An edit first, so there is something to undo after the round trip: the second row, by typing into its cell.
      await clickGrid(page, box!.x + MARKER_W + 100, box!.y + HEADER_H + 20);
      await typeToEdit(page, "Edited");
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${long.id}/records/${made.records[0]!.id}`)).values[long.primary_field_id]).toBe("Edited");
      await scroller.evaluate((el) => void (el.scrollTop = 1800));
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1500);
      const left = await scroller.evaluate((el) => el.scrollTop);
      await clickGrid(page, box!.x + MARKER_W + 100, box!.y + HEADER_H + 20);
      await page.keyboard.press("Shift+Space");
      await expect(page).toHaveURL(/\/r\/rec/);
      await expect(title(page)).toHaveText(/^Row \d{3}$/);
      await page.keyboard.press("Escape");
      await expect(canvas(page)).toBeVisible();
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(left - 5);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(left + 5);
      // The history survived the page: Ctrl+Z puts the first row's name back.
      await undo(page);
      await expect.poll(async () => (await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${long.id}/records/${made.records[0]!.id}`)).values[long.primary_field_id]).toBe("Row 000");
    } finally {
      await page.request.delete(`/api/tables/${long.id}`, { headers: CSRF });
    }
  });

  test("Alt+Down and Alt+Up step through the records of the view the page was opened from", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    await expect(title(page)).toHaveText("Harper & Co");
    const previous = main(page).getByRole("button", { name: /^Previous record/ });
    const next = main(page).getByRole("button", { name: /^Next record/ });
    await expect(previous).toBeDisabled();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/${fx.gridId}/r/${fx.records[1]}$`));
    await expect(title(page)).toHaveText("Ibis Studio");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(title(page)).toHaveText("Juniper Labs");
    await expect(previous).toBeEnabled();
    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page).toHaveURL(new RegExp(`/r/${fx.records[0]}$`));
    await expect(title(page)).toHaveText("Harper & Co");
    // The buttons do the same, and the last record has no next one.
    await next.click();
    await expect(title(page)).toHaveText("Ibis Studio");
    await page.goto(recordUrl(fx.records[4]!));
    await expect(title(page)).toHaveText("Linden Works");
    await expect(next).toBeDisabled();
  });

  test("a value and the title are edited where they stand and each saves on its own", async ({ page }) => {
    await page.goto(recordUrl(fx.records[2]!));
    await expect(title(page)).toHaveText("Juniper Labs");
    // A value is text until it is clicked, then its editor, and Enter keeps it.
    await expect(properties(page).locator("dt")).toHaveText(["Status", "Retainer"]);
    await valueArea(page, "Retainer").click();
    const retainer = properties(page).getByRole("textbox", { name: "Retainer" });
    await retainer.fill("4500");
    await retainer.press("Enter");
    await expect.poll(() => value(page, fx.records[2]!, fx.retainerField)).toBe(4500);
    await expect(valueArea(page, "Retainer")).toContainText("4500");
    // The title is the h1, edited in place: Enter saves it and moves on to the page.
    const name = main(page).getByRole("textbox", { name: "Name" });
    await name.fill("Juniper Labs Ltd");
    await name.press("Enter");
    await expect.poll(() => value(page, fx.records[2]!, fx.nameField)).toBe("Juniper Labs Ltd");
    await expect(main(page).getByRole("navigation", { name: "Breadcrumb" }).getByText("Juniper Labs Ltd")).toBeVisible();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(/Saved/);
    // And it is what a reload shows.
    await page.reload();
    await expect(title(page)).toHaveText("Juniper Labs Ltd");
    await expect(valueArea(page, "Retainer")).toContainText("4500");
  });

  test("Add property takes a name and a value, guesses the type from the value and sets this record's value", async ({ page }) => {
    await page.goto(recordUrl(fx.records[3]!));
    await expect(title(page)).toHaveText("Kestrel Foods");
    await main(page).getByRole("button", { name: "Add property" }).click();
    const box = main(page).getByRole("group", { name: "Add property" });
    await box.getByRole("textbox", { name: "Name" }).fill("Deposit");
    await box.getByRole("textbox", { name: "Value" }).fill("$600");
    await expect(box.getByText(/^Currency · Guessed from “\$600”/)).toBeVisible();
    await box.getByRole("textbox", { name: "Value" }).press("Enter");
    await expect(box).toBeHidden();
    const schema = async () => (await call<{ tables: TableDto[] }>(page.request, "get", `/api/bases/${fx.baseId}`)).tables.find((t) => t.id === fx.tableId)!;
    await expect.poll(async () => (await schema()).fields.find((f) => f.name === "Deposit")?.type).toBe("currency");
    const deposit = (await schema()).fields.find((f) => f.name === "Deposit")!;
    await expect.poll(() => value(page, fx.records[3]!, deposit.id)).toBe(600);
    await expect(properties(page).locator("dt").last()).toHaveText("Deposit");
    // It is the last property in the order the default grid lays out.
    const t = await schema();
    const order = [...t.views.find((v) => v.is_default)!.config.field_order, ...t.fields.map((f) => f.id)].filter((id, i, all) => all.indexOf(id) === i);
    expect(order.at(-1)).toBe(deposit.id);
  });

  test("the page takes a heading from the / menu, and what was typed is there after a reload", async ({ page }) => {
    await page.goto(recordUrl(fx.records[1]!));
    const editor = page.getByRole("textbox", { name: "Page" });
    await editor.click();
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", { name: "Blocks" });
    await expect(menu).toBeVisible();
    await page.keyboard.type("heading 2");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Kickoff");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- agenda sent");
    await expect.poll(async () => (await value(page, fx.records[1]!, fx.pageField)) ?? "", { timeout: SAVE_WAIT }).toBe("## Kickoff\n\n- agenda sent");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Page" }).getByRole("heading", { level: 2, name: "Kickoff" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Page" }).getByRole("listitem")).toHaveText("agenda sent");
  });

  test("the / menu inserts a View block that shows the saved view's records", async ({ page }) => {
    await page.goto(recordUrl(fx.records[4]!));
    await page.getByRole("textbox", { name: "Page" }).click();
    await page.keyboard.type("/view");
    await page.keyboard.press("Enter");
    const list = page.getByRole("listbox", { name: "View to show" });
    await list.getByRole("option", { name: /Active clients/ }).click();
    await expect.poll(async () => (await value(page, fx.records[4]!, fx.pageField)) ?? "", { timeout: SAVE_WAIT }).toBe(`\`\`\`openbase\n{"embed":"view","view":"${fx.activeView}","limit":10}\n\`\`\``);
    // The embed is a table of the view's records (Active: the first, third and fifth), read-only.
    const embed = page.getByRole("region", { name: /^Active clients/ });
    await expect(embed.getByRole("link", { name: "Harper & Co" })).toBeVisible();
    await expect(embed.getByRole("link", { name: "Ibis Studio" })).toHaveCount(0);
    await embed.getByRole("link", { name: "Open view" }).click();
    await expect(page).toHaveURL(new RegExp(`/${fx.tableId}/${fx.activeView}$`));
  });

  test("Comments opens the panel with the count on its button, and Escape closes it before it leaves the page", async ({ page }) => {
    await page.goto(recordUrl(fx.records[0]!));
    await expect(title(page)).toHaveText("Harper & Co");
    const comments = await openRecordPanel(page, "Comments");
    await comments.getByRole("textbox", { name: "Write a comment" }).click();
    await page.keyboard.type("Sent the renewal quote");
    await comments.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(comments.getByText("Sent the renewal quote")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comments (1)" })).toBeVisible();
    const saved = await call<{ body: string }[]>(page.request, "get", `/api/records/${fx.records[0]}/comments`);
    expect(saved.map((c) => c.body)).toEqual(["Sent the renewal quote"]);
    // Focus goes back to the page first: Escape in the box is not "leave".
    await title(page).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Comments" })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/r/${fx.records[0]}$`));
    // Focus went back to the Comments button, whose tooltip is open and takes an Escape of its own; the next one leaves.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(new RegExp(`${gridUrl()}$`), { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  });

  test("a record added from the header and left empty is taken back; one that was named stays", async ({ page }) => {
    await openGrid(page);
    const before = await total(page);
    await newRecordButton(page, "New record").click();
    await expect(page).toHaveURL(/\/r\/rec/);
    await expect(main(page).getByRole("textbox", { name: "Name" })).toBeFocused();
    const empty = openRecordId(page);
    expect((await page.request.get(`/api/tables/${fx.tableId}/records/${empty}`)).ok()).toBe(true);
    // Leaving by the breadcrumb, with nothing entered, discards it.
    await main(page).getByRole("navigation", { name: "Breadcrumb" }).locator(`a[href="${gridUrl()}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${gridUrl()}$`));
    await expect.poll(async () => (await page.request.get(`/api/tables/${fx.tableId}/records/${empty}`)).status()).toBe(404);
    expect(await total(page)).toBe(before);

    await newRecordButton(page, "New record").click();
    await expect(main(page).getByRole("textbox", { name: "Name" })).toBeFocused();
    const named = openRecordId(page);
    await page.keyboard.type("Mulberry Press");
    await page.keyboard.press("Enter");
    await expect.poll(() => value(page, named, fx.nameField)).toBe("Mulberry Press");
    await main(page).getByRole("navigation", { name: "Breadcrumb" }).locator(`a[href="${gridUrl()}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${gridUrl()}$`));
    await page.waitForTimeout(500);
    expect(await total(page)).toBe(before + 1);
    // Taken out again, so no other test finds it among the records.
    expect((await page.request.delete(`/api/tables/${fx.tableId}/records`, { data: { ids: [named] }, headers: CSRF })).ok()).toBe(true);
  });
});

test.describe("a viewer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("is shown every value rendered, with no edit affordance anywhere on the page", async ({ browser }, testInfo) => {
    const ctx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } }, "viewer-page");
    await ctx.addCookies(fx.viewer);
    const page = await ctx.newPage();
    // The same diagnostics the other tests get: nothing may be logged or thrown.
    const problems: string[] = [];
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(recordUrl(fx.records[0]!));
    await expect(title(page)).toHaveText("Harper & Co");
    // Values are text, not buttons; the title is not a box; labels have no menu; the page is read, not typed in.
    await expect(properties(page).getByText("Active")).toBeVisible();
    await expect(properties(page).getByText("100")).toBeVisible();
    await expect(main(page).getByRole("textbox")).toHaveCount(0);
    await expect(properties(page).getByRole("button", { name: /^Edit / })).toHaveCount(0);
    await expect(properties(page).getByRole("button", { name: "Status", exact: true })).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: "Add property" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Page" }).getByRole("heading", { name: "Notes for the team" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Page" }).getByRole("listitem")).toHaveText("Renews in March");
    // What a viewer may do: read the comments, and step through the records.
    await main(page).getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: /Delete record/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: /Duplicate record/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await main(page).getByRole("button", { name: /^Comments/ }).click();
    const panel = page.getByRole("complementary", { name: "Comments" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(panel.getByText(/You can read comments but not write them/)).toBeVisible();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(title(page)).toHaveText("Ibis Studio");
    expect(problems).toEqual([]);
    await ctx.close();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a record opens with one tap as a screen of its own, and the back link returns to the list", async ({ page }) => {
    await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.listId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
    await page.getByText("Ibis Studio", { exact: true }).first().tap();
    await expect(page).toHaveURL(new RegExp(`/r/${fx.records[1]}$`));
    await expect(title(page)).toHaveText("Ibis Studio");
    // A screen: no bottom bar, and the header's targets are 44 px.
    await expect(page.getByRole("navigation", { name: "Workspace menu" })).toHaveCount(0);
    const header = page.getByRole("main", { name: "Record" }).locator("header").first();
    for (const name of [/^Comments/, "Share", "More"]) expect((await header.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await header.getByRole("link", { name: "Clients" }).tap();
    await expect(page).toHaveURL(new RegExp(`/${fx.listId}$`));
    await expect(page.getByText("Ibis Studio", { exact: true }).first()).toBeVisible();
  });
});
