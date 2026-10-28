import { describe, expect, it } from "vitest";
import { UndoStack, invertChanges, toPatches, type CellChange, type UndoOp } from "./undo";

describe("UndoStack with the grid's operations", () => {
  it("undoes a group as one step and keeps the move and delete kinds", async () => {
    const s = new UndoStack<UndoOp>();
    const group: UndoOp = { kind: "group", label: "Paste", ops: [{ kind: "create", label: "Add", ids: ["a"] }, { kind: "edit", label: "Edit", changes: [] }] };
    s.push(group);
    s.push({ kind: "move", label: "Move", ids: ["a"], before: { afterId: "x" }, after: { beforeId: "y" } });
    const seen: string[] = [];
    await s.undo(async (op) => void seen.push(op.kind));
    await s.undo(async (op) => void seen.push(op.kind));
    expect(seen).toEqual(["move", "group"]);
    expect(s.canUndo).toBe(false);
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
