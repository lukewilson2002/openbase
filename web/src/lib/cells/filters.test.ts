import { describe, expect, it } from "vitest";
import type { Filter, FieldType } from "@/api/types";
import { ALL_FIELDS, field } from "@/test/fields";
import { dateModesFor, defaultOperand, filterOpsFor, isFilterable, isIncomplete, makeDateOperand, newCondition, opLabel, operandKindFor, pruneFilter, countConditions, withOp } from "./filters";

const ops = (t: FieldType) => filterOpsFor(ALL_FIELDS[t]);

describe("operator tables (mirror of ob_core::query::filter_ops_for)", () => {
  it("text types", () => {
    for (const t of ["text", "rich_text", "email", "url", "phone", "barcode"] as const) {
      expect(ops(t)).toEqual(["contains", "does_not_contain", "is", "is_not", "starts_with", "ends_with", "is_empty", "is_not_empty"]);
    }
  });
  it("numeric types", () => {
    for (const t of ["number", "currency", "percent", "duration", "rating", "autonumber", "count"] as const) {
      expect(ops(t)).toEqual(["is", "is_not", "lt", "lte", "gt", "gte", "is_empty", "is_not_empty"]);
    }
  });
  it("checkbox only has is", () => expect(ops("checkbox")).toEqual(["is"]));
  it("single select and single user", () => {
    expect(ops("single_select")).toEqual(["is", "is_not", "is_any_of", "is_none_of", "is_empty", "is_not_empty"]);
    expect(ops("created_by")).toEqual(ops("single_select"));
    expect(filterOpsFor(field("user", { multiple: false, notify: false }))).toEqual(ops("single_select"));
  });
  it("multi-valued types", () => {
    const multi = ["has_any_of", "has_all_of", "has_none_of", "is_exactly", "is_empty", "is_not_empty"];
    expect(ops("multiple_select")).toEqual(multi);
    expect(ops("user")).toEqual(multi);
  });
  it("dates", () => {
    for (const t of ["date", "created_time", "last_modified_time"] as const) {
      expect(ops(t)).toEqual(["is", "is_not", "is_before", "is_after", "is_on_or_before", "is_on_or_after", "is_within", "is_empty", "is_not_empty"]);
    }
  });
  it("attachments, links and computed arrays", () => {
    expect(ops("attachment")).toEqual(["contains", "does_not_contain", "is_empty", "is_not_empty"]);
    expect(ops("link")).toEqual(["contains", "does_not_contain", "has_any_of", "has_all_of", "has_none_of", "is_exactly", "is_empty", "is_not_empty"]);
    expect(ops("lookup")).toEqual(ops("link"));
  });
  it("computed fields filter by result type", () => {
    expect(ops("formula")).toEqual(ops("number")); // number result
    expect(filterOpsFor(field("formula", { expression: "", result_type: "text" }))).toEqual(ops("text"));
    expect(filterOpsFor(field("formula", { expression: "", result_type: "bool" }))).toEqual(["is"]);
    expect(filterOpsFor(field("formula", { expression: "", result_type: "date_time" }))).toEqual(ops("date"));
    expect(ops("rollup")).toEqual(ops("number"));
  });
  it("buttons are not filterable", () => {
    expect(ops("button")).toEqual([]);
    expect(isFilterable(ALL_FIELDS.button)).toBe(false);
    expect(isFilterable(ALL_FIELDS.number)).toBe(true);
  });
  it("every filterable field has at least one operator", () => {
    for (const [t, f] of Object.entries(ALL_FIELDS)) if (t !== "button") expect(filterOpsFor(f).length, t).toBeGreaterThan(0);
  });
});

