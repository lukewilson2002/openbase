import type { Locator, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { devices } from "@playwright/test";
import { expect, skipIntro, test } from "./fixtures";

/**
 * The app on a phone: an iPhone-sized touch screen (Playwright's "iPhone 13" metrics in Chrome, 390 px wide). The
 * phone shell (NAV-7, NAV-8, PH-1, PH-2) is a 64 px bottom navigation with three tabs, a 56 px header with 44 px
 * buttons, and the workspace switcher and profile menu as sheets; the Collections tab holds what the sidebar
 * holds. Every screen must fit without horizontal scrolling (a page wider than the screen makes the phone zoom it
 * out), and every focusable text field must be at least 16px, or iOS Safari zooms the page in when it is tapped.
 * The sidebar's row menus are sheets here too. Signs up its own users. Runs only with OPENBASE_E2E=1.
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

/** Every link and button in `scope` is at least 44 px each way (PH-6). */
async function expectTouchTargets(scope: Locator, where: string): Promise<void> {
  const small = await scope.evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "", box: el.getBoundingClientRect() }))
      .filter((e) => e.box.height < 43.5 || e.box.width < 43.5)
      .map((e) => `${e.name} ${Math.round(e.box.width)}x${Math.round(e.box.height)}`),
  );
  expect(small, `${where}: targets under 44 px`).toEqual([]);
}

