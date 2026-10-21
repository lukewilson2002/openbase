import { describe, expect, it } from "vitest";
import type { Field } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { dateClickValues, eventWrites, recordsToEvents, resolveCalendarFields, unscheduledRecords, unscheduledTransient, visibleRange, type EventContext } from "./eventMath";

const name = ALL_FIELDS.text!;
const day = (id: string): Field => field("date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }, { id, name: id });
const timed = (id: string, timezone: string | null = null): Field => field("date", { include_time: true, date_format: "iso", time_format: "h24", timezone }, { id, name: id });

function ctx(fields: Field[], startId: string, endId: string | null, over: Partial<EventContext> = {}): EventContext {
  return { fields: resolveCalendarFields(fields, startId, endId)!, primary: name, format: { ...DEFAULT_CTX, timeZone: "UTC" }, colors: {}, canEdit: true, ...over };
}

describe("resolveCalendarFields", () => {
  it("needs a date-like start field; ignores a missing or identical end field", () => {
    const fs = [name, day("d"), day("e")];
    expect(resolveCalendarFields(fs, null, null)).toBeNull();
    expect(resolveCalendarFields(fs, name.id, null)).toBeNull();
    expect(resolveCalendarFields(fs, "d", "d")!.end).toBeNull();
    expect(resolveCalendarFields(fs, "d", "e")!.end?.field.id).toBe("e");
    expect(resolveCalendarFields(fs, "d", "nope")!.end).toBeNull();
  });
});

describe("recordsToEvents", () => {
  it("maps date-only records to all-day events and multi-day ranges to an exclusive end", () => {
    const c = ctx([name, day("d"), day("e")], "d", "e", { colors: { r2: "blue" } });
    const events = recordsToEvents(
      [
        makeRecord({ [name.id]: "Single", d: "2026-03-05" }, "r1"),
        makeRecord({ [name.id]: "Range", d: "2026-03-05", e: "2026-03-07" }, "r2"),
        makeRecord({ [name.id]: "Nope" }, "r3"),
      ],
      c,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: "r1", title: "Single", start: "2026-03-05", allDay: true, startEditable: true, durationEditable: true });
    expect(events[0]!.end).toBeUndefined();
    expect(events[1]).toMatchObject({ id: "r2", start: "2026-03-05", end: "2026-03-08", allDay: true, extendedProps: { recordId: "r2", color: "blue" } });
    expect(events[1]!.extendedProps.recordId).toBe("r2");
  });

  it("places timed records at their wall time in the field's zone", () => {
    const c = ctx([name, timed("t", "America/New_York")], "t", null);
    const [ev] = recordsToEvents([makeRecord({ [name.id]: "Call", t: "2026-07-01T18:30:00.000Z" }, "r1")], c);
    expect(ev).toMatchObject({ allDay: false, start: "2026-07-01T14:30:00" });
    expect(ev!.durationEditable).toBe(false); // no end field to resize
  });

  it("is read-only for viewers and for computed date fields", () => {
    const fs = [name, day("d")];
    expect(recordsToEvents([makeRecord({ d: "2026-03-05" })], ctx(fs, "d", null, { canEdit: false }))[0]).toMatchObject({ startEditable: false, durationEditable: false });
    const created: Field = ALL_FIELDS.created_time!;
    const c = ctx([name, created], created.id, null);
    expect(recordsToEvents([makeRecord({ [created.id]: "2026-03-05T10:00:00.000Z" })], c)[0]!.startEditable).toBe(false);
  });

  it("lists records without a start as unscheduled", () => {
    const c = ctx([name, day("d")], "d", null);
    const recs = [makeRecord({ d: "2026-03-05" }, "r1"), makeRecord({}, "r2"), makeRecord({ d: "garbage" }, "r3")];
    expect(unscheduledRecords(recs, c.fields, "UTC").map((r) => r.id)).toEqual(["r2", "r3"]);
  });
});

describe("eventWrites", () => {
  const D = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

  it("writes a moved all-day event, turning the exclusive end into the last day", () => {
    const c = ctx([name, day("d"), day("e")], "d", "e");
    expect(eventWrites({ startMs: D(2026, 3, 10), endMs: D(2026, 3, 13), allDay: true }, c.fields, "UTC")).toEqual({ d: "2026-03-10", e: "2026-03-12" });
  });

  it("does not write an end the record never had", () => {
    const c = ctx([name, day("d"), day("e")], "d", "e");
    expect(eventWrites({ startMs: D(2026, 3, 10), endMs: null, allDay: true }, c.fields, "UTC")).toEqual({ d: "2026-03-10" });
  });

  it("maps timed events back through the field zone and keeps the end after the start", () => {
    const c = ctx([name, timed("s", "America/New_York"), timed("e", "America/New_York")], "s", "e");
    expect(eventWrites({ startMs: D(2026, 7, 1, 14, 30), endMs: D(2026, 7, 1, 16, 0), allDay: false }, c.fields, "UTC")).toEqual({ s: "2026-07-01T18:30:00.000Z", e: "2026-07-01T20:00:00.000Z" });
  });

  it("floors a timed start dropped onto an all-day slot to midnight, and clamps a date-only end", () => {
    const c = ctx([name, timed("s"), day("e")], "s", "e");
    expect(eventWrites({ startMs: D(2026, 7, 1, 13), endMs: D(2026, 7, 1, 13), allDay: true }, c.fields, "UTC")).toEqual({ s: "2026-07-01T00:00:00.000Z", e: "2026-07-01" });
  });
});

describe("dateClickValues and visibleRange", () => {
  it("starts a day-click on a timed field at 09:00 and a date field at the day", () => {
    const timedCtx = ctx([name, timed("t", "Asia/Tokyo")], "t", null);
    expect(dateClickValues(Date.UTC(2026, 6, 1), true, timedCtx.fields, "UTC")).toEqual({ t: "2026-07-01T00:00:00.000Z" }); // 09:00 JST
    expect(dateClickValues(Date.UTC(2026, 6, 1, 15), false, timedCtx.fields, "UTC")).toEqual({ t: "2026-07-01T06:00:00.000Z" });
    const dayCtx = ctx([name, day("d")], "d", null);
    expect(dateClickValues(Date.UTC(2026, 6, 1), true, dayCtx.fields, "UTC")).toEqual({ d: "2026-07-01" });
  });

  it("turns FullCalendar's exclusive range into padded inclusive bounds", () => {
    expect(visibleRange(Date.UTC(2026, 1, 23), Date.UTC(2026, 3, 6))).toEqual({ from: "2026-02-22", to: "2026-04-06" });
  });
});

describe("unscheduledTransient", () => {
  const empty = { field_id: "d", op: "is_empty", value: null };
  const cond = { field_id: "s", op: "is", value: "x" } as const;

  it("is just 'start is empty' when the view has no filter", () => {
    expect(unscheduledTransient(null, "d")).toEqual({ filter: { conjunction: "and", items: [empty] } });
    expect(unscheduledTransient({ conjunction: "or", items: [] }, "d")).toEqual({ filter: { conjunction: "and", items: [empty] } });
  });

  it("appends to a saved AND filter instead of nesting it", () => {
    expect(unscheduledTransient({ conjunction: "and", items: [cond] }, "d")).toEqual({ filter: { conjunction: "and", items: [cond, empty] } });
  });

  it("nests a saved OR filter so its meaning survives", () => {
    const or = { conjunction: "or" as const, items: [cond, { field_id: "s", op: "is" as const, value: "y" }] };
    expect(unscheduledTransient(or, "d")).toEqual({ filter: { conjunction: "and", items: [or, empty] } });
  });
});
