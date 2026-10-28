/**
 * Rows of the list's groups that lie past the records the view loaded. The view loads the first
 * `RECORD_CAP` records of its query, but its group headers cover all of it, so a group that starts
 * past the cap (or runs over it) is still there to open. Its rows are fetched on demand by their
 * position (`offset` into the whole ordered result), a page of the group at a time as it is shown.
 */
import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { TableRecord, TransientConfig } from "@/api/types";
import { FETCH_PAGE } from "../common/useViewRecords";
import type { ViewRecordsData } from "../common/cache";
import { buildOutline, leafNodes } from "./outline";

export interface GroupRowsParams {
  tableId: string;
  viewId: string;
  configKey: string;
  search: string;
  timeZone: string;
  transient: TransientConfig | null;
  /** What the view loaded (undefined while it loads). */
  base: ViewRecordsData | undefined;
}

export interface GroupRows {
  /** Rows fetched so far per group path ("" without groups), in order, from where the loaded records end. */
  tails: ReadonlyMap<string, readonly TableRecord[]>;
  /** Ask for the first `upTo` rows of a group (rows already loaded count). */
  request(path: string, upTo: number): void;
  /** "loading" while rows are on their way, "error" when fetching them failed. */
  status: "loading" | "error" | undefined;
  retry(): void;
}

const EMPTY: ReadonlyMap<string, readonly TableRecord[]> = new Map();

export function useGroupRows(p: GroupRowsParams): GroupRows {
  const [want, setWant] = useState<Readonly<Record<string, number>>>({});
  const request = useCallback((path: string, upTo: number) => setWant((cur) => ((cur[path] ?? 0) >= upTo ? cur : { ...cur, [path]: upTo })), []);

  // The ranges to fetch: for each group asked for, from the end of the loaded records (or the
  // group's own start) to the row asked for.
  const loadedCount = p.base?.records.length ?? 0;
  const ranges = useMemo(() => {
    if (!p.base) return [];
    const leaves = p.base.groups.length > 0 ? leafNodes(buildOutline(p.base.groups)) : [{ path: "", start: 0, count: p.base.total }];
    const out: { path: string; from: number; to: number }[] = [];
    for (const leaf of leaves) {
      const upTo = want[leaf.path];
      if (!upTo) continue;
      const from = Math.max(leaf.start, loadedCount);
      const to = leaf.start + Math.min(leaf.count, upTo);
      if (to > from) out.push({ path: leaf.path, from, to });
    }
    return out;
  }, [p.base, want, loadedCount]);

  const q = useQuery({
    queryKey: [...recordKeys.viewQuery(p.tableId, p.viewId, p.configKey, p.search), "group-rows", p.timeZone, p.transient ?? null, loadedCount, ranges],
    queryFn: async ({ signal }) => {
      const out = new Map<string, TableRecord[]>();
      await Promise.all(
        ranges.map(async ({ path, from, to }) => {
          const rows: TableRecord[] = [];
          while (from + rows.length < to) {
            const res = await recordsApi.query(
              p.viewId,
              { offset: from + rows.length, limit: Math.min(FETCH_PAGE, to - from - rows.length), search: p.search || null, timezone: p.timeZone, range: null, ...(p.transient ? { transient: p.transient } : {}) },
              signal,
            );
            if (res.records.length === 0) break;
            rows.push(...res.records);
          }
          out.set(path, rows);
        }),
      );
      return out;
    },
    enabled: ranges.length > 0,
    placeholderData: keepPreviousData,
  });

  const status = ranges.length === 0 ? undefined : q.isError ? "error" : q.isFetching ? "loading" : undefined;
  return { tails: ranges.length === 0 ? EMPTY : (q.data ?? EMPTY), request, status, retry: () => void q.refetch() };
}
