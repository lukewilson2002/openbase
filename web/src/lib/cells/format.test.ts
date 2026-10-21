import { describe, expect, it } from "vitest";
import type { FieldType } from "@/api/types";
import { ALL_FIELDS, CHOICES, field } from "@/test/fields";
import { chipItems, displayText, editText, formatDuration, formatGeneralNumber, formatNumber, type FormatCtx } from "./format";

const ctx: FormatCtx = { timeZone: "UTC", userName: (id) => ({ usr1: "Ada Lovelace", usr2: "Grace Hopper" })[id] };
const text = (type: FieldType, value: unknown, c: FormatCtx = ctx) => displayText(ALL_FIELDS[type], value, c);

describe("number formatting", () => {
  it("rounds half away from zero (not half to even)", () => {
    expect(formatNumber(1234.5, { kind: "fixed", precision: 0 })).toBe("1235");
    expect(formatNumber(-1234.5, { kind: "fixed", precision: 0 })).toBe("-1235");
    expect(formatNumber(2.675, { kind: "fixed", precision: 2 })).toBe("2.68");
  });
  it("never shows negative zero", () => {
    expect(formatNumber(-0.001, { kind: "fixed", precision: 1 })).toBe("0.0");
  });
  it("formats currency with grouping and symbol placement", () => {
    expect(formatNumber(1234567.891, { kind: "currency", precision: 2, symbol: "$" })).toBe("$1,234,567.89");
    expect(formatNumber(-1234.5, { kind: "currency", precision: 2, symbol: "€" })).toBe("-€1,234.50");
  });
  it("formats percent from a fraction", () => {
    expect(formatNumber(0.125, { kind: "percent", precision: 1 })).toBe("12.5%");
    expect(formatNumber(1.5, { kind: "percent", precision: 0 })).toBe("150%");
  });
  it("formats general numbers compactly", () => {
    expect(formatGeneralNumber(5)).toBe("5");
    expect(formatGeneralNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatGeneralNumber(NaN)).toBe("");
  });
  it("formats durations", () => {
    expect(formatDuration(5400, "h_mm")).toBe("1:30");
    expect(formatDuration(3661, "h_mm_ss")).toBe("1:01:01");
    expect(formatDuration(3661.5, "h_mm_ss_s")).toBe("1:01:01.5");
    expect(formatDuration(1.234, "h_mm_ss_sss")).toBe("0:00:01.234");
    expect(formatDuration(-90, "h_mm_ss")).toBe("-0:01:30");
    expect(formatDuration(-0.1, "h_mm")).toBe("0:00");
  });
});

