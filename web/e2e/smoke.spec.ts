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
  await expect(page.getByRole("heading", { name: /Welcome to your OpenBase|Log in/ })).toBeVisible();
  // The stylesheet and script of the app were loaded from the server's own origin.
  const origins = await page.evaluate(() => [...document.querySelectorAll("script[src], link[rel=stylesheet]")].map((n) => (n as HTMLScriptElement).src || (n as HTMLLinkElement).href));
  expect(origins.length).toBeGreaterThan(0);
  for (const o of origins) expect(new URL(o).origin).toBe(new URL(page.url()).origin);
  // The app is not a dev build: no Vite client, no source maps referenced.
  expect(await page.content()).not.toContain("/@vite/client");
});

test("the favicons, touch icon and web app manifest are linked, load and decode without CSP violations", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Welcome to your OpenBase|Log in/ })).toBeVisible();
  // The OpenBase mark is on the page, drawn inline (no image request, nothing for the CSP to block).
  await expect(page.getByRole("img", { name: "OpenBase" })).toBeVisible();

  const links = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")].map((l) => ({ rel: l.rel, type: l.type, href: l.href })),
  );
  const byRel = (rel: string, type?: string) => links.find((l) => l.rel === rel && (!type || l.type === type));
  const svg = byRel("icon", "image/svg+xml");
  const ico = byRel("icon", "image/x-icon");
  const touch = byRel("apple-touch-icon");
  const manifestLink = byRel("manifest");
  expect(svg && ico && touch && manifestLink, `icon links in the page head: ${JSON.stringify(links)}`).toBeTruthy();
  expect(await page.locator("meta[name=theme-color]").getAttribute("content")).toBe("#1F5AE0");

  // Content types and caching, as the server sends them.
  const expected: [string, string | RegExp][] = [
    [svg!.href, "image/svg+xml"],
    [ico!.href, /^image\/(x-icon|vnd\.microsoft\.icon)$/],
    [touch!.href, "image/png"],
    [manifestLink!.href, "application/manifest+json"],
  ];
  for (const [href, type] of expected) {
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    if (typeof type === "string") expect(contentType, href).toBe(type);
    else expect(contentType, href).toMatch(type);
    expect(res.headers()["etag"], href).toBeTruthy();
    expect(res.headers()["cache-control"], href).toBe(href === manifestLink!.href ? "no-cache" : "public, max-age=86400");
  }

  // The browser itself decodes every image (img-src 'self') and parses the manifest (connect-src
  // 'self'); a CSP violation or a broken file would surface in the diagnostics watchdog.
  const manifest = await page.evaluate(async (href) => (await fetch(href)).json(), manifestLink!.href);
  expect(manifest).toMatchObject({ name: "OpenBase", short_name: "OpenBase", start_url: "/", display: "standalone", theme_color: "#1F5AE0" });
  expect(typeof manifest.background_color).toBe("string");
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
  expect(icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
  const decoded = await page.evaluate(
    (urls) =>
      Promise.all(
        urls.map(
          (url) =>
            new Promise<{ url: string; width: number }>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve({ url, width: img.naturalWidth });
              img.onerror = () => reject(new Error(`could not load ${url}`));
              img.src = url;
            }),
        ),
      ),
    [svg!.href, ico!.href, touch!.href, ...icons.map((i) => new URL(i.src, page.url()).href)],
  );
  for (const d of decoded) expect(d.width, d.url).toBeGreaterThan(0);
  expect(decoded.find((d) => d.url.endsWith("/icon-192.png"))?.width).toBe(192);
  expect(decoded.find((d) => d.url.endsWith("/icon-512.png"))?.width).toBe(512);
  expect(decoded.find((d) => d.url.endsWith("/apple-touch-icon.png"))?.width).toBe(180);
});

test("serves client-side routes from the app shell and real 404s for missing assets", async ({ page, request }) => {
  const route = await request.get("/some/client/route");
  expect(route.status()).toBe(200);
  expect(route.headers()["content-type"]).toContain("text/html");
  const missing = await request.get("/assets/does-not-exist.js");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"] ?? "").not.toContain("text/html");
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: /Welcome to your OpenBase|Log in|Page not found/ })).toBeVisible();
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
