import { afterEach, describe, expect, it, vi } from "vitest";
import { lastTableOf, lastViewOf, rememberPlace } from "./lastPlace";

afterEach(() => vi.restoreAllMocks());

const place = { baseId: "app1", tableId: "tbl1", viewId: "viw1" };

describe("lastPlace", () => {
  it("remembers a view with its table in its folder", () => {
    rememberPlace(place);
    rememberPlace({ baseId: "app1", tableId: "tbl2", viewId: "viw4" });
    rememberPlace({ baseId: "app3", tableId: "tbl9", viewId: "viw9" });
    expect(lastViewOf("tbl1")).toBe("viw1");
    expect(lastViewOf("tbl2")).toBe("viw4");
    expect(lastTableOf("app1")).toBe("tbl2");
    expect(JSON.parse(localStorage.getItem("ob-last-place")!)).toEqual({
      tables: { tbl1: "viw1", tbl2: "viw4", tbl9: "viw9" },
      projects: { app1: "tbl2", app3: "tbl9" },
    });
  });

  it("knows nothing about a place it has not seen", () => {
    expect(lastViewOf("tbl1")).toBeUndefined();
    expect(lastTableOf("app1")).toBeUndefined();
  });

  it("ignores stored data that is not what it wrote", () => {
    for (const bad of ["{not json", "null", "[]", '{"tables":[],"projects":7}']) {
      localStorage.setItem("ob-last-place", bad);
      expect(lastViewOf("tbl1")).toBeUndefined();
      expect(lastTableOf("app1")).toBeUndefined();
    }
    // And writes over it.
    rememberPlace(place);
    expect(lastViewOf("tbl1")).toBe("viw1");
  });

  it("survives storage that throws, on reads and on writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => rememberPlace(place)).not.toThrow();
    expect(lastViewOf("tbl1")).toBeUndefined();
    expect(lastTableOf("app1")).toBeUndefined();
  });
});
