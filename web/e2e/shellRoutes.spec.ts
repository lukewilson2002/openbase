import type { APIRequestContext, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * Every route of the spec's Routes table that exists so far opens inside the new shell, in a real browser at both
 * widths (Phase 3's gate: "every route opens in the new shell"): the sidebar on a desktop and the bottom bar on a
 * phone, one `main` with its own header and one `h1`, no bar across the app, no error screen, and on a phone no
 * horizontal page scroll. The console, uncaught exceptions and failed requests are watched by the fixture, so a
 * route that logs an error fails here. What each screen shows has its own specs; this one is about where a route
 * leads. A route is added to {@link ROUTES} in the phase that creates it (the record page in Phase 5).
 *
 * Not in the list, on purpose: the design reference (`/__dev/design`), sign-in, sign-up, invite, public form and
 * share pages and the OAuth consent page are outside the shell; `/inbox` redirects to Home.
 *
 * Signs up its own user, and signs in as the journey's administrator for /admin. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };
const ADMIN_EMAIL = "journey-admin@example.com";

interface Fixture {
  workspaceId: string;
  rootId: string;
  tableId: string;
  folderId: string;
  emptyFolderId: string;
}

interface Route {
  /** The ledger's name for it, and the test title. */
  name: string;
  path: (f: Fixture) => string;
  /** The `h1` the screen opens with. */
  heading: string | RegExp;
  /** Where the address ends up when the route redirects. */
  lands?: (f: Fixture) => RegExp;
  /** The phone's address, when it differs from the desktop's (`/workspace/:id/collections` is Home on a desktop). */
  desktopLands?: (f: Fixture) => RegExp;
  admin?: boolean;
}

const ROUTES: Route[] = [
  { name: "/ leads to Home", path: () => "/", heading: "Home", lands: (f) => new RegExp(`/workspace/${f.workspaceId}$`) },
  { name: "Home", path: (f) => `/workspace/${f.workspaceId}`, heading: "Home" },
  { name: "Collection", path: (f) => `/base/${f.rootId}/${f.tableId}`, heading: "Tasks", lands: (f) => new RegExp(`/base/${f.rootId}/${f.tableId}/viw`) },
  { name: "Collection in a folder", path: (f) => `/base/${f.folderId}`, heading: "Plants", lands: (f) => new RegExp(`/base/${f.folderId}/tbl[^/]+/viw`) },
  { name: "Empty folder", path: (f) => `/base/${f.emptyFolderId}`, heading: "Archive" },
  {
    name: "Collections tab (Home on a desktop)",
    path: (f) => `/workspace/${f.workspaceId}/collections`,
    heading: "Collections",
    desktopLands: (f) => new RegExp(`/workspace/${f.workspaceId}$`),
  },
  { name: "Notifications", path: () => "/notifications", heading: "Notifications" },
  { name: "Workspace automations", path: (f) => `/workspace/${f.workspaceId}/automations`, heading: "Automations" },
  { name: "Folder automations", path: (f) => `/base/${f.rootId}/automations`, heading: "Automations" },
  { name: "Members", path: (f) => `/workspace/${f.workspaceId}/members`, heading: "Members" },
  { name: "Workspace settings", path: (f) => `/workspace/${f.workspaceId}/settings`, heading: "Workspace settings" },
  { name: "History", path: () => "/history", heading: "History" },
  { name: "Trash", path: () => "/trash", heading: "Trash" },
  { name: "Account", path: () => "/account", heading: "Account settings" },
  { name: "Account, AI assistants tab", path: () => "/account?tab=assistants", heading: "Account settings" },
  { name: "Admin", path: () => "/admin", heading: "Administration", admin: true },
  { name: "Admin, Email tab", path: () => "/admin?tab=email", heading: "Administration", admin: true },
];

const SIZES = [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const;

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(path, { data, headers: CSRF });
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A workspace with a top-level collection (Tasks), a folder with a collection (Plants) and an empty folder. */
async function seed(request: APIRequestContext): Promise<Fixture> {
  const signup = await request.post("/api/auth/signup", { data: { email: `e2e-routes-${randomBytes(4).toString("hex")}@example.com`, name: "Routes E2E", password: PASSWORD }, headers: CSRF });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  await skipIntro(request);
  const ws = await post<{ id: string }>(request, "/api/workspaces", { name: "Routes workspace" });
  const rootId = ((await (await request.get("/api/workspaces")).json()) as { id: string; root_base_id: string }[]).find((w) => w.id === ws.id)!.root_base_id;
  const tasks = await post<{ id: string; primary_field_id: string }>(request, `/api/bases/${rootId}/tables`, { name: "Tasks" });
  await post(request, `/api/tables/${tasks.id}/records`, { records: [{ values: { [tasks.primary_field_id]: "Send the quote" } }], typecast: true });
  const garden = await post<{ id: string }>(request, `/api/workspaces/${ws.id}/bases`, { name: "Garden", empty: true });
  await post(request, `/api/bases/${garden.id}/tables`, { name: "Plants" });
  const archive = await post<{ id: string }>(request, `/api/workspaces/${ws.id}/bases`, { name: "Archive", empty: true });
  return { workspaceId: ws.id, rootId, tableId: tasks.id, folderId: garden.id, emptyFolderId: archive.id };
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Main menu" });

let fixture: Fixture;
let ownerState: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;
let adminState: typeof ownerState;

test.beforeAll(async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  const owner = await newClientContext(browser, testInfo, { baseURL }, "owner");
  fixture = await seed(owner.request);
  ownerState = await owner.storageState();
  await owner.close();

  const admin = await newClientContext(browser, testInfo, { baseURL }, "admin");
  const login = await admin.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: PASSWORD }, headers: CSRF });
  expect(login.ok(), `signing in as the journey's administrator: ${login.status()} ${await login.text()}`).toBeTruthy();
  adminState = await admin.storageState();
  await admin.close();
});

