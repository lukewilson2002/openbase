/**
 * The fixed colour palette shared with the server (`ob_core::field::COLORS`).
 * Each name has a matching `.choice-<name>` CSS class in styles/index.css.
 * `colors.test.ts` checks this list against the Rust source so they cannot drift.
 */
export const COLORS = [
  "blue",
  "cyan",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "gray",
  "blue_dark",
  "cyan_dark",
  "teal_dark",
  "green_dark",
  "yellow_dark",
  "orange_dark",
  "red_dark",
  "pink_dark",
  "purple_dark",
  "gray_dark",
] as const;

export type ChoiceColor = (typeof COLORS)[number];

export function isChoiceColor(value: string | null | undefined): value is ChoiceColor {
  return !!value && (COLORS as readonly string[]).includes(value);
}

/** CSS classes for a choice pill; unknown colours fall back to gray. */
export function choiceClass(color: string | null | undefined): string {
  return `choice choice-${isChoiceColor(color) ? color : "gray"}`;
}

/** Human label: "blue_dark" -> "Dark blue". */
export function colorLabel(color: ChoiceColor): string {
  const [hue = "", dark] = color.split("_");
  const name = hue.charAt(0).toUpperCase() + hue.slice(1);
  return dark ? `Dark ${hue}` : name;
}

/** The hue of a palette colour, which the accent classes are keyed by ("green_dark" -> "green"). */
export function accentHue(color: string | null | undefined): string {
  return (isChoiceColor(color) ? color : "gray").replace(/_dark$/, "");
}

export type AccentStyle = "tint" | "solid" | "button";

/**
 * Classes that paint something in a workspace's or base's colour (styles/index.css, "Accents"):
 * `tint` for a base tile, `solid` for a workspace tile, `button` for a base-coloured button.
 */
export function accentClass(color: string | null | undefined, style: AccentStyle): string {
  return `ob-hue-${accentHue(color)} ${style === "button" ? "ob-tint-button" : `ob-${style}`}`;
}

/**
 * A small dot in a choice's colour (a stack, a group, a calendar chip): the hue's strong shade, which
 * stays visible on white and on the dark surfaces where the light pill colours fade into the page.
 */
export function colorDotClass(color: string | null | undefined): string {
  return `ob-hue-${accentHue(color)} ob-dot`;
}

/** A soft button in the base's colour (the views' "Add"): tint background, dark text, thin line. */
export function baseAccentButtonClass(color: string | null | undefined): string {
  return accentClass(color, "button");
}

/** Stable colour per identity (email, else name), so the same person looks the same everywhere. */
export function personColor(seed: string): ChoiceColor {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % 10] ?? "gray";
}

/**
 * The `.ob-hue-*` shades as hex, for the grid, which draws on a canvas and cannot use the CSS
 * classes. colors.test.ts checks these against styles/index.css so the two cannot drift apart.
 */
export const ACCENT_SHADES: Readonly<Record<string, string>> = {
  blue: "#1f5ae0",
  cyan: "#0e7490",
  teal: "#0f766e",
  green: "#157a39",
  yellow: "#8a5a00",
  orange: "#a85a0a",
  red: "#c4261d",
  pink: "#b0175a",
  purple: "#6b3fc4",
  gray: "#566070",
};

/** The strong shade of a palette colour as hex (see ACCENT_SHADES). */
export function accentShade(color: string | null | undefined): string {
  return ACCENT_SHADES[accentHue(color)] ?? ACCENT_SHADES.gray!;
}

