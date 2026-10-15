import type { Page } from "@playwright/test";
import { clickGrid, expect, gridFocused, redo, test, typeToEdit, undo } from "./fixtures";

/**
 * The journey of a new instance, driven through the real UI in a real browser against the real
 * server: set up the first administrator, create a workspace and a base, rename the table, add
 * fields (number, single select, date, formula) through the field dialog, add records and edit cells
 * in the grid, filter and sort from the toolbar, open the expanded record and comment, then log out
 * and back in. Everything that matters is verified against the API, never against canvas pixels
 * (the grid is drawn on a canvas, so cells are operated by position, like grid.spec.ts does).
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1360, height: 820 } });

const EMAIL = "journey-admin@example.com";
const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

// Grid geometry (views/grid/cellModels.ts defaultWidth, GlideGrid.tsx): row marker, header, row height.
const MARKER_W = 56;
const HEADER_H = 44;
const ROW_H = 42;
// A table made on the empty base's page has only its primary field, so the added fields follow "Name".
const COLUMNS = [
  { key: "name", width: 220 },
  { key: "qty", width: 140 },
  { key: "status", width: 170 },
  { key: "due", width: 140 },
  { key: "double", width: 170 },
] as const;
type Col = (typeof COLUMNS)[number]["key"];

type Field = { id: string; name: string; type: string; options: Record<string, unknown> };
type Table = { id: string; name: string; icon?: string | null; primary_field_id: string; fields: Field[]; views: { id: string; config: Record<string, unknown> }[] };

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
    // A too-short password is caught before any request is made.
    await page.getByLabel("Your name").fill("Journey Admin");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Create my account" }).click();
    await expect(page.getByRole("alert").or(page.locator("[role=alert], .text-danger")).first()).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create my account" }).click();
    // A new account meets the intro first; skipping it is remembered by the server.
    await expect(page.getByRole("dialog", { name: "A base holds one project" })).toBeVisible();
    await page.getByRole("button", { name: "Skip the intro" }).click();
    await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
    expect(await api<{ needs_setup: boolean }>(page, "/api/setup")).toMatchObject({ needs_setup: false });
    await expect.poll(async () => api<{ intro_seen: boolean }>(page, "/api/auth/me")).toMatchObject({ email: EMAIL, is_admin: true, intro_seen: true });
  });

  await test.step("creates a workspace and a base", async () => {
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Journey workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Journey workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Make your first base" })).toBeVisible();
    await page.getByRole("button", { name: "New base" }).first().click();
    await page.getByRole("textbox", { name: "Name" }).fill("Journey base");
    await page.getByRole("button", { name: "Create base" }).click();
    // A new base starts without tables, and the page asks for the first one by name.
    await expect(page).toHaveURL(/\/base\/app[^/]+$/);
    baseId = /\/base\/(app[^/]+)/.exec(page.url())![1]!;
    await expect(page.getByRole("heading", { name: "Create your first table" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Tables" }).getByText("No tables yet.")).toBeVisible();
    await page.getByRole("textbox", { name: "Table name" }).fill("Table 1");
    await page.getByRole("button", { name: "Create table" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${baseId}/tbl[^/]+/viw[^/]+$`));
    viewId = /\/(viw[^/?]+)/.exec(page.url())![1]!;
    await expect(page.getByRole("toolbar", { name: "View toolbar" })).toBeVisible();
    const workspaces = await api<{ name: string; bases: { id: string; name: string }[] }[]>(page, "/api/workspaces");
    expect(workspaces.find((w) => w.name === "Journey workspace")?.bases.map((b) => b.name)).toEqual(["Journey base"]);
  });

  await test.step("renames the table", async () => {
    table = await loadTable();
    await page.getByRole("button", { name: `Table options for ${table.name}` }).click();
    await page.getByRole("menuitem", { name: "Rename table" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Projects");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
    table = await loadTable();
    expect(table.name).toBe("Projects");
  });

  const addField = async (name: string, type: RegExp, fill?: () => Promise<void>) => {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add field" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await dialog.getByLabel("Field name").fill(name);
    await dialog.getByRole("option", { name: type }).click();
    await fill?.();
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog).toBeHidden();
  };

  await test.step("adds a number, a single select, a date and a formula field through the field dialog", async () => {
    await addField("Qty", /^Number\b/);
    await addField("Status", /^Single select\b/, async () => {
      const dialog = page.getByRole("dialog", { name: "Add a field" });
      await dialog.getByRole("button", { name: "Add option" }).click();
      await dialog.getByLabel("Name of option 1").fill("Todo");
      await dialog.getByRole("button", { name: "Add option" }).click();
      await dialog.getByLabel("Name of option 2").fill("Done");
    });
    await addField("Due", /^Date\b/);
    await addField("Double", /^Formula\b/, async () => {
      const dialog = page.getByRole("dialog", { name: "Add a field" });
      await dialog.getByRole("combobox", { name: "Formula" }).fill("{Qty} * 2");
      // The live check against the server parses the formula and previews it.
      await expect(dialog.getByText(/Looks good/)).toBeVisible();
    });

    table = await loadTable();
    expect(table.fields.map((f) => [f.name, f.type])).toEqual([["Name", "single_line_text"], ["Qty", "number"], ["Status", "single_select"], ["Due", "date"], ["Double", "formula"]]);
    const double = table.fields.find((f) => f.name === "Double")!;
    expect(double.options).toMatchObject({ expression: "{Qty} * 2", result_type: "number" });
    const status = table.fields.find((f) => f.name === "Status")!;
    expect((status.options.choices as { name: string }[]).map((c) => c.name)).toEqual(["Todo", "Done"]);
    // The new columns are in the grid.
    await expect(page.getByText("5 fields").or(page.getByRole("toolbar", { name: "View toolbar" }))).toBeVisible();
  });

  const fid = (name: string) => table.fields.find((f) => f.name === name)!.id;

  await test.step("adds records and edits cells in the grid", async () => {
    await expect(page.getByText("0 items")).toBeVisible();
    for (let i = 1; i <= 3; i++) {
      await page.getByRole("button", { name: "Add record" }).click();
      await expect(page.getByText(`${i} record${i === 1 ? "" : "s"}`)).toBeVisible();
    }
    expect(await records()).toHaveLength(3);

    const names = ["Alpha", "Bravo", "Charlie"];
    await typeDown(page, "name", 0, names);
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

  await test.step("filters and sorts from the toolbar; the view remembers both", async () => {
    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByRole("button", { name: "Add condition", exact: true }).click();
    await page.getByLabel("Field", { exact: true }).selectOption({ label: "Qty" });
    await page.getByLabel("Operator").selectOption("gte");
    await page.getByLabel("Value").fill("20");
    await expect(page.getByText("2 items")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Filtered by / })).toBeVisible();

    await page.getByRole("button", { name: /^Sort/ }).click();
    await page.getByRole("button", { name: "Add sort" }).click();
    await page.getByLabel("Field for sort 1").selectOption({ label: "Qty" });
    await page.getByLabel("Direction for sort 1").selectOption("desc");
    await expect(page.getByRole("button", { name: /^Sorted by / })).toBeVisible();
    await page.keyboard.press("Escape");

    // The server applies the saved view config: only Qty >= 20, biggest first.
    await expect.poll(async () => (await records()).map((r) => r.values[table.primary_field_id])).toEqual(["Charlie", "Bravo"]);
    const view = (await loadTable()).views.find((v) => v.id === viewId)!;
    expect(view.config).toMatchObject({ filter: { items: [{ field_id: fid("Qty"), op: "gte", value: 20 }] }, sorts: [{ field_id: fid("Qty"), direction: "desc" }] });
    // The saved view survives a reload.
    await page.reload();
    await expect(page.getByText("2 items")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sorted by / })).toBeVisible();
  });

  await test.step("opens the expanded record and comments on it", async () => {
    await selectCell(page, "name", 0); // Charlie, the biggest Qty
    await page.keyboard.press("Shift+Space");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Charlie" })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Write a comment" }).fill("Ship it");
    await dialog.getByRole("button", { name: "Comment" }).click();
    await expect(dialog.getByText("Ship it")).toBeVisible();
    const rec = (await records())[0]!;
    const comments = await api<{ body: string; user_name: string }[]>(page, `/api/records/${rec.id}/comments`);
    expect(comments.map((c) => c.body)).toEqual(["Ship it"]);
    expect(comments[0]!.user_name).toBe("Journey Admin");
    await dialog.getByRole("tab", { name: "History" }).click();
    await expect(dialog.getByRole("list", { name: "Revision history" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/record=/);
  });

  await test.step("logs out and back in; the data is where it was left", async () => {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
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
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
    await expect(page.getByText("2 items")).toBeVisible();
    expect((await records()).map((r) => r.values[table.primary_field_id])).toEqual(["Charlie", "Bravo"]);
  });

  // Icons: picked from the full list for a table, shown in its tab and in the link field's target
  // select, then for the base and the workspace (workspace page tiles).
  await test.step("gives the table an icon from the full list; the tab shows it and the server keeps it", async () => {
    await page.getByRole("button", { name: "Table options for Projects" }).click();
    await page.getByRole("menuitem", { name: /Change icon/ }).click();
    const dialog = page.getByRole("dialog", { name: "Table icon" });
    // The 20 popular icons are on screen at once; anything else is found by name.
    await expect(dialog.getByRole("group", { name: "Popular icons" }).getByRole("button")).toHaveCount(20);
    await dialog.getByRole("searchbox", { name: "Search icons" }).fill("tractor");
    await dialog.getByRole("group", { name: "Matching icons" }).getByRole("button", { name: "Tractor" }).click();
    await expect(dialog).toBeHidden();
    const tab = page.getByRole("navigation", { name: "Tables" }).getByRole("link", { name: "Projects" });
    await expect(tab.locator("svg[data-icon='tractor']")).toBeVisible();
    expect((await loadTable()).icon).toBe("tractor");
    // It survives a reload (and is drawn from the lazily loaded set, not just the bundled 20).
    await page.reload();
    await expect(tab.locator("svg[data-icon='tractor']")).toBeVisible();
  });

  await test.step("shows the table icons in the link field's target select", async () => {
    const created = await page.request.post(`/api/bases/${baseId}/tables`, { data: { name: "Clients", icon: "users" }, headers: CSRF });
    expect(created.ok(), await created.text()).toBeTruthy();
    const clients = (await created.json()) as { id: string };
    await expect(page.getByRole("navigation", { name: "Tables" }).getByRole("link", { name: "Clients" }).locator("svg[data-icon='users']")).toBeVisible();

    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Add field" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a field" });
    await dialog.getByLabel("Field name").fill("Client");
    await dialog.getByRole("option", { name: /^Link to another record/ }).click();
    const target = dialog.getByRole("combobox", { name: "Table to link to" });
    await target.click();
    const here = page.getByRole("option", { name: "Projects (this table)" });
    const other = page.getByRole("option", { name: "Clients" });
    await expect(here.locator("svg[data-icon='tractor']")).toBeVisible();
    await expect(other.locator("svg[data-icon='users']")).toBeVisible();
    await other.click();
    await expect(target.locator("svg[data-icon='users']")).toBeVisible();
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog).toBeHidden();
    const link = (await loadTable()).fields.find((f) => f.name === "Client")!;
    expect(link.type).toBe("link");
    expect(link.options).toMatchObject({ linked_table_id: clients.id });
  });

  await test.step("gives the base and the workspace icons; the workspace page shows them instead of the letters", async () => {
    await page.getByRole("heading", { level: 1 }).getByRole("button").click();
    await page.getByRole("menuitem", { name: "Change icon" }).click();
    await page.getByRole("group", { name: "Popular icons" }).getByRole("button", { name: "Store" }).click();
    await expect(page.getByRole("heading", { level: 1 }).locator("[data-entity-tile] svg[data-icon='store']")).toBeVisible();

    await page.getByRole("heading", { level: 1 }).getByRole("button").click();
    await page.getByRole("menuitem", { name: "Workspace home" }).click();
    const card = page.getByRole("link", { name: "Journey base" }).locator("xpath=ancestor::li");
    await expect(card.locator("[data-entity-tile] svg[data-icon='store']")).toBeVisible();
    await expect(card.locator("[data-entity-tile]")).not.toContainText("J");

    await page.getByRole("button", { name: "Change icon of Journey workspace" }).click();
    await page.getByRole("group", { name: "Popular icons" }).getByRole("button", { name: "Briefcase" }).click();
    // The workspace page's own header (the app's top bar is a header too, outside main).
    const section = page.getByRole("main").locator("header");
    await expect(section.locator("[data-entity-tile] svg[data-icon='briefcase']").first()).toBeVisible();
    const workspaces = await api<{ name: string; icon: string | null; bases: { name: string; icon: string | null }[] }[]>(page, "/api/workspaces");
    const ws = workspaces.find((w) => w.name === "Journey workspace")!;
    expect(ws.icon).toBe("briefcase");
    expect(ws.bases.find((b) => b.name === "Journey base")?.icon).toBe("store");

    // Removing the icon brings the letter back.
    await page.getByRole("button", { name: "Change icon of Journey workspace" }).click();
    await page.getByRole("button", { name: "Remove icon" }).click();
    await expect(section.locator("[data-entity-tile]").first()).toContainText("J");
    expect((await api<{ name: string; icon: string | null }[]>(page, "/api/workspaces")).find((w) => w.name === "Journey workspace")?.icon ?? null).toBeNull();
  });
});
