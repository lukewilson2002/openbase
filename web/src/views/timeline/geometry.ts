/**
 * Pure timeline geometry: the time axis per scale, tick marks, bar rectangles, lane layout with
 * row packing, drag arithmetic and dependency arrows.
 *
 * Everything is in wall time (see ../common/wallTime.ts). A "day number" is wall ms / one day,
 * so `xOf` is simply (days since the window start) times pixels per day.
 */
import type { TimelineScale } from "@/api/types";
import { DAY_MS, type Span } from "../common/wallTime";

export const SCALES: readonly TimelineScale[] = ["day", "week", "month", "quarter", "year"];
export const SCALE_LABELS: Record<TimelineScale, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

/** Horizontal pixels per day at each scale. */
export const PX_PER_DAY: Record<TimelineScale, number> = { day: 48, week: 14, month: 4, quarter: 1.4, year: 0.5 };

/** Days shown on each side of the centre when a window is first built (and added per extension). */
const HALF_SPAN_DAYS: Record<TimelineScale, number> = { day: 45, week: 200, month: 900, quarter: 2200, year: 5500 };

export const ROW_HEIGHT = 36;
export const BAR_HEIGHT = 24;
export const LANE_PAD = 6;
export const MILESTONE_SIZE = 16;
export const MIN_BAR_WIDTH = 8;

export interface Axis {
  /** First day shown (inclusive), as a day number. */
  fromDay: number;
  /** Last day shown (exclusive). */
  toDay: number;
  pxPerDay: number;
}

export const axisWidth = (a: Axis): number => Math.round((a.toDay - a.fromDay) * a.pxPerDay);

export function dayNumber(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function makeAxis(scale: TimelineScale, centerDay: number): Axis {
  const half = HALF_SPAN_DAYS[scale];
  return { fromDay: Math.floor(centerDay) - half, toDay: Math.floor(centerDay) + half, pxPerDay: PX_PER_DAY[scale] };
}

/** The axis grown by one half span on one side (the user scrolled near that edge). */
export function extendAxis(axis: Axis, side: "start" | "end", scale: TimelineScale): Axis {
  const add = HALF_SPAN_DAYS[scale];
  return side === "start" ? { ...axis, fromDay: axis.fromDay - add } : { ...axis, toDay: axis.toDay + add };
}

export const xOfMs = (ms: number, a: Axis): number => (ms / DAY_MS - a.fromDay) * a.pxPerDay;
export const xOfDay = (day: number, a: Axis): number => (day - a.fromDay) * a.pxPerDay;
export const dayAtX = (x: number, a: Axis): number => Math.floor(x / a.pxPerDay) + a.fromDay;
/** The day at the centre of a viewport scrolled to `scrollLeft` (chart coordinates, label column excluded). */
export const centerDayOf = (scrollLeft: number, viewportWidth: number, a: Axis): number => a.fromDay + (scrollLeft + viewportWidth / 2) / a.pxPerDay;

/** One step finer (zoom in) or coarser (zoom out). */
export function stepScale(scale: TimelineScale, dir: "in" | "out"): TimelineScale {
  const i = SCALES.indexOf(scale);
  return SCALES[Math.min(SCALES.length - 1, Math.max(0, i + (dir === "in" ? -1 : 1)))]!;
}

// ---- ticks -------------------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Tick {
  label: string;
  /** First day of the period (inclusive) and the day after its last. */
  startDay: number;
  endDay: number;
}

type Unit = "day" | "week" | "month" | "quarter" | "year" | "decade";

function civil(day: number): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
const dayOfCivil = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** Start day of the period of `unit` containing `day` (weeks start on Monday). */
function periodStart(unit: Unit, day: number): number {
  const c = civil(day);
  switch (unit) {
    case "day":
      return day;
    case "week":
      return day - ((c.dow + 6) % 7);
    case "month":
      return dayOfCivil(c.y, c.m, 1);
    case "quarter":
      return dayOfCivil(c.y, Math.floor((c.m - 1) / 3) * 3 + 1, 1);
    case "year":
      return dayOfCivil(c.y, 1, 1);
    case "decade":
      return dayOfCivil(Math.floor(c.y / 10) * 10, 1, 1);
  }
}

function nextPeriod(unit: Unit, start: number): number {
  const c = civil(start);
  switch (unit) {
    case "day":
      return start + 1;
    case "week":
      return start + 7;
    case "month":
      return dayOfCivil(c.y, c.m + 1, 1);
    case "quarter":
      return dayOfCivil(c.y, c.m + 3, 1);
    case "year":
      return dayOfCivil(c.y + 1, 1, 1);
    case "decade":
      return dayOfCivil(c.y + 10, 1, 1);
  }
}

