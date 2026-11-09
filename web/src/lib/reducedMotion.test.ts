import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, scrollBehavior } from "./reducedMotion";

function setReduced(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
}

describe("reduced motion (A11Y-6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("glides when nothing was asked for", () => {
    setReduced(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
  });

  it("jumps when the system asks for reduced motion", () => {
    setReduced(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });
});
