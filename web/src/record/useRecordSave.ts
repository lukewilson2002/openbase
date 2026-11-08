/**
 * Saving the values of one record page: each edit goes out as it is committed, optimistically, one at a time per
 * collection, and the page says whether that is going on ("Saving…", "Saved", "Couldn't save"). Values that could
 * not be saved stay on screen with their error to be corrected.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { recordKeys, recordsApi } from "@/api/records";
import type { Collaborator, Field, Table, TableRecord } from "@/api/types";
import type { EditValue } from "@/components/record/editors/env";
import { jsonEqual, parseText } from "@/lib/cells/parse";
import { toWire } from "@/lib/cells/wire";

/** How long "Saved" stays in the bar. */
export const SAVED_VISIBLE_MS = 3000;

export type SaveState = "idle" | "saving" | "saved" | "error";

const URGENCY: Record<SaveState, number> = { idle: 0, saved: 1, error: 2, saving: 3 };

/** One status for the bar out of several things being saved: what is still going on, else what failed, else what was saved. */
export function combineSaveStates(...states: SaveState[]): SaveState {
  return states.reduce<SaveState>((worst, s) => (URGENCY[s] > URGENCY[worst] ? s : worst), "idle");
}

/** Nothing in a field: an empty list, no text, unchecked are all "no value", whichever way an editor says so. */
const isBlank = (v: unknown) => v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);

/**
 * The multiline text of this record that has not reached the server: typed (waiting for typing to pause) or
 * sent (waiting for the answer), by `recordId:fieldId`.
 */
export class Unsent {
  private typing = new Set<string>();
  private sent = new Map<string, number>();
  /** The text in a field is (or is no longer) different from what was last saved. */
  typed(key: string, dirty: boolean) {
    if (dirty) this.typing.add(key);
    else this.typing.delete(key);
  }
  /** A save of the field is made: its typed text is the save's now. */
  send(key: string) {
    this.typing.delete(key);
    this.sent.set(key, (this.sent.get(key) ?? 0) + 1);
  }
  /** A save of the field is answered (or refused). */
  answered(key: string) {
    const n = (this.sent.get(key) ?? 0) - 1;
    if (n > 0) this.sent.set(key, n);
    else this.sent.delete(key);
  }
  isWaiting(key: string) {
    return this.typing.has(key) || this.sent.has(key);
  }
  /** Any text of this record has not reached the server. */
  anyWaiting() {
    return this.typing.size > 0 || this.sent.size > 0;
  }
}

export interface RecordSave {
  /** Error messages by field id. */
  errors: Record<string, string>;
  /** The values that could not be saved, by field id. */
  failed: Record<string, { value: unknown }>;
  state: SaveState;
  /** What this record's fields were last saved as, by `recordId:fieldId`. */
  lastSaved: RefObject<Map<string, unknown>>;
  unsent: RefObject<Unsent>;
  /** Saves an edit; answers the value it saved, if it did. */
  onSave(field: Field, edit: EditValue): { value: unknown } | undefined;
}

