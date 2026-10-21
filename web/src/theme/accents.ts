/**
 * Accent colours: the app's primary colour, chosen per person from the hues projects and workspaces
 * are coloured with (lib/colors.ts), blue by default.
 *
 * The primary is the colour itself: the saturated swatch of the palette (`.choice-<hue>_dark`, the
 * colour a person sees when they pick it for a project), a small step deeper and calmer so a large
 * fill does not glare, the same in light and dark mode, always with white text on it: the light
 * swatches (cyan, teal, green, yellow, orange) go only as much deeper as white text needs to read.
 * Buttons, switches, checkboxes and the selected row of a menu are filled with it. Where the accent is text on a page (`--primary-text`: links,
 * active labels) or a focus ring, it is the swatch too unless that would not read, and then only
 * its lightness moves (darker on a light page, lighter on a dark one) until WCAG AA holds; hue and
 * chroma stay. The soft fill is a wash of the swatch over the surface.
 *
 * The page, cards, menu and top bar and the text are plain greys at the lightness of the reference
 * greys in styles/index.css; lines take a touch of the accent (`NEUTRAL_TINT`) and a hover is a light
 * wash of the primary, less than a selection's fill. Every
 * pairing in `CONTRAST_RULES` is held to AA.
 *
 * The result is the CSS in styles/accents.css (accents.test.ts keeps that file in step with this
 * generator) and the grid's canvas theme (views/grid/glide/theme.ts), which cannot read CSS.
 */
import { PALETTE } from "@/lib/cells/palette";
import { contrast, hexToOklch, oklchToHex, type Oklch } from "./oklch";

/** The accent colours, in the palette's order. */
export const ACCENTS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "blue";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

export type Mode = "light" | "dark";

/** The tokens of styles/index.css that follow the accent. */
export const ACCENT_TOKENS = [
  "bg",
  "surface",
  "chrome",
  "subtle",
  "hover",
  "line",
  "line-strong",
  "fg",
  "muted",
  "faint",
  "primary",
  "primary-hover",
  "primary-fg",
  "primary-text",
  "primary-soft",
  "primary-soft-line",
  "primary-ink",
  "ring",
] as const;
export type AccentToken = (typeof ACCENT_TOKENS)[number];
export type TokenSet = Record<AccentToken, string>;

/**
 * The reference tokens in styles/index.css (accents.test.ts checks they match): the original blue
 * theme, whose greys give every accent's neutrals their lightness.
 */
export const BLUE: Record<Mode, TokenSet> = {
  light: {
    bg: "#f6f7f9",
    surface: "#ffffff",
    chrome: "#ffffff",
    subtle: "#f0f2f5",
    hover: "#e8ebf0",
    line: "#dfe3ea",
    "line-strong": "#c4cad4",
    fg: "#1b1f27",
    muted: "#566070",
    faint: "#636d7e",
    primary: "#1f5ae0",
    "primary-hover": "#1848b8",
    "primary-fg": "#ffffff",
    "primary-text": "#1f5ae0",
    "primary-soft": "#e4ecff",
    "primary-soft-line": "#c9d8ff",
    "primary-ink": "#12358a",
    ring: "#1f5ae0",
  },
  dark: {
    bg: "#12151b",
    surface: "#1a1e26",
    chrome: "#1a1e26",
    subtle: "#232833",
    hover: "#2c3240",
    line: "#2f3542",
    "line-strong": "#444c5c",
    fg: "#e8ebf1",
    muted: "#a4adbd",
    faint: "#8893a4",
    primary: "#6b97ff",
    "primary-hover": "#86a9ff",
    "primary-fg": "#0b1220",
    "primary-text": "#6b97ff",
    "primary-soft": "#1f2d52",
    "primary-soft-line": "#2f4475",
    "primary-ink": "#b9ccff",
    ring: "#7aa1ff",
  },
};

/**
 * Accents whose palette colour does not read as their name: the palette's pink is a magenta, so the
 * pink accent starts from a true pink (a light one, so the generator deepens it for white text).
 */
const SOURCE: Partial<Record<Accent, { bg: string; fg: string }>> = {
  pink: { bg: "#ec4899", fg: "#2e0716" },
};

/** The swatch of an accent: the palette's saturated colour (or its `SOURCE`) and the text it carries. */
export function swatch(accent: Accent): { bg: string; fg: string } {
  return SOURCE[accent] ?? PALETTE[`${accent}_dark`]!;
}

/**
 * Share of `NEUTRAL_TINT` the hovers and lines take, per mode: a warm tint reads as brown on dark
 * greys, and grey's own tint is a cool slate kept light so it stays a grey.
 */
const TINT: Record<Accent, Record<Mode, number>> = {
  blue: { light: 1, dark: 1 },
  cyan: { light: 1, dark: 0.9 },
  teal: { light: 0.95, dark: 0.75 },
  green: { light: 0.9, dark: 0.65 },
  yellow: { light: 0.9, dark: 0.5 },
  orange: { light: 0.85, dark: 0.5 },
  red: { light: 0.8, dark: 0.5 },
  pink: { light: 0.85, dark: 0.55 },
  purple: { light: 1, dark: 0.85 },
  gray: { light: 0.3, dark: 0.35 },
};

