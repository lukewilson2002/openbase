/**
 * Records of a shared view: `POST /api/public/shares/{token}/query`. Tables page through the
 * result; boards, galleries, calendars and timelines load it whole (pages of 1,000, up to 5,000
 * records) because they need every card to lay themselves out. Queries are cached under
 * `["public", token, ...]`; the password never enters a key (it is read from a ref when the
 * request is made).
 */
import { useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { publicApi } from "@/api/sharing";
import type { DateRange, GroupHeader, PublicQueryResponse, TableRecord, TransientConfig } from "@/api/types";
import { toRecord, type SharedFields } from "./publicFields";

export const PUBLIC_PAGE = 100;
const FETCH_PAGE = 1000;
export const PUBLIC_CAP = 5000;

export interface PublicData {
  records: TableRecord[];
  total: number;
  offset: number;
  groups: GroupHeader[];
  colors: Record<string, string>;
  /** More records match than were loaded. */
  truncated: boolean;
}

interface Common {
  token: string;
  password: string | null;
  fields: SharedFields;
  search: string;
  timeZone: string;
  transient?: TransientConfig | null;
  range?: DateRange | null;
  enabled?: boolean;
}

function shape(res: PublicQueryResponse, fields: SharedFields, truncated: boolean): PublicData {
  return { records: res.records.map((r) => toRecord(r, fields)), total: res.total, offset: res.offset, groups: res.groups ?? [], colors: res.colors ?? {}, truncated };
}

/** One page of the shared view's records. */
export function usePublicPage(p: Common & { offset: number; limit?: number }) {
  const limit = p.limit ?? PUBLIC_PAGE;
  const password = useRef(p.password);
  password.current = p.password;
  const q = useQuery({
    queryKey: ["public", p.token, "page", p.search, p.offset, limit, p.timeZone, p.transient ?? null],
    queryFn: ({ signal }) =>
      publicApi.query(p.token, { offset: p.offset, limit, search: p.search || null, timezone: p.timeZone, ...(p.transient ? { transient: p.transient } : {}) }, password.current, signal),
    enabled: p.enabled ?? true,
    placeholderData: keepPreviousData,
  });
  const data = useMemo(() => (q.data ? shape(q.data, p.fields, false) : undefined), [q.data, p.fields]);
  return { data, loading: q.isPending, fetching: q.isFetching, error: q.error, refetch: () => void q.refetch() };
}

/** Every record of the shared view (up to the cap), optionally restricted to a date range. */
export function usePublicAll(p: Common & { cap?: number }) {
  const cap = p.cap ?? PUBLIC_CAP;
  const password = useRef(p.password);
  password.current = p.password;
  const q = useQuery({
    queryKey: ["public", p.token, "all", p.search, p.range ?? null, p.timeZone, cap, p.transient ?? null],
    queryFn: async ({ signal }) => {
      const merged: PublicQueryResponse = { total: 0, offset: 0, records: [], groups: [], colors: {} };
      for (;;) {
        const res = await publicApi.query(
          p.token,
          { offset: merged.records.length, limit: Math.min(FETCH_PAGE, cap - merged.records.length), search: p.search || null, timezone: p.timeZone, range: p.range ?? null, ...(p.transient ? { transient: p.transient } : {}) },
          password.current,
          signal,
        );
        merged.total = res.total;
        if (merged.groups.length === 0) merged.groups = res.groups ?? [];
        Object.assign(merged.colors, res.colors ?? {});
        merged.records.push(...res.records);
        if (res.records.length === 0 || merged.records.length >= Math.min(res.total, cap)) break;
      }
      return merged;
    },
    enabled: p.enabled ?? true,
    placeholderData: keepPreviousData,
  });
  const data = useMemo(() => (q.data ? shape(q.data, p.fields, q.data.total > q.data.records.length) : undefined), [q.data, p.fields]);
  return { data, loading: q.isPending && (p.enabled ?? true), fetching: q.isFetching, error: q.error, refetch: () => void q.refetch() };
}
