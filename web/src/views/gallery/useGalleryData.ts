/**
 * Paged records for the gallery: `POST /api/views/{id}/query` with a growing offset (infinite
 * scroll). Cached under `["records", tableId, viewId, "query", ...]` so live events refetch the
 * loaded pages.
 */
import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { QueryResponse, TableRecord } from "@/api/types";

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

export function useGalleryData(p: { tableId: string; viewId: string; configKey: string; search: string; timeZone: string }): GalleryData {
  const q = useInfiniteQuery({
    queryKey: [...recordKeys.viewQuery(p.tableId, p.viewId, p.configKey, p.search), "gallery", p.timeZone],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }): Promise<QueryResponse> =>
      recordsApi.query(p.viewId, { offset: pageParam, limit: GALLERY_PAGE, search: p.search || null, timezone: p.timeZone }, signal),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, pg) => n + pg.records.length, 0);
      return last.records.length > 0 && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
  return useMemo(() => {
    const pages = q.data?.pages ?? [];
    const seen = new Set<string>();
    const records: TableRecord[] = [];
    const colors: Record<string, string> = {};
    for (const pg of pages) {
      Object.assign(colors, pg.colors ?? {});
      for (const r of pg.records) {
        // A write between page fetches can shift rows so one appears twice.
        if (!seen.has(r.id)) {
          seen.add(r.id);
          records.push(r);
        }
      }
    }
    return {
      records,
      total: pages[pages.length - 1]?.total ?? 0,
      colors,
      loading: q.isPending,
      loadingMore: q.isFetchingNextPage,
      hasMore: !!q.hasNextPage,
      error: q.error,
      loadMore: () => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      },
    };
  }, [q.data, q.isPending, q.isFetchingNextPage, q.hasNextPage, q.error, q.fetchNextPage]);
}
