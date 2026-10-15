import type { Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { devices } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The app on a phone: an iPhone-sized touch screen (Playwright's "iPhone 13" metrics in Chrome). The
 * home page, a base and its record panel must fit the screen without horizontal scrolling (a page
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

test("the home page, a base, its toolbar and the record panel fit a phone", async ({ page }) => {
  const email = `e2e-mobile-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await page.request.post("/api/auth/signup", { data: { email, name: "Mobile E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  const ws = await (await page.request.post("/api/workspaces", { data: { name: "Mobile workspace" }, headers: CSRF })).json();
  const base = await (await page.request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "A base with a fairly long name" }, headers: CSRF })).json();
  const table = base.tables[0] as { id: string };
  const created = await (await page.request.post(`/api/tables/${table.id}/records`, { data: { records: [{ values: {} }] }, headers: CSRF })).json();
  const recordId = created.records[0].id as string;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expectFits(page, "home");

  await page.goto(`/base/${base.id}/${table.id}`);
  const toolbar = page.getByRole("toolbar", { name: "View toolbar" });
  await expect(toolbar).toBeVisible();
  await expectFits(page, "base");

  await toolbar.getByRole("button", { name: "Search records (Ctrl+F)" }).click();
  await expect(page.getByRole("searchbox", { name: "Search records" })).toBeFocused();
  await expectFits(page, "search");
  await page.keyboard.press("Escape");

  await toolbar.getByRole("button", { name: "Filter" }).click();
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

  await page.goto("/");
  await page.getByRole("button", { name: "New workspace" }).first().tap();
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
