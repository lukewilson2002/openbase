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
    expect(measureRecordCell(ctx, tags, theme)).toBe(11 * 7 + 16 + 8 * 7 + 16 + 4 + 28);
    const person = cell({ field: ALL_FIELDS.user!, chips: [{ text: "Alan Turing" }] });
    expect(measureRecordCell(ctx, person, theme)).toBe(11 * 7 + 12 + 18 + 28);
  });

  it("fits a linked record's chip: its title in a medium-weight 12 px font, with the chip's padding and its collection's mark", () => {
    const fonts: string[] = [];
    const spy = { ...ctx, set font(f: string) { fonts.push(f); }, get font() { return fonts.at(-1) ?? ""; }, measureText: ctx.measureText } as unknown as CanvasRenderingContext2D;
    const links = cell({ field: ALL_FIELDS.link!, chips: [{ text: "Launch" }, { text: "Docs" }] });
    expect(measureRecordCell(spy, links, theme)).toBe(6 * 7 + 14 + 4 * 7 + 14 + 4 + 28);
    expect(fonts.at(-1)).toBe("500 12px sans-serif");
    // With the colour of the linked collection each chip also holds an 8 px mark and the 6 px after it.
    const marked = cell({ field: ALL_FIELDS.link!, chips: [{ text: "Launch", color: "blue" }, { text: "Docs", color: "blue" }] });
    expect(measureRecordCell(spy, marked, theme)).toBe(6 * 7 + 28 + 4 * 7 + 28 + 4 + 28);
  });

  it("measures the primary field's text in its 600 weight", () => {
    const fonts: string[] = [];
    const spy = { ...ctx, set font(f: string) { fonts.push(f); }, get font() { return fonts.at(-1) ?? ""; }, measureText: ctx.measureText } as unknown as CanvasRenderingContext2D;
    measureRecordCell(spy, cell({ display: "Billing v2", isPrimary: true }), theme);
    expect(fonts.at(-1)).toBe("600 14px sans-serif");
  });
});
