import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, newClientContext, test } from "./fixtures";
import { SHOTS, SIZES, THEMES, settle, type Shot, type Size, type Theme } from "./ledgerShots";
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

// ------------------------------------------------------------------------------------------------------

/** Rows to take, from `LEDGER_ONLY=2,4`; all of them when unset. */
const only = (process.env["LEDGER_ONLY"] ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const file = (shot: Shot, theme: Theme, size: Size) => join(OUT_DIR, `${String(shot.row).padStart(2, "0")}-${shot.slug}-${theme}-${size}.png`);

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
            storageState: shot.as === "anonymous" ? { cookies: [], origins: [] } : seed[shot.as ?? "owner"],
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
        await shot.open({ page, seed, phone, baseURL: testInfo.project.use.baseURL! });
        await settle(page);
        // The phone must not scroll sideways on any shot (PH-7): a screenshot of a page wider than the screen hides it.
        if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "the page is wider than the phone").toBeLessThanOrEqual(0);
        await page.screenshot({ path: file(shot, theme, size), animations: "disabled", caret: "hide" });
        await context.close();
      });
    }
  }
}
