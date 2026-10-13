/** Glide themes mirroring the CSS tokens in styles/index.css (canvas cannot read CSS variables reliably at theme-switch time). */
import type { Theme } from "@glideapps/glide-data-grid";

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const common: Partial<Theme> = {
  cellHorizontalPadding: 8,
  cellVerticalPadding: 3,
  headerFontStyle: "600 13px",
  baseFontStyle: "13px",
  markerFontStyle: "11px",
  fontFamily: FONT,
  editorFontSize: "13px",
  lineHeight: 1.4,
  headerIconSize: 18,
  roundingRadius: 4,
  bgSearchResult: "#fff3a3",
};

export const LIGHT_THEME: Partial<Theme> = {
  ...common,
  accentColor: "#2563eb",
  accentFg: "#ffffff",
  accentLight: "#e4ecff",
  textDark: "#1b1f27",
  textMedium: "#566070",
  textLight: "#7a8494",
  textBubble: "#1b1f27",
  bgIconHeader: "#566070",
  fgIconHeader: "#ffffff",
  textHeader: "#3b4452",
  textHeaderSelected: "#ffffff",
  bgCell: "#ffffff",
  bgCellMedium: "#f6f7f9",
  bgHeader: "#f6f7f9",
  bgHeaderHasFocus: "#e8ebf0",
  bgHeaderHovered: "#eceff4",
  bgBubble: "#e8ebf0",
  bgBubbleSelected: "#ffffff",
  borderColor: "#dfe3ea",
  drilldownBorder: "#c4cad4",
  linkColor: "#1d4fd0",
};

export const DARK_THEME: Partial<Theme> = {
  ...common,
  accentColor: "#5b8cff",
  accentFg: "#0b1220",
  accentLight: "#1f2d52",
  textDark: "#e8ebf1",
  textMedium: "#a4adbd",
  textLight: "#7f8a9c",
  textBubble: "#e8ebf1",
  bgIconHeader: "#a4adbd",
  fgIconHeader: "#1a1e26",
  textHeader: "#c9d0dc",
  textHeaderSelected: "#0b1220",
  bgCell: "#1a1e26",
  bgCellMedium: "#232833",
  bgHeader: "#232833",
  bgHeaderHasFocus: "#2c3240",
  bgHeaderHovered: "#2a303c",
  bgBubble: "#2c3240",
  bgBubbleSelected: "#1a1e26",
  borderColor: "#2f3542",
  drilldownBorder: "#444c5c",
  linkColor: "#7aa1ff",
};
