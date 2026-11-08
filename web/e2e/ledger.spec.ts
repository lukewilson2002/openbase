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


/** A saved view of a seeded collection, open: the heading comes first, the layout's own content a moment later (each shot waits for that). */
async function openView(page: Page, seed: LedgerSeed, collection: string, view?: string): Promise<void> {
  const id = view ? seed.views[`${collection} / ${view}`] : seed.defaultViews[collection];
  if (!id) throw new Error(`the ledger seed has no view ${view ?? "(default)"} of ${collection}`);
  await page.goto(`/base/${seed.bases[collection]}/${seed.tables[collection]}/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: collection })).toBeVisible();
}

/** The grid has drawn: the canvas is up and Glide's accessible table holds a record's title, which arrives with the records. */
async function gridDrawn(page: Page, title: string): Promise<void> {
  await expect(page.locator("canvas[data-testid='data-grid-canvas']").first()).toBeVisible();
  await expect(page.locator("canvas[data-testid='data-grid-canvas'] td", { hasText: title }).first()).toBeAttached();
}

/** The filter bar. */
const filterBar = (page: Page) => page.getByRole("combobox", { name: "Filter or search" });

/** Types a phrase into the filter bar and applies its first suggestion, as a person does; returns once the chip is there. */
async function applyPhrase(page: Page, phrase: string, chip: string): Promise<void> {
  const bar = filterBar(page);
  await bar.click();
  await bar.fill(phrase);
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: chip, exact: true })).toBeVisible();
}

/** Takes the pointer and the keyboard focus off the screen's controls, so no hover or focus ring is part of the picture. */
async function rest(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1435, 995);
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

  // 5 · Collection header, tabs, filter bar and the drafts bar (COL-1 to COL-5). Clients has four saved views besides
  // its default grid, a record name ("client") and a filter of two chips, so the shot shows every part of the screen.
  {
    row: 5,
    slug: "collection-header",
    name: "collection header, tabs, filter bar with chips and the changes bar",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await applyPhrase(page, "active", "Status is Active");
      await applyPhrase(page, "retainer over 2000", "Retainer is over 2,000");
      await expect(page.getByText(/Showing \d+ of 14 clients/)).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 5,
    slug: "filter-suggestions",
    name: "filter bar with its suggestions",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      const bar = filterBar(page);
      await bar.click();
      await bar.fill("next contact this week");
      await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible();
      await expect(page.getByRole("option").first()).toBeVisible();
    },
  },

  // 6 · View options (COL-6): the main screen, and one of the screens it opens. A popover on a desktop, a sheet on a phone.
  {
    row: 6,
    slug: "view-options",
    name: "View options",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await page.getByRole("button", { name: "View options" }).click();
      const panel = page.getByRole("dialog", { name: "View options" });
      await expect(panel.getByRole("group", { name: "Layout" })).toBeVisible();
      await expect(panel.getByRole("button", { name: /^Properties/ })).toBeVisible();
    },
  },
  {
    row: 6,
    slug: "view-options-properties",
    name: "View options, the Properties screen",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await page.getByRole("button", { name: "View options" }).click();
      const panel = page.getByRole("dialog", { name: "View options" });
      await panel.getByRole("button", { name: /^Properties/ }).click();
      await expect(panel.getByRole("button", { name: "Back to View options" })).toBeVisible();
    },
  },

  // 7 · Save as view (COL-5): the dialog over a draft of two chips, its name filled in from them.
  {
    row: 7,
    slug: "save-as-view",
    name: "Save as view",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await applyPhrase(page, "active", "Status is Active");
      await applyPhrase(page, "retainer over 2000", "Retainer is over 2,000");
      await page.getByRole("button", { name: "Save as view", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Save as view" });
      await expect(dialog.getByRole("textbox", { name: "Name" })).not.toHaveValue("");
      await expect(dialog.getByRole("radio", { name: "Only me" })).toBeChecked();
    },
  },

  // 8 to 13 · The layouts (COL-7), each in a saved view of a seeded collection.
  {
    row: 8,
    slug: "grid",
    name: "Grid layout",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await rest(page);
    },
  },
  {
    row: 9,
    slug: "list",
    name: "List layout",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "By status");
      await expect(page.getByRole("tree", { name: "Grouped records" })).toBeVisible();
      await expect(page.getByRole("treeitem", { name: /^Active, \d+ records?$/ })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 10,
    slug: "board",
    name: "Board layout",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Pipeline");
      await expect(page.getByRole("listitem", { name: "Stack: Active" })).toBeVisible();
      await expect(page.getByText("Fernwood Dental").first()).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 11,
    slug: "calendar",
    name: "Calendar layout with the unscheduled list",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Follow-ups");
      await expect(page.locator(".fc-event").first()).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 11,
    slug: "calendar-unscheduled",
    name: "Calendar with the unscheduled list open on a phone",
    sizes: ["390"],
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Follow-ups");
      await expect(page.locator(".fc-event").first()).toBeVisible();
      await page.getByRole("button", { name: /^Show unscheduled records/ }).tap();
      await expect(page.getByRole("complementary", { name: "Unscheduled records" })).toBeVisible();
    },
  },
  {
    row: 12,
    slug: "gallery",
    name: "Gallery layout",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Projects", "Cards");
      await expect(page.getByRole("button", { name: "Fernwood website rebuild" })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 13,
    slug: "timeline",
    name: "Timeline layout",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Projects", "Schedule");
      await expect(page.locator("[data-bar]").first()).toBeVisible();
      await rest(page);
    },
  },

  // 14 · Form builder (COL-6): the Form layout of Clients, with its settings beside the live preview.
  {
    row: 14,
    slug: "form-builder",
    name: "Form builder",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Intake");
      await expect(page.getByRole("region", { name: "Form settings" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 14,
    slug: "form-builder-preview",
    name: "Form builder, the preview pane on a phone",
    sizes: ["390"],
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Intake");
      await page.getByRole("group", { name: "Builder panes" }).getByRole("button", { name: "Preview" }).tap();
      await expect(page.getByRole("region", { name: "Live preview" })).toBeVisible();
    },
  },

  // 15 · Collection settings (COL-10), opened from the header's "…".
  {
    row: 15,
    slug: "collection-settings",
    name: "Collection settings",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients");
      await gridDrawn(page, "Fernwood Dental");
      await page.getByRole("button", { name: "Collection settings" }).click();
      await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
    },
  },

  // 16 · Bulk selection (COL-9): a bar with the count and the actions on a desktop; on a phone the count and Actions,
  // whose sheet lists them. The List layout: its rows carry the selection checkboxes.
  {
    row: 16,
    slug: "selection",
    name: "bulk selection bar, and its actions sheet on a phone",
    open: async ({ page, seed, phone }) => {
      await openView(page, seed, "Clients", "By status");
      for (const name of ["Oakline Cycles", "Larkspur Florists", "Quill & Co. Books"]) await page.getByRole("checkbox", { name: `Select ${name}` }).check();
      const bar = page.getByRole("toolbar", { name: "Selected records" });
      await expect(bar).toContainText("3 selected");
      if (phone) {
        await bar.getByRole("button", { name: "Actions" }).tap();
        await expect(page.getByRole("dialog", { name: "3 selected" })).toBeVisible();
      }
    },
  },
  {
    row: 16,
    slug: "selection-bar",
    name: "bulk selection bar on a phone",
    sizes: ["390"],
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "By status");
      for (const name of ["Oakline Cycles", "Larkspur Florists"]) await page.getByRole("checkbox", { name: `Select ${name}` }).tap();
      await expect(page.getByRole("toolbar", { name: "Selected records" })).toContainText("2 selected");
    },
  },

  // 17 · Empty and filtered-empty states (COL-9): a collection without records, and a filter that matches none.
  {
    row: 17,
    slug: "empty-collection",
    name: "empty collection",
    open: async ({ page, seed }) => {
      await page.goto(`/base/${seed.bases["Ideas"]}/${seed.tables["Ideas"]}/${seed.defaultViews["Ideas"]}`);
      await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "No ideas yet" })).toBeVisible();
    },
  },
  {
    row: 17,
    slug: "filtered-empty",
    name: "filter that matches nothing",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "By status");
      await expect(page.getByRole("tree", { name: "Grouped records" })).toBeVisible();
      await applyPhrase(page, "name contains zzz", "Name contains zzz");
      await expect(page.getByRole("heading", { name: "No clients match these filters" })).toBeVisible();
      await rest(page);
    },
  },

  // 18 · Record page (REC-1 to REC-6): an account with its properties and a page that has a heading, a list and both
  // embeds. The phone's shot has the keyboard's formatting bar up (the page has the focus).
  {
    row: 18,
    slug: "record-page",
    name: "record page",
    open: async ({ page, seed, phone }) => {
      await page.goto(`/base/${seed.pageRecord.baseId}/${seed.pageRecord.tableId}/${seed.pageRecord.viewId}/r/${seed.pageRecord.recordId}`);
      await expect(page.getByRole("heading", { level: 1, name: seed.pageRecord.title })).toBeVisible();
      const box = page.getByRole("textbox", { name: "Page" });
      await expect(box.getByRole("heading", { name: "This quarter" })).toBeVisible();
      // The embeds have their rows before the picture is taken.
      await expect(page.getByRole("region", { name: /^Bills · linked to this account/ }).getByRole("link", { name: "Domain renewal" })).toBeVisible();
      if (phone) {
        await box.getByRole("heading", { name: "This quarter" }).scrollIntoViewIfNeeded();
        await box.tap({ position: { x: 40, y: 12 } });
        await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
      } else {
        await rest(page);
      }
    },
  },

  // 19 · Comments and history panels (REC-7): a 360 px panel beside the page on a desktop, a full-screen sheet on a phone.
  {
    row: 19,
    slug: "comments-panel",
    name: "comments panel",
    open: async ({ page, seed, phone }) => {
      await page.goto(`/base/${seed.pageRecord.baseId}/${seed.pageRecord.tableId}/${seed.pageRecord.viewId}/r/${seed.pageRecord.recordId}`);
      await expect(page.getByRole("heading", { level: 1, name: seed.pageRecord.title })).toBeVisible();
      await page.getByRole("button", { name: /^Comments \(2\)$/ }).click();
      const panel = phone ? page.getByRole("dialog", { name: "Comments" }) : page.getByRole("complementary", { name: "Comments" });
      await expect(panel.getByText("Sent the revised quote.")).toBeVisible();
      // The box to write in has loaded (its editor is a chunk of its own).
      await expect(panel.getByRole("textbox", { name: "Write a comment" })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 19,
    slug: "history-panel",
    name: "history panel",
    open: async ({ page, seed, phone }) => {
      await page.goto(`/base/${seed.pageRecord.baseId}/${seed.pageRecord.tableId}/${seed.pageRecord.viewId}/r/${seed.pageRecord.recordId}`);
      await expect(page.getByRole("heading", { level: 1, name: seed.pageRecord.title })).toBeVisible();
      if (phone) {
        await page.getByRole("button", { name: "More" }).click();
        await page.getByRole("button", { name: "History" }).click();
      } else {
        await page.getByRole("button", { name: "History" }).click();
      }
      const panel = phone ? page.getByRole("dialog", { name: "History" }) : page.getByRole("complementary", { name: "History" });
      await expect(panel.getByRole("list", { name: "Revision history" })).toBeVisible();
      await rest(page);
    },
  },

  // 20 · Page embeds (REC-6): Linked records and View as tables in the page.
  {
    row: 20,
    slug: "page-embeds",
    name: "page embeds",
    open: async ({ page, seed, phone }) => {
      await page.goto(`/base/${seed.pageRecord.baseId}/${seed.pageRecord.tableId}/${seed.pageRecord.viewId}/r/${seed.pageRecord.recordId}`);
      await expect(page.getByRole("heading", { level: 1, name: seed.pageRecord.title })).toBeVisible();
      const linked = page.getByRole("region", { name: /^Bills · linked to this account/ });
      const unpaid = page.getByRole("region", { name: /^Unpaid bills/ });
      await expect(linked.getByRole("link", { name: "Domain renewal" })).toBeVisible();
      await expect(unpaid.getByRole("link", { name: "Accounting fees" })).toBeVisible();
      // The page's top (a desktop shows both tables), or the first table's, at the top of the screen.
      await (phone ? linked : page.getByRole("region", { name: "Page" })).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await rest(page);
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
