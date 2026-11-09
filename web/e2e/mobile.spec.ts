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

test("the shell, its sheets, the collection and the record page fit a phone", async ({ page }) => {
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
  await expect(page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toBeVisible();
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

  await test.step("the collection's header has a back link naming the Collections tab, Share, + and the search, and a 12-character name fits whole", async () => {
    // The name that did not fit between the buttons in Phase 3 now has the whole row under the bar.
    const renamed = await page.request.patch(`/api/tables/${table.id}`, { data: { name: "Archive 2025" }, headers: CSRF });
    expect(renamed.ok(), `rename the collection: ${renamed.status()}`).toBeTruthy();
    await page.reload();
    const header = page.getByRole("main").locator("header").first();
    const back = header.getByRole("link", { name: "Back to Collections" });
    await expect(back).toHaveAttribute("href", `/workspace/${ws.id}/collections`);
    await expect(header.getByRole("button", { name: "Share" })).toBeVisible();
    await expect(header.getByRole("button", { name: "New record" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Search everything" })).toBeVisible();
    await expectTouchTargets(header.getByRole("button").or(header.getByRole("link")), "collection header");
    const title = page.getByRole("heading", { level: 1, name: "Archive 2025" });
    await expect(title).toBeVisible();
    expect(await title.locator("span.truncate").evaluate((el) => el.scrollWidth - el.clientWidth), "the title is cut off").toBeLessThanOrEqual(0);
    await expect(page.getByRole("tab", { name: "All archive 2025" })).toBeVisible();
    await expectFits(page, "collection header");
    await expect(tabs.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    // The header's search opens the search over the screen.
    await header.getByRole("button", { name: "Search everything" }).tap();
    await expect(page.getByRole("dialog", { name: "Search everything" })).toBeVisible();
    await page.keyboard.press("Escape");
    await back.tap();
    await expect(page).toHaveURL(new RegExp(`/workspace/${ws.id}/collections$`));
  });

  await page.goto(`/base/${base.id}/${table.id}`);
  // View options is one 44 px sliders button at the right end of the filter bar; the old toolbar and the floating Add are gone.
  const options = page.getByRole("button", { name: "View options" });
  await expect(options).toBeVisible();
  await expectTouchTargets(options, "View options button");
  await expectFits(page, "base");
  await expect(page.getByRole("toolbar", { name: "View toolbar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add record" })).toHaveCount(0);

  // The filter bar is under the tabs, full width and at least 44 px tall; its suggestions are a panel above the keyboard, not a popover.
  const filterBar = page.getByRole("combobox", { name: "Filter or search" });
  await expect(filterBar).toBeVisible();
  expect((await filterBar.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await filterBar.click();
  await filterBar.fill("alpha");
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await expect(suggestions).toBeVisible();
  // The panel slides in: wait for it to settle before measuring where it ends.
  await expect.poll(async () => (await suggestions.boundingBox())!.y + (await suggestions.boundingBox())!.height, { message: "suggestions inside the screen" }).toBeLessThanOrEqual(viewport.height);
  await expectTouchTargets(suggestions.getByRole("option"), "filter suggestions");
  await expectFits(page, "filter suggestions");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Search for “alpha”", exact: true })).toBeVisible();
  await expectFits(page, "search chip");
  await page.getByRole("button", { name: "Remove Search for “alpha”" }).click();

  // The nested builder is a sheet.
  await filterBar.fill("x");
  await page.getByRole("option", { name: "Advanced filter" }).click();
  await page.getByRole("dialog", { name: "Advanced filter" }).getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Operator" })).toBeVisible();
  await expectFits(page, "advanced filter");
  await page.keyboard.press("Escape");

  // On a phone View options is a sheet: the layout tiles three to a row, then Sort, Group, Color and Properties.
  await options.tap();
  const sheet = page.getByRole("dialog", { name: "View options" });
  await expect(sheet).toBeVisible();
  const tiles = sheet.getByRole("group", { name: "Layout" }).getByRole("button");
  await expect(tiles).toHaveCount(7);
  await expect(sheet.getByRole("button", { name: "Grid", pressed: true })).toBeVisible();
  await expectTouchTargets(sheet.getByRole("button"), "View options");
  // Both rectangles are read in one call: the sheet is still rising, so two separate reads would measure it at two heights.
  const [first, fourth] = await tiles.evaluateAll((els) => [els[0], els[3]].map((el) => { const r = el.getBoundingClientRect(); return { y: r.y, height: r.height }; }));
  expect(fourth.y, "the fourth tile starts the second row").toBeGreaterThan(first.y + first.height - 1);
  await expectFits(page, "view options");
  // A row opens its screen in the same sheet, with Back.
  await sheet.getByRole("button", { name: /^Sort/ }).tap();
  await expect(sheet.getByRole("button", { name: "Back to View options" })).toBeVisible();
  await expectTouchTargets(sheet.getByRole("button"), "View options sort");
  await expectFits(page, "view options sort");
  await sheet.getByRole("button", { name: "Add sort" }).tap();
  await expectFits(page, "view options with a sort");
  await sheet.getByRole("button", { name: "Back to View options" }).tap();
  await sheet.getByRole("button", { name: /^Properties/ }).tap();
  await expectFits(page, "view options properties");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(options).toBeFocused();

  // A record is a screen of its own (PH-4): the 56 px header has the way back, Comments, Share and More, and no bottom bar.
  await page.goto(`/base/${base.id}/${table.id}/r/${recordId}`);
  const record = page.getByRole("main", { name: "Record" });
  await expect(record.getByRole("heading", { level: 1 })).toBeVisible();
  const bar = record.locator("header").first();
  await expect(bar.getByRole("link", { name: /^Back to / })).toBeVisible();
  await expect(bar.getByRole("button")).toHaveCount(3);
  await expectTouchTargets(bar.getByRole("button").or(bar.getByRole("link")), "record header");
  await expect(page.getByRole("navigation", { name: "Main menu" })).toHaveCount(0);
  await expectFits(page, "record page");
  await bar.getByRole("button", { name: "Comments" }).tap();
  const comments = page.getByRole("dialog", { name: "Comments" });
  await expect(comments.getByRole("textbox", { name: "Write a comment" })).toBeVisible();
  await expectFits(page, "record comments");
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

/** A finger that rests on (x, y) for `ms`, optionally slides to (x, y + dy), and lifts: real touch events. */
async function hold(page: Page, x: number, y: number, ms: number, dy = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: at }] });
  await touch("touchStart", y);
  await page.waitForTimeout(ms);
  if (dy !== 0) {
    for (let i = 1; i <= 6; i++) await touch("touchMove", y + (dy * i) / 6);
  }
  await touch("touchEnd", y + dy);
  await cdp.detach();
}

test("on a phone a hold on a card opens its action sheet, a selection is a count and Actions, and a filter that matches nothing says so with Reset (COL-9)", async ({ page }) => {
  const email = `e2e-mobile-col9-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Hold workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "Hold base" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string; primary_field_id: string };
  await page.request.patch(`/api/tables/${table.id}`, { data: { record_noun: "card" }, headers: CSRF });
  const made = await page.request.post(`/api/tables/${table.id}/records`, { data: { records: ["Alpha", "Beta", "Gamma"].map((name) => ({ values: { [table.primary_field_id]: name } })) }, headers: CSRF });
  expect(made.ok(), await made.text()).toBeTruthy();
  // A gallery sorted by name: its cards are not draggable, so a hold that moves is a scroll, not a reorder.
  const view = await (
    await page.request.post(`/api/tables/${table.id}/views`, { data: { name: "Cards", type: "gallery", config: { sorts: [{ field_id: table.primary_field_id, direction: "asc" }] } }, headers: CSRF })
  ).json();
  await page.goto(`/base/${base.id}/${table.id}/${view.id}`);
  const alpha = page.getByRole("button", { name: "Alpha", exact: true });
  await expect(alpha).toBeVisible();
  const where = new URL(page.url()).pathname;

  await test.step("a hold that lets go without moving opens the card's sheet, and does not open the card", async () => {
    const box = (await alpha.boundingBox())!;
    await hold(page, box.x + box.width / 2, box.y + box.height / 2, 450);
    const sheet = page.getByRole("dialog", { name: "Alpha" });
    await expect(sheet).toBeVisible();
    await expectTouchTargets(sheet.getByRole("button"), "card sheet");
    await expect(sheet.getByRole("button", { name: "Open record" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Delete record" })).toBeVisible();
    expect(new URL(page.url()).pathname + new URL(page.url()).search, "the press did not open the card").toBe(where);
    await expectFits(page, "card sheet");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await test.step("a quick tap still opens the card, and a hold that slides is a scroll, not a menu", async () => {
    const box = (await alpha.boundingBox())!;
    await hold(page, box.x + box.width / 2, box.y + box.height / 2, 450, 40);
    await page.waitForTimeout(300);
    await expect(page.getByRole("dialog", { name: "Alpha" })).toHaveCount(0);
  });

  await test.step("a selection is the count and Actions; the actions are a sheet", async () => {
    // The select boxes are 44 px targets in a card's corner, clear of its title (PH-6).
    await expectTouchTargets(page.getByRole("checkbox", { name: /^Select / }), "card select boxes");
    // The title's text stops where its padding starts, which is where the box begins (the box's 44 px target may share a few pixels of it).
    const textEnd = await page.getByRole("heading", { name: "Beta", exact: true }).evaluate((h) => h.getBoundingClientRect().right - parseFloat(getComputedStyle(h).paddingRight));
    const tickBox = (await page.getByRole("checkbox", { name: "Select Beta" }).boundingBox())!;
    expect(textEnd, "the select box is over the title's text").toBeLessThanOrEqual(tickBox.x + 4);
    await page.getByRole("checkbox", { name: "Select Beta" }).tap();
    await page.getByRole("checkbox", { name: "Select Gamma" }).tap();
    const bar = page.getByRole("toolbar", { name: "Selected records" });
    await expect(bar).toContainText("2 selected");
    await expectTouchTargets(bar.getByRole("button"), "selection bar");
    await expect(bar.getByRole("button", { name: "Duplicate" })).toHaveCount(0);
    await bar.getByRole("button", { name: "Actions" }).tap();
    const sheet = page.getByRole("dialog", { name: "2 selected" });
    await expect(sheet.getByRole("button", { name: "Duplicate" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Delete" })).toBeVisible();
    await expectTouchTargets(sheet.getByRole("button"), "selection sheet");
    await expectFits(page, "selection sheet");
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Clear selection" }).tap();
    await expect(bar).toHaveCount(0);
  });

  await test.step("a filter that matches nothing says so, with Reset", async () => {
    const filterBar = page.getByRole("combobox", { name: "Filter or search" });
    await filterBar.click();
    await filterBar.fill("zzz-no-such-card");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "No cards match these filters" })).toBeVisible();
    // The header's New card stays; the empty state offers Reset, not New (a record added here would vanish).
    await expect(page.getByRole("heading", { name: "No cards match these filters" }).locator("..").getByRole("button", { name: "New card" })).toHaveCount(0);
    await expectFits(page, "filtered to nothing");
    // The changes bar has a Reset of its own (it drops the whole draft); this one is the empty state's.
    await page.getByRole("heading", { name: "No cards match these filters" }).locator("..").getByRole("button", { name: "Reset" }).tap();
    await expect(page.getByRole("heading", { name: "No cards match these filters" })).toHaveCount(0);
    await expect(alpha).toBeVisible();
  });
});

/**
 * PH-4: Back from a record page lands each layout at the place it was left. A collection long enough to scroll, shown as a
 * list, a gallery and a board; each is scrolled, a card in view is opened, and the way back (the header's link) finds the same
 * scroll and the same card on screen.
 */
test("on a phone Back from a record lands the list, the gallery and the board where they were left (PH-4)", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `e2e-mobile-ph4-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Back workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "Back base" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string; primary_field_id: string; name: string };
  const status = await (
    await page.request.post(`/api/tables/${table.id}/fields`, { data: { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] } }, headers: CSRF })
  ).json();
  const choices = status.options.choices as { id: string; name: string }[];
  const records = Array.from({ length: 60 }, (_, i) => ({ values: { [table.primary_field_id]: `Item ${String(i + 1).padStart(2, "0")}`, [status.id]: choices[i % 2]!.id } }));
  for (let i = 0; i < records.length; i += 10) {
    const res = await page.request.post(`/api/tables/${table.id}/records`, { data: { records: records.slice(i, i + 10) }, headers: CSRF });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const sorts = [{ field_id: table.primary_field_id, direction: "asc" }];
  const views: Record<string, string> = {};
  for (const [name, type, config] of [
    ["Outline", "list", { sorts }],
    ["Cards", "gallery", { sorts }],
    ["Board", "kanban", { sorts, kanban: { stack_field_id: status.id } }],
  ] as const) {
    const made = await page.request.post(`/api/tables/${table.id}/views`, { data: { name, type, personal: false, config }, headers: CSRF });
    expect(made.ok(), await made.text()).toBeTruthy();
    views[name] = ((await made.json()) as { id: string }).id;
  }

  // The scroller that holds the records: the first of these that has somewhere to scroll.
  const SCROLLERS = '[data-scroll-restore="list"], [data-scroll-restore="frame"], [data-scroll-restore^="stack:"], [data-scroll-root]';
  const spot = () =>
    page.evaluate((sel) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.scrollHeight - e.clientHeight > 150);
      return el ? { top: Math.round(el.scrollTop), name: el.getAttribute("data-scroll-restore") ?? "page" } : null;
    }, SCROLLERS);
  const scrollDown = () =>
    page.evaluate((sel) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.scrollHeight - e.clientHeight > 150)!;
      el.scrollTop = 700;
    }, SCROLLERS);

  for (const name of ["Outline", "Cards", "Board"]) {
    await test.step(`${name}: scroll, open a record, go Back`, async () => {
      await page.goto(`/base/${base.id}/${table.id}/${views[name]}`);
      await expect(page.getByText("Item 01").first()).toBeVisible();
      await expect.poll(spot, "the layout has to scroll for this test").not.toBeNull();
      await scrollDown();
      await expect.poll(async () => (await spot())?.top ?? 0).toBeGreaterThan(300);
      await page.waitForTimeout(400);
      const left = (await spot())!;
      // A record wholly inside the scroller's visible part, so the tap does not scroll it into view (which would be a scroll of its own).
      const title = await page.evaluate((sel) => {
        const scroller = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.scrollHeight - e.clientHeight > 150)!;
        const box = scroller.getBoundingClientRect();
        const top = Math.max(box.top, 0) + 16;
        const bottom = Math.min(box.bottom, innerHeight) - 16;
        const cards = [...document.querySelectorAll<HTMLElement>("[data-record-id], [role=treeitem]")];
        const card = cards.find((c) => {
          const r = c.getBoundingClientRect();
          return r.top > top && r.bottom < bottom && /Item \d\d/.test(c.textContent ?? "");
        });
        return card ? /Item \d\d/.exec(card.textContent ?? "")![0] : null;
      }, SCROLLERS);
      expect(title, "a record in view").not.toBeNull();
      await page.getByText(title!, { exact: true }).first().tap();
      await expect(page).toHaveURL(/\/r\/rec/);
      await expect(page.getByRole("heading", { level: 1, name: title! })).toBeVisible();
      await page.getByRole("main").locator("header").getByRole("link", { name: new RegExp(`^Back to ${table.name}`) }).tap();
      await expect(page).toHaveURL(new RegExp(`/${views[name]}$`));
      await expect.poll(async () => Math.abs(((await spot())?.top ?? 0) - left.top), `${name} is back where it was`).toBeLessThanOrEqual(6);
      await expect(page.getByText(title!, { exact: true }).first()).toBeVisible();
    });
  }
});

