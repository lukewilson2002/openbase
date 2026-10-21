import { afterEach, describe, expect, it, vi } from "vitest";
import { SCROLL_SETTLE_MS, scrolledRecently, watchScrolling, whenScrollSettles } from "./scrollSettle";

describe("scrollSettle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls at once when nothing is scrolling, and once the scrolling stops when something is", () => {
    vi.useFakeTimers();
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    watchScrolling();
    const fn = vi.fn();
    whenScrollSettles(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // A list scrolls: cards pass under the pointer, and the preview waits.
    window.dispatchEvent(new Event("scroll"));
    expect(scrolledRecently()).toBe(true);
    const later = vi.fn();
    whenScrollSettles(later);
    now += 200;
    vi.advanceTimersByTime(200);
    // Still scrolling (a wheel keeps it going): the wait starts again from the last scroll.
    window.dispatchEvent(new Event("wheel"));
    now += SCROLL_SETTLE_MS - 1;
    vi.advanceTimersByTime(SCROLL_SETTLE_MS - 1);
    expect(later).not.toHaveBeenCalled();
    now += 1;
    vi.advanceTimersByTime(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(scrolledRecently()).toBe(false);
  });

  it("can be called off before it runs", () => {
    vi.useFakeTimers();
    let now = 50_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    watchScrolling();
    window.dispatchEvent(new Event("scroll"));
    const fn = vi.fn();
    const cancel = whenScrollSettles(fn);
    cancel();
    now += SCROLL_SETTLE_MS * 2;
    vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });
});
