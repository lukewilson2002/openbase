import { describe, expect, it } from "vitest";
import type { Filter } from "@/api/types";
import { F, TABLE_FIELDS } from "./viewTestUtils";
import { filterPrefill, prefillFor } from "./prefill";

const and = (...items: Filter["items"]): Filter => ({ conjunction: "and", items });
const is = (field_id: string, value: unknown, op: "is" | "is_any_of" | "has_any_of" | "has_all_of" | "is_not" = "is") => ({ field_id, op, value: value as never });

describe("filterPrefill", () => {
  it("starts a record with the value of a select it is filtered to", () => {
    expect(filterPrefill(TABLE_FIELDS, and(is("f_status", "s3")))).toEqual({ f_status: "s3" });
    expect(filterPrefill(TABLE_FIELDS, and(is("f_status", ["s2"], "is_any_of")))).toEqual({ f_status: "s2" });
  });

  it("reads text and numbers, and a person (the viewer for 'me')", () => {
    expect(filterPrefill(TABLE_FIELDS, and(is("f_name", "Task"), is(F.effort.id, 3)))).toEqual({ f_name: "Task", [F.effort.id]: 3 });
    expect(filterPrefill(TABLE_FIELDS, and(is("f_owner", "me")), "usr1")).toEqual({ f_owner: ["usr1"] });
    expect(filterPrefill(TABLE_FIELDS, and(is("f_owner", "me")))).toEqual({});
  });

  it("goes into nested 'and' groups", () => {
    expect(filterPrefill(TABLE_FIELDS, and(is("f_name", "A"), and(is("f_status", "s1"))))).toEqual({ f_name: "A", f_status: "s1" });
  });

  it("leaves out what one value cannot satisfy", () => {
    expect(filterPrefill(TABLE_FIELDS, and(is("f_status", "s3", "is_not")))).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, and(is("f_status", ["s1", "s2"], "is_any_of")))).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, { conjunction: "or", items: [is("f_status", "s1"), is("f_name", "x")] })).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, and(is("f_status", "s1"), is("f_status", "s2")))).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, and(is("f_start", "2024-01-01")))).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, and(is("gone", "x")))).toEqual({});
  });

  it("takes the one condition of an 'or'", () => {
    expect(filterPrefill(TABLE_FIELDS, { conjunction: "or", items: [is("f_status", "s1")] })).toEqual({ f_status: "s1" });
  });

  it("is empty without a filter", () => {
    expect(filterPrefill(TABLE_FIELDS, null)).toEqual({});
    expect(filterPrefill(TABLE_FIELDS, and())).toEqual({});
  });
});

describe("prefillFor", () => {
  it("lets the group's value win over the filter's, and skips blank groups", () => {
    const filter = and(is("f_status", "s1"), is("f_name", "A"));
    expect(prefillFor(TABLE_FIELDS, filter, { f_status: "s2" })).toEqual({ f_status: "s2", f_name: "A" });
    expect(prefillFor(TABLE_FIELDS, filter, { f_status: null })).toEqual({ f_status: "s1", f_name: "A" });
  });
});
