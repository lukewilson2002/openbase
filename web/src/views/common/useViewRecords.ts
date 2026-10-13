/**
 * Loads every record of a view query (kanban, calendar, timeline, list): pages of 1,000 through
 * `POST /api/views/{id}/query` until `cap` records are loaded. The result lives in TanStack Query
 * under `["records", tableId, viewId, "query", configKey, search, "all", ...]`, so the shared
 * `records_changed` invalidation refetches it in place (the previous data stays on screen while
 * it does, and while a new date range loads).
 */
import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { DateRange, GroupHeader, TableRecord } from "@/api/types";
import type { ViewRecordsData } from "./cache";

/** Largest page the server returns (`og_core::limits::MAX_PAGE_SIZE`). */
export const FETCH_PAGE = 1_000;
/** Records a whole-view query loads before showing the "showing first N" notice. */
export const RECORD_CAP = 5_000;

export interface ViewRecordsParams {
  tableId: string;
  viewId: string;
  /** Hash of the saved view config the query depends on (`queryRelevantKey`). */
  configKey: string;
  search: string;
  timeZone: string;
  range?: DateRange | null;
  cap?: number;
  enabled?: boolean;
  /** Distinguishes independent queries of the same view (for example the unscheduled list). */
  variant?: string;
}

export function viewRecordsKey(p: Pick<ViewRecordsParams, "tableId" | "viewId" | "configKey" | "search" | "timeZone" | "range" | "cap" | "variant">): QueryKey {
  return [...recordKeys.viewQuery(p.tableId, p.viewId, p.configKey, p.search), "all", p.variant ?? "", p.range ?? null, p.timeZone, p.cap ?? RECORD_CAP];
}

/** Fetch pages until `cap` records or the end; exported for tests. */
export async function fetchAllRecords(
  viewId: string,
  base: { search: string; timeZone: string; range?: DateRange | null },
  cap: number,
  signal?: AbortSignal,
): Promise<ViewRecordsData> {
  const records: TableRecord[] = [];
  let total = 0;
  let groups: GroupHeader[] = [];
  const colors: Record<string, string> = {};
  for (;;) {
    const res = await recordsApi.query(
      viewId,
      { offset: records.length, limit: Math.min(FETCH_PAGE, cap - records.length), search: base.search || null, timezone: base.timeZone, range: base.range ?? null },
      signal,
    );
    total = res.total;
    if (groups.length === 0 && res.groups?.length) groups = res.groups;
    Object.assign(colors, res.colors ?? {});
    records.push(...res.records);
    if (res.records.length === 0 || records.length >= Math.min(total, cap)) break;
  }
  return { records, total, groups, colors, truncated: total > records.length };
}

export interface ViewRecords {
  data: ViewRecordsData | undefined;
  /** First load (nothing to show yet). */
  loading: boolean;
  /** A refetch is in flight (data may be stale). */
  fetching: boolean;
  error: Error | null;
  queryKey: QueryKey;
  refetch: () => void;
}

export function useViewRecords(p: ViewRecordsParams): ViewRecords {
  const cap = p.cap ?? RECORD_CAP;
  const queryKey = viewRecordsKey({ ...p, cap });
  const q = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAllRecords(p.viewId, { search: p.search, timeZone: p.timeZone, range: p.range }, cap, signal),
    enabled: p.enabled ?? true,
    placeholderData: keepPreviousData,
  });
  const qc = useQueryClient();
  return {
    data: q.data,
    loading: q.isPending && (p.enabled ?? true),
    fetching: q.isFetching,
    error: q.error,
    queryKey,
    refetch: () => void qc.invalidateQueries({ queryKey }),
  };
}
