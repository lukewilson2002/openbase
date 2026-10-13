import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real stack: `e2e/globalSetup.ts` builds the web client, builds the
 * Rust server (which embeds `web/dist`), starts `target/debug/opengrid` on a temporary data
 * directory and a free port, and exports its address as OPENGRID_E2E_URL for the tests.
 *
 *   OPENGRID_E2E=1 npm run e2e
 *
 * Browsers are NOT downloaded: the tests run in the locally installed Google Chrome
 * (`channel: "chrome"`). Knobs:
 *   OPENGRID_E2E_URL=http://host:port   use a running server instead of starting one
 *   OPENGRID_E2E_SKIP_BUILD=1           reuse web/dist and target/debug/opengrid as they are
 *   OPENGRID_E2E_KEEP_DATA=1            keep the temporary data directory (its path is printed)
 *
 * The projects depend on each other on purpose: they share one server and one data directory, and
 * the first one to run sees a fresh instance (smoke: the first-run screen), the second sets it up
 * through the UI (journey), the others work on that instance (grid, then sharing and automations).
 */
const chrome = { ...devices["Desktop Chrome"], channel: "chrome" as const };

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
    baseURL: process.env["OPENGRID_E2E_URL"] ?? "http://127.0.0.1:8080",
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
  ],
});
