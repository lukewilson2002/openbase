/**
 * Planning of multi-cell operations (paste, clear, fill) as pure functions over a small reader
 * interface, so they are unit-tested without a canvas. Each returns the `CellChange`s to apply
 * (view values, with the previous value for undo) plus any problems found.
 */
import type { TableRecord } from "@/api/types";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { parseText, jsonEqual, type ParseCtx } from "@/lib/cells/parse";
import { isEmptyValue, toView } from "@/lib/cells/wire";
import type { GridColumnSpec, GridPoint, GridRange, GridSelectionInfo } from "./adapter";
import { cellValueOf } from "./cellModels";
import type { CellChange } from "./undo";

export interface GridReader {
  columns: readonly GridColumnSpec[];
  /** Number of display rows (record rows and group headers; not the summary row). */
  rowCount: number;
  /** The record shown at a display row, or undefined for group headers and unloaded rows. */
  recordAt(row: number): TableRecord | undefined;
  /** Whether a display row shows a record (even if not loaded yet). */
  isRecordRow(row: number): boolean;
}

export interface PlanResult {
  changes: CellChange[];
  /** Human-readable problems (invalid values, rows that are not loaded). */
  errors: string[];
}

export interface PastePlan extends PlanResult {
  /** Values (wire form, by field id) for records to create when the paste runs past the last row. */
  newRecords: Record<string, unknown>[];
}

function beforeOf(rec: TableRecord, col: GridColumnSpec): unknown {
  return cellValueOf(rec, col.field) ?? null;
}

/** Names of link targets by id, for optimistic display. */
export type LinkNames = ReadonlyMap<string, string>;

export interface PasteOptions {
  parse: ParseCtx;
  /** Record names by id for links resolved by the caller. */
  linkNames?: LinkNames;
  /** The selected rectangle; a single pasted value fills all of it. */
  selection?: GridRange | null;
}

/** Expand a 1x1 clipboard over the selection. */
function expandToSelection(values: readonly (readonly string[])[], sel: GridRange | null | undefined): readonly (readonly string[])[] {
  const single = values.length === 1 && values[0]?.length === 1;
  if (!single || !sel || (sel.width === 1 && sel.height === 1)) return values;
  const v = values[0]![0]!;
  return Array.from({ length: sel.height }, () => Array.from({ length: sel.width }, () => v));
}

export function planPaste(reader: GridReader, target: GridPoint, input: readonly (readonly string[])[], opts: PasteOptions): PastePlan {
  const values = expandToSelection(input, opts.selection);
  const changes: CellChange[] = [];
  const errors: string[] = [];
  const newRecords: Record<string, unknown>[] = [];
  let row = target.row;
  const pending = new Map<number, Record<string, unknown>>();

  for (let r = 0; r < values.length; r++) {
    // Group headers are skipped: pasted rows continue with the next record row.
    while (row < reader.rowCount && !reader.isRecordRow(row)) row++;
    const line = values[r]!;
    const rec = row < reader.rowCount ? reader.recordAt(row) : undefined;
    const overflow = row >= reader.rowCount;
    if (!overflow && !rec) {
      errors.push(`Row ${row + 1} is not loaded yet`);
      row++;
      continue;
    }
    const fresh: Record<string, unknown> = {};
    for (let c = 0; c < line.length; c++) {
      const col = reader.columns[target.col + c];
      if (!col || col.readOnly) continue;
      const text = line[c]!;
      const res = parseText(col.field, text, opts.parse);
      if (!res.ok) {
        errors.push(`${col.field.name}: ${res.error}`);
        continue;
      }
      if (overflow) {
        if (res.value !== null) fresh[col.field.id] = res.value;
        continue;
      }
      const after = toView(col.field, res.value, opts.linkNames);
      const before = beforeOf(rec!, col);
      changes.push({ recordId: rec!.id, fieldId: col.field.id, before, after });
    }
    if (overflow) pending.set(r, fresh);
    row++;
  }
  for (const [, v] of [...pending].sort((a, b) => a[0] - b[0])) newRecords.push(v);
  return { changes: changes.filter((c) => !jsonEqual(c.before, c.after)), errors, newRecords };
}

/** Rectangles covered by a selection: ranges, plus whole rows and whole columns. */
export function selectionRectangles(sel: GridSelectionInfo, columnCount: number, rowCount: number): GridRange[] {
  const out: GridRange[] = [...sel.ranges];
  for (const row of sel.rows) out.push({ x: 0, y: row, width: columnCount, height: 1 });
  for (const col of sel.columns) out.push({ x: col, y: 0, width: 1, height: rowCount });
  return out;
}

export function planClear(reader: GridReader, rects: readonly GridRange[]): PlanResult {
  const changes: CellChange[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const rect of rects) {
    for (let row = rect.y; row < Math.min(rect.y + rect.height, reader.rowCount); row++) {
      if (!reader.isRecordRow(row)) continue;
      const rec = reader.recordAt(row);
      if (!rec) {
        errors.push(`Row ${row + 1} is not loaded yet`);
        continue;
      }
      for (let c = rect.x; c < rect.x + rect.width; c++) {
        const col = reader.columns[c];
        if (!col || col.readOnly) continue;
        const key = `${rec.id}:${col.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const before = beforeOf(rec, col);
        if (!isEmptyValue(before)) changes.push({ recordId: rec.id, fieldId: col.id, before, after: null });
      }
    }
  }
  return { changes, errors };
}

/** Drag-fill: the source rectangle repeats over the destination. */
export function planFill(reader: GridReader, src: GridRange, dest: GridRange, parse: ParseCtx, format: FormatCtx): PlanResult {
  const changes: CellChange[] = [];
  const errors: string[] = [];
  const mod = (n: number, m: number) => ((n % m) + m) % m;
  // Source rows that are group headers or not loaded make the fill impossible for those cells.
  for (let row = dest.y; row < Math.min(dest.y + dest.height, reader.rowCount); row++) {
    if (!reader.isRecordRow(row)) continue;
    const rec = reader.recordAt(row);
    if (!rec) continue;
    const srcRow = src.y + mod(row - src.y, src.height);
    const srcRec = reader.recordAt(srcRow);
    if (!srcRec) continue;
    for (let c = dest.x; c < dest.x + dest.width; c++) {
      const col = reader.columns[c];
      const srcCol = reader.columns[src.x + mod(c - src.x, src.width)];
      if (!col || !srcCol || col.readOnly) continue;
      const srcValue = cellValueOf(srcRec, srcCol.field);
      let after: unknown;
      if (srcCol.id === col.id) after = isEmptyValue(srcValue) ? null : srcValue;
      else {
        const res = parseText(col.field, displayText(srcCol.field, srcValue, format), parse);
        if (!res.ok) {
          errors.push(`${col.field.name}: ${res.error}`);
          continue;
        }
        after = toView(col.field, res.value);
      }
      const before = beforeOf(rec, col);
      if (!jsonEqual(before, after)) changes.push({ recordId: rec.id, fieldId: col.id, before, after });
    }
  }
  return { changes, errors };
}
