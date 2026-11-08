import { DESIGN_SECTIONS, DESIGN_THEMES } from "../src/dev/designSections";
import { expect, test } from "./fixtures";

/**
 * The design reference page (/__dev/design, UX overhaul DL-2) in the e2e build, which is built with
 * VITE_DESIGN_PAGE=1 (playwright.config.ts): every token family and core component has its own section, drawn in
 * both themes, at desktop and phone width. Needs no account. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`every section renders in light and dark at ${name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/__dev/design");
    await expect(page.getByRole("heading", { level: 1, name: "Design reference" })).toBeVisible();

    for (const section of DESIGN_SECTIONS) {
      const block = page.locator(`[data-design-section="${section.id}"]`);
      await expect(block.getByRole("heading", { level: 2, name: section.title }), section.id).toHaveCount(1);
      for (const theme of DESIGN_THEMES) {
        const column = block.locator(`[data-design-theme="${theme}"]`);
        await column.scrollIntoViewIfNeeded();
        await expect(column, `${section.id} ${theme}`).toBeVisible();
        // The column's own label plus at least one example.
        expect(await column.locator(":scope > *").count(), `${section.id} ${theme} is empty`).toBeGreaterThan(1);
      }
    }

    // The columns really are in their themes: the page ground is a different colour in each.
    const grounds = await page.locator('[data-design-section="colour"] [data-design-theme]').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(grounds).toHaveLength(2);
    expect(grounds[0]).not.toBe(grounds[1]);

    // A phone page does not scroll sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("the overlays are drawn open in their frames, and a dark column's floating panels stay dark", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__dev/design");
  for (const theme of DESIGN_THEMES) {
    for (const [section, role] of [
      ["sheet", "dialog"],
      ["dialog", "alertdialog"],
      ["command-palette", "dialog"],
      ["popover-menu", "menu"],
    ] as const) {
      const column = page.locator(`[data-design-section="${section}"] [data-design-theme="${theme}"]`);
      await expect(column.getByRole(role).first(), `${section} ${theme}`).toBeVisible();
    }
  }
  // The menu is portalled into its own column, so it takes that column's colours, not the page's.
  const surfaces = await page.locator('[data-design-section="popover-menu"] [data-design-theme] [role="menu"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(surfaces).toHaveLength(2);
  expect(surfaces[0]).not.toBe(surfaces[1]);
});
