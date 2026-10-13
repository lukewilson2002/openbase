/**
 * Glide cell objects for the adapter's cell models. This is the only place that knows how a
 * `CellModel` maps onto Glide's `GridCell` union; cells are cached per model object so
 * `getCellContent` stays O(1) and allocation-free after the first draw.
 *
 * `any` is not used here: custom cells carry a typed payload (`OgData`) behind Glide's
 * `CustomCell<T>` generic.
 */
import { GridCellKind, type BooleanCell, type CustomCell, type GridCell, type LoadingCell, type TextCell } from "@glideapps/glide-data-grid";
import type { CellModel, RecordCellModel } from "../adapter";

/** Payload of every custom cell the grid draws. */
export type OgData =
  | { og: "cell"; model: RecordCellModel; pending?: { json?: unknown; text?: string } }
  | { og: "group"; model: Extract<CellModel, { kind: "group" }> }
  | { og: "summary"; model: Extract<CellModel, { kind: "summary" }> };

export type OgCell = CustomCell<OgData>;

const LOADING: LoadingCell = { kind: GridCellKind.Loading, allowOverlay: false };
const BLANK: TextCell = { kind: GridCellKind.Text, allowOverlay: false, readonly: true, data: "", displayData: "" };

const cache = new WeakMap<CellModel, GridCell>();

export function isOgCell(cell: GridCell): cell is OgCell {
  return cell.kind === GridCellKind.Custom && typeof (cell.data as Partial<OgData> | undefined)?.og === "string";
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
  const cell: OgCell = {
    kind: GridCellKind.Custom,
    allowOverlay: !m.readOnly,
    copyData: m.display,
    readonly: m.readOnly,
    data: { og: "cell", model: m },
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
      const g: OgCell = { kind: GridCellKind.Custom, allowOverlay: false, copyData: model.label, readonly: true, data: { og: "group", model } };
      cell = g;
      break;
    }
    case "summary": {
      const s: OgCell = { kind: GridCellKind.Custom, allowOverlay: false, copyData: model.text, readonly: true, data: { og: "summary", model } };
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
export function withPending(cell: OgCell, pending: { json?: unknown; text?: string }): OgCell {
  const data = cell.data;
  if (data.og !== "cell") return cell;
  return { ...cell, data: { ...data, pending } };
}
