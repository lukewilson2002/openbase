/**
 * Pure calendar logic: records -> FullCalendar events, FullCalendar drags -> field values.
 *
 * FullCalendar runs with `timeZone: "UTC"` and is fed wall times (see ../common/wallTime.ts), so
 * what it reports back after a drag is again a wall time that maps to stored values through the
 * date fields' own options and zones, whatever zone the browser is in.
 */
import type { Field, Filter, TableRecord, TransientConfig } from "@/api/types";
import { cardTitle, fieldsToShow } from "../common/cardFields";
import { resolveDateFields, type DateFields } from "../common/dateFields";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { displayShapeOf } from "@/lib/cells/kinds";
import { DAY_MS, floorDay, isWritableDate, padRange, recordSpan, wallIso, wallToStored, wallYmd, type Span } from "../common/wallTime";

export type CalendarFields = DateFields;

/** Resolve the configured date fields; null until the start field is set to a usable field. */
export const resolveCalendarFields = resolveDateFields;

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  startEditable: boolean;
  durationEditable: boolean;
  /**
   * `color` is the record's palette colour; the calendar draws the chip in it. `sortIndex` is the
   * record's place in the view's own order (its sort), `details` the values of the visible fields
   * the chip shows under the title.
   */
  extendedProps: { recordId: string; sortIndex: number; color?: string; details?: string[] };
}

export interface EventContext {
  fields: CalendarFields;
  primary: Field | undefined;
  format: FormatCtx;
  colors: Readonly<Record<string, string>>;
  /** The viewer may edit records. */
  canEdit: boolean;
  /** The visible fields a chip may show under its title (see `chipDetails`); none by default. */
  chipFields?: readonly Field[];
}

/** Most field values a chip shows under its title. */
export const CHIP_DETAIL_LIMIT = 2;

