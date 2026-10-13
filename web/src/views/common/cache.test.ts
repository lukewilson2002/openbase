import { describe, expect, it } from "vitest";
import { makeRecord } from "@/test/fields";
import { insertRecord, moveRecordInList, patchRecordValues, removeRecords, upsertRecords, type ViewRecordsData } from "./cache";

const data = (): ViewRecordsData => ({
  records: [makeRecord({ a: 1 }, "r1"), makeRecord({ a: 2 }, "r2"), makeRecord({ a: 3 }, "r3")],
  total: 3,
  groups: [],
  colors: {},
  truncated: false,
});
const ids = (d: ViewRecordsData) => d.records.map((r) => r.id);

describe("view records cache helpers", () => {
  it("patches values and deletes the key for empty values without touching other records", () => {
    const d = data();
    const next = patchRecordValues(d, "r2", { a: null, b: "x" });
    expect(next.records[1]!.values).toEqual({ b: "x" });
    expect(next.records[0]).toBe(d.records[0]);
    expect(d.records[1]!.values).toEqual({ a: 2 });
    expect(patchRecordValues(d, "nope", { a: 1 })).toBe(d);
  });

  it("moves a record before or after an anchor", () => {
    const d = data();
    expect(ids(moveRecordInList(d, "r3", { beforeId: "r1" }))).toEqual(["r3", "r1", "r2"]);
    expect(ids(moveRecordInList(d, "r1", { afterId: "r2" }))).toEqual(["r2", "r1", "r3"]);
    expect(moveRecordInList(d, "r1", { beforeId: "r2" })).toBe(d); // already there
    expect(moveRecordInList(d, "r1", { beforeId: "missing" })).toBe(d);
    expect(moveRecordInList(d, "r1", {})).toBe(d);
  });

  it("upserts, inserts and removes", () => {
    const d = data();
    const server = { ...d.records[0]!, values: { a: 99 } };
    expect(upsertRecords(d, [server]).records[0]!.values).toEqual({ a: 99 });
    expect(upsertRecords(d, [makeRecord({}, "zz")])).toBe(d);
    const inserted = insertRecord(d, makeRecord({}, "r4"), "r1");
    expect(ids(inserted)).toEqual(["r1", "r4", "r2", "r3"]);
    expect(inserted.total).toBe(4);
    expect(insertRecord(inserted, makeRecord({}, "r4"))).toBe(inserted);
    const removed = removeRecords(d, new Set(["r2"]));
    expect(ids(removed)).toEqual(["r1", "r3"]);
    expect(removed.total).toBe(2);
  });
});
