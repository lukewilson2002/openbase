import type { Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { devices } from "@playwright/test";
import { expect, skipIntro, test } from "./fixtures";

/**
 * The app on a phone: an iPhone-sized touch screen (Playwright's "iPhone 13" metrics in Chrome). The
 * project (a base), its menu drawer and its record panel must fit the screen without horizontal scrolling (a page
 * wider than the screen makes the phone zoom it out), and every focusable text field must be at least
 * 16px, or iOS Safari zooms the page in when it is tapped. The icon picker opens as a bottom sheet
 * inside the screen and closes on a tap outside. Signs up its own users. Runs only with
 * OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices["iPhone 13"];
test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

/** How far the page is wider than the screen, and the text fields under 16px. */
async function measure(page: Page): Promise<{ overflow: number; small: string[] }> {
  return page.evaluate(() => {
    const fields = document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea, select");
    const small = [...fields]
      .filter((el) => el.getClientRects().length > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.id}" ${getComputedStyle(el).fontSize}`);
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small };
  });
}

async function expectFits(page: Page, where: string): Promise<void> {
  const m = await measure(page);
  expect(m.overflow, `${where}: page wider than the screen`).toBeLessThanOrEqual(0);
  expect(m.small, `${where}: text fields under 16px make iOS zoom in`).toEqual([]);
}

test("the project, the menu, its toolbar and the record panel fit a phone", async ({ page }) => {
  const email = `e2e-mobile-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Mobile workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "A base with a fairly long name" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string };
  const created = await (await page.request.post(`/api/tables/${table.id}/records`, { data: { records: [{ values: {} }] }, headers: CSRF })).json();
  const recordId = created.records[0].id as string;

  // `/` is the Inbox (it no longer opens the last project): a capture box that fits the phone. The menu leads on.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expectFits(page, "inbox");
  await page.getByRole("button", { name: /^Show menu/ }).tap();
  const inboxMenu = page.getByRole("dialog", { name: "Menu" });
  await expect(inboxMenu.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  // No workspace is open on the Inbox: unfold the only one and its project (names only fold), then open its table.
  await inboxMenu.getByRole("button", { name: "Expand Mobile workspace" }).tap();
  await inboxMenu.getByRole("list", { name: "Projects in Mobile workspace" }).getByRole("button", { name: "A base with a fairly long name", exact: true }).tap();
  await inboxMenu.getByRole("list", { name: /^Tables in / }).getByRole("link", { name: "Table 1" }).tap();
  await expect(page).toHaveURL(new RegExp(`/base/${base.id}/${table.id}/viw[^/]+$`));
  await expectFits(page, "project");

  await page.getByRole("button", { name: /^Show menu/ }).tap();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  await expect(drawer.getByRole("list", { name: "Projects in Mobile workspace" }).getByRole("button", { name: "A base with a fairly long name", exact: true })).toBeVisible();
  await expectFits(page, "menu drawer");
  // Folding a row is not navigating: the drawer stays open.
  await drawer.getByRole("button", { name: "Collapse A base with a fairly long name" }).tap();
  await expect(drawer).toBeVisible();
  // Folded by hand is remembered on this device: open it again for the steps below.
  await drawer.getByRole("button", { name: "Expand A base with a fairly long name" }).tap();
  await expect(drawer.getByRole("list", { name: /^Tables in / })).toBeVisible();
  await drawer.getByRole("button", { name: "Close menu" }).tap();
  await expect(drawer).toBeHidden();

  await page.goto(`/base/${base.id}/${table.id}`);
  const toolbar = page.getByRole("toolbar", { name: "View toolbar" });
  await expect(toolbar).toBeVisible();
  await expectFits(page, "base");
  // The top bar keeps Share as an icon, and Add floats at the bottom corner, clear of the screen edge.
  await expect(page.getByRole("banner").getByRole("button", { name: "Share" })).toBeVisible();
  const add = (await page.getByRole("button", { name: "Add record" }).boundingBox())!;
  expect(add.height).toBeGreaterThanOrEqual(48);
  expect(add.x + add.width, "Add inside the screen").toBeLessThanOrEqual(viewport.width);
  expect(add.y + add.height, "Add inside the screen").toBeLessThanOrEqual(viewport.height);

  // The base's menu is the drawer; choosing a table closes it.
  await page.getByRole("button", { name: /^Show menu/ }).tap();
  const baseMenu = page.getByRole("dialog", { name: "Menu" });
  await expect(baseMenu.getByRole("list", { name: /^Tables in / })).toBeVisible();
  await expect(baseMenu.getByRole("button", { name: "Collapse Mobile workspace" })).toBeVisible();
  await expectFits(page, "base menu drawer");
  await baseMenu.getByRole("list", { name: /^Tables in / }).getByRole("link", { name: "Table 1" }).tap();
  await expect(baseMenu).toBeHidden();

  await toolbar.getByRole("button", { name: "Search records (Ctrl+F)" }).click();
  await expect(page.getByRole("searchbox", { name: "Search records" })).toBeFocused();
  await expectFits(page, "search");
  await page.keyboard.press("Escape");

  // On a phone the tools are one menu behind a sliders button.
  await toolbar.getByRole("button", { name: /^Tools/ }).click();
  await page.getByRole("menu", { name: "View tools" }).getByRole("menuitem", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Operator" })).toBeVisible();
  await expectFits(page, "filter");
  await page.keyboard.press("Escape");

  await page.goto(`/base/${base.id}/${table.id}?record=${recordId}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Write a comment" })).toBeVisible();
  await expectFits(page, "record panel");
});

