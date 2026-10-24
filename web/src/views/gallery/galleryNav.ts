/**
 * Moving around the gallery's cards with the arrow keys. The grid reflows with the window, so the
 * rows are read from where the cards are drawn rather than from a column count.
 */

export interface CardBox {
  left: number;
  top: number;
  width: number;
}

/**
 * The card an arrow key goes to from card `from`, or null when there is nowhere to go (the key's
 * edge, or a key that is not a movement). Up and Down keep to the same column: the card of the next
 * row whose middle is nearest to this one's.
 */
export function neighbourCard(boxes: readonly CardBox[], from: number, key: string): number | null {
  if (from < 0 || from >= boxes.length) return null;
  switch (key) {
    case "ArrowLeft":
      return from > 0 ? from - 1 : null;
    case "ArrowRight":
      return from < boxes.length - 1 ? from + 1 : null;
    case "Home":
      return from > 0 ? 0 : null;
    case "End":
      return from < boxes.length - 1 ? boxes.length - 1 : null;
    case "ArrowUp":
    case "ArrowDown": {
      const here = boxes[from]!;
      const down = key === "ArrowDown";
      // Cards of one row share a top; the next row is the nearest top beyond this one's.
      let rowTop: number | null = null;
      for (const b of boxes) {
        if (down ? b.top > here.top + 1 : b.top < here.top - 1) {
          if (rowTop === null || (down ? b.top < rowTop : b.top > rowTop)) rowTop = b.top;
        }
      }
      if (rowTop === null) return null;
      const mid = here.left + here.width / 2;
      let best: number | null = null;
      let bestDist = Infinity;
      boxes.forEach((b, i) => {
        if (Math.abs(b.top - rowTop!) > 1) return;
        const d = Math.abs(b.left + b.width / 2 - mid);
        if (d < bestDist) {
          best = i;
          bestDist = d;
        }
      });
      return best;
    }
    default:
      return null;
  }
}

/** Whether the card is on the last row of the grid (Down from it would need more cards to be loaded). */
export function onLastRow(boxes: readonly CardBox[], index: number): boolean {
  const here = boxes[index];
  return !!here && boxes.every((b) => b.top <= here.top + 1);
}

/**
 * The card focus goes to when `deleted` cards are removed: the first one left after the first
 * deleted card, else the last one before it. Null when none is left.
 */
export function survivorAfterDelete(ids: readonly string[], deleted: ReadonlySet<string>): string | null {
  const first = ids.findIndex((id) => deleted.has(id));
  if (first < 0) return null;
  const after = ids.slice(first).find((id) => !deleted.has(id));
  if (after) return after;
  for (let i = first - 1; i >= 0; i--) if (!deleted.has(ids[i]!)) return ids[i]!;
  return null;
}
