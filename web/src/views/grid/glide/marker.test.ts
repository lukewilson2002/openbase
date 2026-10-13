import { markerCellRenderer, type MarkerCell } from "@glideapps/glide-data-grid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER_START_INDEX, installMarkerNumbering, markerNumber, setRowNumbering } from "./marker";

installMarkerNumbering();

/** A canvas context that only records the text it is asked to draw. */
function fakeCtx() {
  const drawn: string[] = [];
  const ctx = {
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    textAlign: "start",
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3 }),
    fillText: (t: string) => void drawn.push(t),
    save: vi.fn(),
    restore: vi.fn(),
    textBaseline: "alphabetic",
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

function marker(displayRow: number): MarkerCell {
  return { kind: "marker" as never, allowOverlay: false, checked: false, markerKind: "both", row: MARKER_START_INDEX + displayRow, drawHandle: false, checkboxStyle: "square" } as unknown as MarkerCell;
}

function drawRow(displayRow: number): string[] {
  const { ctx, drawn } = fakeCtx();
  const cell = marker(displayRow);
  const theme = { markerFontFull: "11px sans-serif", textLight: "#999", textDark: "#000", bgCell: "#fff", accentColor: "#00f", checkboxMaxSize: 18 };
  const args = { ctx, theme, col: 0, row: displayRow, rect: { x: 0, y: 0, width: 56, height: 33 }, highlighted: false, hoverAmount: 0, hoverX: undefined, hoverY: undefined, cellFillColor: "#fff", cell };
  markerCellRenderer.draw(args as never, cell);
  return drawn;
}

describe("marker numbering", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it("numbers by display row when no grid is registered (the library default)", () => {
    expect(markerNumber(MARKER_START_INDEX + 4)).toBe(5);
    expect(drawRow(4)).toEqual(["5"]);
  });

  it("shows the host's number and draws nothing for rows without one", () => {
    // Display rows: 0 group header, 1-2 records 1-2, 3 group header, 4-5 records 3-4, 6 the summary row.
    const numbers = [null, 1, 2, null, 3, 4, null];
    unregister = setRowNumbering((row) => numbers[row] ?? null);

    expect(drawRow(1)).toEqual(["1"]);
    expect(drawRow(4)).toEqual(["3"]);
    expect(drawRow(5)).toEqual(["4"]);
    // Group headers and the pinned summary row: no number, and no hover checkbox either.
    expect(drawRow(0)).toEqual([]);
    expect(drawRow(3)).toEqual([]);
    expect(drawRow(6)).toEqual([]);
  });

  it("gives the accessibility tree the same text", () => {
    unregister = setRowNumbering((row) => (row === 2 ? null : row + 10));
    expect(markerCellRenderer.getAccessibilityString(marker(1))).toBe("11");
    expect(markerCellRenderer.getAccessibilityString(marker(2))).toBe("");
  });

  it("stops applying once the grid unregisters", () => {
    const off = setRowNumbering(() => 99);
    expect(markerNumber(MARKER_START_INDEX + 1)).toBe(99);
    off();
    expect(markerNumber(MARKER_START_INDEX + 1)).toBe(2);
  });
});
