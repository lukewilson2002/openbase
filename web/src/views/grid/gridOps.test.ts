import { describe, expect, it } from "vitest";
import type { Field, TableRecord } from "@/api/types";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { ALL_FIELDS, PEOPLE, makeRecord } from "@/test/fields";
import type { GridColumnSpec } from "./adapter";
import { toColumnSpecs } from "./cellModels";
import { planClear, planFill, planPaste, selectionRectangles, type GridReader } from "./gridOps";

const fields: Field[] = [ALL_FIELDS.single_line_text, ALL_FIELDS.number, ALL_FIELDS.single_select, ALL_FIELDS.checkbox, ALL_FIELDS.formula, ALL_FIELDS.link];
const columns: GridColumnSpec[] = toColumnSpecs(fields, fields[0]!.id, {}, {});
const records: TableRecord[] = [
  makeRecord({ fld_single_line_text: "one", fld_number: 1, fld_single_select: "chs1", fld_checkbox: true }, "r1"),
  makeRecord({ fld_single_line_text: "two" }, "r2"),
  makeRecord({ fld_single_line_text: "three", fld_number: 3 }, "r3"),
];

/** Rows: [group header, r1, r2, r3] so group rows are skipped by pastes. */
function reader(opts: { grouped?: boolean; unloaded?: number[] } = {}): GridReader {
  const rows: (TableRecord | "group")[] = opts.grouped ? ["group", ...records] : records;
  return {
    columns,
    rowCount: rows.length,
    recordAt: (row) => {
      const r = rows[row];
      return r === "group" || r === undefined || opts.unloaded?.includes(row) ? undefined : r;
    },
    isRecordRow: (row) => rows[row] !== undefined && rows[row] !== "group",
  };
}

const parse = { timeZone: "UTC", users: PEOPLE };

describe("planPaste", () => {
  it("parses each cell per target field type", () => {
    const plan = planPaste(reader(), { col: 0, row: 0 }, [["alpha", "$12.50", "In progress", "yes"]], { parse });
    expect(plan.errors).toEqual([]);
    expect(plan.changes).toEqual([
      { recordId: "r1", fieldId: "fld_single_line_text", before: "one", after: "alpha" },
      { recordId: "r1", fieldId: "fld_number", before: 1, after: 12.5 },
      { recordId: "r1", fieldId: "fld_single_select", before: "chs1", after: "chs2" },
    ]);
  });

  it("clears a cell when pasting blank text and skips computed columns", () => {
    const plan = planPaste(reader(), { col: 1, row: 0 }, [["", "", "", "", "ignored"]], { parse });
    expect(plan.changes).toEqual([
      { recordId: "r1", fieldId: "fld_number", before: 1, after: null },
      { recordId: "r1", fieldId: "fld_single_select", before: "chs1", after: null },
      { recordId: "r1", fieldId: "fld_checkbox", before: true, after: null },
    ]);
  });

  it("reports values that do not fit and still plans the rest", () => {
    const plan = planPaste(reader(), { col: 0, row: 1 }, [["x", "not a number"]], { parse });
    expect(plan.errors).toEqual(['number: "not a number" is not a number']);
    expect(plan.changes).toEqual([{ recordId: "r2", fieldId: "fld_single_line_text", before: "two", after: "x" }]);
  });

  it("repeats a single value over the selected range", () => {
    const plan = planPaste(reader(), { col: 1, row: 0 }, [["7"]], { parse, selection: { x: 1, y: 0, width: 1, height: 3 } });
    expect(plan.changes.map((c) => [c.recordId, c.after])).toEqual([["r1", 7], ["r2", 7], ["r3", 7]]);
  });

  it("skips group header rows", () => {
    const plan = planPaste(reader({ grouped: true }), { col: 0, row: 0 }, [["a"], ["b"]], { parse });
    expect(plan.changes.map((c) => c.recordId)).toEqual(["r1", "r2"]);
  });

  it("collects rows beyond the last record as new records", () => {
    const plan = planPaste(reader(), { col: 0, row: 2 }, [["c"], ["d", "4"], ["e"]], { parse });
    expect(plan.changes.map((c) => c.recordId)).toEqual(["r3"]);
    expect(plan.newRecords).toEqual([{ fld_single_line_text: "d", fld_number: 4 }, { fld_single_line_text: "e" }]);
  });

  it("refuses rows that are not loaded", () => {
    const plan = planPaste(reader({ unloaded: [1] }), { col: 0, row: 1 }, [["a"]], { parse });
    expect(plan.changes).toEqual([]);
    expect(plan.errors).toHaveLength(1);
  });

  it("resolves link names through the supplied map and names them for display", () => {
    const plan = planPaste(reader(), { col: 5, row: 0 }, [["Alpha"]], { parse: { ...parse, linkIds: new Map([["alpha", "recA"]]) }, linkNames: new Map([["recA", "Alpha"]]) });
    expect(plan.changes).toEqual([{ recordId: "r1", fieldId: "fld_link", before: null, after: [{ id: "recA", name: "Alpha" }] }]);
  });
});

describe("planClear", () => {
  it("clears editable non-empty cells only", () => {
    const plan = planClear(reader(), [{ x: 0, y: 0, width: 5, height: 2 }]);
    expect(plan.changes.map((c) => `${c.recordId}:${c.fieldId}`)).toEqual(["r1:fld_single_line_text", "r1:fld_number", "r1:fld_single_select", "r1:fld_checkbox", "r2:fld_single_line_text"]);
    expect(plan.changes.every((c) => c.after === null)).toBe(true);
  });
  it("does not clear the same cell twice for overlapping rectangles", () => {
    const plan = planClear(reader(), [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 2, height: 1 }]);
    expect(plan.changes).toHaveLength(2);
  });
  it("turns row and column selections into rectangles", () => {
    const rects = selectionRectangles({ cell: null, ranges: [{ x: 0, y: 0, width: 1, height: 1 }], rows: [2], columns: [1] }, 6, 3);
    expect(rects).toEqual([{ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 2, width: 6, height: 1 }, { x: 1, y: 0, width: 1, height: 3 }]);
  });
});

describe("planFill", () => {
  it("copies the source down, repeating the pattern", () => {
    const plan = planFill(reader(), { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 1, width: 1, height: 2 }, parse, DEFAULT_CTX);
    expect(plan.changes).toEqual([
      { recordId: "r2", fieldId: "fld_single_line_text", before: "two", after: "one" },
      { recordId: "r3", fieldId: "fld_single_line_text", before: "three", after: "one" },
    ]);
  });
  it("fills across columns of different types through text parsing", () => {
    // The number 1 (shown "1.00") filled into a select is parsed as text and passed through as an option name.
    const plan = planFill(reader(), { x: 1, y: 0, width: 1, height: 1 }, { x: 2, y: 0, width: 1, height: 1 }, parse, DEFAULT_CTX);
    expect(plan.changes).toEqual([{ recordId: "r1", fieldId: "fld_single_select", before: "chs1", after: "1.00" }]);
  });
  it("skips unchanged cells", () => {
    const plan = planFill(reader(), { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }, parse, DEFAULT_CTX);
    expect(plan.changes).toEqual([]);
  });
});
