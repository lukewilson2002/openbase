import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { describe, expect, it } from "vitest";
import { PRESS_WINDOW_MS, isFocusSelectAfterPress } from "./focusSelect";

const empty: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: undefined };
const cell = (col: number, row: number): GridSelection => ({
  ...empty,
  current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
});
// Cell (0, 0) on screen: x 40..240, y 44..84.
const bounds = (c: number, r: number) => ({ x: 40 + c * 200, y: 44 + r * 40, width: 200, height: 40 });
const now = 10_000;

describe("isFocusSelectAfterPress", () => {
  it("ignores the first cell selected after a tap on blank space", () => {
    expect(isFocusSelectAfterPress(empty, cell(0, 0), { x: 150, y: 500, t: now - 50 }, now, bounds)).toBe(true);
  });

  it("keeps a tap on that very cell", () => {
    expect(isFocusSelectAfterPress(empty, cell(0, 0), { x: 150, y: 60, t: now - 50 }, now, bounds)).toBe(false);
  });

  it("keeps keyboard focus, which has no recent press", () => {
    expect(isFocusSelectAfterPress(empty, cell(0, 0), null, now, bounds)).toBe(false);
    expect(isFocusSelectAfterPress(empty, cell(0, 0), { x: 150, y: 500, t: now - PRESS_WINDOW_MS - 1 }, now, bounds)).toBe(false);
  });

  it("keeps changes from an existing selection, ranges, and row or column selections", () => {
    expect(isFocusSelectAfterPress(cell(1, 2), cell(0, 0), { x: 150, y: 500, t: now }, now, bounds)).toBe(false);
    const range: GridSelection = { ...empty, current: { cell: [0, 0], range: { x: 0, y: 0, width: 2, height: 1 }, rangeStack: [] } };
    expect(isFocusSelectAfterPress(empty, range, { x: 150, y: 500, t: now }, now, bounds)).toBe(false);
    const rows: GridSelection = { ...cell(0, 0), rows: CompactSelection.fromSingleSelection(0) };
    expect(isFocusSelectAfterPress(empty, rows, { x: 150, y: 500, t: now }, now, bounds)).toBe(false);
  });
});
