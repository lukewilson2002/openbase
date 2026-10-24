/**
 * A client-side undo/redo stack (docs/plans §1.6: "client-side stack of inverse operations; no server
 * action log"), generic over its operations so any view can use it. It holds data only: the owner
 * supplies a runner that performs an operation's inverse (or the operation again, for redo).
 *
 * `views/grid/undo.ts` is the same structure fixed to the grid's own operations; the grid can move
 * onto this one by giving its operation type to `UndoStack<UndoOp>`.
 */

export const DEFAULT_UNDO_LIMIT = 100;

export class UndoStack<Op> {
  private undoItems: Op[] = [];
  private redoItems: Op[] = [];
  private running = false;
  private listeners = new Set<() => void>();
  private rev = 0;

  constructor(private readonly limit: number = DEFAULT_UNDO_LIMIT) {}

  /** Changes whenever the stack does (for `useSyncExternalStore`). */
  get revision(): number {
    return this.rev;
  }

  get canUndo(): boolean {
    return this.undoItems.length > 0;
  }

  get canRedo(): boolean {
    return this.redoItems.length > 0;
  }

  /** An undo or redo is running. */
  get busy(): boolean {
    return this.running;
  }

  peekUndo(): Op | undefined {
    return this.undoItems[this.undoItems.length - 1];
  }

  peekRedo(): Op | undefined {
    return this.redoItems[this.redoItems.length - 1];
  }

  /** Record a freshly performed operation; this invalidates the redo history. */
  push(op: Op): void {
    this.undoItems.push(op);
    if (this.undoItems.length > this.limit) this.undoItems.shift();
    this.redoItems = [];
    this.notify();
  }

  /** Forget an operation without running it (a created record that was discarded again). */
  drop(op: Op): void {
    const i = this.undoItems.lastIndexOf(op);
    if (i < 0) return;
    this.undoItems.splice(i, 1);
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
  async undo(perform: (op: Op) => Promise<void>): Promise<Op | undefined> {
    return this.step(this.undoItems, this.redoItems, perform);
  }

  async redo(perform: (op: Op) => Promise<void>): Promise<Op | undefined> {
    return this.step(this.redoItems, this.undoItems, perform);
  }

  /**
   * Undo one particular operation, not the newest (the Undo of a toast, after other work was done).
   * Returns undefined when it is no longer on the stack (already undone, or dropped).
   */
  async undoOp(op: Op, perform: (op: Op) => Promise<void>): Promise<Op | undefined> {
    if (this.running) return undefined;
    const i = this.undoItems.lastIndexOf(op);
    if (i < 0) return undefined;
    this.running = true;
    try {
      await perform(op);
      this.undoItems.splice(this.undoItems.lastIndexOf(op), 1);
      this.redoItems.push(op);
    } finally {
      this.running = false;
      this.notify();
    }
    return op;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async step(from: Op[], to: Op[], perform: (op: Op) => Promise<void>): Promise<Op | undefined> {
    if (this.running) return undefined;
    const op = from[from.length - 1];
    if (op === undefined) return undefined;
    this.running = true;
    try {
      await perform(op);
      from.pop();
      to.push(op);
    } finally {
      this.running = false;
      this.notify();
    }
    return op;
  }

  private notify(): void {
    this.rev++;
    for (const fn of this.listeners) fn();
  }
}
