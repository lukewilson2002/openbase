import { describe, expect, it } from "vitest";
import { chipFont, chipPadding, drawCellText, layoutChips, oneLine, type ChipDraw } from "./draw";

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

describe("chips in the grid, as StatusChip and LinkChip draw them", () => {
  it("sets a chip in 12 px medium weight and plain counts in 12 px regular, whatever the cell's font", () => {
    expect(chipFont("14px sans-serif", "select")).toBe("500 12px sans-serif");
    expect(chipFont("600 14px sans-serif", "link")).toBe("500 12px sans-serif");
    expect(chipFont("14px sans-serif", "plain")).toBe("12px sans-serif");
  });

  it("pads a pill 8 px each side, a link chip 7 and its mark, a person's chip for the face", () => {
    expect(chipPadding("select")).toBe(16);
    expect(chipPadding("link")).toBe(14);
    expect(chipPadding("link", true)).toBe(28);
    expect(chipPadding("user")).toBe(30);
  });

  it("makes room for the collection's mark on a link chip that has one", () => {
    const chips: ChipDraw[] = [{ text: "Alpha", kind: "link", color: "blue" }];
    const { placed } = layoutChips(ctx, theme, { x: 0, y: 0, width: 300, height: 46 }, chips);
    expect(placed[0]!.w).toBe(5 * 7 + 28);
  });
});

describe("oneLine", () => {
  it("joins lines with one space and trims around the breaks", () => {
    expect(oneLine("a  \n\n  b\n c")).toBe("a b c");
    expect(oneLine("no break")).toBe("no break");
  });

  it("reads a 100,000-character run of spaces in linear time (F35)", () => {
    const text = `a${" ".repeat(99_998)}b`;
    const t = performance.now();
    expect(oneLine(text)).toBe(text);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("drawCellText", () => {
  it("hands the canvas only a short prefix of a huge value (F35)", () => {
    let longest = 0;
    const c = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      measureText: (s: string) => {
        longest = Math.max(longest, s.length);
        return { width: s.length * 7 };
      },
      fillText: () => {},
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    drawCellText(c, theme as never, { x: 0, y: 0, width: 200, height: 30 }, `a${" ".repeat(99_998)}b`, { color: "#000", align: "left" } as never);
    expect(longest).toBeLessThanOrEqual(2001);
  });
});
