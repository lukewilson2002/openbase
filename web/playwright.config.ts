import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real stack: `e2e/globalSetup.ts` builds the web client, builds the
 * Rust server (which embeds `web/dist`), starts `target/debug/openbase` on a temporary data
 * directory and a free port, and exports its address as OPENBASE_E2E_URL for the tests.
 *
 *   OPENBASE_E2E=1 npm run e2e
 *
 * Browsers are NOT downloaded: the tests run in the locally installed Google Chrome
 * (`channel: "chrome"`; GitHub's Ubuntu runners have it too). Knobs:
 *   OPENBASE_E2E_BROWSER=chromium       use Playwright's own Chromium instead (CI fallback only; run
 *                                       `npx playwright install chromium` first; never needed locally)
 *   OPENBASE_E2E_URL=http://host:port   use a running server instead of starting one
 *   OPENBASE_E2E_SKIP_BUILD=1           reuse web/dist and target/debug/openbase as they are
 *   OPENBASE_E2E_KEEP_DATA=1            keep the temporary data directory (its path is printed)
 *
 * The projects depend on each other on purpose: they share one server and one data directory, and
 * the first one to run sees a fresh instance (smoke: the first-run screen), the second sets it up
 * through the UI (journey), the others work on that instance (grid, then sharing and automations).
 */
const browser = process.env["OPENBASE_E2E_BROWSER"] ?? "chrome";
if (browser !== "chrome" && browser !== "chromium") {
  throw new Error(`OPENBASE_E2E_BROWSER must be "chrome" or "chromium", not "${browser}".`);
}
const chrome = { ...devices["Desktop Chrome"], ...(browser === "chrome" ? { channel: "chrome" as const } : {}) };

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // Set by globalSetup before the workers start.
    baseURL: process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "smoke", testMatch: /smoke\.spec\.ts$/, use: chrome },
    { name: "journey", testMatch: /journey\.spec\.ts$/, use: chrome, dependencies: ["smoke"] },
    { name: "grid", testMatch: /grid\.spec\.ts$/, use: chrome, dependencies: ["journey"] },
    // Forms, share links and CSV; signs up its own user, so it only needs the instance to be set up.
    { name: "sharing", testMatch: /sharing\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    { name: "automations", testMatch: /automations\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    // Kanban, gallery, calendar, timeline, list, trash and the notification bell; signs up its own user.
    { name: "views", testMatch: /views\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    // An MCP OAuth client: registration, login, consent, code exchange, MCP calls and revocation from
    // the account page; signs up its own users.
    { name: "oauth", testMatch: /oauth\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    // The account page's AI assistants tab: instructions per assistant, copy buttons, phone width, both themes.
    { name: "assistants", testMatch: /assistants\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    // Passkeys with Chrome's virtual authenticator: add, sign in without a password, skip 2FA, remove,
    // and an administrator removing another user's passkeys; signs up its own users.
    { name: "passkeys", testMatch: /passkeys\.spec\.ts$/, use: chrome, dependencies: ["grid"] },
    // Administration -> Email: changes the instance-wide mail settings and restores them, so it
    // runs after everything else.
    { name: "admin-email", testMatch: /adminEmail\.spec\.ts$/, use: chrome, dependencies: ["sharing", "automations", "views", "oauth", "assistants", "passkeys"] },
  ],
});
