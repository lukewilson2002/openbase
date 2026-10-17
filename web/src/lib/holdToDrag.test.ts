import type { PointerEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUCH_HOLD_MS, useHoldToDrag } from "./holdToDrag";

const ev = (pointerType: string, x = 100, y = 100, pointerId = 1) => ({ pointerType, pointerId, clientX: x, clientY: y }) as unknown as PointerEvent<Element>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useHoldToDrag", () => {
  it("starts a mouse drag at once and finishes it on release", () => {
    const { result } = renderHook(() => useHoldToDrag());
    const start = vi.fn();
    result.current.press(ev("mouse"), start);
    expect(start).toHaveBeenCalledOnce();
    expect(result.current.move(ev("mouse", 140))).toBe(true);
    expect(result.current.release(ev("mouse", 140))).toBe("drag");
  });

  it("starts a touch drag only after the hold, and then stops the page scrolling", () => {
    const { result } = renderHook(() => useHoldToDrag());
    const start = vi.fn();
    result.current.press(ev("touch"), start);
    expect(start).not.toHaveBeenCalled();
    expect(result.current.move(ev("touch", 103))).toBe(false);
    act(() => vi.advanceTimersByTime(TOUCH_HOLD_MS));
    expect(start).toHaveBeenCalledOnce();
    const scroll = new TouchEvent("touchmove", { cancelable: true });
    window.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(true);
    expect(result.current.move(ev("touch", 160))).toBe(true);
    expect(result.current.release(ev("touch", 160))).toBe("drag");
    const after = new TouchEvent("touchmove", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("treats a finger that moves during the hold as a swipe: no drag, nothing on release", () => {
    const { result } = renderHook(() => useHoldToDrag());
    const start = vi.fn();
    result.current.press(ev("touch"), start);
    expect(result.current.move(ev("touch", 100, 130))).toBe(false);
    act(() => vi.advanceTimersByTime(TOUCH_HOLD_MS * 2));
    expect(start).not.toHaveBeenCalled();
    expect(result.current.release(ev("touch", 100, 160))).toBe("none");
  });

  it("calls a quick touch a tap, and a cancelled one nothing", () => {
    const { result } = renderHook(() => useHoldToDrag());
    const start = vi.fn();
    result.current.press(ev("touch"), start);
    expect(result.current.release(ev("touch"))).toBe("tap");
    result.current.press(ev("touch"), start);
    expect(result.current.release(ev("touch"), true)).toBe("none");
    act(() => vi.advanceTimersByTime(TOUCH_HOLD_MS));
    expect(start).not.toHaveBeenCalled();
  });
});
