import type { APIRequestContext, Cookie, Page } from "@playwright/test";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * Kanban, gallery, calendar, timeline and list views, plus the trash and the notification bell,
 * against a live server. Runs only with OPENBASE_E2E=1 (see playwright.config.ts: the stack is
 * built and started for you):
 *
 *   OPENBASE_E2E=1 npm run e2e -- --project=views --no-deps
 *
 * It signs up its own user (the server started by globalSetup allows signup; on a server that does
 * not, set OPENBASE_E2E_EMAIL and OPENBASE_E2E_PASSWORD to an existing account). Results are
 * asserted against the server (the records API), not against pixels.
 *
 * The menu's tree can be put in another order (drag a row with the mouse, or Move up / Move down in its
 * "…" menu): the "menu order" tests make their own workspace, project, tables and views.
 *
 * Notifications: mentions and assignments skip their author, so the Notifications test makes an automation
 * ("record created" -> notify) tell the signed-in user about a record they create.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.describe.configure({ mode: "serial" });

const EMAIL = process.env["OPENBASE_E2E_EMAIL"] ?? "e2e-views@example.com";
const PASSWORD = process.env["OPENBASE_E2E_PASSWORD"] ?? "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Fixture {
  baseId: string;
  tableId: string;
  fields: { name: string; status: string; start: string; end: string; deps: string };
  choice: { todo: string; doing: string; done: string };
  views: { kanban: string; gallery: string; calendar: string; timeline: string; list: string };
  records: Record<"alpha" | "bravo" | "charlie" | "delta" | "echo", string>;
}

let fx: Fixture;
/** The signed-in session, added to every test's fresh browser context. */
let session: Cookie[] = [];

async function call<T>(req: APIRequestContext, method: "post" | "patch" | "get" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await req[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function signIn(page: Page): Promise<void> {
  const signup = await page.request.post("/api/auth/signup", { data: { email: EMAIL, name: "E2E Views", password: PASSWORD }, headers: CSRF });
  if (!signup.ok()) {
    const login = await page.request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD }, headers: CSRF });
    expect(login.ok(), `login failed (${login.status()}): set OPENBASE_E2E_EMAIL/OPENBASE_E2E_PASSWORD`).toBeTruthy();
  }
  await skipIntro(page.request);
}

type TableDto = { id: string; fields: { id: string; name: string }[]; views: { id: string }[] };

