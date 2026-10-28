import { describe, expect, it } from "vitest";
import type { DateOptions, Field, GroupHeader } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { DAY_MS } from "../common/wallTime";
import type { TimelineSpan } from "./geometry";
import { createWrites, dragWrites, dropWrites, groupIntoLanes, lanesFromGroups, spanLabel, timelineSpan, type TimelineDateFields } from "./lanes";

const status = ALL_FIELDS.single_select!;
const rec = (id: string, v: Record<string, unknown>) => makeRecord(v, id);
const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

describe("groupIntoLanes", () => {
  it("makes a lane per choice in choice order, including empty choices, with (Empty) last", () => {
    const lanes = groupIntoLanes([rec("a", { [status.id]: "chs3" }), rec("b", {}), rec("c", { [status.id]: "chs1" }), rec("d", { [status.id]: "chs3" })], status, DEFAULT_CTX);
    expect(lanes.map((l) => [l.label, l.records.map((r) => r.id)])).toEqual([
      ["Todo", ["c"]],
      ["In progress", []],
      ["Done", ["a", "d"]],
      ["(Empty)", ["b"]],
    ]);
    expect(lanes[0]!.value).toBe("chs1");
    expect(lanes[3]!.value).toBeNull();
    expect(lanes[2]!.color).toBe("green");
  });

  it("groups by user, using names and the first user of multi-user fields", () => {
    const user = ALL_FIELDS.user!;
    const ctx = { ...DEFAULT_CTX, userName: (id: string) => ({ u1: "Zed", u2: "Amy" })[id] };
    const lanes = groupIntoLanes([rec("a", { [user.id]: ["u1", "u2"] }), rec("b", { [user.id]: ["u2"] }), rec("c", {})], user, ctx);
    expect(lanes.map((l) => l.label)).toEqual(["Amy", "Zed", "(Empty)"]);
    expect(lanes[0]!.value).toEqual(["u2"]);
  });

  it("groups links by the first linked record and text by its value, sorted naturally", () => {
    const link = ALL_FIELDS.link!;
    const l1 = groupIntoLanes([rec("a", { [link.id]: [{ id: "x", name: "Beta" }] }), rec("b", { [link.id]: [{ id: "y", name: "Alpha" }] })], link, DEFAULT_CTX);
    expect(l1.map((l) => l.label)).toEqual(["Alpha", "Beta"]);
    const text = ALL_FIELDS.text!;
    const l2 = groupIntoLanes([rec("a", { [text.id]: "Team 10" }), rec("b", { [text.id]: "Team 2" })], text, DEFAULT_CTX);
    expect(l2.map((l) => l.label)).toEqual(["Team 2", "Team 10"]);
    expect(l2[0]!.value).toBe("Team 2");
  });

  it("groups checkboxes unchecked first and cannot write computed lane values", () => {
    const cb = ALL_FIELDS.checkbox!;
    expect(groupIntoLanes([rec("a", { [cb.id]: true }), rec("b", {})], cb, DEFAULT_CTX).map((l) => l.label)).toEqual(["Unchecked", "Checked"]);
    const formula: Field = ALL_FIELDS.formula!;
    const lane = groupIntoLanes([rec("a", { [formula.id]: 4 })], formula, DEFAULT_CTX)[0]!;
    expect(lane.value).toBeUndefined();
  });
});

