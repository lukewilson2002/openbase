import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive a real `opengrid` binary on a temporary data directory
 * (docs/plans §1.6). They are opt-in: start the server yourself (or let a harness do it)
 * and run `OPENGRID_E2E=1 npm run e2e`. Browsers are not installed by `npm ci`;
 * run `npx playwright install chromium` once before the first run.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.OPENGRID_E2E_URL ?? "http://127.0.0.1:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
