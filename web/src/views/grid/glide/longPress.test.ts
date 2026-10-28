import { describe, expect, it } from "vitest";
import { cellAtPoint } from "./longPress";

// Three columns 100 wide, rows 40 high, the first row starting at y = 50; column 0 is frozen.
const bounds = (col: number, row: number) => (col > 2 ? undefined : { x: col * 100, y: 50 + row * 40, width: 100, height: 40 });

describe("cellAtPoint", () => {
  it("finds the cell a point is in", () => {
    expect(cellAtPoint(bounds, { y: 0, height: 5 }, 3, 150, 95)).toEqual({ col: 1, row: 1 });
    expect(cellAtPoint(bounds, { y: 2, height: 5 }, 3, 20, 135)).toEqual({ col: 0, row: 2 });
  });

  it("finds nothing over the header, past the last column or below the rows", () => {
    expect(cellAtPoint(bounds, { y: 0, height: 5 }, 3, 150, 20)).toBeNull();
    expect(cellAtPoint(bounds, { y: 0, height: 5 }, 3, 350, 95)).toBeNull();
    expect(cellAtPoint(bounds, { y: 0, height: 2 }, 3, 150, 400)).toBeNull();
  });
});
