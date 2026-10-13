/**
 * Glide cell objects for the adapter's cell models. This is the only place that knows how a
 * `CellModel` maps onto Glide's `GridCell` union; cells are cached per model object so
 * `getCellContent` stays O(1) and allocation-free after the first draw.
 *
 * `any` is not used here: custom cells carry a typed payload (`ObData`) behind Glide's
 * `CustomCell<T>` generic.
 */
import { GridCellKind, type BooleanCell, type CustomCell, type GridCell, type LoadingCell, type TextCell } from "@glideapps/glide-data-grid";
import type { CellModel, RecordCellModel } from "../adapter";

/** Payload of every custom cell the grid draws. */
export type ObData =
  | { ob: "cell"; model: RecordCellModel; pending?: { json?: unknown; text?: string } }
  | { ob: "group"; model: Extract<CellModel, { kind: "group" }> }
  | { ob: "summary"; model: Extract<CellModel, { kind: "summary" }> };

export type ObCell = CustomCell<ObData>;

const LOADING: LoadingCell = { kind: GridCellKind.Loading, allowOverlay: false };
const BLANK: TextCell = { kind: GridCellKind.Text, allowOverlay: false, readonly: true, data: "", displayData: "" };

const cache = new WeakMap<CellModel, GridCell>();

export function isObCell(cell: GridCell): cell is ObCell {
  return cell.kind === GridCellKind.Custom && typeof (cell.data as Partial<ObData> | undefined)?.ob === "string";
}

function recordCell(m: RecordCellModel): GridCell {
  if (m.field.type === "checkbox" || isBoolFormula(m)) {
    const c: BooleanCell = {
      kind: GridCellKind.Boolean,
      data: m.value === true,
      allowOverlay: false,
      readonly: m.readOnly,
      copyData: m.display,
    };
    return c;
  }
  const cell: ObCell = {
    kind: GridCellKind.Custom,
    allowOverlay: !m.readOnly,
    copyData: m.display,
    readonly: m.readOnly,
    data: { ob: "cell", model: m },
  };
  return cell;
}

function isBoolFormula(m: RecordCellModel): boolean {
  return (m.field.type === "formula" || m.field.type === "rollup") && typeof m.value === "boolean";
}

/** Glide cell for a model; the result is cached by model identity. */
export function toGridCell(model: CellModel): GridCell {
  const hit = cache.get(model);
  if (hit) return hit;
  let cell: GridCell;
  switch (model.kind) {
    case "loading":
      cell = LOADING;
      break;
    case "blank":
      cell = BLANK;
      break;
    case "group": {
      const g: ObCell = { kind: GridCellKind.Custom, allowOverlay: false, copyData: model.label, readonly: true, data: { ob: "group", model } };
      cell = g;
      break;
    }
    case "summary": {
      const s: ObCell = { kind: GridCellKind.Custom, allowOverlay: false, copyData: model.text, readonly: true, data: { ob: "summary", model } };
      cell = s;
      break;
    }
    case "cell":
      cell = recordCell(model);
      break;
  }
  cache.set(model, cell);
  return cell;
}

/** A copy of an edited custom cell carrying the pending value. */
export function withPending(cell: ObCell, pending: { json?: unknown; text?: string }): ObCell {
  const data = cell.data;
  if (data.ob !== "cell") return cell;
  return { ...cell, data: { ...data, pending } };
}
