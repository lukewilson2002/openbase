import { isChoiceColor, type ChoiceColor } from "./colors";

/**
 * Hues a workspace without a colour of its own is given, in an order that keeps the first few
 * names a person makes visibly different from each other.
 */
const FALLBACK: readonly ChoiceColor[] = ["green", "blue", "purple", "orange", "teal", "pink", "cyan", "red", "yellow", "gray"];

/**
 * A workspace's colour: its own when the server sends one, else one picked from its name, so the
 * same workspace looks the same everywhere and on every device until it has a colour of its own.
 * Takes the shape structurally because older servers do not send `color` at all.
 */
export function workspaceColor(ws: { name: string; color?: string | null }): ChoiceColor {
  if (isChoiceColor(ws.color)) return ws.color;
  let h = 0;
  for (const ch of ws.name.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length]!;
}
