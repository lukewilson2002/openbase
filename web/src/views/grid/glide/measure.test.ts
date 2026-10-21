import { describe, expect, it } from "vitest";
import { ALL_FIELDS } from "@/test/fields";
import type { RecordCellModel } from "../adapter";
import { measureRecordCell } from "./renderers";

// A canvas whose text is 7 px a character, so widths are easy to check.
const ctx = { font: "", measureText: (s: string) => ({ width: s.length * 7 }) } as unknown as CanvasRenderingContext2D;
const theme = { cellHorizontalPadding: 14, baseFontFull: "14px sans-serif" };
const cell = (over: Partial<RecordCellModel>): RecordCellModel => ({ kind: "cell", recordId: "r1", field: ALL_FIELDS.text!, value: "", display: "", chips: [], readOnly: false, isPrimary: false, ...over });

describe("measureRecordCell", () => {
  it("fits text with the cell's padding, and the longest line of a multi-line value", () => {
    expect(measureRecordCell(ctx, cell({ display: "November 21, 2026 11:00am" }), theme)).toBe(25 * 7 + 28);
    expect(measureRecordCell(ctx, cell({ display: "short\na much longer line" }), theme)).toBe(18 * 7 + 28);
  });

  it("keeps room for the primary field's expand icon", () => {
    expect(measureRecordCell(ctx, cell({ display: "Billing v2", isPrimary: true }), theme)).toBe(10 * 7 + 28 + 26);
  });

  it("fits every chip with its padding and the gaps between them, and a person's face", () => {
    const tags = cell({ field: ALL_FIELDS.multiple_select!, chips: [{ text: "In progress" }, { text: "Platform" }] });
    expect(measureRecordCell(ctx, tags, theme)).toBe(11 * 7 + 12 + 8 * 7 + 12 + 4 + 28);
    const person = cell({ field: ALL_FIELDS.user!, chips: [{ text: "Alan Turing" }] });
    expect(measureRecordCell(ctx, person, theme)).toBe(11 * 7 + 12 + 18 + 28);
  });

  it("fits a linked record's small card: its title in a medium-weight font, with a card's padding", () => {
    const fonts: string[] = [];
    const spy = { ...ctx, set font(f: string) { fonts.push(f); }, get font() { return fonts.at(-1) ?? ""; }, measureText: ctx.measureText } as unknown as CanvasRenderingContext2D;
    const links = cell({ field: ALL_FIELDS.link!, chips: [{ text: "Launch" }, { text: "Docs" }] });
    expect(measureRecordCell(spy, links, theme)).toBe(6 * 7 + 14 + 4 * 7 + 14 + 4 + 28);
    expect(fonts.at(-1)).toBe("500 13px sans-serif");
  });
});
