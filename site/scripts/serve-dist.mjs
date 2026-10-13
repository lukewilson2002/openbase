#!/usr/bin/env node
// A tiny static server for dist/ that behaves like Cloudflare Pages for what matters here:
// it applies dist/_headers and dist/_redirects, serves directory indexes, redirects
// /docs/x to /docs/x/, and answers unknown paths with 404.html and status 404.
// Use it to test the Content-Security-Policy and other headers locally:
//   npm run build && npm run serve        (http://localhost:4400, or PORT=...)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const port = Number(process.env.PORT || 4400);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".pagefind": "application/octet-stream", ".pf_meta": "application/octet-stream",
  ".pf_fragment": "application/octet-stream", ".pf_index": "application/octet-stream", ".pf_filter": "application/octet-stream",
};

function parseHeaders(file) {
  const rules = [];
  if (!fs.existsSync(file)) return rules;
  let cur = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      const i = raw.indexOf(":");
      if (cur && i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    } else {
      cur = { pattern: raw.trim(), headers: [] };
      rules.push(cur);
    }
  }
  return rules;
}
function globToRegExp(p) {
  return new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}
function parseRedirects(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => {
    const [from, to, status = "302"] = l.trim().split(/\s+/);
    return { from, to, status: Number(status) };
  });
}

const headerRules = parseHeaders(path.join(dist, "_headers")).map((r) => ({ ...r, re: globToRegExp(r.pattern) }));
const redirects = parseRedirects(path.join(dist, "_redirects"));

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}
function applicable(pathname) {
  const out = {};
  for (const r of headerRules) if (r.re.test(pathname)) for (const [k, v] of r.headers) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let pathname = decodeURIComponent(url.pathname);
    const base = applicable(pathname);
    const redirect = redirects.find((r) => r.from === pathname || r.from === pathname.replace(/\/$/, ""));
    if (redirect) return send(res, redirect.status, { ...base, Location: redirect.to }, "");
    let file = path.join(dist, pathname);
    if (!file.startsWith(dist)) return send(res, 400, base, "bad path");
    let st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st?.isDirectory()) {
      if (!pathname.endsWith("/")) return send(res, 308, { ...base, Location: pathname + "/" + url.search }, "");
      file = path.join(file, "index.html");
      st = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (!st) {
      const nf = path.join(dist, "404.html");
      return send(res, 404, { ...base, "Content-Type": TYPES[".html"] }, fs.existsSync(nf) ? fs.readFileSync(nf) : "not found");
    }
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    send(res, 200, { "Content-Type": type, ...base }, fs.readFileSync(file));
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${dist} with _headers and _redirects on http://localhost:${port}`));
