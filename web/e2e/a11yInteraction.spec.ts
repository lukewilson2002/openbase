import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, newClientContext, test } from "./fixtures";
import { seedLedger, type LedgerSeed } from "./ledgerSeed";
import { settle } from "./ledgerShots";
import { tapTargetFailures } from "./phoneAudit";

/**
 * Accessibility beyond axe (A11Y-1 to A11Y-6), on the ledger's seeded workspace: keyboard-only walks through capture,
 * filtering, saving a view and editing a record, Escape handing the focus back to what opened a pop-over, a sheet and a
 * dialog, the 2 px focus ring on every focusable element, landmarks and headings, the live regions, colour never being the
 * only cue, 200% text zoom, target sizes and reduced motion. The axe sweep over every screen is a11y.spec.ts.
 * No mouse is used where a test says keyboard: it moves with Tab and presses keys.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

let seed: LedgerSeed;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  seed = await seedLedger(browser, testInfo);
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function signedIn(browser: import("@playwright/test").Browser, testInfo: import("@playwright/test").TestInfo, viewport: { width: number; height: number }, extra: import("@playwright/test").BrowserContextOptions = {}) {
  const phone = viewport.width < 1024;
  const context = await newClientContext(browser, testInfo, { baseURL: testInfo.project.use.baseURL, storageState: seed.owner, viewport, isMobile: phone, hasTouch: phone, ...extra }, "a11y-interaction");
  return { context, page: await context.newPage() };
}

const home = () => `/workspace/${seed.workspaceId}`;
const nav = (page: Page) => page.getByRole("navigation", { name: "Main menu" });
const captureBox = (page: Page) => page.getByRole("textbox", { name: "Add a task, a note, a meal, anything" });
const filterBar = (page: Page) => page.getByRole("combobox", { name: "Filter or search" });
const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

async function openClients(page: Page, view?: string): Promise<void> {
  const id = view ? seed.views[`Clients / ${view}`]! : seed.defaultViews["Clients"]!;
  await page.goto(`/base/${seed.bases["Clients"]}/${seed.tables["Clients"]}/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
}

async function openAccount(page: Page): Promise<void> {
  const r = seed.pageRecord;
  await page.goto(`/base/${r.baseId}/${r.tableId}/${r.viewId}/r/${r.recordId}`);
  await expect(page.getByRole("heading", { level: 1, name: r.title })).toBeVisible();
}

/** The page, not a field in it, has the focus: where a person is after the page has loaded and nothing was pressed. */
async function pageHasFocus(page: Page): Promise<void> {
  await expect(page.locator("canvas[data-testid='data-grid-canvas']").first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Tab (the keyboard, nothing else) until `target` has the focus; fails when it is not reached in `max` presses. */
async function tabTo(page: Page, target: Locator, max = 120): Promise<void> {
  for (let i = 0; i <= max; i++) {
    const here = await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 1_000 }).catch(() => false);
    if (here) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab did not reach ${target} in ${max} presses`);
}

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-1 Keyboard
// ---------------------------------------------------------------------------------------------------------------------

test.describe("A11Y-1 keyboard", () => {
  test("capture: Tab reaches the box, Enter adds the note, and the toast's Undo is reachable", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await page.goto(home());
    await expect(captureBox(page)).toBeVisible();
    await tabTo(page, captureBox(page));
    await page.keyboard.type("Buy oat milk");
    await page.keyboard.press("Enter");
    await expect(toasts(page).getByText(/^Added to /)).toBeVisible();
    await expect(captureBox(page)).toHaveValue("");
    await tabTo(page, toasts(page).getByRole("button", { name: "Undo" }));
    await context.close();
  });

  test("filtering and saving a view: / focuses the bar, a phrase and Enter make a chip, Tab reaches Save as view, and the dialog is filled and sent from the keyboard", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    // The page itself has the focus (nothing was clicked, and the grid has let go of it), so the slash is the shortcut and not a character.
    await pageHasFocus(page);
    await page.keyboard.press("/");
    await expect(filterBar(page)).toBeFocused();
    await page.keyboard.type("active");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    const chip = page.getByRole("button", { name: "Status is Active", exact: true });
    await expect(chip).toBeVisible();
    await expect(page.getByText(/^Showing \d+ of \d+/)).toBeVisible();

    const save = page.getByRole("button", { name: "Save as view", exact: true });
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Save as view" });
    await expect(dialog).toBeVisible();
    // The focus moved into the dialog, to its first field.
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Active clients, by keyboard");
    await tabTo(page, dialog.getByRole("button", { name: "Save as view" }), 20);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: "Active clients, by keyboard" })).toHaveAttribute("aria-selected", "true");
    await context.close();
  });

  test("editing a record: Tab reaches a property's Edit button, Enter opens its editor, typing and Enter save it, and Escape leaves the page", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openAccount(page);
    const edit = page.getByRole("main", { name: "Record" }).getByRole("button", { name: "Edit Monthly" });
    await tabTo(page, edit);
    // The Edit button is for the keyboard and is not drawn until it has the focus; it must be drawn then.
    const shown = await edit.boundingBox();
    expect(shown && shown.width > 0 && shown.height > 0, "the focused Edit button is on screen").toBeTruthy();
    await page.keyboard.press("Enter");
    const field = page.getByRole("main", { name: "Record" }).getByRole("textbox", { name: "Monthly" });
    await expect(field).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("275");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(/Saved/);
    await expect(page.getByRole("main", { name: "Record" }).getByText("275", { exact: true }).first()).toBeVisible();
    // The edit went to the server.
    await page.reload();
    await expect(page.getByRole("main", { name: "Record" }).getByText("275", { exact: true }).first()).toBeVisible();
    await context.close();
  });

  test("Alt+Down and Alt+Up step between the records of the view and Escape leaves the page for the view", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openAccount(page);
    const title = page.getByRole("main", { name: "Record" }).getByRole("heading", { level: 1 });
    await expect(title).toHaveText("Fernwood Dental");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(title).not.toHaveText("Fernwood Dental");
    await page.keyboard.press("Alt+ArrowUp");
    await expect(title).toHaveText("Fernwood Dental");
    await context.close();
  });

  test("Ctrl K opens the command palette and Escape returns the focus to where it was", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    await pageHasFocus(page);
    await page.keyboard.press("/");
    await expect(filterBar(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: /search|command/i });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(filterBar(page)).toBeFocused();
    await context.close();
  });

  test("Escape closes a pop-over and puts the focus back on the control that opened it", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    // A menu (the workspace switcher) and a panel (Notifications), each opened with the keyboard.
    for (const [opener, popover] of [
      [nav(page).getByRole("button", { name: /^Northwind Studio/ }), page.getByRole("menu")],
      [nav(page).getByRole("button", { name: /^Notifications/ }), page.getByRole("dialog", { name: "Notifications" })],
    ] as const) {
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(popover).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(opener).toBeFocused();
    }
    await context.close();
  });

  test("Escape closes a dialog and puts the focus back on the control that opened it", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    await filterBar(page).focus();
    await page.keyboard.type("active");
    await page.keyboard.press("Enter");
    const save = page.getByRole("button", { name: "Save as view", exact: true });
    await expect(save).toBeVisible();
    await save.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Save as view" });
    await expect(dialog).toBeVisible();
    // The dialog has taken the focus: Escape is then heard by it, and not by the control behind.
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    // A beat for the dialog to finish mounting: its Escape listener is attached by an effect that runs after the field has the focus.
    await settle(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(save).toBeFocused();
    await context.close();
  });

  test("Escape closes a sheet on a phone and puts the focus back on the control that opened it", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, PHONE);
    await page.goto(home());
    await expect(captureBox(page)).toBeVisible();
    const opener = page.getByRole("main").locator("header").first().getByRole("button", { name: /^Northwind Studio/ });
    await opener.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Switch workspace" });
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();
    await context.close();
  });
});

test.describe("A11Y-1 a dialog opened from a menu", () => {
  // The menu item that opened the dialog is gone when it closes: focus goes back to the button that opened the menu.
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`Escape in a dialog opened from a row's menu puts the focus back on the row's menu button, ${label}`, async ({ browser }, testInfo) => {
      const { context, page } = await signedIn(browser, testInfo, viewport);
      if (viewport === PHONE) {
        await page.goto(`${home()}/collections`);
        await expect(page.getByRole("heading", { level: 1, name: "Collections" })).toBeVisible();
      } else await openClients(page);
      const opener = page.getByRole("button", { name: "Collection options for Clients" }).first();
      await opener.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Rename" }).or(page.getByRole("dialog", { name: "Clients" }).getByRole("button", { name: "Rename" })).click();
      const dialog = page.getByRole("dialog", { name: "Rename collection" });
      await expect(dialog).toBeVisible();
      await settle(page);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await context.close();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-2 Focus
// ---------------------------------------------------------------------------------------------------------------------

/** What the page reports about the element that has the focus, read in the page. */
interface FocusReport {
  what: string;
  /** The element's own outline is 2 px, solid, the --ring colour, and offset 2 px (or -2 px, drawn inside a box that clips). */
  ownRing: boolean;
  /** A wrapper that has the focus within it draws the ring (a field inside a composite control). */
  wrapperRing: boolean;
  /** Focus-visible matched: the keyboard put the focus here. */
  visible: boolean;
  outline: string;
}

/**
 * Tabs through the page and reports, for every element the focus lands on, whether a 2 px --ring outline is drawn around it
 * (A11Y-2). Stops when the focus comes back to the first element or after `max` presses.
 */
async function auditFocusRing(page: Page, max = 150): Promise<FocusReport[]> {
  await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--ring)";
    probe.id = "ring-probe";
    document.body.append(probe);
  });
  const reports: FocusReport[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const report = await page.evaluate((): (FocusReport & { key: string }) | null => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return null;
      const ring = getComputedStyle(document.getElementById("ring-probe")!).color;
      const asRing = (e: Element) => {
        const s = getComputedStyle(e);
        const width = parseFloat(s.outlineWidth);
        const offset = parseFloat(s.outlineOffset);
        const shadow = s.boxShadow.includes(ring);
        return { outline: s.outlineStyle !== "none" && width >= 2 && s.outlineColor === ring && (offset === 2 || offset === -2), shadow, text: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} offset ${s.outlineOffset}` };
      };
      const own = asRing(el);
      // A resize handle is a thin strip: it shows the focus as a 2 px bar in the --ring colour down its length, which is its outline.
      const bar = el.getAttribute("role") === "separator" && [...el.children].some((c) => getComputedStyle(c).backgroundColor === ring && c.getBoundingClientRect().width >= 2);
      let wrapper = false;
      for (let p = el.parentElement, depth = 0; p && depth < 4 && !wrapper; p = p.parentElement, depth++) {
        if (!p.matches(":focus-within")) continue;
        const w = asRing(p);
        wrapper = w.outline || w.shadow;
      }
      const path: string[] = [];
      for (let n: Element | null = el, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
        path.unshift(`${n.tagName.toLowerCase()}${n.getAttribute("aria-label") ? `[${n.getAttribute("aria-label")}]` : ""}${n.getAttribute("data-testid") ? `[${n.getAttribute("data-testid")}]` : ""}`);
      }
      const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
      return { key: `${path.join(">")}|${name}`, what: `${path.join(" > ")} "${name}"`, ownRing: own.outline || bar, wrapperRing: wrapper, visible: el.matches(":focus-visible"), outline: own.text };
    });
    if (!report) continue;
    if (seen.has(report.key)) break;
    seen.add(report.key);
    reports.push(report);
  }
  return reports;
}

