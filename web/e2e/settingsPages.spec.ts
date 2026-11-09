import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, skipIntro, test } from "./fixtures";

/**
 * History, Trash, the workspace's settings and members, and the account against the real server (APP-9, APP-10,
 * APP-12, APP-13, APP-14, AGT-5): filters as chips in a bar, kind chips and the color marks of the Trash, the top-level
 * chooser, a week start saved on the profile, a token made at Full access, and no horizontal scroll on a phone.
 * Signs up its own user. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

async function send<T>(request: APIRequestContext, method: "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, { data, headers: CSRF });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** A user with a workspace: Notes at its top level (two records, one edited and one deleted), a folder Garden with Plants and a deleted Tools. */
async function seed(request: APIRequestContext) {
  const email = `e2e-settings-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Settings E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await send<{ id: string }>(request, "post", "/api/workspaces", { name: "Settings workspace" });
  const list = (await (await request.get("/api/workspaces")).json()) as { id: string; root_base_id: string }[];
  const top = list.find((w) => w.id === ws.id)!.root_base_id;
  const notes = await send<{ id: string; primary_field_id: string }>(request, "post", `/api/bases/${top}/tables`, { name: "Notes" });
  const made = await send<{ records: { id: string }[] }>(request, "post", `/api/tables/${notes.id}/records`, {
    records: [{ values: { [notes.primary_field_id]: "Keep" } }, { values: { [notes.primary_field_id]: "Discard" } }],
    typecast: true,
  });
  await send(request, "patch", `/api/tables/${notes.id}/records`, { records: [{ id: made.records[0]!.id, values: { [notes.primary_field_id]: "Kept" } }], typecast: true });
  await send(request, "delete", `/api/tables/${notes.id}/records`, { ids: [made.records[1]!.id] });
  const garden = await send<{ id: string }>(request, "post", `/api/workspaces/${ws.id}/bases`, { name: "Garden", empty: true });
  await send(request, "post", `/api/bases/${garden.id}/tables`, { name: "Plants" });
  const tools = await send<{ id: string }>(request, "post", `/api/bases/${garden.id}/tables`, { name: "Tools" });
  await send(request, "delete", `/api/tables/${tools.id}`);
  return { workspaceId: ws.id, topId: top, gardenId: garden.id, notesId: notes.id, keptId: made.records[0]!.id };
}

test("the Trash lists each item with its color mark, who deleted it and the days left, filters by kind and place, and restores", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  const fx = await seed(page.request);
  await page.goto("/trash");
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();

  const items = page.getByRole("list", { name: "Deleted items" });
  const tools = items.getByRole("listitem").filter({ hasText: "Tools" });
  await expect(tools).toContainText("Collection in Settings workspace › Garden");
  await expect(tools).toContainText("Deleted by you");
  await expect(tools).toContainText(/30 days left/);
  await expect(tools.locator(".ob-mark-14")).toHaveCount(1);
  // No icon tile stands for a kind or a place any more.
  await expect(items.locator("svg")).toHaveCount(0);

  await test.step("kind chips narrow the list", async () => {
    await page.getByRole("button", { name: "Records", exact: true }).click();
    await expect(page.getByRole("button", { name: "Records", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(items.getByRole("listitem")).toHaveCount(1);
    await expect(items).toContainText("Discard");
    await page.getByRole("button", { name: "Collections", exact: true }).click();
    await expect(items.getByRole("listitem")).toHaveCount(1);
    await expect(items).toContainText("Tools");
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

  await test.step("the place filter is a chip in a bar", async () => {
    const bar = page.getByRole("combobox", { name: "Filter the trash" });
    await bar.fill("garden");
    await page.getByRole("option", { name: /Folder: Garden/ }).click();
    await expect(page).toHaveURL(new RegExp(`base=${fx.gardenId}`));
    await expect(page.getByRole("button", { name: "Remove Folder: Garden" })).toBeVisible();
    await expect(items.getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove Folder: Garden" }).click();
    await expect(items.getByRole("listitem")).toHaveCount(2);
  });

  await test.step("Restore brings a collection back", async () => {
    await page.getByRole("button", { name: "Restore Tools" }).click();
    await expect(items.getByRole("listitem").filter({ hasText: "Tools" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: /^Tools/ })).toBeVisible();
  });
});

test("History filters by chips, groups activity on a record and links to the record page", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  const fx = await seed(page.request);
  await page.goto("/history");
  await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();

  // Kept was created, then another record was, then Kept was edited: two runs on the record, newest first.
  const card = page.getByRole("article", { name: "Activity on Kept" }).first();
  await expect(card).toBeVisible();
  // The place is three marks beside three names, with no tiles.
  await expect(card.locator(".ob-mark-8")).toHaveCount(2);
  await expect(card).toContainText("Settings workspace");
  await expect(card.getByRole("link", { name: "Kept" })).toHaveAttribute("href", `/base/${fx.topId}/${fx.notesId}/r/${fx.keptId}`);

  const bar = page.getByRole("combobox", { name: "Filter the history" });
  await bar.fill("deleted");
  await page.getByRole("option", { name: /Kind: Deleted/ }).click();
  await expect(page).toHaveURL(/kind=delete/);
  // The feed keeps the old cards on screen until the filtered one arrives, so wait for it to be the only one.
  await expect(page.getByRole("article", { name: "Activity on Discard" })).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Activity on Kept" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove Kind: Deleted" }).click();
  await expect(page.getByRole("article", { name: "Activity on Kept" }).first()).toBeVisible();

  await card.getByRole("link", { name: "Kept" }).click();
  await expect(page).toHaveURL(new RegExp(`/base/${fx.topId}/${fx.notesId}/r/${fx.keptId}`));
});

test("the workspace settings move the top level, and Members lists folder access", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change color…" })).toBeVisible();

  const current = page.getByRole("listitem").filter({ hasText: "Top level now" });
  await expect(current).toHaveCount(1);
  await page.getByRole("button", { name: "Use Garden as top level" }).click();
  await expect(page.getByText("Garden is now the top level")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Top level now" })).toContainText("Garden");

  await page.getByRole("button", { name: "Delete workspace" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete Settings workspace?");
  await expect(confirm).toContainText(/move to the trash for 30 days/);
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/workspace/${fx.workspaceId}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByText("Everyone here has one role. You choose which folders each person can open.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Members" })).toContainText("Settings E2E");
});

test("the account saves a week start and makes a token at Full access", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await seed(page.request);
  await page.goto("/account");
  await page.getByLabel("Week starts on").selectOption("1");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Week starts on")).toHaveValue("1");
  expect(((await (await page.request.get("/api/auth/me")).json()) as { week_start: number }).week_start).toBe(1);

  await page.goto("/account?tab=tokens");
  await page.getByRole("button", { name: "New token" }).click();
  const dialog = page.getByRole("dialog", { name: "New API token" });
  await dialog.getByLabel("Name", { exact: true }).fill("Agent");
  await expect(dialog.getByRole("radio", { name: "Read", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Full access" }).check();
  await dialog.getByRole("button", { name: "Create token" }).click();
  await page.getByRole("dialog", { name: "Copy your new token" }).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("list", { name: "API tokens" }).getByRole("listitem").filter({ hasText: "Agent" })).toContainText("Full access");
});

test("these pages fit a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fx = await seed(page.request);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const path of ["/history", "/trash", `/workspace/${fx.workspaceId}/settings`, `/workspace/${fx.workspaceId}/members`, "/account", "/account?tab=tokens", "/account?tab=sessions", "/account?tab=assistants"]) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await overflow(), path).toBeLessThanOrEqual(0);
  }
});
