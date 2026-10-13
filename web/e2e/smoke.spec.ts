import { expect, test } from "./fixtures";

/**
 * Smoke test of the shipped artifact: `/` is served by the Rust server from the web client
 * embedded in the binary (e2e/globalSetup.ts builds it with `--features debug-embed` and checks
 * that it is served with web/dist gone), not by Vite. On a fresh instance the visitor lands on
 * the first-run screen. The watchdog from ./fixtures fails the test on any console error, uncaught
 * exception, CSP violation or failed request.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");

test("loads / from the embedded build without console errors or CSP violations", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-type"]).toContain("text/html");

  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");

  // A fresh instance shows the first-run screen (an already configured one shows the login screen).
  await expect(page.getByRole("heading", { name: /Set up OpenBase|Log in/ })).toBeVisible();
  // The stylesheet and script of the app were loaded from the server's own origin.
  const origins = await page.evaluate(() => [...document.querySelectorAll("script[src], link[rel=stylesheet]")].map((n) => (n as HTMLScriptElement).src || (n as HTMLLinkElement).href));
  expect(origins.length).toBeGreaterThan(0);
  for (const o of origins) expect(new URL(o).origin).toBe(new URL(page.url()).origin);
  // The app is not a dev build: no Vite client, no source maps referenced.
  expect(await page.content()).not.toContain("/@vite/client");
});

test("serves client-side routes from the app shell and real 404s for missing assets", async ({ page, request }) => {
  const route = await request.get("/some/client/route");
  expect(route.status()).toBe(200);
  expect(route.headers()["content-type"]).toContain("text/html");
  const missing = await request.get("/assets/does-not-exist.js");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"] ?? "").not.toContain("text/html");
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: /Set up OpenBase|Log in|Page not found/ })).toBeVisible();
});

test("unknown API paths return the JSON error format", async ({ request }) => {
  const res = await request.get("/api/does-not-exist");
  expect(res.status()).toBe(404);
  expect((await res.json()).error.code).toBe("not_found");
});

test("the fresh instance reports that it needs setup", async ({ request }) => {
  const res = await request.get("/api/setup");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ needs_setup: true });
});

// Self-tests of the watchdog: these tests are expected to fail (`test.fail()`), which proves that a
// console error and a CSP violation really do fail a test, so "no errors" above means something.
test.describe("the watchdog", () => {
  test("fails a test whose page logs a console error", async ({ page }) => {
    test.fail();
    await page.goto("/");
    await page.evaluate(() => console.error("deliberate error"));
  });

  test("fails a test whose page violates the Content-Security-Policy", async ({ page }) => {
    test.fail();
    await page.goto("/");
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__injected = true";
      document.head.append(s);
    });
    await page.waitForTimeout(200);
  });
});
