import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, newClientContext, test } from "./fixtures";
import { seedLedger, type LedgerSeed } from "./ledgerSeed";

/**
 * The screen ledger's screenshots (DONE-2): every screen of the spec's Appendix, in light and dark at 1440 px and
 * 390 px, device scale factor 1, written to docs/plans/ux-overhaul-screenshots/NN-slug-{light,dark}-{1440,390}.png
 * where NN is the ledger row number. A phase that moves a screen adds one entry to {@link SHOTS} and runs
 *
 *   LEDGER_SHOTS=1 OPENBASE_E2E=1 npx playwright test ledger            (every entry)
 *   LEDGER_SHOTS=1 OPENBASE_E2E=1 LEDGER_ONLY=2,4 npx playwright test ledger   (the entries of rows 2 and 4)
 *
 * (OPENBASE_E2E_SKIP_BUILD=1 reuses the build of the last run.) The data is seeded by ledgerSeed.ts through the
 * REST API: a workspace with collections, folders, dated records, three workspaces and a limited member. The
 * images are looked at before a row is marked moved, so a shot ends on the state worth looking at: an open menu
 * or palette is part of the shot, and `open` waits for the screen to be settled, never for a fixed time.
 *
 * Skipped unless LEDGER_SHOTS=1: it is a tool, not a check, and it rewrites tracked files.
 */
test.skip(!process.env["OPENBASE_E2E"] || process.env["LEDGER_SHOTS"] !== "1", "set OPENBASE_E2E=1 and LEDGER_SHOTS=1 to take the ledger screenshots (see the header of ledger.spec.ts)");

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/plans/ux-overhaul-screenshots");

const SIZES = {
  // Tall enough for the seeded sidebar to end above its footer: a list cut off by the footer reads as a bug in a picture.
  "1440": { viewport: { width: 1440, height: 1000 }, phone: false },
  "390": { viewport: { width: 390, height: 844 }, phone: true },
} as const;
type Size = keyof typeof SIZES;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

interface ShotContext {
  page: Page;
  seed: LedgerSeed;
  /** Below the desktop breakpoint: the phone layout. */
  phone: boolean;
}

