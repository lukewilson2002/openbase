#!/usr/bin/env node
// Regenerates the product screenshots in site/public/screenshots/.
//
//   cd site && npm ci && npm run screenshots
//
// What it does (nothing here needs Rust, and no browser is downloaded):
//   1. starts an existing OpenBase release binary on a free localhost port with a temporary data dir,
//   2. creates the first admin and seeds a small demo bakery through the REST API,
//   3. drives the installed Google Chrome (Playwright channel "chrome") and takes the screenshots,
//   4. writes optimized WebP files (2x pixel density) and deletes the temporary data dir.
//
// Environment:
//   OPENBASE_BIN              path to the openbase binary (default: <repo>/target/release/openbase)
//   OPENBASE_SHOTS_CHROMIUM   a Chrome or Chromium executable to use instead of the installed Google
//                             Chrome, for machines without it (for example Playwright's own Chromium)
// Flags:
//   --only a,b    take only the named shots (see SHOTS below)
//   --seed-only   seed, print the URL and wait until Ctrl-C (to poke at the demo by hand)
//
// The demo data is fictional. Dates are relative to today, so the calendar and timeline always show
// the current month; the images therefore change a little each time you regenerate them.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(siteDir, "..");
const outDir = path.join(siteDir, "public/screenshots");
const BIN = process.env.OPENBASE_BIN || path.join(repoDir, "target/release/openbase");
const CHROMIUM = process.env.OPENBASE_SHOTS_CHROMIUM;
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only="))?.slice(7) ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : "")).split(",").filter(Boolean);
const seedOnly = args.includes("--seed-only");

const VIEWPORT = { width: 1560, height: 960 };
const PAGE_VIEWPORT = { width: 1560, height: 800 };
// Images are shown at most ~1200 CSS pixels wide on the site, so 2400 px keeps them sharp at 2x.
const MAX_WIDTH = 2400;
const WEBP_BUDGET = 300 * 1024;

// ------------------------------------------------------------------ server

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      const { port: got } = s.address();
      s.close(() => resolve(got));
    });
  });
}
/** 8080 (the default, which makes the AI assistants screenshot show the usual address) when free, else any free port. */
const freePort = () => listenOn(8080).catch(() => listenOn(0));

