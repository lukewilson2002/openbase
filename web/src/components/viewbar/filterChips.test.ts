import { describe, expect, it } from "vitest";
import type { Condition, Filter } from "@/api/types";
import { addCondition, advancedLabel, chipsOf, isFlat, removeCondition, replaceCondition } from "./filterChips";

const a: Condition = { field_id: "fa", op: "is", value: "x" };
const b: Condition = { field_id: "fb", op: "gt", value: 5 };
const c: Condition = { field_id: "fc", op: "is_empty", value: null };
const and = (...items: Filter["items"]): Filter => ({ conjunction: "and", items });
const or = (...items: Filter["items"]): Filter => ({ conjunction: "or", items });

describe("chipsOf", () => {
  it("has no chips without a filter, or for an empty one", () => {
    expect(chipsOf(null)).toEqual([]);
    expect(chipsOf(undefined)).toEqual([]);
    expect(chipsOf(and())).toEqual([]);
  });

  it("is one chip per condition of an AND list, in order, each knowing its place", () => {
    expect(chipsOf(and(a, b, c))).toEqual([
      { kind: "condition", index: 0, condition: a },
      { kind: "condition", index: 1, condition: b },
      { kind: "condition", index: 2, condition: c },
    ]);
  });

  it("is a single condition chip whichever way the one condition is joined", () => {
    expect(chipsOf(or(a))).toEqual([{ kind: "condition", index: 0, condition: a }]);
  });

  it("is one advanced chip for OR, counting every condition", () => {
    expect(chipsOf(or(a, b, c))).toEqual([{ kind: "advanced", count: 3 }]);
  });

  it("is one advanced chip when a group sits inside, counting the conditions in it too", () => {
    expect(chipsOf(and(a, or(b, c)))).toEqual([{ kind: "advanced", count: 3 }]);
    expect(chipsOf(and(and(a)))).toEqual([{ kind: "advanced", count: 1 }]);
  });
});

describe("isFlat", () => {
  it("is true for AND lists of conditions and false for anything else", () => {
    expect(isFlat(and(a, b))).toBe(true);
    expect(isFlat(or(a, b))).toBe(false);
    expect(isFlat(and(a, and(b)))).toBe(false);
    expect(isFlat(and())).toBe(false);
    expect(isFlat(null)).toBe(false);
  });
});

describe("advancedLabel", () => {
  it("counts conditions", () => {
    expect(advancedLabel(3)).toBe("Advanced filter, 3 conditions");
    expect(advancedLabel(1)).toBe("Advanced filter, 1 condition");
  });
});

describe("addCondition", () => {
  it("starts a filter", () => {
    expect(addCondition(null, a)).toEqual(and(a));
    expect(addCondition(undefined, a)).toEqual(and(a));
    expect(addCondition(and(), a)).toEqual(and(a));
  });

  it("adds to an AND list by AND, after the others", () => {
    expect(addCondition(and(a), b)).toEqual(and(a, b));
  });

  it("does not add what is already there", () => {
    const f = and(a, b);
    expect(addCondition(f, { ...a })).toBe(f);
  });

  it("adds the same property with another value", () => {
    expect(addCondition(and(a), { ...a, value: "y" })).toEqual(and(a, { ...a, value: "y" }));
  });

  it("keeps a group inside an AND list as it is", () => {
    const g = or(a, b);
    expect(addCondition(and(g), c)).toEqual(and(g, c));
  });

  it("makes an OR filter one side of an AND, so what it said still holds", () => {
    const f = or(a, b);
    expect(addCondition(f, c)).toEqual(and(f, c));
  });

  it("turns a lone condition joined by OR into an AND list", () => {
    expect(addCondition(or(a), b)).toEqual(and(a, b));
  });

  it("refuses a hundred and first condition", () => {
    const many = and(...Array.from({ length: 100 }, (_, i): Condition => ({ field_id: "fa", op: "is", value: `v${i}` })));
    expect(addCondition(many, b)).toBeNull();
  });

  it("does not change the filter it was given", () => {
    const f = and(a);
    addCondition(f, b);
    expect(f).toEqual(and(a));
  });
});

describe("replaceCondition and removeCondition", () => {
  it("replaces one place and leaves the rest", () => {
    expect(replaceCondition(and(a, b, c), 1, { ...b, value: 9 })).toEqual(and(a, { ...b, value: 9 }, c));
  });

  it("removes one place", () => {
    expect(removeCondition(and(a, b, c), 1)).toEqual(and(a, c));
  });

  it("leaves nothing when the last one goes", () => {
    expect(removeCondition(and(a), 0)).toBeNull();
  });

  it("keeps the way the conditions are joined", () => {
    expect(removeCondition(or(a), 0)).toBeNull();
    expect(replaceCondition(or(a), 0, b)).toEqual(or(b));
  });
});