describe("labels and operands", () => {
  it("numbers use = and ≠", () => {
    expect(opLabel("is", ALL_FIELDS.number)).toBe("=");
    expect(opLabel("is_not", ALL_FIELDS.number)).toBe("≠");
    expect(opLabel("is", ALL_FIELDS.text)).toBe("is");
    expect(opLabel("lte", ALL_FIELDS.number)).toBe("≤");
  });
  it("operand editors per kind", () => {
    expect(operandKindFor(ALL_FIELDS.text, "contains")).toBe("text");
    expect(operandKindFor(ALL_FIELDS.number, "gt")).toBe("number");
    expect(operandKindFor(ALL_FIELDS.checkbox, "is")).toBe("bool");
    expect(operandKindFor(ALL_FIELDS.single_select, "is")).toBe("choice_one");
    expect(operandKindFor(ALL_FIELDS.single_select, "is_any_of")).toBe("choice_many");
    expect(operandKindFor(ALL_FIELDS.created_by, "is")).toBe("user_one");
    expect(operandKindFor(ALL_FIELDS.user, "has_any_of")).toBe("user_many");
    expect(operandKindFor(ALL_FIELDS.link, "has_any_of")).toBe("record_many");
    expect(operandKindFor(ALL_FIELDS.link, "contains")).toBe("text");
    expect(operandKindFor(ALL_FIELDS.lookup, "has_any_of")).toBe("text_list");
    expect(operandKindFor(ALL_FIELDS.date, "is_before")).toBe("date");
    expect(operandKindFor(ALL_FIELDS.date, "is_empty")).toBe("none");
  });
  it("date modes depend on the operator", () => {
    expect(dateModesFor("is")).toContain("exact_date");
    expect(dateModesFor("is")).not.toContain("past_week");
    expect(dateModesFor("is_within")).toContain("past_number_of_days");
    expect(dateModesFor("is_within")).not.toContain("today");
  });
  it("builds date operands in the server's shape", () => {
    expect(makeDateOperand("today")).toEqual({ mode: "today" });
    expect(makeDateOperand("number_of_days_ago", { days: 7 })).toEqual({ mode: "number_of_days_ago", days: 7 });
    expect(makeDateOperand("exact_date", { date: "2026-10-12" })).toEqual({ mode: "exact_date", date: "2026-10-12" });
    expect(makeDateOperand("past_number_of_days", { days: -3 })).toEqual({ mode: "past_number_of_days", days: 0 });
  });
});

describe("conditions", () => {
  it("new conditions use the first operator with an empty operand", () => {
    expect(newCondition(ALL_FIELDS.text)).toEqual({ field_id: "fld_text", op: "contains", value: "" });
    expect(newCondition(ALL_FIELDS.date).value).toEqual({ mode: "today" });
    expect(newCondition(ALL_FIELDS.checkbox).value).toBe(true);
    expect(newCondition(ALL_FIELDS.multiple_select).value).toEqual([]);
  });
  it("switching operators keeps the operand only when its shape stays valid", () => {
    const c = { field_id: "x", op: "contains" as const, value: "hello" };
    expect(withOp(c, ALL_FIELDS.text, "starts_with").value).toBe("hello");
    expect(withOp({ field_id: "x", op: "is" as const, value: "chs1" }, ALL_FIELDS.single_select, "is_any_of").value).toEqual([]);
    expect(withOp({ field_id: "x", op: "is_before" as const, value: { mode: "today" } }, ALL_FIELDS.date, "is_within").value).toEqual({ mode: "past_week" });
    expect(defaultOperand(ALL_FIELDS.date, "is_empty")).toBeNull();
  });
  it("detects incomplete conditions (ignored by the server)", () => {
    const f = ALL_FIELDS.text;
    expect(isIncomplete({ field_id: f.id, op: "contains", value: "" }, f)).toBe(true);
    expect(isIncomplete({ field_id: f.id, op: "contains", value: "x" }, f)).toBe(false);
    expect(isIncomplete({ field_id: f.id, op: "is_empty", value: null }, f)).toBe(false);
    expect(isIncomplete({ field_id: ALL_FIELDS.date.id, op: "is", value: { mode: "exact_date", date: "" } }, ALL_FIELDS.date)).toBe(true);
    expect(isIncomplete({ field_id: "gone", op: "is", value: "x" }, undefined)).toBe(true);
  });
  it("prunes conditions on deleted fields and empty groups", () => {
    const filter: Filter = {
      conjunction: "and",
      items: [
        { field_id: "a", op: "is", value: 1 },
        { field_id: "gone", op: "is", value: 1 },
        { conjunction: "or", items: [{ field_id: "gone", op: "is", value: 1 }] },
        { conjunction: "or", items: [{ field_id: "b", op: "is", value: 2 }] },
      ],
    };
    const pruned = pruneFilter(filter, new Set(["a", "b"]));
    expect(countConditions(pruned)).toBe(2);
    expect(pruned.items).toHaveLength(2);
  });
});