/** Values of the first non-empty chip fields as text: what an event chip shows besides its title. */
export function chipDetails(record: TableRecord, fields: readonly Field[], format: FormatCtx, limit = CHIP_DETAIL_LIMIT): string[] {
  const out: string[] = [];
  for (const f of fieldsToShow(fields.filter((x) => displayShapeOf(x) !== "attachment"), record, format, limit + 4)) {
    const text = displayText(f, record.values[f.id], format).replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The exclusive end FullCalendar draws for a span. An all-day event takes whole days: a timed end
 * (a date start with a date-time end) runs through the day it falls on, unless it is exactly midnight.
 */
function eventEnd(span: Span): string {
  if (!span.startDateOnly) return wallIso(span.endMs);
  return wallYmd(span.endMs % DAY_MS === 0 ? span.endMs : floorDay(span.endMs) + DAY_MS);
}

/** Records with a start date become events; the rest are "unscheduled". */
export function recordsToEvents(records: readonly TableRecord[], ctx: EventContext): CalendarEvent[] {
  const { fields } = ctx;
  const startWritable = ctx.canEdit && isWritableDate(fields.start.field);
  const endWritable = !fields.end || isWritableDate(fields.end.field);
  const events: CalendarEvent[] = [];
  records.forEach((r, sortIndex) => {
    const span = recordSpan(r.values, { id: fields.start.field.id, opts: fields.start.opts }, fields.end && { id: fields.end.field.id, opts: fields.end.opts }, ctx.format.timeZone);
    if (!span) return;
    const ev: CalendarEvent = {
      id: r.id,
      title: cardTitle(ctx.primary, r, ctx.format),
      allDay: span.startDateOnly,
      start: span.startDateOnly ? wallYmd(span.startMs) : wallIso(span.startMs),
      // Resizing sets the end field; it needs one that can be written.
      startEditable: startWritable && endWritable,
      durationEditable: startWritable && !!fields.end && endWritable,
      extendedProps: { recordId: r.id, sortIndex },
    };
    if (span.hasEnd) ev.end = eventEnd(span);
    const color = ctx.colors[r.id];
    if (color) ev.extendedProps.color = color;
    const details = ctx.chipFields ? chipDetails(r, ctx.chipFields, ctx.format) : [];
    if (details.length > 0) ev.extendedProps.details = details;
    events.push(ev);
  });
  return events;
}

/**
 * The record ids in the order the calendar reads them: day by day, within a day by the view's sort
 * (else by start time), then the unscheduled ones. The record panel's previous and next walk this.
 */
export function readingOrder(events: readonly CalendarEvent[], sorted: boolean, unscheduledIds: readonly string[] = []): string[] {
  const day = (e: CalendarEvent) => e.start.slice(0, 10);
  const compare = (a: CalendarEvent, b: CalendarEvent) => {
    if (day(a) !== day(b)) return day(a) < day(b) ? -1 : 1;
    if (!sorted && a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.extendedProps.sortIndex - b.extendedProps.sortIndex;
  };
  const ordered = [...events].sort(compare).map((e) => e.extendedProps.recordId);
  return [...ordered, ...unscheduledIds];
}

/** Records the calendar cannot place: no start date. */
export function unscheduledRecords(records: readonly TableRecord[], fields: CalendarFields, zone: string): TableRecord[] {
  return records.filter((r) => recordSpan(r.values, { id: fields.start.field.id, opts: fields.start.opts }, null, zone) === null);
}

/**
 * The one-off override that makes the view query answer "records without a start date": the
 * saved filter AND the start field is empty. A transient filter replaces the saved one, so the
 * saved conditions are carried over (a saved AND group is flattened, anything else nests as a
 * group) and the view's own filter still applies to the unscheduled list.
 */
export function unscheduledTransient(saved: Filter | null | undefined, startFieldId: string): TransientConfig {
  const empty = { field_id: startFieldId, op: "is_empty" as const, value: null };
  const items = saved?.items ?? [];
  if (items.length === 0) return { filter: { conjunction: "and", items: [empty] } };
  if (saved!.conjunction === "and") return { filter: { conjunction: "and", items: [...items, empty] } };
  return { filter: { conjunction: "and", items: [saved!, empty] } };
}

/** A record's span as the calendar draws it, and whether it also holds an end that the span ignores. */
export interface EventSpan extends Span {
  /** The end field holds a value, but not one after the start: the span has no end. */
  endUnusable: boolean;
}

/** The span a record occupies in the calendar, or null when it has no start date. */
export function recordEventSpan(record: TableRecord, fields: CalendarFields, zone: string): EventSpan | null {
  const start = { id: fields.start.field.id, opts: fields.start.opts };
  const end = fields.end && { id: fields.end.field.id, opts: fields.end.opts };
  const span = recordSpan(record.values, start, end, zone);
  if (!span) return null;
  const stored = fields.end ? record.values[fields.end.field.id] : null;
  return { ...span, endUnusable: !span.hasEnd && stored !== null && stored !== undefined && stored !== "" };
}

export interface EventTimes {
  /** Wall time of the (new) start. */
  startMs: number;
  /** Exclusive wall end reported by FullCalendar, if the event has one. */
  endMs: number | null;
  allDay: boolean;
  /** Dragged whole (the default) or resized. */
  change?: "move" | "resize";
  /**
   * The record's span before the change. With it a moved event keeps its stored end where FullCalendar's
   * drawn end cannot say: a date-only end shifts by the days the start moved, a timed end keeps its time
   * of day. Without it the end is read off the drawn event.
   */
  before?: EventSpan | null;
}

/** Wall-clock milliseconds past midnight. */
const timeOfDay = (ms: number) => ms - floorDay(ms);
/** What a timed end is given when an all-day event is stretched and the record had none: the end of the day. */
const END_OF_DAY_MS = DAY_MS - 60_000;

/**
 * Field values for a moved or resized event. The end field is only written when the calendar
 * has one and the event carries an end (or the record had none and the drag does not add it).
 *
 * FullCalendar's end is exclusive and follows the event's start: a date start draws whole days, a
 * date-time start draws to the minute. The end field may be of the other kind, so the stored end is
 * not simply the drawn one: a date-only end is inclusive (the last day), and a timed end of an
 * all-day event keeps the time of day it had.
 */
export function eventWrites(times: EventTimes, fields: CalendarFields, zone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const { start, end } = fields;
  const { before } = times;
  // A timed field dropped on an all-day slot starts at midnight.
  const startMs = times.allDay ? floorDay(times.startMs) : times.startMs;
  out[start.field.id] = wallToStored(startMs, start.opts, zone);
  if (!end) return out;
  if (times.endMs === null) {
    // The record has no end after its start: moving it takes along an end that sits before it (or on it).
    if (before?.endUnusable && times.change !== "resize") out[end.field.id] = wallToStored(end.opts.include_time ? startMs : floorDay(startMs), end.opts, zone);
    return out;
  }
  const drawnEnd = times.endMs;
  const moved = times.change !== "resize" && before?.hasEnd && before.startDateOnly === times.allDay;
  let endMs: number;
  if (!end.opts.include_time) {
    // The last day. A moved event shifts it by the days its start moved (a nudge of an hour changes nothing);
    // a resized one ends on the day its drawn end reaches into.
    if (moved) endMs = before.endMs - DAY_MS + (floorDay(startMs) - floorDay(before.startMs));
    else endMs = times.allDay || drawnEnd % DAY_MS === 0 ? drawnEnd - DAY_MS : floorDay(drawnEnd);
    endMs = Math.max(endMs, floorDay(startMs));
  } else if (moved) {
    endMs = before.endMs + (startMs - before.startMs);
  } else if (times.allDay) {
    // An all-day event stretched over a timed end field: the last drawn day, at the end's own time of day.
    const tod = before?.hasEnd ? timeOfDay(before.endMs) : END_OF_DAY_MS;
    endMs = tod === 0 ? drawnEnd : floorDay(drawnEnd - 1) + tod;
  } else {
    endMs = drawnEnd;
  }
  if (end.opts.include_time) endMs = Math.max(endMs, startMs);
  out[end.field.id] = wallToStored(endMs, end.opts, zone);
  return out;
}

/** The values that take a record off the calendar: its dates cleared (the end only when it can be written). */
export function unscheduleValues(fields: CalendarFields): Record<string, null> {
  const values: Record<string, null> = { [fields.start.field.id]: null };
  if (fields.end && isWritableDate(fields.end.field)) values[fields.end.field.id] = null;
  return values;
}

/**
 * The day the toolbar's Add creates a record on: today while it is on screen, else the first day of the
 * period shown (the 1st of a month, the first day of a week), so Add never lands out of sight.
 */
export function addDay(todayMs: number, periodStartMs: number, periodEndMs: number): number {
  const today = floorDay(todayMs);
  return today >= periodStartMs && today < periodEndMs ? today : periodStartMs;
}

/** Start value for a record created by clicking a day (or time slot). */
export function dateClickValues(wallMs: number, allDay: boolean, fields: CalendarFields, zone: string): Record<string, string> {
  // A bare day on a field that has times opens the working day instead of midnight.
  const ms = allDay && fields.start.opts.include_time ? floorDay(wallMs) + 9 * 60 * 60 * 1000 : wallMs;
  return { [fields.start.field.id]: wallToStored(ms, fields.start.opts, zone) };
}

/** `DateRange` bounds from a FullCalendar visible range (UTC midnights, end exclusive), padded a day. */
export function visibleRange(startMs: number, endMs: number): { from: string; to: string } | null {
  return padRange(wallYmd(startMs), wallYmd(endMs - DAY_MS), 1);
}
