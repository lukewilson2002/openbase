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
  type GridMouseEventArgs,
  type GridSelection,
  type Item,
  type ProvideEditorCallbackResult,
  type ProvideEditorComponent,
  type DrawHeaderCallback,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import { Pin } from "lucide-react";
import "@glideapps/glide-data-grid/dist/index.css";
import type { CellEdit, CellModel, GridAdapterProps, GridHandle, GridRange, GridSelectionInfo, ScreenRect } from "../adapter";
import { isFormulaError } from "@/lib/cells/format";
import { displayShapeOf } from "@/lib/cells/kinds";
import { layoutChips, type PlacedChip } from "./draw";
import { isObCell, toGridCell, withPending, type ObCell } from "./cells";
import { ADD_ICON, headerIcons } from "./icons";
import { cn } from "@/lib/cn";
import { MARKER_START_INDEX, installMarkerNumbering, setRowNumbering } from "./marker";
import { createRenderer, measureRecordCell } from "./renderers";
import { isFocusSelectAfterPress, type Press } from "./focusSelect";
import { gridTheme } from "./theme";
import { LONG_PRESS_MS, LONG_PRESS_TOLERANCE_PX, cellAtPoint } from "./longPress";

installMarkerNumbering();

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
/** A column waiting to be fitted (its rows are not loaded yet). */
const FIT_PLACEHOLDER_WIDTH = 150;
/** The widest a column grows to fit its content: a longer text says the rest in its cell's preview. */
const FIT_MAX_WIDTH = 360;
/** How many loaded rows a column is fitted to. */
const FIT_ROWS = 200;
/** How far the row numbers' column can be dragged, and where this device keeps its width. */
const MARKER_MIN = 32;
const MARKER_MAX = 120;
const MARKER_KEY = "ob-grid-marker-width";
const clampMarker = (w: number) => Math.round(Math.min(MARKER_MAX, Math.max(MARKER_MIN, w)));
function storedMarkerWidth(): number {
  try {
    const n = Number(localStorage.getItem(MARKER_KEY));
    return n > 0 ? clampMarker(n) : ROW_MARKER_WIDTH;
  } catch {
    return ROW_MARKER_WIDTH;
  }
}
const ADD_COLUMN_ID = "__add_field__";
export const GRID_HEADER_HEIGHT = 44;
/** A number that turns into a checkbox on hover; `marker.ts` decides the number per row. */
const rowMarkers = (width: number) => ({ kind: "both", width, startIndex: MARKER_START_INDEX }) as const;
/** Glide's header menu button, at the right end of a header (its `menuButtonSize`). */
const HEADER_MENU_WIDTH = 30;
/** The primary field's pin button, just left of the header menu button. */
const PIN_BUTTON_SIZE = 32;
const PIN_BUTTON_GAP = 4;

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

let measuring: CanvasRenderingContext2D | null = null;
/** The chips of the cell the pointer was last over, laid out once: a move within the cell reuses them. */
let lastLayout: { key: string; placed: PlacedChip[] } | null = null;

/** The linked record whose chip is at a point of a cell, laid out as the renderer draws it. */
function linkChipAt(props: GridAdapterProps, [col, row]: Item, bounds: Rectangle, x: number, y: number): { point: { col: number; row: number }; recordId: string; rect: ScreenRect } | null {
  const m = props.getCell(col, row);
  if (m.kind !== "cell" || displayShapeOf(m.field) !== "link" || isFormulaError(m.value)) return null;
  // The cell's models are rebuilt when `version` changes, and its look with the theme and its size.
  const key = `${col}:${row}:${bounds.width}:${bounds.height}:${props.version}:${props.dark}:${props.accent}`;
  if (lastLayout?.key !== key) {
    measuring ??= document.createElement("canvas").getContext("2d");
    if (!measuring) return null;
    const base = gridTheme(props.dark, props.accent);
    const theme = { cellHorizontalPadding: base.cellHorizontalPadding ?? 14, baseFontFull: `${base.baseFontStyle} ${base.fontFamily}` };
    const chips = m.chips.map((c) => ({ text: c.text, color: c.color, kind: "link" as const }));
    lastLayout = { key, placed: layoutChips(measuring, theme, { x: 0, y: 0, width: bounds.width, height: bounds.height }, chips).placed };
  }
  const hit = lastLayout.placed.find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
  const id = hit && m.chips[hit.index]?.id;
  if (!hit || !id) return null;
  return { point: { col, row }, recordId: id, rect: { x: bounds.x + hit.x, y: bounds.y + hit.y, width: hit.w, height: hit.h } };
}

