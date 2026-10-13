/**
 * Paged record loading for the grid. Pages of PAGE_SIZE rows are fetched lazily through
 * `POST /api/views/{id}/query` and cached in TanStack Query under
 * `["records", tableId, viewId, "query", configKey, search, pageIndex]`, so a `records_changed`
 * event (which invalidates `["records", tableId]`) lands here: the visible pages are refetched in
 * place (the old rows stay on screen until the new ones arrive, so scroll position and selection
 * are untouched) and pages out of view are dropped to be fetched again on demand.
 *
 * `getRecord(index)` is an O(1) lookup in a ref'd page map; React state only carries a version
 * counter so the grid knows when to redraw.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { GroupHeader, QueryResponse, TableRecord } from "@/api/types";
import { PAGE_SIZE, pagesFor } from "./rowMap";

export interface GridDataParams {
  tableId: string;
  viewId: string;
  /** Hash of everything in the view config the query depends on (filter, sorts, groups...). */
  configKey: string;
  search: string;
  timeZone: string;
}

export interface GridData {
  /** Number of records matching the filter and search (the last known while a new query loads). */
  total: number;
  groups: readonly GroupHeader[];
  /** True until the first page of the current query arrives. */
  loading: boolean;
  error: Error | null;
  /** Bumped whenever page contents change. */
  version: number;
  getRecord(index: number): TableRecord | undefined;
  rowColor(recordId: string): string | undefined;
  indexOf(recordId: string): number;
  /** Request the pages covering record indexes [first, last] (and one page of look-ahead). */
  ensureRange(first: number, last: number): void;
  /** Like ensureRange but resolves when the pages have arrived. */
  loadRange(first: number, last: number): Promise<void>;
  /** Replace records in the cache (server responses, optimistic edits). */
  upsertRecords(records: readonly TableRecord[]): void;
  /** Apply `values` (null deletes the key) to a cached record; returns the previous record for rollback. */
  patchValues(recordId: string, values: Record<string, unknown>): TableRecord | undefined;
  /** Drop everything and refetch what is visible (after structural edits). */
  refresh(): void;
}