test("the shell, its sheets, the collection and the record panel fit a phone", async ({ page }) => {
  const email = `e2e-mobile-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Mobile workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "A base with a fairly long name" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string };
  const created = await (await page.request.post(`/api/tables/${table.id}/records`, { data: { records: [{ values: {} }] }, headers: CSRF })).json();
  const recordId = created.records[0].id as string;

  // `/` is the last workspace's Home: a capture box that fits the phone, under the header with the switcher, the avatar and the search.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workspace/${ws.id}$`));
  await expectFits(page, "home");
  // There is no drawer and no menu button: the bottom navigation is the main menu.
  await expect(page.getByRole("button", { name: /^(Show|Hide) menu/ })).toHaveCount(0);
  const tabs = page.getByRole("navigation", { name: "Main menu" });
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Collections", "Notifications"]);
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  await test.step("the bar is 64 px above the home indicator, with 22 px icons and 12 px labels", async () => {
    const bar = (await tabs.boundingBox())!;
    expect(bar.height).toBeGreaterThanOrEqual(64);
    expect(bar.y + bar.height, "the bar rests on the bottom of the screen").toBeCloseTo(viewport.height, 0);
    const home = tabs.getByRole("link", { name: "Home" });
    expect(await home.locator("svg").evaluate((el) => el.getBoundingClientRect().width)).toBe(22);
    expect(await home.locator("span").last().evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
    await expectTouchTargets(tabs.getByRole("link"), "tabs");
  });

  await test.step("the header holds the switcher, the avatar and the search, each 44 px, and the switcher opens a sheet", async () => {
    const header = page.getByRole("main").locator("header").first();
    expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await expectTouchTargets(header.getByRole("button"), "home header");
    await header.getByRole("button", { name: /^Mobile workspace/ }).tap();
    const sheet = page.getByRole("dialog", { name: "Switch workspace" });
    await expect(sheet.getByRole("button", { name: "Mobile workspace" })).toHaveAttribute("aria-current", "true");
    await expect(sheet.getByRole("button", { name: "New workspace" })).toBeVisible();
    await expectFits(page, "workspace switcher sheet");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await test.step("the avatar opens the profile menu as a sheet, with Escape returning focus to it", async () => {
    const avatar = page.getByRole("main").locator("header").first().getByRole("button", { name: "Account menu" });
    await avatar.tap();
    const sheet = page.getByRole("dialog", { name: "Account" });
    await expect(sheet.getByText(email)).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expectFits(page, "profile sheet");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(avatar).toBeFocused();
  });

  await test.step("the other tabs and the workspace's screens fit the phone", async () => {
    for (const [route, heading, label] of [
      [`/workspace/${ws.id}/collections`, "Collections", "collections"],
      ["/notifications", "Notifications", "notifications"],
      [`/workspace/${ws.id}/automations`, "Automations", "automations"],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expectFits(page, label);
    }
  });

  await test.step("the Collections tab holds the switcher, the folders and the footer, and opens a collection", async () => {
    await page.goto(`/workspace/${ws.id}/collections`);
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: /^Mobile workspace/ })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    for (const name of ["History", "Trash", "Workspace settings"]) await expect(main.getByRole("link", { name })).toBeVisible();
    await expect(main.getByRole("button", { name: "Account menu" })).toBeVisible();
    await expectTouchTargets(main.getByRole("link"), "collections tab links");
    const folder = main.getByRole("button", { name: "A base with a fairly long name", exact: true });
    await expect(folder).toBeVisible();
    // Folding a folder is not navigating.
    await folder.tap();
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    // Folded by hand is remembered on this device: open it again for the steps below.
    await folder.tap();
    await main.getByRole("list", { name: /^Collections in / }).getByRole("link", { name: /^Table 1/ }).tap();
    await expect(page).toHaveURL(new RegExp(`/base/${base.id}/${table.id}/viw[^/]+$`));
    await expectFits(page, "collection");
  });

  await test.step("the collection's header has a back link naming the Collections tab, and the search", async () => {
    const header = page.getByRole("main").locator("header").first();
    const back = header.getByRole("link", { name: "Back to Collections" });
    await expect(back).toHaveAttribute("href", `/workspace/${ws.id}/collections`);
    await expect(header.getByRole("button", { name: "Share" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Search everything" })).toBeVisible();
    await expectTouchTargets(header.getByRole("button").or(header.getByRole("link")), "collection header");
    await expect(tabs.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    // The header's search opens the search over the screen.
    await header.getByRole("button", { name: "Search everything" }).tap();
    await expect(page.getByRole("dialog", { name: "Search everything" })).toBeVisible();
    await page.keyboard.press("Escape");
    await back.tap();
    await expect(page).toHaveURL(new RegExp(`/workspace/${ws.id}/collections$`));
  });

  await page.goto(`/base/${base.id}/${table.id}`);
  const toolbar = page.getByRole("toolbar", { name: "View toolbar" });
  await expect(toolbar).toBeVisible();
  await expectFits(page, "base");
  // Add floats at the bottom corner, clear of the screen edge and of the bottom navigation.
  const add = (await page.getByRole("button", { name: "Add record" }).boundingBox())!;
  const bar = (await tabs.boundingBox())!;
  expect(add.height).toBeGreaterThanOrEqual(48);
  expect(add.x + add.width, "Add inside the screen").toBeLessThanOrEqual(viewport.width);
  expect(add.y + add.height, "Add above the bottom navigation").toBeLessThanOrEqual(bar.y);

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
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toBeVisible();
  await expectFits(page, "record panel");
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

test("a swipe that starts on a row's button scrolls the Collections tab and opens nothing; a tap opens its sheet", async ({ page }) => {
  const email = `e2e-mobile-swipe-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Swipe workspace" }, headers: CSRF })).json();
  // Enough folders that the screen has to scroll.
  for (let i = 1; i <= 24; i++) {
    const res = await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: `Project ${String(i).padStart(2, "0")}`, empty: true }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto(`/workspace/${ws.id}/collections`);
  const main = page.getByRole("main");
  await expect(main.getByRole("button", { name: "Folder options for Project 24" })).toBeAttached();
  const scrollY = () => page.evaluate(() => window.scrollY);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight), "the screen has to scroll for this test").toBeGreaterThan(100);

  // Start the swipe on a row's "…" button and drag up.
  const more = main.getByRole("button", { name: "Folder options for Project 05" });
  await more.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await more.boundingBox())!;
  const before = await scrollY();
  await swipe(page, box.x + box.width / 2, box.y + box.height / 2, -240);
  await expect.poll(scrollY, "the swipe scrolled the screen").toBeGreaterThan(before);
  await expect(page.getByRole("dialog", { name: "Project 05" })).toHaveCount(0);

  // A tap on the same button opens its menu, as a sheet named for the folder (PH-3).
  await more.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await more.tap();
  await expect(page.getByRole("dialog", { name: "Project 05" }).getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
});