function screenRect(b: Rectangle): { x: number; y: number; width: number; height: number } {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

export const GlideGrid = forwardRef<GridHandle, GridAdapterProps>(function GlideGrid(props, ref) {
  const pr = useRef(props);
  pr.current = props;
  const gridRef = useRef<DataEditorRef>(null);
  /** Whether the column resize under way has been dragged (see onColumnResizeEnd). */
  const resizeMoved = useRef(false);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [paint, setPaint] = useState(0);

  useEffect(ensurePortal, []);
  // Which number the marker column shows in each display row (none for group headers and the summary row).
  useEffect(() => setRowNumbering((row) => pr.current.rowNumber(row)), []);

  // Glide listens for `click` on the window and reads `changedTouches` from anything that is not a
  // MouseEvent. Radix switches and checkboxes inside a <form> (any dialog or popover of the page)
  // dispatch a plain `new Event("click")` from their hidden input to notify the form, which makes
  // Glide throw "Cannot read properties of undefined (reading '0')". Such events are not clicks of
  // the pointer: keep them away from Glide (capture phase on the window runs before its listener).
  useEffect(() => {
    const guard = (e: Event) => {
      if (!(e instanceof MouseEvent) && !("changedTouches" in e)) e.stopImmediatePropagation();
    };
    window.addEventListener("click", guard, true);
    return () => window.removeEventListener("click", guard, true);
  }, []);

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
        const next: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } };
        setSelection(next);
        // Glide only reports selections the pointer or keyboard made; the grid view has to hear about
        // this one too, or what it thinks is selected (and its "has the selection changed" checks) is stale.
        pr.current.onSelectionChange(toInfo(next));
        gridRef.current?.scrollTo(col, row, "both");
      },
      clearSelection: () => {
        setSelection(EMPTY_SELECTION);
        pr.current.onSelectionChange(toInfo(EMPTY_SELECTION));
      },
      cellBounds: (col, row) => {
        const b = gridRef.current?.getBounds(col, row);
        return b ? screenRect(b) : null;
      },
      invalidate: () => setPaint((n) => n + 1),
    }),
    [],
  );

  // Columns without a width of their own, fitted once to their header and the first loaded rows, as
  // a double-click on a column's edge does (but over more rows, and keeping every value: nothing is
  // cut until the column reaches FIT_MAX_WIDTH). A width is fitted once per column; a drag or a
  // double-click then gives it a saved one.
  const [fitted, setFitted] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (props.fitColumns === false) return;
    const todo = props.columns.filter((c) => c.width === undefined && fitted[c.id] === undefined);
    if (todo.length === 0) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const base = gridTheme(props.dark, props.accent);
    const cellTheme = { cellHorizontalPadding: base.cellHorizontalPadding ?? 14, baseFontFull: `${base.baseFontStyle} ${base.fontFamily}` };
    const rows = Math.min(props.rowCount, FIT_ROWS);
    const next = { ...fitted };
    for (const c of todo) {
      const col = props.columns.indexOf(c);
      // The header: its icon, title and menu button (and the primary field's pin).
      ctx.font = `${base.headerFontStyle} ${base.fontFamily}`;
      let w = 14 + 16 + 8 + ctx.measureText(c.title).width + 8 + HEADER_MENU_WIDTH + (col === 0 && props.primaryPin ? PIN_BUTTON_SIZE : 0);
      for (let row = 0; row < rows; row++) {
        const m = pr.current.getCell(col, row);
        if (m.kind === "cell") w = Math.max(w, measureRecordCell(ctx, m, cellTheme));
      }
      next[c.id] = Math.max(60, Math.min(FIT_MAX_WIDTH, Math.ceil(w)));
    }
    setFitted(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitColumns, props.columns, props.rowCount, props.version]);

  const columns = useMemo<GridColumn[]>(() => {
    // A column without a width of its own is as wide as its content (`fitted`, below).
    const cols: GridColumn[] = props.columns.map((c) => ({ id: c.id, title: c.title, width: c.width ?? fitted[c.id] ?? FIT_PLACEHOLDER_WIDTH, icon: c.field.type, hasMenu: true }));
    // An "Add field" column after the last field adds a field when its header is clicked.
    if (props.canAddField) cols.push({ id: ADD_COLUMN_ID, title: "Add field", icon: ADD_ICON, width: 130 });
    return cols;
  }, [props.columns, props.canAddField, fitted]);

  // A new function identity makes Glide redraw every visible cell.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getCellContent = useCallback(
    (item: Item): GridCell => (item[0] >= pr.current.columns.length ? toGridCell(BLANK_MODEL) : toGridCell(pr.current.getCell(item[0], item[1]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.version, props.columns, props.rowCount, paint],
  );

  // The pin button sits over the primary field's header. Pinned, that header never moves; unpinned it
  // scrolls with the rest, so follow Glide's scroller to keep the button on it.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const pin = props.primaryPin;
  const followScroll = pin !== null && !pin.pinned;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!followScroll || !wrap) {
      setScrollLeft(0);
      return;
    }
    // Glide may not have rendered its scroller yet (a view that opens unpinned), so listen on the
    // wrapper in the capture phase (scroll events do not bubble) instead of on the scroller itself.
    const isScroller = (el: EventTarget | null): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("dvn-scroller");
    const onScroll = (e: Event) => {
      if (isScroller(e.target)) setScrollLeft(e.target.scrollLeft);
    };
    setScrollLeft(wrap.querySelector<HTMLElement>(".dvn-scroller")?.scrollLeft ?? 0);
    wrap.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => wrap.removeEventListener("scroll", onScroll, { capture: true });
  }, [followScroll]);

  // With the pin button showing, the primary field's title stops short of it (the menu button
  // still draws in its own place at the right end).
  const showPin = pin !== null;
  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      if (!showPin || args.columnIndex !== 0) {
        drawContent();
        return;
      }
      const { ctx, rect } = args;
      const titleEnd = rect.width - HEADER_MENU_WIDTH - PIN_BUTTON_SIZE - PIN_BUTTON_GAP;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, Math.max(0, titleEnd), rect.height);
      ctx.rect(rect.x + rect.width - HEADER_MENU_WIDTH, rect.y, HEADER_MENU_WIDTH, rect.height);
      ctx.clip();
      drawContent();
      ctx.restore();
    },
    [showPin],
  );

  // The keyboard and a long press open the record menu themselves; the browser's own context menu event
  // that may follow them is not a second request.
  const menuOpenedAt = useRef(0);
  const visibleRegion = useRef({ y: 0, height: 0 });
  const onVisibleRegionChanged = useCallback((range: Rectangle) => {
    visibleRegion.current = { y: range.y, height: range.height };
    pr.current.onVisibleRowsChange(range.y, range.y + range.height - 1);
  }, []);

  // A long press of a finger opens the row menu (a mouse has the right button, the keyboard the menu key).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer: number | null = null;
    let start: { x: number; y: number } | null = null;
    let fired = false;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      start = null;
    };
    const fire = () => {
      timer = null;
      if (!start) return;
      const { x, y } = start;
      const hit = cellAtPoint((c, r) => gridRef.current?.getBounds(c, r), visibleRegion.current, pr.current.columns.length, x, y);
      start = null;
      if (!hit) return;
      fired = true;
      const sel = selectionRef.current;
      const inSelection = sel.rows.hasIndex(hit.row) || (sel.current && sel.current.range.y <= hit.row && hit.row < sel.current.range.y + sel.current.range.height);
      if (!inSelection) {
        const next: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty(), current: { cell: [hit.col, hit.row], range: { x: hit.col, y: hit.row, width: 1, height: 1 }, rangeStack: [] } };
        setSelection(next);
        pr.current.onSelectionChange(toInfo(next));
      }
      menuOpenedAt.current = performance.now();
      pr.current.onCellContextMenu(hit, { x, y, width: 1, height: 1 });
    };
    const onStart = (e: TouchEvent) => {
      cancel();
      fired = false;
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t) return;
      start = { x: t.clientX, y: t.clientY };
      timer = window.setTimeout(fire, LONG_PRESS_MS);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > LONG_PRESS_TOLERANCE_PX) cancel();
    };
    // The lift that ends a long press is not a tap: Glide must not select the cell or open its editor.
    const onEnd = (e: TouchEvent) => {
      cancel();
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    };
    wrap.addEventListener("touchstart", onStart, { passive: true });
    wrap.addEventListener("touchmove", onMove, { passive: true });
    wrap.addEventListener("touchend", onEnd, { capture: true });
    wrap.addEventListener("touchcancel", onEnd, { capture: true });
    return () => {
      cancel();
      wrap.removeEventListener("touchstart", onStart);
      wrap.removeEventListener("touchmove", onMove);
      wrap.removeEventListener("touchend", onEnd, { capture: true });
      wrap.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, []);

  const onCellsEdited = useCallback((items: readonly EditListItem[]) => {
    const edits: CellEdit[] = [];
    for (const { location, value } of items) {
      const [col, row] = location;
      if (value.kind === GridCellKind.Boolean) {
        edits.push({ col, row, json: value.data === true ? true : null });
      } else if (value.kind === GridCellKind.Custom && isObCell(value)) {
        const data = value.data;
        if (data.ob !== "cell") continue;
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

  // Glide copies these cells' `copyData`, and fits a column to them (`measure`): so they are the grid's own
  // cells, as drawn, carrying the copy text, once the rows are loaded.
  const getCellsForSelection = useCallback((rect: Rectangle) => async (): Promise<readonly (readonly GridCell[])[]> => {
    const text = await pr.current.getCopyText({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    return text.map((row, j) =>
      row.map((t, i): GridCell => {
        const col = rect.x + i;
        const own = col < pr.current.columns.length ? toGridCell(pr.current.getCell(col, rect.y + j)) : null;
        return own && own.kind === GridCellKind.Custom ? { ...own, copyData: t } : { kind: GridCellKind.Text, allowOverlay: false, readonly: true, data: t, displayData: t, copyData: t };
      }),
    );
  }, []);

  const ObEditor = useMemo<ProvideEditorComponent<ObCell>>(
    () =>
      function ObEditorBridge({ value, onChange, onFinishedEditing, initialValue, target }) {
        const data = value.data;
        if (data.ob !== "cell") return null;
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
      if (!isObCell(cell) || cell.data.ob !== "cell" || !pr.current.canEdit) return undefined;
      // The editor component is typed for ObCell; Glide hands it exactly those cells.
      return { editor: ObEditor as unknown as ProvideEditorComponent<GridCell>, disablePadding: true, disableStyling: true };
    },
    [ObEditor],
  );

  const theme = gridTheme(props.dark, props.accent);
  // Where the pointer last pressed over the grid, to tell Glide's select-on-focus from a real tap.
  const lastPress = useRef<Press | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const note = (e: PointerEvent) => {
      lastPress.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    wrap.addEventListener("pointerdown", note, { capture: true, passive: true });
    wrap.addEventListener("pointerup", note, { capture: true, passive: true });
    return () => {
      wrap.removeEventListener("pointerdown", note, { capture: true });
      wrap.removeEventListener("pointerup", note, { capture: true });
    };
  }, []);

  const onGridSelectionChange = useCallback((sel: GridSelection) => {
    // A tap on blank space leaves nothing selected, whatever Glide does when it takes the focus.
    if (isFocusSelectAfterPress(selectionRef.current, sel, lastPress.current, performance.now(), (c, r) => gridRef.current?.getBounds(c, r))) return;
    setSelection(sel);
    pr.current.onSelectionChange(toInfo(sel));
  }, []);

  // Which linked record's chip the pointer is over, if any: the host shows its preview.
  const hoveredLink = useRef<string | null>(null);
  const onMouseMove = useCallback((args: GridMouseEventArgs) => {
    const report = pr.current.onLinkHover;
    if (!report) return;
    const hit = args.kind === "cell" ? linkChipAt(pr.current, args.location, args.bounds, args.localEventX, args.localEventY) : null;
    const key = hit ? `${hit.point.col}:${hit.point.row}:${hit.recordId}` : null;
    if (key === hoveredLink.current) return;
    hoveredLink.current = key;
    report(hit);
  }, []);

  const onCellClicked = useCallback((cell: Item, ev: { bounds: Rectangle; isDoubleClick?: boolean }) => {
    const model = pr.current.getCell(cell[0], cell[1]);
    if (model.kind === "group") pr.current.onGroupToggle(model.headerIndex);
    else if (model.kind === "summary") pr.current.onSummaryClick(cell[0], screenRect(ev.bounds));
  }, []);


  const primary = props.columns[0];
  const primaryWidth = primary ? (primary.width ?? fitted[primary.id] ?? FIT_PLACEHOLDER_WIDTH) : 0;
  const pinLeft = primary ? primaryWidth - HEADER_MENU_WIDTH - PIN_BUTTON_SIZE - (pin?.pinned ? 0 : scrollLeft) : 0;

  // The row numbers' column: as wide as this device last made it, by dragging its edge in the header
  // (Glide cannot resize it itself) or with the arrow keys; a double-click sets it back.
  const [markerWidth, setMarkerWidth] = useState(storedMarkerWidth);
  const markers = useMemo(() => rowMarkers(markerWidth), [markerWidth]);
  const markerDrag = useRef<{ x: number; width: number } | null>(null);
  const keepMarker = (w: number) => {
    setMarkerWidth(w);
    try {
      localStorage.setItem(MARKER_KEY, String(w));
    } catch {
      /* not kept: it still holds for this page */
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onPointerLeave={() => {
        // Off the grid altogether, the canvas reports no more moves.
        if (hoveredLink.current === null) return;
        hoveredLink.current = null;
        pr.current.onLinkHover?.(null);
      }}
    >
    <DataEditor
      ref={gridRef}
      className="ob-glide"
      width="100%"
      height="100%"
      columns={columns}
      rows={props.rowCount + (props.showSummary ? 1 : 0)}
      freezeTrailingRows={props.showSummary ? 1 : 0}
      rowHeight={props.rowHeight}
      headerHeight={GRID_HEADER_HEIGHT}
      freezeColumns={props.freezeColumns}
      getCellContent={getCellContent}
      customRenderers={customRenderers}
      provideEditor={provideEditor}
      theme={theme}
      headerIcons={headerIcons()}
      drawHeader={drawHeader}
      rowMarkers={markers}
      // Rows read as lines of a list, as in the rest of the app; the header still shows where columns
      // meet, and that is where they resize.
      verticalBorder={false}
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
      onColumnResizeStart={() => {
        resizeMoved.current = false;
      }}
      onColumnResize={(_c, w, idx) => {
        resizeMoved.current = true;
        pr.current.onColumnResize(idx, w, false);
      }}
      // A press on a column's edge without a drag ends with Glide's "no width yet", which it clamps to the
      // narrowest column: a click would collapse it. Only a drag resizes; a double-click fits the column
      // (Glide measures it after the second release and reports it through onColumnResize).
      onColumnResizeEnd={(_c, w, idx) => {
        if (resizeMoved.current) pr.current.onColumnResize(idx, w, true);
      }}
      onColumnMoved={props.canReorderColumns ? (from, to) => pr.current.onColumnMove(from, to) : undefined}
      onRowMoved={props.canReorderRows ? (from, to) => pr.current.onRowMove(from, to) : undefined}
      onHeaderMenuClick={(col, bounds) => col < pr.current.columns.length && pr.current.onHeaderMenu(col, screenRect(bounds))}
      onHeaderContextMenu={(col, ev) => {
        ev.preventDefault();
        // The "Add field" header past the last column has no menu.
        if (col < pr.current.columns.length) pr.current.onHeaderMenu(col, screenRect(ev.bounds));
      }}
      onMouseMove={onMouseMove}
      onCellContextMenu={(cell, ev) => {
        ev.preventDefault();
        if (performance.now() - menuOpenedAt.current < 600) return;
        pr.current.onCellContextMenu({ col: cell[0], row: cell[1] }, { x: ev.bounds.x + ev.localEventX, y: ev.bounds.y + ev.localEventY, width: 1, height: 1 });
      }}
      onCellClicked={onCellClicked}
      onHeaderClicked={(col) => {
        if (col >= pr.current.columns.length) pr.current.onAddField();
      }}
      onKeyDown={(e) => {
        // The menu key (or Shift+F10) opens the record menu of the focused cell, or of the first selected row.
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          const row = e.location?.[1] ?? selectionRef.current.rows.first();
          const col = Math.min(e.location?.[0] ?? 0, Math.max(0, pr.current.columns.length - 1));
          const b = row === undefined ? undefined : gridRef.current?.getBounds(col, row);
          if (row !== undefined && b) {
            e.cancel();
            e.preventDefault();
            menuOpenedAt.current = performance.now();
            pr.current.onCellContextMenu({ col, row }, { x: b.x + Math.min(24, b.width / 2), y: b.y + b.height / 2, width: 1, height: 1 });
            return;
          }
        }
        const handled = pr.current.onKeyDown({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, cell: e.location ? { col: e.location[0], row: e.location[1] } : null });
        if (handled) e.cancel();
      }}
      onDragOverCell={() => {}}
      onDrop={(cell, dt) => {
        const files = dt ? [...dt.files] : [];
        if (files.length > 0) pr.current.onDropFiles({ col: cell[0], row: cell[1] }, files);
      }}
      maxColumnWidth={800}
      // A column fitted with a double-click on its edge stops where an unsized one does.
      maxColumnAutoWidth={FIT_MAX_WIDTH}
      minColumnWidth={60}
    />
    {pin && primary && (
      // Clipped to the columns, so an unpinned primary field's button slides out under the row numbers.
      <div className="pointer-events-none absolute top-0 right-0 overflow-hidden" style={{ left: markerWidth, height: GRID_HEADER_HEIGHT }}>
        <button
          type="button"
          onClick={pin.onToggle}
          aria-pressed={pin.pinned}
          aria-label={pin.pinned ? `Unpin the ${primary.title} column` : `Pin the ${primary.title} column so it stays on screen`}
          title={pin.pinned ? `Unpin the ${primary.title} column` : `Pin the ${primary.title} column`}
          className={cn(
            "pointer-events-auto absolute flex items-center justify-center rounded-lg hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring",
            pin.pinned ? "text-primary-text" : "text-muted",
          )}
          style={{ left: pinLeft, top: (GRID_HEADER_HEIGHT - PIN_BUTTON_SIZE) / 2, width: PIN_BUTTON_SIZE, height: PIN_BUTTON_SIZE }}
        >
          <Pin aria-hidden className="size-4" fill={pin.pinned ? "currentColor" : "none"} />
        </button>
      </div>
    )}
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the row numbers"
      aria-valuenow={markerWidth}
      aria-valuemin={MARKER_MIN}
      aria-valuemax={MARKER_MAX}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        markerDrag.current = { x: e.clientX, width: markerWidth };
      }}
      onPointerMove={(e) => {
        const d = markerDrag.current;
        if (d) setMarkerWidth(clampMarker(d.width + e.clientX - d.x));
      }}
      onPointerUp={(e) => {
        const d = markerDrag.current;
        if (!d) return;
        markerDrag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        // A press without a drag changes nothing.
        if (e.clientX !== d.x) keepMarker(clampMarker(d.width + e.clientX - d.x));
      }}
      onPointerCancel={() => {
        markerDrag.current = null;
      }}
      onDoubleClick={() => keepMarker(ROW_MARKER_WIDTH)}
      onKeyDown={(e) => {
        const next = e.key === "ArrowLeft" ? markerWidth - 8 : e.key === "ArrowRight" ? markerWidth + 8 : null;
        if (next === null) return;
        e.preventDefault();
        keepMarker(clampMarker(next));
      }}
      className="group absolute top-0 z-10 flex w-2 cursor-col-resize touch-none justify-center focus-visible:outline-none"
      style={{ left: markerWidth - 4, height: GRID_HEADER_HEIGHT }}
    >
      <span aria-hidden className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-ring group-active:bg-primary" />
    </div>
    </div>
  );
});
