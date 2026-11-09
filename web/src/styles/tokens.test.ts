import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Notebook design tokens (UX overhaul DL-1, docs/plans/2026-11-07-ux-overhaul.md "Design language")
 * are the contract every screen is built to, so a value changed by accident fails here. Values are read
 * from index.css as written, converted from rem at 16px.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");

function declared(block: RegExp): Map<string, string> {
  const body = block.exec(css)?.[1];
  if (!body) throw new Error(`no block for ${block}`);
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...noComments.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)].map((m) => [m[1]!, m[2]!.trim()]));
}

const light = declared(/:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/);
const dark = declared(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const theme = declared(/@theme static\s*\{([\s\S]*?)\n\}/);
const root = declared(/\n:root\s*\{(\s*\/\*\s*\n\s*\* Spacing steps[\s\S]*?)\n\}/);

/** "0.8125rem" -> 13, "999px" -> 999. */
function px(value: string | undefined): number {
  if (!value) throw new Error("token missing");
  const m = /^(-?[\d.]+)(rem|px)$/.exec(value);
  if (!m) throw new Error(`not a length: ${value}`);
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}

describe("semantic colours (kept exactly)", () => {
  const LIGHT: Record<string, string> = {
    "--bg": "#f6f7f9",
    "--surface": "#ffffff",
    "--subtle": "#f0f2f5",
    "--hover": "#e8ebf0",
    "--line": "#dfe3ea",
    "--line-strong": "#c4cad4",
    "--fg": "#1b1f27",
    "--muted": "#566070",
    "--faint": "#636d7e",
    "--primary": "#1f5ae0",
    "--primary-soft": "#e4ecff",
    "--primary-soft-line": "#c9d8ff",
    "--primary-ink": "#12358a",
    "--danger": "#c4261d",
    "--success": "#157a39",
    "--ring": "#1f5ae0",
  };
  const DARK: Record<string, string> = {
    "--bg": "#12151b",
    "--surface": "#1a1e26",
    "--subtle": "#232833",
    "--hover": "#2c3240",
    "--line": "#2f3542",
    "--line-strong": "#444c5c",
    "--fg": "#e8ebf1",
    "--muted": "#a4adbd",
    "--faint": "#8893a4",
    "--primary": "#6b97ff",
    "--primary-soft": "#1f2d52",
    "--primary-soft-line": "#2f4475",
    "--primary-ink": "#b9ccff",
    "--danger": "#ff7168",
    "--success": "#4cc577",
    "--ring": "#7aa1ff",
  };
  it.each(Object.entries(LIGHT))("light %s is %s", (name, value) => expect(light.get(name)).toBe(value));
  it.each(Object.entries(DARK))("dark %s is %s", (name, value) => expect(dark.get(name)).toBe(value));

  it("keeps the floating-things shadow in both themes", () => {
    expect(light.get("--shadow")).toBeTruthy();
    expect(dark.get("--shadow")).toBeTruthy();
  });
});

describe("type scale", () => {
  // token: [size, line height, weight or undefined, letter spacing or undefined]
  const SCALE: Record<string, [number, number, number?, string?]> = {
    "initial-xs": [9, 11],
    initial: [10, 12],
    meta: [12, 16, 400],
    label: [13, 18],
    ui: [14, 20],
    read: [15, 24, 400],
    "read-phone": [16, 25, 400],
    h3: [16, 21, 600],
    sheet: [18, 24, 600],
    h2: [20, 26, 600, "-0.01em"],
    title: [24, 29, 600, "-0.01em"],
    home: [28, 34, 600, "-0.01em"],
    "home-phone": [26, 31, 600, "-0.01em"],
    record: [34, 39, 700, "-0.02em"],
    "record-phone": [26, 31, 700, "-0.02em"],
    capture: [18, 26],
    "capture-phone": [17, 24],
  };
  it.each(Object.entries(SCALE))("text-%s", (name, [size, line, weight, spacing]) => {
    expect(px(theme.get(`--text-${name}`))).toBe(size);
    expect(px(theme.get(`--text-${name}--line-height`))).toBe(line);
    expect(theme.get(`--text-${name}--font-weight`)).toBe(weight === undefined ? undefined : String(weight));
    expect(theme.get(`--text-${name}--letter-spacing`)).toBe(spacing);
  });

  it("gives titles of 20px and up -0.01em and the record title -0.02em, and nothing smaller any", () => {
    for (const [name, [size, , , spacing]] of Object.entries(SCALE)) {
      if (name.startsWith("record")) expect(spacing).toBe("-0.02em");
      else if (size >= 20 && name !== "capture" && name !== "capture-phone") expect(spacing).toBe("-0.01em");
      else expect(spacing).toBeUndefined();
    }
  });
});

describe("shape and size", () => {
  it.each([
    ["xs", 4],
    ["sm", 6],
    ["md", 8],
    ["lg", 12],
    ["xl", 16],
    ["pill", 999],
  ])("--radius-%s is %dpx", (name, value) => expect(px(theme.get(`--radius-${name}`))).toBe(value));

  it.each([
    ["control-sm", 30],
    ["control-md", 34],
    ["control-lg", 40],
    ["control-touch", 44],
    ["row-table", 46],
    ["row-feed", 44],
    ["row-feed-phone", 56],
  ])("--spacing-%s is %dpx", (name, value) => expect(px(theme.get(`--spacing-${name}`))).toBe(value));

  it.each([
    ["sidebar", 256],
    ["record", 760],
    ["home", 960],
    ["panel", 360],
  ])("--container-%s is %dpx", (name, value) => expect(px(theme.get(`--container-${name}`))).toBe(value));

  it("steps spacing by 4 from 2 up to 64", () => {
    const steps = [...root.keys()].filter((k) => k.startsWith("--space-")).map((k) => px(root.get(k)));
    expect(steps).toEqual([2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]);
  });

  it("pads collections 16px on phone and 40px from the desktop breakpoint", () => {
    expect(px(root.get("--gutter-phone"))).toBe(16);
    expect(px(root.get("--gutter-desktop"))).toBe(40);
    expect(root.get("--gutter")).toBe("var(--gutter-phone)");
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*:root \{\s*--gutter: var\(--gutter-desktop\);/);
  });

  it.each([
    [8, 2],
    [10, 3],
    [14, 4],
    [24, 7],
    [26, 7],
    [28, 8],
  ])("a %dpx ColorMark has radius %dpx", (size, radius) => {
    expect(px(root.get(`--mark-${size}`))).toBe(size);
    expect(px(root.get(`--mark-${size}-radius`))).toBe(radius);
  });

  it("draws the mark's edge at 12% of the text colour", () => {
    expect(root.get("--mark-edge")).toBe("color-mix(in srgb, var(--fg) 12%, transparent)");
  });
});

describe("motion", () => {
  it("has 120, 180 and 240 ms durations, and leaving 30% faster", () => {
    expect(root.get("--duration-fast")).toBe("120ms");
    expect(root.get("--duration-base")).toBe("180ms");
    expect(root.get("--duration-slow")).toBe("240ms");
    for (const name of ["fast", "base", "slow"]) {
      expect(root.get(`--duration-${name}-leave`)).toBe(`calc(var(--duration-${name}) * 0.7)`);
    }
  });

  it("eases entering out, and uses the fast duration for transitions by default", () => {
    expect(theme.get("--ease-enter")).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(theme.get("--default-transition-duration")).toBe("var(--duration-fast)");
    expect(theme.get("--default-transition-timing-function")).toBe("var(--ease-enter)");
  });

  it("turns movement into 120 ms opacity fades under prefers-reduced-motion", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/animation: ob-fade-in var\(--duration-fast\)/);
    expect(block).toMatch(/transition-property: opacity !important/);
    expect(block).toMatch(/transition-duration: var\(--duration-fast\) !important/);
  });

  it("keeps the 16px minimum for inputs on touch screens", () => {
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 639\.98px\) \{[\s\S]*?font-size: max\(16px, 1em\);/);
  });
});