/**
 * The neutral tokens: OKLCH chroma at full tint (lightness is the reference grey's, except where
 * given). The page, cards, the menu and top bar (`chrome`) and the text are plain greys, with no
 * cast of the accent or of blue; hovers and lines carry a touch of the accent. `chrome` sits a
 * step off the page so the menu and top bar read as the app's frame.
 */
const NEUTRAL_TINT: Record<Mode, Partial<Record<AccentToken, { c: number; l?: number }>>> = {
  light: {
    bg: { c: 0 },
    surface: { c: 0 },
    chrome: { c: 0, l: 0.975 },
    subtle: { c: 0 },
    hover: { c: 0.024 },
    line: { c: 0.016 },
    "line-strong": { c: 0.022 },
    fg: { c: 0 },
    muted: { c: 0 },
    faint: { c: 0 },
  },
  dark: {
    bg: { c: 0 },
    surface: { c: 0 },
    chrome: { c: 0, l: 0.215 },
    subtle: { c: 0 },
    hover: { c: 0.03 },
    line: { c: 0.016 },
    "line-strong": { c: 0.022 },
    fg: { c: 0 },
    muted: { c: 0 },
    faint: { c: 0 },
  },
};
/** How far the fill sits below the swatch: a little less light, then a tenth darker still, and a little less chroma. */
const DIM = { l: 0.03, scale: 0.9, c: 0.94 };
/** The soft fill and its line: shares of the swatch washed over the surface. */
const WASH: Record<Mode, { soft: number; line: number; hover: number }> = { light: { soft: 0.24, line: 0.45, hover: 0.12 }, dark: { soft: 0.34, line: 0.55, hover: 0.22 } };

const NEUTRALS: readonly AccentToken[] = ["bg", "surface", "chrome", "subtle", "hover", "line", "line-strong", "fg", "muted", "faint"];
const PAGES = ["bg", "surface", "chrome", "subtle", "hover"] as const;

/** [text, background, minimum ratio]: WCAG AA is 4.5 for text and 3 for controls and focus rings. */
export const CONTRAST_RULES: readonly (readonly [AccentToken, AccentToken, number])[] = [
  ...([...PAGES, "primary-soft"] as const).flatMap((bg) => [
    ["fg", bg, 4.5] as const,
    ["muted", bg, 4.5] as const,
    ["primary-text", bg, 4.5] as const,
  ]),
  ...(["bg", "surface", "chrome", "subtle"] as const).map((bg) => ["faint", bg, 4.5] as const),
  ["primary-fg", "primary", 4.5],
  ["primary-fg", "primary-hover", 4.5],
  ["primary-ink", "primary-soft", 4.5],
  ["primary-ink", "surface", 4.5],
  ["ring", "surface", 3],
  ["ring", "bg", 3],
  ["ring", "chrome", 3],
];

/**
 * Moves a token's lightness one way (`dir` -1 darker, +1 lighter) until it meets every rule it takes
 * part in against the tokens already settled. Hue and chroma stay (chroma only as far as sRGB allows).
 */
function settle(tokens: Partial<TokenSet>, name: AccentToken, start: Oklch, dir: -1 | 1): string {
  const rules = CONTRAST_RULES.filter(([a, b]) => (a === name && tokens[b]) || (b === name && tokens[a]));
  const passes = (hex: string) => rules.every(([a, b, min]) => contrast(a === name ? hex : tokens[a]!, b === name ? hex : tokens[b]!) >= min);
  let color = start;
  let hex = oklchToHex(color);
  for (let i = 0; i < 250 && !passes(hex); i++) {
    color = { ...color, l: Math.min(1, Math.max(0, color.l + dir * 0.004)) };
    hex = oklchToHex(color);
  }
  return hex;
}

/** Distance in OKLab: about 0.02 is a just-visible step between two flat fills. */
export function distance(x: string, y: string): number {
  const [a, b] = [hexToOklch(x), hexToOklch(y)];
  const rad = Math.PI / 180;
  return Math.hypot(a.l - b.l, a.c * Math.cos(a.h * rad) - b.c * Math.cos(b.h * rad), a.c * Math.sin(a.h * rad) - b.c * Math.sin(b.h * rad));
}

