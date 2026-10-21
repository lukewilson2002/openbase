import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLORS, accentHue } from "@/lib/colors";
import { ACCENTS, ACCENT_THEMES, ACCENT_TOKENS, BLUE, CONTRAST_RULES, accentCss, distance, isAccent, swatch } from "./accents";
import { contrast, hexToOklch, oklchToHex } from "./oklch";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("oklch", () => {
  it("round-trips sRGB colours", () => {
    for (const hex of ["#000000", "#ffffff", "#1f5ae0", "#f5b400", "#c4078f", "#566070"]) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
  });

  it("clamps chroma into the sRGB gamut, keeping the hue", () => {
    const hex = oklchToHex({ l: 0.9, c: 0.4, h: 145 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexToOklch(hex).h).toBeCloseTo(145, 0);
  });

  it("measures WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#1f5ae0", "#ffffff")).toBeCloseTo(5.84, 2);
  });
});

describe("accent colours", () => {
  it("are the hues projects and workspaces are coloured with", () => {
    expect([...ACCENTS]).toEqual([...new Set(COLORS.map(accentHue))]);
    expect(isAccent("teal")).toBe(true);
    expect(isAccent("teal_dark")).toBe(false);
  });

  it("start from the blue tokens in styles/index.css", () => {
    const css = read("../styles/index.css");
    for (const [mode, selector] of [
      ["light", ':root[data-theme="light"]'],
      ["dark", ':root[data-theme="dark"]'],
    ] as const) {
      const block = css.slice(css.indexOf(`${selector} {`));
      const body = block.slice(0, block.indexOf("}"));
      for (const token of ACCENT_TOKENS) expect(new RegExp(`--${token}:\\s*${BLUE[mode][token]};`).test(body), `${mode} --${token}`).toBe(true);
    }
  });

  it.each(ACCENTS.flatMap((a) => (["light", "dark"] as const).map((m) => [a, m] as const)))("%s in %s mode meets WCAG AA", (accent, mode) => {
    const t = ACCENT_THEMES[accent][mode];
    for (const [fg, bg, min] of CONTRAST_RULES) expect(contrast(t[fg], t[bg]), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(min);
  });

  it("tint the neutrals without turning them into colours", () => {
    for (const accent of ACCENTS)
      for (const mode of ["light", "dark"] as const)
        for (const token of ["bg", "surface", "subtle", "line"] as const) expect(hexToOklch(ACCENT_THEMES[accent][mode][token]).c, `${accent} ${mode} --${token}`).toBeLessThan(0.045);
  });

  it("hover in a light wash of the primary: its hue, nearer the surface than the primary, with text still readable", () => {
    for (const accent of ACCENTS)
      for (const mode of ["light", "dark"] as const) {
        const t = ACCENT_THEMES[accent][mode];
        const turn = Math.abs(hexToOklch(t.hover).h - hexToOklch(t.primary).h) % 360;
        if (accent !== "gray") expect(Math.min(turn, 360 - turn), `${accent} ${mode} hue`).toBeLessThan(20);
        expect(distance(t.hover, t.surface), `${accent} ${mode}`).toBeLessThan(distance(t.primary, t.surface) / 2);
        expect(contrast(t.fg, t.hover), `${accent} ${mode} text on hover`).toBeGreaterThanOrEqual(4.5);
      }
  });

  // The original blue theme sat at 0.020 in light mode.
  it("set a selection apart from a hover", () => {
    for (const accent of ACCENTS)
      for (const mode of ["light", "dark"] as const) {
        const t = ACCENT_THEMES[accent][mode];
        expect(distance(t["primary-soft"], t.hover), `${accent} ${mode}`).toBeGreaterThan(0.018);
      }
  });

  it("fill with the swatch a step deeper, in light and dark mode alike, always with white text on it", () => {
    for (const accent of ACCENTS) {
      const sw = hexToOklch(swatch(accent).bg);
      // The light swatches (dark text in the palette) go only as deep as white text needs.
      const lightSwatch = swatch(accent).fg !== "#ffffff";
      for (const mode of ["light", "dark"] as const) {
        const t = ACCENT_THEMES[accent][mode];
        const primary = hexToOklch(t.primary);
        expect(t.primary, `${accent} ${mode}`).toBe(ACCENT_THEMES[accent].light.primary);
        expect(t["primary-fg"], `${accent} ${mode}`).toBe("#ffffff");
        expect(contrast("#ffffff", t.primary), `${accent} white on primary`).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", t["primary-hover"]), `${accent} white on hover`).toBeGreaterThanOrEqual(4.5);
        expect(sw.l - primary.l, `${accent} lightness step`).toBeGreaterThanOrEqual(0);
        // Only as deep as white needs, or as the usual calming step takes it (pink lands just past).
        if (lightSwatch) expect(contrast("#ffffff", t.primary), `${accent} no deeper than needed`).toBeLessThan(5.5);
        else expect(sw.l - primary.l, `${accent} lightness step`).toBeLessThanOrEqual(0.12);
        // The fill and the readable text keep the swatch's hue.
        for (const hex of [t.primary, t["primary-text"]]) expect(Math.abs(hexToOklch(hex).h - sw.h), `${accent} ${mode} hue`).toBeLessThan(accent === "gray" ? 20 : 6);
      }
    }
  });

  it("leave the page, cards, menu and text plain grey", () => {
    for (const accent of ACCENTS)
      for (const mode of ["light", "dark"] as const)
        for (const token of ["bg", "surface", "chrome", "subtle", "fg", "muted", "faint"] as const) expect(hexToOklch(ACCENT_THEMES[accent][mode][token]).c, `${accent} ${mode} --${token}`).toBeLessThan(0.002);
  });

  it("are written to styles/accents.css", async () => {
    await expect(accentCss()).toMatchFileSnapshot("../styles/accents.css");
  });
});
