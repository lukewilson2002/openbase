import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, hoverAt, skipIntro, test } from "./fixtures";

/**
 * The plan's Interaction targets table (UX overhaul DONE-5), one test per row, at a desktop and a phone size, each
 * against the real server. A test does what the row says and no more, and asserts two things: the outcome, and the
 * number of steps it took, counted by the page itself rather than by the test. A step is a click or tap (on the
 * field a person is typing in, focusing it is part of typing, so it is not counted), a run of typing, or a key that is
 * not a character (Enter, Tab) or that is pressed with Ctrl or Cmd. Whatever else the test did to set the screen up
 * happens before the count is reset.
 *
 * Capture a task        Home         Type, then Enter
 * Open a record         Collection   1 click or tap
 * Filter by a field     Collection   Type a phrase, then Enter
 * Save the filter       Collection   1 click, then name it
 * Add a property        Record page  Name, value, Enter
 * Switch layout         Collection   View options, then 1 tap
 * Jump to anything      Anywhere     Ctrl K or Cmd K, type, Enter
 *
 * Three rows read a little differently on a touch screen, and the tests say how: Return on a finger's keyboard starts a
 * new line, so Add is how a note is added (HOME-3); there is no Ctrl K, so the search button of the header opens the
 * palette (NAV-9); and Add property is opened by its button before its Name has focus (REC-4), which both sizes count
 * as the step that reaches the form. Signs up its own users. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

async function send<T>(request: APIRequestContext, method: "post" | "get" | "patch", path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

interface Field {
  id: string;
  name: string;
  type: string;
  options?: { choices?: { id: string; name: string }[] };
}
interface TableDto {
  id: string;
  primary_field_id: string;
  fields: Field[];
  views: { id: string; name: string; is_default: boolean; config?: { filter?: unknown } }[];
}

const NAME_W = 220;
const MARKER_W = 56;
const HEADER_H = 44;
const ROW_H = 36;

/**
 * A user with a workspace. At the top level: Clients (three records with a Status and a Due date, a grid with a known
 * name column and a list) and Tasks (a Home date and a Done property, so Home can capture into it). A folder, Garden,
 * holds Plants.
 */
