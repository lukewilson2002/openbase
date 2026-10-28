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
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { FieldDialog, type FieldDialogState } from "@/components/fields/FieldDialog";
import { EditorEnvProvider, type EditorEnv } from "@/components/record/editors/env";
import { FieldEditor } from "@/components/record/editors/FieldEditor";
import { uploadFiles } from "@/components/record/editors/AttachmentEditor";
import { FloatingRecordPeek, linkedTableOf, type FloatingPeekTarget } from "@/components/record/linked/LinkedRecords";
import { LINKED_PARAM, RecordPanel, formatTrail } from "@/views/common/RecordPanel";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ViewBar } from "@/components/viewbar/ViewBar";
import { itemsLabel } from "@/views/common/cardFields";
import { SelectionBar } from "@/views/common/SelectionBar";
import { usePersistedSet } from "@/views/common/usePersistedSet";
import { deleteRecordsText } from "@/components/record/deleteText";
import { Redo2, Undo2 } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { EmptyRecords } from "@/views/common/EmptyRecords";
import { viewHugAreaClass, viewHugCardClass, viewHugFooterClass } from "@/views/common/ViewFrame";
import { queryRelevantKey, reorderVisible, resolveFieldOrder, ROW_HEIGHT_PX, setFieldWidth, setSummary } from "@/components/viewbar/config";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { browserTimeZone } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import { personColors } from "@/lib/colors";
import { useTheme } from "@/theme/ThemeProvider";
import { formatAggregate, aggregationShortLabel } from "@/lib/cells/aggregations";
import { displayText, type FormatCtx } from "@/lib/cells/format";
import { jsonEqual, linkNames, parseText, type ParseCtx } from "@/lib/cells/parse";
import { isEmptyValue, writableValues } from "@/lib/cells/wire";
import type { ViewProps } from "../types";
import type { CellEdit, CellModel, EditorHostProps, GridAdapterProps, GridColumnSpec, GridHandle, GridPoint, GridRange, GridSelectionInfo, ScreenRect } from "./adapter";
import { ColumnMenu, RowMenu, SummaryMenu } from "./GridMenus";
import { frozenColumnCount, usePrimaryPinned } from "./usePrimaryPinned";
import { ADD, BLANK, LOADING, createCellModelFactory, cellValueOf, toColumnSpecs } from "./cellModels";
import { countClearCells, linkKey, planClear, planFill, planPaste, selectionRectangles, summariseProblems, type Ambiguity, type GridReader } from "./gridOps";
import { GRID_HEADER_HEIGHT, GlideGrid } from "./glide/GlideGrid";
import { floatingAddGroup, newRecordValues } from "./addRows";
import { discardIfUntouched, type Fresh } from "./freshRows";
import { PAGE_SIZE, buildRowMap, groupPathKeys } from "./rowMap";
import { UndoStack, type CellChange, type UndoOp } from "./undo";
import { useGridData } from "./useGridData";
import { useRecordOps } from "./useRecordOps";
import { useViewConfig } from "./useViewConfig";

const EMPTY_SELECTION: GridSelectionInfo = { cell: null, ranges: [], rows: [], columns: [] };
const NO_ROWS: readonly number[] = [];
/** Clearing more cells than this asks first (a Delete over a column or Ctrl+A would empty a whole table). */
const CLEAR_CONFIRM_CELLS = 50;
/** Where the focus can go without leaving the grid: its cell editors and the menus and dialogs it opens (they hang off the page's body). */
const STILL_IN_GRID = "#portal, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Pages fetched at once when the records of a selection have to be loaded. */
const LOAD_PAGES_AT_ONCE = 4;
/** How long a new row is waited for before it is selected, and how many times it is looked for. */
const REVEAL_MS = 400;
const REVEAL_TRIES = 6;

export default function GridView(props: ViewProps) {
  // Everything that is per-view (undo history, scroll, selection, search) resets with the view.
  return <GridViewInner key={props.view.id} {...props} />;
}

