import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS } from "@/lib/colors";
import { PALETTE, mixColors, paletteColor, ratingColor, swatchColor } from "./palette";

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

  it("gives marks a colour that shows on light and dark surfaces", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    // The pale entries (chip backgrounds); the `_dark` ones are saturated colours chosen as they are.
    for (const c of COLORS.filter((n) => !n.endsWith("_dark"))) {
      for (const surface of ["#ffffff", "#f0f2f5", "#1a1e26", "#232833"]) {
        expect(ratio(swatchColor(c), surface), `${c} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(swatchColor("red_dark")).toBe(PALETTE.red_dark!.bg);
    expect(swatchColor(undefined)).toBe(swatchColor("gray"));
  });

  it("mixes colours and picks a readable rating tint", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#ffffff", "#000000", 0)).toBe("#ffffff");
    expect(ratingColor("yellow_dark")).toBe(PALETTE.yellow_dark!.bg);
    expect(ratingColor("yellow")).toBe(PALETTE.yellow!.fg);
  });
});
