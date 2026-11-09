/**
 * DONE-10: how long opening a collection of 50,000 records takes on this branch and on `main`, and how
 * much JavaScript the first screen loads. Run it through scripts/perf-compare.sh, which builds both
 * sides first; by hand:
 *
 *   node web/e2e/perf/compare.mjs --branch-bin <openbase> --branch-dist <web/dist> \
 *                                 --main-bin <openbase> --main-dist <web/dist> [--runs 5] [--records 50000]
 *
 * Each side gets its own server, on a throwaway data directory and a free port, with the same
 * collection (the shape of scripts/loadtest.sh's "Orders") loaded through the HTTP API. The runs of the
 * two sides alternate (branch, main, branch, ...) so that a slow minute on the machine hits both, and
 * every run is a fresh browser context: no HTTP cache, no service worker, but a warm server (one
 * discarded warm-up run per side comes first, so the server's own first-read cost is not in the number).
 *
 * The time is `performance.now()` in the page, which starts at the navigation, when the first row of
 * the grid has text in Glide's accessible table and two animation frames have passed (the canvas is
 * drawn in the frame after the data arrives). The median of the runs is the result.
 *
 * Entry JavaScript is the entry chunk named by index.html plus everything it imports statically
 * (modulepreload links and `import ... from "./x.js"`), read from the built files: dynamic imports
 * are loaded later and do not count. The page also reports the JavaScript it actually fetched before
 * the first rows were painted.
 *
 * Browsers are not downloaded: the local Google Chrome is used, as the e2e suite does
 * (OPENBASE_E2E_BROWSER=chromium for Playwright's own).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium, request } from "@playwright/test";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const need = (k) => {
  const v = args.get(k);
  if (!v) throw new Error(`--${k} is required (see the header of ${fileURLToPath(import.meta.url)}).`);
  return resolve(v);
};
const RUNS = Number(args.get("runs") ?? 5);
const RECORDS = Number(args.get("records") ?? 50_000);
const sides = [
  { name: "branch", bin: need("branch-bin"), dist: need("branch-dist") },
  { name: "main", bin: need("main-bin"), dist: need("main-dist") },
];
const EMAIL = "perf@example.com";
const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenBase-CSRF": "1" };

// ---- entry JavaScript -------------------------------------------------------------------------

function entryJs(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const queue = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="([^"]+\.js)"/g)].map((m) => m[1]);
  const seen = new Map();
  while (queue.length) {
    const ref = queue.pop().replace(/^\//, "");
    if (seen.has(ref)) continue;
    const file = readFileSync(join(dist, ref));
    seen.set(ref, { raw: file.length, gzip: gzipSync(file).length });
    // Static imports only: `from"./x.js"` and bare `import"./x.js"`. `import("./x.js")` is dynamic.
    for (const m of file.toString("utf8").matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) queue.push(`assets/${m[1]}`);
  }
  let raw = 0;
  let gzip = 0;
  for (const v of seen.values()) {
    raw += v.raw;
    gzip += v.gzip;
  }
  return { files: seen.size, raw, gzip };
}

// ---- servers and data -------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function startServer(side) {
  const dataDir = mkdtempSync(join(tmpdir(), `openbase-perf-${side.name}-`));
  const port = await freePort();
  const url = `http://localhost:${port}`;
  let log = "";
  const child = spawn(side.bin, ["serve"], {
    cwd: dataDir,
    env: { ...process.env, OPENBASE_DATA_DIR: dataDir, OPENBASE_BIND: `127.0.0.1:${port}`, OPENBASE_PUBLIC_URL: url, OPENBASE_OPEN_SIGNUP: "true", OPENBASE_BACKUP_HOUR: "-1", OPENBASE_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [child.stdout, child.stderr]) s.on("data", (c) => (log = (log + c).slice(-4000)));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${side.name}: openbase exited early.\n${log}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${side.name}: openbase did not answer in 30 s.\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ...side, url, dataDir, child };
}

async function call(req, method, path, data) {
  const res = await req[method](path, { data, headers: CSRF });
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Signs up the administrator, loads RECORDS records, and returns the collection's page URL and the session. */
async function seed(server) {
  const req = await request.newContext({ baseURL: server.url });
  await call(req, "post", "/api/auth/signup", { email: EMAIL, name: "Perf", password: PASSWORD });
  await req.patch("/api/auth/me", { data: { intro_seen: true }, headers: CSRF });
  const ws = await call(req, "post", "/api/workspaces", { name: "Perf" });
  const base = await call(req, "post", `/api/workspaces/${ws.id}/bases`, { name: "Perf" });
  const table = await call(req, "post", `/api/bases/${base.id}/tables`, { name: "Orders" });
  const field = async (name, type, options = {}) => (await call(req, "post", `/api/tables/${table.id}/fields`, { name, type, options })).id;
  const amount = await field("Amount", "number");
  const notes = await field("Notes", "rich_text");
  const qty = await field("Qty", "number");
  const status = await field("Status", "single_select", { choices: ["New", "Packed", "Shipped", "Delivered", "Returned"].map((name) => ({ name })) });
  const tags = await field("Tags", "multiple_select", { choices: ["rush", "gift", "fragile"].map((name) => ({ name })) });
  const due = await field("Due", "date");
  const paid = await field("Paid", "checkbox");
  await field("Total", "formula", { expression: "{Amount} * {Qty}" });
  const pad = (n) => String(n).padStart(2, "0");
  for (let from = 0; from < RECORDS; from += 1000) {
    const records = [];
    for (let i = from; i < Math.min(from + 1000, RECORDS); i++) {
      records.push({
        values: {
          [table.primary_field_id]: `Order ${i}`,
          [amount]: ((i * 7919) % 100000) / 100,
          [qty]: 1 + (i % 20),
          [status]: ["New", "Packed", "Shipped", "Delivered", "Returned"][i % 5],
          [due]: `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`,
          ...(i % 3 === 0 ? { [notes]: `note for order ${i}`, [tags]: ["rush"] } : {}),
          ...(i % 4 === 0 ? { [paid]: true } : {}),
        },
      });
    }
    await call(req, "post", `/api/tables/${table.id}/records`, { typecast: true, records });
  }
  const total = (await call(req, "post", `/api/views/${table.views[0].id}/query`, { limit: 1 })).total;
  if (total !== RECORDS) throw new Error(`${server.name}: the collection holds ${total} records, not ${RECORDS}.`);
  const state = await req.storageState();
  await req.dispose();
  return { path: `/base/${base.id}/${table.id}/${table.views[0].id}`, state };
}

