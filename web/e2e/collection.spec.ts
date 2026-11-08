import { devices, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, skipIntro, test } from "./fixtures";

/**
 * The collection header, its view tabs and its settings against the real server (COL-1, COL-2, COL-10): the title with
 * its count, the folder above it, the New button named after the collection's record name, the description edited in
 * place, the settings dialog (name, color, description, record name, title, page, Home date, done), the tabs (default
 * view first as "All clients", a menu on a right-click, Move left, a drag, More when they do not fit) and the same
 * screen on a phone, where a 12-character name has the whole row and a held press opens a view's menu. Signs up its
 * own user. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Field {
  id: string;
  name: string;
  type: string;
}
interface TableDto {
  id: string;
  name: string;
  color: string;
  description: string | null;
  record_noun: string;
  primary_field_id: string;
  body_field_id: string | null;
  home_date_field_id: string | null;
  done_field_id: string | null;
  fields: Field[];
  views: { id: string; name: string; is_default: boolean; personal: boolean; locked: boolean; config?: { filter?: unknown } }[];
}

async function send<T>(request: APIRequestContext, method: "post" | "get" | "patch", path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A user with a workspace: Clients at the top level (three records, a few properties, three saved views) and a folder, Garden, with Plants. */
async function seed(request: APIRequestContext, tableName = "Clients") {
  const email = `e2e-collection-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Collection E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await send<{ id: string }>(request, "post", "/api/workspaces", { name: "Collection workspace" });
  const workspaces = await send<{ id: string; root_base_id: string }[]>(request, "get", "/api/workspaces");
  const top = workspaces.find((w) => w.id === ws.id)!.root_base_id;
  const table = await send<TableDto>(request, "post", `/api/bases/${top}/tables`, { name: tableName });
  const field = (name: string, type: string, options: unknown = {}) => send<Field>(request, "post", `/api/tables/${table.id}/fields`, { name, type, options });
  const date = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
  await field("Nickname", "text", { multiline: false });
  await field("Due", "date", date);
  await field("Done", "checkbox", { icon: "check", color: "green" });
  await send(request, "post", `/api/tables/${table.id}/records`, { typecast: true, records: ["Harper & Co", "Northwind", "Contoso"].map((n) => ({ values: { [table.primary_field_id]: n } })) });
  const view = (name: string, type: string, personal = false) => send<{ id: string }>(request, "post", `/api/tables/${table.id}/views`, { name, type, personal, config: null });
  const open = await view("Open deals", "grid");
  const pipeline = await view("Pipeline", "gallery");
  const mine = await view("Mine", "grid", true);
  const garden = await send<{ id: string }>(request, "post", `/api/workspaces/${ws.id}/bases`, { name: "Garden", empty: true });
  const plants = await send<TableDto>(request, "post", `/api/bases/${garden.id}/tables`, { name: "Plants" });
  const load = async () => (await send<{ tables: TableDto[] }>(request, "get", `/api/bases/${top}`)).tables.find((t) => t.id === table.id)!;
  return { workspaceId: ws.id, topId: top, gardenId: garden.id, tableId: table.id, plantsId: plants.id, views: { open: open.id, pipeline: pipeline.id, mine: mine.id }, load };
}

const tabNames = (page: Page) => page.getByRole("tablist", { name: /^Views of/ }).getByRole("tab");

test("the header names the collection with its count, and the New button follows its record name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/base/${fx.topId}/${fx.tableId}`);
  const header = page.getByRole("main").locator("header").first();

  await test.step("shows the mark, the title, the count, Share and a primary New button", async () => {
    await expect(header.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
    await expect(header.getByText("3 records")).toBeVisible();
    await expect(header.getByRole("button", { name: "Share" })).toBeVisible();
    await expect(header.getByRole("button", { name: "New record" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Collection settings" })).toBeVisible();
    // A top-level collection has no folder above it.
    await expect(header.getByText("Collection workspace")).toHaveCount(0);
    await expect(page.locator("main h1")).toHaveCount(1);
  });

  await test.step("the count follows a record another client adds", async () => {
    const t = await fx.load();
    await send(page.request, "post", `/api/tables/${fx.tableId}/records`, { typecast: true, records: [{ values: { [t.primary_field_id]: "Fabrikam" } }] });
    await expect(header.getByText("4 records")).toBeVisible({ timeout: 15_000 });
  });

  await test.step("the New button adds a record the way the open layout does", async () => {
    const added = page.waitForResponse((r) => r.request().method() === "POST" && new RegExp(`/api/tables/${fx.tableId}/records$`).test(r.url()));
    await header.getByRole("button", { name: "New record" }).click();
    expect((await added).ok()).toBeTruthy();
  });

  await test.step("a collection inside a folder has the folder's name above its title", async () => {
    await page.goto(`/base/${fx.gardenId}/${fx.plantsId}`);
    const folderHeader = page.getByRole("main").locator("header").first();
    await expect(folderHeader.getByRole("heading", { level: 1, name: "Plants" })).toBeVisible();
    const folder = folderHeader.getByText("Garden", { exact: true });
    await expect(folder).toBeVisible();
    const above = await folder.boundingBox();
    const title = await folderHeader.getByRole("heading", { level: 1 }).boundingBox();
    expect(above!.y + above!.height, "the folder is above the title").toBeLessThanOrEqual(title!.y + 1);
  });
});

test("the settings change the name, color, description, record name, title, page, Home date and done property", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/base/${fx.topId}/${fx.tableId}`);
  const header = page.getByRole("main").locator("header").first();
  const settings = page.getByRole("dialog", { name: "Collection settings" });
  const before = await fx.load();

  await test.step("opens from the … beside the title, with Escape giving the focus back to it", async () => {
    const opener = header.getByRole("button", { name: "Collection settings" });
    await opener.click();
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel("Name", { exact: true })).toHaveValue("Clients");
    await expect(settings.getByLabel("Title property")).toHaveValue(before.primary_field_id);
    await expect(settings.getByLabel("Page property")).toHaveValue(before.body_field_id!);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(opener).toBeFocused();
  });

  await test.step("saves name, color, description and the record name; the button and the line follow", async () => {
    await header.getByRole("button", { name: "Collection settings" }).click();
    await settings.getByLabel("Name", { exact: true }).fill("Customers");
    await settings.getByRole("radio", { name: "Teal", exact: true }).click();
    await settings.getByLabel("Description").fill("People and companies we sell to");
    await settings.getByLabel("Record name").fill("customer");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();
    await expect(header.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
    await expect(header.getByRole("button", { name: "New customer" })).toBeVisible();
    await expect(header.getByRole("button", { name: "People and companies we sell to" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "All customers" })).toBeVisible();
    const t = await fx.load();
    expect(t).toMatchObject({ name: "Customers", color: "teal", description: "People and companies we sell to", record_noun: "customer" });
  });

  await test.step("the description is edited in place: Escape leaves it, Enter saves it", async () => {
    const line = header.getByRole("button", { name: "People and companies we sell to" });
    await line.click();
    const field = header.getByRole("textbox", { name: "Description" });
    await expect(field).toBeFocused();
    await field.fill("Not saved");
    await page.keyboard.press("Escape");
    await expect(line).toBeFocused();
    expect((await fx.load()).description).toBe("People and companies we sell to");
    await line.click();
    await header.getByRole("textbox", { name: "Description" }).fill("Everyone we invoice");
    await page.keyboard.press("Enter");
    await expect(header.getByRole("button", { name: "Everyone we invoice" })).toBeVisible();
    await expect.poll(async () => (await fx.load()).description).toBe("Everyone we invoice");
  });

  await test.step("the title property is chosen among those that can be one, the first UI for it", async () => {
    await header.getByRole("button", { name: "Collection settings" }).click();
    const title = settings.getByLabel("Title property");
    await expect(title.getByRole("option", { name: /^Done/ })).toBeDisabled();
    await expect(title.getByRole("option", { name: "Done (Checkbox properties can't be the title)" })).toHaveCount(1);
    const nickname = before.fields.find((f) => f.name === "Nickname")!;
    await title.selectOption(nickname.id);
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();
    await expect.poll(async () => (await fx.load()).primary_field_id).toBe(nickname.id);
  });

  await test.step("the page, the Home date and the done property are each chosen, or none", async () => {
    const due = before.fields.find((f) => f.name === "Due")!;
    const done = before.fields.find((f) => f.name === "Done")!;
    await header.getByRole("button", { name: "Collection settings" }).click();
    await settings.getByLabel("Page property").selectOption("");
    await settings.getByLabel("Show on Home by").selectOption(due.id);
    await settings.getByLabel("Done property").selectOption(done.id);
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();
    await expect.poll(async () => fx.load().then((t) => [t.body_field_id, t.home_date_field_id, t.done_field_id])).toEqual([null, due.id, done.id]);
    // The sidebar's mark follows the new color without a reload.
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: /^Customers/ })).toBeVisible();
  });
});

test("the tabs: default view first, a menu on a right-click, Move left, a drag, and More when they do not fit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/base/${fx.topId}/${fx.tableId}`);

  await test.step("start with All clients and the saved views, with layout icons, a person glyph and no + tab", async () => {
    await expect(tabNames(page)).toHaveText(["All clients", "Open deals", "Pipeline", "Mine"]);
    await expect(page.getByRole("tab", { name: "All clients" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Pipeline" }).locator("svg")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "All clients" }).locator("svg")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Mine/ }).getByRole("img", { name: "Personal view" })).toBeVisible();
    await expect(page.getByRole("button", { name: /add view|new view/i })).toHaveCount(0);
  });

  await test.step("choosing a tab opens that view", async () => {
    await page.getByRole("tab", { name: "Open deals" }).click();
    await expect(page).toHaveURL(new RegExp(`/${fx.views.open}$`));
    await expect(page.getByRole("tab", { name: "Open deals" })).toHaveAttribute("aria-selected", "true");
  });

  await test.step("a right-click opens the view's menu, which has Rename, Duplicate, Share, Lock, Move and Delete", async () => {
    await page.getByRole("tab", { name: "Pipeline" }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Options for Pipeline" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Rename view", "Duplicate view", "Share view…", "Lock view", "Move left", "Move right", "Delete view"]);
    // The default view has none.
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "All clients" }).click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  await test.step("Move left puts the view before its neighbour, on the server too", async () => {
    await page.getByRole("tab", { name: "Pipeline" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move left" }).click();
    await expect(tabNames(page)).toHaveText(["All clients", "Pipeline", "Open deals", "Mine"]);
    await expect.poll(async () => (await fx.load()).views.filter((v) => !v.is_default && !v.personal).map((v) => v.name)).toEqual(["Pipeline", "Open deals"]);
  });

  await test.step("dragging a tab puts it in a new place among the shared views, and a personal view stays among the personal ones", async () => {
    const drag = async (from: string | RegExp, to: string | RegExp) => {
      const a = (await page.getByRole("tab", { name: from }).boundingBox())!;
      const b = (await page.getByRole("tab", { name: to }).boundingBox())!;
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
      await page.mouse.move(b.x + b.width - 8, b.y + b.height / 2, { steps: 12 });
      await page.mouse.up();
    };
    await drag("Pipeline", "Open deals");
    await expect.poll(async () => (await fx.load()).views.filter((v) => !v.is_default && !v.personal).map((v) => v.name)).toEqual(["Open deals", "Pipeline"]);
    await expect(tabNames(page)).toHaveText(["All clients", "Open deals", "Pipeline", "Mine"]);
    // A drop on the personal view changes nothing.
    await drag("Pipeline", /^Mine/);
    await expect(tabNames(page)).toHaveText(["All clients", "Open deals", "Pipeline", "Mine"]);
  });

  await test.step("Lock view shows a lock on the tab", async () => {
    await page.getByRole("tab", { name: "Open deals" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Lock view" }).click();
    await expect(page.getByRole("tab", { name: /^Open deals/ }).getByRole("img", { name: "Locked view" })).toBeVisible();
  });

  await test.step("tabs that do not fit go into More, and the open view stays on the strip", async () => {
    for (let i = 1; i <= 6; i++) await send(page.request, "post", `/api/tables/${fx.tableId}/views`, { name: `Saved view number ${i}`, type: "grid", config: null });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.reload();
    const more = page.getByRole("button", { name: "More", exact: true }).first();
    await expect(more).toBeVisible();
    const shown = await tabNames(page).count();
    expect(shown).toBeLessThan(10);
    await more.click();
    await page.getByRole("menuitem", { name: "Saved view number 6" }).click();
    await expect(page).toHaveURL(/\/viw[^/]+$/);
    // The view just opened is on the strip now, not only in More.
    await expect(page.getByRole("tab", { name: "Saved view number 6" })).toHaveAttribute("aria-selected", "true");
    // The strip does not scroll sideways or spill over the header.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});

test("a typed phrase becomes a chip and a draft that survives a reload, Reset takes it back, and Save as view makes it a view of its own (COL-3, COL-5)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/base/${fx.topId}/${fx.tableId}/${fx.views.open}`);
  const bar = page.getByRole("combobox", { name: "Filter or search" });
  const chip = page.getByRole("button", { name: "Name contains north", exact: true });
  const changes = page.getByText(/These changes are only for now/);
  const savedFilter = async (name: string) => (await fx.load()).views.find((v) => v.name === name);

  await test.step("a phrase and Enter apply a chip, and the changes bar counts what it shows", async () => {
    await bar.fill("name contains north");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(chip).toBeVisible();
    await expect(page.getByText("Showing 1 of 3 records.")).toBeVisible();
    await expect(changes).toBeVisible();
    // Nothing is saved: the view as the server has it still has no filter.
    expect((await savedFilter("Open deals"))?.config?.filter ?? null).toBeNull();
  });

  await test.step("the draft is still there after a reload", async () => {
    await page.reload();
    await expect(chip).toBeVisible();
    await expect(changes).toBeVisible();
  });

  await test.step("Reset takes the draft back and the bar goes", async () => {
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(chip).toHaveCount(0);
    await expect(changes).toBeHidden();
    await page.reload();
    await expect(chip).toHaveCount(0);
    await expect(changes).toBeHidden();
  });

  await test.step("Save as view names the draft after its chips, and the view becomes a tab", async () => {
    await bar.fill("name contains north");
    await page.keyboard.press("Enter");
    await expect(chip).toBeVisible();
    await page.getByRole("button", { name: "Save as view", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Save as view" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue(/north/i);
    await name.fill("Northern clients");
    await dialog.getByRole("radio", { name: "Everyone" }).check();
    await dialog.getByRole("button", { name: "Save as view" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: "Northern clients" })).toHaveAttribute("aria-selected", "true");
    // The new view carries the filter; the view it came from is as it was; the draft is spent.
    await expect.poll(async () => (await savedFilter("Northern clients"))?.config?.filter ?? null).not.toBeNull();
    expect((await savedFilter("Open deals"))?.config?.filter ?? null).toBeNull();
    await expect(changes).toBeHidden();
    await expect(page.getByText("1 item")).toBeVisible();
  });
});

test("View options switches the layout as a draft: the tab keeps its own, a reload keeps the draft, only Save as view keeps the layout, and Reset goes back (COL-5, COL-6)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/base/${fx.topId}/${fx.tableId}/${fx.views.open}`);
  const grid = page.locator("canvas[data-testid='data-grid-canvas']");
  const cards = page.getByRole("button", { name: "Northwind", exact: true });
  await expect(grid.first()).toBeVisible();

  await test.step("a tile of the Layout group switches the layout, and says which one is on", async () => {
    const panel = page.getByRole("dialog", { name: "View options" });
    await page.getByRole("button", { name: "View options" }).click();
    await expect(panel.getByRole("button", { name: "Grid", pressed: true })).toBeVisible();
    await panel.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Gallery" }).click();
    await expect(panel.getByRole("button", { name: "Gallery", pressed: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cards).toBeVisible();
    await expect(grid).toHaveCount(0);
  });

  await test.step("it is a draft: the tab is still the saved grid, and a different layout offers Save as view, not Update view", async () => {
    await expect(page.getByText(/These changes are only for now/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as view", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update view" })).toHaveCount(0);
    expect((await fx.load()).views.find((v) => v.id === fx.views.open)).toMatchObject({ name: "Open deals" });
    await page.reload();
    await expect(cards).toBeVisible();
  });

  await test.step("Reset puts the saved layout back", async () => {
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(grid.first()).toBeVisible();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText(/These changes are only for now/)).toBeHidden();
  });
});

test.describe("on a phone", () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices["iPhone 13"];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });

  test("a 12-character name has the whole row, the header's buttons are 44 px, and a held press opens a view's menu", async ({ page }) => {
    const fx = await seed(page.request, "Archive 2025");
    await page.goto(`/base/${fx.topId}/${fx.tableId}`);
    const header = page.getByRole("main").locator("header").first();

    await test.step("the name is whole and the page does not scroll sideways", async () => {
      const title = page.getByRole("heading", { level: 1, name: "Archive 2025" });
      await expect(title).toBeVisible();
      expect(await title.locator("span.truncate").evaluate((el) => el.scrollWidth - el.clientWidth), "the title is cut off").toBeLessThanOrEqual(0);
      await expect(page.getByText("3 records")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await expect(page.getByRole("tab", { name: "All archive 2025" })).toBeVisible();
    });

    await test.step("the header holds the back link, Share, + and the search, each at least 44 px", async () => {
      await expect(header.getByRole("link", { name: "Back to Collections" })).toBeVisible();
      for (const name of ["Share", "New record", "Search everything"]) {
        const box = (await header.getByRole("button", { name }).boundingBox())!;
        expect(box.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
        expect(box.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
      }
      const tab = (await page.getByRole("tab", { name: "All archive 2025" }).boundingBox())!;
      expect(tab.height, "tab height").toBeGreaterThanOrEqual(43.5);
    });

    await test.step("a press held on a view's tab, released without moving, opens its menu as a sheet", async () => {
      // Pipeline is in More at this width: Open deals is the tab on the strip.
      const box = (await page.getByRole("tab", { name: "Open deals" }).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.waitForTimeout(450);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const sheet = page.getByRole("dialog", { name: "Open deals" });
      await expect(sheet.getByRole("button", { name: "Rename view" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Move left" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      // Still on the view it was on: the press that ended the hold chose nothing.
      await expect(page.getByRole("tab", { name: "All archive 2025" })).toHaveAttribute("aria-selected", "true");
      await expect(page).not.toHaveURL(new RegExp(`/${fx.views.open}$`));
    });

    await test.step("the settings are a full-screen sheet with Save in reach", async () => {
      await page.getByRole("button", { name: "Collection settings" }).tap();
      const settings = page.getByRole("dialog", { name: "Collection settings" });
      await expect(settings).toBeVisible();
      await settings.getByLabel("Record name").fill("account");
      // The sheet slides up for 240 ms: Save is measured once it has come to rest.
      await expect
        .poll(async () => {
          const save = (await settings.getByRole("button", { name: "Save" }).boundingBox())!;
          return save.y + save.height;
        }, { message: "Save is on the screen" })
        .toBeLessThanOrEqual(viewport.height);
      await settings.getByRole("button", { name: "Save" }).tap();
      await expect(settings).toBeHidden();
      await expect(header.getByRole("button", { name: "New account" })).toBeVisible();
    });
  });
});
