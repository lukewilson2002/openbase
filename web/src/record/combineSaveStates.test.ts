import { describe, expect, it } from "vitest";
import { combineSaveStates } from "./useRecordSave";

describe("combineSaveStates", () => {
  it("is what is still going on, else what failed, else what was saved", () => {
    expect(combineSaveStates()).toBe("idle");
    expect(combineSaveStates("idle", "saved")).toBe("saved");
    expect(combineSaveStates("saved", "error")).toBe("error");
    expect(combineSaveStates("error", "saving", "saved")).toBe("saving");
  });
});
