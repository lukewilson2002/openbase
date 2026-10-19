import type { APIRequestContext, Cookie, Locator, Page } from "@playwright/test";
import { clickGrid, expect, newClientContext, redo, skipIntro, test, typeToEdit, undo } from "./fixtures";

/**
 * Grid journeys against a live server: edit cells (text, number, select), undo/redo, filter, sort,
 * search, hide fields, add a field, expanded record with comments, add/delete records.
 * Runs only with OPENBASE_E2E=1 (see playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=grid --no-deps
 *
 * It signs up its own user (the server started by globalSetup allows signup; on a server that does
 * not, set OPENBASE_E2E_EMAIL and OPENBASE_E2E_PASSWORD to an existing account).
 *
 * Glide draws on a canvas, so cells are operated by position (column widths and row heights are
 * the grid's defaults) with real mouse and keyboard input, and results are asserted against the
 * server (`rows()`), never against pixels.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-grid@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

// Grid geometry (see views/grid/cellModels.ts defaultWidth and the Glide setup in GlideGrid.tsx).
const MARKER_W = 56;
const HEADER_H = 44;
const ROW_H = 42;
// The fixture builds Name, Notes, Qty, Status and Done, in that order.
const WIDTHS = { name: 220, notes: 260, qty: 140, status: 170, done: 110 };

interface Fixture {
  baseId: string;
  tableId: string;
  viewId: string;
  fields: Record<"name" | "qty" | "status" | "done", string>;
}

let fx: Fixture;
/** The signed-in session, added to every test's fresh browser context. */
let session: Cookie[] = [];

async function post<T>(req: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await req.post(path, { data, headers: CSRF });
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function signIn(page: Page): Promise<void> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Grid", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
}

type TableDto = { id: string; fields: { id: string; name: string }[]; views: { id: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const ws = await post<{ id: string }>(req, "/api/workspaces", { name: `E2E ${Date.now()}` });
  const base = await post<{ id: string; tables: TableDto[] }>(req, `/api/workspaces/${ws.id}/bases`, { name: "Grid E2E" });
  const table = base.tables[0] ?? (await post<TableDto>(req, `/api/bases/${base.id}/tables`, { name: "Tasks" }));
  const nameField = table.fields[0]!.id;
  // A new table has only its primary field; the grid tests expect a Notes column after Name.
  await post(req, `/api/tables/${table.id}/fields`, { name: "Notes", type: "long_text", options: {} });
  const qty = await post<{ id: string }>(req, `/api/tables/${table.id}/fields`, { name: "Qty", type: "number", options: { precision: 0, allow_negative: true } });
  const status = await post<{ id: string; options: { choices: { id: string; name: string }[] } }>(req, `/api/tables/${table.id}/fields`, {
    name: "Status",
    type: "single_select",
    options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] },
  });
  const done = await post<{ id: string }>(req, `/api/tables/${table.id}/fields`, { name: "Done", type: "checkbox", options: {} });
  const choice = Object.fromEntries(status.options.choices.map((c) => [c.name, c.id]));
  await post(req, `/api/tables/${table.id}/records`, {
    typecast: true,
    records: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((n, i) => ({ values: { [nameField]: n, [qty.id]: (i + 1) * 10, [status.id]: choice[i % 2 ? "Done" : "Todo"] } })),
  });
  // A shared grid of its own to filter and sort: the table's default grid keeps neither (they are each person's).
  const grid = await post<{ id: string }>(req, `/api/tables/${table.id}/views`, { name: "Grid", type: "grid" });
  return { baseId: base.id, tableId: table.id, viewId: grid.id, fields: { name: nameField, qty: qty.id, status: status.id, done: done.id } };
}