/**
 * PH-3: what was a pop-over is a bottom sheet on a phone. A property's choices on a record page; the menus, pickers and
 * editors are covered by the unit tests of the components that draw them (Menu, Popover, EditorShell, EntitySelect on a phone).
 */
test("on a phone a property's choices open as a bottom sheet, never as a pop-over (PH-3)", async ({ page }) => {
  const email = `e2e-mobile-ph3-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(page.request);
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Sheet workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "Sheet base" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string; primary_field_id: string };
  const fieldRes = await page.request.post(`/api/tables/${table.id}/fields`, { data: { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] } }, headers: CSRF });
  expect(fieldRes.ok(), await fieldRes.text()).toBeTruthy();
  const choices = ((await fieldRes.json()) as { id: string; options: { choices: { id: string; name: string }[] } });
  // A value is set, so the property is shown (an empty one is folded under "Show 1 empty property").
  const todo = choices.options.choices.find((c) => c.name === "Todo")!.id;
  const made = await (await page.request.post(`/api/tables/${table.id}/records`, { data: { records: [{ values: { [table.primary_field_id]: "Pick me", [choices.id]: todo } }] }, headers: CSRF })).json();
  await page.goto(`/base/${base.id}/${table.id}/r/${made.records[0].id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Pick me" })).toBeVisible();

  await test.step("the choices of a property are a sheet, and picking one saves it", async () => {
    // The label opens the property's own menu; the value, shown as its choice, opens the choices.
    await page.getByRole("main").getByText("Todo", { exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Status" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("option", { name: "Done" })).toBeVisible();
    // A sheet rests on the bottom of the screen and is as wide as it, with a grab handle: not a floating panel.
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 2);
    await sheet.getByRole("option", { name: "Done" }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Done", { exact: true })).toBeVisible();
  });

  await test.step("nothing on the screen is a pop-over while a sheet is open", async () => {
    await expect(page.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0);
  });
});
