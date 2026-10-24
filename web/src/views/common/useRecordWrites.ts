/**
 * Record writes shared by the non-grid views: optimistic edits of every cached whole-view query
 * of the table (see `cache.ts`), rolled back when the server rejects them, followed by an
 * invalidation of `["records", tableId]` so the views refetch (the server does not echo this
 * tab's own events).
 *
 * Every successful write is also pushed to the view's undo stack (`history`; Ctrl/Cmd+Z in
 * `ViewFrame`), and deletes and drops show a toast with an Undo button. New records start with the
 * values the view's filter pins down (`prefill`), and one that is left untouched can be thrown away
 * again when its panel closes (`discardIfUntouched`).
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, TableRecord, ViewConfig } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { jsonEqual } from "@/lib/cells/parse";
import { toWire, writableValues } from "@/lib/cells/wire";
import { hasPlacement, type Placement, type RecordOp, type ValueChange } from "@/lib/undo/recordOps";
import { UndoStack } from "@/lib/undo/stack";
import { isViewRecordsData, moveRecordInList, patchRecordValues, removeRecords, upsertRecords, type ViewRecordsData } from "./cache";
import { prefillFor } from "./prefill";

type Snapshot = [QueryKey, ViewRecordsData][];

/** Most ids one request carries (the grid's batch size). */
const BATCH = 500;
/** Most records one duplicate request copies. */
const DUPLICATE_BATCH = 100;
/** How long a delete's Undo stays on screen. */
const UNDO_TOAST_MS = 8000;

export interface WriteOptions {
  /** What the undo history calls this step ("Move card"). */
  label?: string;
  /** Show a success toast with an Undo button, titled so ("Moved to Done"). A write that moves the record shows one anyway. */
  toast?: string;
}

