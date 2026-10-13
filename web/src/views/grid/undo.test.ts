import { describe, expect, it, vi } from "vitest";
import { UndoStack, invertChanges, toPatches, type CellChange, type UndoOp } from "./undo";

const edit = (label = "e", n = 1): UndoOp => ({ kind: "edit", label, changes: Array.from({ length: n }, (_, i) => ({ recordId: `r${i}`, fieldId: "f", before: i, after: i + 1 })) });

describe("UndoStack", () => {
  it("undoes and redoes in order", async () => {
    const s = new UndoStack();
    const a = edit("a");
    const b = edit("b");
    s.push(a);
    s.push(b);
    const seen: string[] = [];
    await s.undo(async (op, dir) => void seen.push(`${dir}:${op.label}`));
    await s.undo(async (op, dir) => void seen.push(`${dir}:${op.label}`));
    expect(await s.undo(async () => {})).toBeUndefined();
    await s.redo(async (op, dir) => void seen.push(`${dir}:${op.label}`));
    expect(seen).toEqual(["undo:b", "undo:a", "redo:a"]);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(true);
  });

  it("a new operation clears the redo history", async () => {
    const s = new UndoStack();
    s.push(edit("a"));
    await s.undo(async () => {});
    expect(s.canRedo).toBe(true);
    s.push(edit("b"));
    expect(s.canRedo).toBe(false);
    expect(s.peekUndo()?.label).toBe("b");
  });

  it("keeps the entry when the inverse operation fails", async () => {
    const s = new UndoStack();
    s.push(edit("a"));
    await expect(s.undo(async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.busy).toBe(false);
  });

  it("ignores a second undo while one is running", async () => {
    const s = new UndoStack();
    s.push(edit("a"));
    s.push(edit("b"));
    let release!: () => void;
    const first = s.undo(() => new Promise<void>((r) => (release = r)));
    expect(await s.undo(async () => {})).toBeUndefined();
    release();
    await first;
    expect(s.peekRedo()?.label).toBe("b");
    expect(s.peekUndo()?.label).toBe("a");
  });

  it("limits history and drops empty edits", () => {
    const s = new UndoStack(3);
    for (let i = 0; i < 5; i++) s.push(edit(String(i)));
    s.push({ kind: "edit", label: "empty", changes: [] });
    expect(s.peekUndo()?.label).toBe("4");
    let n = 0;
    while (s.canUndo) {
      void s.undo(async () => {});
      n++;
      break;
    }
    expect(n).toBe(1);
  });

  it("clear empties both lists and notifies subscribers", async () => {
    const s = new UndoStack();
    const fn = vi.fn();
    s.subscribe(fn);
    s.push(edit());
    await s.undo(async () => {});
    s.clear();
    expect(s.canUndo || s.canRedo).toBe(false);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("supports row creates and deletes", async () => {
    const s = new UndoStack();
    s.push({ kind: "create", label: "add", ids: ["rec1"] });
    s.push({ kind: "delete", label: "del", ids: ["rec2", "rec3"] });
    const ops: UndoOp[] = [];
    await s.undo(async (op) => void ops.push(op));
    await s.undo(async (op) => void ops.push(op));
    expect(ops.map((o) => o.kind)).toEqual(["delete", "create"]);
  });
});

describe("change helpers", () => {
  const changes: CellChange[] = [
    { recordId: "r1", fieldId: "a", before: 1, after: 2 },
    { recordId: "r1", fieldId: "b", before: null, after: "x" },
    { recordId: "r2", fieldId: "a", before: "y", after: null },
  ];
  it("inverts by swapping before and after", () => {
    expect(invertChanges(changes)[0]).toEqual({ recordId: "r1", fieldId: "a", before: 2, after: 1 });
  });
  it("groups changes per record in the requested direction", () => {
    expect(toPatches(changes, "redo")).toEqual([
      { id: "r1", values: { a: 2, b: "x" } },
      { id: "r2", values: { a: null } },
    ]);
    expect(toPatches(changes, "undo")).toEqual([
      { id: "r1", values: { a: 1, b: null } },
      { id: "r2", values: { a: "y" } },
    ]);
  });
});