/** `share` of `top` over `base`, mixed in sRGB like CSS `color-mix(in srgb, …)`. */
function wash(top: string, base: string, share: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(top, i) * share + ch(base, i) * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/** `share` of `top` over `base`, mixed in OKLab (like CSS `color-mix(in oklab, …)`): a tint keeps its hue. */
function washOklab(top: string, base: string, share: number): string {
  const [t, b] = [hexToOklch(top), hexToOklch(base)];
  const rad = Math.PI / 180;
  const ab = (c: Oklch) => [c.c * Math.cos(c.h * rad), c.c * Math.sin(c.h * rad)] as const;
  const [[ta, tb], [ba, bb]] = [ab(t), ab(b)];
  const [a, bk] = [ta * share + ba * (1 - share), tb * share + bb * (1 - share)];
  return oklchToHex({ l: t.l * share + b.l * (1 - share), c: Math.hypot(a, bk), h: ((Math.atan2(bk, a) / rad) + 360) % 360 });
}

function generate(accent: Accent, mode: Mode): TokenSet {
  const base = BLUE[mode];
  const { bg: fill } = swatch(accent);
  const color = hexToOklch(fill);
  const out: Partial<TokenSet> = {};
  // Text and rings move away from the page: darker on a light one, lighter on a dark one.
  const away = mode === "light" ? -1 : 1;

  // Neutrals first: everything else is checked against them.
  for (const name of NEUTRALS) {
    const tint = NEUTRAL_TINT[mode][name]!;
    const c = { l: tint.l ?? hexToOklch(base[name]).l, c: tint.c * TINT[accent][mode], h: color.h };
    out[name] = settle(out, name, c, away);
  }

  // The fill is the swatch a step deeper and calmer (`DIM`) with white text on it, deeper still (hue
  // kept) where white would not read yet; its hover is a step deeper again.
  out["primary-fg"] = "#ffffff";
  out.primary = settle(out, "primary", { l: (color.l - DIM.l) * DIM.scale, c: color.c * DIM.c, h: color.h }, -1);
  const primary = hexToOklch(out.primary);
  out["primary-hover"] = settle(out, "primary-hover", { ...primary, l: primary.l - 0.06 }, -1);

  // A hover is a light wash of the primary, short of a selection's full fill, thinned if text on it
  // would stop reading.
  const textPasses = (hex: string) => contrast(out.fg!, hex) >= 4.5 && contrast(out.muted!, hex) >= 4.5;
  let hoverShare = WASH[mode].hover;
  while (hoverShare > 0.04 && !textPasses(washOklab(out.primary, out.surface!, hoverShare))) hoverShare -= 0.01;
  out.hover = washOklab(out.primary, out.surface!, hoverShare);

  // The soft fill: a wash of the swatch, thinned until the text on it still reads.
  let share = WASH[mode].soft;
  const softPasses = (hex: string) => contrast(out.fg!, hex) >= 4.5 && contrast(out.muted!, hex) >= 4.5;
  while (share > 0.04 && !softPasses(wash(out.primary, out.surface!, share))) share -= 0.02;
  // …and thickened where it would look like a hover (grey on grey), while the text still reads.
  while (share < 0.7 && distance(wash(out.primary, out.surface!, share), out.hover!) < 0.03 && softPasses(wash(out.primary, out.surface!, share + 0.02))) share += 0.02;
  out["primary-soft"] = wash(out.primary, out.surface!, share);
  out["primary-soft-line"] = wash(out.primary, out.surface!, WASH[mode].line);

  out["primary-text"] = settle(out, "primary-text", primary, away);
  out.ring = settle(out, "ring", primary, away);
  // Ink: the accent as emphasis text on its soft fill, a step beyond the text shade.
  const text = hexToOklch(out["primary-text"]);
  out["primary-ink"] = settle(out, "primary-ink", { ...text, l: text.l + away * 0.1 }, away);
  return out as TokenSet;
}

/** Every accent's tokens in both modes, blue's too: styles/index.css holds only the reference shades. */
export const ACCENT_THEMES: Record<Accent, Record<Mode, TokenSet>> = Object.fromEntries(
  ACCENTS.map((a) => [a, { light: generate(a, "light"), dark: generate(a, "dark") }]),
) as Record<Accent, Record<Mode, TokenSet>>;

/**
 * A grey of the reference theme that is not one of the tokens (the grid has a few in-between greys
 * for its header and lines): the same lightness as a plain grey, like the page's own greys.
 */
export function turnNeutral(hex: string): string {
  return oklchToHex({ l: hexToOklch(hex).l, c: 0, h: 0 });
}

/** The CSS for styles/accents.css: one block per accent and mode, keyed by `<html data-accent>`. */
export function accentCss(): string {
  const lines = [
    "/*",
    " * Generated by src/theme/accents.ts; do not edit. Update with",
    " *   npx vitest run src/theme/accents.test.ts -u",
    " * The accent colour a person picks (<html data-accent>, set before first paint by",
    " * public/theme-init.js) replaces the reference tokens of index.css.",
    " */",
  ];
  for (const accent of ACCENTS) {
    for (const mode of ["light", "dark"] as const) {
      const selector = mode === "light" ? `:root:not([data-theme="dark"])[data-accent="${accent}"]` : `:root[data-theme="dark"][data-accent="${accent}"]`;
      lines.push(`${selector} {`);
      for (const token of ACCENT_TOKENS) lines.push(`  --${token}: ${ACCENT_THEMES[accent][mode][token]};`);
      lines.push("}");
    }
  }
  return `${lines.join("\n")}\n`;
}
