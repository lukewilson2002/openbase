import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWallNow } from "./useWallNow";

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-03-12T23:59:40Z") }));
afterEach(() => vi.useRealTimers());

describe("useWallNow", () => {
  it("moves to the next day when midnight passes without anything else happening", () => {
    const { result } = renderHook(() => useWallNow("UTC"));
    expect(new Date(result.current).getUTCDate()).toBe(12);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(new Date(result.current).getUTCDate()).toBe(13);
  });

  it("catches up when the tab becomes visible again", () => {
    const { result } = renderHook(() => useWallNow("UTC"));
    vi.setSystemTime(new Date("2026-03-14T08:00:00Z"));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(new Date(result.current).getUTCDate()).toBe(14);
  });
});