async function seed(request: APIRequestContext) {
  const email = `e2e-targets-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Targets E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await send<{ id: string }>(request, "post", "/api/workspaces", { name: "Targets workspace" });
  const workspaces = await send<{ id: string; root_base_id: string }[]>(request, "get", "/api/workspaces");
  const top = workspaces.find((w) => w.id === ws.id)!.root_base_id;
  const date = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
  const addField = <T = Field>(tableId: string, body: unknown) => send<T>(request, "post", `/api/tables/${tableId}/fields`, body);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const clients = await send<TableDto>(request, "post", `/api/bases/${top}/tables`, { name: "Clients" });
  const status = await addField(clients.id, { name: "Status", type: "single_select", options: { choices: ["Prospect", "Active", "Lost"].map((n) => ({ id: "", name: n, color: "gray" })) } });
  const due = await addField(clients.id, { name: "Due", type: "date", options: date });
  const choice = (name: string) => status.options!.choices!.find((c) => c.name === name)!.id;
  const names = ["Harper & Co", "Northwind", "Contoso"];
  const created = await send<{ records: { id: string }[] }>(request, "post", `/api/tables/${clients.id}/records`, {
    typecast: true,
    records: names.map((n, i) => ({ values: { [clients.primary_field_id]: n, [status.id]: choice(i === 1 ? "Active" : "Prospect"), [due.id]: day(i + 1) } })),
  });
  const view = (name: string, type: string, config: unknown = null) => send<{ id: string }>(request, "post", `/api/tables/${clients.id}/views`, { name, type, config });
  const grid = await view("Grid", "grid", { field_widths: { [clients.primary_field_id]: NAME_W } });
  const list = await view("List", "list");

  const tasks = await send<TableDto>(request, "post", `/api/bases/${top}/tables`, { name: "Tasks" });
  const tasksDue = await addField(tasks.id, { name: "Due", type: "date", options: date });
  const tasksDone = await addField(tasks.id, { name: "Done", type: "checkbox", options: { icon: "check", color: "green" } });
  await send(request, "patch", `/api/tables/${tasks.id}`, { home_date_field_id: tasksDue.id, done_field_id: tasksDone.id });

  const garden = await send<{ id: string }>(request, "post", `/api/workspaces/${ws.id}/bases`, { name: "Garden", empty: true });
  const plants = await send<TableDto>(request, "post", `/api/bases/${garden.id}/tables`, { name: "Plants" });
  await send(request, "post", `/api/tables/${plants.id}/records`, { typecast: true, records: [{ values: { [plants.primary_field_id]: "Fern" } }] });

  const loadClients = async () => (await send<{ tables: TableDto[] }>(request, "get", `/api/bases/${top}`)).tables.find((t) => t.id === clients.id)!;
  const taskTitles = async () => {
    const viewId = (await send<{ tables: TableDto[] }>(request, "get", `/api/bases/${top}`)).tables.find((t) => t.id === tasks.id)!.views.find((v) => v.is_default)!.id;
    const res = await request.post(`/api/views/${viewId}/query`, { data: { offset: 0, limit: 100 }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { records: { values: Record<string, unknown> }[] }).records.map((r) => r.values[tasks.primary_field_id]);
  };
  return {
    workspaceId: ws.id,
    topId: top,
    gardenId: garden.id,
    clientsId: clients.id,
    plantsId: plants.id,
    plantsName: plants.primary_field_id,
    records: Object.fromEntries(names.map((n, i) => [n, created.records[i]!.id])) as Record<string, string>,
    views: { grid: grid.id, list: list.id },
    loadClients,
    taskTitles,
  };
}

type Seed = Awaited<ReturnType<typeof seed>>;
const collectionUrl = (fx: Seed, viewId: string) => `/base/${fx.topId}/${fx.clientsId}/${viewId}`;
const recordUrl = (fx: Seed, name: string) => `/base/${fx.topId}/${fx.clientsId}/${fx.views.grid}/r/${fx.records[name]}`;

// ---------------------------------------------------------------------------------------------------------------------
// The step counter: the page reports what a person would call a step.
// ---------------------------------------------------------------------------------------------------------------------

type Counted = { __steps: string[] };

async function watchSteps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const steps: string[] = [];
    (window as unknown as Counted).__steps = steps;
    const MODIFIERS = new Set(["Control", "Meta", "Shift", "Alt"]);
    addEventListener(
      "click",
      (e) => {
        // A click with no press behind it (detail 0) is the browser answering Enter or Space on a button, which the key already counted.
        if (!e.isTrusted || e.detail === 0) return;
        // Putting the cursor in the field that is about to be typed in is part of typing it.
        const hit = e.target instanceof Element ? e.target.closest("input, textarea, [contenteditable='true'], [role='textbox'], [role='combobox']") : null;
        if (!hit) steps.push("click");
      },
      true,
    );
    addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted || MODIFIERS.has(e.key)) return;
        const shortcut = e.ctrlKey || e.metaKey;
        if (e.key.length > 1 || shortcut) steps.push(`${shortcut ? "Mod+" : ""}${e.key.length > 1 ? e.key : e.key.toUpperCase()}`);
      },
      true,
    );
    addEventListener(
      "input",
      (e) => {
        // A run of typing is one step, however many keys or events it took.
        if (e.isTrusted && steps[steps.length - 1] !== "type") steps.push("type");
      },
      true,
    );
  });
}

const resetSteps = (page: Page) => page.evaluate(() => ((window as unknown as Counted).__steps.length = 0));
const stepsTaken = (page: Page) => page.evaluate(() => [...(window as unknown as Counted).__steps]);

// ---------------------------------------------------------------------------------------------------------------------
// One set of tests, run at both sizes.
// ---------------------------------------------------------------------------------------------------------------------

const SIZES = [
  { name: "desktop", phone: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: "phone", phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
] as const;

const captureBox = (page: Page) => page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" });
const filterBar = (page: Page) => page.getByRole("combobox", { name: "Filter or search" });
const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

for (const size of SIZES) {
  test.describe(`at ${size.name} size`, () => {
    test.use(size.use);
    /** A click on a desktop, a tap on a phone. */
    const press = (target: Locator) => (size.phone ? target.tap() : target.click());

    test("capture a task from Home: type, then Enter (Add on a phone)", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      await page.goto(`/workspace/${fx.workspaceId}`);
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

      // Not a step of the target: the first note names where notes go, and Home keeps the answer.
      await press(page.getByRole("button", { name: /Goes to/ }));
      await press(page.getByRole("option", { name: /^Tasks/ }));
      await captureBox(page).fill("Warm up");
      await (size.phone ? page.getByRole("button", { name: "Add", exact: true }).tap() : captureBox(page).press("Enter"));
      await expect(toasts(page).getByText("Added to Tasks")).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: /Goes to Tasks/ })).toBeVisible();

      await resetSteps(page);
      await captureBox(page).fill("Pay the invoice");
      if (size.phone) await page.getByRole("button", { name: "Add", exact: true }).tap();
      else await captureBox(page).press("Enter");

      await expect(toasts(page).getByText("Added to Tasks").first()).toBeVisible();
      await expect(captureBox(page)).toHaveValue("");
      await expect.poll(fx.taskTitles).toContain("Pay the invoice");
      expect(await stepsTaken(page)).toEqual(size.phone ? ["type", "click"] : ["type", "Enter"]);
    });

    test("open a record from a collection: 1 click or tap", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);

      await test.step("a list", async () => {
        await page.goto(collectionUrl(fx, fx.views.list));
        await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
        const row = page.getByText("Northwind", { exact: true }).first();
        await expect(row).toBeVisible();
        await resetSteps(page);
        await press(row);
        await expect(page).toHaveURL(new RegExp(`/r/${fx.records["Northwind"]}$`));
        await expect(page.getByRole("heading", { level: 1, name: "Northwind" })).toBeVisible();
        expect(await stepsTaken(page)).toEqual(["click"]);
      });

      if (size.phone) return;
      await test.step("a grid: the expand icon in the title cell", async () => {
        await page.goto(collectionUrl(fx, fx.views.grid));
        const canvas = page.locator("canvas[data-testid='data-grid-canvas']").first();
        await expect(canvas).toBeVisible();
        const box = (await canvas.boundingBox())!;
        // The second row's name cell, at the right end where the icon shows while the pointer is over the row.
        const y = box.y + HEADER_H + ROW_H * 1.5;
        const x = box.x + MARKER_W + NAME_W - 14;
        await hoverAt(page, x, y);
        await resetSteps(page);
        await page.mouse.click(x, y);
        await expect(page).toHaveURL(/\/r\/rec[^/]+$/);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await stepsTaken(page)).toEqual(["click"]);
      });
    });

    test("filter a collection by a property: type a phrase, then Enter", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      await page.goto(collectionUrl(fx, fx.views.grid));
      await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
      await expect(filterBar(page)).toBeVisible();

      await resetSteps(page);
      await filterBar(page).fill("name contains north");
      await page.keyboard.press("Enter");

      await expect(page.getByRole("button", { name: "Name contains north", exact: true })).toBeVisible();
      await expect(page.getByText("Showing 1 of 3 records.")).toBeVisible();
      expect(await stepsTaken(page)).toEqual(["type", "Enter"]);
    });

    test("save the current filter as a view: 1 click, then name it", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      await page.goto(collectionUrl(fx, fx.views.grid));
      await filterBar(page).fill("name contains north");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Name contains north", exact: true })).toBeVisible();

      await resetSteps(page);
      await press(page.getByRole("button", { name: "Save as view", exact: true }));
      const dialog = page.getByRole("dialog", { name: "Save as view" });
      const name = dialog.getByRole("textbox", { name: "Name" });
      // The one click is enough to reach the name, which is ready to be typed over.
      await expect(name).toBeFocused();
      await name.fill("Northern clients");
      await name.press("Enter");

      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await fx.loadClients()).views.find((v) => v.name === "Northern clients")?.config?.filter ?? null).not.toBeNull();
      expect((await fx.loadClients()).views.find((v) => v.id === fx.views.grid)?.config?.filter ?? null).toBeNull();
      expect(await stepsTaken(page)).toEqual(["click", "type", "Enter"]);
    });

    test("add a property to a record: name, value, Enter", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      await page.goto(recordUrl(fx, "Northwind"));
      await expect(page.getByRole("heading", { level: 1, name: "Northwind" })).toBeVisible();

      await resetSteps(page);
      await press(page.getByRole("main").getByRole("button", { name: "Add property" }));
      const form = page.getByRole("main").getByRole("group", { name: "Add property" });
      const name = form.getByRole("textbox", { name: "Name" });
      await expect(name).toBeFocused();
      await name.fill("Deposit");
      await page.keyboard.press("Tab");
      await expect(form.getByRole("textbox", { name: "Value" })).toBeFocused();
      await form.getByRole("textbox", { name: "Value" }).fill("$600");
      // The type is guessed, so there is no step that picks one.
      await expect(form.getByText(/^Currency/)).toBeVisible();
      await page.keyboard.press("Enter");

      await expect(form).toBeHidden();
      await expect.poll(async () => (await fx.loadClients()).fields.find((f) => f.name === "Deposit")?.type).toBe("currency");
      await expect(page.getByRole("main").getByText("Deposit", { exact: true }).first()).toBeVisible();
      // The button that opens the form is the only click; naming the property and giving its value are typing.
      expect(await stepsTaken(page)).toEqual(["click", "type", "Tab", "type", "Enter"]);
    });

    test("switch layout from a collection: View options, then 1 tap", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      await page.goto(collectionUrl(fx, fx.views.grid));
      await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
      const panel = page.getByRole("dialog", { name: "View options" });
      const grid = page.locator("canvas[data-testid='data-grid-canvas']");

      const switchTo = async (layout: string, shown: Locator) => {
        await resetSteps(page);
        await press(page.getByRole("button", { name: "View options" }));
        await press(panel.getByRole("group", { name: "Layout" }).getByRole("button", { name: layout, exact: true }));
        await expect(panel.getByRole("button", { name: layout, exact: true, pressed: true })).toBeVisible();
        const taken = await stepsTaken(page);
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(shown.first()).toBeVisible();
        expect(taken, `${layout} took ${taken.length} steps`).toEqual(["click", "click"]);
      };

      await switchTo("Board", page.getByRole("listitem", { name: "Stack: Active" }));
      await expect(grid).toHaveCount(0);
      // A phone's month holds "+1 more" in a day, not the event, so the calendar itself is what shows.
      await switchTo("Calendar", page.locator(".fc-daygrid"));
      await switchTo("Grid", grid);
    });

    test("jump to a record or a collection from anywhere", async ({ page }) => {
      await watchSteps(page);
      const fx = await seed(page.request);
      const palette = page.getByRole("dialog", { name: "Search everything" });
      const box = palette.getByRole("combobox", { name: "Search" });
      /** Ctrl K or Cmd K on a desktop; a finger has no keyboard shortcut, so the header's search button opens it. */
      const openPalette = async () => {
        if (size.phone) await page.getByRole("button", { name: "Search everything" }).first().tap();
        else await page.keyboard.press("ControlOrMeta+k");
        await expect(palette).toBeVisible();
      };
      const opened = size.phone ? "click" : "Mod+K";

      await test.step("a record, from Home", async () => {
        await page.goto(`/workspace/${fx.workspaceId}`);
        await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
        await resetSteps(page);
        await openPalette();
        await box.fill("Northwind");
        // The result itself, not the actions that are listed at once: Enter opens the first thing in the list.
        await expect(palette.getByRole("group", { name: "Records" }).getByRole("option", { name: /Northwind/ })).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/r/${fx.records["Northwind"]}$`));
        await expect(page.getByRole("heading", { level: 1, name: "Northwind" })).toBeVisible();
        expect(await stepsTaken(page)).toEqual([opened, "type", "Enter"]);
      });

      await test.step("a collection, from another collection", async () => {
        await page.goto(collectionUrl(fx, fx.views.grid));
        await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
        await resetSteps(page);
        await openPalette();
        await box.fill("Plants");
        await expect(palette.getByRole("group", { name: "Collections" }).getByRole("option", { name: /Plants/ })).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/base/${fx.gardenId}/${fx.plantsId}`));
        await expect(page.getByRole("heading", { level: 1, name: "Plants" })).toBeVisible();
        expect(await stepsTaken(page)).toEqual([opened, "type", "Enter"]);
      });
    });
  });
}
