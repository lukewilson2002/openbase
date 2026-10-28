/**
 * The long press of a finger on a cell, which opens the row menu: the touch route to what a right-click
 * does with a mouse. Glide opens its own context menu on a long touch only for a cell that was already
 * selected, and a press that ends in a scroll or a drag must not open anything, so the grid watches the
 * touch itself and asks Glide where the finger is.
 */

/** How long a finger rests before it counts as a long press (the same as Glide's own). */
export const LONG_PRESS_MS = 500;
/** How far it may drift before the press counts as a swipe. */
export const LONG_PRESS_TOLERANCE_PX = 10;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Region {
  y: number;
  height: number;
}

/**
 * The cell under a point of the screen, found through the bounds Glide reports for the cells on show:
 * the visible rows (`region`) and every column. Null over the header, the gaps and the add-field column.
 */
export function cellAtPoint(bounds: (col: number, row: number) => Box | undefined, region: Region, columnCount: number, x: number, y: number): { col: number; row: number } | null {
  for (let row = Math.max(0, region.y); row <= region.y + region.height; row++) {
    const rowBox = bounds(0, row);
    if (!rowBox || y < rowBox.y || y >= rowBox.y + rowBox.height) continue;
    for (let col = 0; col < columnCount; col++) {
      const box = bounds(col, row);
      if (box && x >= box.x && x < box.x + box.width) return { col, row };
    }
    return null;
  }
  return null;
}
