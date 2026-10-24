/**
 * Swimlanes and date writes for the timeline: grouping records into lanes (by the view's group
 * headers or client-side by the timeline's group field), and the field values a drag or a
 * create-by-dragging produces.
 */
import type { DateOptions, Field, GroupHeader, TableRecord } from "@/api/types";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { kindClassOf, linkRefs, selectChoicesOf, stringItems } from "@/lib/cells/kinds";
import type { DateFields } from "../common/dateFields";
import { DAY_MS, isWritableDate, readWall, recordSpan, wallToStored, wallYmd, type Span } from "../common/wallTime";
import type { DragMode, TimelineSpan } from "./geometry";

export interface Lane {
  key: string;
  label: string;
  /** Palette colour (single select lanes). */
  color?: string;
  /** Cell value (view form) that puts a new record in this lane; undefined when it cannot be set. */
  value?: unknown;
  /** The field this lane groups by, when it groups. */
  fieldId?: string;
  records: TableRecord[];
}

const EMPTY_LABEL = "(Empty)";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Lane identity and label of one record for a group field. */
function laneOf(field: Field, record: TableRecord, ctx: FormatCtx): { key: string; label: string; color?: string; value?: unknown } {
  const v = record.values[field.id];
  const kind = kindClassOf(field);
  switch (kind) {
    case "select":
    case "multi_select": {
      const id = stringItems(v)[0];
      const choice = id ? selectChoicesOf(field).find((c) => c.id === id) : undefined;
      return choice ? { key: choice.id, label: choice.name, color: choice.color, value: kind === "select" ? choice.id : [choice.id] } : { key: "", label: EMPTY_LABEL, value: null };
    }
    case "user":
    case "user_multi": {
      const id = stringItems(v)[0];
      return id ? { key: id, label: ctx.userName(id) ?? id, value: [id] } : { key: "", label: EMPTY_LABEL, value: null };
    }
    case "link": {
      const ref = linkRefs(v)[0];
      return ref ? { key: ref.id, label: ref.name || ref.id, value: [ref] } : { key: "", label: EMPTY_LABEL, value: null };
    }
    case "bool":
      return v === true ? { key: "true", label: "Checked", value: true } : { key: "false", label: "Unchecked", value: null };
    default: {
      const text = displayText(field, v, ctx).trim();
      // Text, numbers and dates can be written back as-is; computed fields cannot.
      return text ? { key: text, label: text, value: field.type === "formula" || field.type === "lookup" || field.type === "rollup" ? undefined : v } : { key: "", label: EMPTY_LABEL, value: null };
    }
  }
}

/** Lane display order: choices in choice order, others by label, "(Empty)" last. */
function compareLanes(field: Field, a: Lane, b: Lane): number {
  if (a.key === "" || b.key === "") return a.key === b.key ? 0 : a.key === "" ? 1 : -1;
  const choices = selectChoicesOf(field);
  if (choices.length > 0) return choices.findIndex((c) => c.id === a.key) - choices.findIndex((c) => c.id === b.key);
  if (field.type === "checkbox") return a.key === "false" ? -1 : 1;
  return collator.compare(a.label, b.label);
}

/** Group records into lanes by a field, client-side. Records keep their order inside a lane. */
export function groupIntoLanes(records: readonly TableRecord[], field: Field, ctx: FormatCtx): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const r of records) {
    const l = laneOf(field, r, ctx);
    let lane = lanes.get(l.key);
    if (!lane) {
      lane = { key: l.key, label: l.label, color: l.color, value: l.value, fieldId: field.id, records: [] };
      lanes.set(l.key, lane);
    }
    lane.records.push(r);
  }
  // Select lanes show every choice, even without records, so a record can be dragged into them.
  for (const c of selectChoicesOf(field)) {
    if (!lanes.has(c.id)) lanes.set(c.id, { key: c.id, label: c.name, color: c.color, value: field.type === "single_select" ? c.id : [c.id], fieldId: field.id, records: [] });
  }
  return [...lanes.values()].sort((a, b) => compareLanes(field, a, b));
}

/** Lanes from the first level of the view's own grouping (`QueryResponse.groups`). */
export function lanesFromGroups(records: readonly TableRecord[], groups: readonly GroupHeader[]): Lane[] {
  return groups
    .filter((g) => g.depth === 0)
    .map((g) => ({ key: g.key, label: g.label, value: g.value ?? undefined, fieldId: g.field_id, records: records.slice(g.start, g.start + g.count) }));
}

export const NO_LANE: Lane = { key: "", label: "", records: [] };

// ---- date writes -------------------------------------------------------------------------------

export type TimelineDateFields = DateFields;

