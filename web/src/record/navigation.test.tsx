import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation, type InitialEntry } from "react-router";
import { describe, expect, it } from "vitest";
import { trailOf, useRecordNavigation } from "./navigation";

function harness(initial: InitialEntry) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  return renderHook(() => ({ nav: useRecordNavigation(), at: useLocation() }), { wrapper });
}

const target = { baseId: "app1", tableId: "tbl1", recordId: "rec1", viewId: "viw1" };
const trail = (r: { current: { at: { state: unknown } } }) => trailOf(r.current.at.state);

describe("opening a record's page", () => {
  it("remembers the collection screen it came from, one step back", () => {
    const { result } = harness("/base/app1/tbl1/viw1?x=1");
    act(() => result.current.nav.open(target));
    expect(result.current.at.pathname).toBe("/base/app1/tbl1/viw1/r/rec1");
    expect(trail(result)).toEqual({ from: "/base/app1/tbl1/viw1?x=1", steps: 1 });
  });

  it("hands over the order of the layout it was opened from, and keeps it while stepping", () => {
    const { result } = harness("/base/app1/tbl1/viw1");
    act(() => result.current.nav.open(target, { order: ["rec0", "rec1", "rec2"] }));
    expect(result.current.nav.order).toEqual(["rec0", "rec1", "rec2"]);
    // Previous and next replace the entry: the order and the way back stay as they were.
    act(() => result.current.nav.open({ ...target, recordId: "rec2" }, { replace: true }));
    expect(result.current.at.pathname).toBe("/base/app1/tbl1/viw1/r/rec2");
    expect(trail(result)).toEqual({ from: "/base/app1/tbl1/viw1", steps: 1, order: ["rec0", "rec1", "rec2"] });
  });

  it("counts a linked record as one more step back, with no order of its own", () => {
    const { result } = harness("/base/app1/tbl1/viw1");
    act(() => result.current.nav.open(target, { order: ["rec1"] }));
    act(() => result.current.nav.open({ baseId: "app1", tableId: "tbl2", recordId: "recD" }));
    expect(result.current.at.pathname).toBe("/base/app1/tbl2/r/recD");
    expect(trail(result)).toEqual({ from: "/base/app1/tbl1/viw1", steps: 2 });
  });

  it("goes back to the collection in one step however many pages were opened", () => {
    const { result } = harness("/base/app1/tbl1/viw1");
    act(() => result.current.nav.open(target));
    act(() => result.current.nav.open({ baseId: "app1", tableId: "tbl2", recordId: "recD" }));
    act(() => result.current.nav.close("/base/app1/tbl2"));
    expect(result.current.at.pathname).toBe("/base/app1/tbl1/viw1");
  });

  it("takes a link opened straight at a page to the collection the page names, replacing the page", () => {
    const { result } = harness("/base/app1/tbl1/viw1/r/rec1");
    expect(result.current.nav.origin("/base/app1/tbl1/viw1")).toBe("/base/app1/tbl1/viw1");
    act(() => result.current.nav.close("/base/app1/tbl1/viw1"));
    expect(result.current.at.pathname).toBe("/base/app1/tbl1/viw1");
  });

  it("does not claim a way back for a page whose origin is not in this history", () => {
    const { result } = harness("/base/app1/tbl1/viw1/r/rec1");
    act(() => result.current.nav.open({ baseId: "app1", tableId: "tbl2", recordId: "recD" }, { fallbackFrom: "/base/app1/tbl1/viw1" }));
    expect(trail(result)).toEqual({ from: "/base/app1/tbl1/viw1", steps: 0 });
    act(() => result.current.nav.close("/elsewhere"));
    expect(result.current.at.pathname).toBe("/base/app1/tbl1/viw1");
  });

  it("keeps only a window of a very long order", () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `r${i}`);
    const { result } = harness("/base/app1/tbl1/viw1");
    act(() => result.current.nav.open({ ...target, recordId: "r9000" }, { order: ids }));
    const order = trail(result)!.order!;
    expect(order.length).toBeLessThanOrEqual(3000);
    expect(order).toContain("r9000");
    expect(order[order.length - 1]).toBe("r9999");
  });
});
