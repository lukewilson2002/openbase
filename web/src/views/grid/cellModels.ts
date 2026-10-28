/**
 * Builds `CellModel`s for the grid adapter and caches them per record object, so `getCell` is an
 * allocation-free lookup after the first draw. A new factory is made whenever the columns, the
 * format context or the edit permission change (which invalidates every cached model).
 */
import type { Field, TableRecord } from "@/api/types";
import { chipItems, displayText, type FormatCtx } from "@/lib/cells/format";
import { isComputed } from "@/lib/cells/kinds";
import type { CellModel, GridColumnSpec, RecordCellModel } from "./adapter";

export const LOADING: CellModel = { kind: "loading" };
export const BLANK: CellModel = { kind: "blank" };
/** The "Add" of an add row, drawn in its first column. */
export const ADD: CellModel = { kind: "add" };

/**
 * The value of a field in a record. System fields normally arrive in `values`; when the server
 * leaves them out, fall back to the record's own columns.
 */
export function cellValueOf(record: TableRecord, field: Field): unknown {
  const v = record.values[field.id];
  if (v !== undefined && v !== null) return v;
  switch (field.type) {
    case "created_time":
      return new Date(record.created_at).toISOString();
    case "last_modified_time":
      return new Date(record.updated_at).toISOString();
    case "created_by":
      return record.created_by ?? null;
    case "last_modified_by":
      return record.updated_by ?? null;
    case "autonumber":
      return record.autonumber;
    default:
      return null;
  }
}

export interface CellModelFactory {
  /** Model for the record in column `col`. */
  forRecord(record: TableRecord, col: number, rowColor: string | undefined): CellModel;
  summary(col: number, label: string, text: string): CellModel;
  group(headerIndex: number, depth: number, label: string, count: number, collapsed: boolean): CellModel;
}

export function createCellModelFactory(columns: readonly GridColumnSpec[], ctx: FormatCtx, canEdit: boolean): CellModelFactory {
  const records = new WeakMap<TableRecord, (RecordCellModel | undefined)[]>();
  const summaries = new Map<string, CellModel>();
  const groups = new Map<string, CellModel>();

  return {
    forRecord(record, col, rowColor) {
      let row = records.get(record);
      if (!row) {
        row = new Array<RecordCellModel | undefined>(columns.length);
        records.set(record, row);
      }
      const hit = row[col];
      if (hit && hit.rowColor === rowColor) return hit;
      const spec = columns[col];
      if (!spec) return BLANK;
      const value = cellValueOf(record, spec.field);
      const model: RecordCellModel = {
        kind: "cell",
        recordId: record.id,
        field: spec.field,
        value,
        display: displayText(spec.field, value, ctx),
        chips: chipItems(spec.field, value, ctx),
        readOnly: !canEdit || spec.readOnly,
        rowColor: spec.isPrimary ? rowColor : undefined,
        isPrimary: spec.isPrimary,
      };
      row[col] = model;
      return model;
    },
    summary(col, label, text) {
      const key = `${col}\u0000${label}\u0000${text}`;
      let m = summaries.get(key);
      if (!m) {
        m = { kind: "summary", fieldId: columns[col]?.id ?? "", label, text };
        summaries.set(key, m);
      }
      return m;
    },
    group(headerIndex, depth, label, count, collapsed) {
      const key = `${headerIndex}\u0000${depth}\u0000${label}\u0000${count}\u0000${collapsed}`;
      let m = groups.get(key);
      if (!m) {
        m = { kind: "group", headerIndex, depth, label, count, collapsed };
        groups.set(key, m);
      }
      return m;
    },
  };
}

/** Columns for a table in display order, ready for the adapter. */
export function toColumnSpecs(
  fields: readonly Field[],
  primaryId: string,
  widths: Readonly<Record<string, number>>,
  overrides: Readonly<Record<string, number>>,
): GridColumnSpec[] {
  return fields.map((f) => ({
    id: f.id,
    title: f.name,
    // Without a width of its own a column fits its content.
    width: overrides[f.id] ?? widths[f.id],
    field: f,
    isPrimary: f.id === primaryId,
    readOnly: isComputed(f),
  }));
}

