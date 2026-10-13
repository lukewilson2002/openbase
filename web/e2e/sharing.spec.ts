import { readFile } from "node:fs/promises";
import type { APIRequestContext, Browser, BrowserContext, Cookie, Page, TestInfo } from "@playwright/test";
import { expect, newClientContext, test } from "./fixtures";

/**
 * Forms, share links and CSV against a live server, in Chrome:
 *   - build a form view in the UI, share it, submit it anonymously in a fresh browser context (no
 *     cookies at all), and see the record in the grid;
 *   - share a grid view with a password, open it in a fresh context, enter the password and see the
 *     rows but not the hidden field;
 *   - download a view as CSV and check the file; import a CSV into a new table and into an
 *     existing one, including the rows the server refuses;
 *   - a viewer can filter and sort a board for themselves ("Not saved") without changing the view.
 *
 * Results are asserted against the API where the grid (a canvas) would otherwise be the only
 * witness. Runs only with OPENBASE_E2E=1 (see playwright.config.ts).
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1360, height: 860 } });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-sharing@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Fixture {
  workspaceId: string;
  baseId: string;
  tableId: string;
  tableName: string;
  viewId: string;
  fields: { name: string; qty: string; salary: string; status: string };
  choice: { todo: string; done: string };
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

type TableDto = { id: string; name: string; primary_field_id: string; fields: { id: string; name: string; type: string }[]; views: { id: string; name: string; config: { form: { title: string; fields: { field_id: string; required: boolean; label: string | null }[] } } }[] };

async function table(req: APIRequestContext, tableId = fx.tableId): Promise<TableDto> {
  const base = await call<{ tables: TableDto[] }>(req, "get", `/api/bases/${fx.baseId}`);
  return base.tables.find((t) => t.id === tableId)!;
}

async function records(req: APIRequestContext, viewId: string, search?: string): Promise<{ total: number; records: { id: string; values: Record<string, unknown> }[] }> {
  return call(req, "post", `/api/views/${viewId}/query`, { offset: 0, limit: 200, search: search ?? null });
}

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Sharing", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E sharing ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Sharing E2E" });
  const t = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Contacts" }));
  const name = t.primary_field_id;
  const qty = await call<{ id: string }>(req, "post", `/api/tables/${t.id}/fields`, { name: "Qty", type: "number", options: { precision: 0, allow_negative: false } });
  const salary = await call<{ id: string }>(req, "post", `/api/tables/${t.id}/fields`, { name: "Salary", type: "single_line_text", options: {} });
  const status = await call<{ id: string; options: { choices: { id: string; name: string }[] } }>(req, "post", `/api/tables/${t.id}/fields`, {
    name: "Status",
    type: "single_select",
    options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] },
  });
  const choice = Object.fromEntries(status.options.choices.map((c) => [c.name.toLowerCase(), c.id])) as Fixture["choice"];
  await call(req, "post", `/api/tables/${t.id}/records`, {
    typecast: true,
    records: [
      { values: { [name]: "Alpha", [qty.id]: 3, [salary.id]: "SECRET-100", [status.id]: choice.todo } },
      { values: { [name]: "Bravo", [qty.id]: 8, [salary.id]: "SECRET-200", [status.id]: choice.done } },
      { values: { [name]: "Charlie", [qty.id]: 5, [salary.id]: "SECRET-300", [status.id]: choice.todo } },
    ],
  });
  const refreshed = await call<{ tables: TableDto[] }>(req, "get", `/api/bases/${base.id}`);
  const viewId = refreshed.tables.find((x) => x.id === t.id)!.views[0]!.id;
  return { workspaceId: ws.id, baseId: base.id, tableId: t.id, tableName: t.name, viewId, fields: { name, qty: qty.id, salary: salary.id, status: status.id }, choice };
}

/**
 * A browser with no cookies and no storage, as a stranger's would be. Problems the page logs
 * (console errors, CSP violations, failed requests) are collected so the test can assert on them.
 */
async function stranger(browser: Browser, testInfo: TestInfo, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page; problems: string[] }> {
  const context = await newClientContext(browser, testInfo, { baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } }, "stranger");
  const problems: string[] = [];
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    // Chrome reports every 4xx fetch as a console error; the ones a test makes on purpose are listed by the test.
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught exception: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`request failed: ${r.url()}`);
  });
  return { context, page, problems };
}