/** One image set (light and dark at both widths) of one ledger row. */
interface Shot {
  /** The ledger row number in the spec's Appendix. */
  row: number;
  /** The file name's slug: the row's first shot says what the row is, a second shot adds what it shows. */
  slug: string;
  /** For the test title. */
  name: string;
  /** Who is signed in; the owner of the seeded workspace by default. */
  as?: "owner" | "limited";
  /** The widths this shot exists at; both by default. */
  sizes?: readonly Size[];
  /** Get the screen to the state to shoot, and return once it is settled. */
  open: (ctx: ShotContext) => Promise<void>;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main menu" });
const home = (s: LedgerSeed) => `/workspace/${s.workspaceId}`;

/** A collection's default grid with its records drawn: the heading comes first, the grid's canvas a moment later. */
async function openCollection(page: Page, seed: LedgerSeed, baseId: string, name: string): Promise<void> {
  await page.goto(`/base/${baseId}/${seed.tables[name]}/${seed.defaultViews[name]}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.locator("canvas[data-testid='data-grid-canvas']").first()).toBeVisible();
}

/**
 * The ledger. Add a screen by adding one entry; keep the rows in order.
 */
const SHOTS: Shot[] = [
  // 2 · Desktop sidebar and workspace switcher (NAV-1 to NAV-6). The phone has no sidebar: its counterpart is the
  // switcher sheet that Home's header opens.
  {
    row: 2,
    slug: "sidebar",
    name: "sidebar and workspace switcher",
    open: async ({ page, seed, phone }) => {
      if (phone) {
        await page.goto(home(seed));
        await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
        await page.getByRole("main").locator("header").first().getByRole("button", { name: /^Northwind Studio/ }).tap();
        await expect(page.getByRole("dialog", { name: "Switch workspace" }).getByRole("button", { name: "Mark and Jo's household" })).toBeVisible();
        return;
      }
      await openCollection(page, seed, seed.rootId, "Tasks");
      await expect(nav(page).getByRole("link", { name: /^Tasks/ })).toHaveAttribute("aria-current", "page");
      await expect(nav(page).getByRole("list", { name: "Collections in Marketing" })).toBeVisible();
      // One folder folded, so the list shows both states and ends above the footer.
      await nav(page).getByRole("button", { name: "Archive 2025", exact: true }).click();
      await expect(nav(page).getByRole("button", { name: "Archive 2025", exact: true })).toHaveAttribute("aria-expanded", "false");
      // The pointer rests on the folder's row after the click, which would draw it as hovered.
      await page.mouse.move(900, 500);
    },
  },
  {
    row: 2,
    slug: "sidebar-switcher",
    name: "workspace switcher menu",
    sizes: ["1440"],
    open: async ({ page, seed }) => {
      await openCollection(page, seed, seed.rootId, "Tasks");
      await nav(page).getByRole("button", { name: /^Northwind Studio/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByRole("menuitemradio", { name: "Side projects" })).toBeVisible();
    },
  },
  {
    row: 2,
    slug: "sidebar-limited",
    name: "sidebar of a member limited to one folder",
    as: "limited",
    sizes: ["1440"],
    open: async ({ page, seed }) => {
      await openCollection(page, seed, seed.folders.operations, "Invoices");
      await expect(nav(page).getByRole("list", { name: "Collections in Operations" })).toBeVisible();
      await expect(nav(page).getByRole("button", { name: "Marketing", exact: true })).toHaveCount(0);
    },
  },

  // 3 · Phone bottom bar and Collections tab (NAV-7, NAV-8, PH-1, PH-2). A desktop sends the route to Home.
  {
    row: 3,
    slug: "collections-tab",
    name: "Collections tab",
    open: async ({ page, seed, phone }) => {
      await page.goto(`/workspace/${seed.workspaceId}/collections`);
      if (phone) {
        await expect(page.getByRole("heading", { level: 1, name: "Collections" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Workspace menu" }).getByRole("link", { name: /^Clients/ })).toBeVisible();
      } else {
        await expect(page).toHaveURL(new RegExp(`/workspace/${seed.workspaceId}$`));
        await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
      }
    },
  },
  {
    row: 3,
    slug: "collections-tab-footer",
    name: "Collections tab, scrolled to the footer links",
    sizes: ["390"],
    open: async ({ page, seed }) => {
      await page.goto(`/workspace/${seed.workspaceId}/collections`);
      const footer = page.getByRole("navigation", { name: "Workspace menu" }).getByRole("link", { name: "Workspace settings" });
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport();
      await expect(page.getByRole("button", { name: "Account menu" }).last()).toBeInViewport();
    },
  },
  {
    row: 3,
    slug: "bottom-bar",
    name: "bottom bar on Home",
    sizes: ["390"],
    open: async ({ page, seed }) => {
      await page.goto(home(seed));
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
      await expect(nav(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    },
  },

  // 4 · Command palette (NAV-9): the search results for text that finds a record, a collection, a folder, a view and a workspace.
  {
    row: 4,
    slug: "command-palette",
    name: "command palette",
    open: async ({ page, seed, phone }) => {
      await openCollection(page, seed, seed.folders.marketing, "Campaigns");
      if (phone) await page.getByRole("main").locator("header").first().getByRole("button", { name: "Search everything" }).tap();
      else await page.keyboard.press("ControlOrMeta+k");
      const dialog = page.getByRole("dialog", { name: "Search everything" });
      const box = dialog.getByRole("combobox", { name: "Search" });
      await expect(box).toBeFocused();
      await box.fill(seed.palette);
      const results = dialog.getByRole("listbox", { name: "Results" });
      for (const group of ["Records", "Collections", "Folders", "Views", "Workspaces"]) await expect(results.getByRole("group", { name: group })).toBeVisible();
    },
  },

  // 43 · Empty folder (Navigation routes)
  {
    row: 43,
    slug: "empty-folder",
    name: "empty folder",
    open: async ({ page, seed }) => {
      await page.goto(`/base/${seed.folders.archive}`);
      await expect(page.getByRole("heading", { name: "No collections in Archive 2025 yet" })).toBeVisible();
    },
  },
];

// ------------------------------------------------------------------------------------------------------

/** Rows to take, from `LEDGER_ONLY=2,4`; all of them when unset. */
const only = (process.env["LEDGER_ONLY"] ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const file = (shot: Shot, theme: Theme, size: Size) => join(OUT_DIR, `${String(shot.row).padStart(2, "0")}-${shot.slug}-${theme}-${size}.png`);

/** Two animation frames, bounded: layout and fonts have settled when the picture is taken. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      Promise.race([
        document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))),
        new Promise<void>((done) => setTimeout(done, 5_000)),
      ]),
  );
}

test.describe.configure({ mode: "serial" });

let seed: LedgerSeed;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  seed = await seedLedger(browser, testInfo);
  mkdirSync(OUT_DIR, { recursive: true });
});

for (const shot of SHOTS) {
  if (only.length && !only.includes(shot.row)) continue;
  for (const size of shot.sizes ?? (Object.keys(SIZES) as Size[])) {
    for (const theme of THEMES) {
      test(`${String(shot.row).padStart(2, "0")} ${shot.name}, ${theme}, ${size} px`, async ({ browser }, testInfo) => {
        const { viewport, phone } = SIZES[size];
        const context = await newClientContext(
          browser,
          testInfo,
          {
            baseURL: testInfo.project.use.baseURL,
            storageState: shot.as === "limited" ? seed.limited : seed.owner,
            viewport,
            deviceScaleFactor: 1,
            isMobile: phone,
            hasTouch: phone,
            colorScheme: theme,
          },
          `${shot.slug}-${theme}-${size}`,
        );
        // The theme is a per-device choice (theme-init.js reads it before the first paint).
        await context.addInitScript((mode) => localStorage.setItem("ob-theme", mode), theme);
        const page = await context.newPage();
        await shot.open({ page, seed, phone });
        await settle(page);
        // The phone must not scroll sideways on any shot (PH-7): a screenshot of a page wider than the screen hides it.
        if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page is wider than the phone").toBeLessThanOrEqual(0);
        await page.screenshot({ path: file(shot, theme, size), animations: "disabled", caret: "hide" });
        await context.close();
      });
    }
  }
}
