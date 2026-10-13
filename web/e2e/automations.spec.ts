import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, hoverAt, gridFocused, test, typeToEdit } from "./fixtures";

/**
 * The automations journey against a live server: build "when a record is created in Table 1,
 * create a record in Table 2 with Name = {{trigger.record.fields.Name}}" in the editor, turn it on,
 * add a record in the grid, and check through the API and the Runs tab that it ran and that the
 * record exists. Then run it for real from the Test panel against the named record and check
 * that the template produced that name.
 *
 *   OPENGRID_E2E=1 npm run e2e -- --project=automations --no-deps
 *
 * It signs up its own user. Results are asserted against the API, not pixels.
 */
test.skip(!process.env["OPENGRID_E2E"], "set OPENGRID_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENGRID_E2E_EMAIL"] ?? "e2e-automations@example.com";
const PASSWORD = process.env["OPENGRID_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenGrid-CSRF": "1" };

// Grid geometry (see grid.spec.ts): the Name column of a fresh table starts after the row marker.
const MARKER_W = 56;
const NAME_W = 220;
const HEADER_H = 34;
const ROW_H = 33;

interface Fixture {
  baseId: string;
  table1: { id: string; viewId: string; nameId: string };
  table2: { id: string; viewId: string; nameId: string };
}

type TableDto = { id: string; fields: { id: string; name: string }[]; views: { id: string }[] };

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "get", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function signIn(page: Page): Promise<void> {
  const signup = await page.request.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Automations", password: PASSWORD }, headers: CSRF });
  if (signup.ok()) return;
  const login = await page.request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
  expect(login.ok(), `login failed (${login.status()}): set OPENGRID_E2E_EMAIL/OPENGRID_E2E_PASSWORD`).toBeTruthy();
}

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E automations ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Automations E2E" });
  const t1 = base.tables[0]!;
  const t2 = await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Table 2" });
  const describe = (t: TableDto) => ({ id: t.id, viewId: t.views[0]!.id, nameId: t.fields.find((f) => f.name === "Name")!.id });
  return { baseId: base.id, table1: describe(t1), table2: describe(t2) };
}

