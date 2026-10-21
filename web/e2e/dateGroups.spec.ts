import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * Grouping by a date with a granularity: the Group tool's Day / Week / Month / Quarter / Year picker,
 * the list view's group headers in chronological order with a "No date" group last or first, and the
 * same groups in a grid's query. Runs only with OPENBASE_E2E=1 (see playwright.config.ts):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=date-groups --no-deps
 *
 * It signs up its own user and makes its own base.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-date-groups@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Fixture {
  baseId: string;
  tableId: string;
  due: string;
  list: string;
  grid: string;
}

let fx: Fixture;
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

type TableDto = { id: string; fields: { id: string; name: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Date groups", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E date groups ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Date groups" });
  const table = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Tasks" }));
  const name = table.fields[0]!.id;
  const due = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/fields`, {
    name: "Due",
    type: "date",
    options: { include_time: false, date_format: "us", time_format: "h12", timezone: null },
  });
  const rows = [
    { [name]: "Plan", [due.id]: "2026-09-30" },
    { [name]: "Build", [due.id]: "2026-10-02" },
    { [name]: "Ship", [due.id]: "2026-10-21" },
    { [name]: "Celebrate", [due.id]: "2027-01-15" },
    { [name]: "Someday" },
  ];
  await call(req, "post", `/api/tables/${table.id}/records`, { records: rows.map((values) => ({ values })) });
  const mk = async (type: string, viewName: string) =>
    (await call<{ id: string }>(req, "post", `/api/tables/${table.id}/views`, { name: viewName, type, config: { groups: [{ field_id: due.id, direction: "asc" }] } })).id;
  return { baseId: base.id, tableId: table.id, due: due.id, list: await mk("list", "Outline"), grid: await mk("grid", "By date") };
}

/** The group headers of the list view, top to bottom. */
async function headers(page: Page): Promise<string[]> {
  const buttons = page.getByRole("tree", { name: "Grouped records" }).getByRole("treeitem").getByRole("button");
  return (await buttons.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).map((l) => l.replace(/^(Collapse|Expand) /, ""));
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

test.use({ viewport: { width: 1360, height: 820 } });

test("the list groups by day, then by month and year from the Group tool", async ({ page }) => {
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.list}`);
  await expect(page.getByRole("tree", { name: "Grouped records" })).toBeVisible();
  await expect.poll(() => headers(page)).toEqual(["No date", "September 30, 2026", "October 2, 2026", "October 21, 2026", "January 15, 2027"]);

  await page.getByRole("button", { name: /^Grouped by Due/ }).click();
  const pick = page.getByRole("combobox", { name: "Granularity for group 1" });
  await expect(pick).toHaveValue("day");
  await pick.selectOption("month");
  await expect.poll(() => headers(page)).toEqual(["No date", "September 2026", "October 2026", "January 2027"]);

  // Newest first: the latest month leads and "No date" goes last.
  await page.getByRole("combobox", { name: "Direction for group 1" }).selectOption("desc");
  await expect.poll(() => headers(page)).toEqual(["January 2027", "October 2026", "September 2026", "No date"]);

  await pick.selectOption("year");
  await expect.poll(() => headers(page)).toEqual(["2027", "2026", "No date"]);
  await page.keyboard.press("Escape");

  // The choice is saved with the view.
  await page.reload();
  await expect.poll(() => headers(page)).toEqual(["2027", "2026", "No date"]);
});

test("a record added to a month group starts on the month's first day", async ({ page }) => {
  await call(page.request, "patch", `/api/views/${fx.list}`, { config: { groups: [{ field_id: fx.due, direction: "asc", granularity: "month" }] } });
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.list}`);
  await page.getByRole("button", { name: "Add record to October 2026" }).click();
  await expect(page).toHaveURL(/record=rec/);
  const id = new URL(page.url()).searchParams.get("record")!;
  const rec = await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${fx.tableId}/records/${id}`);
  expect(rec.values[fx.due]).toBe("2026-10-01");
  await call(page.request, "delete", `/api/tables/${fx.tableId}/records`, { ids: [id] });
});

test("a grid's Group tool offers the granularity and its groups follow it", async ({ page }) => {
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.grid}`);
  await page.getByRole("button", { name: /^Grouped by Due/ }).click();
  await page.getByRole("combobox", { name: "Granularity for group 1" }).selectOption("quarter");
  await expect
    .poll(async () => {
      const res = await call<{ groups: { label: string; count: number }[] }>(page.request, "post", `/api/views/${fx.grid}/query`, { limit: 0 });
      return res.groups.map((g) => `${g.label} (${g.count})`);
    })
    .toEqual(["No date (1)", "Q3 2026 (1)", "Q4 2026 (2)", "Q1 2027 (1)"]);
});
