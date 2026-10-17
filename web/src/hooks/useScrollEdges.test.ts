import { describe, expect, it } from "vitest";
import { scrollEdges } from "./useScrollEdges";

describe("scrollEdges", () => {
  it("has nothing to scroll when the content fits", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toEqual({ above: false, below: false });
  });

  it("has more below at the top, both ways in the middle, and more above at the end", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 })).toEqual({ above: false, below: true });
    expect(scrollEdges({ scrollTop: 200, scrollHeight: 900, clientHeight: 300 })).toEqual({ above: true, below: true });
    expect(scrollEdges({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 })).toEqual({ above: true, below: false });
  });

  it("treats a fraction of a pixel from an end as the end", () => {
    expect(scrollEdges({ scrollTop: 599.5, scrollHeight: 900, clientHeight: 300 })).toEqual({ above: true, below: false });
    expect(scrollEdges({ scrollTop: 0.5, scrollHeight: 900, clientHeight: 300 })).toEqual({ above: false, below: true });
  });
});
