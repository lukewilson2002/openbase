import { describe, expect, it } from "vitest";
import { ALL_FIELDS, makeRecord, makeTable } from "@/test/fields";
import { DEFAULT_CTX } from "@/lib/cells/format";
import { cardFields, cardTitle, coverUrl, descriptionText, fieldsToShow, hasCardValue, isDescriptionField } from "./cardFields";

const f = ALL_FIELDS;
const table = makeTable([f.single_line_text!, f.number!, f.checkbox!, f.attachment!, f.button!, f.single_select!]);

describe("card fields", () => {
  it("lists visible non-title fields in view order and skips buttons and excluded fields", () => {
    const ids = cardFields(table, { field_order: [], hidden_fields: [f.number!.id] }, new Set([f.attachment!.id])).map((x) => x.id);
    expect(ids).toEqual([f.checkbox!.id, f.single_select!.id]);
  });

  it("skips empty values and caps the number shown", () => {
    const rec = makeRecord({ [f.number!.id]: 4, [f.checkbox!.id]: false, [f.single_select!.id]: "chs1" });
    const shown = fieldsToShow(cardFields(table, { field_order: [], hidden_fields: [] }), rec, DEFAULT_CTX).map((x) => x.id);
    expect(shown).toEqual([f.number!.id, f.single_select!.id]);
    expect(fieldsToShow(cardFields(table, { field_order: [], hidden_fields: [] }), rec, DEFAULT_CTX, 1)).toHaveLength(1);
  });

  it("treats checked boxes, ratings and attachments as values only when set", () => {
    expect(hasCardValue(f.checkbox!, true, DEFAULT_CTX)).toBe(true);
    expect(hasCardValue(f.checkbox!, false, DEFAULT_CTX)).toBe(false);
    expect(hasCardValue(f.rating!, 0, DEFAULT_CTX)).toBe(false);
    expect(hasCardValue(f.attachment!, [], DEFAULT_CTX)).toBe(false);
  });

  it("takes text-like fields as descriptions and flattens them to one line of plain text", () => {
    const yes = (["single_line_text", "long_text", "lookup"] as const).map((t) => isDescriptionField(f[t]!));
    expect(yes).toEqual([true, true, true]);
    expect([f.number!, f.formula!, f.single_select!, f.url!, f.attachment!].some(isDescriptionField)).toBe(false);
    expect(isDescriptionField({ ...f.formula!, options: { ...(f.formula!.options as object), result_type: "text" } } as typeof f.formula)).toBe(true);
    expect(descriptionText(f.single_line_text, " a \n\n b ", DEFAULT_CTX)).toBe("a b");
    expect(descriptionText(f.long_text, "# Head\n\n*soft* &amp; `code`", DEFAULT_CTX)).toBe("Head soft & code");
    expect(descriptionText(f.long_text, null, DEFAULT_CTX)).toBe("");
    expect(descriptionText(undefined, "x", DEFAULT_CTX)).toBe("");
  });

  it("builds a cover from the first image attachment and titles from the primary field", () => {
    const files = [
      { id: "att1", filename: "a.pdf", mime: "application/pdf", size: 1 },
      { id: "att2", filename: "b.png", mime: "image/png", size: 1 },
    ];
    expect(coverUrl(f.attachment!, makeRecord({ [f.attachment!.id]: files }))).toBe("/api/attachments/att2/thumb");
    expect(coverUrl(f.attachment!, makeRecord({}))).toBeNull();
    expect(coverUrl(undefined, makeRecord({}))).toBeNull();
    expect(cardTitle(f.single_line_text, makeRecord({ [f.single_line_text!.id]: " Hello " }), DEFAULT_CTX)).toBe("Hello");
    expect(cardTitle(f.single_line_text, makeRecord({}), DEFAULT_CTX)).toBe("Untitled");
  });
});