describe("lanes that exist whatever is in the window", () => {
  const user = ALL_FIELDS.user!;
  const people = [
    { id: "u1", name: "Zed" },
    { id: "u2", name: "Amy" },
  ];
  const ctx = { ...DEFAULT_CTX, userName: (id: string) => ({ u1: "Zed", u2: "Amy" })[id] };

  it("gives a user field a lane for every collaborator and (Empty), with a lane value that puts a bar there", () => {
    const lanes = groupIntoLanes([rec("a", { [user.id]: ["u1"] })], user, ctx, people);
    expect(lanes.map((l) => [l.label, l.records.length, l.value])).toEqual([
      ["Amy", 0, ["u2"]],
      ["Zed", 1, ["u1"]],
      ["(Empty)", 0, null],
    ]);
  });

  it("gives a select field its (Empty) lane even when every record has a choice", () => {
    const lanes = groupIntoLanes([rec("a", { [status.id]: "chs1" })], status, DEFAULT_CTX);
    expect(lanes.map((l) => l.label)).toEqual(["Todo", "In progress", "Done", "(Empty)"]);
    expect(lanes[3]!.value).toBeNull();
  });

  it("does not offer a lane value for a field that is worked out", () => {
    const by = ALL_FIELDS.created_by!;
    const lanes = groupIntoLanes([rec("a", { [by.id]: ["u1"] })], by, ctx, people);
    expect(lanes.map((l) => l.value)).toEqual([undefined, undefined, undefined]);
  });

  const header = (key: string, label: string, start: number, count: number, value: unknown, field_id = status.id): GroupHeader => ({ depth: 0, field_id, key, label, value: value as GroupHeader["value"], start, count });

  it("adds the unused choices and (Empty) to the view's grouping, in the order its groups run", () => {
    const records = [rec("a", {}), rec("b", {})];
    const lanes = lanesFromGroups(records, [header("chs3", "Done", 0, 1, "chs3"), header("chs1", "Todo", 1, 1, "chs1")], status);
    // The groups run Done, Todo (descending): the unused choice joins them that way.
    expect(lanes.map((l) => [l.label, l.records.length])).toEqual([
      ["Done", 1],
      ["In progress", 0],
      ["Todo", 1],
      ["(Empty)", 0],
    ]);
    expect(lanes[1]!.value).toBe("chs2");
    expect(lanes[1]!.color).toBe("blue");
  });

  it("keeps the (Empty) group where the grouping put it, and its null value so a bar can be dropped there", () => {
    const records = [rec("a", {}), rec("b", {})];
    const lanes = lanesFromGroups(records, [header("", "(Empty)", 0, 1, null), header("chs2", "In progress", 1, 1, "chs2")], status);
    expect(lanes.map((l) => l.label)).toEqual(["(Empty)", "Todo", "In progress", "Done"]);
    expect(lanes[0]!.value).toBeNull();
    expect(lanes[0]!.fieldId).toBe(status.id);
  });

  it("adds collaborators with no records to a grouping by a user field", () => {
    const lanes = lanesFromGroups([rec("a", {})], [header("u1", "Zed", 0, 1, ["u1"], user.id)], user, people);
    expect(lanes.map((l) => [l.label, l.value])).toEqual([
      ["Amy", ["u2"]],
      ["Zed", ["u1"]],
      ["(Empty)", null],
    ]);
  });

  it("has the lanes of a grouped field with no records at all, and none for other kinds of field", () => {
    expect(lanesFromGroups([], [], status).map((l) => l.label)).toEqual(["Todo", "In progress", "Done", "(Empty)"]);
    expect(lanesFromGroups([], [], ALL_FIELDS.text!)).toEqual([]);
  });

  it("makes a computed grouping's lanes unable to take a bar", () => {
    const lanes = lanesFromGroups([rec("a", {})], [header("x", "X", 0, 1, null, "fld_formula")], ALL_FIELDS.formula!);
    expect(lanes[0]!.value).toBeUndefined();
  });
});

describe("lanesFromGroups", () => {
  it("slices the ordered records by the top-level group headers", () => {
    const header = (depth: number, key: string, start: number, count: number): GroupHeader => ({ depth, field_id: "f", key, label: key.toUpperCase(), value: key, start, count });
    const records = ["a", "b", "c", "d"].map((id) => rec(id, {}));
    const lanes = lanesFromGroups(records, [header(0, "x", 0, 3), header(1, "x1", 0, 1), header(1, "x2", 1, 2), header(0, "y", 3, 1)]);
    expect(lanes.map((l) => [l.label, l.records.map((r) => r.id), l.value])).toEqual([
      ["X", ["a", "b", "c"], "x"],
      ["Y", ["d"], "y"],
    ]);
  });
});

