/**
 * Parse pasted or typed text into the canonical stored JSON for a field
 * (mirror of og_core::cell::parse_text; the server re-validates with `typecast: true`).
 */
import type { Field } from "@/api/types";
import { fieldZone } from "./dates";
import { parseDate, storeParsedDate } from "./dates";
import { isComputed, selectChoicesOf } from "./kinds";
import { roundTo } from "./format";
import { canonicalUrl, cleanText, isValidEmail, isValidPhone, parseBoolWord, parseDuration, parseNumber, splitList } from "./text";

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface ParseCtx {
  /** Viewer's zone, used to interpret wall-clock date input when the field has no fixed zone. */
  timeZone: string;
  /** People who can be assigned in user fields. */
  users?: readonly { id: string; name: string; email: string }[];
  /** Linked record ids by (lower-cased) primary-field text, resolved by the caller before parsing. */
  linkIds?: ReadonlyMap<string, string>;
}

const MAX_TEXT = 100_000;

const ok = (value: unknown): ParseResult => ({ ok: true, value });
const fail = (error: string): ParseResult => ({ ok: false, error });

/** `{ok:true, value:null}` clears the cell. */
export const CLEAR: ParseResult = ok(null);

function isId(s: string, prefix: string): boolean {
  return s.startsWith(prefix) && /^[A-Za-z0-9]{1,40}$/.test(s.slice(prefix.length));
}

function resolveChoice(field: Field, key: string): string | null {
  const choices = selectChoicesOf(field);
  const exact = choices.find((c) => c.id === key || c.name === key);
  if (exact) return exact.id;
  const k = key.trim().toLowerCase();
  return choices.find((c) => c.name.trim().toLowerCase() === k)?.id ?? null;
}