async function startServer() {
  if (!fs.existsSync(BIN)) throw new Error(`openbase binary not found at ${BIN}. Build it, or set OPENBASE_BIN.`);
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbase-shots-"));
  const url = `http://localhost:${port}`;
  const child = spawn(BIN, [], {
    env: { ...process.env, OPENBASE_DATA_DIR: dataDir, OPENBASE_BIND: `127.0.0.1:${port}`, OPENBASE_PUBLIC_URL: url, OPENBASE_LOG: "warn", TZ: "America/New_York" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; ; i++) {
    if (exited) throw new Error("openbase exited during startup");
    if (i > 100) throw new Error("openbase did not become healthy");
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  const stop = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!exited) child.kill("SIGKILL");
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { url, port, dataDir, stop };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ API client

class Api {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async call(method, url, body, { form } = {}) {
    const headers = { "x-openbase-csrf": "1", origin: this.base, cookie: this.cookieHeader() };
    if (body !== undefined && !form) headers["content-type"] = "application/json";
    const res = await fetch(this.base + url, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
    return json;
  }
  get = (u) => this.call("GET", u);
  post = (u, b) => this.call("POST", u, b ?? {});
  patch = (u, b) => this.call("PATCH", u, b);
  del = (u, b) => this.call("DELETE", u, b);
}

// ------------------------------------------------------------------ dates

const today = new Date();
today.setHours(12, 0, 0, 0);
function day(offset) {
  const d = new Date(today);
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Monday of the current week. */
const monday = ((d) => {
  const wd = (d.getDay() + 6) % 7;
  return -wd;
})(today);

// ------------------------------------------------------------------ pictures for the Photo field

function svgFor(kind, hue) {
  const bg1 = `hsl(${hue} 55% 88%)`;
  const bg2 = `hsl(${hue} 50% 76%)`;
  const crust = "#b9712f";
  const crustDark = "#8a4f1c";
  const crumb = "#f1d9a8";
  const shapes = {
    loaf: `<ellipse cx="300" cy="250" rx="190" ry="105" fill="${crust}"/><ellipse cx="300" cy="235" rx="170" ry="88" fill="#c9833e"/>
      <path d="M190 215 Q230 175 270 225 M280 205 Q320 165 360 215 M370 215 Q400 185 425 225" stroke="${crumb}" stroke-width="14" fill="none" stroke-linecap="round"/>`,
    baguette: `<g transform="rotate(-18 300 225)"><rect x="70" y="190" width="460" height="70" rx="35" fill="${crust}"/><rect x="76" y="194" width="448" height="50" rx="25" fill="#c9833e"/>
      <path d="M140 205 l30 35 M220 205 l30 35 M300 205 l30 35 M380 205 l30 35" stroke="${crumb}" stroke-width="11" stroke-linecap="round"/></g>`,
    croissant: `<g fill="${crust}"><path d="M110 270 Q130 160 300 150 Q470 160 490 270 Q440 235 400 260 Q350 215 300 250 Q250 215 200 260 Q160 235 110 270Z"/></g>
      <path d="M200 175 Q215 230 200 262 M260 160 Q275 225 262 250 M340 160 Q325 225 338 250 M400 175 Q385 230 400 262" stroke="${crustDark}" stroke-width="9" fill="none" stroke-linecap="round" opacity=".55"/>`,
    cake: `<ellipse cx="300" cy="310" rx="170" ry="30" fill="rgba(0,0,0,.12)"/><rect x="160" y="190" width="280" height="110" rx="16" fill="#7a4a2b"/>
      <path d="M160 214 Q190 250 220 214 Q250 252 280 214 Q310 250 340 214 Q370 252 400 214 Q420 238 440 214 L440 196 Q440 176 420 176 L180 176 Q160 176 160 196Z" fill="#fff4e6"/>
      <circle cx="300" cy="162" r="16" fill="#d6183f"/><path d="M300 146 q4-14 16-18" stroke="#2d7a2d" stroke-width="5" fill="none"/>`,
    cookies: `<g><circle cx="230" cy="240" r="80" fill="#c98f4f"/><circle cx="380" cy="270" r="72" fill="#d19a5c"/>
      <g fill="#4b2a14"><circle cx="205" cy="220" r="11"/><circle cx="250" cy="262" r="10"/><circle cx="262" cy="210" r="9"/><circle cx="355" cy="250" r="10"/><circle cx="400" cy="292" r="11"/><circle cx="405" cy="245" r="9"/></g></g>`,
    bun: `<ellipse cx="300" cy="250" rx="150" ry="95" fill="#d39a58"/><path d="M190 240 Q300 150 410 240" stroke="#f3dcc0" stroke-width="16" fill="none" stroke-linecap="round" opacity=".8"/>
      <path d="M200 270 Q300 200 400 270" stroke="#f3dcc0" stroke-width="12" fill="none" stroke-linecap="round" opacity=".6"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
    <rect width="600" height="450" fill="url(#g)"/><ellipse cx="300" cy="345" rx="230" ry="26" fill="rgba(60,30,10,.10)"/>${shapes[kind]}</svg>`;
}

async function pictureFile(kind, hue) {
  return sharp(Buffer.from(svgFor(kind, hue))).jpeg({ quality: 82 }).toBuffer();
}

// ------------------------------------------------------------------ seed

async function seed(api, password) {
  const email = "maya@larkspur.example";
  const me = await api.post("/api/auth/signup", { email, name: "Maya Chen", password });
  // The first-run intro would cover every screenshot.
  await api.patch("/api/auth/me", { intro_seen: true });
  const ws = await api.post("/api/workspaces", { name: "Larkspur Bakery", icon: "wheat", color: "teal" });
  const base = await api.post(`/api/workspaces/${ws.id}/bases`, { name: "Bakery", color: "orange", icon: "croissant", empty: true });
  const b = base.id;

  const mkField = async (table, f) => {
    const res = await api.post(`/api/tables/${table}/fields`, f);
    return res.field ?? res;
  };

  // ---------- Products
  const products = await api.post(`/api/bases/${b}/tables`, { name: "Products", icon: "wheat" });
  for (const f of products.fields) if (f.name === "Notes") await api.del(`/api/fields/${f.id}`);
  const select = (names) => ({ choices: names.map(([name, color], i) => ({ id: `c${i + 1}`, name, color })) });
  const pf = {};
  pf.category = await mkField(products.id, {
    name: "Category", type: "single_select",
    options: select([["Bread", "orange"], ["Pastry", "yellow"], ["Cake", "pink"], ["Cookies", "teal"], ["Seasonal", "purple"]]),
  });
  pf.price = await mkField(products.id, { name: "Price", type: "currency", options: { precision: 2, symbol: "$", allow_negative: false } });
  pf.photo = await mkField(products.id, { name: "Photo", type: "attachment", options: {} });
  pf.allergens = await mkField(products.id, {
    name: "Allergens", type: "multiple_select",
    options: select([["Gluten", "yellow"], ["Dairy", "blue"], ["Eggs", "orange"], ["Nuts", "red"], ["Sesame", "gray"]]),
  });
  pf.vegan = await mkField(products.id, { name: "Vegan", type: "checkbox", options: { icon: "check", color: "green" } });

  const upload = async (kind, hue, name) => {
    const form = new FormData();
    form.append("file", new Blob([await pictureFile(kind, hue)], { type: "image/jpeg" }), `${name}.jpg`);
    return api.call("POST", `/api/bases/${b}/attachments`, undefined, { form });
  };
  const choice = (field, name) => field.options.choices.find((c) => c.name === name).id;
  const catId = (n) => choice(pf.category, n);
  const alg = (...n) => n.map((x) => choice(pf.allergens, x));
  const productRows = [
    ["Sourdough loaf", "Bread", 7.5, "loaf", 28, ["Gluten"], true],
    ["Seeded rye", "Bread", 8, "loaf", 35, ["Gluten", "Sesame"], true],
    ["Baguette", "Bread", 3.75, "baguette", 40, ["Gluten"], true],
    ["Butter croissant", "Pastry", 4.25, "croissant", 38, ["Gluten", "Dairy"], false],
    ["Cardamom bun", "Pastry", 4, "bun", 20, ["Gluten", "Dairy", "Eggs"], false],
    ["Carrot cake", "Cake", 38, "cake", 345, ["Gluten", "Dairy", "Eggs", "Nuts"], false],
    ["Chocolate fudge cake", "Cake", 42, "cake", 15, ["Gluten", "Dairy", "Eggs"], false],
    ["Oat & raisin cookies", "Cookies", 12, "cookies", 32, ["Gluten"], true],
    ["Winter stollen", "Seasonal", 18, "bun", 8, ["Gluten", "Dairy", "Nuts"], false],
  ];
  const productIds = {};
  for (const [name, cat, price, kind, hue, allergens, vegan] of productRows) {
    const photo = await upload(kind, hue, name.toLowerCase().replace(/[^a-z]+/g, "-"));
    const res = await api.post(`/api/tables/${products.id}/records`, {
      records: [{ values: { [products.primary_field_id]: name, [pf.category.id]: catId(cat), [pf.price.id]: price, [pf.photo.id]: [photo], [pf.allergens.id]: alg(...allergens), [pf.vegan.id]: vegan } }],
    });
    productIds[name] = res.records[0].id;
  }

  // ---------- Customers
  const customers = await api.post(`/api/bases/${b}/tables`, { name: "Customers", icon: "users" });
  const cust = {};
  cust.type = await mkField(customers.id, {
    name: "Type", type: "single_select",
    options: select([["Café", "orange"], ["Restaurant", "blue"], ["Event", "purple"], ["Individual", "gray"]]),
  });
  cust.email = await mkField(customers.id, { name: "Email", type: "email", options: {} });
  cust.phone = await mkField(customers.id, { name: "Phone", type: "phone", options: {} });
  for (const f of customers.fields) if (f.name === "Notes") await api.del(`/api/fields/${f.id}`);

  const custRows = [
    ["Greenhouse Café", "Café", "orders@greenhousecafe.example", "(917) 555-0142"],
    ["Harbor Street Deli", "Restaurant", "kitchen@harborstreet.example", "(917) 555-0118"],
    ["Pine & Pearl", "Restaurant", "hello@pineandpearl.example", "(646) 555-0197"],
    ["Nora Whitfield", "Individual", "nora.whitfield@mail.example", "(718) 555-0163"],
    ["Marlow Events", "Event", "team@marlowevents.example", "(212) 555-0175"],
    ["Little Wren Books & Coffee", "Café", "counter@littlewren.example", "(347) 555-0129"],
    ["Dev Patel", "Individual", "dev.patel@mail.example", "(929) 555-0108"],
  ];
  const custIds = {};
  for (const [name, type, em, ph] of custRows) {
    const res = await api.post(`/api/tables/${customers.id}/records`, {
      records: [{ values: { [customers.primary_field_id]: name, [cust.type.id]: choice(cust.type, type), [cust.email.id]: em, [cust.phone.id]: ph } }],
    });
    custIds[name] = res.records[0].id;
  }

  // ---------- Orders
  const orders = await api.post(`/api/bases/${b}/tables`, { name: "Orders", icon: "shopping-basket" });
  for (const f of orders.fields) if (f.name === "Notes") await api.del(`/api/fields/${f.id}`);
  await api.patch(`/api/fields/${orders.primary_field_id}`, { name: "Order" });
  const o = {};
  o.customer = await mkField(orders.id, { name: "Customer", type: "link", inverse_name: "Orders", options: { linked_table_id: customers.id, inverse_field_id: "", single: true } });
  o.product = await mkField(orders.id, { name: "Product", type: "link", inverse_name: "Orders", options: { linked_table_id: products.id, inverse_field_id: "", single: true } });
  o.qty = await mkField(orders.id, { name: "Qty", type: "number", options: { precision: 0, allow_negative: false } });
  o.unit = await mkField(orders.id, { name: "Unit price", type: "lookup", options: { link_field_id: o.product.id, target_field_id: pf.price.id, result_type: "number" } });
  o.total = await mkField(orders.id, {
    name: "Total", type: "formula",
    options: { expression: "{Qty} * SUM({Unit price})", format: { kind: "currency", precision: 2, symbol: "$" }, result_type: "number" },
  });
  o.status = await mkField(orders.id, {
    name: "Status", type: "single_select",
    options: select([["New", "blue"], ["Baking", "orange"], ["Ready", "green"], ["Delivered", "gray"]]),
  });
  o.delivery = await mkField(orders.id, { name: "Delivery", type: "single_select", options: select([["Pickup", "teal"], ["Delivery", "purple"]]) });
  const dateOpts = { include_time: false, date_format: "friendly", time_format: "h12" };
  o.start = await mkField(orders.id, { name: "Bake on", type: "date", options: dateOpts });
  o.due = await mkField(orders.id, { name: "Due", type: "date", options: dateOpts });
  o.paid = await mkField(orders.id, { name: "Paid", type: "checkbox", options: { icon: "check", color: "green" } });

  // [customer, product, qty, status, delivery, bakeOffset, dueOffset, paid]
  const m = monday;
  const orderRows = [
    ["Greenhouse Café", "Sourdough loaf", 12, "Delivered", "Delivery", m - 7, m - 7, true],
    ["Harbor Street Deli", "Baguette", 40, "Delivered", "Delivery", m - 6, m - 6, true],
    ["Nora Whitfield", "Carrot cake", 1, "Delivered", "Pickup", m - 5, m - 4, true],
    ["Marlow Events", "Butter croissant", 60, "Delivered", "Delivery", m - 3, m - 2, true],
    ["Little Wren Books & Coffee", "Cardamom bun", 24, "Delivered", "Pickup", m - 2, m - 2, true],
    ["Greenhouse Café", "Sourdough loaf", 12, "Delivered", "Delivery", m, m, true],
    ["Pine & Pearl", "Seeded rye", 16, "Delivered", "Delivery", m, m + 1, true],
    ["Harbor Street Deli", "Baguette", 40, "Ready", "Delivery", m + 1, m + 1, false],
    ["Dev Patel", "Chocolate fudge cake", 1, "Ready", "Pickup", m + 1, m + 2, false],
    ["Little Wren Books & Coffee", "Butter croissant", 36, "Baking", "Pickup", m + 2, m + 2, false],
    ["Greenhouse Café", "Butter croissant", 48, "Baking", "Delivery", m + 2, m + 3, false],
    ["Marlow Events", "Oat & raisin cookies", 20, "Baking", "Delivery", m + 2, m + 4, false],
    ["Pine & Pearl", "Sourdough loaf", 10, "New", "Delivery", m + 3, m + 4, false],
    ["Nora Whitfield", "Winter stollen", 2, "New", "Pickup", m + 4, m + 5, false],
    ["Harbor Street Deli", "Seeded rye", 14, "New", "Delivery", m + 4, m + 5, false],
    ["Greenhouse Café", "Sourdough loaf", 12, "New", "Delivery", m + 7, m + 7, false],
    ["Dev Patel", "Carrot cake", 1, "New", "Pickup", m + 8, m + 9, false],
    ["Marlow Events", "Cardamom bun", 80, "New", "Delivery", m + 9, m + 10, false],
    ["Little Wren Books & Coffee", "Cardamom bun", 24, "New", "Pickup", m + 9, m + 9, false],
    ["Pine & Pearl", "Baguette", 30, "New", "Delivery", m + 11, m + 11, false],
  ];
  let n = 1040;
  const orderRecs = orderRows.map(([c, p, qty, st, dl, bake, due, paid]) => ({
    values: {
      [orders.primary_field_id]: `#${n++} ${c}`,
      [o.customer.id]: [custIds[c]],
      [o.product.id]: [productIds[p]],
      [o.qty.id]: qty,
      [o.status.id]: choice(o.status, st),
      [o.delivery.id]: choice(o.delivery, dl),
      [o.start.id]: day(bake),
      [o.due.id]: day(due),
      [o.paid.id]: paid,
    },
  }));
  await api.post(`/api/tables/${orders.id}/records`, { records: orderRecs });

  // Customers: lifetime value and order count (computed from Orders).
  const ordersLinkInCust = (await api.get(`/api/bases/${b}`)).tables.find((t) => t.id === customers.id).fields.find((f) => f.type === "link");
  const ltv = await mkField(customers.id, {
    name: "Lifetime value", type: "rollup",
    options: { link_field_id: ordersLinkInCust.id, target_field_id: o.total.id, expression: "SUM(values)", format: { kind: "currency", precision: 2, symbol: "$" }, result_type: "number" },
  });
  const cnt = await mkField(customers.id, { name: "Orders placed", type: "count", options: { link_field_id: ordersLinkInCust.id } });

  // ---------- Production plan (timeline with dependencies)
  const prod = await api.post(`/api/bases/${b}/tables`, { name: "Production plan", icon: "chef-hat" });
  for (const f of prod.fields) if (f.name === "Notes") await api.del(`/api/fields/${f.id}`);
  await api.patch(`/api/fields/${prod.primary_field_id}`, { name: "Task" });
  const pr = {};
  pr.start = await mkField(prod.id, { name: "Start", type: "date", options: dateOpts });
  pr.end = await mkField(prod.id, { name: "End", type: "date", options: dateOpts });
  pr.station = await mkField(prod.id, {
    name: "Station", type: "single_select",
    options: select([["Prep", "yellow"], ["Ovens", "orange"], ["Packing", "teal"], ["Delivery", "purple"]]),
  });
  pr.dep = await mkField(prod.id, { name: "Depends on", type: "link", inverse_name: "Blocks", options: { linked_table_id: prod.id, inverse_field_id: "", single: false } });
  // [task, station, startOffset, endOffset, [depends on indexes]]; dependants start after their predecessors end.
  // Monday of this week to Wednesday of the next: the ten days the day scale shows after "Today".
  const t0 = m;
  const plan = [
    ["Feed starter, autolyse", "Prep", t0, t0 + 1, []],
    ["Mix and bulk ferment", "Prep", t0 + 2, t0 + 3, [0]],
    ["Shape sourdough", "Prep", t0 + 4, t0 + 4, [1]],
    ["Bake sourdough", "Ovens", t0 + 5, t0 + 5, [2]],
    ["Laminate croissant dough", "Prep", t0 + 1, t0 + 3, []],
    ["Bake croissants", "Ovens", t0 + 4, t0 + 5, [4]],
    ["Pack café orders", "Packing", t0 + 6, t0 + 7, [3, 5]],
    ["Deliver wholesale", "Delivery", t0 + 8, t0 + 8, [6]],
    ["Bake carrot cakes", "Ovens", t0 + 6, t0 + 7, []],
    ["Decorate and box cakes", "Packing", t0 + 8, t0 + 8, [8]],
  ];
  const planIds = [];
  for (const [task, station, s, e] of plan) {
    const res = await api.post(`/api/tables/${prod.id}/records`, {
      records: [{ values: { [prod.primary_field_id]: task, [pr.station.id]: choice(pr.station, station), [pr.start.id]: day(s), [pr.end.id]: day(e) } }],
    });
    planIds.push(res.records[0].id);
  }
  for (let i = 0; i < plan.length; i++) {
    if (!plan[i][4].length) continue;
    await api.patch(`/api/tables/${prod.id}/records`, { records: [{ id: planIds[i], values: { [pr.dep.id]: plan[i][4].map((j) => planIds[j]) } }] });
  }

  // ---------- Views
  const schema = await api.get(`/api/bases/${b}`);
  const tableOf = (id) => schema.tables.find((t) => t.id === id);
  const baseCfg = (tableViews) => structuredCloneConfig(tableViews[0].config);
  const view = async (table, name, type, patch) => {
    const cfg = { ...structuredCloneConfig(tableOf(table).views[0].config), ...patch };
    return api.post(`/api/tables/${table}/views`, { name, type, config: cfg });
  };
  const eq = (field, value) => ({ field_id: field.id, op: "is", value });

  // Orders
  const ordersGrid = tableOf(orders.id).views[0];
  const oGridCfg = {
    ...structuredCloneConfig(ordersGrid.config),
    sorts: [{ field_id: o.due.id, direction: "asc" }],
    groups: [{ field_id: o.status.id, direction: "asc" }],
    hidden_fields: [o.start.id, o.delivery.id, o.paid.id, o.unit.id],
    row_color: { mode: "by_select", field_id: o.status.id },
    summaries: { [o.total.id]: "sum", [o.qty.id]: "sum" },
    // Narrow enough that the Due dates ("October 16, 2026") are not cut off at the right edge.
    field_widths: { [orders.primary_field_id]: 250, [o.customer.id]: 180, [o.product.id]: 180, [o.qty.id]: 90, [o.total.id]: 140, [o.status.id]: 120, [o.due.id]: 170 },
  };
  await api.patch(`/api/views/${ordersGrid.id}`, { name: "All orders", config: oGridCfg });
  await view(orders.id, "By status", "kanban", {
    kanban: { stack_field_id: o.status.id, cover_field_id: null, hide_empty_stacks: true, stack_order: [] },
    hidden_fields: [o.start.id, o.paid.id, o.unit.id, o.delivery.id, o.qty.id],
    row_color: { mode: "by_select", field_id: o.status.id },
    sorts: [{ field_id: o.due.id, direction: "asc" }],
  });
  await view(orders.id, "Calendar", "calendar", { calendar: { date_field_id: o.due.id, end_field_id: null }, hidden_fields: [o.start.id, o.unit.id, o.paid.id, o.delivery.id], row_color: { mode: "by_select", field_id: o.status.id } });
  const timelineOrders = await view(orders.id, "Bake schedule", "timeline", {
    timeline: { start_field_id: o.start.id, end_field_id: o.due.id, group_field_id: o.delivery.id, dependency_field_id: null, scale: "week" },
  });

  // Products gallery
  const prodGrid = tableOf(products.id).views[0];
  await api.patch(`/api/views/${prodGrid.id}`, { name: "All products" });
  // The inverse "Orders" link would make every card a long list of order numbers.
  const productOrders = tableOf(products.id).fields.find((f) => f.type === "link");
  await view(products.id, "Menu", "gallery", { gallery: { cover_field_id: pf.photo.id, cover_crop: true }, hidden_fields: [pf.vegan.id, productOrders.id] });

  // Customers: sorted grid + a public sign-up form
  const custGrid = tableOf(customers.id).views[0];
  await api.patch(`/api/views/${custGrid.id}`, {
    name: "All customers",
    config: { ...structuredCloneConfig(custGrid.config), sorts: [{ field_id: ltv.id, direction: "desc" }], summaries: { [ltv.id]: "sum" } },
  });
  const form = await view(customers.id, "Wholesale enquiry", "form", {
    form: {
      title: "Wholesale enquiry",
      description: "Tell us about your café or restaurant and what you would like to order. We reply within one working day.",
      fields: [
        { field_id: customers.primary_field_id, required: true, label: "Business or your name", help: null },
        { field_id: cust.type.id, required: true, label: "What kind of customer are you?", help: null },
        { field_id: cust.email.id, required: true, label: "Email", help: "We only use it to answer your enquiry." },
        { field_id: cust.phone.id, required: false, label: "Phone", help: null },
      ],
      submit_label: "Send enquiry",
      success_message: "Thank you! We will get back to you within one working day.",
      redirect_url: null,
      show_submit_another: false,
    },
  });
  const share = await api.post(`/api/views/${form.id}/shares`, { kind: "form" });

  // Production timeline
  const prodGridView = tableOf(prod.id).views[0];
  await api.patch(`/api/views/${prodGridView.id}`, { name: "All tasks" });
  const timeline = await view(prod.id, "Production timeline", "timeline", {
    timeline: { start_field_id: pr.start.id, end_field_id: pr.end.id, group_field_id: pr.station.id, dependency_field_id: pr.dep.id, scale: "day" },
    row_color: null,
  });

  // ---------- Automations
  const ordersNow = await api.post(`/api/views/${tableOf(orders.id).views[0].id}/query`, { limit: 100 });
  const auto = [];
  auto.push(
    await api.post(`/api/bases/${b}/automations`, {
      name: "New order: tell the bakers",
      enabled: true,
      trigger: { type: "record_created", table_id: orders.id },
      actions: [
        // Not {{...Product}}: a link field renders as the linked record's id in notifications.
        { type: "notify", user_ids: [me.id], message: "New order {{trigger.record.fields.Order}}: {{trigger.record.fields.Qty}} items, due {{trigger.record.fields.Due}}" },
      ],
    }),
  );
  const ready = await api.post(`/api/bases/${b}/automations`, {
    name: "Order ready: let the customer know",
    enabled: true,
    trigger: { type: "record_matches", table_id: orders.id, filter: { conjunction: "and", items: [{ field_id: o.status.id, op: "is", value: choice(o.status, "Ready") }] } },
    actions: [
      { type: "notify", user_ids: [me.id], message: "{{trigger.record.fields.Order}} is ready for {{trigger.record.fields.Delivery}}" },
      {
        type: "http_request", method: "POST", url: "https://hooks.example.com/sms",
        headers: { "Content-Type": "application/json" },
        body: '{"to": "{{trigger.record.fields.Customer}}", "text": "Your Larkspur Bakery order is ready."}',
        condition: { conjunction: "and", items: [{ field_id: o.delivery.id, op: "is", value: choice(o.delivery, "Pickup") }] },
      },
    ],
  });
  auto.push(ready);
  auto.push(
    await api.post(`/api/bases/${b}/automations`, {
      name: "Website order: add it to Orders",
      enabled: false,
      trigger: { type: "webhook" },
      actions: [{ type: "create_record", table_id: orders.id, values: { Order: "Web: {{trigger.body.customer}}", Qty: "{{trigger.body.qty}}", Status: "New" } }],
    }),
  );
  auto.push(
    await api.post(`/api/bases/${b}/automations`, {
      name: "Weekday 5 am: bake list",
      enabled: true,
      trigger: { type: "schedule", cron: "0 5 * * 1-5", timezone: "America/New_York" },
      actions: [{ type: "notify", user_ids: [me.id], message: "Good morning! Open the Bake schedule view for today's list." }],
    }),
  );
  void ordersNow;
  void timelineOrders;

  // ---------- The rest of the workspace, so its home page has more than one base card
  const extraBase = async (wsId, name, color, icon, tables) => {
    const nb = await api.post(`/api/workspaces/${wsId}/bases`, { name, color, icon, empty: true });
    for (const [tname, ticon, rows] of tables) {
      const t = await api.post(`/api/bases/${nb.id}/tables`, { name: tname, icon: ticon });
      if (rows.length) await api.post(`/api/tables/${t.id}/records`, { records: rows.map((r) => ({ values: { [t.primary_field_id]: r } })) });
    }
    return nb;
  };
  const rota = await extraBase(ws.id, "Staff rota", "blue", "calendar-clock", [
    ["Shifts", "clock", ["Opening bake, 4 am", "Counter, morning", "Counter, afternoon", "Close and clean"]],
    ["Time off", "plane", ["Sam, Nov 3-7", "Priya, Dec 22-26"]],
  ]);
  const suppliers = await extraBase(ws.id, "Suppliers", "green", "truck", [
    ["Suppliers", "truck", ["Hollow Creek Mill", "Brightwater Dairy", "Meadow Lane Eggs", "Northside Packaging"]],
    ["Deliveries", "package", ["Flour, 20 sacks", "Butter, 40 lb", "Eggs, 30 dozen", "Cake boxes, 200"]],
    ["Invoices", "receipt", ["HCM-2291", "BWD-0815", "MLE-1130"]],
  ]);
  const recipes = await extraBase(ws.id, "Recipes", "purple", "book-open", [
    ["Recipes", "book-open", ["Country sourdough", "Laminated croissant dough", "Cardamom bun filling", "Cream cheese frosting"]],
    ["Ingredients", "carrot", ["Bread flour", "Rye flour", "European butter", "Cardamom", "Cream cheese"]],
  ]);
  const catering = await extraBase(ws.id, "Catering", "red", "cake-slice", [
    ["Events", "party-popper", ["Marlow wedding, 120 guests", "Pine & Pearl staff party", "Library fundraiser brunch"]],
    ["Quotes", "file-text", ["Q-0412 Marlow wedding", "Q-0415 Library brunch"]],
  ]);
  await extraBase(ws.id, "Newsletter", "yellow", "megaphone", [
    ["Issues", "mail", ["October: stollen is back", "November: holiday pre-orders"]],
    ["Subscribers", "users", ["nora.whitfield@mail.example", "dev.patel@mail.example"]],
  ]);
  void suppliers;

  // A second workspace, so the sidebar shows the workspace tree.
  const home = await api.post("/api/workspaces", { name: "Home", icon: "house", color: "purple" });
  await extraBase(home.id, "Garden", "green", "sprout", [["Beds", "flower-2", ["Tomatoes", "Herbs", "Squash"]]]);

  // ---------- People: two teammates who accepted an invite, and one pending
  const inviteToken = (created) => created.url.split("/invite/")[1];
  const join = async (name, email, invite) => {
    const them = new Api(api.base);
    const user = await them.post("/api/auth/signup", { email, name, password, invite_token: inviteToken(invite) });
    await them.patch("/api/auth/me", { intro_seen: true });
    return { api: them, user };
  };
  const sam = await join("Sam Okafor", "sam@larkspur.example", await api.post(`/api/workspaces/${ws.id}/invites`, { email: "sam@larkspur.example", role: "creator", all_bases: true }));
  const priya = await join(
    "Priya Nair", "priya@larkspur.example",
    await api.post(`/api/workspaces/${ws.id}/invites`, { email: "priya@larkspur.example", role: "editor", all_bases: false, base_ids: [b, recipes.id, catering.id] }),
  );
  await api.post(`/api/workspaces/${ws.id}/invites`, { email: "leo@larkspur.example", role: "viewer", all_bases: false, base_ids: [rota.id] });

  // ---------- Inbox: two @mentions and an automation notice for Maya
  const mention = `@[Maya Chen](${me.id})`;
  const orderRows2 = (await api.post(`/api/views/${tableOf(orders.id).views[0].id}/query`, { limit: 100 })).records ?? [];
  const recordNamed = (rows, prefix) => rows.find((r) => JSON.stringify(r).includes(prefix));
  const pinePearl = recordNamed(orderRows2, "#1052 Pine");
  if (pinePearl) await sam.api.post(`/api/records/${pinePearl.id}/comments`, { body: `${mention} Pine & Pearl asked to pick these up at 7 instead of 9. Can we bake them first?` });
  await priya.api.post(`/api/records/${productIds["Winter stollen"]}/comments`, { body: `${mention} The marzipan arrived, so the first stollen batch can go out next week.` });
  // Created by Sam after the automations exist, so "New order: tell the bakers" runs and notifies Maya.
  await sam.api.post(`/api/tables/${orders.id}/records`, {
    records: [{ values: { [orders.primary_field_id]: "#1060 Greenhouse Café", [o.customer.id]: [custIds["Greenhouse Café"]], [o.product.id]: [productIds["Butter croissant"]], [o.qty.id]: 24, [o.status.id]: choice(o.status, "New"), [o.delivery.id]: choice(o.delivery, "Delivery"), [o.start.id]: day(m + 10), [o.due.id]: day(m + 11), [o.paid.id]: false } }],
  });

  // ---------- Trash: one of each kind, deleted by different people
  const oldView = await api.post(`/api/tables/${products.id}/views`, { name: "Summer price list", type: "grid", config: structuredCloneConfig(tableOf(products.id).views[0].config) });
  await api.del(`/api/views/${oldView.id}`);
  const sku = await mkField(products.id, { name: "Old SKU", type: "single_line_text", options: {} });
  await sam.api.del(`/api/fields/${sku.id}`);
  const lead = await api.post(`/api/tables/${customers.id}/records`, { records: [{ values: { [customers.primary_field_id]: "Corner Bistro" } }] });
  await sam.api.del(`/api/tables/${customers.id}/records`, { ids: [lead.records[0].id] });
  const specials = await api.post(`/api/bases/${recipes.id}/tables`, { name: "Holiday specials 2025", icon: "gift" });
  await api.del(`/api/tables/${specials.id}`);
  const market = await extraBase(ws.id, "Farmers market 2025", "pink", "store", [["Market days", "calendar", ["Saturday, June 7"]]]);
  await api.del(`/api/bases/${market.id}`);

  return {
    email, baseId: b, ws, tables: { products, customers, orders, prod },
    view: (tableId, name) => tableOf(tableId).views.find((v) => v.name === name) ?? null,
    views: async (tableId) => (await api.get(`/api/bases/${b}`)).tables.find((t) => t.id === tableId).views,
    formToken: share.token, readyAutomationId: ready.id, firstAutomationId: auto[0].id,
    timelineId: timeline.id,
  };
}

function structuredCloneConfig(c) {
  return JSON.parse(JSON.stringify(c));
}

// ------------------------------------------------------------------ shots

/** The Playwright script for each image. `prepare` runs after the page loads. */
function shots(ctx) {
  const { baseId, tables, views } = ctx;
  const viewUrl = async (tableId, name) => {
    const v = (await views(tableId)).find((x) => x.name === name);
    if (!v) throw new Error(`view ${name} not found`);
    return `/base/${baseId}/${tableId}/${v.id}`;
  };
  return [
    { name: "grid", themes: ["light", "dark"], url: () => viewUrl(tables.orders.id, "All orders"), ready: "canvas" , settle: 900 },
    { name: "kanban", themes: ["light", "dark"], url: () => viewUrl(tables.orders.id, "By status"), settle: 700 },
    {
      name: "calendar", themes: ["light"], url: () => viewUrl(tables.orders.id, "Calendar"), settle: 900,
      // Every order has a due date, so the Unscheduled column would only say so; fold it to give the month room.
      after: async (page) => { await page.getByRole("button", { name: "Hide unscheduled records" }).click(); await page.waitForTimeout(400); },
    },
    { name: "timeline", themes: ["light"], url: () => viewUrl(tables.prod.id, "Production timeline"), viewport: { width: 1560, height: 700 }, settle: 900, after: async (page) => { await page.getByRole("button", { name: "Today" }).click(); await page.waitForTimeout(500); } },
    { name: "gallery", themes: ["light"], url: () => viewUrl(tables.products.id, "Menu"), settle: 1200 },
    { name: "form-builder", themes: ["light"], url: () => viewUrl(tables.customers.id, "Wholesale enquiry"), settle: 700 },
    { name: "automations", themes: ["light"], url: async () => `/base/${baseId}/automations/${ctx.readyAutomationId}`, settle: 900 },
    { name: "assistants", themes: ["light", "dark"], url: async () => "/account?tab=assistants", settle: 600 },
    // Pages around the bases are short lists; a lower window leaves less empty space below them.
    { name: "workspace", themes: ["light", "dark"], url: async () => `/workspace/${ctx.ws.id}`, viewport: PAGE_VIEWPORT, settle: 900 },
    { name: "members", themes: ["light"], url: async () => `/workspace/${ctx.ws.id}/members`, viewport: PAGE_VIEWPORT, settle: 900 },
    { name: "trash", themes: ["light"], url: async () => "/trash", viewport: PAGE_VIEWPORT, settle: 900 },
    {
      name: "search", themes: ["light"], url: async () => `/workspace/${ctx.ws.id}`, viewport: PAGE_VIEWPORT, settle: 700,
      after: async (page) => {
        await page.getByRole("combobox", { name: "Search everything" }).click();
        // Matches a base, a view and records, so the results show several groups.
        await page.keyboard.type("bake", { delay: 40 });
        await page.getByRole("option").first().waitFor();
        await page.waitForTimeout(700);
      },
    },
  ];
}

async function takeShots(server, ctx) {
  fs.mkdirSync(outDir, { recursive: true });
  if (!only.length) for (const f of fs.readdirSync(outDir)) if (f.endsWith(".webp")) fs.rmSync(path.join(outDir, f));
  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM, headless: true } : { channel: "chrome", headless: true });
  const written = [];
  try {
    for (const shot of shots(ctx)) {
      if (only.length && !only.includes(shot.name)) continue;
      const url = await shot.url();
      for (const theme of shot.themes) {
        const context = await browser.newContext({
          viewport: shot.viewport ?? VIEWPORT,
          deviceScaleFactor: 2,
          colorScheme: theme,
          locale: "en-US",
          timezoneId: "America/New_York",
          reducedMotion: "reduce",
        });
        if (!shot.signedOut) {
          await context.addCookies([...ctx.api.cookies].map(([name, value]) => ({ name, value, url: server.url })));
        }
        const page = await context.newPage();
        const problems = [];
        page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        page.on("console", (m) => m.type() === "error" && !/status of 401/.test(m.text()) && problems.push(`console: ${m.text()}`));
        await page.goto(server.url + url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("main, [role=main], #root > *", { timeout: 15000 });
        await page.waitForTimeout(shot.settle ?? 800);
        if (shot.after) await shot.after(page);
        const png = await page.screenshot({ type: "png" });
        const file = path.join(outDir, `${shot.name}-${theme}.webp`);
        const info = await toWebp(png, file);
        written.push({ file: path.basename(file), ...info });
        if (problems.length) console.warn(`  ${shot.name} (${theme}): ${problems.join("; ")}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return written;
}

async function toWebp(png, file) {
  let quality = 84;
  for (;;) {
    const buf = await sharp(png).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= WEBP_BUDGET || quality <= 50) {
      fs.writeFileSync(file, buf);
      const meta = await sharp(buf).metadata();
      return { bytes: buf.length, quality, width: meta.width, height: meta.height };
    }
    quality -= 6;
  }
}

// ------------------------------------------------------------------ main

const server = await startServer();
let exitCode = 0;
try {
  const api = new Api(server.url);
  const password = randomBytes(18).toString("base64url");
  console.log(`seeding ${server.url} ...`);
  const ctx = await seed(api, password);
  ctx.api = api;
  if (seedOnly) {
    console.log(`Seeded. Sign in at ${server.url} as ${ctx.email} / ${password}. Press Ctrl-C to stop and delete the data.`);
    await new Promise((resolve) => process.once("SIGINT", resolve));
  } else {
    const written = await takeShots(server, ctx);
    for (const w of written) console.log(`${w.file.padEnd(28)} ${w.width}x${w.height}  ${(w.bytes / 1024).toFixed(0)} KB (q${w.quality})`);
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await server.stop();
}
process.exit(exitCode);
