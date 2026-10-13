/**
 * Month layout of a shared calendar: six weeks starting on Sunday, and which records fall on
 * which day. Dates are read as wall time (`views/common/wallTime.ts`): a date-only value never
 * shifts between zones, a timestamp is shown in the field's zone or the viewer's.
 */
import type { TableRecord } from "@/api/types";
import type { DateFields } from "@/views/common/dateFields";
import { DAY_MS, floorDay, recordSpan, wallYmd } from "@/views/common/wallTime";
import { pad2 } from "@/lib/cells/dates";

export interface MonthCursor {
  year: number;
  /** 1-12 */
  month: number;
}

export function cursorOf(ymd: string): MonthCursor {
  return { year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)) };
}

export function shiftMonth(c: MonthCursor, delta: number): MonthCursor {
  const idx = c.year * 12 + (c.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** The 42 days (6 weeks from the Sunday on or before the 1st) shown for a month, as `YYYY-MM-DD`. */
export function monthDays(c: MonthCursor): string[] {
  const first = Date.UTC(c.year, c.month - 1, 1);
  const start = first - new Date(first).getUTCDay() * DAY_MS;
  return Array.from({ length: 42 }, (_, i) => wallYmd(start + i * DAY_MS));
}

export function monthTitle(c: MonthCursor): string {
  return new Date(Date.UTC(c.year, c.month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export interface DayChip {
  id: string;
  title: string;
  /** `HH:MM` on the first day of a record with a time of day. */
  time?: string;
  color?: string;
}

/** Chips per day for records that overlap the shown days. Records without a start date are left out. */
export function chipsByDay(records: readonly TableRecord[], dates: DateFields, zone: string, days: readonly string[], title: (r: TableRecord) => string, colors: Readonly<Record<string, string>>): Map<string, DayChip[]> {
  const shown = new Set(days);
  const out = new Map<string, DayChip[]>();
  for (const r of records) {
    const span = recordSpan(r.values, { id: dates.start.field.id, opts: dates.start.opts }, dates.end && { id: dates.end.field.id, opts: dates.end.opts }, zone);
    if (!span) continue;
    const firstDay = floorDay(span.startMs);
    // The span's end is exclusive; a timed record without an end stays on its own day.
    const lastDay = floorDay(Math.max(span.endMs - 1, span.startMs));
    for (let d = firstDay, n = 0; d <= lastDay && n < 400; d += DAY_MS, n++) {
      const ymd = wallYmd(d);
      if (!shown.has(ymd)) continue;
      const d0 = new Date(span.startMs);
      const chip: DayChip = { id: r.id, title: title(r), color: colors[r.id] };
      if (d === firstDay && !span.startDateOnly) chip.time = `${pad2(d0.getUTCHours())}:${pad2(d0.getUTCMinutes())}`;
      const list = out.get(ymd);
      if (list) list.push(chip);
      else out.set(ymd, [chip]);
    }
  }
  return out;
}
