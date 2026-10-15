import { COLORS, isChoiceColor, type ChoiceColor } from "./colors";

// Gray is left out: a workspace without a colour of its own should still be told apart by it.
const FALLBACKS = COLORS.slice(0, 9);

/**
 * A workspace's palette colour: its own, or one picked by a stable hash of its name, so a
 * workspace from before workspaces had colours looks the same everywhere it is drawn.
 */
export function workspaceColor(ws: { name: string; color?: string | null }): ChoiceColor {
  if (isChoiceColor(ws.color)) return ws.color;
  let h = 0;
  for (let i = 0; i < ws.name.length; i++) h = (h * 31 + ws.name.charCodeAt(i)) >>> 0;
  return FALLBACKS[h % FALLBACKS.length]!;
}
