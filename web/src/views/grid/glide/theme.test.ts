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
});
