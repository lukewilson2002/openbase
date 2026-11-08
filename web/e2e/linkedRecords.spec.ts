import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * The link picker and the linked-record peek (FLD-5, REC-9) against a live server: the hover preview with Open
 * page, the picker's pop-over on a desktop, and its bottom sheet on a phone. Runs only with OPENBASE_E2E=1 (see
 * playwright.config.ts: the stack is built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=linked-records --no-deps
 *
 * It signs up its own user. Results are asserted against the server (the records API), not against pixels.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-linked@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Fixture {
  baseId: string;
  tasksId: string;
  ownerField: string;
  people: { ada: string; grace: string; linus: string };
  tasks: { ship: string; plan: string };
}

let fx: Fixture;
/** The signed-in session, added to every test's fresh browser context. */
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type TableDto = { id: string; fields: { id: string; name: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const signup = await req.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Linked", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await req.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(req);
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E linked ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Linked E2E" });
  const tasks = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Tasks" }));
  const people = await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "People" });
  const email = await call<{ id: string }>(req, "post", `/api/tables/${people.id}/fields`, { name: "Email", type: "email", options: {} });
  const owner = await call<{ id: string }>(req, "post", `/api/tables/${tasks.id}/fields`, { name: "Owner", type: "link", options: { linked_table_id: people.id, single: false } });
  const made = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${people.id}/records`, {
    typecast: true,
    records: [
      { values: { [people.fields[0]!.id]: "Ada Lovelace", [email.id]: "ada@example.com" } },
      { values: { [people.fields[0]!.id]: "Grace Hopper", [email.id]: "grace@example.com" } },
      { values: { [people.fields[0]!.id]: "Linus Torvalds", [email.id]: "linus@example.com" } },
    ],
  });
  const [ada, grace, linus] = made.records.map((r) => r.id) as [string, string, string];
  const t = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${tasks.id}/records`, {
    typecast: true,
    records: [{ values: { [tasks.fields[0]!.id]: "Ship it", [owner.id]: [ada] } }, { values: { [tasks.fields[0]!.id]: "Plan it", [owner.id]: [ada] } }],
  });
  return { baseId: base.id, tasksId: tasks.id, ownerField: owner.id, people: { ada, grace, linus }, tasks: { ship: t.records[0]!.id, plan: t.records[1]!.id } };
}

/** The Owner property's linked record ids as the server has them. */
async function owners(page: Page, recordId: string): Promise<string[]> {
  const rec = await call<{ values: Record<string, unknown> }>(page.request, "get", `/api/tables/${fx.tasksId}/records/${recordId}`);
  return ((rec.values[fx.ownerField] ?? []) as ({ id: string } | string)[]).map((r) => (typeof r === "string" ? r : r.id));
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

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1360, height: 820 } });

  test("hovering a linked record shows its details, and Open page goes to its page", async ({ page }) => {
    await page.goto(recordUrl(fx.tasks.ship));
    const card = page.locator(`[data-linked-record="${fx.people.ada}"]`);
    await expect(card).toBeVisible();
    await card.hover();
    const peek = page.locator("[data-record-peek]");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("Ada Lovelace");
    await expect(peek).toContainText("People");
    // Every property it has a value for, in the collection's grid order (the inverse link comes after the email).
    await expect(peek.getByRole("term").first()).toHaveText("Email");
    await expect(peek).toContainText("ada@example.com");
    // Open page is a link to the record's own page (it opens in a new tab with a modified click), and a plain click follows it.
    const open = peek.getByRole("link", { name: /Open page/ });
    await expect(open).toHaveAttribute("href", new RegExp(`/r/${fx.people.ada}$`));
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/r/${fx.people.ada}$`));
    await expect(page.getByRole("main", { name: "Record" }).getByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeVisible();
  });

  test("the picker is a pop-over: search, pick with Enter, Done, and the card's x unlinks", async ({ page }) => {
    await page.goto(recordUrl(fx.tasks.plan));
    const card = page.locator(`[data-linked-record="${fx.people.ada}"]`);
    await expect(card).toBeVisible();
    // A click on the card edits the property: the search is focused and picked records are not offered again.
    await card.click({ position: { x: 4, y: 4 } });
    const search = page.getByRole("combobox", { name: "Search Owner" });
    await expect(search).toBeFocused();
    const list = page.getByRole("listbox", { name: "Records" });
    await expect(list.getByRole("option", { name: /Ada Lovelace/ })).toHaveCount(0);
    await search.fill("grace");
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option", { name: /Grace Hopper/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(`[data-linked-record="${fx.people.grace}"]`)).toBeVisible();
    await expect.poll(() => owners(page, fx.tasks.plan)).toEqual([fx.people.ada, fx.people.grace]);
    await page.getByRole("button", { name: "Remove Ada Lovelace" }).click();
    await expect.poll(() => owners(page, fx.tasks.plan)).toEqual([fx.people.grace]);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the picker is a bottom sheet with the search at the top, and Done closes it", async ({ page }) => {
    await page.goto(recordUrl(fx.tasks.ship));
    const card = page.locator(`[data-linked-record="${fx.people.ada}"]`);
    await expect(card).toBeVisible();
    await card.tap({ position: { x: 4, y: 4 } });
    const sheet = page.getByRole("dialog", { name: "Owner" });
    await expect(sheet).toBeVisible();
    // It opens with the keyboard down: the list is there to be read first.
    await expect(sheet.getByRole("combobox", { name: "Search Owner" })).not.toBeFocused();
    const option = sheet.getByRole("option", { name: /Linus Torvalds/ });
    await expect(option).toBeVisible();
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await option.tap();
    await sheet.getByRole("button", { name: "Done" }).tap();
    await expect(sheet).toBeHidden();
    await expect.poll(() => owners(page, fx.tasks.ship)).toEqual([fx.people.ada, fx.people.linus]);
    // No horizontal page scroll with the cards on screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
