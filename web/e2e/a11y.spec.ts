import AxeBuilder from "@axe-core/playwright";
import { appendFileSync } from "node:fs";
import { expect, newClientContext, test } from "./fixtures";
import { seedLedger, type LedgerSeed } from "./ledgerSeed";
import { SHOTS, SIZES, THEMES, settle, type Size } from "./ledgerShots";

/**
 * A11Y-7: axe-core on every screen of the migration ledger (ledgerShots.ts, the same entries ledger.spec.ts
 * photographs, so a screen added to the ledger is checked here too), in light and dark at 1440 px and 390 px, with
 * the menu, sheet or dialog the ledger shows open. Zero serious or critical violations of WCAG 2.0 to 2.2 level A and
 * AA is the bar. Minor and moderate findings are not failures, but they are listed in the test's output.
 *
 *   OPENBASE_E2E=1 npx playwright test a11y            (the whole sweep)
 *   OPENBASE_E2E=1 A11Y_ONLY=9,21 npx playwright test a11y   (the entries of rows 9 and 21)
 *
 * Rules that are switched off, and why (each is specific; nothing else is excluded):
 *  - Nothing yet. The Glide grid's canvas is not excluded: its accessible table is part of the page and is checked.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Rules switched off, by id, each with the reason it cannot apply. */
const DISABLED_RULES: Record<string, string> = {};

const only = (process.env["A11Y_ONLY"] ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

test.describe.configure({ mode: "serial" });

let seed: LedgerSeed;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  seed = await seedLedger(browser, testInfo);
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
            // Axe measures the contrast of what is painted; a transition half way through would be measured half way through.
            reducedMotion: "reduce",
          },
          `a11y-${shot.slug}-${theme}-${size}`,
        );
        await context.addInitScript((mode) => localStorage.setItem("ob-theme", mode), theme);
        const page = await context.newPage();
        await shot.open({ page, seed, phone, baseURL: testInfo.project.use.baseURL! });
        await settle(page);
        // A sheet or a menu that is still fading in is measured half way (a text at 1:1 against its own backdrop): wait until nothing is.
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));

        let axe = new AxeBuilder({ page }).withTags(TAGS);
        const disabled = Object.keys(DISABLED_RULES);
        if (disabled.length) axe = axe.disableRules(disabled);
        const { violations } = await axe.analyze();

        const report = (list: typeof violations) =>
          list
            .map((v) => {
              const nodes = v.nodes.slice(0, 6).map((n) => `    ${n.target.join(" ")}\n      ${n.html.slice(0, 140)}\n      ${[...n.any, ...n.all, ...n.none].map((c) => c.message).join("; ")}`);
              return `${v.impact} ${v.id}: ${v.help} (${v.nodes.length})\n${nodes.join("\n")}`;
            })
            .join("\n");
        const lesser = violations.filter((v) => v.impact !== "serious" && v.impact !== "critical");
        if (lesser.length) testInfo.annotations.push({ type: "minor axe findings", description: report(lesser) });
        const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        // A11Y_REPORT=file: write what was found instead of failing, to see every screen's findings in one run (a failed test restarts the worker and the seed with it).
        if (process.env["A11Y_REPORT"]) {
          if (violations.length) appendFileSync(process.env["A11Y_REPORT"], `## ${testInfo.title}\n${report(violations)}\n\n`);
          await context.close();
          return;
        }
        expect(blocking, `serious or critical axe violations\n${report(blocking)}`).toEqual([]);
        await context.close();
      });
    }
  }
}
