import { describe, expect, it } from "vitest";
import { layoutChips, type ChipDraw } from "./draw";

// A canvas whose text is 7 px a character, so widths are easy to check.
const ctx = { font: "", measureText: (s: string) => ({ width: s.length * 7 }) } as unknown as CanvasRenderingContext2D;
const theme = { cellHorizontalPadding: 10, baseFontFull: "14px sans-serif" };
const links = (...names: string[]): ChipDraw[] => names.map((text) => ({ text, kind: "link" }));

describe("layoutChips", () => {
  it("places every chip that fits, with nothing left to count", () => {
    const { placed, more } = layoutChips(ctx, theme, { x: 0, y: 0, width: 300, height: 42 }, links("Alpha", "Beta"));
    expect(placed.map((p) => [p.index, p.x, p.w])).toEqual([
      [0, 10, 5 * 7 + 14],
      [1, 10 + 49 + 4, 4 * 7 + 14],
    ]);
    expect(more).toBeNull();
  });

  it("counts the chips that do not fit at the end of the line, giving up the last one if it must", () => {
    // 10 + 49 ("Alpha") + 4 + 49 ("Gamma") + 4 = 116; "+2" (plain text) needs 16, so a 160 px cell keeps both.
    const { placed, more } = layoutChips(ctx, theme, { x: 0, y: 0, width: 160, height: 42 }, links("Alpha", "Gamma", "Delta", "Omega"));
    expect(placed.map((p) => p.index)).toEqual([0, 1]);
    expect(more).toMatchObject({ count: 2, x: 116, w: 16 });
    // A little narrower, the second chip gives way to the count of three.
    const tight = layoutChips(ctx, theme, { x: 0, y: 0, width: 120, height: 42 }, links("Alpha", "Gamma", "Delta", "Omega"));
    expect(tight.placed.map((p) => p.index)).toEqual([0]);
    expect(tight.more).toMatchObject({ count: 3, x: 63 });
  });

  it("shortens a long last chip rather than hide it, while it stays readable", () => {
    const { placed, more } = layoutChips(ctx, theme, { x: 0, y: 0, width: 140, height: 42 }, links("A very long record name", "Next"));
    expect(placed).toHaveLength(1);
    expect(placed[0]!.w).toBe(140 - 10 - 10 - 4 - 16);
    expect(more).toMatchObject({ count: 1, w: 16 });
  });
});
