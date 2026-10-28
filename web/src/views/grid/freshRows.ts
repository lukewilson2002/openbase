/**
 * Records the grid has just added (the Add button, an add row, Insert above or below) and the
 * person never touched. When they click off, such a record is taken back without a trace: it was
 * only ever a place-holder, and people often add more rows than they use.
 */
import type { Field, TableRecord } from "@/api/types";
import { jsonEqual } from "@/lib/cells/parse";
import { writableValues } from "@/lib/cells/wire";
import type { UndoOp } from "./undo";

/** What a record added by the grid held when it was made (the values its view filled in count), and the undo step that made it. */
export interface Fresh {
  values: Record<string, unknown>;
  op: UndoOp | null;
}

export interface FreshDeps {
  fields: readonly Field[];
  /** A change was made to the record (a cell edit, a paste, the record panel), even one that put the old value back. */
  touched(recordId: string): boolean;
  /** Cell saves still on their way. */
  saving(): number;
  /** The record as the server has it now. */
  load(recordId: string): Promise<TableRecord | undefined>;
  discard(recordId: string): Promise<{ discarded: boolean }>;
  sleep(ms: number): Promise<void>;
}

/** Whether a record still holds what it was created with, in the fields that can be written. */
export function isUntouched(fields: readonly Field[], made: Fresh, record: Pick<TableRecord, "values">): boolean {
  return jsonEqual(writableValues(fields, record.values as Record<string, unknown>), made.values);
}

/** The most the saves still on their way are waited for. */
const SAVE_WAIT_MS = 4000;
const SAVE_POLL_MS = 40;

/**
 * Take a record added by the grid back if nothing was ever put into it. Resolves true when the
 * server discarded it; false when it stays (touched, changed, already gone, or the server said no).
 */
export async function discardIfUntouched(recordId: string, made: Fresh, deps: FreshDeps): Promise<boolean> {
  // A last edit from the click that moved away is only just being handed over: let it land first.
  await deps.sleep(0);
  for (let waited = 0; deps.saving() > 0 && waited < SAVE_WAIT_MS; waited += SAVE_POLL_MS) await deps.sleep(SAVE_POLL_MS);
  if (deps.touched(recordId)) return false;
  try {
    const now = await deps.load(recordId);
    if (!now || !isUntouched(deps.fields, made, now)) return false;
    return (await deps.discard(recordId)).discarded;
  } catch {
    // Not there, or not removable: it stays.
    return false;
  }
}
