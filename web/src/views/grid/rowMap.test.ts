import { describe, expect, it } from "vitest";
import type { GroupHeader } from "@/api/types";
import { PAGE_SIZE, buildRowMap, groupPathKeys, isLeafGroup, pagesFor } from "./rowMap";

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

describe("buildRowMap: add rows", () => {
  const g = (depth: number, key: string, start: number, count: number): GroupHeader => ({ depth, field_id: depth === 0 ? "f" : "g", key, label: key, value: null, start, count });
  const rows = (m: ReturnType<typeof buildRowMap>) => Array.from({ length: m.length }, (_, r) => (m.isAddRow(r) ? `add${m.addGroupAt(r)}` : m.groupAt(r) >= 0 ? `g${m.groupAt(r)}` : `r${m.recordIndexAt(r)}`));

  it("is one row after the records of an ungrouped table, with no group", () => {
    const m = buildRowMap(3, [], new Set(), true);
    expect(rows(m)).toEqual(["r0", "r1", "r2", "add-1"]);
    expect(m.isAddRow(3)).toBe(true);
    expect(m.addGroupAt(3)).toBe(-1);
    expect(m.recordIndexAt(3)).toBe(-1);
    expect(m.recordRange(0, 9)).toEqual([0, 2]);
    expect(buildRowMap(3, []).length).toBe(3);
    expect(buildRowMap(0, [], new Set(), true).isAddRow(0)).toBe(true);
  });

  const flat = [g(0, "A", 0, 3), g(0, "B", 3, 2)];

  it("closes every group with one", () => {
    const m = buildRowMap(5, flat, new Set(), true);
    expect(rows(m)).toEqual(["g0", "r0", "r1", "r2", "add0", "g1", "r3", "r4", "add1"]);
    expect(m.groupAt(4)).toBe(-1);
    expect(m.rowOfRecord(3)).toBe(6);
    expect(m.recordRange(3, 5)).toEqual([2, 2]);
  });

  it("adds none unless asked", () => {
    expect(rows(buildRowMap(5, flat))).toEqual(["g0", "r0", "r1", "r2", "g1", "r3", "r4"]);
  });

  it("shows none for a collapsed group", () => {
    const m = buildRowMap(5, flat, new Set(["f:A"]), true);
    expect(rows(m)).toEqual(["g0", "g1", "r3", "r4", "add1"]);
    expect(rows(buildRowMap(5, flat, new Set(["f:A", "f:B"]), true))).toEqual(["g0", "g1"]);
  });

  it("closes only the innermost groups of nested ones", () => {
    const nested = [g(0, "A", 0, 4), g(1, "x", 0, 2), g(1, "y", 2, 2), g(0, "B", 4, 1), g(1, "z", 4, 1)];
    expect(nested.map((_, i) => isLeafGroup(nested, i))).toEqual([false, true, true, false, true]);
    expect(rows(buildRowMap(5, nested, new Set(), true))).toEqual(["g0", "g1", "r0", "r1", "add1", "g2", "r2", "r3", "add2", "g3", "g4", "r4", "add4"]);
    // A folded parent hides the add rows of its sub-groups; a folded sub-group only its own.
    expect(rows(buildRowMap(5, nested, new Set(["f:A"]), true))).toEqual(["g0", "g3", "g4", "r4", "add4"]);
    expect(rows(buildRowMap(5, nested, new Set(["f:A/g:x"]), true))).toEqual(["g0", "g1", "g2", "r2", "r3", "add2", "g3", "g4", "r4", "add4"]);
  });
});