export function useRecordSave({ table, recordId, record, timeZone, collaborators }: { table: Table; recordId: string; record: TableRecord | undefined; timeZone: string; collaborators: readonly Collaborator[] }): RecordSave {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, { value: unknown }>>({});
  // Saves of this record in flight, and whether the last one finished a moment ago ("Saved").
  const [pending, setPending] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const inflight = useRef(0);
  const lastSaved = useRef(new Map<string, unknown>());
  const unsent = useRef(new Unsent());
  const currentId = useRef(recordId);
  currentId.current = recordId;

  useEffect(() => {
    setErrors({});
    setFailed({});
  }, [recordId]);

  // Everything a save needs travels in its variables: multiline text saves when the editor goes away (the
  // record is closed or navigated), which is after `recordId` has already moved on.
  const save = useMutation({
    // One save at a time per table, in the order they were made, so a slow earlier save of a text
    // being typed cannot land after a later one.
    scope: { id: `record-saves:${table.id}` },
    // A view waits for these before it decides a record just added was left untouched.
    mutationKey: ["record-save", table.id],
    mutationFn: async ({ recordId: id, field, value }: { recordId: string; field: Field; value: unknown }) => recordsApi.update(table.id, { typecast: true, records: [{ id, values: { [field.id]: toWire(field, value) as never } }] }),
    onMutate: async ({ recordId: id, field, value }) => {
      inflight.current++;
      setPending((n) => n + 1);
      setJustSaved(false);
      const key = recordKeys.record(table.id, id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TableRecord>(key);
      if (prev) {
        const values = { ...prev.values } as Record<string, unknown>;
        if (isBlank(value)) delete values[field.id];
        else values[field.id] = value;
        qc.setQueryData<TableRecord>(key, { ...prev, values: values as TableRecord["values"] });
      }
      return { prev, key };
    },
    onError: (e, { recordId: id, field, value }, ctx) => {
      if (ctx?.prev) {
        // The text the person typed stays in its editor (so it can be corrected and saved again): the
        // rolled-back value must not look like someone else's edit.
        lastSaved.current.set(`${id}:${field.id}`, ctx.prev.values[field.id] ?? null);
        qc.setQueryData(ctx.key, ctx.prev);
      }
      if (id === currentId.current) {
        setErrors((cur) => ({ ...cur, [field.id]: errorMessage(e) }));
        setFailed((cur) => ({ ...cur, [field.id]: { value } }));
      }
    },
    onSuccess: (res, { recordId: id, field }, ctx) => {
      if (id === currentId.current) {
        setErrors((cur) => {
          const { [field.id]: _gone, ...rest } = cur;
          return rest;
        });
        setFailed((cur) => {
          const { [field.id]: _gone, ...rest } = cur;
          return rest;
        });
      }
      // With another save of this table still on its way, its own answer is the newer one.
      const updated = res?.records?.[0];
      const key = ctx?.key ?? recordKeys.record(table.id, id);
      const answered = !!updated && inflight.current <= 1;
      if (updated && answered) qc.setQueryData(key, updated);
      // The collection screens refresh their pages from this invalidation (events from this tab are not echoed
      // back). The record itself is left out: a refetch of it would answer with what this save wrote while a
      // later save of the same text is on its way, which the editor takes for someone else's edit. It is
      // refetched only when its own save did not bring it up to date.
      const own = hashKey(key);
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id), predicate: (q) => q.queryHash !== own || (!updated && inflight.current <= 1) });
    },
    onSettled: (_res, _err, { recordId: id, field }) => {
      unsent.current.answered(`${id}:${field.id}`);
      inflight.current = Math.max(0, inflight.current - 1);
      setPending((n) => Math.max(0, n - 1));
      setJustSaved(true);
    },
  });

  // "Saved" fades after a few seconds.
  useEffect(() => {
    if (!justSaved || pending > 0) return;
    const t = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [justSaved, pending]);
  const state: SaveState = pending > 0 ? "saving" : Object.keys(errors).length > 0 ? "error" : justSaved ? "saved" : "idle";

  const onSave = (field: Field, edit: EditValue): { value: unknown } | undefined => {
    const textKey = `${recordId}:${field.id}`;
    const before = record?.values[field.id] ?? null;
    let after: unknown = edit.json ?? null;
    if (edit.text !== undefined) {
      const res = parseText(field, edit.text, { timeZone, users: collaborators });
      if (!res.ok) {
        setErrors((cur) => ({ ...cur, [field.id]: res.error }));
        return undefined;
      }
      if (field.type === "link") return undefined;
      after = res.value;
    }
    if (jsonEqual(before, after) || (isBlank(before) && isBlank(after))) {
      unsent.current.typed(textKey, false);
      // Back to what the record holds: nothing is left to correct.
      setFailed((cur) => {
        const { [field.id]: _gone, ...rest } = cur;
        return field.id in cur ? rest : cur;
      });
      return undefined;
    }
    lastSaved.current.set(textKey, after);
    unsent.current.send(textKey);
    save.mutate({ recordId, field, value: after });
    return { value: after };
  };

  return { errors, failed, state, lastSaved, unsent, onSave };
}