/** A focusable thing that is not drawn as a ring, with the reason it cannot be. Nothing else is excused. */
const RING_DRAWN_ELSEWHERE = [
  // Glide's grid is one canvas: the cell with the focus is outlined inside the canvas (the whole canvas has no box to ring).
  /canvas|data-grid|dvn-/,
];

/** The focusable elements on the screen the page shows that have no 2 px --ring outline, each with what it has instead. */
async function focusRingFailures(page: Page, name: string): Promise<string[]> {
  const reports = await auditFocusRing(page);
  const bad = reports.filter((r) => !(r.ownRing || r.wrapperRing) && !RING_DRAWN_ELSEWHERE.some((re) => re.test(r.what)));
  const found = bad.map((r) => `${name}: ${r.what} (${r.outline}, focus-visible ${r.visible})`);
  if (reports.length <= 3) found.push(`${name}: Tab found only ${reports.length} focusable elements`);
  return found;
}

test.describe("A11Y-2 focus ring", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`every element Tab reaches on Home, a grid, a list, a record and settings has a 2 px --ring outline, ${theme}`, async ({ browser }, testInfo) => {
      test.setTimeout(180_000);
      const { context, page } = await signedIn(browser, testInfo, DESKTOP, { colorScheme: theme, reducedMotion: "reduce" });
      await context.addInitScript((mode) => localStorage.setItem("ob-theme", mode), theme);
      const screens: [string, () => Promise<void>][] = [
        ["Home", async () => { await page.goto(home()); await expect(captureBox(page)).toBeVisible(); }],
        ["the grid", async () => { await openClients(page); await expect(page.locator("canvas[data-testid='data-grid-canvas']").first()).toBeVisible(); }],
        ["the list", async () => { await openClients(page, "By status"); await expect(page.getByRole("tree").first()).toBeVisible(); }],
        ["the board", async () => { await openClients(page, "Pipeline"); await expect(page.getByRole("button", { name: "Fernwood Dental" }).first()).toBeVisible(); }],
        ["a record", async () => { await openAccount(page); await expect(page.getByRole("textbox", { name: "Page" })).toBeVisible(); }],
        ["settings", async () => { await page.goto(`/workspace/${seed.workspaceId}/settings`); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); }],
      ];
      const failures: string[] = [];
      for (const [name, open] of screens) {
        await open();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        failures.push(...(await focusRingFailures(page, name)));
      }
      expect(failures, "focusable elements without a 2 px --ring outline").toEqual([]);
      await context.close();
    });
  }

  test("a tab shows its ring inside the strip that scrolls, and the panel it controls shows one when Tab reaches it", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const tab = page.getByRole("tab").first();
    await tab.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(tab).toBeFocused();
    const ring = await tab.evaluate((el) => {
      const s = getComputedStyle(el);
      // The strip scrolls, so it clips: the ring (width and offset outward from the tab) has to lie inside its box.
      const grow = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
      const r = el.getBoundingClientRect();
      const clip = (el.closest("[role=tablist]") as HTMLElement).getBoundingClientRect();
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), inside: r.top - grow >= clip.top - 0.5 && r.bottom + grow <= clip.bottom + 0.5 && r.left - grow >= clip.left - 0.5 };
    });
    expect(ring).toMatchObject({ style: "solid", width: 2, inside: true });
    await page.keyboard.press("Tab");
    const panel = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { role: el.getAttribute("role"), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(panel).toEqual({ role: "tabpanel", style: "solid", width: 2 });
    await context.close();
  });

  test("the search in a choice editor has the 2 px ring when it takes the focus", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openAccount(page);
    await page.getByRole("main", { name: "Record" }).getByRole("button", { name: "Edit Status" }).focus();
    await page.keyboard.press("Enter");
    const search = page.getByRole("combobox", { name: "Find an option in Status" });
    await expect(search).toBeFocused();
    const ring = await search.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), colour: s.outlineColor, ring: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim() };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBe(2);
    await context.close();
  });

  test("on a phone, Tab reaches the bottom bar and the capture box with the same ring", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, PHONE, { reducedMotion: "reduce" });
    await page.goto(home());
    await expect(captureBox(page)).toBeVisible();
    expect(await focusRingFailures(page, "Home on a phone"), "focusable elements without a 2 px --ring outline").toEqual([]);
    await context.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-3 Semantics
