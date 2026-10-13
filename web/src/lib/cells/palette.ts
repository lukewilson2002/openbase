/**
 * Canvas colours for the 20-colour choice palette. These mirror the `.choice-*` CSS classes in
 * styles/index.css (canvas cannot read CSS classes); `palette.test.ts` checks they stay in sync.
 */
export interface PaletteEntry {
  bg: string;
  fg: string;
}

export const PALETTE: Record<string, PaletteEntry> = {
  blue: { bg: "#cfdfff", fg: "#14315f" },
  cyan: { bg: "#c9eefc", fg: "#0a3a52" },
  teal: { bg: "#bff3e8", fg: "#0a3f37" },
  green: { bg: "#ccf4bd", fg: "#163d0c" },
  yellow: { bg: "#ffe9a8", fg: "#4a3500" },
  orange: { bg: "#fedcc8", fg: "#5a2208" },
  red: { bg: "#ffd6df", fg: "#6b0f26" },
  pink: { bg: "#ffd3f3", fg: "#6b0f55" },
  purple: { bg: "#e6d9fe", fg: "#3b1a7a" },
  gray: { bg: "#e4e6ea", fg: "#2b303a" },
  blue_dark: { bg: "#1f5fcf", fg: "#ffffff" },
  cyan_dark: { bg: "#1fb2ee", fg: "#04283a" },
  teal_dark: { bg: "#1fcfc4", fg: "#032d29" },
  green_dark: { bg: "#23b536", fg: "#03260a" },
  yellow_dark: { bg: "#f5b400", fg: "#2e2100" },
  orange_dark: { bg: "#f2641f", fg: "#2e0e00" },
  red_dark: { bg: "#d6183f", fg: "#ffffff" },
  pink_dark: { bg: "#c4078f", fg: "#ffffff" },
  purple_dark: { bg: "#6d33d6", fg: "#ffffff" },
  gray_dark: { bg: "#585e6b", fg: "#ffffff" },
};

export function paletteColor(name: string | undefined): PaletteEntry {
  return (name && PALETTE[name]) || PALETTE.gray!;
}

/** Colour of a rating icon (the `color` option of a rating field). */
export function ratingColor(name: string): string {
  const e = PALETTE[name] ?? PALETTE.yellow!;
  // Light variants are too pale to read as an icon; use their foreground.
  return name.endsWith("_dark") ? e.bg : e.fg;
}

/**
 * A colour for small marks (the dot of a stack or lane, the bar at the edge of a coloured row).
 * The light palette entries are chip backgrounds, far too pale for a 10 px dot on a white or grey
 * surface (about 1.3:1); mixing in the chip text colour gives at least 3:1 against the light and
 * the dark surfaces. The `_dark` entries are saturated already.
 */
export function swatchColor(name: string | undefined): string {
  const e = paletteColor(name);
  return name?.endsWith("_dark") ? e.bg : mixColors(e.bg, e.fg, 0.55);
}

/** Mix `fg` over `bg` by `amount` (0..1); both are `#rrggbb`. */
export function mixColors(bg: string, fg: string, amount: number): string {
  const parse = (c: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c.trim());
    return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [255, 255, 255];
  };
  const a = parse(bg);
  const b = parse(fg);
  const mix = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * amount);
  return `#${[mix(0), mix(1), mix(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
