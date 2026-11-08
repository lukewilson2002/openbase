/**
 * Records added a moment ago that have not been typed into (COL-8, REC-8). A record added from a collection
 * opens as its page, and leaving it with nothing entered takes it back as if it had never been added: no trash,
 * no history. The screen that added it is gone by then, so what it was created with is kept here, by record id,
 * until the page has been left. A record that was reached some other way is never in here, so it is never taken back.
 */
import type { QueryClient } from "@tanstack/react-query";
import { recordsApi } from "@/api/records";
import type { Table } from "@/api/types";
import { writableValues } from "@/lib/cells/wire";
import { discardIfUntouched } from "@/views/grid/freshRows";

const made = new Map<string, Record<string, unknown>>();

/** `values` is what the record held when it was made, which the view's filter may have filled in; computed values do not count. */
export function rememberNewRecord(recordId: string, values: Record<string, unknown>): void {
  made.set(recordId, values);
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
  const values = made.get(recordId);
  if (!values) return false;
  made.delete(recordId);
  const gone = await discardIfUntouched(
    recordId,
    { values: writableValues(table.fields, values), op: null },
    {
      fields: table.fields,
      touched: () => false,
      saving: () => qc.isMutating({ mutationKey: ["record-save", table.id] }),
      load: (id) => recordsApi.get(table.id, id),
      discard: (id) => recordsApi.discard(table.id, id),
      sleep,
    },
  );
  if (gone) void qc.invalidateQueries({ queryKey: ["records", table.id] });
  return gone;
}
