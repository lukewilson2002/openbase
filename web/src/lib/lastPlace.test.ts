import { afterEach, describe, expect, it, vi } from "vitest";
import { lastBaseOf, lastTableOf, lastViewOf, projectPath, projectToOpen, rememberPlace } from "./lastPlace";

afterEach(() => vi.restoreAllMocks());

const place = { workspaceId: "wsp1", baseId: "app1", tableId: "tbl1", viewId: "viw1" };

describe("lastPlace", () => {
  it("remembers a view with its table and project, per level", () => {
    rememberPlace(place);
    rememberPlace({ workspaceId: "wsp1", baseId: "app1", tableId: "tbl2", viewId: "viw4" });
    rememberPlace({ workspaceId: "wsp2", baseId: "app3", tableId: "tbl9", viewId: "viw9" });
    expect(lastViewOf("tbl1")).toBe("viw1");
    expect(lastViewOf("tbl2")).toBe("viw4");
    expect(lastTableOf("app1")).toBe("tbl2");
    expect(lastBaseOf("wsp1")).toBe("app1");
    expect(lastBaseOf("wsp2")).toBe("app3");
    expect(JSON.parse(localStorage.getItem("ob-last-place")!)).toEqual({
      tables: { tbl1: "viw1", tbl2: "viw4", tbl9: "viw9" },
      projects: { app1: "tbl2", app3: "tbl9" },
      workspaces: { wsp1: "app1", wsp2: "app3" },
    });
  });

  it("knows nothing about a place it has not seen", () => {
    expect(lastViewOf("tbl1")).toBeUndefined();
    expect(lastTableOf("app1")).toBeUndefined();
    expect(lastBaseOf("wsp1")).toBeUndefined();
  });

  it("ignores stored data that is not what it wrote", () => {
    for (const bad of ["{not json", "null", "[]", '{"tables":[],"projects":7,"workspaces":{"wsp1":3}}']) {
      localStorage.setItem("ob-last-place", bad);
      expect(lastViewOf("tbl1")).toBeUndefined();
      expect(lastBaseOf("wsp1")).toBeUndefined();
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
    expect(lastBaseOf("wsp1")).toBeUndefined();
    expect(projectPath("app1")).toBe("/base/app1");
  });

  it("builds a project's address from its last table and view, as far as they are known", () => {
    expect(projectPath("app1")).toBe("/base/app1");
    rememberPlace(place);
    expect(projectPath("app1")).toBe("/base/app1/tbl1/viw1");
  });

  it("picks the project a workspace opens: the remembered one if it still exists, else the first", () => {
    const ws = { id: "wsp1", bases: [{ id: "app1" }, { id: "app2" }] } as Parameters<typeof projectToOpen>[0];
    expect(projectToOpen(ws)).toBe("app1");
    rememberPlace({ ...place, baseId: "app2" });
    expect(projectToOpen(ws)).toBe("app2");
    rememberPlace({ ...place, baseId: "appGone" });
    expect(projectToOpen(ws)).toBe("app1");
    expect(projectToOpen({ id: "wsp1", bases: [] })).toBeUndefined();
  });
});
