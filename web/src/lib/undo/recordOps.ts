/**
 * What the record views can undo. Edit values are in view form (links as `[{id,name}]`), the same as
 * the grid's `CellChange`, and are converted with `toWire` when they are written back.
 *
 * - `edit`   cell values changed (a calendar drop, a card's stack, a timeline resize).
 * - `move`   a record placed somewhere else in manual order; a placement names a neighbour.
 * - `create` records added: undo moves them to the trash, redo restores the same ids.
 * - `delete` records removed: undo restores them, redo deletes them again.
 * - `group`  several of the above that happened as one step (a card dropped in another stack with a position).
 */

export interface ValueChange {
  recordId: string;
  fieldId: string;
  /** View value before the change; null when the cell was empty. */
  before: unknown;
  after: unknown;
}

/** A place in manual order: right before, or right after, another record. Neither means "leave the order alone". */
export interface Placement {
  beforeId?: string;
  afterId?: string;
}

export type RecordOp =
  | { kind: "edit"; label: string; changes: ValueChange[] }
  | { kind: "move"; label: string; recordId: string; before: Placement; after: Placement }
  | { kind: "create"; label: string; ids: string[] }
  | { kind: "delete"; label: string; ids: string[] }
  | { kind: "group"; label: string; ops: RecordOp[] };

export function hasPlacement(p: Placement | null | undefined): p is Placement {
  return !!p && (!!p.beforeId || !!p.afterId);
}

/** Records an op touches, for dropping them from toasts and tests. */
export function opRecordIds(op: RecordOp): string[] {
  switch (op.kind) {
    case "edit":
      return [...new Set(op.changes.map((c) => c.recordId))];
    case "move":
      return [op.recordId];
    case "create":
    case "delete":
      return op.ids;
    case "group":
      return [...new Set(op.ops.flatMap(opRecordIds))];
  }
}
