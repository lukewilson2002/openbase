// Design-token check (UX overhaul DL-1): every colour and font size in web/src comes from a token in
// web/src/styles/index.css, never from a literal in a component. Run through scripts/check-tokens.sh
// (scripts/check.sh and CI do); the detector is unit-tested in web/src/styles/checkTokens.test.mjs.
//
// Flagged, outside the two lists below:
//   - a raw hex colour (#fff, #1f5ae0, #1f5ae080)
//   - an rgb(), rgba(), hsl() or hsla() colour
//   - a px font size: Tailwind text-[13px], fontSize: 13 / "13px" / {13}, font-size: 13px,
//     font-size="13", and the font shorthand (font: 13px ..., ctx.font = "600 13px ...")
// Comments are ignored; so are "#" in URLs, anchors, ids and entities, and "px" on anything that is
// not a font size (widths, borders, offsets).
//
// The two lists:
//   PERMANENT  files that legitimately hold literals: the token files themselves, the palettes the
//              server shares, generated brand marks, the grid's canvas drawing, and tests.
//   TEMPORARY  scripts/check-tokens.temporary-list.txt: files that still fail because they have not
//              moved to tokens yet. It only shrinks: a file there with no violation left, or that no
//              longer exists, fails the check, so whoever fixes the last literal in a file removes
//              its line. It must be empty by Phase 7 of the UX overhaul.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SRC = path.join(root, "web", "src");
const TEMPORARY_LIST = path.join(here, "check-tokens.temporary-list.txt");

const SCANNED = /\.(?:[cm]?[jt]sx?|css)$/;

// Paths are relative to web/src, with forward slashes.
const PERMANENT_FILES = new Set([
  "theme/accents.ts",
  "lib/colors.ts",
  "lib/cells/palette.ts",
  "components/brandMarks.ts",
  "pages/account/AssistantMarks.tsx",
]);
const PERMANENT_DIRS = ["views/grid/glide/", "test/"];

