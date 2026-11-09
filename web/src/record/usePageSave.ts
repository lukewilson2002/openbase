/**
 * Saving a record's Page (REC-5). With a Page property the text goes through the normal record save (`RecordSave`),
 * like any other value: optimistic, in order with the record's other saves, and counted in the bar's status. With none
 * (a collection whose Page was cleared, or never had one) the first save is `PUT .../records/{id}/page`, which makes
 * "Page" as part of that save (decision 2: the one schema change an editor can cause); the folder is refetched so
 * the page has its property from then on.
 */
import { useEffect, useState } from "react";
import { hashKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { keys } from "@/api/keys";
import { recordKeys, recordsApi } from "@/api/records";
import type { Field, Table } from "@/api/types";
import { SAVED_VISIBLE_MS, type RecordSave, type SaveState } from "./useRecordSave";

/** The key the text of a record's page is tracked under while its property is not known yet. */
export const pageTextKey = (recordId: string, field: Pick<Field, "id"> | undefined) => `${recordId}:${field?.id ?? "page"}`;

export interface PageSave {
  /** The table's Page property, when it has one. */
  field: Field | undefined;
  /** What saving the page through the property-less path is doing; `idle` for the normal path (the record's own status covers that). */
  state: SaveState;
  /** The message of the save that was refused, with or without a property. */
  error: string | undefined;
  /** Saves the page text; `exit` when the page is closing (the request outlives it). */
  commit(text: string, exit?: boolean): void;
}

export function usePageSave({ baseId, table, recordId, save }: { baseId: string; table: Table; recordId: string; save: RecordSave }): PageSave {
  const qc = useQueryClient();
  const field = table.body_field_id ? table.fields.find((f) => f.id === table.body_field_id && f.type === "rich_text") : undefined;
  const [justSaved, setJustSaved] = useState(false);

  const create = useMutation({
    // In order with the record's other saves of this table, and counted by the views that wait for them.
    scope: { id: `record-saves:${table.id}` },
    mutationKey: ["record-save", table.id],
    mutationFn: ({ recordId: id, text }: { recordId: string; text: string }) => recordsApi.setPage(table.id, id, text),
    onMutate: () => setJustSaved(false),
    onSuccess: (saved, { recordId: id }) => {
      // What the server holds is the text the page was last saved as (so its echo is not someone else's edit).
      const held = saved.record.values[saved.field_id] ?? null;
      for (const key of [pageTextKey(id, undefined), pageTextKey(id, { id: saved.field_id })]) save.lastSaved.current.set(key, held);
      const recordKey = recordKeys.record(table.id, id);
      qc.setQueryData(recordKey, saved.record);
      if (saved.created) void qc.invalidateQueries({ queryKey: keys.base(baseId) });
      const own = hashKey(recordKey);
      void qc.invalidateQueries({ queryKey: recordKeys.table(table.id), predicate: (q) => q.queryHash !== own });
    },
    onSettled: (_res, _err, { recordId: id }) => {
      save.unsent.current.answered(pageTextKey(id, undefined));
      setJustSaved(true);
    },
  });

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [justSaved]);

  const state: SaveState = create.isPending ? "saving" : create.isError ? "error" : justSaved ? "saved" : "idle";
  const error = field ? save.errors[field.id] : create.isError ? errorMessage(create.error) : undefined;

  return {
    field,
    state,
    error,
    commit: (text, exit) => {
      if (field) {
        save.onSave(field, { text, ...(exit && { exit }) });
        return;
      }
      if (exit) return recordsApi.setPageOnExit(table.id, recordId, text);
      save.unsent.current.send(pageTextKey(recordId, undefined));
      create.mutate({ recordId, text });
    },
  };
}
