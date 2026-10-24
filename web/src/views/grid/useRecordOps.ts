/**
 * Record mutations for the grid: optimistic cell edits with rollback, create/duplicate/delete/
 * move, and the undo/redo executor. Cell values in `CellChange` are *view* values (links as
 * `[{id,name}]`); they are converted with `toWire` at the API boundary.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys, recordsApi, schemaApi } from "@/api/records";
import type { Field, TableRecord } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/api/client";
import { jsonEqual } from "@/lib/cells/parse";
import { toWire } from "@/lib/cells/wire";
import { hasPlacement } from "@/lib/undo/recordOps";
import type { RecordHistory } from "@/views/common/useRecordWrites";
import type { GridData } from "./useGridData";
import { invertChanges, toPatches, type CellChange, type Placement, type UndoOp, type UndoStack } from "./undo";

const BATCH = 500;
/** Most records one duplicate request copies. */
const DUPLICATE_BATCH = 100;
/** How long the Undo of a toast stays on screen. */
const UNDO_TOAST_MS = 8000;

/** What a toast with an Undo button says: its title, and what else the person should know. */
export type ToastMessage = string | { title: string; description?: string };

export interface RecordOps {
  /**
   * Apply cell changes optimistically, save them, and record an undo entry (into `collect` instead,
   * when a bigger step is being put together; see `commit`). Resolves true on success.
   */
  applyChanges(changes: readonly CellChange[], label: string, opts?: { collect?: UndoOp[] }): Promise<boolean>;
  /** Create records (values are wire values keyed by field id). Resolves with the created records. */
  createRecords(opts: { values?: Record<string, unknown>[]; count?: number; afterRecordId?: string; beforeRecordId?: string; collect?: UndoOp[] }): Promise<TableRecord[]>;
  /** Copy records, each right after its original, as one undo step. Resolves with the copies, in order. */
  duplicateRecords(ids: readonly string[]): Promise<TableRecord[]>;
  /** Delete records (to the trash), with a toast whose Undo restores them. */
  deleteRecords(ids: readonly string[]): Promise<boolean>;
  /** Delete a field (to the trash), with a toast whose Undo restores it. */
  deleteField(field: Field): Promise<boolean>;
  /** Place records before or after another one. `previous` is where the first of them was, for Undo. */
  moveRecords(ids: readonly string[], target: { beforeId?: string; afterId?: string }, previous?: Placement): Promise<boolean>;
  /** Record the steps collected for one gesture as a single undo entry, with a toast offering Undo when `message` is given. */
  commit(ops: UndoOp[], label: string, message?: ToastMessage): void;
  history: RecordHistory;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface RecordOpsParams {
  baseId: string;
  tableId: string;
  fields: readonly Field[];
  data: GridData;
  stack: UndoStack<UndoOp>;
  canEdit: boolean;
  /** Records were added or removed (a delete, a copy, an undo of either): row positions, and a selection made of them, no longer hold. */
  onRowsChanged?: () => void;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", n.toLocaleString()));

export function useRecordOps({ baseId, tableId, fields, data, stack, canEdit, onRowsChanged }: RecordOpsParams): RecordOps {
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

  // --- Running an undo step, either way -------------------------------------------------------

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
          try {
            for (const part of chunk(op.ids, BATCH)) {
              if (remove) await recordsApi.remove(tableId, part);
              else await recordsApi.restore(tableId, part);
            }
          } finally {
            invalidate(true);
            onRowsChanged?.();
          }
          return;
        }
        case "move": {
          const target = dir === "undo" ? op.before : op.after;
          if (!hasPlacement(target)) return;
          try {
            const res = await recordsApi.move(tableId, { ids: [...op.ids], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
            data.upsertRecords(res.records);
          } finally {
            invalidate(false);
          }
          return;
        }
        case "field": {
          try {
            if (dir === "undo") await api.trash.restore({ kind: "field", id: op.fieldId });
            else await schemaApi.deleteField(op.fieldId);
          } finally {
            // The columns, and what the other views and records hold of the field, change with it.
            void qc.invalidateQueries({ queryKey: keys.base(baseId) });
            void qc.invalidateQueries({ queryKey: ["records"] });
          }
          return;
        }
        case "group": {
          const ops = dir === "undo" ? [...op.ops].reverse() : op.ops;
          for (const sub of ops) await perform(sub, dir);
          return;
        }
      }
    },
    [data, writePatches, invalidate, fieldById, tableId, onRowsChanged, qc, baseId],
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

  /** The Undo button of a toast: reverts that step, whatever was done since. */
  const undoStep = useCallback(
    async (op: UndoOp) => {
      try {
        await stack.undoOp(op, (o) => perform(o, "undo"));
      } catch (e) {
        toast.error(e, "Could not undo");
      }
    },
    [stack, perform, toast],
  );

  /** Put a finished step on the stack (or into `collect`) and, when asked, tell the person with an Undo button. */
  const record = useCallback(
    (op: UndoOp, collect?: UndoOp[], message?: ToastMessage) => {
      if (op.kind === "edit" && op.changes.length === 0) return;
      if (collect) {
        collect.push(op);
        return;
      }
      stack.push(op);
      if (message) {
        const { title, description } = typeof message === "string" ? { title: message, description: undefined } : message;
        toast.toast({ title, description, variant: "success", durationMs: description ? UNDO_TOAST_MS * 2 : UNDO_TOAST_MS, action: { label: "Undo", onClick: () => void undoStep(op) } });
      }
    },
    [stack, toast, undoStep],
  );

  const commit = useCallback<RecordOps["commit"]>(
    (ops, label, message) => {
      if (ops.length === 0) return;
      record(ops.length === 1 ? ops[0]! : { kind: "group", label, ops }, undefined, message);
    },
    [record],
  );

  // --- Writes ---------------------------------------------------------------------------------

  const applyChanges = useCallback<RecordOps["applyChanges"]>(
    async (changes, label, opts) => {
      if (!canEdit) return false;
      const effective = changes.filter((c) => !jsonEqual(c.before, c.after));
      if (effective.length === 0) return true;
      const normalised = effective.map((c) => ({ ...c, before: c.before ?? null, after: c.after ?? null }));
      const patches = toPatches(effective, "redo");
      const previous: TableRecord[] = [];
      for (const p of patches) {
        const prev = data.patchValues(p.id, p.values);
        if (prev) previous.push(prev);
      }
      const saved = new Set<string>();
      try {
        // Big edits go in batches: the ones that were saved before a batch failed stay saved, and stay undoable.
        for (const part of chunk(patches, BATCH)) {
          await writePatches(part);
          for (const p of part) saved.add(p.id);
        }
      } catch (e) {
        data.upsertRecords(previous.filter((r) => !saved.has(r.id)));
        toast.error(e, saved.size > 0 ? "Could not save every change" : "Could not save changes");
        if (saved.size > 0) {
          record({ kind: "edit", label, changes: normalised.filter((c) => saved.has(c.recordId)) }, opts?.collect);
          invalidate(true);
        }
        return false;
      }
      record({ kind: "edit", label, changes: normalised }, opts?.collect);
      invalidate(effective.some((c) => fieldById.get(c.fieldId)?.type === "link"));
      return true;
    },
    [canEdit, data, writePatches, toast, record, invalidate, fieldById],
  );

  const moveRecords = useCallback<RecordOps["moveRecords"]>(
    async (ids, target, previous) => {
      try {
        const res = await recordsApi.move(tableId, { ids: [...ids], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
        data.upsertRecords(res.records);
        invalidate(false);
      } catch (e) {
        toast.error(e, "Could not move records");
        return false;
      }
      if (hasPlacement(previous)) {
        record({ kind: "move", label: plural(ids.length, "Move record", "Move {n} records"), ids: [...ids], before: previous, after: target }, undefined, plural(ids.length, "Record moved", "{n} records moved"));
      }
      return true;
    },
    [tableId, data, toast, invalidate, record],
  );

  const createRecords = useCallback<RecordOps["createRecords"]>(
    async ({ values, count = 1, afterRecordId, beforeRecordId, collect }) => {
      if (!canEdit) return [];
      const list = values ?? Array.from({ length: count }, () => ({}));
      const created: TableRecord[] = [];
      let failure: unknown = null;
      try {
        // Batches keep their order: the first goes where asked, each next one right after the previous.
        let after = afterRecordId;
        let before = beforeRecordId;
        for (const part of chunk(list, BATCH)) {
          const res = await recordsApi.create(tableId, { records: part.map((v) => ({ values: v as Record<string, never> })), typecast: true, after_record_id: after ?? null, before_record_id: before ?? null });
          created.push(...res.records);
          const last = res.records[res.records.length - 1]?.id;
          if (last) {
            after = last;
            before = undefined;
          }
        }
      } catch (e) {
        failure = e;
      }
      // The records made before a batch failed exist: they stay undoable.
      if (created.length > 0) record({ kind: "create", label: plural(created.length, "Add record", "Add {n} records"), ids: created.map((r) => r.id) }, collect);
      if (failure) toast.error(failure, created.length > 0 ? "Could not add every record" : "Could not add the record");
      invalidate(false);
      return created;
    },
    [canEdit, tableId, toast, record, invalidate],
  );

  const duplicateRecords = useCallback<RecordOps["duplicateRecords"]>(
    async (ids) => {
      if (!canEdit || ids.length === 0) return [];
      const copies: TableRecord[] = [];
      let failure: unknown = null;
      try {
        // The server puts each copy right after its original, a request at a time, all or nothing.
        for (const part of chunk(ids, DUPLICATE_BATCH)) copies.push(...(await recordsApi.duplicate(tableId, part)).records);
      } catch (e) {
        failure = e;
      }
      if (copies.length > 0) {
        record(
          { kind: "create", label: plural(copies.length, "Duplicate record", "Duplicate {n} records"), ids: copies.map((c) => c.id) },
          undefined,
          plural(copies.length, "Record duplicated", "{n} records duplicated"),
        );
        invalidate(true);
        onRowsChanged?.();
      }
      if (failure) toast.error(failure, copies.length > 0 ? "Could not copy every record" : "Could not duplicate the record");
      return copies;
    },
    [canEdit, tableId, record, invalidate, toast, onRowsChanged],
  );

  const deleteRecords = useCallback<RecordOps["deleteRecords"]>(
    async (ids) => {
      if (!canEdit || ids.length === 0) return false;
      const gone: string[] = [];
      let failure: unknown = null;
      try {
        for (const part of chunk(ids, BATCH)) {
          await recordsApi.remove(tableId, part);
          gone.push(...part);
        }
      } catch (e) {
        failure = e;
      }
      if (gone.length > 0) {
        record({ kind: "delete", label: plural(gone.length, "Delete record", "Delete {n} records"), ids: gone }, undefined, plural(gone.length, "Record deleted", "{n} records deleted"));
        invalidate(true);
        onRowsChanged?.();
      }
      if (failure) toast.error(failure, gone.length > 0 ? "Could not delete every record" : "Could not delete");
      return !failure;
    },
    [canEdit, tableId, toast, record, invalidate, onRowsChanged],
  );

  const deleteField = useCallback<RecordOps["deleteField"]>(
    async (field) => {
      try {
        await schemaApi.deleteField(field.id);
      } catch (e) {
        toast.error(e, "Could not delete the field");
        return false;
      }
      void qc.invalidateQueries({ queryKey: keys.base(baseId) });
      void qc.invalidateQueries({ queryKey: ["records"] });
      record({ kind: "field", label: `Delete field ${field.name}`, fieldId: field.id }, undefined, `Field "${field.name}" deleted`);
      return true;
    },
    [qc, baseId, toast, record],
  );

  // --- History --------------------------------------------------------------------------------

  const revision = useSyncExternalStore(
    useCallback((fn: () => void) => stack.subscribe(fn), [stack]),
    () => stack.revision,
  );
  const history = useMemo<RecordHistory>(
    () => ({ canUndo: stack.canUndo, canRedo: stack.canRedo, undoLabel: stack.peekUndo()?.label, redoLabel: stack.peekRedo()?.label, undo, redo }),
    // `revision` is the stack's change counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stack, revision, undo, redo],
  );

  return { applyChanges, createRecords, duplicateRecords, deleteRecords, deleteField, moveRecords, commit, history, undo, redo };
}
