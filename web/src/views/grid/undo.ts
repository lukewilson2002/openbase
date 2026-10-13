/**
 * Client-side undo/redo of record operations (docs/plans §1.6: "client-side stack of inverse
 * operations; no server action log"). Pure data structure: the grid supplies a runner that
 * performs the inverse (or the original, for redo) against the API.
 *
 * - `edit`   cell changes (single edits, pastes, fills, clears): undo writes the old values back.
 * - `create` records added: undo soft-deletes them, redo restores the same ids.
 * - `delete` records removed: undo restores them, redo deletes them again.
 */

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
  | { kind: "delete"; label: string; ids: string[] };

export type Direction = "undo" | "redo";

export const DEFAULT_UNDO_LIMIT = 100;

export class UndoStack {
  private undoItems: UndoOp[] = [];
  private redoItems: UndoOp[] = [];
  private running = false;
  private listeners = new Set<() => void>();

  constructor(private readonly limit: number = DEFAULT_UNDO_LIMIT) {}

  get canUndo(): boolean {
    return this.undoItems.length > 0;
  }

  get canRedo(): boolean {
    return this.redoItems.length > 0;
  }

  get busy(): boolean {
    return this.running;
  }

  peekUndo(): UndoOp | undefined {
    return this.undoItems[this.undoItems.length - 1];
  }

  peekRedo(): UndoOp | undefined {
    return this.redoItems[this.redoItems.length - 1];
  }

  /** Record a freshly performed operation; this invalidates the redo history. */
  push(op: UndoOp): void {
    if (op.kind === "edit" && op.changes.length === 0) return;
    this.undoItems.push(op);
    if (this.undoItems.length > this.limit) this.undoItems.shift();
    this.redoItems = [];
    this.notify();
  }

  clear(): void {
    this.undoItems = [];
    this.redoItems = [];
    this.notify();
  }

  /**
   * Run `perform` for the newest undoable operation. The operation moves to the redo list only
   * when `perform` succeeds; on failure the stack is unchanged and the error propagates.
   * Returns the operation, or undefined when there was nothing to do (or another run is active).
   */
  async undo(perform: (op: UndoOp, dir: "undo") => Promise<void>): Promise<UndoOp | undefined> {
    return this.step(this.undoItems, (op) => {
      this.redoItems.push(op);
    }, (op) => perform(op, "undo"));
  }

  async redo(perform: (op: UndoOp, dir: "redo") => Promise<void>): Promise<UndoOp | undefined> {
    return this.step(this.redoItems, (op) => {
      this.undoItems.push(op);
    }, (op) => perform(op, "redo"));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async step(from: UndoOp[], moveTo: (op: UndoOp) => void, perform: (op: UndoOp) => Promise<void>): Promise<UndoOp | undefined> {
    if (this.running) return undefined;
    const op = from[from.length - 1];
    if (!op) return undefined;
    this.running = true;
    try {
      await perform(op);
      from.pop();
      moveTo(op);
    } finally {
      this.running = false;
      this.notify();
    }
    return op;
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

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