describe("displayText for every field type", () => {
  it("text-like types", () => {
    expect(text("text", "hello")).toBe("hello");
    expect(text("rich_text", "a\nb")).toBe("a\nb");
    expect(text("email", "a@b.co")).toBe("a@b.co");
    expect(text("url", "https://x.y")).toBe("https://x.y");
    expect(text("phone", "+1 555")).toBe("+1 555");
    expect(text("barcode", "12345")).toBe("12345");
  });
  it("numeric types follow their options", () => {
    expect(text("number", 3.14159)).toBe("3.14");
    expect(text("currency", 1234.5)).toBe("$1,234.50");
    expect(text("percent", 0.256)).toBe("25.6%");
    expect(text("duration", 3661)).toBe("1:01:01");
    expect(text("rating", 3)).toBe("3");
    expect(text("autonumber", 42)).toBe("42");
    expect(text("count", 2)).toBe("2");
  });
  it("checkbox", () => {
    expect(text("checkbox", true)).toBe("checked");
    expect(text("checkbox", null)).toBe("");
  });
  it("selects show names and ignore deleted choices", () => {
    expect(text("single_select", "chs2")).toBe("In progress");
    expect(text("single_select", "gone")).toBe("");
    expect(text("multiple_select", ["chs1", "chs3"])).toBe("Todo, Done");
  });
  it("dates honour options and zones", () => {
    expect(text("date", "2026-10-12")).toBe("10/12/2026");
    expect(text("created_time", "2026-10-12T14:30:00.000Z")).toBe("2026-10-12 14:30");
    expect(text("last_modified_time", "2026-10-12T14:30:00.000Z")).toBe("10/12/2026 11:30pm");
    expect(text("date", "2026-10-12T23:00:00.000Z", { ...ctx, timeZone: "Asia/Tokyo" })).toBe("10/13/2026");
  });
  it("attachments show file names, links show primary names, users show names", () => {
    expect(text("attachment", [{ id: "att1", filename: "a.png", mime: "image/png", size: 1 }])).toBe("a.png");
    expect(text("link", [{ id: "rec1", name: "Alpha" }, { id: "rec2", name: "Beta, Inc" }])).toBe('Alpha, "Beta, Inc"');
    expect(text("user", ["usr1", "usr2"])).toBe("Ada Lovelace, Grace Hopper");
    expect(text("user", ["usrX"])).toBe("usrX");
    expect(text("created_by", "usr1")).toBe("Ada Lovelace");
    expect(text("last_modified_by", "usr2")).toBe("Grace Hopper");
  });
  it("computed fields format by result type and format", () => {
    expect(text("formula", 2.25)).toBe("2.3");
    expect(text("formula", { error: "#ERROR! div by zero" })).toBe("#ERROR! div by zero");
    expect(text("rollup", 1234.4)).toBe("€1,234");
    expect(text("lookup", ["x", "y"])).toBe("x, y");
    const dateFormula = field("formula", { expression: "TODAY()", result_type: "date", format: { kind: "date", include_time: false, date_format: "iso", time_format: "h12", timezone: null } });
    expect(displayText(dateFormula, "2026-10-12", ctx)).toBe("2026-10-12");
    const boolFormula = field("formula", { expression: "1=1", result_type: "bool" });
    expect(displayText(boolFormula, true, ctx)).toBe("true");
  });
  it("buttons show their label only when they have a URL", () => {
    expect(text("button", "https://x.y")).toBe("Open");
    expect(text("button", null)).toBe("");
  });
  it("empty values are empty text for every type", () => {
    for (const [type, f] of Object.entries(ALL_FIELDS)) {
      if (type === "checkbox") continue;
      expect(displayText(f, null, ctx), type).toBe("");
      expect(displayText(f, undefined, ctx), type).toBe("");
    }
  });
});

describe("chips and edit text", () => {
  it("carries choice colours and ids", () => {
    const people: FormatCtx = { ...ctx, userColor: (id) => ({ usr1: "teal", usr2: "orange" })[id] };
    expect(chipItems(ALL_FIELDS.user, ["usr1", "usr2"], people).map((c) => c.color)).toEqual(["teal", "orange"]);
    expect(chipItems(ALL_FIELDS.single_select, "chs3", ctx)).toEqual([{ text: "Done", color: "green", id: "chs3" }]);
    expect(chipItems(ALL_FIELDS.multiple_select, CHOICES.map((c) => c.id), ctx)).toHaveLength(3);
  });
  it("lookups of linked records keep their names", () => {
    const f = field("lookup", { link_field_id: "l", target_field_id: "t", result_type: { array: "text" } });
    expect(chipItems(f, [{ id: "rec1", name: "Alpha" }], ctx)).toEqual([{ text: "Alpha", id: "rec1" }]);
  });
  it("edit text is parseable again", () => {
    expect(editText(ALL_FIELDS.currency, 1234.5, ctx)).toBe("1234.5");
    expect(editText(ALL_FIELDS.percent, 0.125, ctx)).toBe("12.5%");
    expect(editText(ALL_FIELDS.duration, 5400, ctx)).toBe("1:30:00");
    expect(editText(ALL_FIELDS.text, "x", ctx)).toBe("x");
  });
});
