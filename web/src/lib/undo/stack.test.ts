import { describe, expect, it, vi } from "vitest";
import { UndoStack } from "./stack";

describe("UndoStack", () => {
  it("undoes the newest operation, then redoes it, and a new push forgets the redo history", async () => {
    const s = new UndoStack<string>();
    s.push("a");
    s.push("b");
    const seen: string[] = [];
    expect(await s.undo(async (op) => void seen.push(`undo ${op}`))).toBe("b");
    expect(s.peekRedo()).toBe("b");
    expect(await s.redo(async (op) => void seen.push(`redo ${op}`))).toBe("b");
    expect(seen).toEqual(["undo b", "redo b"]);
    await s.undo(async () => {});
    s.push("c");
    expect(s.canRedo).toBe(false);
    expect(s.peekUndo()).toBe("c");
  });

  it("keeps the operation where it is when the runner fails", async () => {
    const s = new UndoStack<string>();
    s.push("a");
    await expect(
      s.undo(async () => {
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.busy).toBe(false);
  });

  it("does not start a second run while one is active", async () => {
    const s = new UndoStack<string>();
    s.push("a");
    s.push("b");
    let release!: () => void;
    const first = s.undo(() => new Promise<void>((r) => (release = r)));
    expect(await s.undo(async () => {})).toBeUndefined();
    release();
    await first;
    expect(s.peekUndo()).toBe("a");
  });

  it("undoes one particular operation and drops others without running them", async () => {
    const s = new UndoStack<string>();
    s.push("a");
    s.push("b");
    s.push("c");
    const run = vi.fn(async () => {});
    expect(await s.undoOp("b", run)).toBe("b");
    expect(run).toHaveBeenCalledWith("b");
    expect(await s.undoOp("b", run)).toBeUndefined();
    s.drop("c");
    expect(s.peekUndo()).toBe("a");
    expect(s.peekRedo()).toBe("b");
  });

  it("caps its history and tells listeners about each change", () => {
    const s = new UndoStack<number>(2);
    const fn = vi.fn();
    s.subscribe(fn);
    s.push(1);
    s.push(2);
    s.push(3);
    expect(s.peekUndo()).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
    const rev = s.revision;
    s.clear();
    expect(s.canUndo).toBe(false);
    expect(s.revision).toBeGreaterThan(rev);
  });
});
