/**
 * Client-side undo/redo of the grid's record operations (docs/plans §1.6: "client-side stack of
 * inverse operations; no server action log"). The stack itself is the shared `UndoStack` (a data
 * structure, with a runner supplied by the owner that performs the inverse, or the original for redo);
 * this file holds the grid's operation types and the helpers over cell changes.
 *
 * - `edit`   cell changes (single edits, pastes, fills, clears, edits made in the record panel): undo
 *            writes the old values back.
 * - `create` records added (or copied): undo soft-deletes them, redo restores the same ids.
 * - `delete` records removed: undo restores them, redo deletes them again.
 * - `move`   records dragged to another place in manual order: undo puts them back next to the
 *            neighbour they had.
 * - `field`  a field deleted: undo restores it from the trash, redo deletes it again.
 * - `group`  several of the above that happened as one step (a paste past the last row: new records and
 *            the cells filled in them).
 */
import type { Placement } from "@/lib/undo/recordOps";

export { UndoStack } from "@/lib/undo/stack";
export type { Placement };

export interface CellChange {
  recordId: string;
  fieldId: string;
  /** Wire value (JSON, `null` clears) before the change. */
  before: unknown;
  after: unknown;
}

export type UndoOp =
  | { kind: "edit"; label: string; changes: CellChange[] }
  | { kind: "create"; label: string; ids: string[] }
  | { kind: "delete"; label: string; ids: string[] }
  | { kind: "move"; label: string; ids: string[]; before: Placement; after: Placement }
  | { kind: "field"; label: string; fieldId: string }
  | { kind: "group"; label: string; ops: UndoOp[] };

export type Direction = "undo" | "redo";

/** The change set that reverses `changes` (before and after swapped). */
export function invertChanges(changes: readonly CellChange[]): CellChange[] {
  return changes.map((c) => ({ ...c, before: c.after, after: c.before }));
}

/** Group changes by record into `UpdateRecords`-style patches (`values` keyed by field id). */
export function toPatches(changes: readonly CellChange[], dir: Direction): { id: string; values: Record<string, unknown> }[] {
  const byRecord = new Map<string, Record<string, unknown>>();
  for (const c of changes) {
    const values = byRecord.get(c.recordId) ?? {};
    values[c.fieldId] = dir === "undo" ? c.before : c.after;
    byRecord.set(c.recordId, values);
  }
  return [...byRecord].map(([id, values]) => ({ id, values }));
}
