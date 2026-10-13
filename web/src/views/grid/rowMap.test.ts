import { describe, expect, it } from "vitest";
import type { GroupHeader } from "@/api/types";
import { PAGE_SIZE, buildRowMap, groupPathKeys, pagesFor } from "./rowMap";

const g = (depth: number, key: string, start: number, count: number): GroupHeader => ({ depth, field_id: depth === 0 ? "f" : "g", key, label: key, value: null, start, count });

describe("buildRowMap", () => {
  it("is the identity without groups", () => {
    const m = buildRowMap(5, []);
    expect(m.length).toBe(5);
    expect(m.recordIndexAt(3)).toBe(3);
    expect(m.groupAt(3)).toBe(-1);
    expect(m.recordIndexAt(5)).toBe(-1);
    expect(m.rowOfRecord(4)).toBe(4);
    expect(m.recordRange(1, 100)).toEqual([1, 4]);
    expect(buildRowMap(0, []).recordRange(0, 3)).toBeNull();
  });

  const groups = [g(0, "A", 0, 3), g(0, "B", 3, 2)];

  it("interleaves headers before their records", () => {
    const m = buildRowMap(5, groups);
    expect(m.length).toBe(7);
    expect([0, 1, 2, 3, 4, 5, 6].map((r) => m.groupAt(r))).toEqual([0, -1, -1, -1, 1, -1, -1]);
    expect([0, 1, 2, 3, 4, 5, 6].map((r) => m.recordIndexAt(r))).toEqual([-1, 0, 1, 2, -1, 3, 4]);
    expect(m.rowOfRecord(3)).toBe(5);
    expect(m.recordRange(0, 4)).toEqual([0, 2]);
  });

  it("hides the records of collapsed groups", () => {
    const m = buildRowMap(5, groups, new Set(["f:A"]));
    expect(m.length).toBe(4);
    expect([0, 1, 2, 3].map((r) => m.recordIndexAt(r))).toEqual([-1, -1, 3, 4]);
    expect(m.rowOfRecord(0)).toBe(-1);
    expect(m.rowOfRecord(3)).toBe(2);
  });

  it("handles nested groups: a collapsed parent hides its children", () => {
    const nested = [g(0, "A", 0, 4), g(1, "x", 0, 2), g(1, "y", 2, 2), g(0, "B", 4, 1), g(1, "x", 4, 1)];
    const open = buildRowMap(5, nested);
    expect(open.length).toBe(10);
    const keys = groupPathKeys(nested);
    expect(keys).toEqual(["f:A", "f:A/g:x", "f:A/g:y", "f:B", "f:B/g:x"]);
    // Collapsing the child "x" under A keeps y; the same key under B is a different path.
    const childCollapsed = buildRowMap(5, nested, new Set(["f:A/g:x"]));
    expect(childCollapsed.length).toBe(8);
    const parentCollapsed = buildRowMap(5, nested, new Set(["f:A"]));
    expect(parentCollapsed.length).toBe(4);
    expect([0, 1, 2, 3].map((r) => parentCollapsed.groupAt(r))).toEqual([0, 3, 4, -1]);
  });
});

describe("pagesFor", () => {
  it("covers a record range, optionally with margin", () => {
    expect(pagesFor(0, 10, 1000)).toEqual([0]);
    expect(pagesFor(PAGE_SIZE - 1, PAGE_SIZE, 1000)).toEqual([0, 1]);
    expect(pagesFor(PAGE_SIZE, PAGE_SIZE + 1, 1000, 1)).toEqual([0, 1, 2]);
    expect(pagesFor(0, 5000, 1000)).toEqual([0, 1, 2, 3, 4]);
    expect(pagesFor(0, 10, 0)).toEqual([]);
    expect(pagesFor(5, 2, 100)).toEqual([]);
  });
});
