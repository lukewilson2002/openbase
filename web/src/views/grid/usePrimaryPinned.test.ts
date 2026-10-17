import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { frozenColumnCount, readPrimaryPinned, usePrimaryPinned } from "./usePrimaryPinned";

afterEach(() => localStorage.clear());

describe("frozenColumnCount", () => {
  it("keeps the primary field plus the frozen columns while pinned", () => {
    expect(frozenColumnCount(true, 0, 4)).toBe(1);
    expect(frozenColumnCount(true, 2, 4)).toBe(3);
    expect(frozenColumnCount(true, 9, 4)).toBe(4);
  });

  it("freezes nothing once the primary field is unpinned", () => {
    expect(frozenColumnCount(false, 0, 4)).toBe(0);
    expect(frozenColumnCount(false, 2, 4)).toBe(0);
  });
});

describe("usePrimaryPinned", () => {
  it("is pinned by default and remembers an unpin per view on this device", () => {
    const hook = renderHook(({ id }) => usePrimaryPinned(id), { initialProps: { id: "viw1" } });
    expect(hook.result.current[0]).toBe(true);
    act(() => hook.result.current[1]());
    expect(hook.result.current[0]).toBe(false);
    expect(readPrimaryPinned("viw1")).toBe(false);
    expect(readPrimaryPinned("viw2")).toBe(true);

    hook.rerender({ id: "viw2" });
    expect(hook.result.current[0]).toBe(true);
    hook.rerender({ id: "viw1" });
    expect(hook.result.current[0]).toBe(false);

    act(() => hook.result.current[1]());
    expect(readPrimaryPinned("viw1")).toBe(true);
  });
});
