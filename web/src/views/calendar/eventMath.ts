/**
 * Pure calendar logic: records -> FullCalendar events, FullCalendar drags -> field values.
 *
 * FullCalendar runs with `timeZone: "UTC"` and is fed wall times (see ../common/wallTime.ts), so
 * what it reports back after a drag is again a wall time that maps to stored values through the
 * date fields' own options and zones, whatever zone the browser is in.
 */
import type { Field, Filter, TableRecord, TransientConfig } from "@/api/types";
import { cardTitle } from "../common/cardFields";
import { resolveDateFields, type DateFields } from "../common/dateFields";
import type { FormatCtx } from "@/lib/cells/format";
import { paletteColor } from "@/lib/cells/palette";
import { DAY_MS, floorDay, isWritableDate, padRange, recordSpan, wallIso, wallToStored, wallYmd } from "../common/wallTime";

export type CalendarFields = DateFields;

/** Resolve the configured date fields; null until the start field is set to a usable field. */
export const resolveCalendarFields = resolveDateFields;

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  backgroundColor?: string;
  borderColor?: string;
  textColor?: string;
  startEditable: boolean;
  durationEditable: boolean;
  extendedProps: { recordId: string };
}

export interface EventContext {
  fields: CalendarFields;
  primary: Field | undefined;
  format: FormatCtx;
  colors: Readonly<Record<string, string>>;
  /** The viewer may edit records. */
  canEdit: boolean;
}

/** Records with a start date become events; the rest are "unscheduled". */
export function recordsToEvents(records: readonly TableRecord[], ctx: EventContext): CalendarEvent[] {
  const { fields } = ctx;
  const startWritable = ctx.canEdit && isWritableDate(fields.start.field);
  const endWritable = !fields.end || isWritableDate(fields.end.field);
  const events: CalendarEvent[] = [];
  for (const r of records) {
    const span = recordSpan(r.values, { id: fields.start.field.id, opts: fields.start.opts }, fields.end && { id: fields.end.field.id, opts: fields.end.opts }, ctx.format.timeZone);
    if (!span) continue;
    const ev: CalendarEvent = {
      id: r.id,
      title: cardTitle(ctx.primary, r, ctx.format),
      allDay: span.startDateOnly,
      start: span.startDateOnly ? wallYmd(span.startMs) : wallIso(span.startMs),
      // Resizing sets the end field; it needs one that can be written.
      startEditable: startWritable && endWritable,
      durationEditable: startWritable && !!fields.end && endWritable,
      extendedProps: { recordId: r.id },
    };
    if (span.hasEnd) ev.end = span.startDateOnly ? wallYmd(span.endMs) : wallIso(span.endMs);
    const color = ctx.colors[r.id];
    if (color) {
      const p = paletteColor(color);
      ev.backgroundColor = p.bg;
      ev.borderColor = p.bg;
      ev.textColor = p.fg;
    }
    events.push(ev);
  }
  return events;
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

export interface EventTimes {
  /** Wall time of the (new) start. */
  startMs: number;
  /** Exclusive wall end reported by FullCalendar, if the event has one. */
  endMs: number | null;
  allDay: boolean;
}

/**
 * Field values for a moved or resized event. The end field is only written when the calendar
 * has one and the event carries an end (or the record had none and the drag does not add it).
 */
export function eventWrites(times: EventTimes, fields: CalendarFields, zone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const { start, end } = fields;
  // A timed field dropped on an all-day slot starts at midnight.
  const startMs = times.allDay ? floorDay(times.startMs) : times.startMs;
  out[start.field.id] = wallToStored(startMs, start.opts, zone);
  if (end && times.endMs !== null) {
    let endMs = times.endMs;
    // FullCalendar's all-day end is exclusive; a date-only end field stores the last day.
    if (end.opts.include_time) {
      out[end.field.id] = wallToStored(endMs, end.opts, zone);
    } else {
      if (times.allDay || endMs % DAY_MS === 0) endMs -= DAY_MS;
      endMs = Math.max(endMs, floorDay(startMs));
      out[end.field.id] = wallToStored(endMs, end.opts, zone);
    }
  }
  return out;
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
