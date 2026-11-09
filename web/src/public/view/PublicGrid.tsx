/**
 * A shared Grid: the signed-in grid's own canvas (`GlideGrid`) with every way to change a record turned off. Its rows come from the
 * link's own query, in pages as the visitor scrolls, through the same page loader the signed-in grid uses (`useGridData`). Groups
 * fold and a header's menu sorts, both the visitor's own and never saved. A record has no page here, so the title cell offers none.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ArrowUpZA, X } from "lucide-react";
import type { QueryResponse, Sort, TransientConfig } from "@/api/types";
import { publicApi } from "@/api/sharing";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { isSortable, ROW_HEIGHT_PX } from "@/components/viewbar/config";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { displayText } from "@/lib/cells/format";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { useTheme } from "@/theme/ThemeProvider";
import { sortLabels } from "@/views/grid/GridMenus";
import type { CellModel, GridAdapterProps, GridColumnSpec, GridHandle, GridRange, ScreenRect } from "@/views/grid/adapter";
import { BLANK, LOADING, cellValueOf, createCellModelFactory, toColumnSpecs } from "@/views/grid/cellModels";
import { GlideGrid, gridHeaderHeight } from "@/views/grid/glide/GlideGrid";
import { buildRowMap, groupPathKeys } from "@/views/grid/rowMap";
import { useGridData, type GridData, type GridPageSource } from "@/views/grid/useGridData";
import { frozenColumnCount, usePrimaryPinned } from "@/views/grid/usePrimaryPinned";
import { loadBlobUrl } from "./PublicAttachments";
import { toRecord, type SharedFields } from "./publicFields";
import { useShare } from "./ShareContext";

const noop = () => {};
/** The tallest the grid grows before it scrolls inside its own box. */
const MAX_HEIGHT = "min(72vh, 52rem)";

export interface PublicGridDataParams {
  token: string;
  password: string | null;
  fields: SharedFields;
  search: string;
  timeZone: string;
  transient: TransientConfig | null;
}

/** The pages of a shared view, as the grid's page loader reads them. */
export function usePublicGridData({ token, password, fields, search, timeZone, transient }: PublicGridDataParams): GridData {
  // The password is read when a page is asked for, never keyed on, as in the other shared queries.
  const secret = useRef(password);
  secret.current = password;
  const source = useMemo<GridPageSource>(
    () => ({
      key: ["public", token, "grid", search, timeZone, transient ?? null],
      fetch: async (offset, limit, signal) => {
        const res = await publicApi.query(token, { offset, limit, search: search || null, timezone: timeZone, ...(transient ? { transient } : {}) }, secret.current, signal);
        return { ...res, records: res.records.map((r) => toRecord(r, fields)) } satisfies QueryResponse;
      },
    }),
    [token, fields, search, timeZone, transient],
  );
  return useGridData({ tableId: `share:${token}`, viewId: "shared", configKey: "", search, timeZone, transient, source });
}

export interface PublicGridProps {
  fields: SharedFields;
  /** The view's own column widths. */
  widths: Readonly<Record<string, number>>;
  data: GridData;
  search: string;
  sort: Sort | null;
  onSort(next: Sort | null): void;
}