function labelOf(unit: Unit, start: number): string {
  const c = civil(start);
  switch (unit) {
    case "day":
      return `${c.d} ${WEEKDAYS[c.dow]}`;
    case "week":
      return `${MONTHS[c.m - 1]!.slice(0, 3)} ${c.d}`;
    case "month":
      return MONTHS[c.m - 1]!.slice(0, 3);
    case "quarter":
      return `Q${Math.floor((c.m - 1) / 3) + 1}`;
    case "year":
      return String(c.y);
    case "decade":
      return `${Math.floor(c.y / 10) * 10}s`;
  }
}

function majorLabel(unit: Unit, start: number): string {
  const c = civil(start);
  switch (unit) {
    case "month":
      return `${MONTHS[c.m - 1]} ${c.y}`;
    case "year":
      return String(c.y);
    default:
      return labelOf(unit, start);
  }
}

function periods(unit: Unit, fromDay: number, toDay: number, label: (unit: Unit, start: number) => string): Tick[] {
  const out: Tick[] = [];
  // Hard stop so a bad window can never spin.
  for (let s = periodStart(unit, fromDay), guard = 0; s < toDay && guard < 5000; s = nextPeriod(unit, s), guard++) {
    out.push({ label: label(unit, s), startDay: s, endDay: nextPeriod(unit, s) });
  }
  return out;
}

const MINOR_UNIT: Record<TimelineScale, Unit> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };
const MAJOR_UNIT: Record<TimelineScale, Unit> = { day: "month", week: "month", month: "year", quarter: "year", year: "decade" };

/** The fine tick row (days, weeks, months, quarters, years) overlapping the window. */
export function minorTicks(scale: TimelineScale, a: Pick<Axis, "fromDay" | "toDay">): Tick[] {
  return periods(MINOR_UNIT[scale], a.fromDay, a.toDay, labelOf);
}

/** The coarse tick row above it (months, years, decades). */
export function majorTicks(scale: TimelineScale, a: Pick<Axis, "fromDay" | "toDay">): Tick[] {
  const unit = MAJOR_UNIT[scale];
  return periods(unit, a.fromDay, a.toDay, unit === "month" || unit === "year" ? majorLabel : labelOf);
}

// ---- bars --------------------------------------------------------------------------------------

export interface BarRect {
  x: number;
  width: number;
  milestone: boolean;
}

/** Rectangle of a span: a bar from start to (exclusive) end, or a diamond when it has no end. */
export function barRect(span: Pick<Span, "startMs" | "endMs" | "hasEnd" | "startDateOnly">, a: Axis): BarRect {
  const x = xOfMs(span.startMs, a);
  if (!span.hasEnd) {
    // A date-only milestone sits in the middle of its day.
    const centre = span.startDateOnly ? x + a.pxPerDay / 2 : x;
    return { x: centre - MILESTONE_SIZE / 2, width: MILESTONE_SIZE, milestone: true };
  }
  return { x, width: Math.max(MIN_BAR_WIDTH, xOfMs(span.endMs, a) - x), milestone: false };
}

// ---- dragging ----------------------------------------------------------------------------------

export type DragMode = "move" | "start" | "end";

/** Whole days a horizontal drag of `dx` pixels covers. */
export const dragDays = (dx: number, a: Axis): number => Math.round(dx / a.pxPerDay);

/**
 * The span after dragging by whole days: the whole bar (`move`), its start edge or its end edge.
 * A bar never collapses: edges stop one day (date-only) or 15 minutes (timed) short of each other.
 */
export function dragSpan(span: Span, mode: DragMode, days: number): Span {
  const shift = days * DAY_MS;
  const minLen = span.startDateOnly ? DAY_MS : 15 * 60_000;
  switch (mode) {
    case "move":
      return { ...span, startMs: span.startMs + shift, endMs: span.endMs + shift };
    case "start":
      return span.hasEnd ? { ...span, startMs: Math.min(span.startMs + shift, span.endMs - minLen) } : span;
    case "end":
      return span.hasEnd ? { ...span, endMs: Math.max(span.endMs + shift, span.startMs + minLen) } : span;
  }
}

// ---- lanes -------------------------------------------------------------------------------------

export interface BarInput {
  id: string;
  title: string;
  span: Span;
}

export interface LaneInput<T extends BarInput = BarInput> {
  key: string;
  bars: T[];
}

export interface PlacedBar<T extends BarInput = BarInput> {
  bar: T;
  x: number;
  width: number;
  milestone: boolean;
  /** Row inside the lane. */
  row: number;
  /** Top edge in chart coordinates (below the header). */
  y: number;
}