// ---------------------------------------------------------------------------------------------------------------------

/** Screens of the signed-in app that carry the shell: [name, who, path or a way to open it]. */
function appScreens(): { name: string; as?: "owner" | "admin"; open: (page: Page) => Promise<void> }[] {
  return [
    { name: "Home", open: async (page) => void (await page.goto(home())) },
    { name: "Collections", open: async (page) => void (await page.goto(`${home()}/collections`)) },
    { name: "a grid", open: (page) => openClients(page) },
    { name: "a list", open: (page) => openClients(page, "By status") },
    { name: "a board", open: (page) => openClients(page, "Pipeline") },
    { name: "a calendar", open: (page) => openClients(page, "Follow-ups") },
    { name: "a record", open: (page) => openAccount(page) },
    { name: "members", open: async (page) => void (await page.goto(`${home()}/members`)) },
    { name: "workspace settings", open: async (page) => void (await page.goto(`${home()}/settings`)) },
    { name: "notifications", open: async (page) => void (await page.goto("/notifications")) },
    { name: "history", open: async (page) => void (await page.goto("/history")) },
    { name: "trash", open: async (page) => void (await page.goto("/trash")) },
    { name: "account", open: async (page) => void (await page.goto("/account")) },
    { name: "administration", as: "admin", open: async (page) => void (await page.goto("/admin")) },
  ];
}

