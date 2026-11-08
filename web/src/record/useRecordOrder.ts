/**
 * The records before and after the open one, in the order of the view the page was opened from (REC-1): the
 * view's own filter, sorts and groups with this person's draft laid over them, as the server computes them.
 * The collection screen is not mounted behind a page, so the order is asked for here, ids only; it is kept
 * apart from the screens' record queries so that saving a value on the page does not load the whole view again.
 * The search box of a screen is not a draft setting (COL-5) and is not part of the order.
 */
import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { recordsApi } from "@/api/records";
import type { Table, View } from "@/api/types";
import { queryRelevantKey } from "@/components/viewbar/config";
import { applyTransient, toTransient } from "@/views/drafts/draft";
import { useViewDraft } from "@/views/drafts/store";
import { effectiveConfig } from "@/views/grid/useViewConfig";
import { FETCH_PAGE, RECORD_CAP } from "@/views/common/useViewRecords";

export interface RecordOrder {
  prevId: string | null;
  nextId: string | null;
}

interface OrderData {
  ids: string[];
}

export function useRecordOrder({ table, view, recordId, timeZone, handed }: { table: Table | undefined; view: View | undefined; recordId: string; timeZone: string; handed?: readonly string[] }): RecordOrder {
  // A layout with an order of its own (a board's stacks, a calendar's days) said what it is on the way here.
  const given = !!handed && handed.includes(recordId);
  const draft = useViewDraft(view?.id ?? "");
  const fieldIds = useMemo(() => new Set((table?.fields ?? []).map((f) => f.id)), [table?.fields]);
  const { transient, configKey } = useMemo(() => {
    if (!view) return { transient: null, configKey: "" };
    const config = effectiveConfig(view.config, draft, fieldIds);
    const t = toTransient(view.config, config);
    return { transient: t, configKey: queryRelevantKey(applyTransient(view.config, t)) };
  }, [view, draft, fieldIds]);

  const viewId = view?.id ?? "";
  const order = useQuery({
    queryKey: ["record-order", table?.id ?? "", viewId, configKey, timeZone],
    enabled: !!view && !!table && !given,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }): Promise<OrderData> => {
      const ids: string[] = [];
      for (;;) {
        const res = await recordsApi.query(viewId, { offset: ids.length, limit: Math.min(FETCH_PAGE, RECORD_CAP - ids.length), timezone: timeZone, ...(transient ? { transient } : {}) }, signal);
        ids.push(...res.records.map((r) => r.id));
        if (res.records.length === 0 || ids.length >= Math.min(res.total, RECORD_CAP)) break;
      }
      return { ids };
    },
  });

  // A record that is not in the list yet (a copy, one added elsewhere a moment ago) is looked for once with a fresh list.
  const lookedFor = useRef<string | null>(null);
  const { data, isFetching, refetch } = order;
  useEffect(() => {
    if (given || !data || isFetching || data.ids.includes(recordId) || lookedFor.current === recordId) return;
    lookedFor.current = recordId;
    void refetch();
  }, [given, data, isFetching, recordId, refetch]);

  return useMemo(() => {
    const ids = given ? handed : data?.ids;
    const i = ids ? ids.indexOf(recordId) : -1;
    if (!ids || i < 0) return { prevId: null, nextId: null };
    return { prevId: ids[i - 1] ?? null, nextId: ids[i + 1] ?? null };
  }, [given, handed, data, recordId]);
}
