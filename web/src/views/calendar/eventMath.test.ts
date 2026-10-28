import { describe, expect, it } from "vitest";
import type { Field } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { addDay, chipDetails, dateClickValues, eventWrites, readingOrder, recordEventSpan, recordsToEvents, resolveCalendarFields, unscheduleValues, unscheduledRecords, unscheduledTransient, visibleRange, type EventContext, type EventTimes } from "./eventMath";

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

  it("draws a date start with a timed end through the day the end falls on", () => {
    const c = ctx([name, day("d"), timed("e")], "d", "e");
    const ev = (end: string) => recordsToEvents([makeRecord({ d: "2026-03-10", e: end }, "r1")], c)[0]!;
    expect(ev("2026-03-12T15:00:00.000Z")).toMatchObject({ start: "2026-03-10", end: "2026-03-13", allDay: true });
    // An end at midnight stops at the end of the day before.
    expect(ev("2026-03-12T00:00:00.000Z").end).toBe("2026-03-12");
  });

  it("numbers events by their place in the view's order and carries the visible fields for the chip", () => {
    const status = ALL_FIELDS.number!;
    const c = ctx([name, status, day("d")], "d", null, { chipFields: [status] });
    const events = recordsToEvents(
      [makeRecord({ [name.id]: "Zed", d: "2026-03-05", [status.id]: 7 }, "r1"), makeRecord({ [name.id]: "Skipped" }, "r2"), makeRecord({ [name.id]: "Alpha", d: "2026-03-05" }, "r3")],
      c,
    );
    expect(events.map((e) => [e.id, e.extendedProps.sortIndex])).toEqual([["r1", 0], ["r3", 2]]);
    expect(events[0]!.extendedProps.details).toEqual(["7.00"]);
    expect(events[1]!.extendedProps.details).toBeUndefined();
  });

  it("shows at most two non-empty field values on a chip", () => {
    const a = field("number", { precision: 0, allow_negative: true }, { id: "a", name: "A" });
    const b = field("number", { precision: 0, allow_negative: true }, { id: "b", name: "B" });
    const c = field("number", { precision: 0, allow_negative: true }, { id: "c", name: "C" });
    const d = field("number", { precision: 0, allow_negative: true }, { id: "d", name: "D" });
    const format = { ...DEFAULT_CTX, timeZone: "UTC" };
    expect(chipDetails(makeRecord({ a: null, b: 2, c: 3, d: 4 }), [a, b, c, d], format)).toEqual(["2", "3"]);
    expect(chipDetails(makeRecord({}), [a, b], format)).toEqual([]);
  });

  it("reads events day by day, by sort within a day (else by time), unscheduled last", () => {
    const c = ctx([name, timed("t")], "t", null);
    const events = recordsToEvents(
      [
        makeRecord({ t: "2026-03-05T15:00:00.000Z" }, "late"),
        makeRecord({ t: "2026-03-06T08:00:00.000Z" }, "next-day"),
        makeRecord({ t: "2026-03-05T09:00:00.000Z" }, "early"),
      ],
      c,
    );
    expect(readingOrder(events, true, ["u1"])).toEqual(["late", "early", "next-day", "u1"]);
    expect(readingOrder(events, false)).toEqual(["early", "late", "next-day"]);
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

describe("eventWrites with a start and an end of different kinds", () => {
  const D = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
  /** A timed start with a date-only end, and the other way round. */
  const timedStart = ctx([name, timed("s"), day("e")], "s", "e");
  const dayStart = ctx([name, day("s"), timed("e")], "s", "e");
  const before = (c: ReturnType<typeof ctx>, values: Record<string, unknown>) => recordEventSpan(makeRecord(values), c.fields, "UTC");
  const write = (c: ReturnType<typeof ctx>, times: EventTimes) => eventWrites(times, c.fields, "UTC");

  const record = { s: "2026-03-10T10:00:00.000Z", e: "2026-03-12" };

  it("keeps the last day when a timed event with a date-only end is nudged an hour (the end does not gain a day)", () => {
    // Drawn 10:00 Mar 10 to Mar 13 00:00; one hour later FullCalendar reports Mar 13 01:00.
    const out = write(timedStart, { startMs: D(2026, 3, 10, 11), endMs: D(2026, 3, 13, 1), allDay: false, change: "move", before: before(timedStart, record) });
    expect(out).toEqual({ s: "2026-03-10T11:00:00.000Z", e: "2026-03-12" });
  });

  it("moves the last day with the days the start moved", () => {
    const b = before(timedStart, record);
    expect(write(timedStart, { startMs: D(2026, 3, 11, 10), endMs: D(2026, 3, 14), allDay: false, change: "move", before: b })).toEqual({ s: "2026-03-11T10:00:00.000Z", e: "2026-03-13" });
    // Fifteen hours later is the next day at 01:00.
    expect(write(timedStart, { startMs: D(2026, 3, 11, 1), endMs: D(2026, 3, 13, 15), allDay: false, change: "move", before: b })).toEqual({ s: "2026-03-11T01:00:00.000Z", e: "2026-03-13" });
    // And back a day.
    expect(write(timedStart, { startMs: D(2026, 3, 9, 10), endMs: D(2026, 3, 12), allDay: false, change: "move", before: b })).toEqual({ s: "2026-03-09T10:00:00.000Z", e: "2026-03-11" });
  });

  it("ends a resized timed event on the day its drawn end reaches into, or the day before when it stops at midnight", () => {
    const b = before(timedStart, record);
    expect(write(timedStart, { startMs: D(2026, 3, 10, 10), endMs: D(2026, 3, 13, 15), allDay: false, change: "resize", before: b })).toMatchObject({ e: "2026-03-13" });
    expect(write(timedStart, { startMs: D(2026, 3, 10, 10), endMs: D(2026, 3, 13), allDay: false, change: "resize", before: b })).toMatchObject({ e: "2026-03-12" });
  });

  it("never lets a date-only end fall before the start's day", () => {
    const b = before(timedStart, record);
    expect(write(timedStart, { startMs: D(2026, 3, 10, 10), endMs: D(2026, 3, 10, 12), allDay: false, change: "resize", before: b })).toMatchObject({ e: "2026-03-10" });
  });

  it("moves an all-day event with a timed end by whole days and keeps the end's time of day", () => {
    const b = before(dayStart, { s: "2026-03-10", e: "2026-03-12T15:00:00.000Z" });
    // Drawn Mar 10 to Mar 13 (exclusive); a day later it is Mar 11 to Mar 14.
    expect(write(dayStart, { startMs: D(2026, 3, 11), endMs: D(2026, 3, 14), allDay: true, change: "move", before: b })).toEqual({ s: "2026-03-11", e: "2026-03-13T15:00:00.000Z" });
  });

  it("stretches an all-day event over a timed end at the end's time of day, or the end of the day when it had none", () => {
    const b = before(dayStart, { s: "2026-03-10", e: "2026-03-12T15:00:00.000Z" });
    expect(write(dayStart, { startMs: D(2026, 3, 10), endMs: D(2026, 3, 15), allDay: true, change: "resize", before: b })).toMatchObject({ e: "2026-03-14T15:00:00.000Z" });
    const none = before(dayStart, { s: "2026-03-10" });
    expect(write(dayStart, { startMs: D(2026, 3, 10), endMs: D(2026, 3, 12), allDay: true, change: "resize", before: none })).toMatchObject({ e: "2026-03-11T23:59:00.000Z" });
  });

  it("moves a timed end with the start and keeps both in the right order", () => {
    const both = ctx([name, timed("s"), timed("e")], "s", "e");
    const b = before(both, { s: "2026-03-10T10:00:00.000Z", e: "2026-03-10T12:30:00.000Z" });
    expect(write(both, { startMs: D(2026, 3, 11, 9), endMs: D(2026, 3, 11, 11, 30), allDay: false, change: "move", before: b })).toEqual({ s: "2026-03-11T09:00:00.000Z", e: "2026-03-11T11:30:00.000Z" });
    expect(write(both, { startMs: D(2026, 3, 10, 10), endMs: D(2026, 3, 10, 9), allDay: false, change: "resize", before: b })).toMatchObject({ e: "2026-03-10T10:00:00.000Z" });
  });

  it("takes along an end that sat before the start when the record is moved, but not when it is resized", () => {
    const c = ctx([name, day("s"), day("e")], "s", "e");
    const b = before(c, { s: "2026-03-10", e: "2026-03-05" });
    expect(b).toMatchObject({ hasEnd: false, endUnusable: true });
    expect(write(c, { startMs: D(2026, 3, 15), endMs: null, allDay: true, change: "move", before: b })).toEqual({ s: "2026-03-15", e: "2026-03-15" });
    expect(write(c, { startMs: D(2026, 3, 10), endMs: null, allDay: true, change: "resize", before: b })).toEqual({ s: "2026-03-10" });
    // A record that never had an end keeps having none.
    expect(write(c, { startMs: D(2026, 3, 15), endMs: null, allDay: true, change: "move", before: before(c, { s: "2026-03-10" }) })).toEqual({ s: "2026-03-15" });
    const timedBoth = ctx([name, timed("s"), timed("e")], "s", "e");
    const zero = before(timedBoth, { s: "2026-03-10T10:00:00.000Z", e: "2026-03-10T10:00:00.000Z" });
    expect(write(timedBoth, { startMs: D(2026, 3, 11, 8), endMs: null, allDay: false, change: "move", before: zero })).toEqual({ s: "2026-03-11T08:00:00.000Z", e: "2026-03-11T08:00:00.000Z" });
  });
});

describe("unscheduleValues and addDay", () => {
  it("clears the start and, when it can be written, the end", () => {
    expect(unscheduleValues(ctx([name, day("d"), day("e")], "d", "e").fields)).toEqual({ d: null, e: null });
    expect(unscheduleValues(ctx([name, day("d")], "d", null).fields)).toEqual({ d: null });
    const created = ALL_FIELDS.created_time!;
    expect(unscheduleValues(ctx([name, day("d"), created], "d", created.id).fields)).toEqual({ d: null });
  });

  it("adds on today when it is on screen, else on the first day shown", () => {
    const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
    const march = [D(2026, 3, 1), D(2026, 4, 1)] as const;
    expect(addDay(D(2026, 3, 12, 15), ...march)).toBe(D(2026, 3, 12));
    expect(addDay(D(2026, 5, 2, 9), ...march)).toBe(D(2026, 3, 1));
    expect(addDay(D(2026, 4, 1, 9), ...march)).toBe(D(2026, 3, 1)); // the end is exclusive
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
