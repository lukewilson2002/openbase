import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRecordSelection } from "./useRecordSelection";

const IDS = ["a", "b", "c", "d", "e"];
const click = (over: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {}, ...over });
const key = (k: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, target: document.body, preventDefault: vi.fn(), ...over });

describe("useRecordSelection", () => {
  it("leaves a plain click on nothing selected to the view (it opens the record)", () => {
    const { result } = renderHook(() => useRecordSelection(IDS));
    let used = true;
    act(() => void (used = result.current.handleClick("a", click())));
    expect(used).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it("toggles with Ctrl/Cmd-click, and with a plain click once something is selected", () => {
    const { result } = renderHook(() => useRecordSelection(IDS));
    act(() => void result.current.handleClick("a", click({ metaKey: true })));
    act(() => void result.current.handleClick("c", click()));
    expect(result.current.ids).toEqual(["a", "c"]);
    act(() => void result.current.handleClick("a", click({ ctrlKey: true })));
    expect(result.current.ids).toEqual(["c"]);
  });

  it("selects a range with Shift-click from the last one clicked, in display order", () => {
    const { result } = renderHook(() => useRecordSelection(IDS));
    act(() => void result.current.handleClick("d", click({ ctrlKey: true })));
    act(() => void result.current.handleClick("b", click({ shiftKey: true })));
    expect(result.current.ids).toEqual(["b", "c", "d"]);
    act(() => void result.current.handleClick("e", click({ shiftKey: true, ctrlKey: true })));
    expect(result.current.ids).toEqual(["b", "c", "d", "e"]);
  });

  it("clears with Escape, selects all with Ctrl/Cmd+A, and deletes with Delete", () => {
    const { result } = renderHook(() => useRecordSelection(IDS));
    const onDelete = vi.fn();
    act(() => void result.current.handleKeyDown(key("a", { ctrlKey: true })));
    expect(result.current.count).toBe(5);
    act(() => void result.current.handleKeyDown(key("Delete"), { onDelete }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    act(() => void result.current.handleKeyDown(key("Escape")));
    expect(result.current.count).toBe(0);
    // Nothing selected: Delete is not ours.
    let used = true;
    act(() => void (used = result.current.handleKeyDown(key("Delete"), { onDelete })));
    expect(used).toBe(false);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("ignores keys while typing in a field", () => {
    const { result } = renderHook(() => useRecordSelection(IDS));
    const input = document.createElement("input");
    act(() => void result.current.handleKeyDown(key("a", { ctrlKey: true, target: input })));
    expect(result.current.count).toBe(0);
  });

  it("forgets records that leave the view", () => {
    const { result, rerender } = renderHook(({ ids }) => useRecordSelection(ids), { initialProps: { ids: IDS } });
    act(() => void result.current.selectAll());
    rerender({ ids: ["a", "c"] });
    expect(result.current.ids).toEqual(["a", "c"]);
  });
});
