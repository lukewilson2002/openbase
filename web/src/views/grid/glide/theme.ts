/** Glide themes mirroring the CSS tokens in styles/index.css (canvas cannot read CSS variables reliably at theme-switch time). */
import type { Theme } from "@glideapps/glide-data-grid";
import { ACCENT_THEMES, ACCENT_TOKENS, BLUE, turnNeutral, type Accent, type AccentToken } from "@/theme/accents";

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const common: Partial<Theme> = {
  cellHorizontalPadding: 14,
  cellVerticalPadding: 3,
  headerFontStyle: "600 14px",
  baseFontStyle: "14px",
  markerFontStyle: "11px",
  fontFamily: FONT,
  editorFontSize: "13px",
  lineHeight: 1.4,
  headerIconSize: 16,
  roundingRadius: 4,
  bgSearchResult: "#fff3a3",
};

export const LIGHT_THEME: Partial<Theme> = {
  ...common,
  accentColor: "#1f5ae0",
  accentFg: "#ffffff",
  accentLight: "#e4ecff",
  textDark: "#1b1f27",
  textMedium: "#566070",
  textLight: "#636d7e",
  textBubble: "#1b1f27",
  bgIconHeader: "#566070",
  fgIconHeader: "#ffffff",
  textHeader: "#566070",
  textHeaderSelected: "#ffffff",
  bgCell: "#ffffff",
  bgCellMedium: "#f6f7f9",
  bgHeader: "#f6f7f9",
  bgHeaderHasFocus: "#e8ebf0",
  bgHeaderHovered: "#eceff4",
  bgBubble: "#e8ebf0",
  bgBubbleSelected: "#ffffff",
  borderColor: "#dfe3ea",
  horizontalBorderColor: "#eef0f4",
  drilldownBorder: "#c4cad4",
  linkColor: "#1d4fd0",
};

export const DARK_THEME: Partial<Theme> = {
  ...common,
  accentColor: "#6b97ff",
  accentFg: "#0b1220",
  accentLight: "#1f2d52",
  textDark: "#e8ebf1",
  textMedium: "#a4adbd",
  textLight: "#8893a4",
  textBubble: "#e8ebf1",
  bgIconHeader: "#a4adbd",
  fgIconHeader: "#1a1e26",
  textHeader: "#a4adbd",
  textHeaderSelected: "#0b1220",
  bgCell: "#1a1e26",
  bgCellMedium: "#232833",
  bgHeader: "#232833",
  bgHeaderHasFocus: "#2c3240",
  bgHeaderHovered: "#2a303c",
  bgBubble: "#2c3240",
  bgBubbleSelected: "#1a1e26",
  borderColor: "#2f3542",
  horizontalBorderColor: "#262b35",
  drilldownBorder: "#444c5c",
  linkColor: "#7aa1ff",
};

/** The blue token each colour of the themes above stands for (the first one, where two share a value). */
const TOKEN_OF = {
  light: tokenLookup("light"),
  dark: tokenLookup("dark"),
};

function tokenLookup(mode: "light" | "dark"): Map<string, AccentToken> {
  const map = new Map<string, AccentToken>();
  for (const token of ACCENT_TOKENS) if (!map.has(BLUE[mode][token])) map.set(BLUE[mode][token], token);
  return map;
}

const cache = new Map<string, Partial<Theme>>();

/**
 * The grid's theme in an accent colour: each colour of the blue theme becomes the same token of the
 * accent's (theme/accents.ts), and the in-between greys become plain greys like the page's.
 * The selection is the accent's swatch with its own text colour; links take the readable text shade.
 */
export function gridTheme(dark: boolean, accent: Accent): Partial<Theme> {
  const base = dark ? DARK_THEME : LIGHT_THEME;
  const key = `${accent}:${dark ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const mode = dark ? "dark" : "light";
  const tokens = ACCENT_THEMES[accent][mode];
  const out: Record<string, unknown> = { ...base };
  for (const [name, value] of Object.entries(base)) {
    if (name in common || typeof value !== "string" || !value.startsWith("#")) continue;
    const token = TOKEN_OF[mode].get(value);
    out[name] = token ? tokens[token] : turnNeutral(value);
  }
  // The fill and the text on it are a pair; links are the accent's readable text shade.
  out.accentColor = tokens.primary;
  out.accentFg = tokens["primary-fg"];
  out.textHeaderSelected = tokens["primary-fg"];
  out.linkColor = tokens["primary-text"];
  cache.set(key, out as Partial<Theme>);
  return out as Partial<Theme>;
}
