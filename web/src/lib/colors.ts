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
