/**
 * "Wall time" for calendar and timeline layout.
 *
 * A date cell is either `YYYY-MM-DD` (never shifts between zones) or an instant (RFC 3339 UTC)
 * that is shown in the field's zone, or the viewer's zone when the field has none. To place both
 * on one axis, a value is read as *wall time*: the milliseconds of its wall-clock reading
 * interpreted as UTC. Days are then exactly 86,400,000 ms (no DST jumps), and drag results map
 * back to stored values through the field's zone with `zonedToInstant`, which also settles DST
 * gaps and overlaps the same way the server does.
 */
import type { DateOptions, Field } from "@/api/types";
import { dateOptionsOf, kindClassOf } from "@/lib/cells/kinds";
import { fieldZone, instantToIso, pad2, readStoredDate, ymdToIso, zonedParts, zonedToInstant } from "@/lib/cells/dates";

export const DAY_MS = 86_400_000;

export interface WallValue {
  /** Wall-clock milliseconds (see the file comment). */
  ms: number;
  /** The cell holds a date without a time of day. */
  dateOnly: boolean;
}

/** Date fields a calendar or timeline can use: dates, created/modified time, date-valued formulas. */
export function isDateLike(field: Field): boolean {
  return kindClassOf(field) === "date" && dateOptionsOf(field) !== null;
}

/** Only plain date fields can be written; the others are computed. */
export function isWritableDate(field: Field | undefined): boolean {
  return field?.type === "date";
}

export function readWall(value: unknown, opts: DateOptions, viewerZone: string): WallValue | null {
  const d = readStoredDate(value);
  if (!d) return null;
  if (d.kind === "date") return { ms: Date.UTC(d.ymd.y, d.ymd.m - 1, d.ymd.d), dateOnly: !opts.include_time };
  const p = zonedParts(d.ms, fieldZone(opts, viewerZone));
  if (!opts.include_time) return { ms: Date.UTC(p.y, p.m - 1, p.d), dateOnly: true };
  return { ms: Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, p.ms), dateOnly: false };
}

/** Stored cell value for a wall-clock time under a field's options. */
export function wallToStored(wallMs: number, opts: DateOptions, viewerZone: string): string {
  const d = new Date(wallMs);
  const ymd = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  if (!opts.include_time) return ymdToIso(ymd);
  return instantToIso(zonedToInstant({ ...ymd, h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }, fieldZone(opts, viewerZone)));
}

/** `YYYY-MM-DD` of a wall time. */
export function wallYmd(ms: number): string {
  const d = new Date(ms);
  return ymdToIso({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
}

/** Wall time of local midnight for a `YYYY-MM-DD` string, or null. */
export function ymdWall(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

/** Wall time "now" in the viewer's zone. */
export function wallNow(zone: string, now: Date = new Date()): number {
  const p = zonedParts(now.getTime(), zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, p.ms);
}

export function floorDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** ISO-like string without zone (`YYYY-MM-DDTHH:mm:ss`), read as UTC by FullCalendar's UTC mode. */
export function wallIso(ms: number): string {
  const d = new Date(ms);
  return `${wallYmd(ms)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export interface Span {
  startMs: number;
  /** Exclusive end. Equals `startMs + one day` (date-only) or `startMs` (timed) when there is no end. */
  endMs: number;
  startDateOnly: boolean;
  /** The record has a usable end value after its start. */
  hasEnd: boolean;
}

/**
 * The span a record occupies. A date-only end is inclusive (the whole last day belongs to the
 * span). An end that is missing or before the start collapses to no end.
 */
export function recordSpan(
  values: Record<string, unknown>,
  start: { id: string; opts: DateOptions },
  end: { id: string; opts: DateOptions } | null,
  viewerZone: string,
): Span | null {
  const s = readWall(values[start.id], start.opts, viewerZone);
  if (!s) return null;
  const e = end ? readWall(values[end.id], end.opts, viewerZone) : null;
  const endExclusive = e ? (e.dateOnly ? e.ms + DAY_MS : e.ms) : null;
  if (endExclusive !== null && endExclusive > s.ms) return { startMs: s.ms, endMs: endExclusive, startDateOnly: s.dateOnly, hasEnd: true };
  return { startMs: s.ms, endMs: s.dateOnly ? s.ms + DAY_MS : s.ms, startDateOnly: s.dateOnly, hasEnd: false };
}

/** Pad `YYYY-MM-DD` bounds by whole days (for range queries; the server rounds in its own zone). */
export function padRange(from: string, to: string, days: number): { from: string; to: string } | null {
  const a = ymdWall(from);
  const b = ymdWall(to);
  if (a === null || b === null) return null;
  return { from: wallYmd(a - days * DAY_MS), to: wallYmd(b + days * DAY_MS) };
}
