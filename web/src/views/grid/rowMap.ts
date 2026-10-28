/**
 * Maps display rows (what the grid shows) to records and group headers.
 *
 * Without grouping the mapping is the identity. With grouping, the query response lists group
 * headers depth-first with the index of the first record of each group (`start`) and its record
 * `count`; headers are interleaved into the rows, and collapsed groups hide their records and
 * nested headers.
 *
 * With `addRows`, a quiet "Add" row closes each expanded group that holds records (a leaf), or the
 * table when there are no groups. It is not a record: it has no record index.
 */
import type { GroupHeader } from "@/api/types";

export interface RowMap {
  /** Number of display rows. */
  readonly length: number;
  /** Record index at a display row, or -1 when the row is a group header. */
  recordIndexAt(row: number): number;
  /** Group header index (into the headers array) at a display row, or -1. */
  groupAt(row: number): number;
  /** Whether a display row is an add row. */
  isAddRow(row: number): boolean;
  /** Group header index an add row adds into, or -1 (not an add row, or the add row of an ungrouped table). */
  addGroupAt(row: number): number;
  /** Display row of a record index, or -1 when hidden by a collapsed group. */
  rowOfRecord(recordIndex: number): number;
  /** Smallest and largest record index shown in the display row range, or null when none. */
  recordRange(firstRow: number, lastRow: number): [number, number] | null;
}

/** Stable key of each header, unique across parents: `field:key/field:key/...`. */
export function groupPathKeys(groups: readonly GroupHeader[]): string[] {
  const stack: string[] = [];
  return groups.map((g) => {
    stack.length = g.depth;
    stack[g.depth] = `${g.field_id}:${g.key}`;
    return stack.join("/");
  });
}

/** Whether header `gi` has no sub-groups: the records are in it. */
export function isLeafGroup(groups: readonly GroupHeader[], gi: number): boolean {
  const g = groups[gi];
  const after = groups[gi + 1];
  return !!g && (!after || after.depth <= g.depth);
}

export function buildRowMap(total: number, groups: readonly GroupHeader[], collapsed: ReadonlySet<string> = new Set(), addRows = false): RowMap {
  if (groups.length === 0) return identityMap(total, addRows);
  const paths = groupPathKeys(groups);
  const count = groups.length;
  // >= 0: record index; -count..-1: -(groupIndex + 1); below that: the add row of group -(v + count + 1).
  const cells: number[] = [];
  let next = 0;
  let skipUntil = -1;
  // The group whose add row comes after the records pushed so far.
  let open = -1;
  const closeGroup = () => {
    if (open >= 0) cells.push(-(count + 1 + open));
    open = -1;
  };
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!;
    if (g.start < skipUntil) continue; // inside a collapsed ancestor
    for (let r = next; r < g.start && r < total; r++) cells.push(r);
    closeGroup();
    cells.push(-(gi + 1));
    next = Math.max(next, g.start);
    if (collapsed.has(paths[gi]!)) {
      skipUntil = g.start + g.count;
      next = skipUntil;
    } else if (addRows && isLeafGroup(groups, gi)) open = gi;
  }
  for (let r = next; r < total; r++) cells.push(r);
  closeGroup();

  const map = Int32Array.from(cells);
  // Reverse lookup, built lazily (needed for scroll-to-record and prev/next only).
  let reverse: Int32Array | null = null;
  const buildReverse = (): Int32Array => {
    if (reverse) return reverse;
    reverse = new Int32Array(total).fill(-1);
    for (let row = 0; row < map.length; row++) {
      const v = map[row]!;
      if (v >= 0) reverse[v] = row;
    }
    return reverse;
  };
  return {
    length: map.length,
    recordIndexAt: (row) => {
      const v = map[row];
      return v === undefined || v < 0 ? -1 : v;
    },
    groupAt: (row) => {
      const v = map[row];
      return v === undefined || v >= 0 || v < -count ? -1 : -v - 1;
    },
    isAddRow: (row) => (map[row] ?? 0) < -count,
    addGroupAt: (row) => {
      const v = map[row];
      return v === undefined || v >= -count ? -1 : -v - count - 1;
    },
    rowOfRecord: (i) => (i < 0 || i >= total ? -1 : buildReverse()[i]!),
    recordRange: (firstRow, lastRow) => {
      let lo = Infinity;
      let hi = -1;
      for (let row = Math.max(0, firstRow); row <= Math.min(map.length - 1, lastRow); row++) {
        const v = map[row]!;
        if (v >= 0) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return hi < 0 ? null : [lo, hi];
    },
  };
}

function identityMap(total: number, addRow: boolean): RowMap {
  return {
    length: total + (addRow ? 1 : 0),
    recordIndexAt: (row) => (row >= 0 && row < total ? row : -1),
    groupAt: () => -1,
    isAddRow: (row) => addRow && row === total,
    addGroupAt: () => -1,
    rowOfRecord: (i) => (i >= 0 && i < total ? i : -1),
    recordRange: (firstRow, lastRow) => {
      const lo = Math.max(0, firstRow);
      const hi = Math.min(total - 1, lastRow);
      return hi < lo ? null : [lo, hi];
    },
  };
}

export const PAGE_SIZE = 200;

/** Page numbers covering the record index range [first, last], optionally widened by `margin` pages. */
export function pagesFor(first: number, last: number, total: number, margin = 0): number[] {
  if (total <= 0 || last < first) return [];
  const maxPage = Math.floor((total - 1) / PAGE_SIZE);
  const lo = Math.max(0, Math.floor(first / PAGE_SIZE) - margin);
  const hi = Math.min(maxPage, Math.floor(last / PAGE_SIZE) + margin);
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}
