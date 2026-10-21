import { randomBytes } from "node:crypto";
import { ACCENT_THEMES } from "../src/theme/accents";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * The accent colour from the account menu's Appearance submenu against the real server: picking one
 * repaints the primary buttons at once, is saved on the account (so a reload, and another browser
 * signed in to the same account, paint it before anything else), and goes back to blue. Signs up
 * its own user. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1280, height: 900 } });

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const BLUE = rgb(ACCENT_THEMES.blue.light.primary);
const PURPLE = rgb(ACCENT_THEMES.purple.light.primary);

test("the accent colour repaints the app, is saved on the account and survives a reload", async ({ browser, page, context }, testInfo) => {
  const email = `e2e-appearance-${randomBytes(4).toString("hex")}@example.com`;
  const res = await page.request.post("/api/auth/signup", { data: { email, name: "Appearance E2E", password: PASSWORD }, headers: CSRF });
  expect(res.ok(), await res.text()).toBeTruthy();
  await skipIntro(page.request);

  await page.goto("/account");
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toHaveCSS("background-color", BLUE);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /^Appearance/ }).click();
  const colors = page.getByRole("group", { name: "Color" });
  await expect(colors.getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/auth/me") && r.request().method() === "PATCH");
  await colors.getByRole("menuitemradio", { name: "Purple" }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(colors.getByRole("menuitemradio", { name: "Purple" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Buttons fade between colours: toHaveCSS waits for the end.
  await expect(save).toHaveCSS("background-color", PURPLE);
  expect((await (await page.request.get("/api/auth/me")).json()).accent).toBe("purple");

  // A reload paints it before the profile arrives (theme-init.js reads the copy on this device).
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBe("purple");
  await expect(save).toHaveCSS("background-color", PURPLE);

  // Another browser signed in to the account gets it from the server.
  const other = await newClientContext(browser, testInfo, { baseURL: testInfo.project.use.baseURL, storageState: { cookies: await context.cookies(), origins: [] } }, "other");
  const otherPage = await other.newPage();
  await otherPage.goto("/account");
  await expect(otherPage.getByRole("button", { name: "Save changes" })).toHaveCSS("background-color", PURPLE);
  await other.close();

  // Blue again: the default, saved as no colour.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /^Appearance/ }).click();
  await page.getByRole("group", { name: "Color" }).getByRole("menuitemradio", { name: "Blue" }).click();
  // The open menu hides the page from the accessibility tree; close it (submenu, then menu).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(save).toHaveCSS("background-color", BLUE);
  await expect.poll(async () => (await (await page.request.get("/api/auth/me")).json()).accent).toBeNull();
});
