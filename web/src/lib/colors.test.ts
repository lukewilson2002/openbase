import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLORS, choiceClass, colorLabel, isChoiceColor } from "./colors";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("choice colours", () => {
  it("matches ob_core::field::COLORS in the Rust source", () => {
    const rust = read("../../../crates/core/src/field.rs");
    const block = /pub const COLORS: \[&str; (\d+)\] = \[([^\]]*)\]/.exec(rust);
    expect(block).not.toBeNull();
    const names = [...block![2]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(Number(block![1])).toBe(20);
    expect([...COLORS]).toEqual(names);
  });

  it("has a CSS class with readable text for every colour", () => {
    const css = read("../styles/index.css");
    for (const color of COLORS) {
      const rule = new RegExp(`\\.choice-${color}\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `.choice-${color} missing`).not.toBeNull();
      const bg = /--c-bg:\s*(#[0-9a-f]{6})/i.exec(rule![1]!)?.[1];
      const fg = /--c-fg:\s*(#[0-9a-f]{6})/i.exec(rule![1]!)?.[1];
      expect(bg, `${color} bg`).toBeDefined();
      expect(fg, `${color} fg`).toBeDefined();
      expect(contrast(bg!, fg!), `${color} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("builds classes and falls back to gray for unknown colours", () => {
    expect(choiceClass("red_dark")).toBe("choice choice-red_dark");
    expect(choiceClass("chartreuse")).toBe("choice choice-gray");
    expect(choiceClass(null)).toBe("choice choice-gray");
    expect(isChoiceColor("teal")).toBe(true);
    expect(isChoiceColor("nope")).toBe(false);
    expect(colorLabel("blue")).toBe("Blue");
    expect(colorLabel("purple_dark")).toBe("Dark purple");
  });
});
