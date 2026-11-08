import { describe, expect, it } from "vitest";
import { legacyRecordTarget, recordPath } from "./recordPath";

describe("recordPath", () => {
  it("has the view only when it is known", () => {
    expect(recordPath("app1", "tbl1", "rec1")).toBe("/base/app1/tbl1/r/rec1");
    expect(recordPath("app1", "tbl1", "rec1", "viw1")).toBe("/base/app1/tbl1/viw1/r/rec1");
    expect(recordPath("app1", "tbl1", "rec1", null)).toBe("/base/app1/tbl1/r/rec1");
  });

  it("encodes what is not safe in an address", () => {
    expect(recordPath("a b", "t/1", "r?1")).toBe("/base/a%20b/t%2F1/r/r%3F1");
  });
});

describe("legacyRecordTarget", () => {
  it("sends ?record= to the page, keeping the view", () => {
    expect(legacyRecordTarget("app1", "tbl1", "viw1", "?record=rec1")).toBe("/base/app1/tbl1/viw1/r/rec1");
    expect(legacyRecordTarget("app1", "tbl1", undefined, "?record=rec1")).toBe("/base/app1/tbl1/r/rec1");
  });

  it("sends a ?linked= trail to its last step, which is the record that was on screen", () => {
    expect(legacyRecordTarget("app1", "tbl1", "viw1", "?record=rec1&linked=tbl2.rec2,tbl3.rec3")).toBe("/base/app1/tbl3/r/rec3");
  });

  it("ignores a trail with no record, and addresses without either", () => {
    expect(legacyRecordTarget("app1", "tbl1", "viw1", "?linked=tbl2.rec2")).toBeNull();
    expect(legacyRecordTarget("app1", "tbl1", "viw1", "")).toBeNull();
    expect(legacyRecordTarget("app1", "tbl1", "viw1", "?record=rec1&linked=junk")).toBe("/base/app1/tbl1/viw1/r/rec1");
  });
});
