/**
 * Display formatting for cells (mirror of ob_core::cell::present): numbers, currency, percent,
 * durations, dates, selects, links, users, attachments and computed values.
 */
import { personColor } from "@/lib/colors";
import type { DateOptions, DurationFormat, Field, ResultType, ValueFormat } from "@/api/types";
import { formatStoredDate } from "./dates";
import {
  attachmentRefs,
  dateOptionsOf,
  displayShapeOf,
  linkRefs,
  resultTypeOf,
  selectChoicesOf,
  stringItems,
  valueFormatOf,
  type CellJson,
} from "./kinds";
import { joinList } from "./text";

export interface FormatCtx {
  /** Viewer's IANA zone, used for date fields without a fixed zone. */
  timeZone: string;
  /** Resolve a user id to a display name. */
  userName: (id: string) => string | undefined;
  /** Resolve a user id to an email, which seeds the person's face colour like everywhere else. */
  userEmail?: (id: string) => string | undefined;
  /** A person's own colour among the base's collaborators (`personColors`), distinct per person. */
  userColor?: (id: string) => string | undefined;
}

export const DEFAULT_CTX: FormatCtx = { timeZone: "UTC", userName: () => undefined };

export type NumberFormat =
  | { kind: "general" }
  | { kind: "integer" }
  | { kind: "fixed"; precision: number }
  | { kind: "currency"; precision: number; symbol: string }
  | { kind: "percent"; precision: number }
  | { kind: "duration"; format: DurationFormat };

/** Round half away from zero (Rust's `f64::round`), unlike `Math.round`. */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function roundTo(v: number, decimals: number): number {
  const factor = 10 ** Math.min(Math.max(decimals, 0), 10);
  const r = roundHalfAway(v * factor) / factor;
  return Number.isFinite(r) ? r : v;
}

function stripNegativeZero(s: string): string {
  return /^-[0.]*$/.test(s) ? s.slice(1) : s;
}

function formatFixed(v: number, precision: number): string {
  const p = Math.min(Math.max(precision, 0), 8);
  return stripNegativeZero(roundTo(v, p).toFixed(p));
}

