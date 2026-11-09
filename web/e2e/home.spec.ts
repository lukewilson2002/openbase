import { type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, skipIntro, test } from "./fixtures";

/**
 * Home against the real server (HOME-2 to HOME-9): the date and title, Due soon and Recently changed from one request, the
 * capture box (a date phrase becoming a chip, the first line as the title), the Done checkbox with Undo, the Inbox card, and
 * the phone's layout. Signs up its own user. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
// Dates are read in the browser's zone and listed in the account's (UTC when none is set): one zone keeps "tomorrow" the same day for both.
test.use({ timezoneId: "UTC" });

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

async function send<T>(request: APIRequestContext, method: "post" | "get" | "patch", path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

interface Table {
  id: string;
  primary_field_id: string;
  fields: { id: string; name: string }[];
  views: { id: string; is_default: boolean }[];
}

/** A user with a workspace whose Tasks collection has a Due date and a Done checkbox, one task overdue and one due today. */
async function seed(request: APIRequestContext) {
  const email = `e2e-home-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Home E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await send<{ id: string }>(request, "post", "/api/workspaces", { name: "Home workspace" });
  const workspaces = await send<{ id: string; root_base_id: string }[]>(request, "get", "/api/workspaces");
  const top = workspaces.find((w) => w.id === ws.id)!.root_base_id;
  const table = await send<Table>(request, "post", `/api/bases/${top}/tables`, { name: "Tasks" });
  const dueField = await send<{ id: string }>(request, "post", `/api/tables/${table.id}/fields`, { name: "Due", type: "date", options: { include_time: false, date_format: "iso", time_format: "h24", timezone: null } });
  const doneField = await send<{ id: string }>(request, "post", `/api/tables/${table.id}/fields`, { name: "Done", type: "checkbox", options: { icon: "check", color: "green" } });
  await send(request, "patch", `/api/tables/${table.id}`, { home_date_field_id: dueField.id, done_field_id: doneField.id });
  await send(request, "post", `/api/tables/${table.id}/records`, {
    records: [
      { values: { [table.primary_field_id]: "Send the invoice", [dueField.id]: day(-1) } },
      { values: { [table.primary_field_id]: "Water the plants", [dueField.id]: day(0) } },
    ],
  });
  const viewId = table.views.find((v) => v.is_default)!.id;
  const records = async () => {
    const res = await request.post(`/api/views/${viewId}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { records: { id: string; values: Record<string, unknown> }[] }).records;
  };
  return { workspaceId: ws.id, tableId: table.id, nameId: table.primary_field_id, dueId: dueField.id, doneId: doneField.id, records };
}

const toasts = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Notifications" });
const box = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" });

test("Home lists what is due, captures into a collection with a date chip, and checks tasks off with Undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}`);

  await test.step("shows the date above the title, and the lists with their dates in words", async () => {
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.getByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}$/)).toBeVisible();
    const due = page.getByRole("region", { name: "Due soon" });
    await expect(due.getByRole("link", { name: /Send the invoice/ })).toBeVisible();
    await expect(due.getByText("Yesterday")).toBeVisible();
    await expect(due.getByText("Today")).toBeVisible();
    await expect(page.getByRole("region", { name: "Recently changed" }).getByRole("link", { name: /Send the invoice/ })).toBeVisible();
  });

  await test.step("a date phrase becomes a chip, the first line the title and the other lines the page", async () => {
    await expect(page.getByRole("button", { name: /Goes to Tasks/ })).toBeVisible();
    await box(page).fill("Call Dana tomorrow\nAbout the quote");
    await expect(page.getByText("Due tomorrow")).toBeVisible();
    await box(page).press("Enter");
    await expect(toasts(page).getByText("Added to Tasks")).toBeVisible();
    await expect(box(page)).toHaveValue("");
    await expect.poll(async () => (await fx.records()).some((r) => r.values[fx.nameId] === "Call Dana" && r.values[fx.dueId] === day(1))).toBe(true);
    // The list follows on its own: the workspace stream tells Home, which asks again.
    const due = page.getByRole("region", { name: "Due soon" });
    await expect(due.getByRole("link", { name: /Call Dana/ })).toBeVisible();
    await expect(due.getByText("Tomorrow")).toBeVisible();
  });

  await test.step("Undo takes the new record back", async () => {
    await toasts(page).getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await fx.records()).some((r) => r.values[fx.nameId] === "Call Dana")).toBe(false);
    await expect(page.getByRole("region", { name: "Due soon" }).getByRole("link", { name: /Call Dana/ })).toHaveCount(0);
  });

  await test.step("the Done checkbox takes the row off Home, and Undo puts it back", async () => {
    const due = page.getByRole("region", { name: "Due soon" });
    await due.getByRole("checkbox", { name: "Mark Send the invoice done" }).click();
    await expect(due.getByRole("link", { name: /Send the invoice/ })).toHaveCount(0);
    await expect.poll(async () => (await fx.records()).find((r) => r.values[fx.nameId] === "Send the invoice")?.values[fx.doneId]).toBe(true);
    await toasts(page).getByRole("button", { name: "Undo" }).click();
    await expect(due.getByRole("link", { name: /Send the invoice/ })).toBeVisible();
    await expect.poll(async () => (await fx.records()).find((r) => r.values[fx.nameId] === "Send the invoice")?.values[fx.doneId] ?? false).toBe(false);
  });

  await test.step("Inbox keeps a draft that Home lists with File and Delete", async () => {
    await page.getByRole("button", { name: /Goes to Tasks/ }).click();
    await page.getByRole("option", { name: /^Inbox/ }).click();
    await box(page).fill("Buy a cake");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const card = page.getByRole("region", { name: "Inbox" });
    await expect(card.getByText("Buy a cake")).toBeVisible();
    await card.getByRole("button", { name: "Delete Buy a cake" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("region", { name: "Inbox" })).toHaveCount(0);
  });
});

test("Home on a phone: the capture box, Inbox and lists stack, the Add button is 44 px, and nothing scrolls sideways", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: "UTC", baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const add = page.getByRole("button", { name: "Add", exact: true });
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const order = await page.locator("main h1, main h2").allTextContents();
  expect(order).toEqual(["Home", "Due soon", "Recently changed"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await context.close();
});
