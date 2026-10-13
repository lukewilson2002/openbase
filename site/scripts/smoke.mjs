#!/usr/bin/env node
// Browser smoke test of the built site, served with its real _headers (scripts/serve-dist.mjs):
//   npm run build && npm run smoke
// Opens every page in installed Google Chrome (Playwright channel "chrome", nothing is downloaded) at
// desktop and phone width, in light and dark, and fails on: console errors or warnings, uncaught
// exceptions, failed requests, Content-Security-Policy violations, requests to other origins,
// horizontal page scroll, and a broken search (Pagefind runs as WebAssembly under the CSP).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const port = Number(process.env.PORT || 4411);
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, [path.join(root, "scripts/serve-dist.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(base + "/")).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 100));
}

const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "index.html" && !p.includes(`${path.sep}pagefind${path.sep}`)) pages.push("/" + path.relative(dist, path.dirname(p)).split(path.sep).join("/") + (path.dirname(p) === dist ? "" : "/"));
  }
})(dist);
pages.push("/this-page-does-not-exist/");

const failures = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 375, height: 800 }]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme });
      await ctx.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
      });
      for (const p of pages) {
        const page = await ctx.newPage();
        const where = `${label}/${scheme} ${p}`;
        const bad = (m) => failures.push(`${where}: ${m}`);
        page.on("console", (m) => ["error", "warning"].includes(m.type()) && !(p.includes("does-not-exist") && /404/.test(m.text())) && bad(`console ${m.type()}: ${m.text()}`));
        page.on("pageerror", (e) => bad(`exception: ${e.message}`));
        page.on("requestfailed", (r) => bad(`request failed: ${r.url()}`));
        page.on("request", (r) => !r.url().startsWith(base) && !r.url().startsWith("data:") && bad(`third-party request: ${r.url()}`));
        const res = await page.goto(base + p, { waitUntil: "load" });
        if (!p.includes("does-not-exist") && res.status() !== 200) bad(`status ${res.status()}`);
        if (p.includes("does-not-exist") && res.status() !== 404) bad(`expected 404, got ${res.status()}`);
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) bad(`page scrolls horizontally by ${over}px`);
        const theme = await page.evaluate(() => document.documentElement.dataset.theme);
        if (theme !== scheme) bad(`theme is ${theme}, expected ${scheme}`);
        await page.close();
      }
      // Search: open the dialog, type, and expect results.
      const page = await ctx.newPage();
      page.on("console", (m) => ["error", "warning"].includes(m.type()) && failures.push(`${label}/${scheme} search: console ${m.type()}: ${m.text()}`));
      await page.goto(base + "/docs/", { waitUntil: "load" });
      await page.locator("button[data-open-modal]").first().click();
      await page.locator("input[type=search], .pagefind-ui__search-input").first().fill("backups");
      try {
        await page.locator(".pagefind-ui__result").first().waitFor({ timeout: 8000 });
      } catch {
        failures.push(`${label}/${scheme}: search for "backups" returned no results`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  for (const f of [...new Set(failures)]) console.error(f);
  console.error(`${failures.length} problem(s)`);
  process.exit(1);
}
console.log(`smoke: ${pages.length} pages x 4 (desktop/phone, light/dark) and search OK`);
