/**
 * The records before and after the open one, in the order of the view the page was opened from (REC-1): the
 * view's own filter, sorts and groups with this person's draft laid over them, as the server computes them.
 * The collection screen is not mounted behind a page, so the order is asked for here. The server answers with
 * the two ids only (`neighbours_of`), so a collection of any size costs one small request and Previous and Next
 * never stop at some cap; it is kept apart from the screens' record queries so that saving a value on the page
 * does not load the whole view again. The search box of a screen is not a draft setting (COL-5) and is not part
 * of the order.
 */
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { recordsApi } from "@/api/records";
import type { Table, View } from "@/api/types";
import { queryRelevantKey } from "@/components/viewbar/config";
import { applyTransient, toTransient } from "@/views/drafts/draft";
import { useViewDraft } from "@/views/drafts/store";
import { effectiveConfig } from "@/views/grid/useViewConfig";

export interface RecordOrder {
  prevId: string | null;
  nextId: string | null;
}

export function useRecordOrder({ table, view, recordId, timeZone, handed }: { table: Table | undefined; view: View | undefined; recordId: string; timeZone: string; handed?: readonly string[] }): RecordOrder {
  const qc = useQueryClient();
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
  const tableId = table?.id ?? "";
  const neighboursOf = (id: string) => ({
    queryKey: ["record-order", tableId, viewId, configKey, timeZone, id] as const,
    // The server's list of a view is kept per version of its data, so a record added a moment ago is in it.
    staleTime: 15_000,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const res = await recordsApi.query(viewId, { limit: 0, neighbours_of: id, timezone: timeZone, ...(transient ? { transient } : {}) }, signal);
      return { prevId: res.neighbours?.previous ?? null, nextId: res.neighbours?.next ?? null } satisfies RecordOrder;
    },
  });

  const order = useQuery({ ...neighboursOf(recordId), enabled: !!view && !!table && !given });

  // Stepping is meant to be instant (Alt+Down, held): the next one's neighbours are fetched before they are needed.
  const { data } = order;
  useEffect(() => {
    if (!data || given) return;
    for (const id of [data.prevId, data.nextId]) if (id) void qc.prefetchQuery(neighboursOf(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- neighboursOf is rebuilt on every render; its inputs are the other dependencies
  }, [data, given, qc, tableId, viewId, configKey, timeZone]);

  return useMemo(() => {
    if (given && handed) {
      const i = handed.indexOf(recordId);
      return { prevId: handed[i - 1] ?? null, nextId: handed[i + 1] ?? null };
    }
    return data ?? { prevId: null, nextId: null };
  }, [given, handed, data, recordId]);
}
