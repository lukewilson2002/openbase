import type { Page } from "@playwright/test";
import { clickGrid, expect, gridFocused, newRecordButton, openOptionsScreen, openRecordPanel, openViewOptions, redo, test, typeToEdit, undo } from "./fixtures";

/**
 * The journey of a new instance, driven through the real UI in a real browser against the real
 * server: set up the first administrator, create a workspace and a base, rename the table, add
 * fields (number, single select, date, formula) through the property dialog, add records and edit cells
 * in the grid, filter and sort from the toolbar, open the record page and comment, then log out
 * and back in. Everything that matters is verified against the API, never against canvas pixels
 * (the grid is drawn on a canvas, so cells are operated by position, like grid.spec.ts does).
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1360, height: 820 } });

const EMAIL = "journey-admin@example.com";
const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

// Grid geometry (GlideGrid.tsx): row marker, header, row height. The column widths below are saved on
// the view before the grid is clicked: a column without a width of its own fits its content.
const MARKER_W = 56;
const HEADER_H = 44;
const ROW_H = 46;
// A table made on the empty base's page has its primary field and the hidden Page property, so the columns the grid shows follow "Name".
const COLUMNS = [
  { key: "name", width: 220 },
  { key: "qty", width: 140 },
  { key: "status", width: 170 },
  { key: "due", width: 140 },
  { key: "double", width: 170 },
] as const;
type Col = (typeof COLUMNS)[number]["key"];

type Field = { id: string; name: string; type: string; options: Record<string, unknown> };
type Table = { id: string; name: string; icon?: string | null; primary_field_id: string; fields: Field[]; views: { id: string; is_default?: boolean; config: Record<string, unknown> }[] };

async function api<T>(page: Page, path: string, init?: { method?: "GET" | "POST"; data?: unknown }): Promise<T> {
  const res = init?.method === "POST" ? await page.request.post(path, { data: init.data ?? {}, headers: CSRF }) : await page.request.get(path);
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const canvas = (page: Page) => page.locator("canvas[data-testid='data-grid-canvas']").first();

async function cellPoint(page: Page, col: Col, row: number) {
  const box = await canvas(page).boundingBox();
  expect(box, "the grid canvas is not on screen").not.toBeNull();
  let x = MARKER_W;
  for (const c of COLUMNS) {
    if (c.key === col) return { x: box!.x + x + c.width / 2, y: box!.y + HEADER_H + row * ROW_H + ROW_H / 2 };
    x += c.width;
  }
  throw new Error(`unknown column ${col}`);
}

async function selectCell(page: Page, col: Col, row: number, opts: { double?: boolean } = {}) {
  const p = await cellPoint(page, col, row);
  await clickGrid(page, p.x, p.y, opts);
}

/**
 * Fill a column from `startRow` downwards the way people do in a spreadsheet: click the first cell,
 * then type a value and press Enter (which moves the selection to the next row) for each value.
 * Clicking every cell instead would be flaky, and not just for tests: Glide treats two mouse clicks
 * within half a second as a double click, which opens the editor of an already selected cell.
 */
async function typeDown(page: Page, col: Col, startRow: number, values: string[]) {
  await selectCell(page, col, startRow);
  for (const value of values) {
    await typeToEdit(page, value);
    await page.keyboard.press("Enter");
    await gridFocused(page);
  }
}

/**
 * The sign-in card (APP-1): the OpenBase lockup above a 400 px card (the page's width less its gutters on a phone),
 * 44 px inputs, a primary button as wide as the card, and no sideways scroll at either size.
 */
