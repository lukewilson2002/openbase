import { act, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { folderOf, forgetUndoHistories, undoStackIn, useForgetUndoOutsideFolder } from "./registry";

let go: ReturnType<typeof useNavigate>;
function Watch() {
  go = useNavigate();
  useForgetUndoOutsideFolder();
  return null;
}

describe("undo histories kept for a folder", () => {
  it("are the same history for every screen that asks, and separate by folder and by name", () => {
    const a = undoStackIn("app1", "grid:viw1");
    expect(undoStackIn("app1", "grid:viw1")).toBe(a);
    expect(undoStackIn("app1", "grid:viw2")).not.toBe(a);
    expect(undoStackIn("app2", "grid:viw1")).not.toBe(a);
  });

  it("know which folder an address belongs to", () => {
    expect(folderOf("/base/app1/tbl1/viw1")).toBe("app1");
    expect(folderOf("/base/app1/tbl1/viw1/r/rec1")).toBe("app1");
    expect(folderOf("/workspace/wsp1")).toBeNull();
    expect(folderOf("/")).toBeNull();
  });

  it("stay through a record's page and go when the person leaves the folder", () => {
    const stack = undoStackIn("app1", "grid:viw1");
    stack.push({ kind: "x" });
    render(
      <MemoryRouter initialEntries={["/base/app1/tbl1/viw1"]}>
        <Watch />
      </MemoryRouter>,
    );
    act(() => void go("/base/app1/tbl1/viw1/r/rec1"));
    act(() => void go("/base/app1/tbl2/r/rec9"));
    expect(undoStackIn("app1", "grid:viw1").canUndo).toBe(true);
    act(() => void go("/workspace/wsp1"));
    expect(undoStackIn("app1", "grid:viw1")).not.toBe(stack);
    expect(undoStackIn("app1", "grid:viw1").canUndo).toBe(false);
    forgetUndoHistories();
  });
});