async function seed(page: Page): Promise<Fixture> {
  const req = page.request;
  const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E views ${Date.now()}` });
  const base = await call<{ id: string; tables: TableDto[] }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Views E2E" });
  const table = base.tables[0] ?? (await call<TableDto>(req, "post", `/api/bases/${base.id}/tables`, { name: "Projects" }));
  const name = table.fields[0]!.id;
  const status = await call<{ id: string; options: { choices: { id: string; name: string }[] } }>(req, "post", `/api/tables/${table.id}/fields`, {
    name: "Status",
    type: "single_select",
    options: { choices: ["Todo", "Doing", "Done"].map((n) => ({ id: "", name: n, color: "gray" })) },
  });
  const dateOptions = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
  const start = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/fields`, { name: "Start", type: "date", options: dateOptions });
  const end = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/fields`, { name: "End", type: "date", options: dateOptions });
  const deps = await call<{ id: string }>(req, "post", `/api/tables/${table.id}/fields`, {
    name: "Depends on",
    type: "link",
    inverse_name: "Blocks",
    options: { linked_table_id: table.id, inverse_field_id: "", single: false },
  });
  const choice = Object.fromEntries(status.options.choices.map((c) => [c.name.toLowerCase(), c.id])) as Fixture["choice"];

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const people = [
    { key: "alpha", values: { [name]: "Alpha", [status.id]: choice.todo, [start.id]: day(-2), [end.id]: day(2) } },
    { key: "bravo", values: { [name]: "Bravo", [status.id]: choice.todo, [start.id]: day(1), [end.id]: day(5) } },
    { key: "charlie", values: { [name]: "Charlie", [status.id]: choice.doing, [start.id]: day(3), [end.id]: day(6) } },
    { key: "delta", values: { [name]: "Delta", [status.id]: choice.done, [start.id]: day(4) } }, // milestone
    { key: "echo", values: { [name]: "Echo", [status.id]: choice.doing } }, // no dates: unscheduled
  ] as const;
  const created = await call<{ records: { id: string }[] }>(req, "post", `/api/tables/${table.id}/records`, { typecast: true, records: people.map((p) => ({ values: p.values })) });
  const records = Object.fromEntries(people.map((p, i) => [p.key, created.records[i]!.id])) as Fixture["records"];
  // Charlie depends on Alpha (ends before Charlie starts: fine); Bravo depends on Alpha (starts before Alpha ends: violated).
  await call(req, "patch", `/api/tables/${table.id}/records`, {
    typecast: true,
    records: [
      { id: records.charlie, values: { [deps.id]: [records.alpha] } },
      { id: records.bravo, values: { [deps.id]: [records.alpha] } },
    ],
  });

  const mk = async (type: string, nameOfView: string, config: unknown) => (await call<{ id: string }>(req, "post", `/api/tables/${table.id}/views`, { name: nameOfView, type, config })).id;
  const views = {
    kanban: await mk("kanban", "Board", { kanban: { stack_field_id: status.id } }),
    gallery: await mk("gallery", "Gallery", { gallery: { cover_crop: true } }),
    calendar: await mk("calendar", "Calendar", { calendar: { date_field_id: start.id, end_field_id: end.id } }),
    timeline: await mk("timeline", "Timeline", { timeline: { start_field_id: start.id, end_field_id: end.id, dependency_field_id: deps.id, scale: "week" } }),
    list: await mk("list", "Outline", { groups: [{ field_id: status.id, direction: "asc" }] }),
  };
  return { baseId: base.id, tableId: table.id, fields: { name, status: status.id, start: start.id, end: end.id, deps: deps.id }, choice, views, records };
}

/** The record as the server has it. */
async function record(page: Page, id: string): Promise<{ values: Record<string, unknown> }> {
  return call(page.request, "get", `/api/tables/${fx.tableId}/records/${id}`);
}

async function open(page: Page, view: keyof Fixture["views"]) {
  await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.views[view]}`);
  await expect(page.getByRole("toolbar", { name: "View toolbar" })).toBeVisible();
}

