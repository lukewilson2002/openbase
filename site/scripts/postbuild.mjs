#!/usr/bin/env node
// Runs after `astro build` (see npm run build).
//   1. Computes the sha256 of every inline <script> in dist/**/*.html and puts the hashes into
//      dist/_headers (replacing __SCRIPT_HASHES__), so the Content-Security-Policy allows exactly
//      the scripts the build emitted and nothing else.
//   2. Fails the build when something the deployment relies on is missing.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const hashes = new Set();
let pages = 0;
for (const file of walk(dist)) {
  if (!file.endsWith(".html")) continue;
  pages++;
  const html = fs.readFileSync(file, "utf8");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue; // external: allowed by 'self'
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue; // data blocks (JSON-LD) never execute
    hashes.add(`'sha256-${crypto.createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
}

const problems = [];
const headersPath = path.join(dist, "_headers");
if (!fs.existsSync(headersPath)) {
  problems.push("dist/_headers is missing (public/_headers)");
} else {
  // Drop the comment lines (they mention the placeholder), then fill it in.
  const text = fs.readFileSync(headersPath, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  if (!text.includes("__SCRIPT_HASHES__")) problems.push("public/_headers lost its __SCRIPT_HASHES__ placeholder");
  fs.writeFileSync(headersPath, text.replaceAll("__SCRIPT_HASHES__", [...hashes].sort().join(" ")));
}
for (const f of ["index.html", "404.html", "robots.txt", "_redirects", "og.png", "favicon.svg", "favicon.ico", "apple-touch-icon.png", "sitemap-index.xml", "pagefind/pagefind.js", "docs/index.html", "docs/quickstart/index.html"]) {
  if (!fs.existsSync(path.join(dist, f))) problems.push(`dist/${f} is missing`);
}
for (const slug of ["self-hosting", "mcp", "automations", "api", "security"]) {
  if (!fs.existsSync(path.join(dist, "docs", slug, "index.html"))) problems.push(`docs/${slug} was not built (is docs/${slug}.md missing?)`);
}

if (problems.length) {
  for (const p of problems) console.error(`postbuild: ${p}`);
  process.exit(1);
}
console.log(`postbuild: ${pages} pages, ${hashes.size} inline script hashes written to dist/_headers`);
