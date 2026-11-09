// Design-token check (UX overhaul DL-1): every colour and font size in web/src comes from a token in
// web/src/styles/index.css, never from a literal in a component. Run through scripts/check-tokens.sh
// (scripts/check.sh and CI do); the detector is unit-tested in web/src/styles/checkTokens.test.mjs.
//
// Flagged, outside the exempt files below:
//   - a raw hex colour (#fff, #1f5ae0, #1f5ae080)
//   - an rgb(), rgba(), hsl() or hsla() colour
//   - a Tailwind palette colour utility (bg-white, text-black/70, border-slate-200, ring-blue-500):
//     the colour must come from a token (bg-surface, text-fg, border-line)
//   - a literal font size: Tailwind text-[13px] or text-[0.8125rem], fontSize: 13 / "13px" / {13}, a literal branch of a
//     conditional or fallback (fontSize: big ? 16 : 13, fontSize: x || 13), "font-size": "13px",
//     setProperty("font-size", "13px"), font-size:${13}px, font-size: 13px, font-size="13", and the
//     font shorthand (font: 13px ..., ctx.font = "600 13px ...")
// Comments are ignored; so are "#" in URLs, anchors, ids and entities, and "px" on anything that is
// not a font size (widths, borders, offsets).
//
// The exempt files (PERMANENT) legitimately hold literals: the token files themselves, the palettes the
// server shares, generated brand marks, the grid's canvas drawing, and tests. There is no list of files
// that "have not moved yet": every other file in web/src uses tokens, and stays that way (DONE-4).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SRC = path.join(root, "web", "src");

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

/** True for a file that may hold literals. */
export function isExempt(rel) {
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
// A Tailwind palette utility: white, black or a named colour with a shade, optionally with an opacity
// (bg-white, bg-black/60, border-slate-200, text-white/70). Tokens (bg-surface, text-fg) never match.
const PALETTE_COLOR =
  /(?<![\w-])(?:bg|text|border(?:-[xytblrse])?|ring|ring-offset|fill|stroke|outline|shadow|divide|from|via|to|decoration|accent|caret|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d{1,3}|\/\[[^\]]+\])?(?![\w-])/g;
const PX_FONT_SIZE = [
  // Tailwind arbitrary value: text-[13px], md:text-[length:13px], text-[0.8125rem] (a rem or em size is a size too)
  /(?<![\w-])text-\[(?:length:)?\d*\.?\d+(?:px|r?em)\]/g,
  // fontSize: 13, fontSize = "13px", fontSize={13}
  /\bfontSize\s*[:=]\s*\{?\s*["'`]?\d+(?:\.\d+)?(?:px)?["'`]?(?![\w%.])/g,
  // fontSize: "max(13px, 1em)"
  /\bfontSize\s*[:=]\s*\{?\s*["'`][^"'`\n]*\d\s*px\b/g,
  // fontSize: "0.8125rem", fontSize: "1.1em" (a relative size is still a literal; "inherit", "100%" and var() are not)
  /\bfontSize\s*[:=]\s*\{?\s*["'`]\d*\.?\d+r?em["'`]/g,
  // font-size: 13px, font-size: max(13px, 1em)
  /\bfont-size\s*:[^;}\n]*?(?<![\w.-])\d*\.?\d+px\b/gi,
  // font-size="13" (an SVG attribute)
  /\bfont-size\s*=\s*["']?\d+(?:\.\d+)?(?:px)?["']?(?![\w%.])/gi,
  // font: 13px/1.4 sans-serif, ctx.font = "600 13px Inter". A size computed at run time
  // (`${size * rem}px`) is not a literal and is left alone.
  /\bfont\s*[:=]\s*[`'"]?[^\n;,]*?\d\s*px\b/g,
  // A quoted key, as CSS-in-JS and style["font-size"] write it: "font-size": "13px", "font-size": 13
  /["'`]font-size["'`]\]?\s*[:=](?!=)\s*(?:\{?\s*\d+(?:\.\d+)?(?![\w%.])|["'`][^"'`\n]*\d\s*px\b)/g,
  // el.style.setProperty("font-size", "13px")
  /\bsetProperty\(\s*["'`]font-size["'`]\s*,\s*(?:\d+(?:\.\d+)?(?![\w%.])|["'`][^"'`\n]*\d\s*px\b)/g,
  // A literal written as an interpolation: font-size:${13}px, fontSize: `${13}px`
  /\b(?:font-size|fontSize)\s*[:=](?!=)\s*\{?\s*["'`]?\s*\$\{\s*\d+(?:\.\d+)?\s*\}\s*px/g,
];

/**
 * The literal branches of a fontSize value that is more than one literal: fontSize: big ? 16 : 13,
 * fontSize: x || 13, fontSize={wide ? "15px" : 13}. A number inside a call (Math.max(8, size / 4.5)) is
 * a computed size and is left alone, like the plain literal, which PX_FONT_SIZE already reports.
 */
function conditionalFontSizes(text) {
  const found = [];
  for (const key of text.matchAll(/\bfontSize\s*[:=](?!=)\s*/g)) {
    let i = key.index + key[0].length;
    if (/["'`]/.test(text[i] ?? "")) continue;
    const braced = text[i] === "{";
    if (braced) i++;
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
        i = j;
      } else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === "," || c === ";")) break;
      else if (depth === 0 && c === "\n" && !braced && !/^\s*(?:[?:]|\|\||&&)/.test(text.slice(i + 1, i + 40))) break;
    }
    const expr = text.slice(start, i);
    for (const m of expr.matchAll(/(?:\?\?|\|\||&&|\?|:)\s*(["'`]?)(\d+(?:\.\d+)?)(?:px)?\1\s*(?=$|\?\?|\|\||&&|:|\?|\)|\n)/g)) {
      found.push({ index: start + m.index + m[0].indexOf(m[2]), text: m[0].replace(/^[?:|&]+\s*/, "").trim() });
    }
  }
  return found;
}

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
  add(PALETTE_COLOR, "palette colour");
  for (const re of PX_FONT_SIZE) add(re, "px font size");
  for (const f of conditionalFontSizes(text)) found.push({ ...lineCol(text, f.index), kind: "px font size", text: f.text });
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

/** The whole check, without any printing: { violations: Map<file, violation[]>, scanned }. */
export function runCheck({ srcDir = SRC } = {}) {
  const violations = new Map();
  let scanned = 0;
  for (const full of walk(srcDir)) {
    const rel = path.relative(srcDir, full).split(path.sep).join("/");
    if (isExempt(rel)) continue;
    scanned++;
    const found = findViolations(readFileSync(full, "utf8"), rel);
    if (found.length > 0) violations.set(rel, found);
  }
  return { violations, scanned };
}

function main() {
  const { violations, scanned } = runCheck();
  for (const [file, found] of violations) {
    for (const v of found) console.error(`web/src/${file}:${v.line}:${v.col}  ${v.kind}: ${v.text}`);
  }
  if (violations.size > 0) {
    console.error(
      `\n${violations.size} file(s) use a literal where a design token belongs. Use a token from ` +
        "web/src/styles/index.css (a colour like text-fg or bg-primary-soft, a size like text-ui or " +
        "text-label, a surface like bg-surface or border-line).",
    );
    process.exit(1);
  }
  console.log(`Design tokens are used everywhere: ${scanned} files checked.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