/** Names of the records of a table, as the server has them. */
async function names(page: Page, table: Fixture["table1"]): Promise<string[]> {
  const res = await page.request.post(`/api/views/${table.viewId}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
  const body = (await res.json()) as { records: { values: Record<string, unknown> }[] };
  return body.records.map((r) => String(r.values[table.nameId] ?? ""));
}

interface RunDto {
  id: number;
  status: string;
  trigger_data: { type: string; test?: boolean };
  log: { action: string; status: string }[];
}

async function runs(page: Page, automationId: string): Promise<RunDto[]> {
  const res = await page.request.get(`/api/automations/${automationId}/runs?limit=50`, { headers: CSRF });
  return ((await res.json()) as { runs: RunDto[] }).runs;
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: process.env["OPENGRID_E2E_URL"] ?? "http://127.0.0.1:8080" });
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

test("builds, enables and runs an automation from a grid edit, and shows the runs", async ({ page, diagnostics }) => {
  // Turning an automation on without actions is refused with a 400 on purpose; Chrome logs every 4xx fetch.
  diagnostics.allow(/Failed to load resource: the server responded with a status of 400/);
  let automationId = "";

  await test.step("opens Automations from the top bar and sees the empty state", async () => {
    await page.goto(`/base/${fx.baseId}`);
    await expect(page.getByRole("toolbar", { name: "View toolbar" })).toBeVisible();
    await page.getByRole("link", { name: "Automations" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.baseId}/automations$`));
    await expect(page.getByText("No automations yet")).toBeVisible();
    await expect(page.getByText("docs/automations.md").first()).toBeVisible();
  });

  await test.step("creates the automation: when a record is created in Table 1", async () => {
    await page.getByRole("button", { name: "New automation" }).click();
    const dialog = page.getByRole("dialog", { name: "New automation" });
    await dialog.getByLabel("Name").fill("Copy new records to Table 2");
    await expect(dialog.getByLabel("When this happens")).toHaveValue("record_created");
    await dialog.getByRole("button", { name: "Create automation" }).click();
    await expect(page).toHaveURL(new RegExp(`/automations/aut\\w+$`));
    automationId = page.url().split("/").pop()!;
    await expect(page.getByLabel("Table", { exact: true })).toHaveValue(fx.table1.id);
    const stored = await call<{ enabled: boolean; trigger: unknown; actions: unknown[] }>(page.request, "get", `/api/automations/${automationId}`);
    expect(stored).toMatchObject({ enabled: false, trigger: { type: "record_created", table_id: fx.table1.id }, actions: [] });
  });

  await test.step("turning it on without an action is refused with the server's reason", async () => {
    await page.getByRole("switch", { name: "Off" }).click();
    await expect(page.getByText("Could not turn the automation on")).toBeVisible();
    await expect(page.getByText(/add at least one action/)).toBeVisible();
  });

  await test.step("adds a Create record action into Table 2 with Name = the trigger record's Name", async () => {
    await page.getByRole("button", { name: "Add action" }).click();
    await page.getByRole("menuitem", { name: /Create record/ }).click();
    const card = page.getByRole("listitem", { name: /^Action 1:/ });
    await card.getByLabel("Table", { exact: true }).selectOption(fx.table2.id);
    await card.getByLabel("Add a field").selectOption(fx.table2.nameId);
    // The value comes from the "Insert data" menu, so the token is the real thing.
    await card.getByRole("button", { name: "Insert data into Name" }).click();
    await page.getByRole("menuitem", { name: /^Name\s/ }).click();
    await expect(card.getByRole("textbox", { name: "Name" })).toHaveValue("{{trigger.record.fields.Name}}");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Automation saved")).toBeVisible();
    const stored = await call<{ actions: unknown[] }>(page.request, "get", `/api/automations/${automationId}`);
    expect(stored.actions).toMatchObject([{ type: "create_record", table_id: fx.table2.id, values: { [fx.table2.nameId]: "{{trigger.record.fields.Name}}" } }]);
  });

  await test.step("enables it", async () => {
    await page.getByRole("switch", { name: "Off" }).click();
    await expect(page.getByRole("switch", { name: "On" })).toBeChecked();
    await expect.poll(async () => (await call<{ enabled: boolean }>(page.request, "get", `/api/automations/${automationId}`)).enabled).toBe(true);
  });

  await test.step("adds a record in the grid", async () => {
    await page.getByRole("navigation", { name: "Tables" }).getByRole("link", { name: "Table 1" }).click();
    await expect(page.getByRole("toolbar", { name: "View toolbar" })).toBeVisible();
    await expect(page.getByText("0 records")).toBeVisible();
    await page.getByRole("button", { name: "Add record" }).click();
    await expect(page.getByText("1 record")).toBeVisible();
    // Name it, as a person would.
    const canvas = page.locator("canvas[data-testid='data-grid-canvas']").first();
    const box = (await canvas.boundingBox())!;
    const x = box.x + MARKER_W + NAME_W / 2;
    const y = box.y + HEADER_H + ROW_H / 2;
    await hoverAt(page, x, y);
    await page.mouse.click(x, y);
    await gridFocused(page);
    await typeToEdit(page, "Alpha");
    await page.keyboard.press("Enter");
    await expect.poll(async () => names(page, fx.table1)).toEqual(["Alpha"]);
  });

  await test.step("the run happened and the record exists in Table 2", async () => {
    await expect.poll(async () => (await runs(page, automationId)).map((r) => r.status), { timeout: 20_000 }).toEqual(["succeeded"]);
    const [run] = await runs(page, automationId);
    expect(run!.trigger_data.type).toBe("record_created");
    expect(run!.log.map((l) => [l.action, l.status])).toEqual([["create_record", "succeeded"]]);
    // The record was created at the moment of "Add record" (blank), then named: the copy is the blank one.
    expect(await names(page, fx.table2)).toEqual([""]);
  });

  await test.step("the Runs tab shows it, expandable to the step log", async () => {
    await page.goto(`/base/${fx.baseId}/automations/${automationId}/runs`);
    const list = page.getByRole("list", { name: "Runs" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    const row = list.getByRole("listitem").first();
    await expect(row.getByText("Succeeded")).toBeVisible();
    await expect(row.getByText("Record created")).toBeVisible();
    await row.getByRole("button").first().click();
    const step = row.getByRole("list", { name: "Step log" }).getByRole("listitem").first();
    await expect(step.getByText("Step 1: create record")).toBeVisible();
    await expect(step.getByText("Succeeded")).toBeVisible();
    // The list shows the last run's status too.
    await expect(page.getByRole("list", { name: "Automations" }).getByText("Succeeded")).toBeVisible();
  });

  await test.step("a dry run renders the template against the named record and writes nothing", async () => {
    await page.getByRole("tab", { name: "Editor" }).click();
    await page.getByRole("button", { name: "Test (dry run)" }).click();
    const result = page.getByRole("region", { name: "Test result" });
    await expect(result.getByText(/Dry run: nothing was written/)).toBeVisible();
    await result.getByText("Output").click();
    await expect(result).toContainText("Alpha");
    expect(await names(page, fx.table2)).toEqual([""]);
  });

  await test.step("a real run, after confirming, creates the record with the template's value", async () => {
    await page.getByRole("checkbox", { name: /Run for real/ }).click();
    await page.getByRole("button", { name: "Run for real" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Run this automation for real?");
    await confirm.getByRole("button", { name: "Run for real" }).click();
    await expect(page.getByText(/Real run, recorded as run #/)).toBeVisible();
    await expect.poll(async () => (await names(page, fx.table2)).sort()).toEqual(["", "Alpha"]);
    const history = await runs(page, automationId);
    expect(history).toHaveLength(2);
    expect(history[0]!.trigger_data.test).toBe(true);
  });

  await test.step("the Runs tab lists both, the newest flagged as a test", async () => {
    await page.getByRole("tab", { name: "Runs" }).click();
    const rows = page.getByRole("list", { name: "Runs" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByText("test", { exact: true })).toBeVisible();
  });
});
