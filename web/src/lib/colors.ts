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

/**
 * The strong shade of each hue (a colour and its "_dark" variant share one), for colours drawn as
 * a solid tile with white text (workspaces) or as a soft tint with the icon in this shade (bases).
 * Every shade keeps white text at 4.5:1 or better (colors.test.ts).
 */
const HUES: Record<string, string> = {
  blue: "#1f5ae0",
  cyan: "#0e7490",
  teal: "#0f766e",
  green: "#157a39",
  yellow: "#8a5a00",
  orange: "#ad600a",
  red: "#c4261d",
  pink: "#b0175a",
  purple: "#6b3fc4",
  gray: "#566070",
};

/** The strong shade of a palette colour ("green_dark" gives the green one); unknown names get gray. */
export function colorHue(color: string | null | undefined): string {
  return HUES[(color ?? "").replace(/_dark$/, "")] ?? HUES.gray!;
}
