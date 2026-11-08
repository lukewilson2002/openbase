/**
 * The two numbers in "Showing 3 of 12 clients" (COL-5): how many records the draft's filter shows, and how
 * many the view shows as saved. Two one-record queries rather than the views' own data, so every layout
 * gets them the same way; only asked while the draft changes the filter, because a sort or a width changes
 * no count.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { View } from "@/api/types";
import { queryRelevantKey } from "@/components/viewbar/config";
import type { ViewConfigApi } from "../grid/useViewConfig";

export interface DraftCounts {
  shown: number;
  total: number;
}

export function useDraftCounts({ tableId, view, cfg, search, timeZone }: { tableId: string; view: View; cfg: Pick<ViewConfigApi, "transient" | "queryConfig">; search: string; timeZone: string }): DraftCounts | null {
  const filterChanged = cfg.transient?.filter !== undefined;
  // Under the table's record keys, so a record added or deleted anywhere refreshes both.
  const saved = useQuery({
    queryKey: [...recordKeys.viewQuery(tableId, view.id, queryRelevantKey(view.config), ""), "count", "saved"],
    queryFn: async ({ signal }) => (await recordsApi.query(view.id, { offset: 0, limit: 1, timezone: timeZone }, signal)).total,
    enabled: filterChanged,
    placeholderData: keepPreviousData,
  });
  const shown = useQuery({
    queryKey: [...recordKeys.viewQuery(tableId, view.id, queryRelevantKey(cfg.queryConfig), search), "count", "draft", cfg.transient],
    queryFn: async ({ signal }) => (await recordsApi.query(view.id, { offset: 0, limit: 1, search: search || null, timezone: timeZone, transient: cfg.transient }, signal)).total,
    enabled: filterChanged,
    placeholderData: keepPreviousData,
  });
  if (!filterChanged || saved.data === undefined || shown.data === undefined) return null;
  return { shown: shown.data, total: saved.data };
}