test("the icon picker opens as a sheet that fits the screen, without the keyboard, and a tap outside closes only it", async ({ page }) => {
  const email = `e2e-mobile-icon-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
  await expectFits(page, "first workspace");
  await page.getByRole("button", { name: /^Show menu/ }).tap();
  await page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name: "New workspace" }).tap();
  const create = page.getByRole("dialog", { name: "New workspace" });
  await create.getByRole("textbox", { name: "Name" }).fill("Kitchen");
  await create.getByRole("button", { name: "Choose icon" }).tap();

  const sheet = page.getByRole("dialog", { name: "Choose icon" });
  await expect(sheet.getByTestId("icon-list")).toBeVisible();
  const box = (await sheet.boundingBox())!;
  const screen = page.viewportSize()!;
  expect(box.y, "sheet top").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "sheet bottom").toBeLessThanOrEqual(screen.height + 0.5);
  expect(box.width, "sheet width").toBeLessThanOrEqual(screen.width);
  await expect(sheet.getByRole("searchbox", { name: "Search icons" })).not.toBeFocused();
  await expectFits(page, "icon picker");

  // Above the sheet is the backdrop.
  await page.touchscreen.tap(screen.width / 2, box.y / 2);
  await expect(sheet).toBeHidden();
  await expect(create).toBeVisible();
  await expect(create.getByRole("button", { name: "Choose icon" })).toBeFocused();

  await create.getByRole("button", { name: "Choose icon" }).tap();
  await sheet.getByRole("button", { name: "Truck" }).tap();
  await expect(sheet).toBeHidden();
  await expect(create.getByRole("button", { name: "Change icon" })).toBeVisible();
});

/** A one-finger swipe from (x, y) by dy, sent as real touch events (Playwright only has taps). */
async function swipe(page: Page, x: number, y: number, dy: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: at }] });
  await touch("touchStart", y);
  const steps = 10;
  for (let i = 1; i <= steps; i++) await touch("touchMove", y + (dy * i) / steps);
  await touch("touchEnd", y + dy);
  await cdp.detach();
}

test("a swipe that starts on a menu button scrolls the menu and opens nothing; a tap opens it", async ({ page }) => {
  const email = `e2e-mobile-swipe-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Swipe workspace" }, headers: CSRF })).json();
  // Enough projects that the drawer has to scroll.
  for (let i = 1; i <= 24; i++) {
    const res = await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: `Project ${String(i).padStart(2, "0")}`, empty: true }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto("/");
  await page.getByRole("button", { name: /^Show menu/ }).tap();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  // `/` is the Inbox, outside any workspace: open this one to list its projects.
  await drawer.getByRole("button", { name: "Expand Swipe workspace" }).tap();
  await expect(drawer.getByRole("button", { name: "Project options for Project 24" })).toBeAttached();
  const scroller = drawer.locator("[data-sidebar-scroll]");
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight), "the menu has to scroll for this test").toBeGreaterThan(100);

  // Start the swipe on a row's "…" button and drag up.
  const more = drawer.getByRole("button", { name: "Project options for Project 05" });
  await more.scrollIntoViewIfNeeded();
  const box = (await more.boundingBox())!;
  const before = await scroller.evaluate((el) => el.scrollTop);
  await swipe(page, box.x + box.width / 2, box.y + box.height / 2, -240);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), "the swipe scrolled the menu").toBeGreaterThan(before);
  await expect(page.getByRole("menu")).toHaveCount(0);

  // A tap on the same button opens its menu.
  await more.scrollIntoViewIfNeeded();
  await more.tap();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Rename project/ })).toBeVisible();
});
