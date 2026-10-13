/**
 * The grid view (W9a). Wires the pieces together:
 *
 *   useViewConfig  saved/local view configuration
 *   useGridData    paged records + live refresh
 *   useRecordOps   optimistic edits, create/delete/move, undo/redo
 *   cellModels     O(1) cell lookup for the canvas
 *   GlideGrid      the canvas (behind the GridAdapter interface)
 *   ViewBar        toolbar (hide/filter/group/sort/colour/row height/search)
 *   ExpandedRecord modal reached by the row's expand icon, Shift+Space or `?record=recXXX`
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys, recordsApi, schemaApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { FieldDialog, type FieldDialogState } from "@/components/fields/FieldDialog";
import { EditorEnvProvider, type EditorEnv } from "@/components/record/editors/env";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import { uploadFiles } from "@/components/record/editors/AttachmentEditor";
import { ExpandedRecord } from "@/components/record/ExpandedRecord";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ViewBar } from "@/components/viewbar/ViewBar";
import { queryRelevantKey, reorderVisible, resolveFieldOrder, ROW_HEIGHT_PX, setFieldWidth, setSummary } from "@/components/viewbar/config";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { browserTimeZone } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import { useTheme } from "@/theme/ThemeProvider";
import { formatAggregate, aggregationShortLabel } from "@/lib/cells/aggregations";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { linkNames, parseText, type ParseCtx } from "@/lib/cells/parse";
import type { ViewProps } from "../types";
import type { CellEdit, CellModel, EditorHostProps, GridAdapterProps, GridColumnSpec, GridHandle, GridPoint, GridRange, GridSelectionInfo, ScreenRect } from "./adapter";
import { ColumnMenu, RowMenu, SummaryMenu } from "./GridMenus";
import { BLANK, LOADING, createCellModelFactory, cellValueOf, toColumnSpecs } from "./cellModels";
import { planClear, planFill, planPaste, selectionRectangles, type GridReader } from "./gridOps";
import { GlideGrid } from "./glide/GlideGrid";
import { buildRowMap, groupPathKeys } from "./rowMap";
import { UndoStack, type CellChange } from "./undo";
import { useGridData } from "./useGridData";
import { useRecordOps } from "./useRecordOps";
import { useViewConfig } from "./useViewConfig";

const EMPTY_SELECTION: GridSelectionInfo = { cell: null, ranges: [], rows: [], columns: [] };

export default function GridView(props: ViewProps) {
  // Everything that is per-view (undo history, scroll, selection, search) resets with the view.
  return <GridViewInner key={props.view.id} {...props} />;
}

function GridViewInner({ schema, table, view, role }: ViewProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const { resolved } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const timeZone = me.data?.timezone || browserTimeZone();
  const canEdit = atLeast(role, "editor");
  const canManageFields = atLeast(role, "creator");

  const collaborators = useQuery({ queryKey: keys.baseCollaborators(schema.id), queryFn: () => api.bases.collaborators(schema.id), staleTime: 60_000 });
  const people = useMemo(() => collaborators.data ?? [], [collaborators.data]);

  // ---- configuration, columns ------------------------------------------------------------------
  const cfg = useViewConfig(schema, table, view, role);
  const { config, queryConfig, transient } = cfg;
  const order = useMemo(() => resolveFieldOrder(table, config), [table, config]);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const columns = useMemo<GridColumnSpec[]>(() => toColumnSpecs(order.visible, table.primary_field_id, config.field_widths, liveWidths), [order.visible, table.primary_field_id, config.field_widths, liveWidths]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const freezeColumns = 1 + Math.min(config.frozen_columns, Math.max(0, columns.length - 1));
  const rowHeight = ROW_HEIGHT_PX[config.row_height];

  // ---- search ----------------------------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- data ------------------------------------------------------------------------------------
  const configKey = useMemo(() => queryRelevantKey(queryConfig), [queryConfig]);
  const data = useGridData({ tableId: table.id, viewId: view.id, configKey, search: debouncedSearch, timeZone, transient });
  const dataRef = useRef(data);
  dataRef.current = data;

  // Collapsed group headers (by path key); a different query starts expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groupKey = useMemo(() => JSON.stringify(queryConfig.groups), [queryConfig.groups]);
  useEffect(() => setCollapsed(new Set()), [groupKey]);
  const pathKeys = useMemo(() => groupPathKeys(data.groups), [data.groups]);
  const rowMap = useMemo(() => buildRowMap(data.total, data.groups, collapsed), [data.total, data.groups, collapsed]);
  const rowMapRef = useRef(rowMap);
  rowMapRef.current = rowMap;
  const grouped = data.groups.length > 0;
  const reorderable = canEdit && queryConfig.sorts.length === 0 && queryConfig.groups.length === 0 && !debouncedSearch;

  // Summaries.
  const summaryKey = useMemo(() => JSON.stringify(queryConfig.summaries), [queryConfig.summaries]);
  const hasSummary = Object.keys(queryConfig.summaries).length > 0;
  const aggregations = useQuery({
    queryKey: recordKeys.aggregations(table.id, view.id, `${configKey}|${summaryKey}`, debouncedSearch),
    // Only the filter of a local override matters to summaries.
    queryFn: ({ signal }) => recordsApi.aggregations(view.id, { search: debouncedSearch, timezone: timeZone, transient: transient?.filter ? { filter: transient.filter } : null, signal }),
    enabled: hasSummary,
    placeholderData: (prev) => prev,
  });

  // ---- formatting and editing environment ------------------------------------------------------
  const userNames = useMemo(() => new Map(people.map((u) => [u.id, u.name] as const)), [people]);
  const emails = useMemo(() => new Map(people.map((u) => [u.id, u.email] as const)), [people]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => userNames.get(id) }), [timeZone, userNames]);
  const editorEnv = useMemo<EditorEnv>(
    () => ({ baseId: schema.id, tableId: table.id, collaborators: people, timeZone, canCreateOptions: canManageFields, format, currentUserId: me.data?.id ?? null }),
    [schema.id, table.id, people, timeZone, canManageFields, format, me.data?.id],
  );

  // ---- cell models -----------------------------------------------------------------------------
  const factory = useMemo(() => createCellModelFactory(columns, format, canEdit), [columns, format, canEdit]);

  const summaryText = useCallback(
    (col: number): { label: string; text: string } => {
      const spec = columnsRef.current[col];
      if (!spec) return { label: "", text: "" };
      const agg = queryConfig.summaries[spec.id];
      if (!agg || agg === "none") return { label: "", text: "" };
      const value = aggregations.data?.values[spec.id];
      return { label: aggregationShortLabel(agg), text: aggregations.data ? formatAggregate(spec.field, agg, value, format) : "…" };
    },
    [queryConfig.summaries, aggregations.data, format],
  );

  const getCell = useCallback(
    (col: number, row: number): CellModel => {
      const map = rowMapRef.current;
      if (row === map.length) {
        const s = summaryText(col);
        return factory.summary(col, s.label, s.text);
      }
      const gi = map.groupAt(row);
      if (gi >= 0) {
        const g = dataRef.current.groups[gi];
        if (!g) return BLANK;
        if (col !== 0) return BLANK;
        const key = groupPathKeys(dataRef.current.groups)[gi] ?? "";
        return factory.group(gi, g.depth, g.label, g.count, collapsedRef.current.has(key));
      }
      const ri = map.recordIndexAt(row);
      const rec = dataRef.current.getRecord(ri);
      if (!rec) return LOADING;
      return factory.forRecord(rec, col, dataRef.current.rowColor(rec.id));
    },
    // The factory identity changes with columns/format/permissions; data and row map are read through refs.
    [factory, summaryText],
  );
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const getRowColor = useCallback((row: number): string | undefined => {
    const ri = rowMapRef.current.recordIndexAt(row);
    if (ri < 0) return undefined;
    const rec = dataRef.current.getRecord(ri);
    return rec ? dataRef.current.rowColor(rec.id) : undefined;
  }, []);

  const recordAtRow = useCallback((row: number): TableRecord | undefined => dataRef.current.getRecord(rowMapRef.current.recordIndexAt(row)), []);

  const reader = useMemo<GridReader>(
    () => ({
      columns,
      rowCount: rowMap.length,
      recordAt: (row) => recordAtRow(row),
      isRecordRow: (row) => rowMap.recordIndexAt(row) >= 0,
    }),
    [columns, rowMap, recordAtRow],
  );
  const readerRef = useRef(reader);
  readerRef.current = reader;

  // ---- operations ------------------------------------------------------------------------------
  const stack = useMemo(() => new UndoStack(), []);
  const ops = useRecordOps({ tableId: table.id, fields: table.fields, data, stack, canEdit });
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const gridRef = useRef<GridHandle>(null);
  const selectionRef = useRef<GridSelectionInfo>(EMPTY_SELECTION);

  const parseCtx = useCallback((linkIds?: ReadonlyMap<string, string>): ParseCtx => ({ timeZone, users: people, linkIds }), [timeZone, people]);

  /** Row's record index range to load for display rows [first, last]. */
  const loadRows = useCallback(async (firstRow: number, lastRow: number) => {
    const range = rowMapRef.current.recordRange(firstRow, lastRow);
    if (range) await dataRef.current.loadRange(range[0], range[1]);
  }, []);

  const onVisibleRowsChange = useCallback((first: number, last: number) => {
    const range = rowMapRef.current.recordRange(first, last);
    if (range) dataRef.current.ensureRange(range[0], range[1]);
  }, []);

  const onCommitEdits = useCallback(
    (edits: readonly CellEdit[]) => {
      const changes: CellChange[] = [];
      for (const e of edits) {
        const spec = columnsRef.current[e.col];
        const rec = recordAtRow(e.row);
        if (!spec || !rec || spec.readOnly) continue;
        let after: unknown;
        if (e.text !== undefined) {
          const res = parseText(spec.field, e.text, { timeZone, users: people });
          if (!res.ok) {
            toast.toast({ title: `Could not set ${spec.field.name}`, description: res.error, variant: "error", durationMs: 6000 });
            continue;
          }
          after = spec.field.type === "link" ? null : res.value;
        } else after = e.json ?? null;
        changes.push({ recordId: rec.id, fieldId: spec.id, before: cellValueOf(rec, spec.field) ?? null, after });
      }
      void opsRef.current.applyChanges(changes, changes.length === 1 ? "Edit cell" : `Edit ${changes.length} cells`);
    },
    [recordAtRow, timeZone, people, toast],
  );

  const onPaste = useCallback(
    (target: GridPoint, rows: readonly (readonly string[])[]) => {
      // The summary row is not data: pasting there must not create records.
      if (target.row >= rowMapRef.current.length || !canEdit) return;
      void (async () => {
        const rd = readerRef.current;
        const lastRow = Math.min(rd.rowCount - 1, target.row + rows.length + 200);
        await loadRows(target.row, lastRow);
        // Link cells paste primary-field text: resolve the names to record ids first.
        const linkIds = new Map<string, string>();
        const names = new Map<string, string>();
        const wanted = new Map<string, Set<string>>(); // linked table -> names
        rows.forEach((line) =>
          line.forEach((text, c) => {
            const col = rd.columns[target.col + c];
            if (col?.field.type === "link") {
              const set = wanted.get(col.field.options.linked_table_id) ?? new Set<string>();
              for (const n of linkNames(text)) set.add(n);
              wanted.set(col.field.options.linked_table_id, set);
            }
          }),
        );
        try {
          for (const [tableId, set] of wanted) {
            for (const name of set) {
              const found = await recordsApi.lookup(tableId, name, { limit: 10 });
              const hit = found.records.find((r) => r.name.toLowerCase() === name.toLowerCase());
              if (hit) {
                linkIds.set(name.toLowerCase(), hit.id);
                names.set(hit.id, hit.name);
              }
            }
          }
        } catch (e) {
          toast.error(e, "Could not look up linked records");
          return;
        }
        const sel = selectionRef.current.ranges[0] ?? null;
        const plan = planPaste(rd, target, rows, { parse: parseCtx(linkIds), linkNames: names, selection: sel });
        if (plan.errors.length > 0) {
          toast.toast({ title: "Paste cancelled: some values do not fit their fields", description: plan.errors.slice(0, 3).join("\n"), variant: "error", durationMs: 9000 });
          return;
        }
        // Unknown select options need creating first (creators only); the server enforces who may.
        const total = plan.changes.length;
        if (plan.newRecords.length > 0) {
          const created = await opsRef.current.createRecords({ values: plan.newRecords });
          if (created.length > 0) toast.toast({ title: `Added ${created.length} new record${created.length === 1 ? "" : "s"}`, variant: "success" });
        }
        if (total > 0) await opsRef.current.applyChanges(plan.changes, total === 1 ? "Paste" : `Paste into ${total} cells`);
      })();
    },
    [loadRows, parseCtx, toast, canEdit],
  );

  const onClear = useCallback(
    (sel: GridSelectionInfo) => {
      void (async () => {
        const rd = readerRef.current;
        const rects = selectionRectangles(sel, rd.columns.length, rd.rowCount);
        for (const r of rects) await loadRows(r.y, r.y + r.height - 1);
        const plan = planClear(readerRef.current, rects);
        await opsRef.current.applyChanges(plan.changes, plan.changes.length === 1 ? "Clear cell" : `Clear ${plan.changes.length} cells`);
      })();
    },
    [loadRows],
  );

  const onFill = useCallback(
    (source: GridRange, destination: GridRange) => {
      void (async () => {
        await loadRows(Math.min(source.y, destination.y), Math.max(source.y + source.height, destination.y + destination.height) - 1);
        const plan = planFill(readerRef.current, source, destination, parseCtx(), format);
        if (plan.errors.length > 0) toast.toast({ title: "Some cells could not be filled", description: plan.errors.slice(0, 3).join("\n"), variant: "error" });
        await opsRef.current.applyChanges(plan.changes, `Fill ${plan.changes.length} cells`);
      })();
    },
    [loadRows, parseCtx, format, toast],
  );

  const getCopyText = useCallback(
    async (range: GridRange): Promise<string[][]> => {
      await loadRows(range.y, range.y + range.height - 1);
      const out: string[][] = [];
      for (let row = range.y; row < range.y + range.height; row++) {
        if (rowMapRef.current.recordIndexAt(row) < 0) continue;
        const rec = recordAtRow(row);
        const line: string[] = [];
        for (let c = range.x; c < range.x + range.width; c++) {
          const spec = columnsRef.current[c];
          line.push(rec && spec ? displayText(spec.field, cellValueOf(rec, spec.field), format) : "");
        }
        out.push(line);
      }
      return out;
    },
    [loadRows, recordAtRow, format],
  );

  // ---- structure changes from the grid ---------------------------------------------------------
  const onColumnResize = useCallback(
    (index: number, width: number, final: boolean) => {
      const spec = columnsRef.current[index];
      if (!spec) return;
      const commit = () => {
        resizeTimer.current = null;
        cfg.update((c) => setFieldWidth(c, spec.id, width));
        setLiveWidths((w) => {
          const { [spec.id]: _drop, ...rest } = w;
          return rest;
        });
      };
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (final) {
        commit();
        return;
      }
      setLiveWidths((w) => ({ ...w, [spec.id]: width }));
      // Save once the drag pauses, in case the release event never reaches the grid.
      resizeTimer.current = setTimeout(commit, 600);
    },
    [cfg],
  );
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onColumnMove = useCallback(
    (from: number, to: number) => {
      const cols = columnsRef.current;
      const a = cols[from];
      const b = cols[to];
      if (!a || !b || a.isPrimary || b.isPrimary) return;
      const ids = cols.map((c) => c.id);
      ids.splice(from, 1);
      ids.splice(to, 0, a.id);
      cfg.update((c) => reorderVisible(c, table, ids));
    },
    [cfg, table],
  );

  const onRowMove = useCallback(
    (from: number, to: number) => {
      const rec = recordAtRow(from);
      const target = recordAtRow(to);
      if (!rec || !target || rec.id === target.id) return;
      void opsRef.current.moveRecords([rec.id], to > from ? { afterId: target.id } : { beforeId: target.id });
    },
    [recordAtRow],
  );

  // ---- menus and dialogs -----------------------------------------------------------------------
  const [colMenu, setColMenu] = useState<{ index: number; at: ScreenRect } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ row: number; col: number; at: ScreenRect } | null>(null);
  const [sumMenu, setSumMenu] = useState<{ col: number; at: ScreenRect } | null>(null);
  /**
   * Close a context menu and hand the keyboard back to the grid. The menus hang off an invisible
   * anchor, so Radix has nothing to return focus to and it would fall to <body>, where Ctrl+Z (undo
   * of a delete done from the menu) and the other grid shortcuts no longer work.
   */
  const closeMenu = useCallback((set: (v: null) => void) => {
    set(null);
    gridRef.current?.focus();
  }, []);
  const [fieldDialog, setFieldDialog] = useState<FieldDialogState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[] } | null>(null);
  const [confirmField, setConfirmField] = useState<Field | null>(null);
  // A field inserted next to another one is placed once the refetched schema contains it.
  const [pendingPlace, setPendingPlace] = useState<{ id: string; relativeTo: { fieldId: string; side: "left" | "right" } } | null>(null);
  useEffect(() => {
    if (!pendingPlace || !table.fields.some((f) => f.id === pendingPlace.id)) return;
    const { id, relativeTo } = pendingPlace;
    setPendingPlace(null);
    cfg.update((c) => {
      const ids = resolveFieldOrder(table, c).all.map((x) => x.id).filter((x) => x !== id);
      const at = ids.indexOf(relativeTo.fieldId);
      ids.splice(relativeTo.side === "left" ? Math.max(1, at) : at + 1, 0, id);
      return { ...c, field_order: ids };
    });
  }, [pendingPlace, table, cfg]);

  const onGroupToggle = useCallback(
    (headerIndex: number) => {
      const key = pathKeys[headerIndex];
      if (!key) return;
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    [pathKeys],
  );

  // ---- expanded record -------------------------------------------------------------------------
  const openRecordId = searchParams.get("record");
  const openRecord = useCallback(
    (recordId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (recordId) next.set("record", recordId);
          else next.delete("record");
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );
  const onExpand = useCallback(
    (row: number) => {
      const rec = recordAtRow(row);
      if (rec) openRecord(rec.id);
    },
    [recordAtRow, openRecord],
  );

  /** Neighbouring record ids in grid order (for prev/next in the expanded record). */
  const neighbours = useMemo(() => {
    if (!openRecordId) return { prev: null as string | null, next: null as string | null };
    const idx = data.indexOf(openRecordId);
    if (idx < 0) return { prev: null, next: null };
    const row = rowMap.rowOfRecord(idx);
    const find = (dir: 1 | -1): string | null => {
      for (let r = row + dir; r >= 0 && r < rowMap.length; r += dir) {
        const rec = recordAtRow(r);
        if (rec) return rec.id;
        if (rowMap.recordIndexAt(r) >= 0) return null; // not loaded yet
      }
      return null;
    };
    return { prev: find(-1), next: find(1) };
    // `data.version` changes when pages arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRecordId, data.version, rowMap, recordAtRow]);

  // ---- add / delete rows -----------------------------------------------------------------------
  const addRecord = useCallback(async () => {
    const selectionBefore = selectionRef.current;
    const created = await opsRef.current.createRecords({});
    if (created.length === 0) return;
    // Wait for the refreshed pages, then bring the new row into view. Someone who has meanwhile
    // clicked into another cell (or is typing in one) keeps their selection.
    window.setTimeout(() => {
      if (selectionRef.current !== selectionBefore) return;
      const idx = dataRef.current.indexOf(created[0]!.id);
      const row = idx >= 0 ? rowMapRef.current.rowOfRecord(idx) : rowMapRef.current.length - 1;
      if (row >= 0) {
        gridRef.current?.scrollToRow(row);
        gridRef.current?.selectCell(0, row);
      }
    }, 400);
  }, []);

  const insertRecord = useCallback(
    async (row: number, where: "above" | "below") => {
      const rec = recordAtRow(row);
      if (!rec) return;
      if (where === "below") await opsRef.current.createRecords({ afterRecordId: rec.id });
      else await opsRef.current.createRecords({ beforeRecordId: rec.id });
    },
    [recordAtRow],
  );

  const selectedRecordIds = useCallback((fromRow: number): string[] => {
    const sel = selectionRef.current;
    const rows = new Set<number>();
    if (sel.rows.includes(fromRow)) sel.rows.forEach((r) => rows.add(r));
    else if (sel.ranges.some((r) => fromRow >= r.y && fromRow < r.y + r.height)) {
      for (const r of sel.ranges) for (let y = r.y; y < r.y + r.height; y++) rows.add(y);
    } else rows.add(fromRow);
    return [...rows].map((r) => recordAtRow(r)?.id).filter((id): id is string => !!id);
  }, [recordAtRow]);

  // ---- keyboard --------------------------------------------------------------------------------
  const onGridKey = useCallback<GridAdapterProps["onKeyDown"]>(
    (k) => {
      const mod = k.ctrlKey || k.metaKey;
      const key = k.key.toLowerCase();
      if (mod && key === "z") {
        void (k.shiftKey ? opsRef.current.redo() : opsRef.current.undo());
        return true;
      }
      if (mod && key === "y") {
        void opsRef.current.redo();
        return true;
      }
      if (k.shiftKey && !mod && k.key === " " && k.cell) {
        onExpand(k.cell.row);
        return true;
      }
      return false;
    },
    [onExpand],
  );

  // Undo/redo also work while focus sits on the toolbar or footer instead of the canvas.
  const onWrapperKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      if (onGridKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, cell: null })) e.preventDefault();
    },
    [onGridKey],
  );

  useEffect(() => {
    // Ctrl/Cmd+F searches the view instead of the browser page.
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.select(), 0);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Files pasted while a cell is selected become attachments.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const attach = useCallback(
    async (files: File[], at: GridPoint) => {
      const spec = columnsRef.current[at.col];
      const rec = recordAtRow(at.row);
      if (!spec || spec.field.type !== "attachment" || !rec || !canEdit) {
        toast.toast({ title: "Drop files onto an attachment cell", variant: "default" });
        return;
      }
      const res = await uploadFiles(schema.id, files);
      if (res.errors.length) toast.toast({ title: "Some files could not be uploaded", description: res.errors.slice(0, 3).join("\n"), variant: "error" });
      if (res.uploaded.length === 0) return;
      const before = cellValueOf(rec, spec.field) ?? null;
      const existing = Array.isArray(before) ? before : [];
      await opsRef.current.applyChanges([{ recordId: rec.id, fieldId: spec.id, before, after: [...existing, ...res.uploaded] }], "Add attachments");
    },
    [recordAtRow, canEdit, toast, schema.id],
  );

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onPasteEvent = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      const cell = selectionRef.current.cell;
      if (files.length > 0 && cell && (e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
        e.preventDefault();
        void attach(files, cell);
      }
    };
    el.addEventListener("paste", onPasteEvent);
    return () => el.removeEventListener("paste", onPasteEvent);
  }, [attach]);

  // ---- editor host -----------------------------------------------------------------------------
  const renderEditor = useCallback(
    (p: EditorHostProps) => (
      <EditorEnvProvider value={editorEnv}>
        <FieldEditor
          field={p.cell.field}
          value={p.cell.value}
          variant="cell"
          target={{ width: p.target.width, height: p.target.height }}
          initialText={p.initialText}
          onChange={p.onChange}
          onCommit={p.onCommit}
          onCancel={p.onCancel}
        />
      </EditorEnvProvider>
    ),
    [editorEnv],
  );

  // ---- render ----------------------------------------------------------------------------------
  const dark = resolved === "dark";
  const total = data.total;
  const rowCountForGrid = rowMap.length;
  const gridProps: GridAdapterProps = {
    columns,
    rowCount: rowCountForGrid,
    rowHeight,
    freezeColumns,
    showSummary: true,
    showRowNumbers: !grouped,
    searchTerm: debouncedSearch,
    dark,
    canEdit,
    canReorderRows: reorderable,
    canReorderColumns: true,
    version: data.version + (collapsed.size > 0 ? 1 : 0) + (hasSummary ? (aggregations.dataUpdatedAt % 1000) : 0),
    getCell,
    getRowColor,
    onVisibleRowsChange,
    onCommitEdits,
    onPaste,
    onClear,
    getCopyText,
    onFill,
    onColumnResize,
    onColumnMove,
    onRowMove,
    onHeaderMenu: (index, at) => setColMenu({ index, at }),
    onCellContextMenu: (point, at) => {
      if (rowMapRef.current.recordIndexAt(point.row) >= 0) setRowMenu({ row: point.row, col: point.col, at });
    },
    onGroupToggle,
    onSummaryClick: (col, at) => setSumMenu({ col, at }),
    onExpand,
    onSelectionChange: (sel) => {
      selectionRef.current = sel;
    },
    onKeyDown: onGridKey,
    canAddField: canManageFields,
    onAddField: () => setFieldDialog({ mode: "create" }),
    onDropFiles: (point, files) => void attach(files, point),
    renderEditor,
  };

  const colSpec = colMenu ? columns[colMenu.index] : undefined;

  return (
    <EditorEnvProvider value={editorEnv}>
      <div ref={wrapperRef} className="flex h-full min-h-[24rem] flex-col" onKeyDown={onWrapperKeyDown}>
        <ViewBar
          schema={schema}
          table={table}
          view={view}
          role={role}
          config={config}
          canConfigure={cfg.canConfigure}
          hasLocalQuery={transient !== null}
          onResetLocalQuery={cfg.resetTransient}
          saving={cfg.saving}
          update={cfg.update}
          collaborators={people}
          currentUserId={me.data?.id ?? null}
          search={search}
          onSearchChange={setSearch}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          searchInputRef={searchInputRef}
          onAddField={() => setFieldDialog({ mode: "create" })}
          canManageFields={canManageFields}
          timeZone={timeZone}
        />
        <div className="relative min-h-0 flex-1 border-t border-line bg-surface">
          {data.error && !data.loading && total === 0 ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 text-center text-[0.8125rem] text-muted">
              <p>Could not load records: {data.error.message}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => dataRef.current.refresh()}>
                  Try again
                </Button>
                {transient && (
                  <Button size="sm" variant="secondary" onClick={cfg.resetTransient}>
                    Reset my filters
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <GlideGrid ref={gridRef} {...gridProps} />
          )}
          {data.loading && total === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">
              <Spinner className="size-5" label="Loading records" />
            </div>
          )}
          {!data.loading && total === 0 && !data.error && (
            <p className="pointer-events-none absolute inset-x-0 top-14 text-center text-[0.8125rem] text-muted">{debouncedSearch ? "No records match your search." : "No records yet."}</p>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line bg-subtle px-3 text-[0.8125rem] text-muted">
          <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => void addRecord()}>
            <Plus aria-hidden className="size-4" /> Add record
          </Button>
          <span aria-live="polite">
            {total.toLocaleString()} record{total === 1 ? "" : "s"}
            {debouncedSearch ? " found" : ""}
          </span>
          {grouped && <span className="hidden sm:inline">· grouped</span>}
          {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
        </div>
      </div>

      <ColumnMenu
        index={colMenu?.index ?? -1}
        at={colMenu?.at ?? null}
        columns={columns}
        table={table}
        config={config}
        cfg={cfg}
        canManageFields={canManageFields}
        canSort
        onClose={() => closeMenu(setColMenu)}
        onEditField={(f, focus) => setFieldDialog({ mode: "edit", field: f, focus })}
        onInsert={(side) => colSpec && setFieldDialog({ mode: "create", relativeTo: { fieldId: colSpec.id, side } })}
        onDelete={(f) => setConfirmField(f)}
      />
      <RowMenu
        at={rowMenu?.at ?? null}
        canEdit={canEdit}
        onClose={() => closeMenu(setRowMenu)}
        onExpand={() => rowMenu && onExpand(rowMenu.row)}
        onInsert={(where) => rowMenu && void insertRecord(rowMenu.row, where)}
        onDuplicate={() => {
          if (!rowMenu) return;
          const recs = selectedRecordIds(rowMenu.row).map((id) => data.getRecord(data.indexOf(id))).filter((r): r is TableRecord => !!r);
          void opsRef.current.duplicateRecords(recs);
        }}
        onDelete={() => {
          if (!rowMenu) return;
          const ids = selectedRecordIds(rowMenu.row);
          if (ids.length > 1) setConfirmDelete({ ids });
          else void opsRef.current.deleteRecords(ids);
        }}
        count={rowMenu ? selectedRecordIds(rowMenu.row).length : 1}
        canInsert={reorderable}
      />
      <SummaryMenu
        at={sumMenu?.at ?? null}
        field={sumMenu ? columns[sumMenu.col]?.field : undefined}
        current={sumMenu ? (queryConfig.summaries[columns[sumMenu.col]?.id ?? ""] ?? "none") : "none"}
        canConfigure={cfg.canConfigure}
        onClose={() => closeMenu(setSumMenu)}
        onPick={(agg) => {
          const id = sumMenu ? columns[sumMenu.col]?.id : undefined;
          if (id) cfg.update((c) => setSummary(c, id, agg));
        }}
      />

      {fieldDialog && (
        <FieldDialog
          state={fieldDialog}
          schema={schema}
          table={table}
          onOpenChange={(open) => !open && setFieldDialog(null)}
          onSaved={(f, relativeTo) => relativeTo && setPendingPlace({ id: f.id, relativeTo })}
        />
      )}
      <ConfirmDialog
        open={!!confirmField}
        onOpenChange={(o) => !o && setConfirmField(null)}
        title={`Delete field "${confirmField?.name ?? ""}"?`}
        description="The field and its values are removed from every view. You can restore it from the trash."
        confirmLabel="Delete field"
        destructive
        onConfirm={async () => {
          if (!confirmField) return;
          await schemaApi.deleteField(confirmField.id);
          await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
        }}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.ids.length ?? 0} records?`}
        description="They are moved to the trash. Press Ctrl/Cmd+Z to undo."
        confirmLabel="Delete records"
        destructive
        onConfirm={async () => {
          if (confirmDelete) await opsRef.current.deleteRecords(confirmDelete.ids);
        }}
      />
      {openRecordId && (
        <ExpandedRecord
          schema={schema}
          table={table}
          view={view}
          role={role}
          recordId={openRecordId}
          config={config}
          prevId={neighbours.prev}
          nextId={neighbours.next}
          onNavigate={openRecord}
          onClose={() => openRecord(null)}
          emails={emails}
          timeZone={timeZone}
          currentUserId={me.data?.id ?? null}
          collaborators={people}
          onDeleteRecord={(id) => opsRef.current.deleteRecords([id])}
          onDuplicateRecord={async (rec) => (await opsRef.current.duplicateRecords([rec]))[0]}
        />
      )}
    </EditorEnvProvider>
  );
}
