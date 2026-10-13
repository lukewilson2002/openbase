import { describe, expect, it } from "vitest";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { cellValueOf, createCellModelFactory, defaultWidth, toColumnSpecs } from "./cellModels";

const fields = [ALL_FIELDS.single_line_text, ALL_FIELDS.single_select, ALL_FIELDS.formula, ALL_FIELDS.created_time, ALL_FIELDS.autonumber, ALL_FIELDS.created_by];
const columns = toColumnSpecs(fields, "fld_single_line_text", { fld_single_select: 300 }, { fld_formula: 99 });
const rec = makeRecord({ fld_single_line_text: "Hello", fld_single_select: "chs3", fld_formula: 5 });

describe("toColumnSpecs", () => {
  it("applies saved widths, live overrides and defaults; computed columns are read-only", () => {
    expect(columns.map((c) => c.width)).toEqual([defaultWidth(fields[0]!), 300, 99, defaultWidth(fields[3]!), defaultWidth(fields[4]!), defaultWidth(fields[5]!)]);
    expect(columns.map((c) => c.readOnly)).toEqual([false, false, true, true, true, true]);
    expect(columns[0]!.isPrimary).toBe(true);
    expect(columns[1]!.isPrimary).toBe(false);
  });
});

describe("cellValueOf", () => {
  it("falls back to record columns for system fields the server did not send", () => {
    expect(cellValueOf(rec, ALL_FIELDS.created_time)).toBe(new Date(rec.created_at).toISOString());
    expect(cellValueOf(rec, ALL_FIELDS.autonumber)).toBe(1);
    expect(cellValueOf(rec, ALL_FIELDS.created_by)).toBe("usr1");
    expect(cellValueOf(rec, ALL_FIELDS.number)).toBeNull();
    expect(cellValueOf(rec, ALL_FIELDS.single_line_text)).toBe("Hello");
  });
});

describe("createCellModelFactory", () => {
  const factory = createCellModelFactory(columns, DEFAULT_CTX, true);

  it("builds models with display text, chips and permissions", () => {
    const m = factory.forRecord(rec, 1, undefined);
    expect(m).toMatchObject({ kind: "cell", recordId: "rec1", display: "Done", readOnly: false, isPrimary: false });
    if (m.kind === "cell") expect(m.chips).toEqual([{ text: "Done", color: "green", id: "chs3" }]);
    expect(factory.forRecord(rec, 2, undefined)).toMatchObject({ readOnly: true, display: "5.0" });
  });

  it("returns the same object for repeated lookups (no per-frame allocation)", () => {
    const a = factory.forRecord(rec, 0, "red");
    expect(factory.forRecord(rec, 0, "red")).toBe(a);
    expect(factory.summary(1, "Sum", "3")).toBe(factory.summary(1, "Sum", "3"));
    expect(factory.group(0, 0, "Todo", 3, false)).toBe(factory.group(0, 0, "Todo", 3, false));
  });

  it("puts the row colour on the primary column only and refreshes when it changes", () => {
    const withColor = factory.forRecord(rec, 0, "red");
    expect(withColor).toMatchObject({ rowColor: "red" });
    expect(factory.forRecord(rec, 1, "red")).toMatchObject({ rowColor: undefined });
    expect(factory.forRecord(rec, 0, "blue")).toMatchObject({ rowColor: "blue" });
  });

  it("new record objects (after an edit or refetch) get fresh models", () => {
    const edited = { ...rec, values: { ...rec.values, fld_single_line_text: "Bye" } };
    expect(factory.forRecord(edited, 0, undefined)).toMatchObject({ display: "Bye" });
    expect(factory.forRecord(rec, 0, undefined)).toMatchObject({ display: "Hello" });
  });

  it("is read-only everywhere without edit permission", () => {
    const viewer = createCellModelFactory(columns, DEFAULT_CTX, false);
    expect(viewer.forRecord(rec, 0, undefined)).toMatchObject({ readOnly: true });
    expect(viewer.forRecord(rec, 1, undefined)).toMatchObject({ readOnly: true });
  });
});