export interface PlacedLane<T extends BarInput = BarInput> {
  key: string;
  top: number;
  height: number;
  rows: number;
  bars: PlacedBar<T>[];
}

const estimateLabelWidth = (title: string): number => title.length * 6.4 + 10;

/** First-fit row packing for horizontal extents; returns the row of each extent and the row count. */
export function packRows(extents: readonly { left: number; right: number }[], gap = 4): { rows: number[]; count: number } {
  const order = extents.map((_, i) => i).sort((a, b) => extents[a]!.left - extents[b]!.left || extents[a]!.right - extents[b]!.right);
  const ends: number[] = [];
  const rows = new Array<number>(extents.length).fill(0);
  for (const i of order) {
    const e = extents[i]!;
    let r = ends.findIndex((end) => e.left >= end + gap);
    if (r < 0) {
      r = ends.length;
      ends.push(e.right);
    } else ends[r] = e.right;
    rows[i] = r;
  }
  return { rows, count: ends.length };
}

/** Stack lanes vertically; inside a lane, bars that would collide go to separate rows. */
export function layoutLanes<T extends BarInput>(lanes: readonly LaneInput<T>[], a: Axis): PlacedLane<T>[] {
  let top = 0;
  return lanes.map((lane) => {
    const rects = lane.bars.map((b) => barRect(b.span, a));
    // A milestone's title is drawn after the diamond, so it takes that room too.
    const extents = lane.bars.map((b, i) => ({ left: rects[i]!.x, right: rects[i]!.x + rects[i]!.width + (rects[i]!.milestone ? estimateLabelWidth(b.title) : 0) }));
    const packed = packRows(extents);
    const rows = Math.max(1, packed.count);
    const height = rows * ROW_HEIGHT + LANE_PAD * 2;
    const placed: PlacedBar<T>[] = lane.bars.map((bar, i) => ({
      bar,
      x: rects[i]!.x,
      width: rects[i]!.width,
      milestone: rects[i]!.milestone,
      row: packed.rows[i]!,
      y: top + LANE_PAD + packed.rows[i]! * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2,
    }));
    const out: PlacedLane<T> = { key: lane.key, top, height, rows, bars: placed };
    top += height;
    return out;
  });
}

// ---- dependencies ------------------------------------------------------------------------------

export interface DependencyEdge {
  /** The predecessor (arrow starts at its end). */
  fromId: string;
  /** The record that depends on it (arrow ends at its start). */
  toId: string;
  /** The predecessor ends after the successor starts. */
  violated: boolean;
}

/**
 * Edges for a self-link dependency field: each record lists its predecessors. Pairs where either
 * record has no dates (or is not loaded) are skipped. Violated = the predecessor's end is after
 * the successor's start; a date-only end counts through the end of its day, so a successor must
 * start the day after.
 */
export function dependencyEdges(
  records: readonly { id: string; values: Record<string, unknown> }[],
  depFieldId: string,
  spans: ReadonlyMap<string, Span>,
): DependencyEdge[] {
  const out: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const to = spans.get(r.id);
    if (!to) continue;
    const links = r.values[depFieldId];
    if (!Array.isArray(links)) continue;
    for (const l of links) {
      const fromId = typeof l === "string" ? l : l && typeof l === "object" && typeof (l as { id?: unknown }).id === "string" ? (l as { id: string }).id : null;
      if (!fromId || fromId === r.id) continue;
      const from = spans.get(fromId);
      const key = `${fromId}>${r.id}`;
      if (!from || seen.has(key)) continue;
      seen.add(key);
      out.push({ fromId, toId: r.id, violated: from.endMs > to.startMs });
    }
  }
  return out;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * SVG path of an arrow from a predecessor's end to a successor's start: out to the right, down
 * or up to the successor's row, in. When the successor starts before the predecessor ends the
 * path loops around through the gap between the rows.
 */
export function arrowPath(from: Point, to: Point, rowHeight = ROW_HEIGHT, stub = 8): string {
  const gap = to.x - from.x;
  if (gap >= stub * 2) {
    const mid = from.x + Math.min(gap / 2, 14);
    return `M ${from.x} ${from.y} H ${mid} V ${to.y} H ${to.x}`;
  }
  const lane = to.y === from.y ? from.y + rowHeight / 2 : to.y > from.y ? to.y - rowHeight / 2 : to.y + rowHeight / 2;
  return `M ${from.x} ${from.y} H ${from.x + stub} V ${lane} H ${to.x - stub} V ${to.y} H ${to.x}`;
}
