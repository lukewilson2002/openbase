/**
 * Date and time helpers for date fields. Mirrors ob_core::cell date handling:
 * - date-only values are `YYYY-MM-DD` and never shift between zones;
 * - instants are RFC 3339 UTC strings with milliseconds (`...Z`);
 * - a field may fix a zone (`DateOptions.timezone`), otherwise the viewer's zone is used.
 */
import type { DateFormat, DateOptions } from "@/api/types";

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export interface LocalDateTime extends YMD {
  h: number;
  mi: number;
  s: number;
  ms: number;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthName(m: number): string {
  return MONTH_NAMES[m - 1] ?? "";
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    zoneFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function msPart(instantMs: number): number {
  return ((instantMs % 1000) + 1000) % 1000;
}

/** Wall-clock parts of an instant in `timeZone`. */
export function zonedParts(instantMs: number, timeZone: string): LocalDateTime {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = zoneFormatter(tz).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second"), ms: msPart(instantMs) };
}

/** Offset (zone minus UTC) in milliseconds at an instant. */
function offsetAt(instantMs: number, tz: string): number {
  const p = zonedParts(instantMs, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, 0) - (instantMs - msPart(instantMs));
}

/**
 * The instant for a wall-clock time in `timeZone`. Ambiguous times (DST fall-back) take the
 * earlier instant; times inside a DST gap move forward by the gap (as the server does).
 */
export function zonedToInstant(local: LocalDateTime, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const asUtc = Date.UTC(local.y, local.m - 1, local.d, local.h, local.mi, local.s, local.ms);
  // Candidate instants using the offsets in force a day before and a day after; whichever
  // renders back to the same wall clock is valid. Two valid = ambiguous (take the earlier).
  const offBefore = offsetAt(asUtc - 86_400_000, tz);
  const offAfter = offsetAt(asUtc + 86_400_000, tz);
  const candidates = new Set([asUtc - offBefore, asUtc - offAfter]);
  const valid: number[] = [];
  for (const c of candidates) {
    const p = zonedParts(c, tz);
    if (p.y === local.y && p.m === local.m && p.d === local.d && p.h === local.h && p.mi === local.mi && p.s === local.s) valid.push(c);
  }
  if (valid.length > 0) return Math.min(...valid);
  // Inside a gap: interpret with the pre-transition offset, which lands past the gap.
  return asUtc - offBefore;
}

export type StoredDate = { kind: "date"; ymd: YMD } | { kind: "instant"; ms: number };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function validYmd({ y, m, d }: YMD): boolean {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Read a stored date cell: `YYYY-MM-DD` or an RFC 3339 instant. */
export function readStoredDate(s: unknown): StoredDate | null {
  if (typeof s !== "string") return null;
  const m = DATE_ONLY.exec(s);
  if (m) {
    const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    return validYmd(ymd) ? { kind: "date", ymd } : null;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : { kind: "instant", ms };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdToIso({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

export function instantToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatDay({ y, m, d }: YMD, f: DateFormat): string {
  switch (f) {
    case "us":
      return `${m}/${d}/${y}`;
    case "european":
      return `${d}/${m}/${y}`;
    case "iso":
      return ymdToIso({ y, m, d });
    case "friendly":
      return `${monthName(m)} ${d}, ${y}`;
  }
}

function formatTime(p: LocalDateTime, f: DateOptions["time_format"]): string {
  if (f === "h24") return `${pad2(p.h)}:${pad2(p.mi)}`;
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${pad2(p.mi)}${p.h < 12 ? "am" : "pm"}`;
}

/** The zone a field shows dates in: its fixed zone, else the viewer's. */
export function fieldZone(opts: Pick<DateOptions, "timezone">, viewerZone: string): string {
  return isValidTimeZone(opts.timezone) ? opts.timezone : isValidTimeZone(viewerZone) ? viewerZone : "UTC";
}

/** Display text of a stored date per the field's date options. Unreadable input yields "". */
export function formatStoredDate(stored: unknown, opts: DateOptions, viewerZone: string): string {
  const d = readStoredDate(stored);
  if (!d) return "";
  if (d.kind === "date") return formatDay(d.ymd, opts.date_format);
  const p = zonedParts(d.ms, fieldZone(opts, viewerZone));
  const day = formatDay(p, opts.date_format);
  return opts.include_time ? `${day} ${formatTime(p, opts.time_format)}` : day;
}

/** Value for `<input type="date">` / `<input type="datetime-local">` from a stored date. */
export function toInputValue(stored: unknown, opts: DateOptions, viewerZone: string): string {
  const d = readStoredDate(stored);
  if (!d) return "";
  if (d.kind === "date") return opts.include_time ? `${ymdToIso(d.ymd)}T00:00` : ymdToIso(d.ymd);
  const p = zonedParts(d.ms, fieldZone(opts, viewerZone));
  const day = ymdToIso(p);
  return opts.include_time ? `${day}T${pad2(p.h)}:${pad2(p.mi)}` : day;
}

/** Stored JSON from the value of an `<input type="date|datetime-local">`; null when unreadable. */
export function fromInputValue(input: string, opts: DateOptions, viewerZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(input.trim());
  if (!m) return null;
  const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (!validYmd(ymd)) return null;
  if (!opts.include_time) return ymdToIso(ymd);
  const local: LocalDateTime = { ...ymd, h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0), ms: 0 };
  return instantToIso(zonedToInstant(local, fieldZone(opts, viewerZone)));
}

/** A date read from text before the field zone is applied. */
export type ParsedDate = { kind: "date"; ymd: YMD } | { kind: "local"; local: LocalDateTime } | { kind: "instant"; ms: number };

const TIME = String.raw`(?:\s*(?:,|T|at)?\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*([aApP]\.?[mM]?\.?)?)?`;
const ISO_RE = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})${TIME}\s*(Z|z|UTC|[+-]\d{2}(?::?\d{2})?)?$`);
const SLASH_RE = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})${TIME}$`);
const MONTH_FIRST_RE = new RegExp(String.raw`^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})${TIME}$`);
const DAY_FIRST_RE = new RegExp(String.raw`^(?:[A-Za-z]+,\s*)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})${TIME}$`);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function monthFromName(name: string): number | null {
  const n = name.toLowerCase();
  if (n.length < 3) return null;
  if (n === "sept") return 9;
  const i = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(n));
  return i < 0 ? null : i + 1;
}

function ymdOf(y: string, m: number, d: number): YMD | null {
  let year = Number(y);
  if (y.length <= 2) year += 2000;
  const ymd = { y: year, m, d };
  return validYmd(ymd) ? ymd : null;
}

interface TimeParts {
  h: number;
  mi: number;
  s: number;
  ms: number;
}

/** `undefined` = no time given, `null` = a time was given but is invalid. */
function timeFrom(c: RegExpExecArray, first: number): TimeParts | null | undefined {
  const hour = c[first];
  if (hour === undefined) return undefined;
  const minute = c[first + 1];
  const ampm = c[first + 4]?.toLowerCase();
  if (minute === undefined && ampm === undefined) return null; // a bare number after a date is not a time
  let h = Number(hour);
  const mi = minute === undefined ? 0 : Number(minute);
  const s = c[first + 2] === undefined ? 0 : Number(c[first + 2]);
  const frac = c[first + 3];
  const ms = frac === undefined ? 0 : Number(`${frac}00`.slice(0, 3));
  if (ampm) {
    if (h < 1 || h > 12) return null;
    const pm = ampm.startsWith("p");
    h = h === 12 ? (pm ? 12 : 0) : pm ? h + 12 : h;
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  return { h, mi, s, ms };
}

function parseOffset(z: string): number | null {
  if (/^(z|utc)$/i.test(z)) return 0;
  const sign = z.startsWith("-") ? -1 : 1;
  const digits = z.slice(1).replace(/\D/g, "");
  let h: number;
  let m: number;
  if (digits.length === 2) {
    h = Number(digits);
    m = 0;
  } else if (digits.length === 4) {
    h = Number(digits.slice(0, 2));
    m = Number(digits.slice(2));
  } else return null;
  if (h > 23 || m > 59) return null;
  return sign * (h * 3600 + m * 60) * 1000;
}

function finish(ymd: YMD | null, time: TimeParts | null | undefined, zone: string | undefined): ParsedDate | null {
  if (!ymd || time === null) return null;
  if (time === undefined) return zone === undefined ? { kind: "date", ymd } : null;
  const local: LocalDateTime = { ...ymd, ...time };
  if (zone === undefined) return { kind: "local", local };
  const off = parseOffset(zone);
  if (off === null) return null;
  return { kind: "instant", ms: Date.UTC(local.y, local.m - 1, local.d, local.h, local.mi, local.s, local.ms) - off };
}

/**
 * Parse a date or date-time from text: ISO and RFC 3339, `MM/DD/YYYY` (or `DD/MM/YYYY` when
 * `european`), `Month D, YYYY`, `D Month YYYY`, each optionally followed by a time.
 */
export function parseDate(input: string, european: boolean): ParsedDate | null {
  const s = input.trim();
  if (!s || s.length > 100) return null;
  if (RFC3339.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return { kind: "instant", ms };
  }
  let c = ISO_RE.exec(s);
  if (c) return finish(ymdOf(c[1]!, Number(c[2]), Number(c[3])), timeFrom(c, 4), c[9]);
  c = SLASH_RE.exec(s);
  if (c) {
    const [mm, dd] = european ? [c[2]!, c[1]!] : [c[1]!, c[2]!];
    return finish(ymdOf(c[3]!, Number(mm), Number(dd)), timeFrom(c, 4), undefined);
  }
  c = MONTH_FIRST_RE.exec(s);
  if (c) {
    const month = monthFromName(c[1]!);
    return month === null ? null : finish(ymdOf(c[3]!, month, Number(c[2])), timeFrom(c, 4), undefined);
  }
  c = DAY_FIRST_RE.exec(s);
  if (c) {
    const month = monthFromName(c[2]!);
    return month === null ? null : finish(ymdOf(c[3]!, month, Number(c[1])), timeFrom(c, 4), undefined);
  }
  return null;
}

/** Canonical stored JSON for a parsed date under a field's options (mirrors `store_date`). */
export function storeParsedDate(parsed: ParsedDate, opts: DateOptions, viewerZone: string): string {
  const zone = fieldZone(opts, viewerZone);
  if (opts.include_time) {
    switch (parsed.kind) {
      case "instant":
        return instantToIso(parsed.ms);
      case "local":
        return instantToIso(zonedToInstant(parsed.local, zone));
      case "date":
        return instantToIso(zonedToInstant({ ...parsed.ymd, h: 0, mi: 0, s: 0, ms: 0 }, zone));
    }
  }
  switch (parsed.kind) {
    case "date":
      return ymdToIso(parsed.ymd);
    case "local":
      return ymdToIso(parsed.local);
    case "instant":
      return ymdToIso(zonedParts(parsed.ms, zone));
  }
}

/** Today's date in `timeZone` as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return ymdToIso(zonedParts(now.getTime(), timeZone));
}
