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

/**
 * Horizontal pixels per day at each scale: roughly a week (day), two weeks (week), six weeks
 * (month), a few months (quarter) and a year (year) across a desktop chart, so each scale's
 * name says what one screen holds.
 */
export const PX_PER_DAY: Record<TimelineScale, number> = { day: 112, week: 56, month: 20, quarter: 7, year: 2.4 };

/** Days shown on each side of the centre when a window is first built (and added per extension). */
const HALF_SPAN_DAYS: Record<TimelineScale, number> = { day: 45, week: 150, month: 400, quarter: 1100, year: 3000 };

export const ROW_HEIGHT = 34;
export const BAR_HEIGHT = 28;
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
      return `${WEEKDAYS[c.dow]} ${c.d}`;
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
    case "week":
      return `Week of ${MONTHS[c.m - 1]!.slice(0, 3)} ${c.d}`;
    case "month":
      return `${MONTHS[c.m - 1]} ${c.y}`;
    case "quarter":
      return `Q${Math.floor((c.m - 1) / 3) + 1} ${c.y}`;
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

const MINOR_UNIT: Record<TimelineScale, Unit> = { day: "day", week: "day", month: "week", quarter: "month", year: "month" };
const MAJOR_UNIT: Record<TimelineScale, Unit> = { day: "week", week: "week", month: "month", quarter: "quarter", year: "year" };

/** The fine tick row (days, weeks or months) overlapping the window. */
export function minorTicks(scale: TimelineScale, a: Pick<Axis, "fromDay" | "toDay">): Tick[] {
  return periods(MINOR_UNIT[scale], a.fromDay, a.toDay, labelOf);
}

/** The coarse tick row above it ("Week of Oct 5", "October 2026", "Q4 2026", "2026"). */
export function majorTicks(scale: TimelineScale, a: Pick<Axis, "fromDay" | "toDay">): Tick[] {
  return periods(MAJOR_UNIT[scale], a.fromDay, a.toDay, majorLabel);
}

/** The fine ticks are single days, so each can be labelled and today's can carry the today pill. */
export const minorIsDay = (scale: TimelineScale): boolean => MINOR_UNIT[scale] === "day";

/** Weekends get a shade where a day is wide enough to see it. */
export const showsWeekends = (scale: TimelineScale): boolean => PX_PER_DAY[scale] >= 14;

/** First days (Saturdays) of the weekends overlapping the window. */
export function weekendStarts(a: Pick<Axis, "fromDay" | "toDay">): number[] {
  const out: number[] = [];
  // Day 0 (1970-01-01) was a Thursday, so Saturdays are the days with (day - 2) % 7 === 0.
  for (let d = a.fromDay - 1 - ((((a.fromDay - 1 - 2) % 7) + 7) % 7); d < a.toDay; d += 7) out.push(d);
  return out;
}

/**
 * The day a chart scrolled to `today` starts at: the beginning of the coarse period that holds the
 * days just before today, so a screen shows a little of what has been done and what comes next
 * (the week scale opens on last week's Monday). Falls back to the period holding today when that
 * would leave today off the screen.
 */
export function windowStart(scale: TimelineScale, today: number, visibleDays: number): number {
  const unit = MAJOR_UNIT[scale];
  const start = periodStart(unit, Math.floor(today - visibleDays / 2));
  return today < start + visibleDays - 1 ? start : periodStart(unit, today);
}

/** "Oct 5 – 18, 2026", "Sep 28 – Oct 11, 2026", "Dec 28, 2026 – Jan 10, 2027": the days a screen shows. */
export function rangeTitle(fromDay: number, lastDay: number): string {
  const a = civil(fromDay);
  const b = civil(lastDay);
  const mon = (m: number) => MONTHS[m - 1]!.slice(0, 3);
  if (a.y !== b.y) return `${mon(a.m)} ${a.d}, ${a.y} – ${mon(b.m)} ${b.d}, ${b.y}`;
  if (a.m !== b.m) return `${mon(a.m)} ${a.d} – ${mon(b.m)} ${b.d}, ${b.y}`;
  return a.d === b.d ? `${mon(a.m)} ${a.d}, ${a.y}` : `${mon(a.m)} ${a.d} – ${b.d}, ${b.y}`;
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
