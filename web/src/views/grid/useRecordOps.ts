/**
 * Record mutations for the grid: optimistic cell edits with rollback, create/duplicate/delete/
 * move, and the undo/redo executor. Cell values in `CellChange` are *view* values (links as
 * `[{id,name}]`); they are converted with `toWire` at the API boundary.
 */
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/api/client";
import { jsonEqual } from "@/lib/cells/parse";
import { toWire, writableValues } from "@/lib/cells/wire";
import type { GridData } from "./useGridData";
import { invertChanges, toPatches, type CellChange, type UndoOp, type UndoStack } from "./undo";

const BATCH = 500;

export interface RecordOps {
  /** Apply cell changes optimistically, save them, and record an undo entry. Resolves true on success. */
  applyChanges(changes: readonly CellChange[], label: string): Promise<boolean>;
  /** Create records (values are wire values keyed by field id). Resolves with the created records. */
  createRecords(opts: { values?: Record<string, unknown>[]; count?: number; afterRecordId?: string; beforeRecordId?: string }): Promise<TableRecord[]>;
  duplicateRecords(records: readonly TableRecord[]): Promise<TableRecord[]>;
  deleteRecords(ids: readonly string[]): Promise<boolean>;
  moveRecords(ids: readonly string[], target: { beforeId?: string; afterId?: string }): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface RecordOpsParams {
  tableId: string;
  fields: readonly Field[];
  data: GridData;
  stack: UndoStack;
  canEdit: boolean;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function useRecordOps({ tableId, fields, data, stack, canEdit }: RecordOpsParams): RecordOps {
  const qc = useQueryClient();
  const toast = useToast();
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f] as const)), [fields]);

  const invalidate = useCallback(
    (touchesLinks: boolean) => {
      void qc.invalidateQueries({ queryKey: touchesLinks ? ["records"] : recordKeys.table(tableId) });
    },
    [qc, tableId],
  );

  /** Send patches (already in the direction to apply) and reconcile the cache with the response. */
  const writePatches = useCallback(
    async (patches: { id: string; values: Record<string, unknown> }[]): Promise<void> => {
      for (const part of chunk(patches, BATCH)) {
        const body = {
          typecast: true,
          records: part.map((p) => ({
            id: p.id,
            values: Object.fromEntries(Object.entries(p.values).map(([fid, v]) => [fid, fieldById.has(fid) ? toWire(fieldById.get(fid)!, v) : v])),
          })),
        };
        const res = await recordsApi.update(tableId, body as Parameters<typeof recordsApi.update>[1]);
        if (res?.records) data.upsertRecords(res.records);
      }
    },
    [tableId, fieldById, data],
  );

  const applyChanges = useCallback(
    async (changes: readonly CellChange[], label: string): Promise<boolean> => {
      if (!canEdit) return false;
      const effective = changes.filter((c) => !jsonEqual(c.before, c.after));
      if (effective.length === 0) return true;
      const patches = toPatches(effective, "redo");
      const previous: TableRecord[] = [];
      for (const p of patches) {
        const prev = data.patchValues(p.id, p.values);
        if (prev) previous.push(prev);
      }
      try {
        await writePatches(patches);
      } catch (e) {
        data.upsertRecords(previous);
        toast.error(e, "Could not save changes");
        return false;
      }
      stack.push({ kind: "edit", label, changes: effective.map((c) => ({ ...c, before: c.before ?? null, after: c.after ?? null })) });
      invalidate(effective.some((c) => fieldById.get(c.fieldId)?.type === "link"));
      return true;
    },
    [canEdit, data, writePatches, toast, stack, invalidate, fieldById],
  );

  const moveRecords = useCallback(
    async (ids: readonly string[], target: { beforeId?: string; afterId?: string }): Promise<boolean> => {
      try {
        await recordsApi.move(tableId, { ids: [...ids], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
        invalidate(false);
        return true;
      } catch (e) {
        toast.error(e, "Could not move records");
        return false;
      }
    },
    [tableId, toast, invalidate],
  );

  const createRecords = useCallback<RecordOps["createRecords"]>(
    async ({ values, count = 1, afterRecordId, beforeRecordId }) => {
      if (!canEdit) return [];
      const list = values ?? Array.from({ length: count }, () => ({}));
      const created: TableRecord[] = [];
      try {
        let after = afterRecordId;
        for (const part of chunk(list, BATCH)) {
          const res = await recordsApi.create(tableId, { records: part.map((v) => ({ values: v as Record<string, never> })), typecast: true, after_record_id: after ?? null });
          created.push(...res.records);
          after = res.records[res.records.length - 1]?.id ?? after;
        }
      } catch (e) {
        toast.error(e, "Could not add the record");
        return created;
      }
      if (beforeRecordId && created.length > 0) await moveRecords(created.map((r) => r.id), { beforeId: beforeRecordId });
      if (created.length > 0) stack.push({ kind: "create", label: created.length === 1 ? "Add record" : `Add ${created.length} records`, ids: created.map((r) => r.id) });
      invalidate(false);
      return created;
    },
    [canEdit, tableId, toast, stack, invalidate, moveRecords],
  );

  const duplicateRecords = useCallback<RecordOps["duplicateRecords"]>(
    async (records) => {
      const out: TableRecord[] = [];
      // Each copy goes right after its original (in manual order views).
      for (const r of records) {
        const created = await createRecords({ values: [writableValues(fields, r.values as Record<string, unknown>)], afterRecordId: r.id });
        out.push(...created);
      }
      return out;
    },
    [createRecords, fields],
  );

  const deleteRecords = useCallback(
    async (ids: readonly string[]): Promise<boolean> => {
      if (!canEdit || ids.length === 0) return false;
      try {
        for (const part of chunk(ids, BATCH)) await recordsApi.remove(tableId, part);
      } catch (e) {
        toast.error(e, "Could not delete");
        return false;
      }
      stack.push({ kind: "delete", label: ids.length === 1 ? "Delete record" : `Delete ${ids.length} records`, ids: [...ids] });
      invalidate(true);
      return true;
    },
    [canEdit, tableId, toast, stack, invalidate],
  );

  const perform = useCallback(
    async (op: UndoOp, dir: "undo" | "redo"): Promise<void> => {
      switch (op.kind) {
        case "edit": {
          const changes = dir === "undo" ? invertChanges(op.changes) : op.changes;
          const patches = toPatches(changes, "redo");
          for (const p of patches) data.patchValues(p.id, p.values);
          await writePatches(patches);
          invalidate(op.changes.some((c) => fieldById.get(c.fieldId)?.type === "link"));
          return;
        }
        case "create":
        case "delete": {
          const remove = (op.kind === "create") === (dir === "undo");
          for (const part of chunk(op.ids, BATCH)) {
            if (remove) await recordsApi.remove(tableId, part);
            else await recordsApi.restore(tableId, part);
          }
          invalidate(true);
          return;
        }
      }
    },
    [data, writePatches, invalidate, fieldById, tableId],
  );

  const undo = useCallback(async () => {
    try {
      await stack.undo((op) => perform(op, "undo"));
    } catch (e) {
      toast.error(e, `Could not undo (${errorMessage(e)})`);
    }
  }, [stack, perform, toast]);

  const redo = useCallback(async () => {
    try {
      await stack.redo((op) => perform(op, "redo"));
    } catch (e) {
      toast.error(e, "Could not redo");
    }
  }, [stack, perform, toast]);

  return { applyChanges, createRecords, duplicateRecords, deleteRecords, moveRecords, undo, redo };
}
