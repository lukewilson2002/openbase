import { describe, expect, it } from "vitest";
import { ALL_FIELDS, field } from "@/test/fields";
import { aggregationShortLabel, aggregationsFor, formatAggregate } from "./aggregations";
import { DEFAULT_CTX } from "./format";

describe("aggregationsFor (mirror of query::aggregations_for)", () => {
  it("always starts with none", () => {
    for (const f of Object.values(ALL_FIELDS)) expect(aggregationsFor(f)[0]).toBe("none");
  });
  it("numbers get statistics", () => {
    expect(aggregationsFor(ALL_FIELDS.number)).toEqual(["none", "empty", "filled", "percent_empty", "percent_filled", "unique", "percent_unique", "sum", "average", "median", "min", "max", "range", "std_dev"]);
    expect(aggregationsFor(ALL_FIELDS.currency)).toEqual(aggregationsFor(ALL_FIELDS.number));
    expect(aggregationsFor(ALL_FIELDS.formula)).toEqual(aggregationsFor(ALL_FIELDS.number));
  });
  it("dates get date statistics", () => {
    expect(aggregationsFor(ALL_FIELDS.date)).toEqual(["none", "empty", "filled", "percent_empty", "percent_filled", "unique", "percent_unique", "earliest_date", "latest_date", "date_range_days"]);
  });
  it("checkboxes only count checked", () => {
    expect(aggregationsFor(ALL_FIELDS.checkbox)).toEqual(["none", "checked", "unchecked", "percent_checked", "percent_unchecked"]);
    expect(aggregationsFor(field("formula", { expression: "", result_type: "bool" }))).toEqual(aggregationsFor(ALL_FIELDS.checkbox));
  });
  it("attachments have no unique counts; text types have no statistics", () => {
    expect(aggregationsFor(ALL_FIELDS.attachment)).toEqual(["none", "empty", "filled", "percent_empty", "percent_filled"]);
    expect(aggregationsFor(ALL_FIELDS.text)).toEqual(["none", "empty", "filled", "percent_empty", "percent_filled", "unique", "percent_unique"]);
    expect(aggregationsFor(ALL_FIELDS.single_select)).not.toContain("sum");
  });
  it("buttons offer nothing", () => expect(aggregationsFor(ALL_FIELDS.button)).toEqual(["none"]));
});

describe("formatAggregate", () => {
  it("formats counts, percentages and field-formatted statistics", () => {
    expect(formatAggregate(ALL_FIELDS.number, "filled", 12, DEFAULT_CTX)).toBe("12");
    expect(formatAggregate(ALL_FIELDS.number, "percent_filled", 0.5, DEFAULT_CTX)).toBe("50%");
    expect(formatAggregate(ALL_FIELDS.currency, "sum", 1234.5, DEFAULT_CTX)).toBe("$1,234.50");
    expect(formatAggregate(ALL_FIELDS.duration, "sum", 3600, DEFAULT_CTX)).toBe("1:00:00");
    expect(formatAggregate(ALL_FIELDS.rating, "average", 3.456789, DEFAULT_CTX)).toBe("3.456789");
  });
  it("formats dates", () => {
    expect(formatAggregate(ALL_FIELDS.date, "earliest_date", "2026-10-12", DEFAULT_CTX)).toBe("10/12/2026");
    expect(formatAggregate(ALL_FIELDS.date, "date_range_days", 30, DEFAULT_CTX)).toBe("30 days");
  });
  it("is empty for none and null", () => {
    expect(formatAggregate(ALL_FIELDS.number, "none", 1, DEFAULT_CTX)).toBe("");
    expect(formatAggregate(ALL_FIELDS.number, "sum", null, DEFAULT_CTX)).toBe("");
  });
  it("has short labels", () => {
    expect(aggregationShortLabel("sum")).toBe("Sum");
    expect(aggregationShortLabel("percent_empty")).toBe("% empty");
  });
});