for (const [sizeName, viewport, phone] of SIZES) {
  test.describe(`at ${sizeName} width`, () => {
    for (const route of ROUTES) {
      test(route.name, async ({ browser }, testInfo) => {
        const context = await newClientContext(
          browser,
          testInfo,
          { baseURL: testInfo.project.use.baseURL, storageState: route.admin ? adminState : ownerState, viewport, isMobile: phone, hasTouch: phone },
          `${sizeName}-${route.name}`,
        );
        const page = await context.newPage();
        // Starting from Home, as a person would (the administrator is in a workspace of their own).
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
        await page.goto(route.path(fixture));

        const lands = (phone ? route.lands : (route.desktopLands ?? route.lands))?.(fixture);
        if (lands) await expect(page).toHaveURL(lands);
        const heading = phone || !route.desktopLands ? route.heading : "Home";
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { level: 1, name: heading })).toBeVisible();

        await test.step("the shell's menu: the sidebar on a desktop, the bottom bar on a phone", async () => {
          if (phone) {
            await expect(menu(page).getByRole("link")).toHaveText(["Home", "Collections", "Notifications"]);
            // Nothing else is a main menu: the drawer is gone.
            await expect(page.getByRole("button", { name: /^(Show|Hide) menu/ })).toHaveCount(0);
            const bar = (await menu(page).boundingBox())!;
            expect(bar.y + bar.height, "the bar rests on the bottom of the screen").toBeCloseTo(viewport.height, 0);
          } else {
            await expect(menu(page).getByRole("button", { name: /^Search everything/ })).toBeVisible();
            await expect(menu(page).getByRole("link", { name: "Home" })).toBeVisible();
            await expect(menu(page).getByRole("link", { name: "Trash" })).toBeVisible();
            expect((await menu(page).boundingBox())!.width, "the sidebar is 256 px by default").toBeGreaterThanOrEqual(200);
          }
        });

        await test.step("one main with its own header, one h1, and no bar across the app", async () => {
          await expect(page.getByRole("main")).toHaveCount(1);
          await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
          expect(await main.locator("header").count(), "the screen draws its own header inside main").toBeGreaterThan(0);
          const outside = await page.evaluate(() => [...document.querySelectorAll("header")].filter((h) => !h.closest("main")).length);
          expect(outside, "a header outside main is a global top bar").toBe(0);
        });

        await test.step("no error screen, and no horizontal scroll on a phone", async () => {
          await expect(page.getByText(/Page not found|Something went wrong/)).toHaveCount(0);
          if (phone) {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow, "the page is wider than the screen").toBeLessThanOrEqual(0);
          }
        });
        await context.close();
      });
    }
  });
}