export function useGridData({ tableId, viewId, configKey, search, timeZone }: GridDataParams): GridData {
  const qc = useQueryClient();
  const pages = useRef(new Map<number, QueryResponse>());
  const index = useRef(new Map<string, number>());
  const colors = useRef(new Map<string, string>());
  const meta = useRef<{ total: number; groups: readonly GroupHeader[] }>({ total: 0, groups: [] });
  const visible = useRef({ first: 0, last: 0 });
  const generation = useRef(0);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const pageKey = useCallback((page: number) => recordKeys.page(tableId, viewId, configKey, search, page), [tableId, viewId, configKey, search]);
  const queryPrefix = useMemo(() => recordKeys.viewQuery(tableId, viewId, configKey, search), [tableId, viewId, configKey, search]);

  const store = useCallback((page: number, res: QueryResponse) => {
    pages.current.set(page, res);
    res.records.forEach((r, i) => index.current.set(r.id, page * PAGE_SIZE + i));
    for (const [id, c] of Object.entries(res.colors ?? {})) colors.current.set(id, c);
    meta.current = { total: res.total, groups: res.groups?.length ? res.groups : (res.total === meta.current.total ? meta.current.groups : []) };
  }, []);

  const fetchPage = useCallback(
    async (page: number, force = false): Promise<void> => {
      const gen = generation.current;
      try {
        const res = await qc.fetchQuery({
          queryKey: pageKey(page),
          queryFn: ({ signal }) => recordsApi.query(viewId, { offset: page * PAGE_SIZE, limit: PAGE_SIZE, search: search || null, timezone: timeZone }, signal),
          staleTime: force ? 0 : 10_000,
        });
        if (gen !== generation.current) return;
        store(page, res);
        setLoading(false);
        setError(null);
        bump();
      } catch (e) {
        if (gen !== generation.current) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    },
    [qc, pageKey, viewId, search, timeZone, store, bump],
  );

  // A different query (view, filter, sort, search...) starts from scratch.
  useEffect(() => {
    generation.current++;
    pages.current = new Map();
    index.current = new Map();
    colors.current = new Map();
    visible.current = { first: 0, last: 0 };
    setLoading(true);
    void fetchPage(0);
    bump();
  }, [fetchPage, bump]);

  const inFlight = useRef(new Set<number>());
  const wanted = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestPages = useCallback(
    (list: number[], force = false): Promise<void> => {
      const jobs: Promise<void>[] = [];
      for (const p of list) {
        if (!force && (pages.current.has(p) || inFlight.current.has(p))) continue;
        inFlight.current.add(p);
        jobs.push(fetchPage(p, force).finally(() => inFlight.current.delete(p)));
      }
      return Promise.all(jobs).then(() => undefined);
    },
    [fetchPage],
  );

  const ensureRange = useCallback(
    (first: number, last: number) => {
      visible.current = { first, last };
      if (wanted.current) clearTimeout(wanted.current);
      // Coalesce the burst of region events during fast scrolling.
      wanted.current = setTimeout(() => {
        const total = Math.max(meta.current.total, PAGE_SIZE);
        void requestPages(pagesFor(first, last, total, 1));
      }, 40);
    },
    [requestPages],
  );

  const loadRange = useCallback(
    async (first: number, last: number) => {
      const total = Math.max(meta.current.total, PAGE_SIZE);
      await requestPages(pagesFor(first, last, total, 0));
    },
    [requestPages],
  );

  const refresh = useCallback(() => {
    const total = Math.max(meta.current.total, PAGE_SIZE);
    const keep = new Set(pagesFor(visible.current.first, visible.current.last, total, 1));
    for (const p of [...pages.current.keys()]) if (!keep.has(p)) pages.current.delete(p);
    void requestPages([...keep], true);
  }, [requestPages]);

  // Live updates: an invalidation of this query's pages refetches the visible ones in place.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== "updated" || ev.action.type !== "invalidate") return;
      const k = ev.query.queryKey;
      if (k.length < queryPrefix.length || queryPrefix.some((part, i) => k[i] !== part)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 30);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [qc, queryPrefix, refresh]);

  useEffect(
    () => () => {
      if (wanted.current) clearTimeout(wanted.current);
    },
    [],
  );

  const getRecord = useCallback((i: number): TableRecord | undefined => {
    if (i < 0) return undefined;
    return pages.current.get(Math.floor(i / PAGE_SIZE))?.records[i % PAGE_SIZE];
  }, []);

  const upsertRecords = useCallback(
    (records: readonly TableRecord[]) => {
      const touched = new Set<number>();
      for (const r of records) {
        const i = index.current.get(r.id);
        if (i === undefined) continue;
        const p = Math.floor(i / PAGE_SIZE);
        const page = pages.current.get(p);
        if (!page) continue;
        const copy = page.records.slice();
        copy[i % PAGE_SIZE] = r;
        pages.current.set(p, { ...page, records: copy });
        touched.add(p);
      }
      if (touched.size > 0) bump();
    },
    [bump],
  );

  const patchValues = useCallback(
    (recordId: string, values: Record<string, unknown>): TableRecord | undefined => {
      const i = index.current.get(recordId);
      if (i === undefined) return undefined;
      const prev = getRecord(i);
      if (!prev) return undefined;
      const next: Record<string, unknown> = { ...prev.values };
      for (const [k, v] of Object.entries(values)) {
        if (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0)) delete next[k];
        else next[k] = v;
      }
      upsertRecords([{ ...prev, values: next as TableRecord["values"] }]);
      return prev;
    },
    [getRecord, upsertRecords],
  );

  return {
    total: meta.current.total,
    groups: meta.current.groups,
    loading,
    error,
    version,
    getRecord,
    rowColor: (id) => colors.current.get(id),
    indexOf: (id) => index.current.get(id) ?? -1,
    ensureRange,
    loadRange,
    upsertRecords,
    patchValues,
    refresh,
  };
}