describe("date writes", () => {
  const day: DateOptions = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
  const timed: DateOptions = { include_time: true, date_format: "iso", time_format: "h24", timezone: "America/New_York" };
  const df = (id: string): Field => field("date", day, { id });
  const tf = (id: string): Field => field("date", timed, { id });
  const dayFields: TimelineDateFields = { start: { field: df("s"), opts: day }, end: { field: df("e"), opts: day } };
  const sp = (s: number, e: number, over: Partial<TimelineSpan> = {}): TimelineSpan => ({ startMs: s, endMs: e, startDateOnly: true, hasEnd: true, ...over });

  it("writes only the edges a drag changed (date-only end stores the last day)", () => {
    const before = sp(D(2026, 3, 10), D(2026, 3, 13));
    expect(dragWrites(before, sp(D(2026, 3, 12), D(2026, 3, 15)), "move", dayFields, "UTC")).toEqual({ s: "2026-03-12", e: "2026-03-14" });
    expect(dragWrites(before, sp(D(2026, 3, 10), D(2026, 3, 16)), "end", dayFields, "UTC")).toEqual({ e: "2026-03-15" });
    expect(dragWrites(before, sp(D(2026, 3, 8), D(2026, 3, 13)), "start", dayFields, "UTC")).toEqual({ s: "2026-03-08" });
    expect(dragWrites(before, before, "move", dayFields, "UTC")).toEqual({});
  });

  it("does not write an end for a milestone or a view without an end field", () => {
    const m = sp(D(2026, 3, 10), D(2026, 3, 11), { hasEnd: false });
    expect(dragWrites(m, sp(D(2026, 3, 12), D(2026, 3, 13), { hasEnd: false }), "move", dayFields, "UTC")).toEqual({ s: "2026-03-12" });
    expect(dragWrites(sp(D(2026, 3, 10), D(2026, 3, 13)), sp(D(2026, 3, 11), D(2026, 3, 14)), "move", { ...dayFields, end: null }, "UTC")).toEqual({ s: "2026-03-11" });
  });

  it("maps timed spans back through the field's zone", () => {
    const fields: TimelineDateFields = { start: { field: tf("s"), opts: timed }, end: { field: tf("e"), opts: timed } };
    const before = sp(D(2026, 7, 1, 9), D(2026, 7, 1, 17), { startDateOnly: false });
    const after = sp(D(2026, 7, 1, 9) + DAY_MS, D(2026, 7, 1, 17) + DAY_MS, { startDateOnly: false });
    expect(dragWrites(before, after, "move", fields, "UTC")).toEqual({ s: "2026-07-02T13:00:00.000Z", e: "2026-07-02T21:00:00.000Z" });
  });

  it("creates by dragging: start at the first day, end at the last, either direction", () => {
    const f1 = Math.floor(D(2026, 3, 5) / DAY_MS);
    const f2 = Math.floor(D(2026, 3, 9) / DAY_MS);
    expect(createWrites(f2, f1, dayFields, "UTC")).toEqual({ s: "2026-03-05", e: "2026-03-09" });
    expect(createWrites(f1, f2, { ...dayFields, end: null }, "UTC")).toEqual({ s: "2026-03-05" });
    const fields: TimelineDateFields = { start: { field: tf("s"), opts: timed }, end: { field: tf("e"), opts: timed } };
    expect(createWrites(f1, f2, fields, "UTC")).toEqual({ s: "2026-03-05T14:00:00.000Z", e: "2026-03-09T21:00:00.000Z" }); // 09:00 EST and 17:00 EDT (DST began on the 8th)
  });

  it("reads an end-only record as a milestone on its end day and an end before the start as reversed", () => {
    expect(timelineSpan({ s: "2026-03-10", e: "2026-03-12" }, dayFields, "UTC")).toMatchObject({ startMs: D(2026, 3, 10), endMs: D(2026, 3, 13), hasEnd: true });
    expect(timelineSpan({ e: "2026-11-30" }, dayFields, "UTC")).toEqual({ startMs: D(2026, 11, 30), endMs: D(2026, 12, 1), startDateOnly: true, hasEnd: false, endOnly: true });
    expect(timelineSpan({ s: "2026-03-10", e: "2026-03-03" }, dayFields, "UTC")).toMatchObject({ startMs: D(2026, 3, 10), hasEnd: false, reversed: true });
    expect(timelineSpan({ s: "2026-03-10" }, dayFields, "UTC")).not.toHaveProperty("reversed");
    expect(timelineSpan({}, dayFields, "UTC")).toBeNull();
    expect(timelineSpan({ e: "2026-03-10" }, { ...dayFields, end: null }, "UTC")).toBeNull();
  });

  it("moves an end-only milestone by its end, and gives a milestone an end from its end edge", () => {
    const endOnly = sp(D(2026, 3, 10), D(2026, 3, 11), { hasEnd: false, endOnly: true });
    expect(dragWrites(endOnly, sp(D(2026, 3, 12), D(2026, 3, 13), { hasEnd: false, endOnly: true }), "move", dayFields, "UTC")).toEqual({ e: "2026-03-12" });
    const m = sp(D(2026, 3, 10), D(2026, 3, 11), { hasEnd: false });
    expect(dragWrites(m, sp(D(2026, 3, 10), D(2026, 3, 13)), "end", dayFields, "UTC")).toEqual({ e: "2026-03-12" });
    // An end edge dragged back to where it was does not invent an end; a reversed end is repaired by it.
    expect(dragWrites(m, m, "end", dayFields, "UTC")).toEqual({});
    expect(dragWrites({ ...m, reversed: true }, m, "end", dayFields, "UTC")).toEqual({ e: "2026-03-10" });
  });

  it("writes only the dates that are not calculated", () => {
    const calcEnd: TimelineDateFields = { ...dayFields, end: { field: field("formula", { expression: "x", result_type: "date" }, { id: "e" }), opts: day } };
    expect(dragWrites(sp(D(2026, 3, 10), D(2026, 3, 13)), sp(D(2026, 3, 12), D(2026, 3, 15)), "move", calcEnd, "UTC")).toEqual({ s: "2026-03-12" });
    expect(createWrites(Math.floor(D(2026, 3, 5) / DAY_MS), Math.floor(D(2026, 3, 9) / DAY_MS), calcEnd, "UTC")).toEqual({ s: "2026-03-05" });
    const calcStart: TimelineDateFields = { ...dayFields, start: { field: field("created_time", day, { id: "s" }), opts: day } };
    expect(dragWrites(sp(D(2026, 3, 10), D(2026, 3, 13)), sp(D(2026, 3, 12), D(2026, 3, 15)), "move", calcStart, "UTC")).toEqual({ e: "2026-03-14" });
  });

  it("drops a record on a day: its start, keeping an end that is not before it", () => {
    const d = Math.floor(D(2026, 11, 5) / DAY_MS);
    expect(dropWrites(d, { e: "2026-11-30" }, dayFields, "UTC")).toEqual({ s: "2026-11-05" });
    expect(dropWrites(d, { e: "2026-11-05" }, dayFields, "UTC")).toEqual({ s: "2026-11-05" });
    // An end before the new start would be invalid: it becomes that day. No end: a one-day bar.
    expect(dropWrites(d, { e: "2026-11-01" }, dayFields, "UTC")).toEqual({ s: "2026-11-05", e: "2026-11-05" });
    expect(dropWrites(d, {}, dayFields, "UTC")).toEqual({ s: "2026-11-05", e: "2026-11-05" });
    expect(dropWrites(d, { e: "2026-11-30" }, { ...dayFields, end: null }, "UTC")).toEqual({ s: "2026-11-05" });
  });

  it("labels spans for the drag tooltip", () => {
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 13)))).toBe("Mar 10 – Mar 12");
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 11)))).toBe("Mar 10");
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 11), { hasEnd: false }))).toBe("Mar 10");
  });
});