/** True for a file that may hold literals for good (not the temporary list). */
export function isPermanentlyExempt(rel) {
  if (PERMANENT_FILES.has(rel)) return true;
  if (PERMANENT_DIRS.some((d) => rel.startsWith(d))) return true;
  if (/^styles\/[^/]+\.css$/.test(rel)) return true;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/**
 * Blank out comments, keeping every other character and every newline so line and column numbers
 * still point at the original text. Strings are kept (a colour inside one is a colour). A quote that
 * is not closed on its line ends there: JSX text has apostrophes, and a regex can hold a quote.
 */
export function stripComments(src, { css = false } = {}) {
  let out = "";
  let i = 0;
  // Frames: a template literal ("tpl") or code, which is the top level or a `${ }` inside a template.
  const stack = [{ kind: "code", depth: 0 }];
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const next = src[i + 1];
    if (top.kind === "tpl") {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        stack.pop();
        out += c;
        i++;
      } else if (c === "$" && next === "{") {
        stack.push({ kind: "code", depth: 0 });
        out += "${";
        i += 2;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (!css && c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const stop = src[j] === c ? j + 1 : j;
      out += src.slice(i, stop);
      i = stop;
    } else if (!css && c === "`") {
      stack.push({ kind: "tpl" });
      out += c;
      i++;
    } else if (stack.length > 1 && c === "{") {
      top.depth++;
      out += c;
      i++;
    } else if (stack.length > 1 && c === "}") {
      if (top.depth === 0) stack.pop();
      else top.depth--;
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// "#" starts a colour only when nothing word-like, an entity (&#), a path (/#) or url( comes before it
// and nothing word-like or a hyphen follows (#add-row is an anchor, #fff is a colour).
const HEX = /(?<![A-Za-z0-9&#/])(?<!url\(\s*["']?)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC_COLOR = /(?<![A-Za-z0-9])(?:rgba?|hsla?)\(/gi;
const PX_FONT_SIZE = [
  // Tailwind arbitrary value: text-[13px], md:text-[length:13px]
  /(?<![\w-])text-\[(?:length:)?\d*\.?\d+px\]/g,
  // fontSize: 13, fontSize = "13px", fontSize={13}
  /\bfontSize\s*[:=]\s*\{?\s*["'`]?\d+(?:\.\d+)?(?:px)?["'`]?(?![\w%.])/g,
  // fontSize: "max(13px, 1em)"
  /\bfontSize\s*[:=]\s*\{?\s*["'`][^"'`\n]*\d\s*px\b/g,
  // font-size: 13px, font-size: max(13px, 1em)
  /\bfont-size\s*:[^;}\n]*?(?<![\w.-])\d*\.?\d+px\b/gi,
  // font-size="13" (an SVG attribute)
  /\bfont-size\s*=\s*["']?\d+(?:\.\d+)?(?:px)?["']?(?![\w%.])/gi,
  // font: 13px/1.4 sans-serif, ctx.font = "600 13px Inter". A size computed at run time
  // (`${size * rem}px`) is not a literal and is left alone.
  /\bfont\s*[:=]\s*[`'"]?[^\n;,]*?\d\s*px\b/g,
];

function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, col: index - before.lastIndexOf("\n") };
}

/**
 * Every violation in one file's source: [{ line, col, kind, text }], in file order.
 * `file` only decides how comments are read (CSS has no // comments).
 */
export function findViolations(src, file = "x.tsx") {
  const text = stripComments(src, { css: file.endsWith(".css") });
  const found = [];
  const add = (re, kind) => {
    for (const m of text.matchAll(re)) found.push({ ...lineCol(text, m.index), kind, text: m[0] });
  };
  add(HEX, "hex colour");
  add(FUNC_COLOR, "rgb/hsl colour");
  for (const re of PX_FONT_SIZE) add(re, "px font size");
  // The same text can match two font-size patterns; report each spot once.
  const seen = new Set();
  return found
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter((v) => !seen.has(`${v.line}:${v.col}`) && seen.add(`${v.line}:${v.col}`));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCANNED.test(entry.name)) yield full;
  }
}

/** Entries of the temporary list: one path per line, `#` lines and blank lines ignored. */
export function parseTemporaryList(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * The whole check, without any printing: { violations: Map<file, violation[]> for files on neither
 * list, problems: string[] about the temporary list, scanned, temporary }.
 */
export function runCheck({ srcDir = SRC, listFile = TEMPORARY_LIST } = {}) {
  const temporary = parseTemporaryList(existsSync(listFile) ? readFileSync(listFile, "utf8") : "");
  const onList = new Set(temporary);
  const problems = [];
  if (onList.size !== temporary.length) problems.push("the temporary list has a duplicate entry");

  const violations = new Map();
  const withViolations = new Set();
  let scanned = 0;
  for (const full of walk(srcDir)) {
    const rel = path.relative(srcDir, full).split(path.sep).join("/");
    if (isPermanentlyExempt(rel)) continue;
    scanned++;
    const found = findViolations(readFileSync(full, "utf8"), rel);
    if (found.length === 0) continue;
    withViolations.add(rel);
    if (!onList.has(rel)) violations.set(rel, found);
  }

  for (const rel of temporary) {
    if (isPermanentlyExempt(rel)) {
      problems.push(`${rel}: already exempt for good, remove it from the temporary list`);
    } else if (!existsSync(path.join(srcDir, rel))) {
      problems.push(`${rel}: no such file (moved or deleted), remove it from the temporary list`);
    } else if (!withViolations.has(rel)) {
      problems.push(`${rel}: no raw colour or px font size left, remove it from the temporary list`);
    }
  }
  return { violations, problems, scanned, temporary };
}

function main() {
  const { violations, problems, scanned, temporary } = runCheck();
  for (const [file, found] of violations) {
    for (const v of found) console.error(`web/src/${file}:${v.line}:${v.col}  ${v.kind}: ${v.text}`);
  }
  for (const p of problems) console.error(`scripts/check-tokens.temporary-list.txt: ${p}`);
  if (violations.size > 0) {
    console.error(
      `\n${violations.size} file(s) use a literal where a design token belongs. Use a token from ` +
        "web/src/styles/index.css (a colour like text-fg or bg-primary-soft, a size like text-ui or " +
        "text-label). Files that have not moved yet are listed in scripts/check-tokens.temporary-list.txt; " +
        "never add to it.",
    );
  }
  if (violations.size > 0 || problems.length > 0) process.exit(1);
  console.log(
    `Design tokens are used everywhere: ${scanned} files checked, ${temporary.length} still on the temporary list.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