test.describe("A11Y-3 semantics", () => {
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`every screen has one main, one h1 and a nav, and its tables have header cells with scope, ${label}`, async ({ browser }, testInfo) => {
      test.setTimeout(180_000);
      const phone = viewport.width < 1024;
      const findings: string[] = [];
      for (const screen of appScreens()) {
        const context = await newClientContext(browser, testInfo, { baseURL: testInfo.project.use.baseURL, storageState: seed[screen.as ?? "owner"], viewport, isMobile: phone, hasTouch: phone }, `a11y-semantics-${screen.name}`);
        const page = await context.newPage();
        await screen.open(page);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        // Let the screen's own content arrive: a heading comes before the records do.
        await page.waitForLoadState("networkidle");
        const report = await page.evaluate(() => {
          const shown = (e: Element) => (e as HTMLElement).checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
          const mains = [...document.querySelectorAll("main, [role=main]")].filter(shown);
          const h1s = [...document.querySelectorAll("h1, [role=heading][aria-level='1']")].filter(shown);
          const navs = [...document.querySelectorAll("nav, [role=navigation]")].filter(shown);
          const noScope = [...document.querySelectorAll("th:not([role=presentation])")].filter((th) => shown(th) && !th.getAttribute("scope")).length;
          const bareTables = [...document.querySelectorAll("table:not([role])")].filter((t) => shown(t) && !t.querySelector("th")).length;
          const fakeLists = [...document.querySelectorAll("[role=listitem]")].filter((i) => !i.closest("[role=list], ul, ol")).length;
          const listWithBadChildren = [...document.querySelectorAll("ul, ol")].filter((l) => [...l.children].some((c) => !["LI", "SCRIPT", "TEMPLATE"].includes(c.tagName) && !c.getAttribute("role"))).length;
          return { mains: mains.length, h1s: h1s.map((h) => h.textContent?.trim()), navs: navs.length, noScope, bareTables, fakeLists, listWithBadChildren };
        });
        if (report.mains !== 1) findings.push(`${screen.name}: ${report.mains} main landmarks`);
        if (report.h1s.length !== 1) findings.push(`${screen.name}: ${report.h1s.length} h1 (${report.h1s.join(" | ")})`);
        // A record on a phone is a screen of its own, with a back arrow and no bottom bar (PH-2): its breadcrumb nav is the desktop's.
        const bare = phone && screen.name === "a record";
        if (report.navs < 1 && !bare) findings.push(`${screen.name}: no nav landmark`);
        if (report.noScope) findings.push(`${screen.name}: ${report.noScope} th without scope`);
        if (report.bareTables) findings.push(`${screen.name}: ${report.bareTables} tables without header cells`);
        if (report.fakeLists) findings.push(`${screen.name}: ${report.fakeLists} list items outside a list`);
        if (report.listWithBadChildren) findings.push(`${screen.name}: ${report.listWithBadChildren} lists with children that are not list items`);
        await context.close();
      }
      expect(findings).toEqual([]);
    });
  }

  test("the sidebar and the bottom bar are the navigation landmark named Main menu, and the page content is the main landmark", async ({ browser }, testInfo) => {
    const desktop = await signedIn(browser, testInfo, DESKTOP);
    await desktop.page.goto(home());
    await expect(desktop.page.getByRole("navigation", { name: "Main menu" })).toBeVisible();
    await expect(desktop.page.getByRole("main")).toBeVisible();
    await desktop.context.close();
    const phone = await signedIn(browser, testInfo, PHONE);
    await phone.page.goto(home());
    const bar = phone.page.getByRole("navigation", { name: "Main menu" });
    await expect(bar.getByRole("link")).toHaveCount(3);
    await expect(phone.page.getByRole("main")).toBeVisible();
    await phone.context.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-4 Announcements
// ---------------------------------------------------------------------------------------------------------------------

test.describe("A11Y-4 announcements", () => {
  test("a toast lands in a polite live region that was already in the page", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await page.goto(home());
    await expect(captureBox(page)).toBeVisible();
    const region = toasts(page).locator("[aria-live=polite]");
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText("");
    await captureBox(page).fill("Order printer paper");
    await captureBox(page).press("Enter");
    await expect(region.getByText(/^Added to /)).toBeVisible();
    await context.close();
  });

  test("the record's save state is a polite status that says Saving, Saved or Couldn't save", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openAccount(page);
    const status = page.getByRole("status", { name: "Save status" });
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveText("");
    const handle = await status.elementHandle();
    await page.getByRole("main", { name: "Record" }).getByRole("button", { name: "Edit Monthly" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("260");
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(/Saved/);
    // The same element changed its text: a region that is replaced is not announced.
    expect(await handle!.evaluate((el) => el.isConnected)).toBe(true);
    // A failing save says so.
    await page.route("**/api/tables/*/records", (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "{}" }) : route.continue()));
    await page.getByRole("main", { name: "Record" }).getByRole("button", { name: "Edit Monthly" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("261");
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(/Couldn't save/);
    await context.close();
  });

  test("filter results are announced: the bar says what was added and the changes strip says how many records show", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    const polite = page.locator("[role=status][aria-live=polite]");
    // Both regions are in the page before anything is filtered, empty.
    await expect(polite.filter({ hasText: /^$/ }).first()).toBeAttached();
    await filterBar(page).focus();
    await page.keyboard.type("active");
    await page.keyboard.press("Enter");
    await expect(polite.filter({ hasText: /^Filter added: / })).toHaveCount(1);
    await expect(polite.filter({ hasText: /^Showing \d+ of \d+/ })).toHaveCount(1);
    await expect(polite.filter({ hasText: /^Showing \d+ of \d+/ })).toHaveAttribute("aria-atomic", "true");
    await context.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-5 Colour is never the only cue
// ---------------------------------------------------------------------------------------------------------------------

test.describe("A11Y-5 colour is not the only cue", () => {
  test("the selected row of the sidebar is heavier as well as filled, and every row has its mark beside its name", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    const current = nav(page).locator("[aria-current=page]").first();
    await expect(current).toContainText("Clients");
    const weight = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).fontWeight));
    expect(await weight(current)).toBeGreaterThanOrEqual(600);
    const other = nav(page).getByRole("link", { name: /^Tasks/ });
    expect(await weight(other)).toBeLessThan(600);
    // Each collection row: a mark (decoration, hidden from assistive technology) beside a name in text.
    const rows = nav(page).getByRole("list", { name: "Collections" }).getByRole("link");
    expect(await rows.count()).toBeGreaterThan(2);
    for (const row of await rows.all()) {
      await expect(row.locator(".ob-mark")).toHaveCount(1);
      expect((await row.innerText()).trim().length).toBeGreaterThan(0);
    }
    await context.close();
  });

  test("the bottom bar's current tab is heavier, and a selected view tab is underlined", async ({ browser }, testInfo) => {
    const phone = await signedIn(browser, testInfo, PHONE);
    await phone.page.goto(home());
    const bar = phone.page.getByRole("navigation", { name: "Main menu" });
    const weight = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).fontWeight));
    expect(await weight(bar.getByRole("link", { name: "Home" }))).toBeGreaterThanOrEqual(600);
    expect(await weight(bar.getByRole("link", { name: "Collections" }))).toBeLessThan(600);
    await phone.context.close();

    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    const selected = page.getByRole("tab", { selected: true }).first();
    const unselected = page.getByRole("tab", { selected: false }).first();
    const underline = (l: Locator) => l.evaluate((el) => getComputedStyle(el).borderBottomColor);
    const transparent = "rgba(0, 0, 0, 0)";
    expect(await underline(selected), "the selected tab has a line under it").not.toBe(transparent);
    expect(await underline(unselected)).toBe(transparent);
    await context.close();
  });

  test("a menu's chosen item carries a check, not only a colour", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await openClients(page);
    await nav(page).getByRole("button", { name: /^Northwind Studio/ }).click();
    const chosen = page.getByRole("menuitemradio", { checked: true });
    await expect(chosen).toHaveCount(1);
    await expect(chosen.locator("svg")).toHaveCount(1);
    await expect(page.getByRole("menuitemradio", { checked: false }).first().locator("svg")).toHaveCount(0);
    await context.close();
  });

  test("an overdue date is red and says when in words, and a screen reader hears that it is overdue", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    await page.goto(home());
    const due = page.getByRole("region", { name: "Due soon" });
    await expect(due).toBeVisible();
    const overdue = due.locator(".text-danger");
    expect(await overdue.count(), "the seed has an overdue task").toBeGreaterThan(0);
    for (const date of await overdue.all()) {
      await expect(date).toHaveText(/(Yesterday|\d+ days ago|[A-Z][a-z]{2} \d{1,2})/);
      await expect(date.getByText("Overdue", { exact: false })).toBeAttached();
    }
    await context.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-6 Sizing and motion
// ---------------------------------------------------------------------------------------------------------------------

/** What would be lost if the text were twice as large: the page scrolls sideways, or the screen's main controls fall off its edge. */
async function expectNothingLost(page: Page, name: string, controls: Locator[]): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name}: the page scrolls sideways`).toBeLessThanOrEqual(1);
  for (const control of controls) {
    await expect(control, `${name}: ${control}`).toBeVisible();
    const box = await control.boundingBox();
    expect(box && box.x >= -1 && box.x + box.width <= page.viewportSize()!.width + 1, `${name}: ${control} is inside the screen's width`).toBeTruthy();
  }
}