function withThousands(s: string): string {
  const neg = s.startsWith("-");
  const rest = neg ? s.slice(1) : s;
  const [int = "", frac] = rest.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac === undefined ? "" : `.${frac}`}`;
}

/** Shortest sensible decimal text: integers without a fraction, otherwise up to 10 decimals trimmed. */
export function formatGeneralNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return stripNegativeZero(v.toFixed(0));
  return stripNegativeZero(v.toFixed(10).replace(/0+$/, "").replace(/\.$/, ""));
}

/** Format seconds as `h:mm`, `h:mm:ss` or `h:mm:ss.s…`. */
export function formatDuration(secs: number, fmt: DurationFormat): string {
  const negative = secs < 0;
  const a = Math.abs(secs);
  let text: string;
  if (fmt === "h_mm") {
    const totalMin = Math.round(a / 60);
    text = `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
  } else {
    const decimals = fmt === "h_mm_ss_s" ? 1 : fmt === "h_mm_ss_ss" ? 2 : fmt === "h_mm_ss_sss" ? 3 : 0;
    const scale = 10 ** decimals;
    const total = Math.round(a * scale);
    const whole = Math.floor(total / scale);
    const frac = total % scale;
    const base = `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
    text = decimals === 0 ? base : `${base}.${String(frac).padStart(decimals, "0")}`;
  }
  const isZero = /^[0:.]*$/.test(text);
  return negative && !isZero ? `-${text}` : text;
}

export function formatNumber(v: number, fmt: NumberFormat): string {
  if (!Number.isFinite(v)) return "";
  switch (fmt.kind) {
    case "general":
      return formatGeneralNumber(v);
    case "integer":
      return formatFixed(v, 0);
    case "fixed":
      return formatFixed(v, fmt.precision);
    case "currency": {
      const s = withThousands(formatFixed(v, fmt.precision));
      return s.startsWith("-") ? `-${fmt.symbol}${s.slice(1)}` : `${fmt.symbol}${s}`;
    }
    case "percent":
      return `${formatFixed(v * 100, fmt.precision)}%`;
    case "duration":
      return formatDuration(v, fmt.format);
  }
}

function fromValueFormat(f: ValueFormat | null | undefined): NumberFormat {
  switch (f?.kind) {
    case "number":
      return { kind: "fixed", precision: f.precision };
    case "currency":
      return { kind: "currency", precision: f.precision, symbol: f.symbol };
    case "percent":
      return { kind: "percent", precision: f.precision };
    case "duration":
      return { kind: "duration", format: f.format };
    default:
      return { kind: "general" };
  }
}

/** How a field's numbers are displayed. */
export function numberFormatOf(field: Field): NumberFormat {
  switch (field.type) {
    case "number":
      return { kind: "fixed", precision: field.options.precision };
    case "currency":
      return { kind: "currency", precision: field.options.precision, symbol: field.options.symbol };
    case "percent":
      return { kind: "percent", precision: field.options.precision };
    case "duration":
      return { kind: "duration", format: field.options.format };
    case "rating":
    case "autonumber":
    case "count":
      return { kind: "integer" };
    case "formula":
    case "rollup":
      return fromValueFormat(valueFormatOf(field));
    default:
      return { kind: "general" };
  }
}

export function toNumber(v: CellJson): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** A chip drawn in a cell: select choices, linked records, users, computed array items. */
export interface ChipItem {
  text: string;
  /** Palette colour name (see lib/colors) for select choices. */
  color?: string;
  /** Linked record id / user id / choice id. */
  id?: string;
}

export interface FormulaError {
  error: string;
}

export function isFormulaError(v: unknown): v is FormulaError {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as FormulaError).error === "string";
}

function computedScalarText(json: CellJson, rt: ResultType, numFmt: NumberFormat, dateOpts: DateOptions | null, ctx: FormatCtx): string {
  if (json === null || json === undefined) return "";
  if (isFormulaError(json)) return json.error;
  switch (rt) {
    case "number": {
      const n = toNumber(json);
      return n === null ? "" : formatNumber(n, numFmt);
    }
    case "bool":
      return json === true ? "true" : json === false ? "false" : "";
    case "date":
    case "date_time":
      return dateOpts ? formatStoredDate(json, dateOpts, ctx.timeZone) : typeof json === "string" ? json : "";
    default:
      if (typeof json === "string") return json;
      if (typeof json === "number") return formatGeneralNumber(json);
      if (typeof json === "boolean") return String(json);
      return "";
  }
}

/** Items of a computed array result, as chips. */
function computedItems(json: CellJson, rt: ResultType, numFmt: NumberFormat, dateOpts: DateOptions | null, ctx: FormatCtx): ChipItem[] {
  const inner = typeof rt === "object" ? rt.array : rt;
  const arr = Array.isArray(json) ? json : json === null || json === undefined ? [] : [json];
  const out: ChipItem[] = [];
  for (const el of arr) {
    if (Array.isArray(el)) {
      out.push(...computedItems(el, inner, numFmt, dateOpts, ctx));
      continue;
    }
    // Lookups of link fields come back as {id,name} objects.
    if (el && typeof el === "object" && !isFormulaError(el) && typeof (el as { name?: unknown }).name === "string") {
      out.push({ text: (el as { name: string }).name, id: (el as { id?: string }).id });
      continue;
    }
    const text = computedScalarText(el as CellJson, inner, numFmt, dateOpts, ctx);
    if (text !== "") out.push({ text });
  }
  return out;
}

/** Chips for a cell whose value is a list (select, multi-select, link, user, computed arrays). */
export function chipItems(field: Field, stored: CellJson, ctx: FormatCtx): ChipItem[] {
  if (stored === null || stored === undefined) return [];
  switch (displayShapeOf(field)) {
    case "select":
    case "multi_select": {
      const choices = selectChoicesOf(field);
      const out: ChipItem[] = [];
      for (const id of stringItems(stored)) {
        const c = choices.find((x) => x.id === id);
        if (c) out.push({ text: c.name, color: c.color, id: c.id });
      }
      return out;
    }
    case "link":
      return linkRefs(stored).map((r) => ({ text: r.name, id: r.id }));
    case "user":
      return stringItems(stored).map((id) => {
        const text = ctx.userName(id) ?? id;
        return { text, id, color: ctx.userColor?.(id) ?? personColor(ctx.userEmail?.(id) || text) };
      });
    case "attachment":
      return attachmentRefs(stored).map((a) => ({ text: a.filename, id: a.id }));
    case "list": {
      const rt = resultTypeOf(field) ?? "text";
      return computedItems(stored, rt, numberFormatOf(field), dateOptionsOf(field), ctx);
    }
    default:
      return [];
  }
}

/** Human text for a cell: what the grid shows and what Copy puts on the clipboard. */
export function displayText(field: Field, stored: CellJson, ctx: FormatCtx = DEFAULT_CTX): string {
  const shape = displayShapeOf(field);
  if (shape === "checkbox") {
    return stored === true ? (field.type === "checkbox" ? "checked" : "true") : stored === false && field.type !== "checkbox" ? "false" : "";
  }
  if (stored === null || stored === undefined) return "";
  if (isFormulaError(stored)) return stored.error;
  switch (shape) {
    case "button":
      return field.type === "button" && typeof stored === "string" && stored ? field.options.label : "";
    case "text":
    case "long_text":
    case "url":
    case "email":
    case "phone":
      return typeof stored === "string" ? stored : typeof stored === "number" ? formatGeneralNumber(stored) : "";
    case "number": {
      const n = toNumber(stored);
      return n === null ? "" : formatNumber(n, numberFormatOf(field));
    }
    case "rating": {
      const n = toNumber(stored);
      return n === null ? "" : formatNumber(n, { kind: "integer" });
    }
    case "date": {
      const opts = dateOptionsOf(field);
      return opts ? formatStoredDate(stored, opts, ctx.timeZone) : "";
    }
    case "select":
    case "multi_select":
    case "link":
    case "user":
    case "attachment":
    case "list":
      return joinList(chipItems(field, stored, ctx).map((c) => c.text));
  }
}

/**
 * Text for an in-cell text editor: the display text without thousands separators or symbols
 * that would make re-parsing lossy (numbers show their exact value).
 */
export function editText(field: Field, stored: CellJson, ctx: FormatCtx = DEFAULT_CTX): string {
  if (stored === null || stored === undefined) return "";
  switch (field.type) {
    case "number":
    case "currency":
      return typeof stored === "number" ? formatGeneralNumber(stored) : displayText(field, stored, ctx);
    case "percent":
      return typeof stored === "number" ? `${formatGeneralNumber(roundTo(stored * 100, 8))}%` : displayText(field, stored, ctx);
    default:
      return displayText(field, stored, ctx);
  }
}
