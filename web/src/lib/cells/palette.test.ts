import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS } from "@/lib/colors";
import { PALETTE, mixColors, paletteColor, ratingColor } from "./palette";

describe("canvas palette", () => {
  it("matches the .choice-* classes in the stylesheet for every colour", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");
    for (const c of COLORS) {
      const m = new RegExp(`\\.choice-${c} \\{\\s*--c-bg: (#[0-9a-f]{6});\\s*--c-fg: (#[0-9a-f]{6});`, "i").exec(css);
      expect(m, c).not.toBeNull();
      expect(PALETTE[c]).toEqual({ bg: m![1], fg: m![2] });
    }
  });

  it("falls back to gray for unknown colours", () => {
    expect(paletteColor("nope")).toEqual(PALETTE.gray);
    expect(paletteColor(undefined)).toEqual(PALETTE.gray);
  });

  it("mixes colours and picks a readable rating tint", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#ffffff", "#000000", 0)).toBe("#ffffff");
    expect(ratingColor("yellow_dark")).toBe(PALETTE.yellow_dark!.bg);
    expect(ratingColor("yellow")).toBe(PALETTE.yellow!.fg);
  });
});
