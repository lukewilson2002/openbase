/**
 * Records added a moment ago that have not been typed into (COL-8, REC-8). A record added from a collection
 * opens as its page, and leaving it with nothing entered takes it back as if it had never been added: no trash,
 * no history. The screen that added it is gone by then, so what it was created with is kept here, by record id,
 * until the page has been left. A record that was reached some other way is never in here, so it is never taken back.
 */
import type { QueryClient } from "@tanstack/react-query";
import { recordKeys, recordsApi } from "@/api/records";
import type { Table, TableRecord } from "@/api/types";
import { writableValues } from "@/lib/cells/wire";
import { discardIfUntouched, isUntouched } from "@/views/grid/freshRows";

const made = new Map<string, { values: Record<string, unknown>; dropStep?: () => void }>();

/**
 * `values` is what the record held when it was made, which the view's filter may have filled in; computed values
 * do not count. `dropStep` takes the add out of the undo history, for when the record is taken back: Ctrl+Z
 * would otherwise restore a record that was never there.
 */
export function rememberNewRecord(recordId: string, values: Record<string, unknown>, dropStep?: () => void): void {
  made.set(recordId, { values, dropStep });
}

/** Whether the record was just added (its title starts being edited). */
export function isNewRecord(recordId: string): boolean {
  return made.has(recordId);
}

/** The record is gone (deleted, or its add undone): looking for it again would only answer 404. */
export function forgetNewRecord(recordId: string): void {
  made.delete(recordId);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Takes the record back if it was just added and nothing was put into it, once the saves still on their way
 * have landed. Resolves true when the server discarded it.
 */
export async function discardNewRecord(qc: QueryClient, table: Table, recordId: string): Promise<boolean> {
  const entry = made.get(recordId);
  if (!entry) return false;
  made.delete(recordId);
  const gone = await discardIfUntouched(
    recordId,
    { values: writableValues(table.fields, entry.values), op: null },
    {
      fields: table.fields,
      touched: () => false,
      saving: () => qc.isMutating({ mutationKey: ["record-save", table.id] }),
      load: (id) => recordsApi.get(table.id, id),
      discard: (id) => recordsApi.discard(table.id, id),
      sleep,
    },
  );
  if (gone) {
    entry.dropStep?.();
    void qc.invalidateQueries({ queryKey: ["records", table.id] });
  }
  return gone;
}

/** Whether an editable thing on the page holds text that has not been committed (a title or a comment being typed). */
function typingSomething(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim() !== "";
  return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? "").trim() !== "";
}

/**
 * The page is closing (a tab, a window): takes the record back at once if it was just added and is still empty.
 * Nothing can be waited for here, so it goes by what the page holds right now: no save on its way, no text typed
 * and not yet committed, and the record as loaded is what it was made as. The server checks again (it refuses a
 * record that was touched), so a wrong guess leaves a record, never takes one. Answers whether it asked.
 */
export function discardNewRecordOnExit(qc: QueryClient, table: Table, recordId: string, unsent: boolean): boolean {
  const entry = made.get(recordId);
  if (!entry || unsent || typingSomething()) return false;
  if (qc.isMutating({ mutationKey: ["record-save", table.id] }) > 0) return false;
  const loaded = qc.getQueryData<TableRecord>(recordKeys.record(table.id, recordId));
  if (!loaded || !isUntouched(table.fields, { values: writableValues(table.fields, entry.values), op: null }, loaded)) return false;
  made.delete(recordId);
  recordsApi.discardOnExit(table.id, recordId);
  return true;
}
