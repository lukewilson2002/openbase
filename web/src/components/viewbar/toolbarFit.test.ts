import { describe, expect, it } from "vitest";
import { visibleToolCount } from "./toolbarFit";

const base = { tools: [60, 50, 60, 90], fixed: 0, more: 64, moreAlways: true, gap: 2 };

describe("visibleToolCount", () => {
  it("shows every tool when there is room for them and More", () => {
    // 260 for the tools, 64 for More, 4 gaps of 2.
    expect(visibleToolCount({ ...base, available: 332 })).toBe(4);
  });

  it("moves tools into More from the right end first as the row narrows", () => {
    expect(visibleToolCount({ ...base, available: 331 })).toBe(3);
    expect(visibleToolCount({ ...base, available: 240 })).toBe(3);
    expect(visibleToolCount({ ...base, available: 180 })).toBe(2);
    expect(visibleToolCount({ ...base, available: 126 })).toBe(1);
    expect(visibleToolCount({ ...base, available: 125 })).toBe(0);
  });

  it("counts More only when it would show", () => {
    // Without items of its own, More appears only once a tool has moved into it.
    expect(visibleToolCount({ ...base, moreAlways: false, available: 266 })).toBe(4);
    expect(visibleToolCount({ ...base, moreAlways: false, available: 265 })).toBe(3);
  });

  it("leaves room for what always shows", () => {
    expect(visibleToolCount({ ...base, fixed: 100, available: 434 })).toBe(4);
    expect(visibleToolCount({ ...base, fixed: 100, available: 433 })).toBe(3);
  });

  it("shows everything before the row has been laid out", () => {
    expect(visibleToolCount({ ...base, available: 0 })).toBe(4);
  });
});