export interface RecordHistory {
  canUndo: boolean;
  canRedo: boolean;
  /** Label of what Undo would revert, for a tooltip. */
  undoLabel?: string;
  redoLabel?: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface RecordWrites {
  /** Set cell values (view form: links as `[{id,name}]`) on one record. Resolves true on success. */
  update(recordId: string, values: Record<string, unknown>, opts?: WriteOptions): Promise<boolean>;
  /** Move a record in manual order (only meaningful when the view has no sorts). */
  move(recordId: string, target: { beforeId?: string; afterId?: string }, opts?: WriteOptions): Promise<boolean>;
  /**
   * Update then reposition as one optimistic step and one undo step (kanban drop). Two requests: if the
   * second fails after the first was saved, the values stay saved and the records are refetched (the
   * toast says what was and was not done), and this resolves false.
   */
  updateAndMove(recordId: string, values: Record<string, unknown>, target: { beforeId?: string; afterId?: string } | null, opts?: WriteOptions): Promise<boolean>;
  /**
   * Create a record; `values` are in view form and win over the `prefill` of the view's filter (a key
   * present with `null` clears it). Resolves with the created record, or null: it failed, or another
   * create is still on its way (a double click adds one record, not two).
   */
  create(values: Record<string, unknown>, opts?: { afterRecordId?: string; prefill?: boolean }): Promise<TableRecord | null>;
  /** Delete records (to the trash), with a toast whose Undo restores them. Resolves true on success. */
  remove(ids: readonly string[]): Promise<boolean>;
  /** Copy records, each right after its original. Resolves with the copies (in order). */
  duplicate(records: readonly TableRecord[]): Promise<TableRecord[]>;
  /** Values a new record starts with in this view: its filter's, then `group` (field id to raw value) on top. */
  prefill(group?: Record<string, unknown>): Record<string, unknown>;
  /**
   * Delete a record `create` made if nothing was changed in it since (its values on the server are
   * still those it was created with). For the panel of a record just added, when it closes. Resolves
   * true when it was discarded.
   */
  discardIfUntouched(recordId: string): Promise<boolean>;
  history: RecordHistory;
}

export interface RecordWritesParams {
  tableId: string;
  fields: readonly Field[];
  canEdit: boolean;
  /** The config the view's queries run with, for the filter new records start from. */
  queryConfig?: Pick<ViewConfig, "filter">;
  /** For "me" in a filter on a person field. */
  currentUserId?: string | null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a created record held when it was made, and the undo step that made it. */
interface Created {
  values: Record<string, unknown>;
  op: RecordOp;
}

export function useRecordWrites({ tableId, fields, canEdit, queryConfig, currentUserId = null }: RecordWritesParams): RecordWrites {
  const qc = useQueryClient();
  const toast = useToast();
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f] as const)), [fields]);
  const stack = useMemo(() => new UndoStack<RecordOp>(), []);
  const created = useRef(new Map<string, Created>());
  const creating = useRef(false);
  const filter = queryConfig?.filter ?? null;

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

  /** A record as the views hold it now (a whole-view query, else its own cache entry). */
  const find = useCallback(
    (snap: Snapshot, recordId: string): TableRecord | undefined => {
      for (const [, data] of snap) {
        const r = data.records.find((x) => x.id === recordId);
        if (r) return r;
      }
      return qc.getQueryData<TableRecord>(recordKeys.record(tableId, recordId));
    },
    [qc, tableId],
  );

  /** Where a record sits in manual order now: right after the one above it, or right before the one below. */
  const placementOf = useCallback((snap: Snapshot, recordId: string): Placement | undefined => {
    for (const [, data] of snap) {
      const i = data.records.findIndex((x) => x.id === recordId);
      if (i < 0) continue;
      const above = data.records[i - 1];
      const below = data.records[i + 1];
      if (above) return { afterId: above.id };
      if (below) return { beforeId: below.id };
      return undefined;
    }
    return undefined;
  }, []);

  const touchesLinks = useCallback((ids: Iterable<string>) => [...ids].some((id) => fieldById.get(id)?.type === "link"), [fieldById]);

  // --- Running an undo step, either way -------------------------------------------------------

  const perform = useCallback(
    async (op: RecordOp, dir: "undo" | "redo"): Promise<void> => {
      switch (op.kind) {
        case "edit": {
          const byRecord = new Map<string, Record<string, unknown>>();
          for (const c of op.changes) {
            const values = byRecord.get(c.recordId) ?? {};
            values[c.fieldId] = dir === "undo" ? c.before : c.after;
            byRecord.set(c.recordId, values);
          }
          await qc.cancelQueries({ queryKey: recordKeys.table(tableId) });
          const snap = snapshot();
          for (const [id, values] of byRecord) mutateCaches((d) => patchRecordValues(d, id, values));
          try {
            const res = await recordsApi.update(tableId, { typecast: true, records: [...byRecord].map(([id, values]) => ({ id, values: wire(values) as never })) });
            if (res?.records) mutateCaches((d) => upsertRecords(d, res.records));
          } catch (e) {
            rollback(snap);
            throw e;
          } finally {
            settle(touchesLinks(op.changes.map((c) => c.fieldId)));
          }
          return;
        }
        case "move": {
          const target = dir === "undo" ? op.before : op.after;
          if (!hasPlacement(target)) return;
          await qc.cancelQueries({ queryKey: recordKeys.table(tableId) });
          const snap = snapshot();
          mutateCaches((d) => moveRecordInList(d, op.recordId, target));
          try {
            await recordsApi.move(tableId, { ids: [op.recordId], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
          } catch (e) {
            rollback(snap);
            throw e;
          } finally {
            settle(false);
          }
          return;
        }
        case "create":
        case "delete": {
          const removing = (op.kind === "create") === (dir === "undo");
          try {
            if (removing) {
              mutateCaches((d) => removeRecords(d, new Set(op.ids)));
              for (const part of chunk(op.ids, BATCH)) await recordsApi.remove(tableId, part);
            } else {
              for (const part of chunk(op.ids, BATCH)) await recordsApi.restore(tableId, part);
            }
          } finally {
            settle(true);
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
    [qc, tableId, snapshot, mutateCaches, rollback, settle, wire, touchesLinks],
  );

  const undo = useCallback(async () => {
    try {
      await stack.undo((op) => perform(op, "undo"));
    } catch (e) {
      toast.error(e, "Could not undo");
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
    async (op: RecordOp) => {
      try {
        await stack.undoOp(op, (o) => perform(o, "undo"));
      } catch (e) {
        toast.error(e, "Could not undo");
      }
    },
    [stack, perform, toast],
  );

  /** Record a finished step and, when asked, tell the person with an Undo button. */
  const done = useCallback(
    (op: RecordOp, title?: string, durationMs?: number) => {
      stack.push(op);
      if (title) toast.toast({ title, variant: "success", durationMs, action: { label: "Undo", onClick: () => void undoStep(op) } });
    },
    [stack, toast, undoStep],
  );

  // --- Edits and moves ------------------------------------------------------------------------

  const updateAndMove = useCallback<RecordWrites["updateAndMove"]>(
    async (recordId, values, target, opts) => {
      if (!canEdit) return false;
      // A refetch in flight would overwrite the optimistic edit with data from before it.
      await qc.cancelQueries({ queryKey: recordKeys.table(tableId) });
      const snap = snapshot();
      const before = find(snap, recordId);
      const changes: ValueChange[] = before
        ? Object.keys(values)
            .map((fieldId) => ({ recordId, fieldId, before: before.values[fieldId] ?? null, after: values[fieldId] ?? null }))
            .filter((c) => !jsonEqual(c.before, c.after))
        : [];
      const placeBefore = target ? placementOf(snap, recordId) : undefined;
      mutateCaches((d) => {
        let next = patchRecordValues(d, recordId, values);
        if (target) next = moveRecordInList(next, recordId, target);
        return next;
      });
      const hasValues = Object.keys(values).length > 0;
      let saved = false;
      try {
        if (hasValues) {
          const res = await recordsApi.update(tableId, { typecast: true, records: [{ id: recordId, values: wire(values) as never }] });
          saved = true;
          if (res?.records) mutateCaches((d) => upsertRecords(d, res.records));
        }
        if (target) await recordsApi.move(tableId, { ids: [recordId], before_id: target.beforeId ?? null, after_id: target.afterId ?? null });
      } catch (e) {
        if (saved) {
          // The server holds the new values; only the position failed. Rolling everything back would show
          // the old values of a record that has the new ones: keep them, put the order back, and refetch.
          rollback(snap);
          mutateCaches((d) => patchRecordValues(d, recordId, values));
          if (changes.length > 0) stack.push({ kind: "edit", label: opts?.label ?? "Edit record", changes });
          toast.error(e, "The change was saved, but the record could not be moved to that place");
          settle(touchesLinks(Object.keys(values)));
          return false;
        }
        rollback(snap);
        toast.error(e, target && !hasValues ? "Could not move the record" : "Could not save changes");
        settle(false);
        return false;
      }
      const ops: RecordOp[] = [];
      const label = opts?.label ?? (target ? "Move record" : "Edit record");
      if (changes.length > 0) ops.push({ kind: "edit", label, changes });
      if (target && hasPlacement(placeBefore)) ops.push({ kind: "move", label, recordId, before: placeBefore, after: target });
      if (ops.length > 0) done(ops.length === 1 ? ops[0]! : { kind: "group", label, ops }, opts?.toast ?? (target ? "Record moved" : undefined));
      settle(touchesLinks(Object.keys(values)));
      return true;
    },
    [canEdit, qc, snapshot, find, placementOf, mutateCaches, tableId, wire, rollback, stack, toast, settle, touchesLinks, done],
  );

  const update = useCallback<RecordWrites["update"]>((recordId, values, opts) => updateAndMove(recordId, values, null, opts), [updateAndMove]);
  const move = useCallback<RecordWrites["move"]>((recordId, target, opts) => updateAndMove(recordId, {}, target, opts), [updateAndMove]);

  // --- Creating, copying, deleting ------------------------------------------------------------

  const prefill = useCallback<RecordWrites["prefill"]>((group) => prefillFor(fields, filter, group, currentUserId), [fields, filter, currentUserId]);

  const insert = useCallback(
    async (values: Record<string, unknown>, afterRecordId?: string): Promise<TableRecord> => {
      const res = await recordsApi.create(tableId, { records: [{ values: wire(values) as never }], typecast: true, after_record_id: afterRecordId ?? null });
      const rec = res.records[0];
      if (!rec) throw new Error("The server did not return the new record");
      return rec;
    },
    [tableId, wire],
  );

  const create = useCallback<RecordWrites["create"]>(
    async (values, opts) => {
      if (!canEdit || creating.current) return null;
      creating.current = true;
      try {
        const rec = await insert(opts?.prefill === false ? values : { ...prefill(), ...values }, opts?.afterRecordId);
        const op: RecordOp = { kind: "create", label: "Add record", ids: [rec.id] };
        stack.push(op);
        created.current.set(rec.id, { values: writableValues(fields, rec.values as Record<string, unknown>), op });
        settle(true);
        return rec;
      } catch (e) {
        toast.error(e, "Could not add the record");
        return null;
      } finally {
        creating.current = false;
      }
    },
    [canEdit, insert, prefill, stack, fields, settle, toast],
  );

  const duplicate = useCallback<RecordWrites["duplicate"]>(
    async (records) => {
      if (!canEdit || records.length === 0) return [];
      const copies: TableRecord[] = [];
      try {
        // The server puts each copy right after its original (in manual order views), a request at a time, all or nothing.
        for (const part of chunk(records, DUPLICATE_BATCH)) copies.push(...(await recordsApi.duplicate(tableId, part.map((r) => r.id))).records);
      } catch (e) {
        toast.error(e, copies.length > 0 ? "Could not copy every record" : "Could not duplicate the record");
      }
      if (copies.length > 0) {
        stack.push({ kind: "create", label: copies.length === 1 ? "Duplicate record" : `Duplicate ${copies.length} records`, ids: copies.map((c) => c.id) });
        settle(true);
      }
      return copies;
    },
    [canEdit, tableId, stack, settle, toast],
  );

  const remove = useCallback<RecordWrites["remove"]>(
    async (ids) => {
      if (!canEdit || ids.length === 0) return false;
      await qc.cancelQueries({ queryKey: recordKeys.table(tableId) });
      const snap = snapshot();
      const gone = new Set(ids);
      mutateCaches((d) => removeRecords(d, gone));
      try {
        for (const part of chunk(ids, BATCH)) await recordsApi.remove(tableId, part);
      } catch (e) {
        rollback(snap);
        toast.error(e, "Could not delete");
        settle(true);
        return false;
      }
      const label = ids.length === 1 ? "Delete record" : `Delete ${ids.length} records`;
      done({ kind: "delete", label, ids: [...ids] }, ids.length === 1 ? "Record deleted" : `${ids.length} records deleted`, UNDO_TOAST_MS);
      settle(true);
      return true;
    },
    [canEdit, qc, tableId, snapshot, mutateCaches, rollback, toast, settle, done],
  );

  const discardIfUntouched = useCallback<RecordWrites["discardIfUntouched"]>(
    async (recordId) => {
      const made = created.current.get(recordId);
      if (!made) return false;
      created.current.delete(recordId);
      // The panel saves what was typed as it goes away: let those saves land before looking.
      await sleep(0);
      for (let i = 0; i < 100 && qc.isMutating({ mutationKey: ["record-save", tableId] }) > 0; i++) await sleep(40);
      try {
        const now = await recordsApi.get(tableId, recordId);
        if (!jsonEqual(writableValues(fields, now.values as Record<string, unknown>), made.values)) return false;
        mutateCaches((d) => removeRecords(d, new Set([recordId])));
        await recordsApi.remove(tableId, [recordId]);
      } catch {
        // Not there, or not removable: it stays, as before.
        settle(true);
        return false;
      }
      stack.drop(made.op);
      settle(true);
      return true;
    },
    [qc, tableId, fields, mutateCaches, stack, settle],
  );

  // --- History --------------------------------------------------------------------------------

  const revision = useSyncExternalStore(
    useCallback((fn: () => void) => stack.subscribe(fn), [stack]),
    () => stack.revision,
  );
  const history = useMemo<RecordHistory>(
    () => ({ canUndo: stack.canUndo, canRedo: stack.canRedo, undoLabel: stack.peekUndo()?.label, redoLabel: stack.peekRedo()?.label, undo, redo }),
    // `revision` is the stack's change counter.
    [stack, revision, undo, redo],
  );

  return useMemo(
    () => ({ update, move, updateAndMove, create, remove, duplicate, prefill, discardIfUntouched, history }),
    [update, move, updateAndMove, create, remove, duplicate, prefill, discardIfUntouched, history],
  );
}
