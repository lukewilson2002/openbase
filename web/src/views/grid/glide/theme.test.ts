import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENTS, ACCENT_THEMES } from "@/theme/accents";
import { contrast } from "@/theme/oklch";
import { DARK_THEME, LIGHT_THEME, gridTheme } from "./theme";

describe("gridTheme", () => {
  it("keeps the reference theme's layout and draws blue in blue's generated tokens", () => {
    expect(gridTheme(false, "blue").cellHorizontalPadding).toBe(LIGHT_THEME.cellHorizontalPadding);
    expect(gridTheme(true, "blue").accentColor).toBe(ACCENT_THEMES.blue.dark.primary);
    expect(DARK_THEME.accentColor).toBe("#6b97ff");
  });

  it.each(ACCENTS)("draws %s in its tokens, with readable links and text", (accent) => {
    for (const dark of [false, true]) {
      const t = gridTheme(dark, accent);
      const tokens = ACCENT_THEMES[accent][dark ? "dark" : "light"];
      expect(t.accentColor).toBe(tokens.primary);
      expect(t.accentLight).toBe(tokens["primary-soft"]);
      expect(t.bgCell).toBe(tokens.surface);
      expect(t.textDark).toBe(tokens.fg);
      expect(t.bgSearchResult, "search highlights stay yellow").toBe(LIGHT_THEME.bgSearchResult);
      for (const [name, value] of Object.entries(t)) if (typeof value === "string" && value.startsWith("#")) expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(t.linkColor!, t.bgCell!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.textMedium!, t.bgHeader!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reads the Notebook tokens of styles/index.css in both themes", () => {
    // The canvas cannot read CSS variables, so the theme repeats them; this keeps the two from drifting.
    const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");
    const tokens = (selector: string): Record<string, string> => {
      const block = css.slice(css.indexOf(selector));
      const body = block.slice(block.indexOf("{") + 1, block.indexOf("\n}"));
      return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
    };
    for (const [theme, selector] of [
      [LIGHT_THEME, ":root,\n:root[data-theme=\"light\"]"],
      [DARK_THEME, ":root[data-theme=\"dark\"] {"],
    ] as const) {
      const t = tokens(selector);
      expect(theme.bgCell).toBe(t["surface"]);
      expect(theme.bgHeader, "the header sits on the page's grey").toBe(t["bg"]);
      expect(theme.textDark).toBe(t["fg"]);
      expect(theme.textHeader, "header text is muted").toBe(t["muted"]);
      expect(theme.textLight).toBe(t["faint"]);
      expect(theme.borderColor).toBe(t["line"]);
      expect(theme.accentColor).toBe(t["primary"]);
      expect(theme.accentLight, "selection is primary-soft").toBe(t["primary-soft"]);
    }
  });

  it("sets the header row at 12 px, 600", () => {
    expect(LIGHT_THEME.headerFontStyle).toBe("600 12px");
    expect(DARK_THEME.headerFontStyle).toBe("600 12px");
  });
});
