/**
 * GridAdapter implementation on Glide Data Grid (@glideapps/glide-data-grid 6.0.3, canvas).
 *
 * Glide declares a React <= 18 peer range; the `overrides` entry in package.json lets it install
 * against React 19 and this wrapper was verified there (render, selection, overlay editors,
 * copy/paste, fill, resize, reorder, frozen columns, trailing frozen summary row).
 *
 * Glide's types force `any` in one place: `customRenderers` is `readonly CustomRenderer<any>[]`
 * (see `CUSTOM_RENDERERS` below), a boundary the library owns.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type CustomRenderer,
  type DataEditorRef,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type ProvideEditorCallbackResult,
  type ProvideEditorComponent,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { CellEdit, CellModel, GridAdapterProps, GridHandle, GridRange, GridSelectionInfo } from "../adapter";
import { isOgCell, toGridCell, withPending, type OgCell } from "./cells";
import { headerIcons } from "./icons";
import { mixColors, paletteColor } from "@/lib/cells/palette";
import { createRenderer } from "./renderers";
import { DARK_THEME, LIGHT_THEME } from "./theme";

const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: undefined };

const KEYBINDINGS = {
  activateCell: " |Enter|shift+Enter|F2",
  // Shift+Space opens the expanded record (handled by the grid view), not Glide's row select.
  selectRow: false,
  downFill: "primary+_68",
  rightFill: "primary+_82",
} as const;

const BLANK_MODEL: CellModel = { kind: "blank" };
const ROW_MARKER_WIDTH = 56;
const ADD_COLUMN_ID = "__add_field__";

/** Glide draws overlay editors into #portal; the app shell has none, so create it once. */
function ensurePortal(): void {
  if (document.getElementById("portal")) return;
  const el = document.createElement("div");
  el.id = "portal";
  el.style.cssText = "position:fixed;left:0;top:0;z-index:40;";
  document.body.appendChild(el);
}

function toInfo(sel: GridSelection): GridSelectionInfo {
  const cur = sel.current;
  const ranges: GridRange[] = cur ? [cur.range, ...cur.rangeStack].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })) : [];
  return {
    cell: cur ? { col: cur.cell[0], row: cur.cell[1] } : null,
    ranges,
    rows: [...sel.rows],
    columns: [...sel.columns],
  };
}