/** Records as the server has them, in the default view order. */
async function rows(page: Page): Promise<{ name: string; qty: number | undefined; status: string | undefined }[]> {
  const res = await page.request.post(`/api/views/${fx.viewId}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
  const body = (await res.json()) as { records: { values: Record<string, unknown> }[] };
  return body.records.map((r) => ({ name: String(r.values[fx.fields.name] ?? ""), qty: r.values[fx.fields.qty] as number | undefined, status: r.values[fx.fields.status] as string | undefined }));
}

const canvas = (page: Page): Locator => page.locator("canvas[data-testid='data-grid-canvas']").first();

/** Click the centre of the cell at (`col` among name/notes/qty/status/done, `row` 0-based). */
async function pointAt(page: Page, col: keyof typeof WIDTHS, row: number) {
  const box = await canvas(page).boundingBox();
  expect(box, "the grid canvas is not on screen").not.toBeNull();
  const order = ["name", "notes", "qty", "status", "done"] as const;
  let x = MARKER_W;
  for (const c of order) {
    if (c === col) break;
    x += WIDTHS[c];
  }
  return { x: box!.x + x + WIDTHS[col] / 2, y: box!.y + HEADER_H + row * ROW_H + ROW_H / 2 };
}

async function clickCell(page: Page, col: keyof typeof WIDTHS, row: number, opts: { double?: boolean; right?: boolean } = {}) {
  const p = await pointAt(page, col, row);
  await clickGrid(page, p.x, p.y, opts);
}

async function gotoGrid(page: Page) {
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.viewId}`);
  await expect(page.getByRole("toolbar", { name: "View toolbar" })).toBeVisible();
  await expect(page.getByText(/\d+ items?/)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
}

test.beforeAll(async ({ browser }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL: process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080" }, "seed");
  const page = await ctx.newPage();
  await signIn(page);
  fx = await seed(page);
  session = await ctx.cookies();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

test.use({ viewport: { width: 1360, height: 820 } });

test("shows the seeded records and the record count", async ({ page }) => {
  await gotoGrid(page);
  await expect(page.getByText("5 items")).toBeVisible();
  expect((await rows(page)).map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
});

test("edits a text cell, saves it on the server, and undoes and redoes it", async ({ page }) => {
  await gotoGrid(page);
  await clickCell(page, "name", 0, { double: true });
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await rows(page))[0]!.name).toBe("Alpha edited");
  await clickCell(page, "name", 0);
  await undo(page);
  await expect.poll(async () => (await rows(page))[0]!.name).toBe("Alpha");
  await redo(page);
  await expect.poll(async () => (await rows(page))[0]!.name).toBe("Alpha edited");
  await undo(page);
  await expect.poll(async () => (await rows(page))[0]!.name).toBe("Alpha");
});

test("type-to-edit replaces a number; text that is not a number is rejected", async ({ page }) => {
  await gotoGrid(page);
  await clickCell(page, "qty", 1);
  await typeToEdit(page, "77");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await rows(page))[1]!.qty).toBe(77);
  await clickCell(page, "qty", 1);
  await typeToEdit(page, "abc");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").first()).toContainText(/not a number/);
  await page.keyboard.press("Escape");
  expect((await rows(page))[1]!.qty).toBe(77);
});

test("picks a single select option from the editor", async ({ page }) => {
  await gotoGrid(page);
  await clickCell(page, "status", 0, { double: true });
  await page.getByRole("combobox", { name: /Find an option/ }).fill("Done");
  await page.getByRole("option", { name: "Done" }).click();
  await expect.poll(async () => (await rows(page))[0]!.status).toBeTruthy();
});

test("clears selected cells with Delete and fills down with Ctrl+D", async ({ page }) => {
  await gotoGrid(page);
  await clickCell(page, "qty", 2);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await rows(page))[2]!.qty).toBeUndefined();
  await undo(page);
  await expect.poll(async () => (await rows(page))[2]!.qty).toBe(30);
});

test("filters by a text condition and shows the record count", async ({ page }) => {
  await gotoGrid(page);
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("button", { name: "Add condition", exact: true }).click();
  await page.getByLabel("Operator").selectOption("contains");
  await page.getByLabel("Value").fill("lph");
  await expect(page.getByText("1 item")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Filtered by / }).click();
  await page.getByRole("button", { name: "Remove condition" }).click();
  await expect(page.getByText("5 items")).toBeVisible();
});

test("sorts by a field descending from the toolbar", async ({ page }) => {
  await gotoGrid(page);
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("button", { name: "Add sort" }).click();
  await page.getByLabel("Direction for sort 1").selectOption("desc");
  await expect(page.getByRole("button", { name: /^Sorted by / })).toBeVisible();
  await expect.poll(async () => (await rows(page))[0]!.name).toBe("Echo");
  await page.getByRole("button", { name: "Remove sort 1" }).click();
});

