import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, skipIntro, test } from "./fixtures";

/**
 * "Search everything" from inside a project: the button in the screen's header opens the box, which shows
 * where the text matched (a highlighted snippet of a rich text field, as plain text); "This project"
 * narrows it. On a desktop and on a phone alike it is that button, and the header's other items stay in
 * place. Signs up its own users. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

/** A user with two projects; the first has a record whose rich text notes mention marketing. */
async function seed(request: APIRequestContext, projectName: string): Promise<{ baseId: string; recordId: string }> {
  const email = `e2e-search-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Search E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await (await request.post("/api/workspaces", { data: { name: "Search workspace" }, headers: CSRF })).json();
  const base = await (await request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: projectName }, headers: CSRF })).json();
  await request.post(`/api/workspaces/${ws.id}/bases`, { data: { name: "Marketing site" }, headers: CSRF });
  const table = base.tables[0] as { id: string; primary_field_id: string };
  const notes = await (await request.post(`/api/tables/${table.id}/fields`, { data: { name: "Notes", type: "rich_text", options: {} }, headers: CSRF })).json();
  const values = {
    [table.primary_field_id]: "Spring launch",
    [notes.id]: "Kickoff is booked for Monday, and Steven will be in charge of **marketing**. That may mean a few late nights before the launch, so plan ahead.",
  };
  const created = await request.post(`/api/tables/${table.id}/records`, { data: { records: [{ values }] }, headers: CSRF });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { baseId: base.id, recordId: (await created.json()).records[0].id };
}

test("searches from inside a project and shows where the text matched", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { baseId, recordId } = await seed(page.request, "Launch plan");
  await page.goto(`/base/${baseId}`);
  // The screen's own header holds the search button; nothing spans the app.
  const header = page.getByRole("main").locator("header");
  await header.getByRole("button", { name: "Search everything" }).click();
  const dialog = page.getByRole("dialog", { name: "Search everything" });
  const box = dialog.getByRole("combobox", { name: "Search everything" });
  await expect(box).toBeVisible();

  await box.fill("mark");
  const results = page.getByRole("listbox", { name: "Search results" });
  const record = results.getByRole("option", { name: /Spring launch/ });
  // The rich text's words around the match, without its Markdown, with the match marked.
  await expect(record).toContainText("Notes: …for Monday, and Steven will be in charge of marketing. That may mean");
  await expect(record).not.toContainText("**");
  await expect(record.locator("mark")).toHaveText("mark");
  await expect(results.getByRole("option", { name: /Marketing site/ }).locator("mark")).toHaveText("Mark");

  // This project only: the other project is not in it.
  await page.getByRole("group", { name: "Search in" }).getByRole("button", { name: "This project" }).click();
  await expect(results.getByRole("option", { name: /Marketing site/ })).toHaveCount(0);
  await expect(record).toBeVisible();
  await record.click();
  await expect(page).toHaveURL(new RegExp(`/base/${baseId}/[^/]+/[^/?]+\\?record=${recordId}`));

  // ⌘K / Ctrl+K opens the box from anywhere on the page, once the record is closed.
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+k");
  await expect(box).toBeFocused();
});

test("is a button in the header, on a desktop and on a phone, and the header does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const { baseId } = await seed(page.request, "A project with a name long enough to crowd the header of the window");
  await page.goto(`/base/${baseId}`);
  const header = page.getByRole("main").locator("header");
  const button = header.getByRole("button", { name: "Search everything" });
  await expect(button).toBeVisible();
  await expect(header.getByRole("combobox")).toHaveCount(0);
  // The button is the header's last item; the header does not scroll or spill over.
  const share = await header.getByRole("button", { name: "Share" }).boundingBox();
  const at = await button.boundingBox();
  expect(at!.x).toBeGreaterThan(share!.x);
  expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

  await button.click();
  const dialog = page.getByRole("dialog", { name: "Search everything" });
  await dialog.getByRole("combobox", { name: "Search everything" }).fill("steven");
  await expect(dialog.getByRole("option", { name: /Spring launch/ }).locator("mark")).toHaveText("Steven");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A phone: the same button, and the page is no wider than the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await button.click();
  await dialog.getByRole("combobox", { name: "Search everything" }).fill("plan ahead");
  await expect(dialog.getByRole("option", { name: /Spring launch/ }).locator("mark")).toHaveText("plan ahead");
});