function screenRect(b: Rectangle): { x: number; y: number; width: number; height: number } {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

export const GlideGrid = forwardRef<GridHandle, GridAdapterProps>(function GlideGrid(props, ref) {
  const pr = useRef(props);
  pr.current = props;
  const gridRef = useRef<DataEditorRef>(null);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [paint, setPaint] = useState(0);

  useEffect(ensurePortal, []);

  const renderer = useMemo(
    () =>
      createRenderer(() => ({
        searchTerm: pr.current.searchTerm,
        dark: pr.current.dark,
        isSelected: (c, r) => {
          const cell = selectionRef.current.current?.cell;
          return !!cell && cell[0] === c && cell[1] === r;
        },
        onExpand: (r) => pr.current.onExpand(r),
        onOpenUrl: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
      })),
    [],
  );
  // `customRenderers` is typed `CustomRenderer<any>[]` by the library.
  const customRenderers = useMemo<readonly CustomRenderer<any>[]>(() => [renderer], [renderer]); // eslint-disable-line @typescript-eslint/no-explicit-any

  useImperativeHandle(
    ref,
    (): GridHandle => ({
      focus: () => gridRef.current?.focus(),
      scrollToRow: (row) => gridRef.current?.scrollTo(0, row, "vertical"),
      selectCell: (col, row) => {
        setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } });
        gridRef.current?.scrollTo(col, row, "both");
      },
      clearSelection: () => setSelection(EMPTY_SELECTION),
      invalidate: () => setPaint((n) => n + 1),
    }),
    [],
  );

  const columns = useMemo<GridColumn[]>(() => {
    const cols: GridColumn[] = props.columns.map((c) => ({ id: c.id, title: c.title, width: c.width, icon: c.field.type, hasMenu: true }));
    // A narrow "+" column after the last field adds a field when its header is clicked.
    if (props.canAddField) cols.push({ id: ADD_COLUMN_ID, title: "+", width: 48 });
    return cols;
  }, [props.columns, props.canAddField]);

  // A new function identity makes Glide redraw every visible cell.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getCellContent = useCallback(
    (item: Item): GridCell => (item[0] >= pr.current.columns.length ? toGridCell(BLANK_MODEL) : toGridCell(pr.current.getCell(item[0], item[1]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.version, props.columns, props.rowCount, paint],
  );

  const onVisibleRegionChanged = useCallback((range: Rectangle) => pr.current.onVisibleRowsChange(range.y, range.y + range.height - 1), []);

  const onCellsEdited = useCallback((items: readonly EditListItem[]) => {
    const edits: CellEdit[] = [];
    for (const { location, value } of items) {
      const [col, row] = location;
      if (value.kind === GridCellKind.Boolean) {
        edits.push({ col, row, json: value.data === true ? true : null });
      } else if (value.kind === GridCellKind.Custom && isOgCell(value)) {
        const data = value.data;
        if (data.og !== "cell") continue;
        if (data.pending) edits.push({ col, row, ...data.pending });
        else edits.push({ col, row, json: data.model.value });
      }
    }
    if (edits.length > 0) pr.current.onCommitEdits(edits);
    return true;
  }, []);

  const onPaste = useCallback((target: Item, values: readonly (readonly string[])[]) => {
    pr.current.onPaste({ col: target[0], row: target[1] }, values);
    return false;
  }, []);

  const onDelete = useCallback((sel: GridSelection) => {
    pr.current.onClear(toInfo(sel));
    return false;
  }, []);

  const getCellsForSelection = useCallback((rect: Rectangle) => async (): Promise<readonly (readonly GridCell[])[]> => {
    const text = await pr.current.getCopyText({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    return text.map((row) => row.map((t): GridCell => ({ kind: GridCellKind.Text, allowOverlay: false, readonly: true, data: t, displayData: t, copyData: t })));
  }, []);

  const OgEditor = useMemo<ProvideEditorComponent<OgCell>>(
    () =>
      function OgEditorBridge({ value, onChange, onFinishedEditing, initialValue, target }) {
        const data = value.data;
        if (data.og !== "cell") return null;
        return (
          <>
            {pr.current.renderEditor({
              cell: data.model,
              initialText: initialValue,
              target: screenRect(target),
              onChange: (edit) => onChange(withPending(value, edit)),
              onCommit: (edit, move) => onFinishedEditing(withPending(value, edit), move),
              onCancel: () => onFinishedEditing(undefined),
            })}
          </>
        );
      },
    [],
  );

  const provideEditor = useCallback(
    (cell: GridCell): ProvideEditorCallbackResult<GridCell> => {
      if (!isOgCell(cell) || cell.data.og !== "cell" || !pr.current.canEdit) return undefined;
      // The editor component is typed for OgCell; Glide hands it exactly those cells.
      return { editor: OgEditor as unknown as ProvideEditorComponent<GridCell>, disablePadding: true, disableStyling: true };
    },
    [OgEditor],
  );

  const theme = props.dark ? DARK_THEME : LIGHT_THEME;
  const tintCache = useRef(new Map<string, string>());
  useEffect(() => {
    tintCache.current.clear();
  }, [props.dark]);
  const getRowThemeOverride = useCallback(
    (row: number) => {
      const c = pr.current.getRowColor(row);
      if (!c) return undefined;
      const key = `${c}:${pr.current.dark ? 1 : 0}`;
      let tint = tintCache.current.get(key);
      if (!tint) {
        const pal = paletteColor(c);
        tint = mixColors(pr.current.dark ? "#1a1e26" : "#ffffff", pal.bg, pr.current.dark ? 0.28 : 0.45);
        tintCache.current.set(key, tint);
      }
      return { bgCell: tint };
    },
    [],
  );

  const onGridSelectionChange = useCallback((sel: GridSelection) => {
    setSelection(sel);
    pr.current.onSelectionChange(toInfo(sel));
  }, []);

  const onCellClicked = useCallback((cell: Item, ev: { bounds: Rectangle; isDoubleClick?: boolean }) => {
    const model = pr.current.getCell(cell[0], cell[1]);
    if (model.kind === "group") pr.current.onGroupToggle(model.headerIndex);
    else if (model.kind === "summary") pr.current.onSummaryClick(cell[0], screenRect(ev.bounds));
  }, []);

  const rowMarkers = useMemo(() => ({ kind: props.showRowNumbers ? ("both" as const) : ("checkbox" as const), width: ROW_MARKER_WIDTH }), [props.showRowNumbers]);

  return (
    <DataEditor
      ref={gridRef}
      className="og-glide"
      width="100%"
      height="100%"
      columns={columns}
      rows={props.rowCount + (props.showSummary ? 1 : 0)}
      freezeTrailingRows={props.showSummary ? 1 : 0}
      rowHeight={props.rowHeight}
      headerHeight={34}
      freezeColumns={props.freezeColumns}
      getCellContent={getCellContent}
      customRenderers={customRenderers}
      provideEditor={provideEditor}
      theme={theme}
      headerIcons={headerIcons()}
      rowMarkers={rowMarkers}
      rowSelectionMode="multi"
      rangeSelect="rect"
      columnSelect="multi"
      rowSelect="multi"
      gridSelection={selection}
      onGridSelectionChange={onGridSelectionChange}
      onVisibleRegionChanged={onVisibleRegionChanged}
      onCellsEdited={onCellsEdited}
      onPaste={onPaste}
      onDelete={onDelete}
      getCellsForSelection={getCellsForSelection}
      fillHandle={props.canEdit}
      onFillPattern={(e) => {
        e.preventDefault();
        pr.current.onFill(e.patternSource, e.fillDestination);
      }}
      keybindings={KEYBINDINGS}
      cellActivationBehavior="double-click"
      editOnType={props.canEdit}
      smoothScrollX
      smoothScrollY
      onColumnResize={(_c, w, idx) => pr.current.onColumnResize(idx, w, false)}
      onColumnResizeEnd={(_c, w, idx) => pr.current.onColumnResize(idx, w, true)}
      onColumnMoved={props.canReorderColumns ? (from, to) => pr.current.onColumnMove(from, to) : undefined}
      onRowMoved={props.canReorderRows ? (from, to) => pr.current.onRowMove(from, to) : undefined}
      onHeaderMenuClick={(col, bounds) => pr.current.onHeaderMenu(col, screenRect(bounds))}
      onHeaderContextMenu={(col, ev) => {
        ev.preventDefault();
        pr.current.onHeaderMenu(col, screenRect(ev.bounds));
      }}
      onCellContextMenu={(cell, ev) => {
        ev.preventDefault();
        pr.current.onCellContextMenu({ col: cell[0], row: cell[1] }, { x: ev.bounds.x + ev.localEventX, y: ev.bounds.y + ev.localEventY, width: 1, height: 1 });
      }}
      onCellClicked={onCellClicked}
      onHeaderClicked={(col) => {
        if (col >= pr.current.columns.length) pr.current.onAddField();
      }}
      onKeyDown={(e) => {
        const handled = pr.current.onKeyDown({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, cell: e.location ? { col: e.location[0], row: e.location[1] } : null });
        if (handled) e.cancel();
      }}
      onDragOverCell={() => {}}
      onDrop={(cell, dt) => {
        const files = dt ? [...dt.files] : [];
        if (files.length > 0) pr.current.onDropFiles({ col: cell[0], row: cell[1] }, files);
      }}
      getRowThemeOverride={getRowThemeOverride}
      maxColumnWidth={800}
      minColumnWidth={60}
    />
  );
});
