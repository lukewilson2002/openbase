import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * The embeds of a record's Page (REC-6) against a live server: Linked records and View come alive as tables on
 * the page of a signed-in person, "+ Link" adds a link, Open leaves a draft filter on the inverse link, and a reader
 * who cannot open the view gets "You can't open this view" and no request for its records. Runs only with
 * OPENBASE_E2E=1 (see playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=page-embeds --no-deps
 *
 * It signs up its own users.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-embeds@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };
const BASE_URL = process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080";

interface Fixture {
  baseId: string;
  clientsId: string;
  invoicesId: string;
  pageField: string;
  linkField: string;
  inverseField: string;
  /** The saved view of the invoices, in this folder. */
  overdueView: string;
  invoicesDefaultView: string;
  /** A saved view in a folder the limited person cannot open, and a personal view of the owner. */
  payrollView: string;
  mineView: string;
  /** Clients: Harper & Co (two invoices), and two more for the tests that write. */
  clients: string[];
  invoices: string[];
  limited: Cookie[];
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get" | "put", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type TableDto = { id: string; primary_field_id: string; body_field_id: string | null; views: { id: string }[]; fields: { id: string; name: string }[] };

async function signUp(req: APIRequestContext, email: string, name: string) {
  const signup = await req.post("/api/auth/signup", { data: { email, name, password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
}

const embed = (body: string) => `\`\`\`openbase\n${body}\n\`\`\``;

test.beforeAll(async ({ browser }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }, "seed");
  const req = ctx.request;
  await signUp(req, EMAIL, "E2E Embeds");
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E embeds ${Date.now()}` });
  const folder = await call<{ id: string }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Clients folder", empty: true });
  const clients = await call<TableDto>(req, "post", `/api/bases/${folder.id}/tables`, { name: "Clients" });
  const invoices = await call<TableDto>(req, "post", `/api/bases/${folder.id}/tables`, { name: "Invoices" });
  await call(req, "patch", `/api/tables/${clients.id}`, { record_noun: "client" });
  await call(req, "patch", `/api/tables/${invoices.id}`, { record_noun: "invoice" });
  const amount = await call<{ id: string }>(req, "post", `/api/tables/${invoices.id}/fields`, { name: "Amount", type: "currency", options: { symbol: "$", precision: 2 } });
  await call(req, "post", `/api/tables/${invoices.id}/fields`, { name: "Status", type: "text", options: { multiline: false } });
  const link = await call<{ id: string; inverse?: { id: string } }>(req, "post", `/api/tables/${clients.id}/fields`, { name: "Invoices", type: "link", options: { linked_table_id: invoices.id, single: false } });
  const overdue = await call<{ id: string }>(req, "post", `/api/tables/${invoices.id}/views`, { name: "Overdue", type: "grid" });
  const mine = await call<{ id: string }>(req, "post", `/api/tables/${invoices.id}/views`, { name: "Only mine", type: "grid", personal: true });
  const schema = await call<{ tables: TableDto[] }>(req, "get", `/api/bases/${folder.id}`);
  const clientsDto = schema.tables.find((t) => t.id === clients.id)!;
  const invoicesDto = schema.tables.find((t) => t.id === invoices.id)!;
  const inverse = invoicesDto.fields.find((f) => f.name === "Clients")?.id ?? link.inverse?.id;
  expect(inverse, "the link has an inverse property").toBeTruthy();
  const inv = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${invoices.id}/records`, {
    typecast: true,
    records: [
      { values: { [invoices.primary_field_id]: "INV-1", [amount.id]: 600 } },
      { values: { [invoices.primary_field_id]: "INV-2", [amount.id]: 120 } },
      { values: { [invoices.primary_field_id]: "INV-3", [amount.id]: 99 } },
    ],
  });
  const cl = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${clients.id}/records`, {
    typecast: true,
    records: ["Harper & Co", "Brightwater Ltd", "Cormorant Ltd", "Delphi Ltd", "Ember Ltd"].map((name) => ({ values: { [clients.primary_field_id]: name } })),
  });
  await call(req, "patch", `/api/tables/${clients.id}/records`, { records: [{ id: cl.records[0]!.id, values: { [link.id]: [inv.records[0]!.id, inv.records[1]!.id] } }] });
  // A folder the limited person is not in, with a saved view of salaries.
  const payroll = await call<{ id: string }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Payroll", empty: true });
  const salaries = await call<TableDto>(req, "post", `/api/bases/${payroll.id}/tables`, { name: "Salaries" });
  await call(req, "post", `/api/tables/${salaries.id}/records`, { typecast: true, records: [{ values: { [salaries.primary_field_id]: "Zelda Zoltan 120000" } }] });
  const payrollView = await call<{ id: string }>(req, "post", `/api/tables/${salaries.id}/views`, { name: "Everyone's pay", type: "grid" });
  // A person limited to the Clients folder.
  const invite = await call<{ url: string }>(req, "post", `/api/bases/${folder.id}/invites`, { role: "editor", email: null });
  const limitedCtx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }, "limited");
  await signUp(limitedCtx.request, `e2e-embeds-limited-${Date.now()}@example.com`, "Limited Person");
  const accept = await limitedCtx.request.post(`/api/invites/by-token/${invite.url.split("/invite/")[1]}/accept`, { data: {}, headers: CSRF });
  expect(accept.ok(), await accept.text()).toBeTruthy();
  fx = {
    baseId: folder.id,
    clientsId: clients.id,
    invoicesId: invoices.id,
    pageField: clientsDto.body_field_id!,
    linkField: link.id,
    inverseField: inverse!,
    overdueView: overdue.id,
    invoicesDefaultView: invoicesDto.views[0]!.id,
    payrollView: payrollView.id,
    mineView: mine.id,
    clients: cl.records.map((r) => r.id),
    invoices: inv.records.map((r) => r.id),
    limited: await limitedCtx.cookies(),
  };
  session = await ctx.cookies();
  await limitedCtx.close();
  await ctx.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

const recordUrl = (recordId: string) => `/base/${fx.baseId}/${fx.clientsId}/r/${recordId}`;
const pageText = async (page: Page, recordId: string) => {
  const rec = await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${fx.clientsId}/records/${recordId}`);
  return (rec.values[fx.pageField] as string | undefined) ?? "";
};
const writePage = (page: Page, recordId: string, text: string) => call(page.request, "patch", `/api/tables/${fx.clientsId}/records`, { records: [{ id: recordId, values: { [fx.pageField]: text } }] });

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } });

  test("Linked records is a table of the links, and Open leaves a draft filter on the inverse link", async ({ page }) => {
    await writePage(page, fx.clients[0]!, `Billing\n\n${embed(`{"embed":"linked","field":"${fx.linkField}"}`)}`);
    await page.goto(recordUrl(fx.clients[0]!));
    const box = page.getByRole("region", { name: "Invoices · linked to this client, 2" });
    await expect(box).toBeVisible();
    await expect(box.getByRole("columnheader")).toHaveText(["Name", "Amount", "Status", "Clients"]);
    await expect(box.getByRole("row")).toHaveCount(3);
    await expect(box.getByRole("cell", { name: "$600.00" })).toBeVisible();
    await expect(box).not.toContainText(fx.linkField);
    // Open: the collection, filtered to this client, as a draft that nothing saved.
    await box.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.baseId}/${fx.invoicesId}/${fx.invoicesDefaultView}`));
    await expect(page.getByRole("heading", { level: 1, name: "Invoices" })).toBeVisible();
    await expect(page.getByText("Showing 2 of 3")).toBeVisible();
    const view = await call<{ tables: { id: string; views: { id: string; config: { filter: unknown } }[] }[] }>(page.request, "get", `/api/bases/${fx.baseId}`);
    const saved = view.tables.find((t) => t.id === fx.invoicesId)!.views.find((v) => v.id === fx.invoicesDefaultView)!;
    expect(saved.config.filter ?? null).toBeNull();
  });

  test("a row opens the record's page", async ({ page }) => {
    await page.goto(recordUrl(fx.clients[0]!));
    await page.getByRole("region", { name: /^Invoices · linked/ }).getByRole("link", { name: "INV-2" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.baseId}/${fx.invoicesId}/r/${fx.invoices[1]!}$`));
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(/INV-2/);
  });

  test("+ Link adds a link and the table shows it", async ({ page }) => {
    await page.goto(recordUrl(fx.clients[0]!));
    const box = page.getByRole("region", { name: /^Invoices · linked/ });
    await box.getByRole("button", { name: "Link a record to Invoices" }).click();
    await page.getByRole("combobox", { name: "Search Invoices" }).fill("INV-3");
    await page.getByRole("option", { name: /INV-3/ }).click();
    await expect(page.getByRole("region", { name: "Invoices · linked to this client, 3" })).toBeVisible();
    await expect.poll(async () => {
      const rec = await call<{ values: Record<string, { id: string }[]> }>(page.request, "get", `/api/tables/${fx.clientsId}/records/${fx.clients[0]!}`);
      return (rec.values[fx.linkField] ?? []).map((r) => r.id).sort();
    }).toEqual([...fx.invoices].sort());
  });

  test("View shows the first records of a saved view, read-only, with Open view", async ({ page }) => {
    await writePage(page, fx.clients[1]!, embed(`{"embed":"view","view":"${fx.overdueView}","limit":2}`));
    await page.goto(recordUrl(fx.clients[1]!));
    const box = page.getByRole("region", { name: "Overdue · 3 invoices" });
    await expect(box).toBeVisible();
    await expect(box.getByRole("row")).toHaveCount(3);
    await expect(box.getByText("Showing 2 of 3")).toBeVisible();
    await expect(box.getByRole("textbox")).toHaveCount(0);
    await box.getByRole("link", { name: "Open view" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.baseId}/${fx.invoicesId}/${fx.overdueView}$`));
  });

  test("the block menu inserts a View block of a saved view of the workspace", async ({ page }) => {
    await page.goto(recordUrl(fx.clients[2]!));
    await page.getByRole("textbox", { name: "Page" }).click();
    await page.keyboard.type("/view");
    await page.keyboard.press("Enter");
    const list = page.getByRole("listbox", { name: "View to show" });
    await expect(list.getByRole("option", { name: /Overdue/ })).toBeVisible();
    // Another person's personal view is never offered, and neither is a collection's default grid.
    await expect(list.getByRole("option", { name: /Only mine/ })).toHaveCount(0);
    await expect(list.getByRole("option", { name: /Everyone's pay/ })).toBeVisible();
    await list.getByRole("option", { name: /Overdue/ }).click();
    await expect.poll(() => pageText(page, fx.clients[2]!), { timeout: 5_000 }).toBe(embed(`{"embed":"view","view":"${fx.overdueView}","limit":10}`));
    await expect(page.getByRole("region", { name: /^Overdue/ })).toBeVisible();
  });

  test("a block that does not read stays as written and says it cannot be shown", async ({ page }) => {
    const bad = embed(`{"embed":"linked","field":"${fx.linkField}","extra":true}`);
    await writePage(page, fx.clients[3]!, `${bad}\n\nAfter it`);
    await page.goto(recordUrl(fx.clients[3]!));
    // In the editor the block stays the code it is, with the words over it (drawn by CSS from `data-note`).
    const block = page.locator("pre.ob-embed-code");
    await expect(block).toHaveAttribute("data-note", "This embed can't be shown");
    await expect(block).toContainText('"extra":true');
    await page.getByRole("textbox", { name: "Page" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" and more");
    await expect.poll(() => pageText(page, fx.clients[3]!), { timeout: 5_000 }).toBe(`${bad}\n\nAfter it and more`);
  });

  test("a reader who cannot open the view sees You can't open this view, and nothing is asked for", async ({ browser }, testInfo) => {
    await writeAs(browser, testInfo, fx.clients[4]!, `${embed(`{"embed":"view","view":"${fx.payrollView}"}`)}\n\n${embed(`{"embed":"view","view":"${fx.mineView}"}`)}`);
    const ctx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, viewport: { width: 1360, height: 900 }, storageState: { cookies: [], origins: [] } }, "reader");
    await ctx.addCookies(fx.limited);
    const page = await ctx.newPage();
    const asked: string[] = [];
    page.on("request", (r) => asked.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.goto(recordUrl(fx.clients[4]!));
    await expect(page.getByText("You can't open this view")).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Page" })).not.toContainText(/Zelda|120000|Everyone's pay|Payroll|Salaries|Only mine/);
    expect(asked.filter((a) => a.includes(fx.payrollView) || a.includes(fx.mineView))).toEqual([]);
    // The server says the same to whoever asks directly.
    const direct = await ctx.request.post(`/api/views/${fx.payrollView}/query`, { data: { limit: 10 }, headers: CSRF });
    expect(direct.status()).toBe(404);
    expect(await direct.text()).not.toMatch(/Zelda|120000|Everyone's pay|Payroll/);
    await ctx.close();
  });
});

/** Writes a record's page as the owner, from a context of its own (the limited reader has the browser). */
async function writeAs(browser: import("@playwright/test").Browser, testInfo: import("@playwright/test").TestInfo, recordId: string, text: string) {
  const ctx = await newClientContext(browser, testInfo, { baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }, "writer");
  await ctx.addCookies(session);
  await call(ctx.request, "patch", `/api/tables/${fx.clientsId}/records`, { records: [{ id: recordId, values: { [fx.pageField]: text } }] });
  await ctx.close();
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an embed scrolls sideways in its own box and the page does not", async ({ page }) => {
    await writePage(page, fx.clients[0]!, `${embed(`{"embed":"linked","field":"${fx.linkField}"}`)}\n\n${embed(`{"embed":"view","view":"${fx.overdueView}"}`)}`);
    await page.goto(recordUrl(fx.clients[0]!));
    const box = page.getByRole("region", { name: /^Invoices · linked/ });
    await expect(box).toBeVisible();
    await expect(page.getByRole("region", { name: /^Overdue/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Rows and links are 44 px targets.
    for (const link of await box.locator("td:first-child a").all()) expect((await link.boundingBox())!.height, (await link.textContent()) ?? "").toBeGreaterThanOrEqual(44);
    const add = box.getByRole("button", { name: "Link a record to Invoices" });
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The picker is a sheet on a phone.
    await add.tap();
    await expect(page.getByRole("dialog", { name: "Invoices" })).toBeVisible();
  });
});
