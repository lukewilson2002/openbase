import { describe, expect, it } from "vitest";
import { ALL_FIELDS } from "@/test/fields";
import { isEmptyValue, toView, toWire, writableValues } from "./wire";

describe("wire conversion", () => {
  it("links are written as id arrays", () => {
    expect(toWire(ALL_FIELDS.link, [{ id: "rec1", name: "A" }, { id: "rec2", name: "B" }])).toEqual(["rec1", "rec2"]);
    expect(toWire(ALL_FIELDS.link, [])).toBeNull();
  });
  it("other values pass through and empties clear", () => {
    expect(toWire(ALL_FIELDS.number, 5)).toBe(5);
    expect(toWire(ALL_FIELDS.single_line_text, "")).toBeNull();
    expect(toWire(ALL_FIELDS.checkbox, false)).toBeNull();
    expect(toWire(ALL_FIELDS.checkbox, true)).toBe(true);
    expect(toWire(ALL_FIELDS.number, 0)).toBe(0);
    expect(toWire(ALL_FIELDS.user, ["usr1"])).toEqual(["usr1"]);
  });
  it("view values name linked records when names are known", () => {
    expect(toView(ALL_FIELDS.link, ["rec1"], new Map([["rec1", "Alpha"]]))).toEqual([{ id: "rec1", name: "Alpha" }]);
    expect(toView(ALL_FIELDS.number, 3)).toBe(3);
    expect(toView(ALL_FIELDS.number, null)).toBeNull();
  });
  it("copies only writable values when duplicating", () => {
    const vals = { fld_single_line_text: "x", fld_link: [{ id: "rec1", name: "A" }], fld_formula: 4, fld_checkbox: true, fld_number: 0 };
    expect(writableValues(Object.values(ALL_FIELDS), vals)).toEqual({ fld_single_line_text: "x", fld_link: ["rec1"], fld_checkbox: true, fld_number: 0 });
  });
  it("knows what is empty", () => {
    for (const v of [null, undefined, "", false, []]) expect(isEmptyValue(v)).toBe(true);
    for (const v of [0, "0", true, [1]]) expect(isEmptyValue(v)).toBe(false);
  });
});
