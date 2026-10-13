import { describe, expect, it } from "vitest";
import type { DateOptions, Field, GroupHeader } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { DAY_MS, type Span } from "../common/wallTime";
import { createWrites, dragWrites, groupIntoLanes, lanesFromGroups, spanLabel, type TimelineDateFields } from "./lanes";

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
    const text = ALL_FIELDS.single_line_text!;
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
  const sp = (s: number, e: number, over: Partial<Span> = {}): Span => ({ startMs: s, endMs: e, startDateOnly: true, hasEnd: true, ...over });

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

  it("labels spans for the drag tooltip", () => {
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 13)))).toBe("Mar 10 – Mar 12");
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 11)))).toBe("Mar 10");
    expect(spanLabel(sp(D(2026, 3, 10), D(2026, 3, 11), { hasEnd: false }))).toBe("Mar 10");
  });
});
