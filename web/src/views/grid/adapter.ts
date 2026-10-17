/**
 * GridAdapter: the narrow interface between the grid view and the canvas grid library.
 *
 * Everything outside `views/grid/glide/` talks to the library only through these types, so the
 * library (currently Glide Data Grid, pinned at 6.0.3 on React 19 through an npm `overrides`
 * entry) can be vendored or replaced by a DOM grid on @tanstack/react-virtual without touching
 * data loading, editing, undo or the toolbar. Coordinates are *display* coordinates: `row` counts
 * rows as shown (record rows, group headers and the summary row), `col` counts columns as shown.
 */
import type { ReactNode } from "react";
import type { Field } from "@/api/types";
import type { ChipItem } from "@/lib/cells/format";

export interface GridColumnSpec {
  id: string;
  title: string;
  width: number;
  field: Field;
  isPrimary: boolean;
  /** Computed fields cannot be edited. */
  readOnly: boolean;
}

/** What to draw (and edit) in one position. Instances are cached and must be treated as immutable. */
export type CellModel =
  | { kind: "loading" }
  | { kind: "blank" }
  | { kind: "group"; headerIndex: number; depth: number; label: string; count: number; collapsed: boolean }
  | { kind: "summary"; fieldId: string; label: string; text: string }
  | RecordCellModel;

export interface RecordCellModel {
  kind: "cell";
  recordId: string;
  field: Field;
  /** The value as returned by the API (links are `[{id,name}]`). */
  value: unknown;
  display: string;
  chips: ChipItem[];
  readOnly: boolean;
  /** Palette colour of the row (left colour bar). */
  rowColor?: string;
  /** Only the primary field's cell shows the expand affordance. */
  isPrimary: boolean;
}

export interface GridPoint {
  col: number;
  row: number;
}

export interface GridRange {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridSelectionInfo {
  /** Focused cell, if any. */
  cell: GridPoint | null;
  /** Selected rectangles (the focused cell's range first). */
  ranges: GridRange[];
  /** Display rows selected via the row markers. */
  rows: number[];
  /** Columns selected via headers. */
  columns: number[];
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A change committed from an editor: either parsed JSON, or text for the host to parse. */
export interface CellEdit {
  col: number;
  row: number;
  json?: unknown;
  text?: string;
}

export interface EditorHostProps {
  cell: RecordCellModel;
  /** Key typed to open the editor (replaces the content), if any. */
  initialText?: string;
  /** Position of the cell on screen, for anchoring pop-overs. */
  target: ScreenRect;
  /** Record the value so far without closing; clicking outside the editor commits it. */
  onChange: (edit: { json?: unknown; text?: string }) => void;
  /** Commit and optionally move the selection (Enter = down, Tab = right, shift reverses). */
  onCommit: (edit: { json?: unknown; text?: string }, move?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  /** Close without saving (Escape). */
  onCancel: () => void;
}

export interface GridHandle {
  focus(): void;
  scrollToRow(row: number): void;
  selectCell(col: number, row: number): void;
  clearSelection(): void;
  /** Redraw every visible cell (cell models changed). */
  invalidate(): void;
}

export interface GridAdapterProps {
  columns: readonly GridColumnSpec[];
  rowCount: number;
  rowHeight: number;
  /** Columns kept in place when scrolling horizontally (including the primary field). */
  freezeColumns: number;
  /**
   * The pin button in the primary field's header (phones), or null for none. `pinned` is whether
   * the primary field stays in place; the host turns that into `freezeColumns`.
   */
  primaryPin: { pinned: boolean; onToggle(): void } | null;
  /** Show a pinned summary row after the data (the host supplies its cells through `getCell`). */
  showSummary: boolean;
  /**
   * The number the row marker column shows in a display row: the record's position in the view,
   * or null for rows that are not records (group headers, the summary row), which show nothing.
   */
  rowNumber(row: number): number | null;
  /** Highlight this text inside cells (search). */
  searchTerm: string;
  dark: boolean;
  /** Whether cells can be edited, filled, pasted into and cleared. */
  canEdit: boolean;
  /** Whether rows can be reordered by dragging. */
  canReorderRows: boolean;
  canReorderColumns: boolean;
  /** Bumped by the host whenever cell models changed, so the grid redraws. */
  version: number;

  /** O(1) lookup. Must never allocate per call for already-seen cells. */
  getCell(col: number, row: number): CellModel;
  getRowColor(row: number): string | undefined;

  onVisibleRowsChange(first: number, last: number): void;
  onCommitEdits(edits: readonly CellEdit[]): void;
  onPaste(target: GridPoint, rows: readonly (readonly string[])[]): void;
  onClear(sel: GridSelectionInfo): void;
  /** Text of the cells in a rectangle (loads missing pages first); used for Copy. */
  getCopyText(range: GridRange): Promise<string[][]>;
  /** Drag-fill: copy the source rectangle over the destination. */
  onFill(source: GridRange, destination: GridRange): void;
  onColumnResize(index: number, width: number, final: boolean): void;
  onColumnMove(from: number, to: number): void;
  onRowMove(from: number, to: number): void;
  onHeaderMenu(index: number, bounds: ScreenRect): void;
  onCellContextMenu(point: GridPoint, bounds: ScreenRect): void;
  onGroupToggle(headerIndex: number): void;
  onSummaryClick(col: number, bounds: ScreenRect): void;
  onExpand(row: number): void;
  onSelectionChange(sel: GridSelectionInfo): void;
  /** Key pressed on the grid. Return true when handled (the grid then skips its own handling). */
  onKeyDown(key: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; cell: GridPoint | null }): boolean;
  /** Add-field column ("+") at the end of the header; hidden when not allowed. */
  canAddField: boolean;
  onAddField(): void;
  /** Files were dropped onto a cell (attachments). */
  onDropFiles(point: GridPoint, files: File[]): void;

  /** Render the editor for a cell (DOM; shared with the expanded record). */
  renderEditor(props: EditorHostProps): ReactNode;
}
