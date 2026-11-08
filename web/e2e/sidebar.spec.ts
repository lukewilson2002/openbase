import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, skipIntro, test } from "./fixtures";

/**
 * The sidebar against the real server (NAV-1 to NAV-4, NAV-6): its structure and record counts, folding folders
 * (kept across a reload), the collection and folder menus (color, move, new collection, new folder, use as top
 * level), the workspace switcher with the brand at its top, and Ctrl+\ to fold the whole sidebar. Signs up its
 * own user. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

interface Workspace {
  id: string;
  name: string;
  color: string;
  root_base_id: string | null;
  bases: { id: string; name: string; is_top_level: boolean; tables: { id: string; name: string; color: string; record_count: number }[] }[];
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(path, { data, headers: CSRF });
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const workspaces = async (request: APIRequestContext) => (await (await request.get("/api/workspaces")).json()) as Workspace[];

/** A user with a workspace: two collections at its top level (Notes with two records, Plans) and a folder, Garden, with two. */
async function seed(request: APIRequestContext) {
  const email = `e2e-sidebar-${randomBytes(4).toString("hex")}@example.com`;
  const signup = await request.post("/api/auth/signup", { data: { email, name: "Sidebar E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await post<{ id: string }>(request, "/api/workspaces", { name: "Sidebar workspace" });
  const top = (await workspaces(request)).find((w) => w.id === ws.id)!.root_base_id!;
  const notes = await post<{ id: string; primary_field_id: string }>(request, `/api/bases/${top}/tables`, { name: "Notes" });
  await post(request, `/api/bases/${top}/tables`, { name: "Plans" });
  await post(request, `/api/tables/${notes.id}/records`, { records: [{ values: { [notes.primary_field_id]: "One" } }, { values: { [notes.primary_field_id]: "Two" } }], typecast: true });
  const garden = await post<{ id: string }>(request, `/api/workspaces/${ws.id}/bases`, { name: "Garden", empty: true });
  await post(request, `/api/bases/${garden.id}/tables`, { name: "Plants" });
  await post(request, `/api/bases/${garden.id}/tables`, { name: "Tools" });
  return { workspaceId: ws.id, topId: top, gardenId: garden.id, notesId: notes.id };
}

test("shows the workspace's collections and folders, folds a folder for good, and colors a collection from its menu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}`);
  const nav = page.getByRole("navigation", { name: "Main menu" });

  await test.step("is a landmark with the switcher, search, Home, Notifications and Automations, then the collections", async () => {
    await expect(nav.getByRole("button", { name: /^Sidebar workspace/ })).toContainText("Switch workspace");
    await expect(nav.getByRole("button", { name: /^Search everything/ })).toContainText(/Ctrl K|⌘K/);
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: /^Notifications/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Automations" })).toBeVisible();
    // The top level's collections with their record counts, then the folders with theirs.
    await expect(nav.getByRole("list", { name: "Collections", exact: true }).getByRole("link")).toHaveText([/^Notes\s*2$/, /^Plans\s*0$/]);
    await expect(nav.getByRole("list", { name: "Collections in Garden" }).getByRole("link")).toHaveText([/^Plants/, /^Tools/]);
    for (const name of ["History", "Trash", "Workspace settings"]) await expect(nav.getByRole("link", { name })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Account menu" })).toContainText("Sidebar E2E");
  });

  await test.step("a collection opens in its last view, and its row is the selected one", async () => {
    await nav.getByRole("list", { name: "Collections", exact: true }).getByRole("link", { name: /^Notes/ }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.topId}/${fx.notesId}/viw`));
    await expect(nav.getByRole("link", { name: /^Notes/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  });

  await test.step("a folder folds on a click and stays folded after a reload", async () => {
    const garden = nav.getByRole("button", { name: "Garden", exact: true });
    await expect(garden).toHaveAttribute("aria-expanded", "true");
    await garden.click();
    await expect(garden).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("list", { name: "Collections in Garden" })).toHaveCount(0);
    await page.reload();
    await expect(nav.getByRole("button", { name: "Garden", exact: true })).toHaveAttribute("aria-expanded", "false");
    await nav.getByRole("button", { name: "Garden", exact: true }).click();
    await expect(nav.getByRole("list", { name: "Collections in Garden" })).toBeVisible();
  });

  await test.step("Color from a collection's menu keeps the choice on the server, and the mark shows it with no letter or icon", async () => {
    await nav.getByRole("button", { name: "Collection options for Plans" }).click();
    await page.getByRole("menuitem", { name: "Color" }).click();
    await page.getByRole("dialog", { name: "Collection color" }).getByRole("radio", { name: "Purple", exact: true }).click();
    await expect
      .poll(async () => {
        const ws = (await workspaces(page.request)).find((w) => w.id === fx.workspaceId)!;
        return ws.bases.find((b) => b.id === fx.topId)!.tables.find((t) => t.name === "Plans")!.color;
      })
      .toBe("purple");
    const mark = nav.getByRole("link", { name: /^Plans/ }).locator(".ob-mark");
    await expect(mark).toHaveClass(/ob-hue-purple/);
    await expect(mark).toBeEmpty();
    await expect(nav.getByRole("link", { name: /^Plans/ }).locator("svg")).toHaveCount(0);
  });

  await test.step("Move down in a collection's menu reorders it for everyone", async () => {
    await nav.getByRole("button", { name: "Collection options for Notes" }).click();
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect(nav.getByRole("list", { name: "Collections", exact: true }).getByRole("link")).toHaveText([/^Plans/, /^Notes/]);
    await expect
      .poll(async () => (await workspaces(page.request)).find((w) => w.id === fx.workspaceId)!.bases.find((b) => b.id === fx.topId)!.tables.map((t) => t.name))
      .toEqual(["Plans", "Notes"]);
  });
});

test("makes a collection and a folder from the +, and a folder becomes the top level", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}`);
  const nav = page.getByRole("navigation", { name: "Main menu" });

  await test.step("New collection goes into the top level and opens", async () => {
    await nav.getByRole("button", { name: "Add a collection or folder" }).click();
    await page.getByRole("menuitem", { name: "New collection", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New collection" });
    await dialog.getByLabel("Collection name").fill("Ideas");
    await dialog.getByRole("button", { name: "Create collection" }).click();
    await expect(page).toHaveURL(new RegExp(`/base/${fx.topId}/tbl[^/]+/viw`));
    await expect(nav.getByRole("list", { name: "Collections", exact: true }).getByRole("link", { name: /^Ideas/ })).toHaveAttribute("aria-current", "page");
  });

  await test.step("New folder opens its empty page, with the folder in the sidebar", async () => {
    await nav.getByRole("button", { name: "Add a collection or folder" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await dialog.getByLabel("Folder name").fill("Archive");
    await dialog.getByRole("button", { name: "Create folder" }).click();
    await expect(page.getByRole("heading", { name: "No collections in Archive yet" })).toBeVisible();
    await expect(nav.getByRole("list", { name: "Folders" }).getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  });

  await test.step("Use as top level moves only the pointer: Garden's collections move up, the old top level becomes a folder", async () => {
    await nav.getByRole("button", { name: "Folder options for Garden" }).click();
    await page.getByRole("menuitem", { name: "Use as top level" }).click();
    await expect(nav.getByRole("list", { name: "Collections", exact: true }).getByRole("link")).toHaveText([/^Plants/, /^Tools/]);
    await expect(nav.getByRole("list", { name: "Folders" }).getByRole("button", { name: "Garden", exact: true })).toHaveCount(0);
    // The old top-level project is now a folder, with its collections under it.
    await expect(nav.getByRole("list", { name: "Folders" }).getByRole("button", { name: "Sidebar workspace", exact: true })).toBeVisible();
    const ws = (await workspaces(page.request)).find((w) => w.id === fx.workspaceId)!;
    expect(ws.root_base_id).toBe(fx.gardenId);
  });

  await test.step("a folder that is not the top level can be deleted after confirming, and the sidebar drops it", async () => {
    await nav.getByRole("button", { name: "Folder options for Archive" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete folder" }).click();
    await expect(nav.getByRole("button", { name: "Folder options for Archive" })).toHaveCount(0);
  });
});

test("the switcher starts with the OpenBase mark, lists the workspaces and makes a new one; Ctrl+\\ folds the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = await seed(page.request);
  await page.goto(`/workspace/${fx.workspaceId}`);
  const nav = page.getByRole("navigation", { name: "Main menu" });

  await test.step("the brand is at the top of the menu and not in the switcher", async () => {
    const switcher = nav.getByRole("button", { name: /^Sidebar workspace/ });
    await expect(switcher.getByRole("img", { name: "OpenBase" })).toHaveCount(0);
    await switcher.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByTestId("brand").locator("svg")).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: "Sidebar workspace" })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitem")).toContainText(["New workspace", "Rename", "Color", "Members", "Invite people", "Settings", "History", "Trash", "Delete"]);
    // Every row of the menu is color and name, with no icon picker anywhere.
    await expect(menu.getByRole("menuitem", { name: /icon/i })).toHaveCount(0);
  });

  await test.step("New workspace opens the new workspace's Home", async () => {
    await page.getByRole("menuitem", { name: "New workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "New workspace" });
    await dialog.getByLabel("Name").fill("Second workspace");
    await dialog.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/workspace\/wsp[^/]+$/);
    await expect(page).not.toHaveURL(new RegExp(fx.workspaceId));
    await expect(nav.getByRole("button", { name: /^Second workspace/ })).toBeVisible();
    await nav.getByRole("button", { name: /^Second workspace/ }).click();
    await expect(page.getByRole("menuitemradio")).toHaveText([/^Sidebar workspace/, /^Second workspace/]);
    await page.keyboard.press("Escape");
  });

  await test.step("Ctrl+\\ folds and unfolds the sidebar, and the fold is remembered on this device", async () => {
    await expect(nav).toBeVisible();
    await page.keyboard.press("Control+\\");
    await expect(nav).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Show menu" })).toBeVisible();
    await expect(nav).toHaveCount(0);
    await page.keyboard.press("Control+\\");
    await expect(nav).toBeVisible();
  });
});