export function PublicGrid({ fields, widths, data, search, sort, onSort }: PublicGridProps) {
  const { token, password, format } = useShare();
  const { resolved, accent } = useTheme();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [primaryPinned, togglePrimaryPinned] = usePrimaryPinned(`share:${token}`);
  const pinned = desktop || primaryPinned;

  // Widths dragged in the header are the visitor's own for as long as the page is open.
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const columns = useMemo<GridColumnSpec[]>(() => toColumnSpecs(fields.list, fields.title?.id ?? "", widths, liveWidths), [fields, widths, liveWidths]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const rowMap = useMemo(() => buildRowMap(data.total, data.groups, collapsed, false), [data.total, data.groups, collapsed]);
  const rowMapRef = useRef(rowMap);
  rowMapRef.current = rowMap;
  const dataRef = useRef(data);
  dataRef.current = data;

  const factory = useMemo(() => createCellModelFactory(columns, format, false), [columns, format]);
  const getCell = useCallback(
    (col: number, row: number): CellModel => {
      const map = rowMapRef.current;
      if (row >= map.length) return BLANK;
      const gi = map.groupAt(row);
      if (gi >= 0) {
        const groups = dataRef.current.groups;
        const g = groups[gi];
        if (!g || col !== 0) return BLANK;
        return factory.group(gi, g.depth, g.label, g.count, collapsedRef.current.has(groupPathKeys(groups)[gi] ?? ""));
      }
      const record = dataRef.current.getRecord(map.recordIndexAt(row));
      return record ? factory.forRecord(record, col, dataRef.current.rowColor(record.id)) : LOADING;
    },
    [factory],
  );

  const getCopyText = useCallback(async (range: GridRange): Promise<string[][]> => {
    const map = rowMapRef.current;
    const span = map.recordRange(range.y, range.y + range.height - 1);
    if (span) await dataRef.current.loadRange(span[0], span[1]);
    const out: string[][] = [];
    for (let row = range.y; row < range.y + range.height; row++) {
      if (map.recordIndexAt(row) < 0) continue;
      const record = dataRef.current.getRecord(map.recordIndexAt(row));
      out.push(Array.from({ length: range.width }, (_, i) => {
        const spec = columnsRef.current[range.x + i];
        return record && spec ? displayText(spec.field, cellValueOf(record, spec.field), format) : "";
      }));
    }
    return out;
  }, [format]);

  // A file tile's preview: the link's own thumbnail address, or for a protected link (an image cannot send the password) a blob fetched with it.
  const gridRef = useRef<GridHandle>(null);
  const blobs = useRef(new Map<string, string>());
  const asked = useRef(new Set<string>());
  const thumbUrl = useCallback(
    (id: string): string | null => {
      if (password === null) return publicApi.thumbUrl(token, id);
      const hit = blobs.current.get(id);
      if (hit) return hit;
      if (!asked.current.has(id)) {
        asked.current.add(id);
        loadBlobUrl(token, password, { id })
          .then((url) => {
            blobs.current.set(id, url);
            gridRef.current?.invalidate();
          })
          .catch(() => asked.current.delete(id));
      }
      return null;
    },
    [token, password],
  );

  const [menu, setMenu] = useState<{ index: number; at: ScreenRect } | null>(null);
  const menuSpec = menu ? columns[menu.index] : undefined;
  const sorted = menuSpec && sort?.field_id === menuSpec.id ? sort.direction : null;
  const [asc, desc] = menuSpec ? sortLabels(menuSpec.field) : ["", ""];

  const rowHeight = ROW_HEIGHT_PX.medium;
  const headerHeight = gridHeaderHeight(false);
  const empty = !data.loading && data.total === 0;
  const gridProps: GridAdapterProps = {
    columns,
    fitColumns: !data.loading,
    rowCount: rowMap.length,
    rowHeight,
    freezeColumns: frozenColumnCount(pinned, 0, columns.length),
    primaryPin: desktop || !columns[0]?.isPrimary ? null : { pinned, onToggle: togglePrimaryPinned },
    showSummary: false,
    rowNumber: (row) => {
      const i = rowMapRef.current.recordIndexAt(row);
      return i >= 0 ? i + 1 : null;
    },
    newRecordLabel: "",
    searchTerm: search,
    dark: resolved === "dark",
    accent,
    canEdit: false,
    canReorderRows: false,
    canReorderColumns: false,
    canExpand: false,
    thumbUrl,
    version: data.version + collapsed.size,
    getCell,
    onVisibleRowsChange: (first, last) => {
      const span = rowMapRef.current.recordRange(first, last);
      if (span) dataRef.current.ensureRange(span[0], span[1]);
    },
    onCommitEdits: noop,
    onPaste: noop,
    onClear: noop,
    getCopyText,
    onFill: noop,
    onColumnResize: (index, width) => {
      const spec = columnsRef.current[index];
      if (spec) setLiveWidths((cur) => ({ ...cur, [spec.id]: Math.round(width) }));
    },
    onColumnMove: noop,
    onRowMove: noop,
    onHeaderMenu: (index, at) => {
      if (columnsRef.current[index]) setMenu({ index, at });
    },
    onCellContextMenu: noop,
    onGroupToggle: (headerIndex) => {
      const key = groupPathKeys(dataRef.current.groups)[headerIndex];
      if (key === undefined) return;
      setCollapsed((cur) => (cur.has(key) ? new Set([...cur].filter((k) => k !== key)) : new Set([...cur, key])));
    },
    onAddRow: noop,
    onSummaryClick: noop,
    onExpand: noop,
    onSelectionChange: noop,
    onKeyDown: () => false,
    canAddField: false,
    onAddField: noop,
    onDropFiles: noop,
    renderEditor: () => null,
  };

  if (empty) return <p className="rounded-lg border border-line bg-surface px-3 py-10 text-center text-label text-muted">No records to show.</p>;
  // The card is as tall as its rows, up to a screenful; past that the canvas scrolls inside it.
  const height = `min(max(${headerHeight + rowMap.length * rowHeight + 20}px, 12rem), ${MAX_HEIGHT})`;
  return (
    <section aria-label="Records" className="overflow-hidden rounded-lg border border-line bg-surface" style={{ height }}>
      <GlideGrid ref={gridRef} {...gridProps} />
      <AnchoredMenu anchor={menu?.at ?? null} onClose={() => setMenu(null)} label={menuSpec ? `Column menu for ${menuSpec.title}` : "Column menu"}>
        {menuSpec && (
          <>
            <DropdownMenuLabel>{menuSpec.title}</DropdownMenuLabel>
            <DropdownMenuItem disabled={!isSortable(menuSpec.field)} onSelect={() => onSort({ field_id: menuSpec.id, direction: "asc" })}>
              <ArrowDownAZ aria-hidden className="size-4" /> {asc}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!isSortable(menuSpec.field)} onSelect={() => onSort({ field_id: menuSpec.id, direction: "desc" })}>
              <ArrowUpZA aria-hidden className="size-4" /> {desc}
            </DropdownMenuItem>
            {sorted && (
              <DropdownMenuItem onSelect={() => onSort(null)}>
                <X aria-hidden className="size-4" /> Remove sort
              </DropdownMenuItem>
            )}
          </>
        )}
      </AnchoredMenu>
    </section>
  );
}
