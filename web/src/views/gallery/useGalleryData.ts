/**
 * Records for the gallery, loaded as far as the person has scrolled: the first `GALLERY_PAGE`, and
 * another page each time more are asked for (infinite scroll). The loaded records are one
 * `ViewRecordsData` under `["records", tableId, viewId, "query", ..., limit]`, the same shape the other
 * views cache, so the shared optimistic writes (edits, drops, deletes, undo) and the live-event
 * refetch work on them as they do everywhere else. A bigger limit is a new query that shows the
 * smaller one while it loads, so the cards already on screen stay put.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { recordKeys } from "@/api/records";
import type { TableRecord, TransientConfig } from "@/api/types";
import { fetchAllRecords } from "../common/useViewRecords";

export const GALLERY_PAGE = 60;

export interface GalleryData {
  records: TableRecord[];
  total: number;
  colors: Record<string, string>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  loadMore(): void;
}

export function useGalleryData(p: { tableId: string; viewId: string; configKey: string; search: string; timeZone: string; transient?: TransientConfig | null }): GalleryData {
  const qc = useQueryClient();
  const transient = p.transient ?? null;
  // The override is compared by value: a new object with the same parts is the same query.
  const transientKey = JSON.stringify(transient);
  const base = useMemo(
    () => [...recordKeys.viewQuery(p.tableId, p.viewId, p.configKey, p.search), "gallery", p.timeZone, JSON.parse(transientKey) as TransientConfig | null],
    [p.tableId, p.viewId, p.configKey, p.search, p.timeZone, transientKey],
  );
  const baseId = JSON.stringify(base);
  // How many records to load for this query; a different query (another search, filter...) starts over.
  const [asked, setAsked] = useState({ baseId, limit: GALLERY_PAGE });
  const limit = asked.baseId === baseId ? asked.limit : GALLERY_PAGE;

  const q = useQuery({
    queryKey: [...base, limit],
    queryFn: ({ signal }) => fetchAllRecords(p.viewId, { search: p.search, timeZone: p.timeZone, transient }, limit, signal),
    placeholderData: keepPreviousData,
  });

  // Once the bigger query has its records the smaller ones are only stale copies of them: the shared
  // writes patch every cached copy and read a record's neighbours from the first they find.
  const settled = q.isSuccess && !q.isPlaceholderData;
  useEffect(() => {
    if (settled) qc.removeQueries({ queryKey: base, predicate: (query) => query.queryKey[query.queryKey.length - 1] !== limit });
  }, [qc, base, limit, settled]);

  const data = q.data;
  const loaded = data?.records.length ?? 0;
  const hasMore = !!data && loaded < data.total;
  const loadMore = useCallback(() => {
    if (!hasMore || q.isFetching) return;
    setAsked({ baseId, limit: Math.max(limit, loaded) + GALLERY_PAGE });
  }, [hasMore, q.isFetching, baseId, limit, loaded]);

  return useMemo(
    () => ({
      records: data?.records ?? [],
      total: data?.total ?? 0,
      colors: data?.colors ?? {},
      loading: q.isPending,
      loadingMore: q.isPlaceholderData && q.isFetching,
      hasMore,
      error: q.error,
      loadMore,
    }),
    [data, q.isPending, q.isPlaceholderData, q.isFetching, hasMore, q.error, loadMore],
  );
}
