/**
 * How many of the toolbar's tools (Filter, Sort, Group, Hide fields, Color, Row height, in that
 * order) fit in one row beside the parts that always stay (the view's own setting, its extras),
 * with More after them. Tools leave from the right end first, into More, and come back in the same
 * order as room returns.
 *
 * Widths are measured from an invisible copy of every tool, not from the tools on screen, so the
 * answer does not depend on how many are showing and cannot flip back and forth at one width.
 */
export function visibleToolCount({
  available,
  tools,
  fixed,
  more,
  moreAlways,
  gap,
}: {
  /** Width of the row the tools sit in. 0 means it has not been laid out (or there is no layout, as in tests). */
  available: number;
  /** Width of each tool, left to right. */
  tools: readonly number[];
  /** Total width of what always shows (the view's setting and extras). */
  fixed: number;
  /** Width of the More button. */
  more: number;
  /** More shows even when every tool fits, because it has items of its own. */
  moreAlways: boolean;
  /** Space between two items. */
  gap: number;
}): number {
  if (available <= 0) return tools.length;
  const fixedCount = fixed > 0 ? 1 : 0;
  for (let k = tools.length; k >= 0; k--) {
    const withMore = moreAlways || k < tools.length;
    const items = fixedCount + k + (withMore ? 1 : 0);
    const width = fixed + tools.slice(0, k).reduce((sum, w) => sum + w, 0) + (withMore ? more : 0) + Math.max(0, items - 1) * gap;
    if (width <= available) return k;
  }
  return 0;
}
