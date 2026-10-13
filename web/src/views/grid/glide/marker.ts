/**
 * What the row-marker column shows, row by row.
 *
 * Glide draws the marker column itself (a number that turns into a checkbox on hover) and numbers
 * it by *display row*: with group headers interleaved among the records that skews the count, and
 * the pinned summary row at the bottom gets "n + 1". Glide has no hook for this (`drawCell` is not
 * called for its own marker cells and `rowMarkers.startIndex` is one constant), so this module
 * wraps the library's marker renderer once: it asks the host which number a display row shows,
 * and draws nothing at all (no number, no hover checkbox) for rows that have none (group headers
 * and the summary row). The host is the one active grid, registered with `setRowNumbering`.
 *
 * Pinned to @glideapps/glide-data-grid 6.0.3 (see the adapter notes in `adapter.ts`): the wrapper
 * only touches `markerCellRenderer.draw` and `.getAccessibilityString`, and `startIndex` must stay
 * at 1 (the library gives the marker cell `row = startIndex + displayRow`).
 */
import { markerCellRenderer } from "@glideapps/glide-data-grid";

/** The number shown for a display row, or null for a row that has no number (nothing is drawn). */
export type RowNumbering = (displayRow: number) => number | null;

/** Glide's `rowMarkers.startIndex` (its default): marker cell `row` = START + display row. */
export const MARKER_START_INDEX = 1;

let current: RowNumbering | null = null;
let installed = false;

/** Register the active grid's numbering; returns what to call to unregister it (if still current). */
export function setRowNumbering(fn: RowNumbering): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}

/** The number a marker cell shows, given the library's own `row` (display row + start index). */
export function markerNumber(libraryRow: number): number | null {
  if (!current) return libraryRow;
  return current(libraryRow - MARKER_START_INDEX);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Wrap the library's marker renderer (once). */
export function installMarkerNumbering(): void {
  if (installed) return;
  installed = true;
  const renderer = markerCellRenderer as Mutable<typeof markerCellRenderer>;
  const draw = renderer.draw;
  const accessibility = renderer.getAccessibilityString;
  renderer.draw = (args, cell) => {
    const n = markerNumber(cell.row);
    if (n === null) return;
    if (n === cell.row) return draw(args, cell);
    const relabelled = { ...cell, row: n };
    return draw({ ...args, cell: relabelled }, relabelled);
  };
  renderer.getAccessibilityString = (cell) => {
    const n = markerNumber(cell.row);
    return n === null ? "" : accessibility({ ...cell, row: n });
  };
}
