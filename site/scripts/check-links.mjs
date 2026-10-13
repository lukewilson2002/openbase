#!/usr/bin/env node
// Link check for the built site (dist/). Offline by default:
//   * every internal href / src / srcset in every page must resolve to a file in dist/,
//   * every #fragment must exist as an id (or name) in the target page,
//   * every page must have exactly one <h1>, a <title>, a description, a canonical URL, and
//     every <img> must have alt, width and height.
// `--external` also requests each external URL once (HEAD, falling back to GET) and warns about
// failures; that needs network access and is not used in CI because third-party sites flake.
// Exit code 1 when anything internal is wrong.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const SITE = "https://myopenbase.app";
const external = process.argv.includes("--external");

if (!fs.existsSync(dist)) {
  console.error("dist/ does not exist: run npm run build first");
  process.exit(1);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const pages = new Map(); // url path -> { file, ids:Set, html }
for (const file of walk(dist)) {
  if (!file.endsWith(".html")) continue;
  let url = "/" + path.relative(dist, file).split(path.sep).join("/");
  url = url.replace(/index\.html$/, "");
  const html = fs.readFileSync(file, "utf8");
  const ids = new Set();
  for (const m of html.matchAll(/\b(?:id|name)\s*=\s*"([^"]+)"/g)) ids.add(m[1]);
  pages.set(url, { file, ids, html });
}

const problems = [];
const externals = new Map();
const problem = (page, msg) => problems.push(`${page}: ${msg}`);

function resolveInternal(from, target) {
  // returns {path, hash} for a site-internal target, or null for external / non-link
  if (/^(mailto:|tel:|data:|javascript:)/i.test(target)) return null;
  let u;
  try {
    u = new URL(target, SITE + from);
  } catch {
    return { bad: true };
  }
  if (u.origin !== SITE) return null;
  return { path: decodeURIComponent(u.pathname), hash: decodeURIComponent(u.hash.slice(1)) };
}

function exists(p) {
  if (pages.has(p)) return true;
  const f = path.join(dist, p);
  return f.startsWith(dist) && fs.existsSync(f) && fs.statSync(f).isFile();
}

for (const [url, page] of pages) {
  const { html } = page;
  if (url === "/404.html") continue;
  const h1 = (html.match(/<h1\b/g) || []).length;
  if (h1 !== 1) problem(url, `${h1} <h1> elements (want exactly 1)`);
  if (!/<title>[^<]+<\/title>/.test(html)) problem(url, "missing <title>");
  if (!/<meta name="description" content="[^"]+"/.test(html)) problem(url, "missing meta description");
  const canon = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  if (!canon) problem(url, "missing canonical link");
  else if (canon !== SITE + url) problem(url, `canonical is ${canon}, expected ${SITE + url}`);
  // heading order: no jump of more than one level downwards
  let prev = 0;
  for (const m of html.matchAll(/<h([1-6])\b/g)) {
    const level = Number(m[1]);
    if (prev && level > prev + 1) problem(url, `heading level jumps from h${prev} to h${level}`);
    prev = level;
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\balt\s*=/.test(tag)) problem(url, `<img> without alt: ${tag.slice(0, 100)}`);
    if (!/\bwidth\s*=/.test(tag) || !/\bheight\s*=/.test(tag)) problem(url, `<img> without width/height: ${tag.slice(0, 100)}`);
  }
  const targets = [];
  for (const m of html.matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"/g)) targets.push(m[1]);
  for (const m of html.matchAll(/\bsrcset\s*=\s*"([^"]*)"/g)) for (const part of m[1].split(",")) targets.push(part.trim().split(/\s+/)[0]);
  for (const raw of targets) {
    const t = raw.replace(/&amp;/g, "&");
    if (!t) continue;
    if (/^https?:\/\//i.test(t) && !t.startsWith(SITE)) {
      externals.set(t.split("#")[0], url);
      continue;
    }
    const r = resolveInternal(url, t);
    if (!r) continue;
    if (r.bad) {
      problem(url, `unparseable link ${t}`);
      continue;
    }
    if (!exists(r.path)) {
      problem(url, `broken link ${t} (no ${r.path})`);
      continue;
    }
    if (r.hash && pages.has(r.path) && !pages.get(r.path).ids.has(r.hash)) problem(url, `broken anchor ${t} (no #${r.hash} in ${r.path})`);
  }
}

console.log(`checked ${pages.size} pages, ${externals.size} distinct external URLs`);

if (external) {
  const warn = [];
  const queue = [...externals.keys()];
  const worker = async () => {
    for (let u; (u = queue.pop()); ) {
      try {
        let res = await fetch(u, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
        if (res.status >= 400) res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000) });
        if (res.status >= 400) warn.push(`${u} -> ${res.status} (linked from ${externals.get(u)})`);
      } catch (e) {
        warn.push(`${u} -> ${e.message} (linked from ${externals.get(u)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const w of warn) console.warn(`external: ${w}`);
  console.log(`external check: ${warn.length} problem(s)`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("no internal problems");