test.describe("A11Y-6 sizing and motion", () => {
  /**
   * 200% browser zoom is the same layout as a viewport half as wide: 1440 px at 200% is 720 CSS px, and 390 px at 200% is 195.
   * 320 CSS px is the narrowest WCAG asks for (1.4.10 reflow), and the text is made twice as large on top of it.
   */
  for (const [label, viewport] of [["200% on a 1440 px screen", { width: 720, height: 450 }], ["320 px with text at 200%", { width: 320, height: 640 }]] as const) {
    test(`text at 200% loses nothing on Home, a list, a record and settings: ${label}`, async ({ browser }, testInfo) => {
      test.setTimeout(120_000);
      const { context, page } = await signedIn(browser, testInfo, viewport, { deviceScaleFactor: label.startsWith("200") ? 2 : 1 });
      const bigText = label.startsWith("320");
      const zoom = async () => {
        if (bigText) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      };
      await page.goto(home());
      await zoom();
      await expectNothingLost(page, "Home", [page.getByRole("heading", { level: 1, name: "Home" }), captureBox(page), page.getByRole("button", { name: "Add", exact: true })]);
      await openClients(page, "By status");
      await zoom();
      await expectNothingLost(page, "a list", [page.getByRole("heading", { level: 1, name: "Clients" }), filterBar(page)]);
      await openAccount(page);
      await zoom();
      await expectNothingLost(page, "a record", [page.getByRole("heading", { level: 1, name: "Fernwood Dental" }), page.getByRole("main", { name: "Record" }).getByRole("region", { name: "Properties" })]);
      await page.goto(`${home()}/settings`);
      await zoom();
      await expectNothingLost(page, "settings", [page.getByRole("heading", { level: 1 })]);
      await context.close();
    });
  }

  test("every button, link and field on desktop is at least 24 by 24 px", async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const { context, page } = await signedIn(browser, testInfo, DESKTOP);
    const small: string[] = [];
    for (const screen of appScreens().filter((s) => !s.as)) {
      await screen.open(page);
      await page.waitForLoadState("networkidle");
      small.push(
        ...(await page.evaluate((name) => {
          const out: string[] = [];
          const targets = document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=option], [role=link], [role=treeitem], [role=combobox]");
          for (const el of targets) {
            const e = el as HTMLElement;
            if (!e.checkVisibility({ checkVisibilityCSS: true })) continue;
            const r = e.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right < 0 || r.bottom < 0 || r.left > innerWidth) continue;
            if (e.closest(".sr-only")) continue;
            // In a sentence (WCAG 2.5.8): a link or button between words of the same paragraph is as tall as the line.
            const display = getComputedStyle(e).display;
            const around = [...(e.parentElement?.childNodes ?? [])].filter((n) => n !== e && (n.textContent ?? "").trim().length > 0);
            if ((display === "inline" || display === "inline-block") && around.length > 0) continue;
            // A layer laid over a larger box (after:inset-0 on a row's link) or around a small one (a 16 px box's 24 px layer) is the press area.
            const layer = (pseudo: "::before" | "::after") => {
              const cs = getComputedStyle(e, pseudo);
              if (cs.content === "none" || cs.position !== "absolute") return false;
              let box: HTMLElement | null = e;
              while (box && getComputedStyle(box).position === "static") box = box.parentElement;
              const edge = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
              const [t, b, l, rt] = [edge(cs.top), edge(cs.bottom), edge(cs.left), edge(cs.right)];
              const cb = box?.getBoundingClientRect();
              const w = edge(cs.width) ?? (cb && l !== null && rt !== null ? cb.width - l - rt : 0);
              const h = edge(cs.height) ?? (cb && t !== null && b !== null ? cb.height - t - b : 0);
              return (w ?? 0) >= 24 && (h ?? 0) >= 24;
            };
            if (layer("::before") || layer("::after")) continue;
            if (r.width < 24 || r.height < 24) out.push(`${name}: ${e.tagName.toLowerCase()}${e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : ""} "${(e.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        }, screen.name)),
      );
    }
    expect(small).toEqual([]);
    await context.close();
  });

  test("on a phone the choice sheet and the date field of a record are 44 px targets (PH-6)", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, PHONE);
    await openAccount(page);
    const properties = page.getByRole("main", { name: "Record" });
    await properties.getByRole("button", { name: "Edit Status" }).evaluate((el) => (el as HTMLElement).click());
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("combobox", { name: "Find an option in Status" })).toBeVisible();
    await settle(page);
    expect(await tapTargetFailures(page), "the choice sheet").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await properties.getByRole("button", { name: "Edit Renewal" }).evaluate((el) => (el as HTMLElement).click());
    await expect(properties.getByRole("textbox", { name: "Renewal", exact: true })).toBeVisible();
    await settle(page);
    expect(await tapTargetFailures(page), "the date field").toEqual([]);
    await context.close();
  });

  test("on a phone the calendar, the list and the timeline have 44 px targets (PH-6)", async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const { context, page } = await signedIn(browser, testInfo, PHONE);
    const open = async (collection: string, view: string) => {
      await page.goto(`/base/${seed.bases[collection]}/${seed.tables[collection]}/${seed.views[`${collection} / ${view}`]}`);
      await expect(page.getByRole("heading", { level: 1, name: collection })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await settle(page);
    };
    await open("Clients", "Follow-ups");
    await expect(page.locator(".fc-daygrid-day").first()).toBeVisible();
    expect(await tapTargetFailures(page), "the calendar").toEqual([]);
    await open("Clients", "By status");
    await expect(page.getByRole("tree")).toBeVisible();
    expect(await tapTargetFailures(page), "the list").toEqual([]);
    await open("Projects", "Schedule");
    await expect(page.getByRole("button", { name: /^Fernwood website rebuild/ }).first()).toBeVisible();
    expect(await tapTargetFailures(page), "the timeline").toEqual([]);
    await context.close();
  });

  test("reduced motion: pop-overs and sheets fade instead of moving, and scrolling does not glide", async ({ browser }, testInfo) => {
    const { context, page } = await signedIn(browser, testInfo, DESKTOP, { reducedMotion: "reduce" });
    await openClients(page);
    await nav(page).getByRole("button", { name: /^Northwind Studio/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    const moving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => Object.keys(k).some((p) => !["offset", "easing", "composite", "computedOffset", "opacity"].includes(p))))
        // A spinner turning is the progress indicator itself, and it is slowed to 2 s under reduced motion (styles/index.css), so it is not a movement of the page.
        .filter((a) => (a as CSSAnimation).animationName !== "ob-spin")
        .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty} on ${(a.effect as KeyframeEffect).target?.tagName.toLowerCase()}`),
    );
    expect(moving, "properties animated while a menu opens").toEqual([]);
    await context.close();
    // A phone's sheet too.
    const phone = await signedIn(browser, testInfo, PHONE, { reducedMotion: "reduce" });
    await phone.page.goto(home());
    await phone.page.getByRole("main").locator("header").first().getByRole("button", { name: /^Northwind Studio/ }).click();
    await expect(phone.page.getByRole("dialog", { name: "Switch workspace" })).toBeVisible();
    const sheetMoves = await phone.page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => Object.keys(k).some((p) => !["offset", "easing", "composite", "computedOffset", "opacity"].includes(p))))
        .filter((a) => (a as CSSAnimation).animationName !== "ob-spin")
        .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty} on ${(a.effect as KeyframeEffect).target?.tagName.toLowerCase()}`),
    );
    expect(sheetMoves, "properties animated while a sheet opens").toEqual([]);
    await phone.context.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A11Y-7 What a search says when it finds nothing
// ---------------------------------------------------------------------------------------------------------------------

test.describe("A11Y-7 no results", () => {
  // A listbox with no option in it is a critical axe finding, and "no matches" is a common state of these screens; the ledger shows them with results.
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`the command palette and Home's Goes to picker with nothing found have no serious or critical axe violations, ${label}`, async ({ browser }, testInfo) => {
      const { context, page } = await signedIn(browser, testInfo, viewport, { reducedMotion: "reduce" });
      const blocking = async () => {
        await settle(page);
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      };
      await page.goto(home());
      await expect(captureBox(page)).toBeVisible();
      await page.getByRole("button", { name: /^Goes to/ }).click();
      const goesTo = page.getByRole("combobox", { name: "Search collections" });
      await goesTo.fill("zzqqxx");
      await expect(page.getByText("No collection matches.")).toBeVisible();
      expect(await blocking(), "Goes to with no match").toEqual([]);
      await page.keyboard.press("Escape");

      if (viewport === PHONE) await page.getByRole("main").locator("header").first().getByRole("button", { name: "Search everything" }).tap();
      else await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Search everything" });
      await palette.getByRole("combobox", { name: "Search" }).fill("zzqqxx");
      await expect(palette.locator("p", { hasText: /^No matches for/ })).toBeVisible();
      expect(await blocking(), "the palette with no match").toEqual([]);
      await context.close();
    });
  }
});
