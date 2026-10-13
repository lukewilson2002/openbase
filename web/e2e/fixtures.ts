import { expect, test as base, type Page } from "@playwright/test";

/**
 * `test` with an automatic watchdog: every page opened by a test is observed, and the test fails
 * if the page logged a console error, threw, violated the Content-Security-Policy, or had a
 * request fail at the network level.
 *
 * One thing is tolerated: a signed-out visitor's `GET /api/auth/me` answers 401 by design, and
 * Chrome reports every 4xx fetch in the console ("Failed to load resource"). That specific message
 * for that specific URL is ignored; any other failed resource is a problem.
 */
export interface Diagnostics {
  problems: string[];
  /**
   * Declare that a problem is expected in this test (for example the 401 Chrome logs for a login
   * with a wrong password that the test makes on purpose). Matched against the problem text.
   */
  allow(pattern: RegExp): void;
}

const ALLOWED = [{ text: /Failed to load resource: the server responded with a status of 401/, url: /\/api\/auth\/me$/ }];

function watch(page: Page, problems: string[]): void {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location().url;
    if (ALLOWED.some((a) => a.text.test(msg.text()) && a.url.test(url))) return;
    problems.push(`console.error: ${msg.text()}${url ? ` (${url})` : ""}`);
  });
  page.on("pageerror", (err) => problems.push(`uncaught exception: ${err.message}`));
  page.on("requestfailed", (req) => {
    // Navigations away and aborted event streams are not failures of the page.
    const error = req.failure()?.errorText ?? "";
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(error)) return;
    problems.push(`request failed: ${req.method()} ${req.url()} (${error})`);
  });
}

export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ context }, use) => {
      const problems: string[] = [];
      // Violations are also reported as console errors by Chrome; this makes them explicit.
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`);
        });
      });
      context.on("page", (page) => watch(page, problems));
      for (const page of context.pages()) watch(page, problems);
      const allowed: RegExp[] = [];
      await use({ problems, allow: (pattern) => void allowed.push(pattern) });
      const unexpected = problems.filter((p) => !allowed.some((a) => a.test(p)));
      expect(unexpected, "the app logged errors, threw, or broke the Content-Security-Policy").toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Move the pointer to (x, y) and wait for two frames. Glide (the canvas grid) resolves the cell
 * under the pointer from mouse-move events, so a click that arrives in the same tick as the move
 * lands on whatever was hovered before. A real pointer always moves first; tests have to as well.
 */
export async function hoverAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Wait until a cell editor (an input or text area) has keyboard focus: keys sent earlier are lost. */
export async function editorFocused(page: Page): Promise<void> {
  await page.waitForFunction(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""), undefined, { polling: 25 });
}

/**
 * Wait until the grid has keyboard focus. Glide focuses its canvas a frame after a click (keys sent
 * before that are lost), or a cell of the accessible table inside the canvas after an edit.
 */
export async function gridFocused(page: Page): Promise<void> {
  // Glide refocuses the grid in a requestAnimationFrame scheduled by the click: let that run first.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas[data-testid='data-grid-canvas']");
      return !!canvas && (canvas === document.activeElement || canvas.contains(document.activeElement));
    },
    undefined,
    { polling: 25 },
  );
}

/**
 * Type into the selected grid cell the way a person does: the first key opens the editor (the grid
 * hands it that key), the rest go to the editor once it has focus. Keys sent in the same instant as
 * the first one would reach the canvas before the editor exists and be dropped. The caller presses
 * Enter, Tab or Escape afterwards.
 */
export async function typeToEdit(page: Page, text: string): Promise<void> {
  await page.keyboard.press(text[0]!);
  await editorFocused(page);
  if (text.length > 1) await page.keyboard.type(text.slice(1));
}

/**
 * The grid ignores undo and redo while it is still finishing the previous write (an operation moves
 * to the redo list only once the server has answered), and a test polling the API can see the new
 * value a moment before the browser has processed the response. Wait for that moment to pass.
 */
export async function undo(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Z");
}

export async function redo(page: Page): Promise<void> {
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Shift+Z");
}

export { expect };