async function openView(page: Page, viewId = fx.viewId) {
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${viewId}`);
  await expect(page.getByRole("toolbar", { name: /toolbar/ })).toBeVisible();
}

test.beforeAll(async ({ browser, baseURL }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL, storageState: { cookies: [], origins: [] } }, "seed");
  const page = await ctx.newPage();
  fx = await seed(page);
  session = await ctx.cookies();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

test("builds a form, shares it, and a stranger's submission shows up as a record", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  let formViewId = "";
  let link = "";

  await test.step("creates a form view from the sidebar", async () => {
    await openView(page);
    await page.getByRole("button", { name: "Form", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New form view" });
    await dialog.getByLabel("Name").fill("Contact form");
    await dialog.getByRole("button", { name: "Create view" }).click();
    await expect(page.getByRole("heading", { name: "Form", exact: true })).toBeVisible();
    formViewId = new URL(page.url()).pathname.split("/").pop()!;
    // A new form starts with every editable field.
    const t = await table(page.request);
    const created = t.views.find((v) => v.id === formViewId)!;
    expect(created.config.form.fields.map((f) => f.field_id)).toEqual(expect.arrayContaining([fx.fields.name, fx.fields.qty, fx.fields.salary, fx.fields.status]));
  });

  await test.step("builds it: title, a required field with a label, fewer fields", async () => {
    await page.getByLabel("Title").fill("Join the waitlist");
    await page.getByLabel("Description").fill("We write back within a day.");
    await page.getByLabel("Success message").fill("You are on the list!");
    await page.getByLabel("Submit button").fill("Sign me up");
    const nameRow = page.getByRole("listitem", { name: "Form field Name" });
    await nameRow.getByRole("switch", { name: "Required" }).click();
    await page.getByLabel("Label for Name").fill("Your name");
    await page.getByLabel("Help text for Name").fill("As on your ID");
    for (const f of ["Notes", "Salary", "Status"]) await page.getByRole("button", { name: `Remove ${f} from the form` }).click();
    // The live preview follows what was typed.
    const preview = page.getByRole("region", { name: "Form preview" });
    await expect(preview.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
    await expect(preview.getByText("Your name")).toBeVisible();
    await expect(preview.getByRole("button", { name: "Sign me up" })).toBeDisabled();
    await expect.poll(async () => (await table(page.request)).views.find((v) => v.id === formViewId)!.config.form.fields.map((f) => f.field_id)).toEqual([fx.fields.name, fx.fields.qty]);
    const form = (await table(page.request)).views.find((v) => v.id === formViewId)!.config.form;
    expect(form.title).toBe("Join the waitlist");
    expect(form.fields[0]).toMatchObject({ required: true, label: "Your name" });
  });

  await test.step("shares it with a form link", async () => {
    await page.getByRole("button", { name: "Share form" }).click();
    const dialog = page.getByRole("dialog", { name: "Share Contact form" });
    await expect(dialog.getByText(/never see any record/)).toBeVisible();
    await dialog.getByRole("button", { name: "Create form link" }).click();
    const address = dialog.getByRole("textbox", { name: "Form link" });
    await expect(address).toHaveValue(/\/form\/[A-Za-z0-9_-]+$/);
    link = await address.inputValue();
    await page.keyboard.press("Escape");
  });

  await test.step("a stranger fills it in: no cookies, no login, no app shell", async () => {
    const visitor = await stranger(browser, testInfo, baseURL);
    const v = visitor.page;
    await v.goto(link);
    await expect(v.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
    await expect(v.getByText("We write back within a day.")).toBeVisible();
    await expect(v.getByText("As on your ID")).toBeVisible();
    await expect(v.getByText("Powered by")).toBeVisible();
    // Nothing of the app: no toolbar, no sign-in.
    await expect(v.getByRole("toolbar")).toHaveCount(0);
    await expect(v).not.toHaveURL(/login/);

    // Required fields are checked before anything is sent.
    await v.getByRole("button", { name: "Sign me up" }).click();
    await expect(v.getByText("This field is required.")).toBeVisible();
    await expect(v.getByLabel(/Your name/)).toBeFocused();

    await v.getByLabel(/Your name/).fill("Zed Visitor");
    await v.getByLabel("Qty").fill("9");
    await v.getByRole("button", { name: "Sign me up" }).click();
    await expect(v.getByText("You are on the list!")).toBeVisible();
    expect(await visitor.context.cookies()).toEqual([]);
    expect(visitor.problems).toEqual([]);
    await visitor.context.close();
  });

  await test.step("the record is in the table, and the grid shows it", async () => {
    const found = await records(page.request, fx.viewId, "Zed Visitor");
    expect(found.total).toBe(1);
    expect(found.records[0]!.values).toMatchObject({ [fx.fields.name]: "Zed Visitor", [fx.fields.qty]: 9 });
    await openView(page);
    await expect(page.getByText("4 records")).toBeVisible();
    // The grid is a canvas, so look for the record with the search box.
    await page.keyboard.press("Control+F");
    await page.getByRole("searchbox", { name: "Search records" }).fill("Zed");
    await expect(page.getByText(/1 record found/)).toBeVisible();
  });
});

test("shares a grid with a password: a stranger gets the rows, not the hidden field", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  let link = "";
  let token = "";
  let viewId = "";

  await test.step("hides the Salary field in a new grid view and shares it with a password", async () => {
    const created = await call<{ id: string; config: Record<string, unknown> }>(page.request, "post", `/api/tables/${fx.tableId}/views`, { name: "Team sheet", type: "grid", config: null });
    viewId = created.id;
    await call(page.request, "patch", `/api/views/${viewId}`, { config: { ...created.config, hidden_fields: [fx.fields.salary] } });
    await openView(page, viewId);
    await page.getByRole("button", { name: "Share view" }).click();
    const dialog = page.getByRole("dialog", { name: "Share Team sheet" });
    await expect(dialog.getByText(/The 1 hidden field never leaves the server/)).toBeVisible();
    await dialog.getByRole("switch", { name: "Protect with a password" }).click();
    await dialog.getByRole("textbox", { name: "Password" }).fill("open sesame");
    await dialog.getByRole("button", { name: "Create link" }).click();
    const address = dialog.getByRole("textbox", { name: "View link" });
    await expect(address).toHaveValue(/\/share\/[A-Za-z0-9_-]+$/);
    link = await address.inputValue();
    token = link.split("/").pop()!;
    await expect(dialog.getByText("Password protected")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("the API itself refuses the page and the records without the password", async () => {
    const anon = await newClientContext(browser, testInfo, { baseURL, storageState: { cookies: [], origins: [] } }, "anonymous");
    const r1 = await anon.request.get(`/api/public/shares/${token}`);
    expect(r1.status()).toBe(401);
    expect((await r1.json()).error.code).toBe("share_password_required");
    const r2 = await anon.request.post(`/api/public/shares/${token}/query`, { data: {}, headers: CSRF });
    expect(r2.status()).toBe(401);
    await anon.close();
  });

  await test.step("a stranger opens the link, is asked for the password, and sees the shared rows", async () => {
    const visitor = await stranger(browser, testInfo, baseURL);
    const v = visitor.page;
    await v.goto(link);
    await expect(v.getByRole("heading", { name: "This page is password protected" })).toBeVisible();
    await expect(v.getByText("Alpha")).toHaveCount(0);

    await v.getByRole("textbox", { name: "Password" }).fill("wrong one");
    await v.getByRole("button", { name: "Continue" }).click();
    await expect(v.getByText("That password is not correct. Try again.")).toBeVisible();
    await expect(v.getByText("Alpha")).toHaveCount(0);

    await v.getByRole("textbox", { name: "Password" }).fill("open sesame");
    await v.getByRole("button", { name: "Continue" }).click();
    await expect(v.getByRole("heading", { name: "Team sheet" })).toBeVisible();
    const table = v.getByRole("table", { name: "Records" });
    await expect(table.getByText("Alpha")).toBeVisible();
    await expect(table.getByText("Bravo")).toBeVisible();
    await expect(v.getByText(/\d+–\d+ of \d+ records/)).toBeVisible();
    // Visible fields only: the hidden one is not a column, and its values are nowhere in the page.
    await expect(table.getByRole("columnheader")).toContainText(["Name", "Qty", "Status"]);
    await expect(table.getByRole("columnheader", { name: /Salary/ })).toHaveCount(0);
    expect(await v.content()).not.toContain("SECRET-");
    await expect(v.getByText("Powered by")).toBeVisible();

    // Search narrows the rows; the password is not in the address bar or storage.
    await v.getByRole("searchbox", { name: "Search records" }).fill("brav");
    await expect(table.getByText("Alpha")).toHaveCount(0);
    await expect(table.getByText("Bravo")).toBeVisible();
    expect(v.url()).not.toContain("sesame");
    expect(await v.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("sesame");
    expect(await visitor.context.cookies()).toEqual([]);
    // The only console errors are the 401s Chrome logs for the password prompts.
    expect(visitor.problems.filter((p) => !/status of 401/.test(p))).toEqual([]);
    await visitor.context.close();
  });

  await test.step("switching the link off closes it", async () => {
    const links = await call<{ id: string }[]>(page.request, "get", `/api/views/${viewId}/shares`);
    await call(page.request, "patch", `/api/shares/${links[0]!.id}`, { enabled: false });
    const visitor = await stranger(browser, testInfo, baseURL);
    await visitor.page.goto(link);
    await expect(visitor.page.getByRole("heading", { name: "This page is not available" })).toBeVisible();
    await visitor.context.close();
  });
});

test("downloads a view as CSV: visible fields, the view's sort, BOM and quoting", async ({ page }) => {
  const created = await call<{ id: string; config: Record<string, unknown> }>(page.request, "post", `/api/tables/${fx.tableId}/views`, { name: "Export me", type: "grid", config: null });
  await call(page.request, "patch", `/api/views/${created.id}`, { config: { ...created.config, hidden_fields: [fx.fields.salary], sorts: [{ field_id: fx.fields.qty, direction: "desc" }] } });
  await openView(page, created.id);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("Export me.csv");
  const text = await readFile((await download.path())!, "utf8");
  expect(text.startsWith("﻿")).toBe(true);
  const lines = text.slice(1).split("\r\n").filter(Boolean);
  expect(lines[0]).toBe("Name,Notes,Qty,Status");
  expect(text).not.toContain("SECRET-");
  // Sorted by quantity, descending: the visitor's record from the form test (9), Bravo (8), Charlie (5), Alpha (3).
  const order = lines.slice(1).map((l) => l.split(",")[0]);
  expect(order).toEqual(["Zed Visitor", "Bravo", "Charlie", "Alpha"]);
});

test("imports a CSV into a new table, then into an existing one, and reports bad rows without writing", async ({ page, diagnostics }) => {
  test.setTimeout(120_000);
  // The server refuses the bad file with a 422 on purpose; Chrome logs every 4xx fetch.
  diagnostics.allow(/status of 422.*import\)$/);
  let newTableId = "";

  await test.step("New table from CSV: name from the file, preview, types inferred", async () => {
    await openView(page);
    await page.getByRole("button", { name: "Add table" }).click();
    await page.getByRole("menuitem", { name: /New table from CSV/ }).click();
    const dialog = page.getByRole("dialog", { name: "New table from CSV" });
    await dialog.getByLabel("CSV file").setInputFiles({ name: "Customers 2026.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Age,Joined,Active\nAnn,30,2024-01-05,yes\nBob,41,2023-12-31,no\nCyd,29,2022-06-30,yes\n") });
    await expect(dialog.getByLabel("Table name")).toHaveValue("Customers 2026");
    await expect(dialog.getByRole("region", { name: "Preview" }).getByText("Bob")).toBeVisible();
    await dialog.getByRole("button", { name: "Create table" }).click();
    await expect(page).not.toHaveURL(new RegExp(fx.tableId));
    newTableId = new URL(page.url()).pathname.split("/")[3]!;
    await expect(page.getByRole("link", { name: "Customers 2026" })).toBeVisible();
    const t = await table(page.request, newTableId);
    expect(t.fields.map((f) => [f.name, f.type])).toEqual(expect.arrayContaining([["Age", "number"], ["Joined", "date"], ["Active", "checkbox"]]));
    expect((await records(page.request, t.views[0]!.id)).total).toBe(3);
  });

  await test.step("Import CSV into an existing table: columns are matched, one is skipped", async () => {
    await openView(page);
    await page.getByRole("button", { name: `Table options for ${fx.tableName}` }).click();
    await page.getByRole("menuitem", { name: /Import CSV/ }).click();
    const dialog = page.getByRole("dialog", { name: `Import CSV into ${fx.tableName}` });
    await dialog.getByLabel("CSV file").setInputFiles({ name: "more.csv", mimeType: "text/csv", buffer: Buffer.from("Name;Qty;Comment\nDelta;12;hi\nEcho;4;there\n") });
    const mapping = dialog.getByRole("region", { name: "Column mapping" });
    await expect(mapping.getByLabel("Field for Name")).toHaveValue(fx.fields.name);
    await expect(mapping.getByLabel("Field for Qty")).toHaveValue(fx.fields.qty);
    await expect(mapping.getByLabel("Field for Comment")).toHaveValue("");
    await mapping.getByLabel("Field for Comment").selectOption({ label: "Notes" });
    await dialog.getByRole("button", { name: "Import 3 columns" }).click();
    await expect(dialog.getByText("Imported 2 records")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    const delta = (await records(page.request, fx.viewId, "Delta")).records[0]!;
    expect(delta.values[fx.fields.qty]).toBe(12);
    await expect(page.getByText(/\d+ records/)).toBeVisible();
  });

  await test.step("a file with a bad row is refused as a whole, with the row numbers", async () => {
    const before = (await records(page.request, fx.viewId)).total;
    await page.getByRole("button", { name: `Table options for ${fx.tableName}` }).click();
    await page.getByRole("menuitem", { name: /Import CSV/ }).click();
    const dialog = page.getByRole("dialog", { name: `Import CSV into ${fx.tableName}` });
    await dialog.getByLabel("CSV file").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Qty\nFine,1\nBroken,not a number\nNegative,-5\n") });
    await dialog.getByRole("button", { name: /^Import \d+ column/ }).click();
    await expect(dialog.getByText("Nothing was imported.")).toBeVisible();
    const problems = dialog.getByRole("list", { name: "Problem rows" });
    await expect(problems.getByRole("listitem")).toHaveCount(2);
    await expect(problems).toContainText("Row 3");
    await expect(problems).toContainText("Row 4");
    expect((await records(page.request, fx.viewId)).total).toBe(before);
    await page.keyboard.press("Escape");
  });

  await test.step("a file over 20 MB is refused on the spot", async () => {
    await page.getByRole("button", { name: `Table options for ${fx.tableName}` }).click();
    await page.getByRole("menuitem", { name: /Import CSV/ }).click();
    const dialog = page.getByRole("dialog", { name: `Import CSV into ${fx.tableName}` });
    const big = Buffer.alloc(20 * 1024 * 1024 + 10, "a");
    await dialog.getByLabel("CSV file").setInputFiles({ name: "huge.csv", mimeType: "text/csv", buffer: big });
    await expect(dialog.getByText(/the limit is 20 MB/)).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Column mapping" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test("a viewer can filter and sort a board for themselves; the view stays as it was", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const board = await call<{ id: string; config: Record<string, unknown> }>(page.request, "post", `/api/tables/${fx.tableId}/views`, {
    name: "Board",
    type: "kanban",
    config: null,
  });
  await call(page.request, "patch", `/api/views/${board.id}`, { config: { ...board.config, kanban: { ...(board.config["kanban"] as object), stack_field_id: fx.fields.status } } });

  // A second person joins the base as a viewer through an invite link.
  const invite = await call<{ url: string }>(page.request, "post", `/api/bases/${fx.baseId}/invites`, { role: "viewer", email: null });
  const guest = await newClientContext(browser, testInfo, { baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 1360, height: 860 } }, "guest");
  const g = await guest.newPage();
  const email = `viewer-${Date.now()}@example.com`;
  const signup = await g.request.post("/api/auth/signup", { data: { email, name: "Viewer Vera", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const accept = await g.request.post(`/api/invites/by-token/${invite.url.split("/invite/")[1]}/accept`, { data: {}, headers: CSRF });
  expect(accept.ok(), await accept.text()).toBeTruthy();

  await g.goto(`/base/${fx.baseId}/${fx.tableId}/${board.id}`);
  await expect(g.getByRole("listitem", { name: "Stack: Todo" })).toBeVisible();
  await expect(g.getByRole("button", { name: "Share view" })).toHaveCount(0);

  // Sort and filter locally: the marker appears, the saved view does not change.
  await g.getByRole("button", { name: /^Sort/ }).click();
  await g.getByRole("button", { name: "Add sort" }).click();
  await g.keyboard.press("Escape");
  await expect(g.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  await g.getByRole("button", { name: /^Filter/ }).click();
  await g.getByRole("button", { name: "Add condition", exact: true }).click();
  await g.getByLabel("Operator").selectOption("contains");
  await g.getByLabel("Value").fill("Alp");
  await g.keyboard.press("Escape");
  await expect(g.getByRole("button", { name: "Alpha" })).toBeVisible();
  await expect(g.getByRole("button", { name: "Bravo" })).toHaveCount(0);

  const saved = (await table(page.request)).views.find((v) => v.id === board.id)! as unknown as { config: { filter: unknown; sorts: unknown[] } };
  expect(saved.config.filter ?? null).toBeNull();
  expect(saved.config.sorts).toEqual([]);

  await g.getByRole("button", { name: "Reset" }).click();
  await expect(g.getByRole("button", { name: "Bravo" })).toBeVisible();
  await expect(g.getByRole("status").filter({ hasText: "Not saved" })).toHaveCount(0);
  await guest.close();
});