// ---- one run ----------------------------------------------------------------------------------

const watchRows = () => {
  // Resolves when the grid's accessible table has a row of text and two frames have been drawn since.
  window.__rowsPaintedAt = null;
  const check = () => {
    if (window.__rowsPaintedAt !== null) return;
    const cell = [...document.querySelectorAll('[role="gridcell"]')].find((c) => /^Order \d+$/.test(c.textContent?.trim() ?? ""));
    if (!cell) return;
    window.__rowsPaintedAt = -1;
    requestAnimationFrame(() => requestAnimationFrame(() => (window.__rowsPaintedAt = performance.now())));
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
};

async function run(browser, server, target) {
  const context = await browser.newContext({ baseURL: server.url, storageState: target.state, serviceWorkers: "block" });
  await context.addInitScript(watchRows);
  const page = await context.newPage();
  const js = [];
  page.on("response", async (res) => {
    if (/\.js(\?|$)/.test(res.url())) js.push(res);
  });
  await page.goto(target.path, { waitUntil: "commit" });
  await page.waitForFunction(() => typeof window.__rowsPaintedAt === "number" && window.__rowsPaintedAt > 0, undefined, { timeout: 60_000, polling: 50 });
  const ms = await page.evaluate(() => window.__rowsPaintedAt);
  let bytes = 0;
  let gzip = 0;
  for (const res of js) {
    const body = await res.body().catch(() => null);
    if (body) {
      bytes += body.length;
      gzip += gzipSync(body).length;
    }
  }
  await context.close();
  return { ms, files: js.length, bytes, gzip };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

// ---- main -------------------------------------------------------------------------------------

const servers = [];
let code = 0;
try {
  const entry = Object.fromEntries(sides.map((s) => [s.name, entryJs(s.dist)]));
  for (const side of sides) {
    const server = await startServer(side);
    servers.push(server);
    const t0 = Date.now();
    server.target = await seed(server);
    console.log(`[perf] ${side.name}: ${RECORDS} records loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const browser = await chromium.launch(process.env["OPENBASE_E2E_BROWSER"] === "chromium" ? {} : { channel: "chrome" });
  const results = { branch: [], main: [] };
  for (const s of servers) await run(browser, s, s.target); // warm-up, discarded
  for (let i = 0; i < RUNS; i++) {
    for (const s of i % 2 === 0 ? servers : [...servers].reverse()) {
      const r = await run(browser, s, s.target);
      results[s.name].push(r);
      console.log(`[perf] run ${i + 1} ${s.name}: ${r.ms.toFixed(0)} ms to the first rows, ${r.files} scripts, ${kb(r.bytes)} fetched`);
    }
  }
  await browser.close();

  const med = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ms: median(v.map((r) => r.ms)), bytes: median(v.map((r) => r.bytes)), gzip: median(v.map((r) => r.gzip)) }]));
  const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`;
  console.log(`\nOpening a collection of ${RECORDS} records, median of ${RUNS} runs, navigation to first rows painted`);
  console.log(`  branch  ${med.branch.ms.toFixed(0)} ms   (runs: ${results.branch.map((r) => r.ms.toFixed(0)).join(", ")})`);
  console.log(`  main    ${med.main.ms.toFixed(0)} ms   (runs: ${results.main.map((r) => r.ms.toFixed(0)).join(", ")})`);
  console.log(`  branch against main: ${pct(med.branch.ms, med.main.ms)} (limit +10%)`);
  console.log(`\nFirst screen's JavaScript, entry chunk plus its static imports`);
  for (const n of ["branch", "main"]) console.log(`  ${n.padEnd(6)}  ${entry[n].files} files, ${kb(entry[n].raw)} raw, ${kb(entry[n].gzip)} gzip`);
  console.log(`  branch against main: ${pct(entry.branch.raw, entry.main.raw)} raw`);
  console.log(`\nJavaScript fetched before the rows were painted (median run, all chunks the route loads)`);
  for (const n of ["branch", "main"]) console.log(`  ${n.padEnd(6)}  ${kb(med[n].bytes)} raw, ${kb(med[n].gzip)} gzip`);
  if (med.branch.ms > med.main.ms * 1.1 || entry.branch.raw > entry.main.raw) {
    console.log("\nFAIL: the branch is more than 10% slower to open a collection, or its entry JavaScript is larger than main's.");
    code = 1;
  }
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  for (const s of servers) {
    s.child.kill("SIGKILL");
    rmSync(s.dataDir, { recursive: true, force: true });
  }
}
process.exit(code);
