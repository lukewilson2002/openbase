/**
 * Record writes shared by the non-grid views: optimistic edits of every cached whole-view query
 * of the table (see `cache.ts`), rolled back when the server rejects them, followed by an
 * invalidation of `["records", tableId]` so the views refetch (the server does not echo this
 * tab's own events).
 */
import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { toWire } from "@/lib/cells/wire";
import { isViewRecordsData, moveRecordInList, patchRecordValues, upsertRecords, type ViewRecordsData } from "./cache";

type Snapshot = [QueryKey, ViewRecordsData][];

export interface RecordWrites {
  /** Set cell values (view form: links as `[{id,name}]`) on one record. Resolves true on success. */
  update(recordId: string, values: Record<string, unknown>): Promise<boolean>;
  /** Move a record in manual order (only meaningful when the view has no sorts). */
  move(recordId: string, target: { beforeId?: string; afterId?: string }): Promise<boolean>;
  /** Update then reposition as one optimistic step (kanban drop). */
  updateAndMove(recordId: string, values: Record<string, unknown>, target: { beforeId?: string; afterId?: string } | null): Promise<boolean>;
  /** Create a record; `values` are in view form. Resolves with the created record or null. */
  create(values: Record<string, unknown>, opts?: { afterRecordId?: string }): Promise<TableRecord | null>;
}

export function useRecordWrites({ tableId, fields, canEdit }: { tableId: string; fields: readonly Field[]; canEdit: boolean }): RecordWrites {
  const qc = useQueryClient();
  const toast = useToast();
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f] as const)), [fields]);

  const wire = useCallback(
    (values: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(values).map(([id, v]) => [id, fieldById.has(id) ? toWire(fieldById.get(id)!, v) : v])),
    [fieldById],
  );

  const snapshot = useCallback((): Snapshot => {
    const out: Snapshot = [];
    for (const [key, data] of qc.getQueriesData({ queryKey: recordKeys.table(tableId) })) {
      if (isViewRecordsData(data)) out.push([key, data]);
    }
    return out;
  }, [qc, tableId]);

  const mutateCaches = useCallback(
    (fn: (d: ViewRecordsData) => ViewRecordsData) => {
      for (const [key, data] of snapshot()) {
        const next = fn(data);
        if (next !== data) qc.setQueryData(key, next);
      }
    },
    [qc, snapshot],
  );

  const rollback = useCallback(
    (snap: Snapshot) => {
      for (const [key, data] of snap) qc.setQueryData(key, data);
    },
    [qc],
  );

  const settle = useCallback(
    (touchesLinks: boolean) => {
      void qc.invalidateQueries({ queryKey: touchesLinks ? ["records"] : recordKeys.table(tableId) });
    },
    [qc, tableId],
  );

  const updateAndMove = useCallback<RecordWrites["updateAndMove"]>(
    async (recordId, values, target) => {
      if (!canEdit) return false;
      // A refetch in flight would overwrite the optimistic edit with data from before it.
      await qc.cancelQueries({ queryKey: recordKeys.table(tableId) });
      const snap = snapshot();
      mutateCaches((d) => {
        let next = patchRecordValues(d, recordId, values);
        if (target) next = moveRecordInList(next, recordId, target);
        return next;
      });
      try {
        const hasValues = Object.keys(values).length > 0;
        if (hasValues) {
          const res = await recordsApi.update(tableId, { typecast: true, records: [{ id: recordId, values: wire(values) as never }] });
          if (res?.records) mutateCaches((d) => upsertRecords(d, res.records));
        }
        if (target) await recordsApi.move(tableId, { ids: [recordId], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
      } catch (e) {
        rollback(snap);
        toast.error(e, target && Object.keys(values).length === 0 ? "Could not move the record" : "Could not save changes");
        settle(false);
        return false;
      }
      settle(Object.keys(values).some((id) => fieldById.get(id)?.type === "link"));
      return true;
    },
    [canEdit, qc, snapshot, mutateCaches, tableId, wire, rollback, toast, settle, fieldById],
  );

  const update = useCallback<RecordWrites["update"]>((recordId, values) => updateAndMove(recordId, values, null), [updateAndMove]);
  const move = useCallback<RecordWrites["move"]>((recordId, target) => updateAndMove(recordId, {}, target), [updateAndMove]);

  const create = useCallback<RecordWrites["create"]>(
    async (values, opts) => {
      if (!canEdit) return null;
      try {
        const res = await recordsApi.create(tableId, { records: [{ values: wire(values) as never }], typecast: true, after_record_id: opts?.afterRecordId ?? null });
        settle(true);
        return res.records[0] ?? null;
      } catch (e) {
        toast.error(e, "Could not add the record");
        return null;
      }
    },
    [canEdit, tableId, wire, toast, settle],
  );

  return useMemo(() => ({ update, move, updateAndMove, create }), [update, move, updateAndMove, create]);
}
