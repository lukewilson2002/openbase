#!/usr/bin/env node
// Copies the repository's documentation into the Starlight content folder so that
// docs/*.md (and CHANGELOG.md) stay the single source of truth. Run by `npm run build`
// and `npm run dev`. Everything this script writes is gitignored (see site/.gitignore).
//
//   docs/{self-hosting,mcp,automations,api,security}.md  -> /docs/<slug>/
//   docs/releasing.md, CHANGELOG.md (when they exist)    -> /docs/releasing/, /docs/changelog/
//   brand/*                                              -> src/assets/brand/, public/ (favicons)
//
// While copying a document it
//   * turns the first `# Heading` into the page title (Starlight renders it as the h1),
//   * adds a description and an "edit this page" link to GitHub,
//   * rewrites relative links: other synced docs -> /docs/<slug>/, anything else in the
//     repository -> a GitHub blob/tree URL (anchors are kept),
//   * copies local images next to the site (public/docs-assets/).
// Fenced code blocks and inline code are never touched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(siteDir, "..");
const REPO_URL = "https://github.com/lukewilson2002/openbase";
const BRANCH = "main";

const outDir = path.join(siteDir, "src/content/docs/docs");
const assetsOut = path.join(siteDir, "public/docs-assets");

/** Documents to publish. `optional` ones are skipped quietly when the source does not exist yet. */
export const DOCS = [
  {
    src: "docs/self-hosting.md",
    slug: "self-hosting",
    description:
      "Take a fresh VPS to a running OpenBase with HTTPS, backups, upgrades and recovery: Docker Compose with Caddy, or the single binary with systemd.",
  },
  {
    src: "docs/mcp.md",
    slug: "mcp",
    description:
      "OpenBase has a built-in MCP server. Connect Claude, ChatGPT or any MCP client by signing in or with a token, and let an AI assistant build bases and edit records for you.",
  },
  {
    src: "docs/automations.md",
    slug: "automations",
    description:
      "Triggers, actions, placeholders, webhooks and run history for OpenBase automations.",
  },
  {
    src: "docs/api.md",
    slug: "api",
    description:
      "The Airtable-compatible REST API under /api/v1: authentication, endpoints, value shapes, filters, limits and differences from Airtable.",
  },
  {
    src: "docs/security.md",
    slug: "security",
    description:
      "OpenBase threat model, protections, limits, the administrator checklist and accepted risks.",
  },
  {
    src: "docs/releasing.md",
    slug: "releasing",
    optional: true,
    description: "How maintainers cut an OpenBase release: versioning, tags, images and checks.",
  },
  {
    src: "CHANGELOG.md",
    slug: "changelog",
    optional: true,
    description: "What changed in each OpenBase release.",
  },
];

const bySource = new Map(DOCS.map((d) => [d.src, d]));

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Slugs that exist in the repository right now (used by astro.config.mjs for the sidebar). */
export function availableSlugs() {
  return DOCS.filter((d) => exists(path.join(repoDir, d.src))).map((d) => d.slug);
}

const warnings = [];
const warn = (msg) => warnings.push(msg);

function githubUrl(repoRel) {
  const abs = path.join(repoDir, repoRel);
  const clean = repoRel.split(path.sep).join("/").replace(/\/$/, "");
  let kind = "blob";
  if (exists(abs)) {
    if (fs.statSync(abs).isDirectory()) kind = "tree";
  } else {
    warn(`link target does not exist in the repository: ${repoRel}`);
  }
  return `${REPO_URL}/${kind}/${BRANCH}/${clean}`;
}

/** Rewrite one link target found in `srcRel` (a repository-relative path). */
function rewriteTarget(target, srcRel, state) {
  if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const hashAt = target.search(/[#?]/);
  const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
  const rest = hashAt === -1 ? "" : target.slice(hashAt);
  if (!pathPart) return target;
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    /* keep as is */
  }
  const repoRel = path.posix.normalize(path.posix.join(path.posix.dirname(srcRel), decoded));
  if (repoRel.startsWith("..")) {
    warn(`link leaves the repository: ${target} (in ${srcRel})`);
    return target;
  }
  const doc = bySource.get(repoRel);
  if (doc && exists(path.join(repoDir, doc.src))) return `/docs/${doc.slug}/${rest}`;
  if (state.image) {
    const abs = path.join(repoDir, repoRel);
    if (exists(abs) && fs.statSync(abs).isFile()) {
      fs.mkdirSync(assetsOut, { recursive: true });
      const name = path.basename(abs);
      fs.copyFileSync(abs, path.join(assetsOut, name));
      return `/docs-assets/${name}`;
    }
  }
  return githubUrl(repoRel) + rest;
}

/** Rewrite links/images in one line of prose (outside code spans). */
function rewriteProse(text, srcRel) {
  // Inline links and images: [text](target "title") / ![alt](target)
  text = text.replace(/(!?)(\[[^\]]*\])\(([^()\s]+)((?:\s+"[^"]*")?)\)/g, (m, bang, label, target, title) => {
    const out = rewriteTarget(target, srcRel, { image: bang === "!" });
    return `${bang}${label}(${out}${title})`;
  });
  // Reference definitions: [label]: target
  text = text.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (m, head, target) => head + rewriteTarget(target, srcRel, { image: false }));
  // HTML attributes (href/src) in inline HTML
  text = text.replace(/\b(href|src)="([^"]+)"/g, (m, attr, target) => `${attr}="${rewriteTarget(target, srcRel, { image: attr === "src" })}"`);
  return text;
}

