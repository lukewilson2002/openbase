/**
 * Glide selects the first visible cell whenever its canvas gains focus with nothing selected, so a
 * keyboard user has somewhere to start. It means to skip that when a pointer gave the focus, but the
 * check depends on timing: on a phone, tapping blank space below the rows clears the selection,
 * focuses the canvas, and every so often the first row's primary cell comes back selected (the
 * tap toggles it on and off a few times). [`isFocusSelectAfterPress`] recognises that selection so
 * the grid can ignore it: a blank tap always leaves nothing selected.
 */
import type { GridSelection, Rectangle } from "@glideapps/glide-data-grid";

/** Where and when the pointer last went down or up over the grid (`performance.now()` time). */
export interface Press {
  x: number;
  y: number;
  t: number;
}

/** How long after a press a selection can still be its doing. */
export const PRESS_WINDOW_MS = 1000;

/**
 * True when `next` is Glide's select-on-focus answering a press elsewhere: nothing was selected,
 * now exactly one cell is (no rows or columns), a pointer pressed within the last second, and not
 * on that cell. A tap on the cell itself, a range, and keyboard focus (no press) are left alone.
 */
export function isFocusSelectAfterPress(
  prev: GridSelection,
  next: GridSelection,
  press: Press | null,
  now: number,
  boundsOf: (col: number, row: number) => Rectangle | undefined,
): boolean {
  if (prev.current !== undefined || prev.rows.length > 0 || prev.columns.length > 0) return false;
  const cur = next.current;
  if (!cur || next.rows.length > 0 || next.columns.length > 0) return false;
  if (cur.range.width !== 1 || cur.range.height !== 1 || cur.rangeStack.length > 0) return false;
  if (!press || now - press.t > PRESS_WINDOW_MS) return false;
  const b = boundsOf(cur.cell[0], cur.cell[1]);
  if (!b) return false;
  const onCell = press.x >= b.x && press.x <= b.x + b.width && press.y >= b.y && press.y <= b.y + b.height;
  return !onCell;
}