test.beforeAll(async ({ browser }, testInfo) => {
  const ctx = await newClientContext(browser, testInfo, { baseURL: process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080", storageState: { cookies: [], origins: [] } }, "seed");
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

test.describe("kanban", () => {
  test("stacks cards by status in choice order with counts", async ({ page }) => {
    await open(page, "kanban");
    const stacks = page.getByRole("listitem", { name: /^Stack:/ });
    // Every card has a status, so the empty Uncategorized stack stays out of the way.
    await expect(stacks).toHaveText([/Todo/, /Doing/, /Done/]);
    await expect(page.getByRole("listitem", { name: "Stack: Todo" }).getByRole("button", { name: /Alpha|Bravo/ })).toHaveCount(2);
  });

  test("drags a card to another stack with the pointer and saves the new status", async ({ page }) => {
    await open(page, "kanban");
    const card = page.getByRole("button", { name: "Alpha" });
    const target = page.getByRole("listitem", { name: "Stack: Doing" });
    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await record(page, fx.records.alpha)).values[fx.fields.status]).toBe(fx.choice.doing);
    await expect(target.getByRole("button", { name: "Alpha" })).toBeVisible();
  });

  test("moves a card with the keyboard (Space, arrow, Space)", async ({ page }) => {
    await open(page, "kanban");
    await page.getByRole("button", { name: "Delta" }).focus();
    // dnd-kit ignores arrow keys until it has measured the cards and announced what the picked-up card
    // is over (the overlay shows earlier than that), so wait for the announcement, then for each step to show.
    await page.keyboard.press("Space");
    await expect(page.locator("[data-drag-overlay]")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /moved over droppable area/ })).toBeAttached();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("listitem", { name: "Stack: Doing" }).getByRole("button", { name: "Delta" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect.poll(async () => (await record(page, fx.records.delta)).values[fx.fields.status]).toBe(fx.choice.doing);
  });

  test("adds a card prefilled with the stack value and opens it", async ({ page }) => {
    await open(page, "kanban");
    await page.getByRole("button", { name: "Add card to Done" }).click();
    await expect(page).toHaveURL(/record=rec/);
    await expect(page.getByRole("dialog")).toBeVisible();
    const id = new URL(page.url()).searchParams.get("record")!;
    expect((await record(page, id)).values[fx.fields.status]).toBe(fx.choice.done);
  });
});

test.describe("gallery and list", () => {
  test("the gallery shows a card per record and opens one in the expanded record", async ({ page }) => {
    await open(page, "gallery");
    await expect(page.getByRole("button", { name: "Bravo" })).toBeVisible();
    await page.getByRole("button", { name: "Bravo" }).click();
    await expect(page).toHaveURL(new RegExp(`record=${fx.records.bravo}`));
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("the list groups by status with counts and adds a record inside a group", async ({ page }) => {
    await open(page, "list");
    await expect(page.getByRole("tree", { name: "Grouped records" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /Todo/ })).toBeVisible();
    await page.getByRole("button", { name: "Add record to Todo" }).click();
    await expect(page).toHaveURL(/record=rec/);
    const id = new URL(page.url()).searchParams.get("record")!;
    expect((await record(page, id)).values[fx.fields.status]).toBe(fx.choice.todo);
  });
});

test.describe("calendar", () => {
  test("shows dated records on the month grid and lists undated ones as unscheduled", async ({ page }) => {
    await open(page, "calendar");
    await expect(page.locator(".fc-event", { hasText: "Alpha" }).first()).toBeVisible();
    // The unscheduled column is open on a desktop.
    await expect(page.getByRole("complementary", { name: "Unscheduled records" }).getByText("Echo")).toBeVisible();
  });

  test("clicking an event opens its record", async ({ page }) => {
    await open(page, "calendar");
    await page.locator(".fc-event", { hasText: "Alpha" }).first().click();
    await expect(page).toHaveURL(new RegExp(`record=${fx.records.alpha}`));
  });

  test("clicking an empty day creates a record dated that day and opens it", async ({ page }) => {
    await open(page, "calendar");
    // The last cell of the month grid is weeks past every fixture record.
    const cell = page.locator(".fc-daygrid-day").last();
    const date = await cell.getAttribute("data-date");
    await cell.locator(".fc-daygrid-day-frame").click({ position: { x: 20, y: 40 } });
    await expect(page).toHaveURL(/record=rec/);
    const id = new URL(page.url()).searchParams.get("record")!;
    expect((await record(page, id)).values[fx.fields.start]).toBe(date);
    // Delete it again: the timeline tests count the dated records.
    await call(page.request, "delete", `/api/tables/${fx.tableId}/records`, { ids: [id] });
  });

  test("dragging an unscheduled record onto a day gives it that date", async ({ page }) => {
    await open(page, "calendar");
    const item = page.getByRole("complementary", { name: "Unscheduled records" }).getByText("Echo");
    const day = page.locator(".fc-daygrid-day.fc-day-today");
    // Plain pointer moves: dragTo insists on a hit target at the cell's centre, which events may cover.
    const from = (await item.boundingBox())!;
    const to = (await day.boundingBox())!;
    await page.mouse.move(from.x + 10, from.y + 5);
    await page.mouse.down();
    await page.mouse.move(from.x - 40, from.y + 5, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
    // "Today" is the viewer's day (profile zone, else the browser's), not necessarily the UTC date.
    const date = await day.getAttribute("data-date");
    await expect.poll(async () => (await record(page, fx.records.echo)).values[fx.fields.start]).toBe(date);
    // Unschedule Echo again: the timeline tests count the dated records.
    await call(page.request, "patch", `/api/tables/${fx.tableId}/records`, { records: [{ id: fx.records.echo, values: { [fx.fields.start]: null } }] });
  });
});

test.describe("timeline", () => {
  test("draws bars, a milestone and a red arrow for the violated dependency", async ({ page }) => {
    await open(page, "timeline");
    await expect(page.locator("[data-bar]")).toHaveCount(4); // Echo has no dates
    await expect(page.locator("[data-bar][data-milestone]")).toHaveCount(1);
    await expect(page.locator("path[data-dependency='violated']")).toHaveCount(1);
    await expect(page.locator("path[data-dependency='ok']")).toHaveCount(1);
  });

  test("moves a bar a day with the keyboard and saves both dates", async ({ page }) => {
    const before = (await record(page, fx.records.charlie)).values;
    await open(page, "timeline");
    await page.getByRole("button", { name: /^Charlie, / }).focus();
    await page.keyboard.press("ArrowRight");
    const next = (iso: unknown) => new Date(Date.parse(String(iso)) + 86_400_000).toISOString().slice(0, 10);
    await expect.poll(async () => (await record(page, fx.records.charlie)).values[fx.fields.start]).toBe(next(before[fx.fields.start]));
    expect((await record(page, fx.records.charlie)).values[fx.fields.end]).toBe(next(before[fx.fields.end]));
  });

  test("switches the scale and keeps it after a reload", async ({ page }) => {
    await open(page, "timeline");
    await page.getByRole("group", { name: "Timeline scale" }).getByRole("button", { name: "Month" }).click();
    await expect.poll(async () => (await call<{ tables: { views: { id: string; config: { timeline: { scale: string } } }[] }[] }>(page.request, "get", `/api/bases/${fx.baseId}`)).tables[0]!.views.find((v) => v.id === fx.views.timeline)!.config.timeline.scale).toBe("month");
    await page.reload();
    await expect(page.getByRole("group", { name: "Timeline scale" }).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
  });

  test("lists undated records beside the chart and dates one dropped on a lane", async ({ page }) => {
    await open(page, "timeline");
    const column = page.getByRole("complementary", { name: "Unscheduled records" });
    const echo = column.getByRole("listitem").filter({ hasText: "Echo" });
    await expect(echo).toBeVisible();
    // The footer no longer counts them: the column lists them.
    await expect(page.getByText(/without a date/)).toHaveCount(0);
    const view = (await page.getByTestId("timeline-scroller").boundingBox())!;
    const lane = (await page.locator("[data-lane]").first().boundingBox())!;
    // Inside the visible chart, right of the record names, below the lane's bar.
    await echo.dragTo(page.locator("[data-lane]").first(), { targetPosition: { x: view.x - lane.x + view.width / 2, y: lane.height - 6 } });
    await expect.poll(async () => (await record(page, fx.records.echo)).values[fx.fields.start] ?? null).not.toBeNull();
    const values = (await record(page, fx.records.echo)).values;
    expect(values[fx.fields.end]).toBe(values[fx.fields.start]);
    await expect(echo).toHaveCount(0);
    // Unschedule Echo again: the timeline tests count the dated records.
    await call(page.request, "patch", `/api/tables/${fx.tableId}/records`, { records: [{ id: fx.records.echo, values: { [fx.fields.start]: null, [fx.fields.end]: null } }] });
  });

  test("drags a bar into another swim lane and saves the lane's value", async ({ page }) => {
    const lanes = (await call<{ id: string }>(page.request, "post", `/api/tables/${fx.tableId}/views`, { name: "Lanes", type: "timeline", config: { timeline: { start_field_id: fx.fields.start, end_field_id: fx.fields.end, group_field_id: fx.fields.status, scale: "week" } } })).id;
    await page.goto(`/base/${fx.baseId}/${fx.tableId}/${lanes}`);
    const bar = page.getByRole("button", { name: /^Charlie, / });
    await expect(bar).toBeVisible();
    const from = (await bar.boundingBox())!;
    const todo = (await page.locator(`[data-lane="${fx.choice.todo}"]`).boundingBox())!;
    // Near its start: the bar can run on under the Unscheduled column, depending on today's date.
    const x = from.x + 16;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, from.y + from.height / 2 - 10, { steps: 3 });
    await page.mouse.move(x, todo.y + todo.height - 12, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await record(page, fx.records.charlie)).values[fx.fields.status]).toBe(fx.choice.todo);
    // Put Charlie back and remove the view: other tests count on both.
    await call(page.request, "patch", `/api/tables/${fx.tableId}/records`, { records: [{ id: fx.records.charlie, values: { [fx.fields.status]: fx.choice.doing } }] });
    await call(page.request, "delete", `/api/views/${lanes}`);
  });

  test("creates a record by dragging across empty lane space", async ({ page }) => {
    await open(page, "timeline");
    await expect(page.locator("[data-bar]").first()).toBeVisible();
    const lane = (await page.locator("[data-lane]").first().boundingBox())!;
    // The chart opens scrolled to last week, so the lane's own left edge is off screen: aim inside the
    // visible chart just right of the record names, and below the bars.
    const view = (await page.getByTestId("timeline-scroller").boundingBox())!;
    const x = view.x + 216 + 40;
    const y = lane.y + lane.height - 8;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 100, y, { steps: 8 });
    await page.mouse.up();
    await expect(page).toHaveURL(/record=rec/);
    const id = new URL(page.url()).searchParams.get("record")!;
    const values = (await record(page, id)).values;
    expect(values[fx.fields.start]).toBeTruthy();
    expect(values[fx.fields.end]).toBeTruthy();
  });
});

test.describe("trash and notifications", () => {
  test("a deleted record shows up in the trash and Restore brings it back", async ({ page }) => {
    const doomed = (await call<{ records: { id: string }[] }>(page.request, "post", `/api/tables/${fx.tableId}/records`, { typecast: true, records: [{ values: { [fx.fields.name]: "Doomed" } }] })).records[0]!.id;
    const del = await page.request.delete(`/api/tables/${fx.tableId}/records`, { data: { ids: [doomed] }, headers: CSRF });
    expect(del.ok()).toBeTruthy();
    await page.goto(`/base/${fx.baseId}/${fx.tableId}/${fx.views.list}`);
    await page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: "Trash" }).click();
    await expect(page.getByText(/Things stay here for \d+ days/)).toBeVisible();
    const list = page.getByRole("list", { name: "Deleted items" });
    await expect(list.getByText("Doomed")).toBeVisible();
    await list.getByRole("button", { name: "Restore Doomed" }).click();
    await expect(list.getByText("Doomed")).toHaveCount(0);
    expect((await record(page, doomed)).values[fx.fields.name]).toBe("Doomed");
  });

  test("the bell shows a real notification, opens its record and marks it read", async ({ page }) => {
    // An automation's notify action is the one notification a lone user can trigger for themselves
    // (mentions and assignments skip the author).
    const me = await call<{ id: string }>(page.request, "get", "/api/auth/me");
    const zulu = `Zulu ${Date.now()}`; // notifications belong to the user, so earlier runs may have left some
    await call(page.request, "post", `/api/bases/${fx.baseId}/automations`, {
      name: "Tell me about new records",
      enabled: true,
      trigger: { type: "record_created", table_id: fx.tableId },
      actions: [{ type: "notify", user_ids: [me.id], message: "Created {{trigger.record.fields.Name}}" }],
    });
    await call(page.request, "post", `/api/tables/${fx.tableId}/records`, { typecast: true, records: [{ values: { [fx.fields.name]: zulu } }] });
    await expect
      .poll(async () => (await call<{ unread: number }>(page.request, "get", "/api/notifications")).unread, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const unreadBefore = (await call<{ unread: number }>(page.request, "get", "/api/notifications")).unread;

    await open(page, "list");
    const bell = page.getByRole("navigation", { name: "Main menu" }).getByRole("button", { name: /^Notifications, \d+ unread/ });
    await expect(bell).toBeVisible();
    await bell.click();
    const popup = page.getByRole("dialog", { name: "Notifications" });
    await expect(popup.getByText(`Created ${zulu}`)).toBeVisible();

    // Clicking it marks it read and goes to the base (an automation says which base, not which table).
    await popup.getByRole("button", { name: new RegExp(zulu) }).click();
    // The shell turns the bare base URL into the view last used there: the list view we were on.
    await expect(page).toHaveURL(new RegExp(`/base/${fx.baseId}/${fx.tableId}/${fx.views.list}`));
    await expect.poll(async () => (await call<{ unread: number }>(page.request, "get", "/api/notifications")).unread).toBe(unreadBefore - 1);
  });
});

test.describe("menu order", () => {
  /** A workspace with one project of three empty tables (Alpha, Bravo, Charlie) and, in Alpha, three shared views. */
  async function seedTree(page: Page) {
    const req = page.request;
    const ws = await call<{ id: string }>(req, "post", "/api/workspaces", { name: `E2E order ${Date.now()}` });
    const base = await call<{ id: string }>(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Order E2E", empty: true });
    const tables: { id: string; name: string }[] = [];
    for (const name of ["Alpha", "Bravo", "Charlie"]) tables.push(await call<{ id: string; name: string }>(req, "post", `/api/bases/${base.id}/tables`, { name }));
    for (const name of ["Rows", "Cards", "Gallery"]) await call(req, "post", `/api/tables/${tables[0]!.id}/views`, { name, type: name === "Gallery" ? "gallery" : "grid" });
    return { workspaceId: ws.id, baseId: base.id, tables };
  }
  const tableNames = async (page: Page, baseId: string) => (await call<{ tables: { name: string }[] }>(page.request, "get", `/api/bases/${baseId}`)).tables.map((t) => t.name);

  test("drags a table below another with the mouse, and the order is still there after a reload", async ({ page }) => {
    const tree = await seedTree(page);
    await page.goto(`/base/${tree.baseId}/${tree.tables[0]!.id}`);
    const list = page.getByRole("list", { name: "Tables in Order E2E" });
    await expect(list.getByRole("link")).toHaveText(["Alpha", "Bravo", "Charlie"]);

    // Alpha, picked up by its row, goes below Bravo: a few pixels first (a plain click must not drag), then to the target.
    const alpha = (await list.getByRole("link", { name: "Alpha" }).boundingBox())!;
    const bravo = (await list.getByRole("link", { name: "Bravo" }).boundingBox())!;
    await page.mouse.move(alpha.x + 40, alpha.y + alpha.height / 2);
    await page.mouse.down();
    await page.mouse.move(alpha.x + 40, alpha.y + alpha.height / 2 + 8, { steps: 3 });
    await page.mouse.move(alpha.x + 40, bravo.y + bravo.height * 0.8, { steps: 10 });
    await page.mouse.up();

    await expect(list.getByRole("link")).toHaveText(["Bravo", "Alpha", "Charlie"]);
    await expect.poll(() => tableNames(page, tree.baseId)).toEqual(["Bravo", "Alpha", "Charlie"]);
    // The drop did not open the table it ended on.
    await expect(page).toHaveURL(new RegExp(`/base/${tree.baseId}/${tree.tables[0]!.id}`));

    await page.reload();
    await expect(page.getByRole("list", { name: "Tables in Order E2E" }).getByRole("link")).toHaveText(["Bravo", "Alpha", "Charlie"]);
  });

  test("a click on a row without moving still opens it", async ({ page }) => {
    const tree = await seedTree(page);
    await page.goto(`/base/${tree.baseId}/${tree.tables[0]!.id}`);
    await page.getByRole("list", { name: "Tables in Order E2E" }).getByRole("link", { name: "Charlie" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${tree.baseId}/${tree.tables[2]!.id}`));
  });

  test("moves a table with the keyboard through its row menu, and a view through the view switcher's options", async ({ page }) => {
    const tree = await seedTree(page);
    await page.goto(`/base/${tree.baseId}/${tree.tables[0]!.id}`);
    const list = page.getByRole("list", { name: "Tables in Order E2E" });

    await list.getByRole("button", { name: "Table options for Charlie" }).click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect(list.getByRole("link")).toHaveText(["Alpha", "Charlie", "Bravo"]);
    await expect.poll(() => tableNames(page, tree.baseId)).toEqual(["Alpha", "Charlie", "Bravo"]);

    // The menu lists tables only: the views are in the toolbar's list, where they are also put in order.
    await expect(page.getByRole("button", { name: /^Show views of/ })).toHaveCount(0);
    const viewNames = async () =>
      (await call<{ tables: { id: string; views: { name: string; is_default?: boolean }[] }[] }>(page.request, "get", `/api/bases/${tree.baseId}`)).tables
        .find((t) => t.id === tree.tables[0]!.id)!
        .views.filter((v) => !v.is_default)
        .map((v) => v.name);
    const before = await viewNames();
    // Whatever else a new table starts with, the three views are there, Gallery after Cards.
    expect(before.indexOf("Gallery")).toBe(before.indexOf("Cards") + 1);
    const after = [...before];
    after.splice(before.indexOf("Gallery") - 1, 2, "Gallery", "Cards");

    await page.getByRole("button", { name: /^View: / }).click();
    const views = page.getByRole("menu", { name: "Views of Alpha" });
    await views.getByRole("menuitem", { name: "Gallery" }).click({ button: "right" });
    await page.getByRole("menu", { name: "Options for Gallery" }).getByRole("menuitem", { name: "Move up" }).click();
    await expect.poll(viewNames).toEqual(after);
    // Still so once the page is loaded again.
    await page.reload();
    expect(await viewNames()).toEqual(after);
  });
});