async function expectSignInCard(page: Page, primary: string) {
  const original = page.viewportSize();
  for (const [width, height, card] of [[1280, 800, 400], [390, 844, 358]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole("img", { name: "OpenBase" })).toBeVisible();
    const box = await page.getByRole("heading", { level: 1 }).evaluate((h) => h.closest("[class*='max-w-']")!.getBoundingClientRect().toJSON() as { width: number });
    expect(box.width).toBeCloseTo(card, 0);
    const input = await page.getByLabel("Email").boundingBox();
    expect(input!.height).toBeGreaterThanOrEqual(44);
    const button = await page.getByRole("button", { name: primary }).boundingBox();
    expect(button!.width).toBeGreaterThan(box.width - 60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  if (original) await page.setViewportSize(original);
}

test("a new instance, from first-run setup to a logged-in grid with data", async ({ page, diagnostics }) => {
  test.setTimeout(120_000);
  // The wrong password typed on purpose below makes Chrome log the 401 of the login request.
  diagnostics.allow(/status of 401.*\/api\/auth\/login\)$/);
  let baseId = "";
  let table: Table;
  let viewId = "";

  const loadTable = async (): Promise<Table> => {
    const base = await api<{ tables: Table[] }>(page, `/api/bases/${baseId}`);
    return base.tables[0]!;
  };
  const records = async () => {
    const res = await page.request.post(`/api/views/${viewId}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
    expect(res.ok()).toBeTruthy();
    return ((await res.json()) as { total: number; records: { id: string; values: Record<string, unknown> }[] }).records;
  };

  await test.step("the first visit leads to the first-run screen, creates the owner and shows the intro", async () => {
    test.skip((await (await page.request.get("/api/setup")).json()).needs_setup === false, "this instance was already set up; the journey needs a fresh one");
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Welcome to your OpenBase" })).toBeVisible();
    await expectSignInCard(page, "Create my account");
    // A too-short password is caught before any request is made.
    await page.getByLabel("Your name").fill("Journey Admin");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Create my account" }).click();
    await expect(page.getByRole("alert").or(page.locator("[role=alert], .text-danger")).first()).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create my account" }).click();
    // A new account meets the five-step intro first (APP-3); finishing it is remembered by the server.
    const intro = page.getByRole("dialog", { name: "Home catches your ideas" });
    await expect(intro).toBeVisible();
    for (const title of ["Collections hold your records", "Views show your collection your way", "Workspaces and folders keep things apart", "Connect an assistant, if you like"]) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
    await page.getByRole("button", { name: "I'll do it myself" }).click();
    await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
    expect(await api<{ needs_setup: boolean }>(page, "/api/setup")).toMatchObject({ needs_setup: false });
    await expect.poll(async () => api<{ intro_seen: boolean }>(page, "/api/auth/me")).toMatchObject({ email: EMAIL, is_admin: true, intro_seen: true });
  });

  await test.step("creates a workspace, which starts with its top-level project", async () => {
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Journey workspace");
    await page.getByRole("radio", { name: "Teal", exact: true }).click();
    await page.getByRole("button", { name: "Create workspace" }).click();
    // A new workspace opens on its Home, and starts with an empty top-level project named after it.
    await expect(page).toHaveURL(/\/workspace\/wsp[^/]+$/);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    const workspaceId = /\/workspace\/(wsp[^/]+)/.exec(page.url())![1]!;
    const listed = await api<{ id: string; color: string; root_base_id: string | null }[]>(page, "/api/workspaces");
    // The color picked on the first-run screen is the workspace's, and the top-level project exists (APP-2).
    expect(listed.find((w) => w.id === workspaceId)!.color).toBe("teal");
    const topLevelId = listed.find((w) => w.id === workspaceId)!.root_base_id!;
    // The later steps and specs name the project, so give it the name they use (the sidebar and the header show it).
    const renamed = await page.request.patch(`/api/bases/${topLevelId}`, { data: { name: "Journey base" }, headers: CSRF });
    expect(renamed.ok(), `rename the top-level project: ${renamed.status()}`).toBeTruthy();
    await page.goto(`/base/${topLevelId}`);
    // It has no collections yet, and the page asks for the first one.
    baseId = topLevelId;
    await expect(page.getByRole("heading", { name: "No collections in Journey base yet" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByText(/No collections yet/)).toBeVisible();
    await page.getByRole("button", { name: "New collection" }).click();
    const newCollection = page.getByRole("dialog", { name: "New collection" });
    await newCollection.getByLabel("Collection name").fill("Table 1");
    await newCollection.getByRole("button", { name: "Create collection" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${baseId}/tbl[^/]+/viw[^/]+$`));
    await expect(page.getByRole("button", { name: "View options" })).toBeVisible();
    // A new table opens in its default grid, its only view: its tab reads "All" and the collection's name.
    await expect(page.getByRole("tab", { name: "All table 1" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(1);
    const defaultId = /\/(viw[^/?]+)/.exec(page.url())![1]!;
    expect((await loadTable()).views.map((v) => [v.id, v.is_default])).toEqual([[defaultId, true]]);
    // A shared grid of its own, named after its type, keeps the filter and sort the steps below save. There is no
    // Add view: a view is made by Save as view from a draft (views.spec), so this one is made through the API.
    const made = await page.request.post(`/api/tables/${/\/(tbl[^/]+)\//.exec(page.url())![1]}/views`, { data: { name: "Grid", type: "grid", personal: false, config: null }, headers: CSRF });
    expect(made.ok(), `create the grid view: ${made.status()}`).toBeTruthy();
    viewId = ((await made.json()) as { id: string }).id;
    await page.reload();
    await page.getByRole("tab", { name: "Grid" }).click();
    await expect(page).toHaveURL(new RegExp(`/${viewId}$`));
    const workspaces = await api<{ name: string; bases: { id: string; name: string }[] }[]>(page, "/api/workspaces");
    expect(workspaces.find((w) => w.name === "Journey workspace")?.bases.map((b) => b.name)).toEqual(["Journey base"]);
  });

  await test.step("renames the table", async () => {
    table = await loadTable();
    await page.getByRole("button", { name: `Collection options for ${table.name}` }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Collection name" }).fill("Projects");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: /^Projects/ })).toBeVisible();
    table = await loadTable();
    expect(table.name).toBe("Projects");
  });

  const addField = async (name: string, type: RegExp, fill?: () => Promise<void>) => {
    await (await openViewOptions(page)).getByRole("button", { name: "Add property" }).click();
    const dialog = page.getByRole("dialog", { name: "Add property" });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByRole("option", { name: type }).click();
    await fill?.();
    await dialog.getByRole("button", { name: "Add property" }).click();
    await expect(dialog).toBeHidden();
  };

  await test.step("adds a number, a single select, a date and a formula field through the property dialog", async () => {
    await addField("Qty", /^Number\b/);
    await addField("Status", /^Single select\b/, async () => {
      const dialog = page.getByRole("dialog", { name: "Add property" });
      await dialog.getByRole("button", { name: "Add option" }).click();
      await dialog.getByLabel("Name of option 1").fill("Todo");
      await dialog.getByRole("button", { name: "Add option" }).click();
      await dialog.getByLabel("Name of option 2").fill("Done");
    });
    await addField("Due", /^Date\b/);
    await addField("Double", /^Formula\b/, async () => {
      const dialog = page.getByRole("dialog", { name: "Add property" });
      await dialog.getByRole("combobox", { name: "Formula" }).fill("{Qty} * 2");
      // The live check against the server parses the formula and previews it.
      await expect(dialog.getByText(/Looks good/)).toBeVisible();
    });

    table = await loadTable();
    expect(table.fields.map((f) => [f.name, f.type])).toEqual([["Name", "text"], ["Page", "rich_text"], ["Qty", "number"], ["Status", "single_select"], ["Due", "date"], ["Double", "formula"]]);
    const double = table.fields.find((f) => f.name === "Double")!;
    expect(double.options).toMatchObject({ expression: "{Qty} * 2", result_type: "number" });
    const status = table.fields.find((f) => f.name === "Status")!;
    expect((status.options.choices as { name: string }[]).map((c) => c.name)).toEqual(["Todo", "Done"]);
    // The new columns are in the grid.
    await expect(page.getByText("5 fields").or(page.getByRole("button", { name: "View options" }))).toBeVisible();
  });

  const fid = (name: string) => table.fields.find((f) => f.name === name)!.id;

  await test.step("gives the grid's columns known widths, to click cells by position", async () => {
    const view = (await loadTable()).views.find((v) => v.id === viewId)!;
    const field_widths = Object.fromEntries(COLUMNS.map((c) => [fid(c.key === "name" ? "Name" : c.key[0]!.toUpperCase() + c.key.slice(1)), c.width]));
    const res = await page.request.patch(`/api/views/${viewId}`, { data: { config: { ...view.config, field_widths } }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
    await page.reload();
    await expect(page.getByRole("button", { name: "View options" })).toBeVisible();
  });

  await test.step("adds records and edits cells in the grid", async () => {
    await expect(page.getByText("0 items")).toBeVisible();
    const names = ["Alpha", "Bravo", "Charlie"];
    for (const [i, name] of names.entries()) {
      await newRecordButton(page).click();
      // The header's New opens the new record as its page with the title focused (REC-8); a record that is named stays,
      // and the bar's breadcrumb leads back to the grid.
      const main = page.getByRole("main", { name: "Record" });
      await expect(main.getByRole("textbox", { name: "Name" })).toBeFocused();
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await records()).map((r) => r.values[table.primary_field_id])).toEqual(names.slice(0, i + 1));
      await main.getByRole("navigation", { name: "Breadcrumb" }).locator(`a[href$="/${viewId}"]`).click();
      await expect(page.getByText(`${i + 1} item${i === 0 ? "" : "s"}`)).toBeVisible();
    }
    expect(await records()).toHaveLength(3);
    await expect.poll(async () => (await records()).map((r) => r.values[table.primary_field_id])).toEqual(names);

    await typeDown(page, "qty", 0, ["10", "20", "30"]);
    await expect.poll(async () => (await records()).map((r) => r.values[fid("Qty")])).toEqual([10, 20, 30]);
    // The formula column is computed by the server.
    await expect.poll(async () => (await records()).map((r) => r.values[fid("Double")])).toEqual([20, 40, 60]);

    // A single select is picked in its editor.
    await selectCell(page, "status", 1, { double: true });
    await page.getByRole("combobox", { name: /Find an option/ }).fill("Done");
    await page.getByRole("option", { name: "Done" }).click();
    const done = (status: unknown) => (table.fields.find((f) => f.name === "Status")!.options.choices as { id: string; name: string }[]).find((c) => c.id === status)?.name;
    await expect.poll(async () => done((await records())[1]!.values[fid("Status")])).toBe("Done");

    // Dates are typed in the field's format.
    await typeDown(page, "due", 0, ["2026-03-04"]);
    await expect.poll(async () => (await records())[0]!.values[fid("Due")]).toBe("2026-03-04");

    // Undo and redo act on the server state too: the last edit was the date.
    await undo(page);
    await expect.poll(async () => (await records())[0]!.values[fid("Due")]).toBeUndefined();
    await redo(page);
    await expect.poll(async () => (await records())[0]!.values[fid("Due")]).toBe("2026-03-04");
  });

  await test.step("filters from the filter bar and sorts from View options as a draft; Reset takes it back and Update view saves it", async () => {
    await page.getByRole("combobox", { name: "Filter or search" }).fill("qty at least 20");
    await page.keyboard.press("Enter");
    await expect(page.getByText("2 items")).toBeVisible();
    await expect(page.getByRole("button", { name: "Qty is at least 20", exact: true })).toBeVisible();

    await openOptionsScreen(page, "Sort");
    await page.getByRole("button", { name: "Add sort" }).click();
    await page.getByLabel("Property for sort 1").selectOption({ label: "Qty" });
    await page.getByLabel("Direction for sort 1").selectOption("desc");
    await page.keyboard.press("Escape");

    // Nothing is saved yet: the bar counts what the draft shows, and the view still holds all three.
    await expect(page.getByText("Showing 2 of 3 records.")).toBeVisible();
    await expect.poll(async () => (await records()).length).toBe(3);
    expect((await loadTable()).views.find((v) => v.id === viewId)!.config).toMatchObject({ filter: null, sorts: [] });
    // The draft survives a reload on this device.
    await page.reload();
    await expect(page.getByText("2 items")).toBeVisible();
    await expect((await openViewOptions(page)).getByRole("button", { name: /^Sort Qty, highest first$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Showing 2 of 3 records.")).toBeVisible();

    // Reset takes both back.
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("3 items")).toBeVisible();
    await expect(page.getByText(/These changes are only for now/)).toBeHidden();

    // Again, and this time Update view writes it: the server applies the saved view, only Qty >= 20, biggest first.
    await page.getByRole("combobox", { name: "Filter or search" }).fill("qty at least 20");
    await page.keyboard.press("Enter");
    await expect(page.getByText("2 items")).toBeVisible();
    await openOptionsScreen(page, "Sort");
    await page.getByRole("button", { name: "Add sort" }).click();
    await page.getByLabel("Property for sort 1").selectOption({ label: "Qty" });
    await page.getByLabel("Direction for sort 1").selectOption("desc");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Update view" }).click();
    await expect.poll(async () => (await records()).map((r) => r.values[table.primary_field_id])).toEqual(["Charlie", "Bravo"]);
    const view = (await loadTable()).views.find((v) => v.id === viewId)!;
    expect(view.config).toMatchObject({ filter: { items: [{ field_id: fid("Qty"), op: "gte", value: 20 }] }, sorts: [{ field_id: fid("Qty"), direction: "desc" }] });
    await expect(page.getByText(/These changes are only for now/)).toBeHidden();
    // The saved view survives a reload.
    await page.reload();
    await expect(page.getByText("2 items")).toBeVisible();
    await expect((await openViewOptions(page)).getByRole("button", { name: /^Sort Qty, highest first$/ })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("opens the record's page and comments on it", async () => {
    await selectCell(page, "name", 0); // Charlie, the biggest Qty
    await page.keyboard.press("Shift+Space");
    await expect(page.getByRole("main", { name: "Record" }).getByRole("heading", { level: 1, name: "Charlie" })).toBeVisible();
    const comments = await openRecordPanel(page, "Comments");
    await comments.getByRole("textbox", { name: "Write a comment" }).fill("Ship it");
    await comments.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(comments.getByText("Ship it")).toBeVisible();
    const rec = (await records())[0]!;
    const saved = await api<{ body: string; user_name: string }[]>(page, `/api/records/${rec.id}/comments`);
    expect(saved.map((c) => c.body)).toEqual(["Ship it"]);
    expect(saved[0]!.user_name).toBe("Journey Admin");
    const history = await openRecordPanel(page, "History");
    await expect(history.getByRole("list", { name: "Revision history" })).toBeVisible();
    // The History panel is the open one; Escape closes it first and the next returns to the grid.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "History" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/\/r\//);
  });

  await test.step("logs out and back in; the data is where it was left", async () => {
    await page.getByRole("button", { name: /^Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expectSignInCard(page, "Log in");
    // The session is gone for real, not just hidden.
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
    await page.goto(`/base/${baseId}`);
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();

    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert").or(page.locator(".text-danger")).first()).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    // The login returns to the page that was asked for.
    await expect(page).toHaveURL(new RegExp(`/base/${baseId}/tbl[^/]+/${viewId}$`));
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: /^Projects/ })).toBeVisible();
    await expect(page.getByText("2 items")).toBeVisible();
    expect((await records()).map((r) => r.values[table.primary_field_id])).toEqual(["Charlie", "Bravo"]);
  });

  // The sidebar and the link property's collection picker show entity colors, never icons (decision 3); the icon
  // columns stay in the API.
  await test.step("shows the collection marks, not icons, in the link property's target select", async () => {
    const iconed = await page.request.patch(`/api/tables/${table.id}`, { data: { icon: "tractor" }, headers: CSRF });
    expect(iconed.ok(), await iconed.text()).toBeTruthy();
    const created = await page.request.post(`/api/bases/${baseId}/tables`, { data: { name: "Clients", icon: "users" }, headers: CSRF });
    expect(created.ok(), await created.text()).toBeTruthy();
    const clients = (await created.json()) as { id: string };
    // The sidebar lists it by its color mark and name, and draws no icon.
    const row = page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: /^Clients/ });
    await page.reload();
    await expect(row).toBeVisible();
    await expect(row.locator("svg")).toHaveCount(0);

    await (await openViewOptions(page)).getByRole("button", { name: "Add property" }).click();
    const dialog = page.getByRole("dialog", { name: "Add property" });
    await dialog.getByLabel("Name", { exact: true }).fill("Client");
    await dialog.getByRole("option", { name: /^Link to another record/ }).click();
    const target = dialog.getByRole("combobox", { name: "Collection to link to" });
    await expect(dialog.getByText("Collections in other folders can't be linked.")).toBeVisible();
    await target.click();
    const here = page.getByRole("option", { name: "Projects (this collection)" });
    const other = page.getByRole("option", { name: "Clients" });
    await expect(here.locator(".ob-mark")).toBeVisible();
    await expect(other.locator(".ob-mark")).toBeVisible();
    await expect(here.locator("svg[data-icon='tractor']")).toHaveCount(0);
    await expect(other.locator("svg[data-icon='users']")).toHaveCount(0);
    await other.click();
    await expect(target.locator(".ob-mark")).toBeVisible();
    await expect(target.locator("svg[data-icon='users']")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Add property" }).click();
    await expect(dialog).toBeHidden();
    const link = (await loadTable()).fields.find((f) => f.name === "Client")!;
    expect(link.type).toBe("link");
    expect(link.options).toMatchObject({ linked_table_id: clients.id });
  });

  await test.step("colors the workspace from the switcher's menu, and the sidebar shows the color without a letter or icon", async () => {
    const menu = page.getByRole("navigation", { name: "Main menu" });
    await menu.getByRole("button", { name: /^Journey workspace/ }).click();
    await page.getByRole("menuitem", { name: "Color" }).click();
    await page.getByRole("dialog", { name: "Workspace color" }).getByRole("radio", { name: "Purple", exact: true }).click();
    await expect.poll(async () => (await api<{ name: string; color: string }[]>(page, "/api/workspaces")).find((w) => w.name === "Journey workspace")?.color).toBe("purple");
    const mark = menu.getByRole("button", { name: /^Journey workspace/ }).locator(".ob-mark");
    await expect(mark).toHaveClass(/ob-hue-purple/);
    await expect(mark).toBeEmpty();
  });
});
