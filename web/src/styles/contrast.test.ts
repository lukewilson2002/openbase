import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "@/views/grid/glide/theme";

/**
 * The text colours of both themes against the surfaces they are drawn on (WCAG AA, 4.5:1). The
 * browser scan that found the original failures lives in the pull request; this keeps them fixed.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");

function tokens(selector: RegExp): Record<string, string> {
  const block = selector.exec(css)?.[1];
  if (!block) throw new Error(`no block for ${selector}`);
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]));
}

const light = tokens(/:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/);
const dark = tokens(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const PAIRS: [fg: string, bg: string][] = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["fg", "subtle"],
  ["fg", "hover"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "subtle"],
  ["muted", "hover"],
  // Secondary text ("faint": field labels on cards, "No cards", placeholders) sits on the page, cards and panels.
  ["faint", "bg"],
  ["faint", "surface"],
  ["faint", "subtle"],
  ["primary", "surface"],
  ["primary", "bg"],
  ["primary", "primary-soft"],
  ["primary-fg", "primary"],
  ["danger", "surface"],
  ["danger", "danger-soft"],
  ["danger-fg", "danger"],
  ["success", "surface"],
  ["success", "success-soft"],
];

describe.each([
  ["light", light, LIGHT_THEME],
  ["dark", dark, DARK_THEME],
] as const)("%s theme", (_name, t, canvas) => {
  it.each(PAIRS)("%s text on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the grid canvas uses readable text colours too", () => {
    expect(ratio(canvas.textDark!, canvas.bgCell!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(canvas.textMedium!, canvas.bgCell!)).toBeGreaterThanOrEqual(4.5);
    // Row numbers and secondary text sit on cells, the header and (in the pinned row) the muted band.
    expect(ratio(canvas.textLight!, canvas.bgCell!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(canvas.textLight!, canvas.bgHeader!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(canvas.textHeader!, canvas.bgHeader!)).toBeGreaterThanOrEqual(4.5);
  });

  it("the canvas theme mirrors the CSS tokens", () => {
    expect(canvas.textDark).toBe(t["fg"]);
    expect(canvas.textMedium).toBe(t["muted"]);
    expect(canvas.textLight).toBe(t["faint"]);
    expect(canvas.accentColor).toBe(t["primary"]);
    expect(canvas.bgCell).toBe(t["surface"]);
  });
});
