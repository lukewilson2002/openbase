import { createHash } from "node:crypto";
import { expect, test as base, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";

/**
 * `test` with an automatic watchdog: every page opened by a test is observed, and the test fails
 * if the page logged a console error, threw, violated the Content-Security-Policy, or had a
 * request fail at the network level.
 *
 * One thing is tolerated: a signed-out visitor's `GET /api/auth/me` answers 401 by design, and
 * Chrome reports every 4xx fetch in the console ("Failed to load resource"). That specific message
 * for that specific URL is ignored; any other failed resource is a problem.
 *
 * Every test also gets its own client address. The server limits sign-ins (10 a minute) and sign-ups
 * (10 an hour) per client address, and the whole suite would otherwise come from 127.0.0.1 and share
 * one bucket, so a slow run, a retry or one more spec exhausts it. The e2e server trusts
 * `X-Forwarded-For` (OPENBASE_TRUST_PROXY, see globalSetup.ts; it only listens on loopback, and
 * production limits are untouched), and the `page`, `context` and `request` fixtures send an address
 * derived from the project, the test and the retry. Contexts that a test or a `beforeAll` makes itself
 * with `browser.newContext()` do not inherit it: use {@link newClientContext}.
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
  page.on("pageerror", (err) => problems.push(`uncaught exception: ${err.message}${err.stack ? `\n${err.stack.split("\n").slice(1, 6).join("\n")}` : ""}`));
  page.on("requestfailed", (req) => {
    // Navigations away and aborted event streams are not failures of the page.
    const error = req.failure()?.errorText ?? "";
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(error)) return;
    problems.push(`request failed: ${req.method()} ${req.url()} (${error})`);
  });
}

/**
 * A client address in 10.0.0.0/8 that depends only on `parts` (the same parts, the same address, so a
 * failure can be reproduced; different parts, a different one with a collision chance of about
 * 1 in 16 million). 10.0.0.0 and 10.255.255.255 are avoided.
 */
export function clientAddress(...parts: (string | number)[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  const n = 1 + (digest.readUInt32BE(0) % 0xff_ff_fe); // 1 .. 16777214
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

/** The `X-Forwarded-For` header a browser context or API request context sends to be its own client. */
export function clientHeaders(testInfo: Pick<TestInfo, "project" | "testId" | "retry" | "repeatEachIndex">, label = ""): Record<string, string> {
  return { "X-Forwarded-For": clientAddress(testInfo.project.name, testInfo.testId, testInfo.retry, testInfo.repeatEachIndex, label) };
}

let contexts = 0;

/**
 * OPENBASE_E2E_CPU_THROTTLE=4 makes every page of the run four times slower (Chrome DevTools CPU
 * throttling, the same as the Performance panel's "4x slowdown"), to find out locally what a busy CI
 * machine finds out in a release run: the tests must not depend on how fast the page is. Test-only; a
 * normal run does not set it.
 */
function throttle(page: Page): void {
  const rate = Number(process.env["OPENBASE_E2E_CPU_THROTTLE"] ?? "1");
  if (!(rate > 1)) return;
  void (async () => {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    } catch {
      /* the page closed first */
    }
  })();
}

/**
 * `browser.newContext()` for a second browser profile (a stranger, another user, a `beforeAll` that
 * signs up), with its own client address (see {@link test}). `label` tells profiles of one test
 * apart; it needs no uniqueness beyond that, a counter does the rest.
 */
export async function newClientContext(browser: Browser, testInfo: TestInfo, options: BrowserContextOptions = {}, label = ""): Promise<BrowserContext> {
  const headers = clientHeaders(testInfo, `${label}#${++contexts}`);
  const context = await browser.newContext({ ...options, extraHTTPHeaders: { ...headers, ...options.extraHTTPHeaders } });
  context.on("page", throttle);
  return context;
}

export const test = base.extend<{ diagnostics: Diagnostics }>({
  // Overrides the (option) fixture that `context`, `page` and `request` are built from.
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use(clientHeaders(testInfo));
  },
  diagnostics: [
    async ({ context }, use) => {
      const problems: string[] = [];
      // Violations are also reported as console errors by Chrome; this makes them explicit.
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`);
        });
      });
      // Glide's double-click detection reads the time of the last mouse release (see clickGrid).
      await context.addInitScript(() => {
        window.addEventListener("mouseup", () => ((window as unknown as { __obLastMouseUp?: number }).__obLastMouseUp = Date.now()), true);
      });
      context.on("page", (page) => watch(page, problems));
      context.on("page", throttle);
      for (const page of context.pages()) {
        watch(page, problems);
        throttle(page);
      }
      const allowed: RegExp[] = [];
      await use({ problems, allow: (pattern) => void allowed.push(pattern) });
      const unexpected = problems.filter((p) => !allowed.some((a) => a.test(p)));
      expect(unexpected, "the app logged errors, threw, or broke the Content-Security-Policy").toEqual([]);
    },
    { auto: true },
  ],
});

/** How long a wait for the page may take before the test says what it was waiting for. */
const WAIT_MS = 5_000;

/**
 * Wait for two animation frames. Bounded: a page that never paints (a hidden tab) must not hang the
 * test until its own timeout without saying so.
 */
async function frames(page: Page, timeoutMs = WAIT_MS): Promise<void> {
  const painted = await page.evaluate(
    (ms) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve(true);
          }),
        );
      }),
    timeoutMs,
  );
  if (!painted) throw new Error(`the page painted no frame within ${timeoutMs} ms (is its tab hidden?)`);
}

/**
 * Move the pointer to (x, y) and wait for two frames. Glide (the canvas grid) resolves the cell
 * under the pointer from mouse-move events, so a click that arrives in the same tick as the move
 * lands on whatever was hovered before. A real pointer always moves first; tests have to as well.
 */
export async function hoverAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await frames(page);
}

/** What has the keyboard and what the grid thinks is selected, for the message of a failed wait. */
async function describeGridState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    const aria = el?.getAttribute("aria-label");
    const focus = el ? `<${el.tagName.toLowerCase()}${aria ? ` aria-label="${aria}"` : ""}>` : "nothing";
    const selected = [...document.querySelectorAll("canvas[data-testid='data-grid-canvas'] td[aria-selected='true']")].map((td) => td.id).join(", ");
    const editor = document.querySelector("#portal input, #portal textarea, #portal [role='combobox']") ? "yes" : "no";
    return `focus is on ${focus}; cell editor open: ${editor}; selected cells: ${selected || "none"}`;
  });
}

/** A cell editor (an input or a text area) holds the keyboard. */
async function editorHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""));
}

/** Wait until a cell editor (an input or text area) has keyboard focus: keys sent earlier are lost. */
export async function editorFocused(page: Page, timeoutMs = WAIT_MS): Promise<void> {
  try {
    await page.waitForFunction(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""), undefined, { polling: 25, timeout: timeoutMs });
  } catch (error) {
    throw new Error(`no cell editor took the keyboard within ${timeoutMs} ms (${await describeGridState(page)})`, { cause: error });
  }
}

/**
 * Wait until the grid has keyboard focus. Glide focuses its canvas a frame after a click (keys sent
 * before that are lost), or a cell of the accessible table inside the canvas after an edit. A cell
 * editor that is open holds the focus instead, and keeps it for good: that is reported after
 * `timeoutMs`, with the state of the grid, instead of after the whole test timeout.
 */
export async function gridFocused(page: Page, timeoutMs = WAIT_MS): Promise<void> {
  // Glide refocuses the grid in a requestAnimationFrame scheduled by the click: let that run first.
  await frames(page);
  try {
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector("canvas[data-testid='data-grid-canvas']");
        return !!canvas && (canvas === document.activeElement || canvas.contains(document.activeElement));
      },
      undefined,
      { polling: 25, timeout: timeoutMs },
    );
  } catch (error) {
    throw new Error(`the grid did not take the keyboard within ${timeoutMs} ms (${await describeGridState(page)})`, { cause: error });
  }
}

/** Glide counts two mouse releases less than this many milliseconds apart as a double click. */
const GLIDE_DOUBLE_CLICK_MS = 500;

/**
 * Click the canvas grid at (x, y) the way a person does, and return once the grid owns the keyboard.
 *
 * Two traps are closed here:
 *
 *  - Glide decides "double click" from the time of the last mouse release anywhere on the page, not
 *    from the cell. A click on "Add record" a moment ago followed by a click on an already selected
 *    cell (the app selects the new row by itself) therefore opens that cell's editor, and the editor
 *    holds the keyboard for good. So the click waits until the last release is out of that window
 *    (the page records it, see the init script of `test`). It never sleeps: when nothing was clicked
 *    recently it does not wait at all.
 *  - Should the grid still not own the keyboard, the click is made again, three times at most, after
 *    closing an editor that a click opened (Escape, nothing is committed) or focusing the canvas of a
 *    cell that was already selected (Glide does not take the keyboard for a click that changes
 *    nothing). After that the error says what the grid looked like.
 *
 * `double` makes a real double click and waits for the editor; `right` a right click (the context
 * menu takes the focus, so there is no wait for the grid).
 */
export async function clickGrid(page: Page, x: number, y: number, opts: { double?: boolean; right?: boolean } = {}): Promise<void> {
  await hoverAt(page, x, y);
  if (opts.double) {
    await page.mouse.dblclick(x, y);
    await editorFocused(page);
    return;
  }
  if (opts.right) {
    await page.mouse.click(x, y, { button: "right" });
    return;
  }
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    await page.waitForFunction(
      (windowMs) => Date.now() - ((window as unknown as { __obLastMouseUp?: number }).__obLastMouseUp ?? 0) > windowMs + 20,
      GLIDE_DOUBLE_CLICK_MS,
      { polling: 25, timeout: WAIT_MS },
    );
    await page.mouse.click(x, y);
    try {
      await gridFocused(page, attempt < attempts ? 2_000 : WAIT_MS);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      if (await editorHasFocus(page)) {
        await page.keyboard.press("Escape");
      } else {
        // Glide takes the keyboard for a click that selects a cell, not for one on the cell that is
        // already selected. Put the focus on the grid directly, as tabbing or clicking back would.
        await page.locator("canvas[data-testid='data-grid-canvas']").first().focus();
      }
      await frames(page);
    }
  }
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
