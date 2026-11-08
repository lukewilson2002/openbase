import { afterEach, describe, expect, it } from "vitest";
import { readLastWorkspace, rememberWorkspace, workspaceToOpen } from "./lastWorkspace";

afterEach(() => localStorage.clear());

describe("workspaceToOpen", () => {
  const list = [{ id: "wsp1" }, { id: "wsp2" }, { id: "wsp3" }];

  it("is the workspace used last while the person still belongs to it", () => {
    expect(workspaceToOpen(list, "wsp3")?.id).toBe("wsp3");
  });

  it("is the first in the person's own order when none was used, or it is gone", () => {
    expect(workspaceToOpen(list, null)?.id).toBe("wsp1");
    expect(workspaceToOpen(list, "wspGone")?.id).toBe("wsp1");
  });

  it("is nothing for someone without a workspace", () => {
    expect(workspaceToOpen([], "wsp1")).toBeUndefined();
  });

  it("reads the device's last workspace by default", () => {
    rememberWorkspace("wsp2");
    expect(readLastWorkspace()).toBe("wsp2");
    expect(workspaceToOpen(list)?.id).toBe("wsp2");
    rememberWorkspace(null);
    expect(workspaceToOpen(list)?.id).toBe("wsp1");
  });
});