/** Stored value for an exclusive wall end, respecting a date-only end's inclusive last day. */
function storeEnd(endExclusiveMs: number, end: { opts: DateOptions }, zone: string): string {
  return end.opts.include_time ? wallToStored(endExclusiveMs, end.opts, zone) : wallToStored(Math.floor((endExclusiveMs - 1) / DAY_MS) * DAY_MS, end.opts, zone);
}

/**
 * The span a record occupies on the timeline: its start and end; a milestone when it has only a
 * start, or its end is not after the start (`reversed`); a milestone on the end day when it has
 * only an end (`endOnly`). Null when it has neither.
 */
export function timelineSpan(values: Record<string, unknown>, fields: TimelineDateFields, zone: string): TimelineSpan | null {
  const start = { id: fields.start.field.id, opts: fields.start.opts };
  const end = fields.end && { id: fields.end.field.id, opts: fields.end.opts };
  const span = recordSpan(values, start, end, zone);
  if (!span) {
    const e = end && readWall(values[end.id], end.opts, zone);
    return e ? { startMs: e.ms, endMs: e.dateOnly ? e.ms + DAY_MS : e.ms, startDateOnly: e.dateOnly, hasEnd: false, endOnly: true } : null;
  }
  if (span.hasEnd || !end) return span;
  const e = readWall(values[end.id], end.opts, zone);
  // An end before the start: a timed end equal to the start is just an event of no length.
  return e && (e.dateOnly ? e.ms + DAY_MS : e.ms) < span.startMs ? { ...span, reversed: true } : span;
}

/** Field values to write after a drag: only the dates the drag actually changed, and only those that can be written. */
export function dragWrites(before: TimelineSpan, after: Span, mode: DragMode, fields: TimelineDateFields, zone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const end = fields.end && isWritableDate(fields.end.field) ? fields.end : null;
  // A milestone on an end alone moves that end.
  if (before.endOnly) {
    if (end && mode === "move" && after.startMs !== before.startMs) out[end.field.id] = wallToStored(after.startMs, end.opts, zone);
    return out;
  }
  if (isWritableDate(fields.start.field) && (mode === "move" || mode === "start") && after.startMs !== before.startMs) out[fields.start.field.id] = wallToStored(after.startMs, fields.start.opts, zone);
  if (end && (mode === "move" || mode === "end")) {
    // A milestone only gets an end from its end edge (and a reversed one is repaired by it, even undragged).
    const grows = mode === "end" && !before.hasEnd && (after.endMs !== before.endMs || !!before.reversed);
    if (grows || (before.hasEnd && after.endMs !== before.endMs)) out[end.field.id] = storeEnd(after.endMs, end, zone);
  }
  return out;
}

const endOfDay = (day: number, end: { opts: DateOptions }) => (end.opts.include_time ? day * DAY_MS + 17 * 3_600_000 : day * DAY_MS);

/** Values for a record created by dragging across `fromDay..toDay` (day numbers, either order). An end that cannot be written is left out. */
export function createWrites(fromDay: number, toDay: number, fields: TimelineDateFields, zone: string): Record<string, string> {
  const first = Math.min(fromDay, toDay);
  const last = Math.max(fromDay, toDay);
  const startMs = first * DAY_MS + (fields.start.opts.include_time ? 9 * 3_600_000 : 0);
  const out: Record<string, string> = { [fields.start.field.id]: wallToStored(startMs, fields.start.opts, zone) };
  if (fields.end && isWritableDate(fields.end.field)) out[fields.end.field.id] = wallToStored(endOfDay(last, fields.end), fields.end.opts, zone);
  return out;
}

/**
 * Values for a record dragged in from the unscheduled column onto `day`: its start. An end it
 * already has is kept when it is not before the new start; else (or when it has none) the end is
 * that same day.
 */
export function dropWrites(day: number, current: Record<string, unknown>, fields: TimelineDateFields, zone: string): Record<string, string> {
  const out = createWrites(day, day, fields, zone);
  const end = fields.end;
  if (!end || !isWritableDate(end.field)) return out;
  const startMs = day * DAY_MS + (fields.start.opts.include_time ? 9 * 3_600_000 : 0);
  const e = readWall(current[end.field.id], end.opts, zone);
  if (e && (e.dateOnly ? e.ms + DAY_MS : e.ms) > startMs) delete out[end.field.id];
  return out;
}

/** "Mar 3 – Mar 8" label shown on a bar while it is dragged. */
export function spanLabel(span: Span): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
  };
  if (!span.hasEnd) return fmt(span.startMs);
  const lastDay = span.startDateOnly ? span.endMs - DAY_MS : span.endMs;
  return wallYmd(span.startMs) === wallYmd(lastDay) ? fmt(span.startMs) : `${fmt(span.startMs)} – ${fmt(lastDay)}`;
}
