/**
 * Delete and duplicate for the records of a card or row view (kanban, gallery, list, timeline):
 * one record is deleted at once, with a toast whose Undo brings it back; several ask first, with
 * their count. The views wire this to a card's menu, the Delete key and a selection bar, and render
 * `dialog` once (`ViewFrame` does, for the actions in `ViewSetup.actions`).
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { TableRecord } from "@/api/types";
import { deleteRecordsText } from "@/components/record/deleteText";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { RecordWrites } from "./useRecordWrites";

export interface RecordActions {
  /** The person may delete and copy records (their role is Editor or above). */
  canEdit: boolean;
  /**
   * Delete records. One goes at once (Undo is offered in a toast); several open a confirmation that
   * names the count. `onDone` runs once they are deleted (clear the selection there).
   */
  requestDelete(ids: readonly string[], onDone?: () => void): void;
  /** Copy records, each right after its original; `onDone` gets the copies. */
  duplicate(records: readonly TableRecord[], onDone?: (copies: TableRecord[]) => void): Promise<TableRecord[]>;
  /** The confirmation dialog; render it once somewhere in the view (`ViewFrame` does). */
  dialog: ReactNode;
}

export function useRecordActions({ writes, role, canEdit }: { writes: Pick<RecordWrites, "remove" | "duplicate">; role: string; canEdit: boolean }): RecordActions {
  const [pending, setPending] = useState<{ ids: readonly string[]; onDone?: () => void } | null>(null);

  const requestDelete = useCallback<RecordActions["requestDelete"]>(
    (ids, onDone) => {
      if (!canEdit || ids.length === 0) return;
      if (ids.length === 1) {
        void writes.remove(ids).then((ok) => ok && onDone?.());
        return;
      }
      setPending({ ids, onDone });
    },
    [canEdit, writes],
  );

  const duplicate = useCallback<RecordActions["duplicate"]>(
    async (records, onDone) => {
      const copies = await writes.duplicate(records);
      if (copies.length > 0) onDone?.(copies);
      return copies;
    },
    [writes],
  );

  const dialog = pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && setPending(null)}
      title={deleteRecordsText(role, pending.ids.length).title}
      description={deleteRecordsText(role, pending.ids.length).description}
      confirmLabel={`Delete ${pending.ids.length.toLocaleString()} records`}
      destructive
      onConfirm={async () => {
        const { ids, onDone } = pending;
        // A failure is already on screen as a toast.
        if (await writes.remove(ids)) onDone?.();
      }}
    />
  ) : null;

  return useMemo(() => ({ canEdit, requestDelete, duplicate, dialog }), [canEdit, requestDelete, duplicate, dialog]);
}