function GridViewInner({ schema, table, view, role }: ViewProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const { resolved, accent } = useTheme();
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
  // On a phone the primary field can be unpinned from its header; on a desktop it always stays.
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [primaryPinned, togglePrimaryPinned] = usePrimaryPinned(view.id);
  const pinned = desktop || primaryPinned;
  const freezeColumns = frozenColumnCount(pinned, config.frozen_columns, columns.length);
  const rowHeight = ROW_HEIGHT_PX[config.row_height];

  // ---- search ----------------------------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const searchRef = useRef(search);
  searchRef.current = search;
  const debouncedRef = useRef(debouncedSearch);
  debouncedRef.current = debouncedSearch;
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- data ------------------------------------------------------------------------------------
  const configKey = useMemo(() => queryRelevantKey(queryConfig), [queryConfig]);
  const data = useGridData({ tableId: table.id, viewId: view.id, configKey, search: debouncedSearch, timeZone, transient });
  const dataRef = useRef(data);
  dataRef.current = data;

  // Collapsed group headers (by path key, which names the field and its value): remembered per view on
  // this device, so folding a group survives a reload and a visit to another view.
  const [collapsed, toggleCollapsed, replaceCollapsed] = usePersistedSet(`ob-grid-collapsed:${view.id}`);
  const pathKeys = useMemo(() => groupPathKeys(data.groups), [data.groups]);
  const rowMap = useMemo(() => buildRowMap(data.total, data.groups, collapsed, canEdit), [data.total, data.groups, collapsed, canEdit]);
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
  const colors = useMemo(() => personColors(people), [people]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => userNames.get(id), userEmail: (id) => emails.get(id), userColor: (id) => colors.get(id) }), [timeZone, userNames, emails, colors]);
  const editorEnv = useMemo<EditorEnv>(
    () => ({ baseId: schema.id, tableId: table.id, collaborators: people, timeZone, canCreateOptions: canManageFields, format, currentUserId: me.data?.id ?? null, schema }),
    [schema, table.id, people, timeZone, canManageFields, format, me.data?.id],
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
      if (map.isAddRow(row)) return col === 0 ? ADD : BLANK;
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
  const stack = useMemo(() => new UndoStack<UndoOp>(), []);
  const gridRef = useRef<GridHandle>(null);
  const selectionRef = useRef<GridSelectionInfo>(EMPTY_SELECTION);
  // Records came or went (a delete, a copy, an undo of either): the rows a selection named hold other records now.
  const onRowsChanged = useCallback(() => gridRef.current?.clearSelection(), []);
  // Records this grid added that nothing has been put into yet, with what they were made with.
  const fresh = useRef(new Map<string, Fresh>());
  // The ones that were changed in some way, even when put back.
  const touched = useRef(new Set<string>());
  const onEdited = useCallback((ids: readonly string[]) => {
    for (const id of ids) if (fresh.current.has(id)) touched.current.add(id);
  }, []);
  const ops = useRecordOps({ baseId: schema.id, tableId: table.id, fields: table.fields, data, stack, canEdit, onRowsChanged, onEdited });
  const opsRef = useRef(ops);
  opsRef.current = ops;

  // What is typed into the record panel is saved by the panel itself: put it on the same undo stack, so
  // Ctrl/Cmd+Z reverts the last thing done, not an older edit made in the grid.
  useEffect(
    () =>
      qc.getMutationCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const { mutation } = event;
        const key = mutation.options.mutationKey;
        if (key?.[0] !== "record-save" || key[1] !== table.id) return;
        const vars = mutation.state.variables as { recordId: string; field: Field; value: unknown } | undefined;
        if (vars?.recordId) onEdited([vars.recordId]);
        if (event.action.type !== "success") return;
        const prev = (mutation.state.context as { prev?: TableRecord } | undefined)?.prev;
        if (!vars || !prev) return;
        const before = prev.values[vars.field.id] ?? null;
        const after = isEmptyValue(vars.value) ? null : vars.value;
        if (jsonEqual(before, after)) return;
        stack.push({ kind: "edit", label: `Edit ${vars.field.name}`, changes: [{ recordId: vars.recordId, fieldId: vars.field.id, before, after }] });
      }),
    [qc, table.id, stack, onEdited],
  );

  const parseCtx = useCallback((linkIds?: ReadonlyMap<string, string>): ParseCtx => ({ timeZone, users: people, linkIds }), [timeZone, people]);

  /** Row's record index range to load for display rows [first, last]. */
  const loadRows = useCallback(async (firstRow: number, lastRow: number) => {
    const range = rowMapRef.current.recordRange(firstRow, lastRow);
    if (range) await dataRef.current.loadRange(range[0], range[1]);
  }, []);

  const visibleRows = useRef<[number, number] | null>(null);
  const onVisibleRowsChange = useCallback((first: number, last: number) => {
    visibleRows.current = [first, last];
    const range = rowMapRef.current.recordRange(first, last);
    if (range) dataRef.current.ensureRange(range[0], range[1]);
  }, []);
  // Folding or unfolding a group moves other records into the rows on screen without a scroll: those
  // rows now show records that may not be loaded yet, so the same rows are asked for again.
  useEffect(() => {
    const rows = visibleRows.current;
    if (!rows) return;
    const range = rowMap.recordRange(rows[0], rows[1]);
    if (range) dataRef.current.ensureRange(range[0], range[1]);
  }, [rowMap]);

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

  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[] } | null>(null);
  const [confirmClear, setConfirmClear] = useState<{ sel: GridSelectionInfo; cells: number } | null>(null);

  const onPaste = useCallback(
    (target: GridPoint, rows: readonly (readonly string[])[]) => {
      // The summary row is not data: pasting there must not create records.
      if (target.row >= rowMapRef.current.length || rowMapRef.current.isAddRow(target.row) || !canEdit) return;
      void (async () => {
        const rd = readerRef.current;
        const lastRow = Math.min(rd.rowCount - 1, target.row + rows.length + 200);
        await loadRows(target.row, lastRow);
        // Link cells paste primary-field text: resolve the names to record ids first. A name that matches
        // several records is not guessed at: those cells are skipped and reported.
        const linkIds = new Map<string, string>();
        const names = new Map<string, string>();
        const sameName = new Set<string>();
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
              const found = await recordsApi.lookup(tableId, name, { limit: 50 });
              const hits = found.records.filter((r) => r.name.toLowerCase() === name.toLowerCase());
              if (hits.length > 1) sameName.add(linkKey(tableId, name));
              else if (hits[0]) {
                // Names are resolved by text alone: the same name in two linked tables would hand one of them the other's record.
                const taken = linkIds.get(name.toLowerCase());
                if (taken && taken !== hits[0].id) {
                  sameName.add(linkKey(tableId, name));
                  for (const other of wanted.keys()) sameName.add(linkKey(other, name));
                } else {
                  linkIds.set(name.toLowerCase(), hits[0].id);
                  names.set(hits[0].id, hits[0].name);
                }
              }
            }
          }
        } catch (e) {
          toast.error(e, "Could not look up linked records");
          return;
        }
        // Several collaborators can share a name too.
        const seenNames = new Set<string>();
        const sharedNames = new Set<string>();
        for (const u of people) {
          const n = u.name.trim().toLowerCase();
          if (seenNames.has(n)) sharedNames.add(n);
          seenNames.add(n);
        }
        const ambiguous: Ambiguity = { links: sameName, users: sharedNames };
        const sel = selectionRef.current.ranges[0] ?? null;
        const plan = planPaste(rd, target, rows, { parse: parseCtx(linkIds), linkNames: names, selection: sel, ambiguous });
        // What fits is pasted; what does not is left as it was, and said so.
        const problems = summariseProblems(plan.errors);
        if (plan.readOnlyFields.length > 0) problems.push(`${plan.readOnlyFields.slice(0, 3).join(", ")}${plan.readOnlyFields.length > 3 ? " and more" : ""}: computed fields are left as they are`);
        const skipped = plan.errors.length;
        const steps: UndoOp[] = [];
        // Unknown select options need creating first (creators only); the server enforces who may.
        const created = plan.newRecords.length > 0 ? await opsRef.current.createRecords({ values: plan.newRecords, collect: steps }) : [];
        const total = plan.changes.length;
        if (total > 0) await opsRef.current.applyChanges(plan.changes, total === 1 ? "Paste" : `Paste into ${total} cells`, { collect: steps });
        if (steps.length === 0) {
          if (problems.length > 0) toast.toast({ title: "Nothing was pasted", description: problems.join("\n"), variant: "error", durationMs: 9000 });
          return;
        }
        const pieces = [total > 0 && `Pasted into ${total.toLocaleString()} ${total === 1 ? "cell" : "cells"}`, created.length > 0 && `added ${created.length.toLocaleString()} ${created.length === 1 ? "record" : "records"}`].filter(Boolean) as string[];
        const title = pieces.join(", ").replace(/^./, (c) => c.toUpperCase());
        opsRef.current.commit(steps, "Paste", problems.length > 0 ? { title, description: `${skipped > 0 ? `Skipped ${skipped.toLocaleString()} ${skipped === 1 ? "cell" : "cells"}:\n` : ""}${problems.join("\n")}` } : title);
      })();
    },
    [loadRows, parseCtx, toast, canEdit, people],
  );

  /** Ids of the records shown in these display rows, loading the pages they are on first. */
  const idsOfRows = useCallback(async (rows: readonly number[]): Promise<{ ids: string[]; missing: number }> => {
    const map = rowMapRef.current;
    const indexes = rows.map((r) => map.recordIndexAt(r)).filter((i) => i >= 0);
    const pages = [...new Set(indexes.map((i) => Math.floor(i / PAGE_SIZE)))];
    for (let i = 0; i < pages.length; i += LOAD_PAGES_AT_ONCE) {
      await Promise.all(pages.slice(i, i + LOAD_PAGES_AT_ONCE).map((p) => dataRef.current.loadRange(p * PAGE_SIZE, p * PAGE_SIZE)));
    }
    const ids: string[] = [];
    let missing = 0;
    for (const i of indexes) {
      const rec = dataRef.current.getRecord(i);
      if (rec) ids.push(rec.id);
      else missing++;
    }
    return { ids, missing };
  }, []);

  /** The records of these rows, or null (with a word on screen) when some could not be loaded: nothing is done to a part of a selection. */
  const recordsOfRows = useCallback(
    async (rows: readonly number[], doing: string): Promise<string[] | null> => {
      if (rows.length > PAGE_SIZE) toast.toast({ title: `Loading ${rows.length.toLocaleString()} records…`, durationMs: 3000 });
      const { ids, missing } = await idsOfRows(rows);
      if (missing > 0) {
        toast.toast({ title: `Nothing was ${doing}`, description: `${missing.toLocaleString()} of the selected records could not be loaded. Try again.`, variant: "error" });
        return null;
      }
      return ids;
    },
    [idsOfRows, toast],
  );

  const deleteRows = useCallback(
    async (rows: readonly number[]) => {
      if (!canEdit || rows.length === 0) return;
      const ids = await recordsOfRows(rows, "deleted");
      if (!ids || ids.length === 0) return;
      // One record goes at once (the toast offers Undo); several ask first, with their count.
      if (ids.length === 1) void opsRef.current.deleteRecords(ids);
      else setConfirmDelete({ ids });
    },
    [canEdit, recordsOfRows],
  );

  const duplicateRows = useCallback(
    async (rows: readonly number[]) => {
      if (!canEdit || rows.length === 0) return;
      const ids = await recordsOfRows(rows, "duplicated");
      if (ids && ids.length > 0) await opsRef.current.duplicateRecords(ids);
    },
    [canEdit, recordsOfRows],
  );

  const clearCells = useCallback(
    async (sel: GridSelectionInfo) => {
      const rd = readerRef.current;
      const rects = selectionRectangles(sel, rd.columns.length, rd.rowCount);
      for (const r of rects) await loadRows(r.y, r.y + r.height - 1);
      const plan = planClear(readerRef.current, rects);
      const n = plan.changes.length;
      const steps: UndoOp[] = [];
      if (await opsRef.current.applyChanges(plan.changes, n === 1 ? "Clear cell" : `Clear ${n} cells`, { collect: steps })) {
        opsRef.current.commit(steps, `Clear ${n} cells`, n > 1 ? `Cleared ${n.toLocaleString()} cells` : undefined);
      }
    },
    [loadRows],
  );

  // Delete and Backspace: on rows picked with their checkboxes they delete the records; on cells they empty them.
  const onClear = useCallback(
    (sel: GridSelectionInfo) => {
      if (!canEdit) return;
      if (sel.rows.length > 0) {
        void deleteRows(sel.rows);
        return;
      }
      const rd = readerRef.current;
      const cells = countClearCells(selectionRectangles(sel, rd.columns.length, rd.rowCount), rd.columns, rd.rowCount, rd.isRecordRow);
      if (cells > CLEAR_CONFIRM_CELLS) setConfirmClear({ sel, cells });
      else void clearCells(sel);
    },
    [canEdit, deleteRows, clearCells],
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
      // Where it was, for Undo: right after the record above it, or right before the one below.
      const above = from > 0 ? recordAtRow(from - 1) : undefined;
      const below = recordAtRow(from + 1);
      const previous = above ? { afterId: above.id } : below ? { beforeId: below.id } : undefined;
      void opsRef.current.moveRecords([rec.id], to > from ? { afterId: target.id } : { beforeId: target.id }, previous);
    },
    [recordAtRow],
  );

  // ---- menus and dialogs -----------------------------------------------------------------------
  const [colMenu, setColMenu] = useState<{ index: number; at: ScreenRect } | null>(null);
  /** `rows`: the display rows the menu acts on (the selection when the row is in it), counting the ones not loaded yet. */
  const [rowMenu, setRowMenu] = useState<{ row: number; col: number; at: ScreenRect; rows: number[] } | null>(null);
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
      if (key) toggleCollapsed(key);
    },
    [pathKeys, toggleCollapsed],
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
          // Linked records opened on top of the record go with it.
          next.delete(LINKED_PARAM);
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

  // A linked record's chip under the pointer: its preview floats over it, with Open (the cell's record
  // in the panel, and the linked one on top of it, a step back away).
  const [linkHover, setLinkHover] = useState<FloatingPeekTarget | null>(null);
  /** Opens `cellRecordId` in the panel with the linked record on top of it (a step back away). */
  const openLinkedFromCell = useCallback(
    (cellRecordId: string, tableId: string, recordId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("record", cellRecordId);
        next.set(LINKED_PARAM, formatTrail([{ tableId, recordId }]));
        return next;
      });
    },
    [setSearchParams],
  );

  /** Record indexes of the rows before and after the open record in grid order (-1: none), skipping group headers and folded groups. */
  const neighbourIndexes = useMemo(() => {
    const none = { prev: -1, next: -1 };
    if (!openRecordId) return none;
    const idx = data.indexOf(openRecordId);
    const row = idx < 0 ? -1 : rowMap.rowOfRecord(idx);
    if (row < 0) return none;
    const find = (dir: 1 | -1): number => {
      for (let r = row + dir; r >= 0 && r < rowMap.length; r += dir) {
        const i = rowMap.recordIndexAt(r);
        if (i >= 0) return i;
      }
      return -1;
    };
    return { prev: find(-1), next: find(1) };
    // `data.version` changes when pages arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRecordId, data.version, rowMap]);
  /** Neighbouring record ids in grid order (for prev/next in the expanded record); null until their page has arrived. */
  const neighbours = useMemo(
    () => ({
      prev: neighbourIndexes.prev >= 0 ? (dataRef.current.getRecord(neighbourIndexes.prev)?.id ?? null) : null,
      next: neighbourIndexes.next >= 0 ? (dataRef.current.getRecord(neighbourIndexes.next)?.id ?? null) : null,
    }),
    // `data.version` changes when pages arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [neighbourIndexes, data.version],
  );
  // Stepping through the records must not stop where the loaded pages do: the pages of the records on
  // either side of the open one are fetched, and the buttons enable themselves when they arrive. (Not
  // `ensureRange`: that is the range on screen, which a refresh keeps.)
  useEffect(() => {
    for (const i of [neighbourIndexes.prev, neighbourIndexes.next]) if (i >= 0 && !dataRef.current.getRecord(i)) void dataRef.current.loadRange(i, i);
  }, [neighbourIndexes, data.version]);

  // ---- add / delete rows -----------------------------------------------------------------------
  // The new row is selected and scrolled into view once its page has arrived, unless the person has
  // picked another cell by then. Quick successive clicks share one pending reveal (the last new row
  // wins, and "before" stays the selection from the first click), so no stale timer can move the
  // selection from under a click that came later.
  const reveal = useRef<{ timer: number; before: GridSelectionInfo } | null>(null);
  useEffect(
    () => () => {
      if (reveal.current) window.clearTimeout(reveal.current.timer);
    },
    [],
  );

  /** Add a record the grid will take back again if it is left untouched. Resolves with the new record, or null. */
  const createFresh = useCallback(
    async (opts: { values: Record<string, unknown>; afterRecordId?: string; beforeRecordId?: string }): Promise<TableRecord | null> => {
      const steps: UndoOp[] = [];
      const [rec] = await opsRef.current.createRecords({ values: [opts.values], afterRecordId: opts.afterRecordId, beforeRecordId: opts.beforeRecordId, collect: steps });
      if (!rec) return null;
      opsRef.current.commit(steps, "Add record");
      fresh.current.set(rec.id, { values: writableValues(table.fields, rec.values as Record<string, unknown>), op: steps[0] ?? null });
      return rec;
    },
    [table.fields],
  );

  // The selection moves by itself in a few places (the new row, a selection kept in step with a row
  // that went away); those moves are not the person leaving a row.
  const selectingBySelf = useRef(false);
  const selectQuietly = useCallback((move: () => void) => {
    selectingBySelf.current = true;
    try {
      move();
    } finally {
      selectingBySelf.current = false;
    }
  }, []);

  /** Add a record (into group `group` of the group headers, when given; the end of the table otherwise) and select it. */
  const addRecord = useCallback(
    async (target: { group?: number } = {}) => {
      const focused = document.activeElement;
      const values = newRecordValues(table.fields, queryConfig.filter, dataRef.current.groups, target.group ?? -1, me.data?.id ?? null);
      // Groups are known by their path, which outlasts the rows moving around.
      const groupKey = target.group !== undefined && target.group >= 0 ? groupPathKeys(dataRef.current.groups)[target.group] : undefined;
      // A search would hide the new, empty record: show everything again first, so it can be typed into.
      if (searchRef.current.trim() !== "") {
        selectQuietly(() => gridRef.current?.clearSelection());
        setSearch("");
        for (let waited = 0; (debouncedRef.current !== "" || dataRef.current.loading) && waited < 3000; waited += 50) await sleep(50);
      }
      const before = reveal.current?.before ?? selectionRef.current;
      const created = await createFresh({ values });
      if (!created) return;
      if (reveal.current) window.clearTimeout(reveal.current.timer);
      // Its page may take a moment to arrive: look again a few times. Until then scroll to where it
      // will be (the end of its group, or of the table) to load it, but never select a row that is
      // another record.
      let tries = 0;
      const look = () => {
        if (selectionRef.current !== before) return void (reveal.current = null);
        const idx = dataRef.current.indexOf(created.id);
        const row = idx >= 0 ? rowMapRef.current.rowOfRecord(idx) : -1;
        if (row < 0) {
          const map = rowMapRef.current;
          const gi = groupKey ? groupPathKeys(dataRef.current.groups).indexOf(groupKey) : -1;
          let end = -1;
          if (gi >= 0) {
            for (let r = 0; r < map.length && end < 0; r++) if (map.isAddRow(r) && map.addGroupAt(r) === gi) end = r;
          } else if (!grouped && dataRef.current.total > 0) end = map.rowOfRecord(dataRef.current.total - 1);
          if (end >= 0) gridRef.current?.scrollToRow(end);
          if (++tries < REVEAL_TRIES) reveal.current = { timer: window.setTimeout(look, REVEAL_MS), before };
          else reveal.current = null;
          return;
        }
        reveal.current = null;
        gridRef.current?.scrollToRow(row);
        selectQuietly(() => gridRef.current?.selectCell(0, row));
        // The keyboard is still on the "Add" button (or nowhere) that was used: hand it to the
        // grid, or the new row looks selected while typing goes to the button, and a click on that
        // already selected cell would not move the focus either.
        if (document.activeElement === focused || document.activeElement === document.body) gridRef.current?.focus();
      };
      reveal.current = { timer: window.setTimeout(look, REVEAL_MS), before };
    },
    [table.fields, queryConfig.filter, me.data?.id, createFresh, selectQuietly, grouped],
  );

  /** The group the floating Add adds into: that of the selected row, else the one at the top of what is on screen. */
  const floatingGroup = useCallback((): number => {
    const sel = selectionRef.current;
    const gi = floatingAddGroup(rowMapRef.current, dataRef.current.groups, sel.cell?.row ?? sel.rows[0] ?? null, visibleRows.current?.[0] ?? null);
    // Adding into a folded group would hide the new record: unfold it.
    const key = gi >= 0 ? groupPathKeys(dataRef.current.groups)[gi] : undefined;
    if (key && collapsedRef.current.has(key)) toggleCollapsed(key);
    return gi;
  }, [toggleCollapsed]);

  const insertRecord = useCallback(
    async (row: number, where: "above" | "below") => {
      const rec = recordAtRow(row);
      if (!rec) return;
      // Rows below the new one move down: a selection of rows would name other records.
      if (selectionRef.current.rows.length > 0) gridRef.current?.clearSelection();
      const values = newRecordValues(table.fields, queryConfig.filter, dataRef.current.groups, -1, me.data?.id ?? null);
      await createFresh(where === "below" ? { values, afterRecordId: rec.id } : { values, beforeRecordId: rec.id });
    },
    [recordAtRow, table.fields, queryConfig.filter, me.data?.id, createFresh],
  );

  // ---- untouched new rows go away ---------------------------------------------------------------
  // A record added here and left empty when the person clicks off is taken back, as if it had never
  // been added: no toast, nothing in the trash or the history, and no step left in Undo.
  const openIdRef = useRef(openRecordId);
  openIdRef.current = openRecordId;
  const takeBack = useCallback(
    async (id: string, made: Fresh) => {
      const idx = dataRef.current.indexOf(id);
      const row = idx >= 0 ? rowMapRef.current.rowOfRecord(idx) : -1;
      const gone = await discardIfUntouched(id, made, {
        fields: table.fields,
        touched: (x) => touched.current.has(x),
        saving: () => opsRef.current.saving(),
        load: (x) => recordsApi.get(table.id, x),
        discard: (x) => recordsApi.discard(table.id, x),
        sleep,
      });
      touched.current.delete(id);
      if (!gone) return;
      if (made.op) stack.drop(made.op);
      void qc.invalidateQueries({ queryKey: ["records"] });
      // The rows under it move up: keep what is selected on the same records.
      const sel = selectionRef.current;
      if (row < 0) return;
      const range = sel.ranges[0];
      if (sel.cell && sel.rows.length === 0 && sel.columns.length === 0 && sel.ranges.length === 1 && range?.width === 1 && range.height === 1) {
        if (sel.cell.row > row) selectQuietly(() => gridRef.current?.selectCell(sel.cell!.col, sel.cell!.row - 1));
      } else if (sel.rows.some((r) => r > row) || sel.ranges.some((r) => r.y + r.height - 1 > row)) selectQuietly(() => gridRef.current?.clearSelection());
    },
    [table.fields, table.id, stack, qc, selectQuietly],
  );

  /** Take back the new records that are no longer selected (`leaving`: all of them, the grid is being left). */
  const sweepFresh = useCallback(
    (leaving = false) => {
      if (fresh.current.size === 0) return;
      const sel = selectionRef.current;
      for (const [id, made] of [...fresh.current]) {
        if (id === openIdRef.current) continue;
        if (!leaving) {
          const idx = dataRef.current.indexOf(id);
          // Not on screen: while the new row is still being looked for it may yet be selected;
          // after that (a filter hides it, say) it cannot be what the person is working on.
          if (idx < 0 && reveal.current) continue;
          const row = rowMapRef.current.rowOfRecord(idx);
          if (sel.columns.length > 0 || (row >= 0 && (sel.rows.includes(row) || sel.ranges.some((r) => row >= r.y && row < r.y + r.height)))) continue;
        }
        fresh.current.delete(id);
        void takeBack(id, made);
      }
    },
    [takeBack],
  );
  const sweepRef = useRef(sweepFresh);
  sweepRef.current = sweepFresh;

  // A record panel closing leaves the record it was on, if the selection is elsewhere.
  useEffect(() => {
    if (!openRecordId) sweepRef.current();
  }, [openRecordId]);

  // Focus going to somewhere else in the page, or the grid going away, leaves every new row.
  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      // Within the grid's own page area, in one of its pop-ups, or the window itself losing focus.
      if (to ? wrap.contains(to) || to.closest(STILL_IN_GRID) : !document.hasFocus()) return;
      sweepRef.current(true);
    };
    wrap.addEventListener("focusout", onFocusOut);
    return () => {
      wrap.removeEventListener("focusout", onFocusOut);
      sweepRef.current(true);
    };
  }, []);

  /** The display rows a menu opened on `fromRow` acts on: the selected rows, or the rows of the selected cells, or that row. */
  const rowsForMenu = useCallback((fromRow: number): number[] => {
    const sel = selectionRef.current;
    const rows = new Set<number>();
    if (sel.rows.includes(fromRow)) sel.rows.forEach((r) => rows.add(r));
    else if (sel.ranges.some((r) => fromRow >= r.y && fromRow < r.y + r.height)) {
      for (const r of sel.ranges) for (let y = r.y; y < r.y + r.height; y++) rows.add(y);
    } else rows.add(fromRow);
    // Group headers and the summary row are not records.
    return [...rows].filter((r) => rowMapRef.current.recordIndexAt(r) >= 0).sort((a, b) => a - b);
  }, []);

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
      // Enter, Space and F2 fold a group from its header and open the summary menu from a summary cell.
      if (k.cell && !mod && !k.shiftKey && !k.altKey && (k.key === "Enter" || k.key === " " || k.key === "F2")) {
        const map = rowMapRef.current;
        const group = map.groupAt(k.cell.row);
        if (group >= 0) {
          onGroupToggle(group);
          return true;
        }
        if (map.isAddRow(k.cell.row)) {
          void addRecord({ group: map.addGroupAt(k.cell.row) });
          return true;
        }
        if (k.cell.row === map.length) {
          const at = gridRef.current?.cellBounds(k.cell.col, k.cell.row);
          if (at) setSumMenu({ col: k.cell.col, at });
          return true;
        }
      }
      return false;
    },
    [onExpand, onGroupToggle, addRecord],
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
  const cardRef = useRef<HTMLDivElement>(null);
  const hScrollbar = useHorizontalScrollbarHeight(cardRef);
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

  // The marker column counts records in the view; group headers and the summary row have no number.
  const rowNumber = useCallback((row: number): number | null => {
    const i = rowMapRef.current.recordIndexAt(row);
    return i >= 0 ? i + 1 : null;
  }, []);

  // ---- render ----------------------------------------------------------------------------------
  // Rows picked with their checkboxes, and how many records that is (the ones not loaded yet count too).
  const [selectedRows, setSelectedRows] = useState<readonly number[]>(NO_ROWS);
  const selectedRecordRows = useMemo(() => selectedRows.filter((r) => rowMap.recordIndexAt(r) >= 0), [selectedRows, rowMap]);
  const insertNote = useMemo(() => {
    const why = [queryConfig.sorts.length > 0 && "sorted", grouped && "grouped", debouncedSearch !== "" && "filtered by a search"].filter(Boolean);
    return why.length === 0 ? undefined : `Records cannot be inserted at a place while the view is ${why.join(" and ")}. Remove that to insert above or below.`;
  }, [queryConfig.sorts.length, grouped, debouncedSearch]);
  const history = ops.history;
  const dark = resolved === "dark";
  const total = data.total;
  const rowCountForGrid = rowMap.length;
  const empty = !data.loading && total === 0 && !data.error;
  const gridProps: GridAdapterProps = {
    columns,
    fitColumns: !data.loading,
    rowCount: rowCountForGrid,
    rowHeight,
    freezeColumns,
    primaryPin: desktop || !columns[0]?.isPrimary ? null : { pinned, onToggle: togglePrimaryPinned },
    showSummary: !empty,
    rowNumber,
    searchTerm: debouncedSearch,
    dark,
    accent,
    canEdit,
    canReorderRows: reorderable,
    canReorderColumns: true,
    version: data.version + collapsed.size + (hasSummary ? (aggregations.dataUpdatedAt % 1000) : 0),
    getCell,
    onVisibleRowsChange,
    onCommitEdits,
    onPaste,
    onClear,
    getCopyText,
    onFill,
    onColumnResize,
    onColumnMove,
    onRowMove,
    onHeaderMenu: (index, at) => {
      // The "Add field" header past the last column has no menu.
      if (columnsRef.current[index]) setColMenu({ index, at });
    },
    onCellContextMenu: (point, at) => {
      if (rowMapRef.current.recordIndexAt(point.row) >= 0) setRowMenu({ row: point.row, col: point.col, at, rows: rowsForMenu(point.row) });
    },
    onGroupToggle,
    onAddRow: (row) => void addRecord({ group: rowMapRef.current.addGroupAt(row) }),
    onSummaryClick: (col, at) => setSumMenu({ col, at }),
    onExpand,
    onSelectionChange: (sel) => {
      selectionRef.current = sel;
      setSelectedRows((cur) => (sel.rows.length === 0 && cur.length === 0 ? cur : sel.rows));
      // Resting on an add row is not leaving a new row: someone adding a few in a row keeps them all.
      if (!selectingBySelf.current && !(sel.cell && rowMapRef.current.isAddRow(sel.cell.row))) sweepFresh();
    },
    onKeyDown: onGridKey,
    canAddField: canManageFields,
    onAddField: () => setFieldDialog({ mode: "create" }),
    onDropFiles: (point, files) => void attach(files, point),
    onLinkHover: (hit) => {
      const field = hit ? columns[hit.point.col]?.field : undefined;
      const linked = field ? linkedTableOf(schema, field) : undefined;
      // The cell's record is taken now: rows can move under an open preview (a live update, a refetch).
      const cellRecord = hit ? recordAtRow(hit.point.row) : undefined;
      setLinkHover(
        hit && linked && cellRecord
          ? { key: `${cellRecord.id}:${hit.point.col}:${hit.recordId}`, table: linked, recordId: hit.recordId, rect: hit.rect, open: () => openLinkedFromCell(cellRecord.id, linked.id, hit.recordId) }
          : null,
      );
    },
    renderEditor,
  };

  const colSpec = colMenu ? columns[colMenu.index] : undefined;
  // The card ends where the rows end (header, rows, summary row and its border); past the page's
  // height it scrolls inside. With no records it keeps only the header, so fields can still be added,
  // and the empty message sits under it: the canvas would otherwise draw blank rows and an empty
  // summary bar that look broken.
  const gridHeight = empty ? undefined : Math.max(GRID_HEADER_HEIGHT + (rowCountForGrid + 1) * rowHeight + 2 + hScrollbar, total === 0 ? 180 : 0);

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
          onAddField={canManageFields ? () => setFieldDialog({ mode: "create" }) : undefined}
          timeZone={timeZone}
          onAdd={canEdit ? () => void addRecord({ group: floatingGroup() }) : undefined}
        />
        <div className={viewHugAreaClass}>
        <div ref={cardRef} className={viewHugCardClass} style={{ height: gridHeight }}>
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
            <div className={empty ? "shrink-0" : "min-h-0 flex-1"} style={empty ? { height: GRID_HEADER_HEIGHT + 1 } : undefined}>
              <GlideGrid ref={gridRef} {...gridProps} />
            </div>
          )}
          {canEdit && selectedRecordRows.length > 0 && (
            <SelectionBar count={selectedRecordRows.length} onDuplicate={() => void duplicateRows(selectedRecordRows)} onDelete={() => void deleteRows(selectedRecordRows)} onClear={() => gridRef.current?.clearSelection()} />
          )}
          {data.loading && total === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">
              <Spinner className="size-5" label="Loading records" />
            </div>
          )}
          {empty && (
            <div className="border-t border-line">
              <EmptyRecords searching={!!debouncedSearch} onAdd={canEdit ? () => void addRecord() : undefined} />
            </div>
          )}
        </div>
        <div className={viewHugFooterClass}>
          <span aria-live="polite">
            {itemsLabel(total)}
            {debouncedSearch ? " found" : ""}
          </span>
          {grouped && <span className="hidden sm:inline">· grouped</span>}
          {grouped && (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => replaceCollapsed(pathKeys)} disabled={pathKeys.every((k) => collapsed.has(k))}>
                Collapse all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => replaceCollapsed([])} disabled={!pathKeys.some((k) => collapsed.has(k))}>
                Expand all
              </Button>
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {cfg.saving && <span className="mr-2 text-xs">Saving view…</span>}
            {canEdit && (
              <>
                <IconButton label={`Undo${history.undoLabel ? `: ${history.undoLabel}` : ""} (Ctrl/Cmd+Z)`} size="sm" disabled={!history.canUndo} onClick={() => void history.undo()}>
                  <Undo2 aria-hidden className="size-4" />
                </IconButton>
                <IconButton label={`Redo${history.redoLabel ? `: ${history.redoLabel}` : ""} (Ctrl/Cmd+Shift+Z)`} size="sm" disabled={!history.canRedo} onClick={() => void history.redo()}>
                  <Redo2 aria-hidden className="size-4" />
                </IconButton>
              </>
            )}
          </span>
        </div>
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
        onDuplicate={() => rowMenu && void duplicateRows(rowMenu.rows)}
        onDelete={() => rowMenu && void deleteRows(rowMenu.rows)}
        count={rowMenu?.rows.length ?? 1}
        canInsert={reorderable}
        insertNote={insertNote}
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
        description="The field and its values are removed from every view. Undo brings it back, as does the trash."
        confirmLabel="Delete field"
        destructive
        onConfirm={async () => {
          if (!confirmField) return;
          await opsRef.current.deleteField(confirmField);
        }}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={deleteRecordsText(role, confirmDelete?.ids.length ?? 0).title}
        description={deleteRecordsText(role, confirmDelete?.ids.length ?? 0).description}
        confirmLabel={`Delete ${(confirmDelete?.ids.length ?? 0).toLocaleString()} records`}
        destructive
        onConfirm={async () => {
          if (confirmDelete) await opsRef.current.deleteRecords(confirmDelete.ids);
        }}
      />
      <ConfirmDialog
        open={!!confirmClear}
        onOpenChange={(o) => !o && setConfirmClear(null)}
        title={`Clear ${(confirmClear?.cells ?? 0).toLocaleString()} cells?`}
        description="Their values are emptied and the records stay. Press Undo right after to bring the values back."
        confirmLabel="Clear cells"
        destructive
        onConfirm={async () => {
          if (confirmClear) await clearCells(confirmClear.sel);
        }}
      />
      <FloatingRecordPeek at={linkHover} format={format} emails={emails} role={role} />
      {openRecordId && (
        <RecordPanel
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
          onDuplicateRecord={async (rec) => (await opsRef.current.duplicateRecords([rec.id]))[0]}
        />
      )}
    </EditorEnvProvider>
  );
}

/**
 * Height of the grid's horizontal scrollbar while the columns are wider than the card (0 with
 * overlay scrollbars, about 15 px where scrollbars always show). The card is sized to fit its rows,
 * and without this the scrollbar took the last row's room, so the grid scrolled vertically while
 * the page still had space to grow.
 */
function useHorizontalScrollbarHeight(cardRef: React.RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(0);
  const watched = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  // Glide's scroller is created inside the grid and is replaced when the grid remounts (an error or
  // an empty table in between), so look for it after each render and follow the new one.
  useEffect(() => {
    const el = cardRef.current?.querySelector<HTMLElement>(".dvn-scroller") ?? null;
    if (el === (watched.current?.el ?? null)) return;
    watched.current?.ro.disconnect();
    watched.current = null;
    if (!el) return setHeight(0);
    const measure = () => setHeight(Math.max(0, el.offsetHeight - el.clientHeight));
    measure();
    // The scrollbar appearing or going away changes the scroller's content box, which this sees.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    watched.current = { el, ro };
  });
  useEffect(() => () => watched.current?.ro.disconnect(), []);
  return height;
}
