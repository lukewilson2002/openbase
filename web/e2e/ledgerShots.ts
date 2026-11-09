import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { startConsent, type LedgerSeed } from "./ledgerSeed";

/**
 * The screen ledger: one entry per screen of the spec's Appendix, each with the steps that get the screen (and the menu,
 * sheet or dialog worth looking at) onto the page. ledger.spec.ts photographs them (DONE-2) and a11y.spec.ts runs axe on
 * them (A11Y-7), so a screen added here is covered by both. See the header of ledger.spec.ts for how to add one.
 */

export const SIZES = {
  // Tall enough for the seeded sidebar to end above its footer: a list cut off by the footer reads as a bug in a picture.
  "1440": { viewport: { width: 1440, height: 1000 }, phone: false },
  "390": { viewport: { width: 390, height: 844 }, phone: true },
} as const;
export type Size = keyof typeof SIZES;
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export interface ShotContext {
  page: Page;
  seed: LedgerSeed;
  /** Below the desktop breakpoint: the phone layout. */
  phone: boolean;
  baseURL: string;
}

/** One image set (light and dark at both widths) of one ledger row. */
export interface Shot {
  /** The ledger row number in the spec's Appendix. */
  row: number;
  /** The file name's slug: the row's first shot says what the row is, a second shot adds what it shows. */
  slug: string;
  /** For the test title. */
  name: string;
  /**
   * Who is signed in; the owner of the seeded workspace by default. "anonymous" is nobody (the sign-in and public pages),
   * "admin" the instance's administrator, "fresh" a person with no workspace yet and "newcomer" one who has not seen the intro.
   */
  as?: "owner" | "limited" | "anonymous" | "admin" | "fresh" | "newcomer";
  /** The whole page, not the screen: for a reference page that is far longer than one. */
  fullPage?: boolean;
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

/** The seeded account's record page (Fernwood Dental): its title and its page's editor (a chunk of its own) are up, so no placeholder is in the picture. */
async function openAccount(page: Page, seed: LedgerSeed): Promise<void> {
  const r = seed.pageRecord;
  await page.goto(`/base/${r.baseId}/${r.tableId}/${r.viewId}/r/${r.recordId}`);
  await expect(page.getByRole("heading", { level: 1, name: r.title })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Page" })).toBeVisible();
}

/** There is a picture in `scope` and every one has been decoded. */
async function picturesLoaded(scope: Locator): Promise<void> {
  await expect.poll(() => scope.locator("img").evaluateAll((all) => all.length > 0 && all.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

/** The record page's property list. */
const propertyList = (page: Page) => page.getByRole("main", { name: "Record" }).getByRole("region", { name: "Properties" });

/** A property's name opens its menu, which is a pop-over on a desktop and a sheet on a phone; "Edit property" opens the dialog. */
async function editProperty(page: Page, name: string): Promise<Locator> {
  await propertyList(page).getByRole("button", { name, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit property" }).or(page.getByRole("button", { name: "Edit property", exact: true })).click();
  const dialog = page.getByRole("dialog", { name: "Edit property" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Takes the pointer off the screen's controls but leaves the focus where it is: a pop-over that closes when it loses the focus stays in the shot. */
async function restPointer(page: Page): Promise<void> {
  await page.mouse.move(1435, 995);
}

/**
 * The ledger. Add a screen by adding one entry; keep the rows in order.
 */
export const SHOTS: Shot[] = [
  // 1 · Design reference (DL-2): every token and core component in both themes. Compiled into the e2e build only (VITE_DESIGN_PAGE=1)
  // and needs no account.
  {
    row: 1,
    slug: "design-reference",
    name: "design reference",
    as: "anonymous",
    fullPage: true,
    open: async ({ page }) => {
      await page.goto("/__dev/design");
      await expect(page.getByRole("heading", { level: 1, name: "Design reference" })).toBeVisible();
    },
  },

  // 2 · Desktop sidebar and workspace switcher (NAV-1 to NAV-6). The phone has no sidebar: its counterpart is the
  // switcher sheet that Home's header opens.
  {
    row: 2,
    slug: "sidebar",
    name: "sidebar and workspace switcher",
    open: async ({ page, seed, phone }) => {
      if (phone) {
        await page.goto(home(seed));
        await expect(page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toBeVisible();
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
        await expect(page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toBeVisible();
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
      await expect(page.getByRole("button", { name: /^Account menu/ }).last()).toBeInViewport();
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
      await expect(page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toBeVisible();
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
      await expect(page.getByRole("treeitem", { name: /^Active \d+ records?$/ })).toBeVisible();
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
      await page.getByRole("button", { name: /^Unscheduled/ }).tap();
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
      await openAccount(page, seed);
      const box = page.getByRole("textbox", { name: "Page" });
      await expect(box.getByRole("heading", { name: "This quarter" })).toBeVisible();
      // The record's tile is the shopfront picture.
      await picturesLoaded(page.getByRole("main", { name: "Record" }));
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

  {
    row: 18,
    slug: "record-add-property",
    name: "record page, the Add property box with a guessed type",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      await page.getByRole("main", { name: "Record" }).getByRole("button", { name: "Add property" }).click();
      const box = page.getByRole("group", { name: "Add property" });
      await box.getByRole("textbox", { name: "Name" }).fill("Next review");
      await box.getByRole("textbox", { name: "Value" }).fill("Nov 14");
      await expect(box.getByText("Date · Guessed from “Nov 14”")).toBeVisible();
      await box.scrollIntoViewIfNeeded();
    },
  },

  // 19 · Comments and history panels (REC-7): a 360 px panel beside the page on a desktop, a full-screen sheet on a phone.
  {
    row: 19,
    slug: "comments-panel",
    name: "comments panel",
    open: async ({ page, seed, phone }) => {
      await openAccount(page, seed);
      await page.getByRole("button", { name: /^Comments, 2$/ }).click();
      const panel = phone ? page.getByRole("dialog", { name: "Comments" }) : page.getByRole("complementary", { name: "Comments" });
      await expect(panel.getByText("Sent the revised quote.")).toBeVisible();
      // The box to write in has loaded (its editor is a chunk of its own), and so has the picture in the second comment.
      await expect(panel.getByRole("textbox", { name: "Write a comment" })).toBeVisible();
      await picturesLoaded(panel);
      await rest(page);
    },
  },
  {
    row: 19,
    slug: "history-panel",
    name: "history panel",
    open: async ({ page, seed, phone }) => {
      await openAccount(page, seed);
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
      await openAccount(page, seed);
      const linked = page.getByRole("region", { name: /^Bills · linked to this account/ });
      const unpaid = page.getByRole("region", { name: /^Unpaid bills/ });
      await expect(linked.getByRole("link", { name: "Domain renewal" })).toBeVisible();
      await expect(unpaid.getByRole("link", { name: "Accounting fees" })).toBeVisible();
      // The page's top (a desktop shows both tables), or the first table's, at the top of the screen.
      await (phone ? linked : page.getByRole("region", { name: "Page" })).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await rest(page);
    },
  },

  // 21 · Property editor, choices and formula (FLD-2 to FLD-6): the dialog (a sheet on a phone) from a property's menu on the
  // record page, for a choice property, the type list and a formula.
  {
    row: 21,
    slug: "property-editor",
    name: "property editor with choices",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      const dialog = await editProperty(page, "Status");
      await expect(dialog.getByRole("textbox", { name: "Name of option 3" })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 21,
    slug: "property-types",
    name: "property editor with the type list open",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      const dialog = await editProperty(page, "Renewal");
      await dialog.getByRole("button", { name: /^Type/ }).click();
      await expect(dialog.getByRole("listbox", { name: "Property types" }).or(page.getByRole("listbox", { name: "Property types" }))).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 21,
    slug: "property-formula",
    name: "property editor with a formula and its live check",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      const dialog = await editProperty(page, "Per year");
      await expect(dialog.getByRole("combobox", { name: "Formula" })).toHaveValue("{Monthly} * 12");
      await expect(dialog.getByText(/Looks good/)).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 21,
    slug: "property-type-change",
    name: "property editor warning that a type change clears values",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      const dialog = await editProperty(page, "Contact");
      await dialog.getByRole("button", { name: /^Type/ }).click();
      await page.getByRole("option", { name: /^Number/ }).click();
      await expect(dialog.getByRole("status")).toContainText(/values? may be cleared/);
      await rest(page);
    },
  },

  // 22 · Link picker and linked record peek (FLD-5, REC-9): the picker is a pop-over on a desktop and a bottom sheet on a
  // phone; the peek is a hover card on a desktop and a sheet when a finger holds the record.
  {
    row: 22,
    slug: "link-picker",
    name: "link picker",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      await page.locator(`[data-linked-record="${seed.peekedBill}"]`).click({ position: { x: 4, y: 4 } });
      const list = page.getByRole("listbox", { name: "Records" });
      await expect(list.getByRole("option", { name: /Design software/ })).toBeVisible();
      await restPointer(page);
    },
  },
  {
    row: 22,
    slug: "linked-peek",
    name: "linked record peek",
    open: async ({ page, seed, phone }) => {
      if (phone) {
        // A finger resting on the card opens the peek as a sheet, where the record's one link can't be dragged. Playwright
        // cannot hold a touch, so the press is sent the way the browser sends it.
        const solo = seed.soloLink;
        await page.goto(`/base/${seed.pageRecord.baseId}/${seed.pageRecord.tableId}/${seed.pageRecord.viewId}/r/${solo.recordId}`);
        const card = page.locator(`[data-linked-record="${solo.billId}"]`);
        await expect(card).toBeVisible();
        await card.evaluate((el) => {
          const box = el.getBoundingClientRect();
          el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.x + 8, clientY: box.y + 8 }));
        });
        await expect(page.getByRole("dialog", { name: solo.billTitle })).toBeVisible();
        return;
      }
      await openAccount(page, seed);
      await page.locator(`[data-linked-record="${seed.peekedBill}"]`).hover();
      await expect(page.locator("[data-record-peek]")).toContainText("Domain renewal");
    },
  },

  // 23 · Home (HOME-1 to HOME-11): the lists, the Inbox card of two drafts and the capture box; then a capture whose date phrase
  // became a chip, and the Goes to picker.
  {
    row: 23,
    slug: "home",
    name: "Home",
    open: async ({ page, seed }) => {
      await page.goto(home(seed));
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Due soon" }).getByRole("link").first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Recently changed" }).getByRole("link").first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Inbox" }).getByText("Ask Dana about the annual hosting price")).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 23,
    slug: "home-capture",
    name: "capture with a date chip",
    open: async ({ page, seed }) => {
      await page.goto(home(seed));
      const box = page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" });
      await expect(box).toBeVisible();
      await page.getByRole("button", { name: /^Goes to/ }).click();
      await page.getByRole("option", { name: /^Tasks/ }).click();
      await box.fill("Call Fernwood about the new quote tomorrow");
      await expect(page.getByText(/^Due tomorrow/)).toBeVisible();
      await restPointer(page);
    },
  },
  {
    row: 23,
    slug: "home-picker",
    name: "Goes to picker",
    open: async ({ page, seed }) => {
      await page.goto(home(seed));
      await expect(page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toBeVisible();
      await page.getByRole("button", { name: /^Goes to/ }).click();
      await expect(page.getByRole("option", { name: /^Inbox/ })).toBeVisible();
      await expect(page.getByRole("option", { name: /^Tasks/ })).toBeVisible();
    },
  },

  // 24 to 28 · The pages before anyone is signed in (APP-1): nobody is signed in on any of them.
  {
    row: 24,
    slug: "sign-in",
    name: "sign in",
    as: "anonymous",
    open: async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    },
  },
  {
    row: 25,
    slug: "two-factor",
    name: "two-factor sign-in",
    as: "anonymous",
    open: async ({ page }) => {
      await page.goto("/login/2fa");
      await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
    },
  },
  {
    row: 26,
    slug: "setup",
    name: "first administrator",
    as: "anonymous",
    open: async ({ page }) => {
      // The instance already has people, so /setup would send a visitor to the sign-in page: the screen is shown the way a new instance answers.
      await page.route("**/api/setup", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), needs_setup: true } });
      });
      await page.goto("/setup");
      await expect(page.getByRole("heading", { name: "Welcome to your OpenBase" })).toBeVisible();
    },
  },
  {
    row: 27,
    slug: "sign-up",
    name: "sign up",
    as: "anonymous",
    open: async ({ page }) => {
      await page.goto("/signup");
      await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    },
  },
  {
    row: 27,
    slug: "invite",
    name: "invitation to a workspace",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(`/invite/${seed.inviteToken}`);
      await expect(page.getByRole("heading", { name: "Join Northwind Studio" })).toBeVisible();
    },
  },
  {
    row: 28,
    slug: "forgot-password",
    name: "forgot password",
    as: "anonymous",
    open: async ({ page }) => {
      await page.goto("/forgot-password");
      await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    },
  },
  {
    row: 28,
    slug: "reset-password",
    name: "choose a new password",
    as: "anonymous",
    open: async ({ page }) => {
      await page.goto("/reset-password?token=ledger-example-token");
      await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    },
  },

  // 29 · First run (APP-2): a person with no workspace yet.
  {
    row: 29,
    slug: "first-run",
    name: "first workspace",
    as: "fresh",
    open: async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("#first-workspace-title")).toBeVisible();
    },
  },

  // 30 · Intro (APP-3): the first of its five steps, over the Home of a person who has not seen it.
  {
    row: 30,
    slug: "intro",
    name: "intro",
    as: "newcomer",
    open: async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("dialog", { name: "Home catches your ideas" })).toBeVisible();
    },
  },
  {
    row: 30,
    slug: "intro-views",
    name: "intro, a later step",
    as: "newcomer",
    open: async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("dialog", { name: "Home catches your ideas" })).toBeVisible();
      // The dialog is named by its step, so it is found by its role from the second step on.
      for (let step = 0; step < 2; step++) await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("dialog", { name: "Home catches your ideas" })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },

  // 31 · Notifications (APP-4): the sidebar's popover on a desktop, the tab's screen on a phone; and the screen on a desktop.
  {
    row: 31,
    slug: "notifications",
    name: "notifications",
    open: async ({ page, seed, phone }) => {
      if (phone) {
        await page.goto("/notifications");
        await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
      } else {
        await page.goto(home(seed));
        await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
        await nav(page).getByRole("button", { name: /^Notifications/ }).click();
      }
      await expect(page.getByRole("list", { name: "Notifications" }).getByRole("listitem").first()).toBeVisible();
    },
  },
  {
    row: 31,
    slug: "notifications-page",
    name: "notifications screen",
    sizes: ["1440"],
    open: async ({ page }) => {
      await page.goto("/notifications");
      await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Notifications" }).getByRole("listitem").first()).toBeVisible();
    },
  },

  // 32 · Automations (APP-5): the workspace's list, a folder's automation in the editor, and its runs.
  {
    row: 32,
    slug: "automations",
    name: "workspace automations",
    open: async ({ page, seed }) => {
      await page.goto(`/workspace/${seed.workspaceId}/automations`);
      await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
      await expect(page.getByText("Tell me about new research")).toBeVisible();
    },
  },
  {
    row: 32,
    slug: "automation-editor",
    name: "automation editor",
    open: async ({ page, seed }) => {
      await page.goto(`/base/${seed.rootId}/automations/${seed.automations.research}`);
      await expect(page.getByRole("tablist", { name: "Automation sections" })).toBeVisible();
      await expect(page.getByRole("switch", { name: "On", exact: true })).toBeChecked();
      await rest(page);
    },
  },
  {
    row: 32,
    slug: "automation-runs",
    name: "automation runs",
    open: async ({ page, seed }) => {
      await page.goto(`/base/${seed.rootId}/automations/${seed.automations.research}/runs`);
      await expect(page.getByRole("list", { name: "Runs" }).getByRole("listitem").first()).toBeVisible();
      await rest(page);
    },
  },

  // 33 and 34 · The public pages (APP-6, APP-7): no one is signed in. The form is shown with its first check failing.
  {
    row: 33,
    slug: "public-form",
    name: "public form",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(seed.links.form);
      await expect(page.getByRole("heading", { level: 1, name: "Tell us about your studio" })).toBeVisible();
    },
  },
  {
    row: 33,
    slug: "public-form-check",
    name: "public form with a missing answer",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(seed.links.form);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("This question is required.")).toBeVisible();
    },
  },
  {
    row: 34,
    slug: "public-view",
    name: "public shared view",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(seed.links.view);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Fernwood Dental").first()).toBeVisible();
      await rest(page);
    },
  },

  {
    row: 34,
    slug: "public-view-grid",
    name: "public shared grid",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(seed.links.grid);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // The signed-in grid's canvas draws the rows; its accessible table beneath says when they are in.
      await expect.poll(async () => (await page.locator("canvas[data-testid='data-grid-canvas']").first().textContent()) ?? "").toContain("Fernwood Dental");
      await rest(page);
    },
  },
  {
    row: 34,
    slug: "public-view-calendar",
    name: "public shared calendar",
    as: "anonymous",
    open: async ({ page, seed }) => {
      await page.goto(seed.links.calendar);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".ob-cal-chip").first()).toBeVisible();
      await rest(page);
    },
  },

  // 35 · Share (APP-8): inviting people over folders, and a view's links.
  {
    row: 35,
    slug: "share",
    name: "share dialog, invite people",
    open: async ({ page, seed }) => {
      await openCollection(page, seed, seed.rootId, "Clients");
      await page.getByRole("main").locator("header").getByRole("button", { name: "Share" }).click();
      await expect(page.getByRole("dialog", { name: /^Share / })).toBeVisible();
    },
  },
  {
    row: 35,
    slug: "share-view",
    name: "share dialog, links of a view",
    open: async ({ page, seed }) => {
      await openView(page, seed, "Clients", "Pipeline");
      await page.getByRole("main").locator("header").getByRole("button", { name: "Share" }).click();
      const dialog = page.getByRole("dialog", { name: /^Share / });
      await dialog.getByRole("tab", { name: "Share a view" }).click();
      await expect(dialog.getByRole("switch").first()).toBeVisible();
    },
  },

  // 36 and 37 · History and Trash (APP-9, APP-10).
  {
    row: 36,
    slug: "history",
    name: "history",
    open: async ({ page }) => {
      await page.goto("/history");
      await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
      await expect(page.getByRole("article").first()).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 37,
    slug: "trash",
    name: "trash",
    open: async ({ page }) => {
      await page.goto("/trash");
      await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Deleted items" }).getByRole("listitem").first()).toBeVisible();
      await rest(page);
    },
  },

  // 38 · CSV (APP-11): a new collection from a file, and a file imported into a collection.
  {
    row: 38,
    slug: "csv-new-collection",
    name: "new collection from CSV",
    open: async ({ page, seed }) => {
      await page.goto(`/base/${seed.folders.archive}`);
      await page.getByRole("button", { name: "Import CSV" }).click();
      const dialog = page.getByRole("dialog", { name: "New collection from CSV" });
      await dialog.getByLabel("CSV file").setInputFiles({ name: "Customers 2026.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Age,Joined,Active\nAnn,30,2024-01-05,yes\nBob,41,2023-12-31,no\nCyd,29,2022-06-30,yes\n") });
      await expect(dialog.getByRole("region", { name: "Preview" }).getByText("Bob")).toBeVisible();
    },
  },
  {
    row: 38,
    slug: "csv-import",
    name: "import CSV into a collection",
    open: async ({ page, seed, phone }) => {
      // The collection's menu is in the sidebar, which a phone has as its Collections tab.
      if (phone) await page.goto(`/workspace/${seed.workspaceId}/collections`);
      else await openCollection(page, seed, seed.rootId, "Clients");
      await page.getByRole("button", { name: "Collection options for Clients" }).click();
      await page.getByRole("menuitem", { name: /Import CSV/ }).or(page.getByRole("button", { name: /Import CSV/ })).first().click();
      const dialog = page.getByRole("dialog", { name: "Import CSV into Clients" });
      await dialog.getByLabel("CSV file").setInputFiles({ name: "more-clients.csv", mimeType: "text/csv", buffer: Buffer.from("Name;Status;Retainer;Comment\nDelta Dental;Lead;1200;hi\nEcho Cycles;Active;800;there\n") });
      await expect(dialog.getByRole("region", { name: "Column mapping" })).toBeVisible();
    },
  },

  // 39 and 40 · Workspace settings and Members (APP-12, APP-13).
  {
    row: 39,
    slug: "workspace-settings",
    name: "workspace settings",
    open: async ({ page, seed }) => {
      await page.goto(`/workspace/${seed.workspaceId}/settings`);
      await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
      await expect(page.getByText("Top level now")).toBeVisible();
    },
  },
  {
    row: 40,
    slug: "members",
    name: "members and folder access",
    open: async ({ page, seed }) => {
      await page.goto(`/workspace/${seed.workspaceId}/members`);
      await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Members" })).toContainText("Jonas Berg");
      await rest(page);
    },
  },

  // 41 · Account and the OAuth consent page (APP-14, AGT-2, AGT-5).
  {
    row: 41,
    slug: "account",
    name: "account profile",
    open: async ({ page }) => {
      await page.goto("/account");
      await expect(page.getByRole("heading", { level: 1, name: "Account settings" })).toBeVisible();
    },
  },
  {
    row: 41,
    slug: "account-tokens",
    name: "API tokens",
    open: async ({ page }) => {
      await page.goto("/account?tab=tokens");
      await expect(page.getByText("Nightly backup script")).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 41,
    slug: "account-assistants",
    name: "connected apps",
    open: async ({ page, seed }) => {
      await page.goto("/account?tab=assistants");
      await expect(page.getByRole("list", { name: "Connected apps" }).getByRole("listitem").filter({ hasText: seed.connectedApp })).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 41,
    slug: "oauth-consent",
    name: "OAuth consent",
    open: async ({ page, baseURL }) => {
      const consent = await startConsent(page.request, baseURL, "Notion Agent");
      await page.goto(consent.path);
      await expect(page.getByRole("heading", { name: "Allow Notion Agent to use your OpenBase?" })).toBeVisible();
      await rest(page);
    },
  },

  // 42 · Admin (APP-15): the instance's administrator.
  {
    row: 42,
    slug: "admin",
    name: "admin users",
    as: "admin",
    open: async ({ page }) => {
      await page.goto("/admin");
      await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
      await expect(page.getByText("Mara Okafor").first()).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 42,
    slug: "admin-apps",
    name: "admin connected apps",
    as: "admin",
    open: async ({ page }) => {
      await page.goto("/admin?tab=apps");
      await expect(page.getByText("Claude Code").first()).toBeVisible();
      await rest(page);
    },
  },
  {
    row: 42,
    slug: "admin-audit",
    name: "admin audit",
    as: "admin",
    open: async ({ page }) => {
      await page.goto("/admin?tab=audit");
      await expect(page.getByRole("heading", { level: 1, name: "Administration" })).toBeVisible();
      await expect(page.getByRole("row").nth(1)).toBeVisible();
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

  // 44 · File preview (REC-3): the record page with a picture, a PDF and a Word file; the picture also fills the record's tile.
  // The tiles' pictures have loaded before a shot is taken: a tile whose picture failed shows its type instead.
  {
    row: 44,
    slug: "file-preview",
    name: "file tiles on the record page",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      const file = propertyList(page).getByRole("link", { name: /fernwood-storefront\.png/ });
      await expect(file).toBeVisible();
      // Pictures load lazily, once they are on screen.
      await file.scrollIntoViewIfNeeded();
      await picturesLoaded(page.getByRole("main", { name: "Record" }));
      await rest(page);
    },
  },
  {
    row: 44,
    slug: "file-editor",
    name: "file list while editing the Files property",
    open: async ({ page, seed }) => {
      await openAccount(page, seed);
      await propertyList(page).locator("[data-edit-field]", { has: page.getByRole("button", { name: "Edit Files" }) }).click();
      await expect(page.getByRole("button", { name: "Remove brand-guidelines.docx" })).toBeVisible();
      await picturesLoaded(page.locator("body"));
      await restPointer(page);
    },
  },
  // 45 · Not found and error screens (APP-16, APP-17): each says what happened and offers Go to Home.
  {
    row: 45,
    slug: "not-found",
    name: "page not found",
    open: async ({ page }) => {
      await page.goto("/there/is/nothing/here");
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    },
  },
  {
    row: 45,
    slug: "folder-not-found",
    name: "a folder that is gone",
    open: async ({ page }) => {
      await page.goto("/base/appGoneForGood");
      await expect(page.getByRole("link", { name: "Go to Home" })).toBeVisible();
    },
  },
];


/** Two animation frames, bounded: layout and fonts have settled when the picture is taken. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      Promise.race([
        document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))),
        new Promise<void>((done) => setTimeout(done, 5_000)),
      ]),
  );
}