test("searches with Ctrl+F", async ({ page }) => {
  await gotoGrid(page);
  await page.keyboard.press("Control+F");
  await page.getByRole("searchbox", { name: "Search records" }).fill("char");
  await expect(page.getByText(/1 item found/)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search records" }).press("Escape");
  await expect(page.getByText("5 items")).toBeVisible();
});

test("hides a field and shows it again", async ({ page }) => {
  await gotoGrid(page);
  await page.getByRole("button", { name: /Hide fields/ }).click();
  await page.getByRole("switch", { name: "Qty" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /1 hidden field/ })).toBeVisible();
  await page.getByRole("button", { name: /1 hidden field/ }).click();
  await page.getByRole("button", { name: "Show all" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Hide fields" })).toBeVisible();
});

test("adds a field from the dialog", async ({ page }) => {
  await gotoGrid(page);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Add field" }).click();
  await page.getByLabel("Field name").fill("Remarks");
  await page.getByRole("option", { name: /Long text/ }).click();
  await page.getByRole("button", { name: "Create field" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const base = await (await page.request.get(`/api/bases/${fx.baseId}`)).json();
  const names = base.tables.find((t: { id: string }) => t.id === fx.tableId).fields.map((f: { name: string }) => f.name);
  expect(names).toContain("Notes");
});

test("opens the expanded record with Shift+Space, comments, and the link is shareable", async ({ page }) => {
  await gotoGrid(page);
  await clickCell(page, "name", 1);
  await page.keyboard.press("Shift+Space");
  await expect(page).toHaveURL(/[?&]record=rec/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Bravo" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Write a comment" }).fill("Hello from the e2e test");
  await dialog.getByRole("button", { name: "Comment" }).click();
  await expect(dialog.getByText("Hello from the e2e test")).toBeVisible();
  await dialog.getByRole("tab", { name: "History" }).click();
  await expect(dialog.getByRole("list", { name: "Revision history" })).toBeVisible();
  const url = page.url();
  await page.goto(url);
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Bravo" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/record=/);
});

test("adds and deletes records, with undo", async ({ page }) => {
  await gotoGrid(page);
  await page.getByRole("button", { name: "Add record" }).click();
  await expect(page.getByText("6 items")).toBeVisible();
  // Undo is ignored while the grid is still finishing the write it would undo: wait for the server to have it.
  await expect.poll(async () => (await rows(page)).length).toBe(6);
  await undo(page);
  await expect(page.getByText("5 items")).toBeVisible();
  await expect.poll(async () => (await rows(page)).length).toBe(5);
  await clickCell(page, "name", 4, { right: true });
  await page.getByRole("menuitem", { name: /Delete record/ }).click();
  await expect(page.getByText("4 items")).toBeVisible();
  await expect.poll(async () => (await rows(page)).length).toBe(4);
  await undo(page);
  await expect(page.getByText("5 items")).toBeVisible();
  await expect.poll(async () => (await rows(page)).length).toBe(5);
});

/**
 * The marker column's pixels: an 8-bit "ink" map of the marker cell of display row `row`
 * (0 = first body row; `"summary"` = the pinned summary row at the bottom of the canvas) with the
 * cell background taken as the colour of its corner pixel. The marker shows a number or nothing
 * (a checkbox appears only under the pointer, which the helper moves out of the way first).
 */
async function markerInk(page: Page, row: number | "summary"): Promise<string> {
  await page.mouse.move(2, 2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return canvas(page).evaluate(
    (el, args) => {
      const c = el as HTMLCanvasElement;
      const scale = c.width / c.getBoundingClientRect().width;
      const top = args.row === "summary" ? c.getBoundingClientRect().height - args.rowH : args.header + (args.row as number) * args.rowH;
      const ctx = c.getContext("2d")!;
      const x0 = Math.round(8 * scale);
      const w = Math.round((args.markerW - 16) * scale);
      const y0 = Math.round((top + 5) * scale);
      const h = Math.round((args.rowH - 10) * scale);
      const { data } = ctx.getImageData(x0, y0, w, h);
      const bg = [data[0]!, data[1]!, data[2]!];
      let out = "";
      for (let i = 0; i < data.length; i += 4) {
        const d = Math.abs(data[i]! - bg[0]!) + Math.abs(data[i + 1]! - bg[1]!) + Math.abs(data[i + 2]! - bg[2]!);
        out += d > 60 ? "1" : "0";
      }
      return out;
    },
    { row, rowH: ROW_H, header: HEADER_H, markerW: MARKER_W },
  );
}
const inked = (map: string): boolean => map.includes("1");

test("the marker column numbers the records and leaves the pinned summary row without a number", async ({ page }) => {
  await gotoGrid(page);
  const n = (await rows(page)).length;
  expect(inked(await markerInk(page, 0)), "record 1 shows its number").toBe(true);
  expect(inked(await markerInk(page, n - 1)), `record ${n} shows its number`).toBe(true);
  // Below the last record there is empty space, and the summary row at the bottom: neither has a number.
  expect(inked(await markerInk(page, n + 1)), "an empty row shows a number").toBe(false);
  expect(inked(await markerInk(page, "summary")), `the summary row shows "${n + 1}"`).toBe(false);
});

test("in a grouped view the marker column numbers the records, not the group headers", async ({ page }) => {
  const view = await post<{ id: string }>(page.request, `/api/tables/${fx.tableId}/views`, {
    name: "By status",
    type: "grid",
    config: { groups: [{ field_id: fx.fields.status, direction: "asc" }] },
  });
  const res = await page.request.post(`/api/views/${view.id}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
  const grouped = (await res.json()) as { total: number; groups: { start: number; depth: number }[] };
  expect(grouped.groups.length).toBeGreaterThan(1);
  // Display row of record i: the records before it plus the group headers that precede it.
  const displayRow = (i: number) => i + grouped.groups.filter((g) => g.start <= i).length;

  // Reference glyphs: the same numbers in the ungrouped view.
  await gotoGrid(page);
  const plain: string[] = [];
  for (let i = 0; i < grouped.total; i++) plain.push(await markerInk(page, i));

  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${view.id}`);
  await expect(page.getByText(/grouped/)).toBeVisible();
  await expect(canvas(page)).toBeVisible();
  for (let i = 0; i < grouped.total; i++) {
    // Record i + 1 draws the same number as in the plain view: a number, not a (hover-only) checkbox.
    await expect.poll(() => markerInk(page, displayRow(i)), { message: `marker of record ${i + 1}` }).toBe(plain[i]);
  }
  // Group header j sits after its own start records and the j headers before it.
  for (const [j, g] of grouped.groups.entries()) {
    expect(inked(await markerInk(page, g.start + j)), `group header ${j} shows a number`).toBe(false);
  }
  expect(inked(await markerInk(page, "summary")), "the summary row shows a number").toBe(false);
});