/** Choice names in `text` that match no existing choice (what the server would have to create). */
export function missingChoiceNames(field: Field, text: string): string[] {
  if (field.type !== "single_select" && field.type !== "multiple_select") return [];
  const names = field.type === "multiple_select" ? splitList(text) : [text.trim()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const name = n.trim();
    if (!name || resolveChoice(field, name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Link names in `text` (comma-separated primary field texts) that are not record ids. */
export function linkNames(text: string): string[] {
  return splitList(text).filter((n) => !isId(n, "rec"));
}

function parseUsers(field: Extract<Field, { type: "user" }>, text: string, ctx: ParseCtx): ParseResult {
  const tokens = text.includes(",") || text.includes("@") ? splitList(text) : [text.trim()];
  const ids: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    let id: string | undefined;
    if (isId(t, "usr")) id = t;
    else {
      const lower = t.toLowerCase();
      id = ctx.users?.find((u) => u.name.toLowerCase() === lower || u.email.toLowerCase() === lower)?.id;
    }
    if (!id) return fail(`"${t}" is not a collaborator on this base`);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return CLEAR;
  if (!field.options.multiple && ids.length > 1) return fail("This field allows a single user");
  return ok(ids);
}

function parseLinks(field: Extract<Field, { type: "link" }>, text: string, ctx: ParseCtx): ParseResult {
  const ids: string[] = [];
  for (const name of splitList(text)) {
    const id = isId(name, "rec") ? name : ctx.linkIds?.get(name.toLowerCase());
    if (!id) return fail(`No linked record named "${name}"`);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return CLEAR;
  if (field.options.single && ids.length > 1) return fail("This field allows a single linked record");
  return ok(ids);
}

/** Turn text into the stored JSON for `field`. Blank text clears the cell. */
export function parseText(field: Field, text: string, ctx: ParseCtx): ParseResult {
  if (isComputed(field)) return fail("This field is computed and cannot be edited");
  const blank = text.trim() === "";
  switch (field.type) {
    case "single_line_text":
    case "long_text":
    case "barcode": {
      const cleaned = cleanText(text, field.type === "long_text");
      if (cleaned.trim() === "") return CLEAR;
      if ([...cleaned].length > MAX_TEXT) return fail("Text is too long");
      return ok(cleaned);
    }
    case "number":
    case "currency":
    case "percent": {
      if (blank) return CLEAR;
      const symbol = field.type === "currency" ? field.options.symbol : null;
      const p = parseNumber(text, symbol);
      if (!p) return fail(`"${text.trim()}" is not a number`);
      const v = p.percent || field.type === "percent" ? p.value / 100 : p.value;
      // Percent keeps two extra decimals: 12.5% is stored 0.125.
      const decimals = field.type === "percent" ? field.options.precision + 2 : field.options.precision;
      const rounded = roundTo(v, decimals);
      if (!field.options.allow_negative && rounded < 0) return fail("Negative numbers are not allowed");
      return ok(rounded === 0 ? 0 : rounded);
    }
    case "duration": {
      if (blank) return CLEAR;
      const secs = parseDuration(text);
      if (secs === null) return fail(`"${text.trim()}" is not a duration`);
      const dec = { h_mm: 0, h_mm_ss: 0, h_mm_ss_s: 1, h_mm_ss_ss: 2, h_mm_ss_sss: 3 }[field.options.format];
      return ok(roundTo(secs, dec));
    }
    case "rating": {
      const t = text.trim();
      if (!t) return CLEAR;
      const stars = [...t].filter((c) => c === "★" || c === "⭐").length;
      let v: number;
      if (stars > 0 && /^[★⭐☆ ]+$/u.test(t)) v = stars;
      else {
        const p = parseNumber(t, null);
        if (!p) return fail(`"${t}" is not a rating`);
        v = p.value;
      }
      v = Math.round(v);
      if (v === 0) return CLEAR;
      if (v < 0) return fail("Ratings cannot be negative");
      return ok(Math.min(v, field.options.max));
    }
    case "checkbox": {
      const b = parseBoolWord(text);
      if (b === null) return fail(`"${text.trim()}" is not a checkbox value`);
      return b ? ok(true) : CLEAR;
    }
    case "single_select": {
      const t = text.trim();
      if (!t) return CLEAR;
      // Unknown names pass through: the server (typecast) creates the option, or rejects it for non-creators.
      return ok(resolveChoice(field, t) ?? t);
    }
    case "multiple_select": {
      const out: string[] = [];
      for (const n of splitList(text)) {
        const v = resolveChoice(field, n) ?? n.trim();
        if (!out.includes(v)) out.push(v);
      }
      return out.length ? ok(out) : CLEAR;
    }
    case "date": {
      const t = text.trim();
      if (!t) return CLEAR;
      const parsed = parseDate(t, field.options.date_format === "european");
      if (!parsed) return fail(`"${t}" is not a recognised date`);
      return ok(storeParsedDate(parsed, field.options, ctx.timeZone));
    }
    case "email": {
      const t = text.trim();
      if (!t) return CLEAR;
      return isValidEmail(t) ? ok(t) : fail(`"${t}" is not a valid email address`);
    }
    case "url": {
      const t = text.trim();
      if (!t) return CLEAR;
      const u = canonicalUrl(t);
      return u ? ok(u) : fail("Only http, https and mailto links are allowed");
    }
    case "phone": {
      const t = text.trim();
      if (!t) return CLEAR;
      return isValidPhone(t) ? ok(t) : fail(`"${t}" is not a valid phone number`);
    }
    case "attachment":
      return blank ? CLEAR : fail("Attachments cannot be set from text");
    case "link":
      return blank ? CLEAR : parseLinks(field, text, ctx);
    case "user":
      return blank ? CLEAR : parseUsers(field, text, ctx);
    default:
      return fail("This field is computed and cannot be edited");
  }
}

/** Parse a TSV clipboard payload (rows split on newlines, cells on tabs, quoted cells supported). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const s = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
    i++;
  }
  // A trailing newline (spreadsheets add one) does not create an extra empty row.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Format rows of cell text as TSV; cells containing tabs, quotes or newlines are quoted. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((r) =>
      r
        .map((c) => (/[\t\n\r"]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c))
        .join("\t"),
    )
    .join("\n");
}

/** Deep equality of two JSON values (null and undefined are the same, "empty"). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export { fieldZone };