function splitCodeSpans(line) {
  // Alternate [prose, code, prose, code, ...]
  return line.split(/((`+)(?:(?!\2)[\s\S])+?\2)/g).filter((_, i) => i % 3 !== 2);
}

function rewriteLinks(markdown, srcRel) {
  const lines = markdown.split("\n");
  let fence = null;
  return lines
    .map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0].repeat(3);
        else if (f[1][0] === fence[0]) fence = null;
        return line;
      }
      if (fence) return line;
      const parts = splitCodeSpans(line);
      return parts.map((p, i) => (i % 2 === 0 ? rewriteProse(p, srcRel) : p)).join("");
    })
    .join("\n");
}

function plain(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function autoDescription(body) {
  const paras = body.split(/\n\s*\n/);
  for (const p of paras) {
    const t = p.trim();
    if (!t || /^(#|\||[-*+]\s|>|```|~~~|\d+\.\s|<)/.test(t) || /^Contents:/i.test(t)) continue;
    const s = plain(t);
    if (s.length < 20) continue;
    if (s.length <= 160) return s;
    const cut = s.slice(0, 157);
    return cut.slice(0, cut.lastIndexOf(" ")) + "...";
  }
  return "OpenBase documentation.";
}

function splitTitle(markdown) {
  const lines = markdown.split("\n");
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (!fence && /^# +\S/.test(lines[i])) {
      const title = plain(lines[i].replace(/^# +/, ""));
      lines.splice(i, 1);
      return { title, body: lines.join("\n").replace(/^\s*\n/, "") };
    }
  }
  return { title: null, body: markdown };
}

function syncDoc(doc) {
  const abs = path.join(repoDir, doc.src);
  if (!exists(abs)) {
    if (!doc.optional) warn(`${doc.src} is missing; its page is not generated`);
    return false;
  }
  const raw = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  const { title: found, body } = splitTitle(raw);
  const title = found || doc.slug;
  const fixed = rewriteLinks(body, doc.src);
  const description = doc.description || autoDescription(body);
  const front = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `editUrl: ${JSON.stringify(`${REPO_URL}/edit/${BRANCH}/${doc.src}`)}`,
    "---",
    "",
    `<!-- Generated by site/scripts/sync-docs.mjs from ${doc.src}. Do not edit here; edit the source file. -->`,
    "",
  ].join("\n");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${doc.slug}.md`), front + fixed);
  return true;
}

function copyBrand() {
  const brand = path.join(repoDir, "brand");
  const assets = path.join(siteDir, "src/assets/brand");
  const pub = path.join(siteDir, "public");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(pub, { recursive: true });
  const copies = [
    // [source, destination]
    ["openbase-lockup.svg", path.join(assets, "lockup.svg")],
    ["openbase-lockup-dark.svg", path.join(assets, "lockup-dark.svg")],
    ["openbase-mark.svg", path.join(assets, "mark.svg")],
    ["openbase-mark-small.svg", path.join(pub, "favicon.svg")],
    ["favicon.ico", path.join(pub, "favicon.ico")],
    ["png/apple-touch-icon.png", path.join(pub, "apple-touch-icon.png")],
  ];
  for (const [from, to] of copies) {
    const src = path.join(brand, from);
    if (!exists(src)) {
      warn(`brand/${from} is missing`);
      continue;
    }
    fs.copyFileSync(src, to);
  }
}

export function syncAll() {
  // Remove what an earlier run generated so that deleted docs disappear.
  for (const doc of DOCS) fs.rmSync(path.join(outDir, `${doc.slug}.md`), { force: true });
  fs.rmSync(assetsOut, { recursive: true, force: true });
  const written = DOCS.filter((d) => syncDoc(d)).map((d) => d.slug);
  copyBrand();
  console.log(`sync-docs: ${written.length} docs (${written.join(", ")}), brand assets copied`);
  for (const w of warnings) console.warn(`sync-docs: warning: ${w}`);
  return { written, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { warnings: w } = syncAll();
  if (process.argv.includes("--strict") && w.length) process.exit(1);
}
