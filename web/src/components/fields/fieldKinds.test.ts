import { describe, expect, it } from "vitest";
import type { FieldType } from "@/api/types";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { FIELD_TYPES, FIELD_TYPE_GROUPS, clearedSentence, conversionRisk, conversionWarning, defaultKind, draftFromField, kindChange, needsConfirmation, toCreateField, toUpdateField, validateDraft, type FieldDraft, type KindContext } from "./fieldKinds";

const link = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_link", name: "Owner" });
const table = makeTable([field("text", { multiline: false }, { id: "fld_name", name: "Name" }), link]);
const other = makeTable([field("text", { multiline: false }, { id: "fld_p", name: "Person" })], { id: "tbl2", name: "People" });
const ctx: KindContext = { table, tables: [table, other] };

const draft = (type: FieldType, name = "New property"): FieldDraft => ({ name, description: "", kind: defaultKind(type, ctx), inverseName: "" });

describe("field types", () => {
  it("covers exactly the 28 types, each in one picker group", () => {
    expect(FIELD_TYPES).toHaveLength(28);
    expect(new Set(FIELD_TYPES).size).toBe(28);
    const grouped = FIELD_TYPE_GROUPS.flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...FIELD_TYPES].sort());
  });
});

describe("defaultKind and the CreateField payload", () => {
  it.each(FIELD_TYPES.map((t) => [t]))("%s always sends an options object", (type) => {
    const body = toCreateField(draft(type as FieldType));
    expect(body.type).toBe(type);
    expect(body.options).toBeTypeOf("object");
    expect(body.options).not.toBeNull();
    expect(body.name).toBe("New property");
  });

  it("matches the server defaults for simple types", () => {
    expect(defaultKind("text", ctx)).toEqual({ type: "text", options: { multiline: false } });
    expect(defaultKind("currency", ctx)).toEqual({ type: "currency", options: { precision: 2, symbol: "$", allow_negative: true } });
    expect(defaultKind("rating", ctx)).toEqual({ type: "rating", options: { max: 5, icon: "star", color: "yellow" } });
    expect(defaultKind("duration", ctx)).toEqual({ type: "duration", options: { format: "h_mm" } });
    expect(defaultKind("checkbox", ctx).options).toEqual({ icon: "check", color: "green" });
    expect(defaultKind("user", ctx).options).toEqual({ multiple: false, notify: false });
  });

  it("referencing types start from the first usable reference", () => {
    expect(defaultKind("link", ctx).options).toMatchObject({ linked_table_id: "tbl2" });
    expect(defaultKind("lookup", ctx).options).toMatchObject({ link_field_id: "fld_link" });
    expect(defaultKind("count", ctx).options).toEqual({ link_field_id: "fld_link" });
    expect(defaultKind("rollup", ctx).options).toMatchObject({ expression: "SUM(values)" });
    // With no other table, a link may point at its own table.
    expect(defaultKind("link", { table, tables: [table] }).options).toMatchObject({ linked_table_id: "tbl1" });
  });

  it("round-trips the options of each type into the payload", () => {
    for (const [type, f] of Object.entries(ALL_FIELDS)) {
      const d = draftFromField(f);
      const body = toCreateField({ ...d, name: "Copy" });
      expect(body.type, type).toBe(type);
      expect(body.options, type).toEqual(cleanOptions(f));
    }
  });

  it("trims names, drops empty descriptions and adds the inverse name for links", () => {
    const d = { ...draft("link"), name: "  Owner  ", inverseName: " Tasks " };
    expect(toCreateField(d)).toMatchObject({ name: "Owner", description: null, inverse_name: "Tasks" });
    expect(toCreateField({ ...draft("link"), inverseName: "" }).inverse_name).toBeNull();
    expect(toCreateField({ ...draft("number"), description: " hi " }).description).toBe("hi");
  });

  it("keeps select choices (with colours) in order and trims their names", () => {
    const d: FieldDraft = { ...draft("single_select"), kind: { type: "single_select", options: { choices: [{ id: "", name: " A ", color: "red" }, { id: "x", name: "B", color: "blue" }] } } };
    expect(toCreateField(d).options).toEqual({ choices: [{ id: "", name: "A", color: "red" }, { id: "x", name: "B", color: "blue" }] });
  });
});

function cleanOptions(f: (typeof ALL_FIELDS)[FieldType]): unknown {
  return (f as { options: unknown }).options;
}

describe("validateDraft", () => {
  it("requires a unique name", () => {
    expect(validateDraft(draft("number", ""), ctx).map((i) => i.field)).toEqual(["name"]);
    expect(validateDraft(draft("number", "name"), ctx)[0]?.message).toMatch(/already has that name/);
    expect(validateDraft(draft("number", "Name"), ctx, table.fields[0])).toEqual([]);
    expect(validateDraft(draft("number", "x".repeat(300)), ctx)).toHaveLength(1);
  });
  it("checks type-specific requirements", () => {
    const sel: FieldDraft = { ...draft("single_select"), kind: { type: "single_select", options: { choices: [{ id: "", name: "A", color: "red" }, { id: "", name: "a", color: "blue" }] } } };
    expect(validateDraft(sel, ctx)[0]?.message).toMatch(/unique/);
    expect(validateDraft({ ...draft("formula") }, ctx)[0]?.message).toMatch(/formula/i);
    expect(validateDraft({ ...draft("button") }, ctx).map((i) => i.message)).toEqual(["Enter a formula that produces the URL."]);
    expect(validateDraft({ ...draft("lookup") }, ctx)[0]?.message).toMatch(/look up/);
    expect(validateDraft({ ...draft("count"), kind: { type: "count", options: { link_field_id: "" } } }, ctx)[0]?.message).toMatch(/link property/);
    expect(validateDraft(draft("text"), ctx)).toEqual([]);
  });
});

describe("toUpdateField", () => {
  const existing = field("number", { precision: 0, allow_negative: true }, { id: "fld_n", name: "Qty" });
  it("returns null when nothing changed", () => {
    expect(toUpdateField(existing, draftFromField(existing))).toBeNull();
  });
  it("sends only the changed name or description", () => {
    expect(toUpdateField(existing, { ...draftFromField(existing), name: "Quantity" })).toEqual({ name: "Quantity" });
    expect(toUpdateField(existing, { ...draftFromField(existing), description: "How many" })).toEqual({ description: "How many" });
  });
  it("sends type and options together when they change", () => {
    const d = { ...draftFromField(existing), kind: { type: "number" as const, options: { precision: 2, allow_negative: true } } };
    expect(toUpdateField(existing, d)).toEqual({ type: "number", options: { precision: 2, allow_negative: true } });
    expect(toUpdateField(existing, { ...draftFromField(existing), kind: defaultKind("currency", ctx) })).toMatchObject({ type: "currency" });
  });
});

describe("type change warnings", () => {
  it("classifies conversions", () => {
    expect(conversionRisk("number", "number")).toBe("none");
    expect(conversionRisk("number", "text")).toBe("safe");
    expect(conversionRisk("single_select", "multiple_select")).toBe("safe");
    expect(conversionRisk("multiple_select", "single_select")).toBe("lossy");
    expect(conversionRisk("text", "number")).toBe("lossy");
    expect(conversionRisk("rich_text", "text")).toBe("lossy");
    expect(conversionRisk("number", "formula")).toBe("lossy");
    expect(conversionRisk("formula", "number")).toBe("safe");
    expect(conversionRisk("attachment", "checkbox")).toBe("lossy");
  });
  it("explains the risk", () => {
    expect(conversionWarning("number", "number")).toBeNull();
    expect(conversionWarning("text", "number")).toMatch(/cleared/);
    expect(conversionWarning("number", "formula")).toMatch(/discarded/);
    expect(conversionWarning("number", "text")).toMatch(/converted/);
  });
});

describe("what a type change clears (the server's rules)", () => {
  const qty = field("number", { precision: 0, allow_negative: true }, { id: "fld_q", name: "Qty" });
  const note = field("text", { multiline: false }, { id: "fld_t", name: "Note" });
  const linkOptions = { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false };
  const owner = field("link", linkOptions, { id: "fld_l", name: "Owner" });

  it("clears every value when a property becomes computed", () => {
    expect(kindChange(qty, defaultKind("formula", ctx))).toMatchObject({ risk: "lossy", clears: "all", linkPair: false });
    expect(kindChange(qty, defaultKind("autonumber", ctx)).clears).toBe("all");
  });

  it("clears every value when a property becomes a link, and says a matching property is added", () => {
    const change = kindChange(note, defaultKind("link", ctx));
    expect(change).toMatchObject({ risk: "lossy", clears: "all", linkPair: true });
    expect(change.warning).toMatch(/added to the linked collection/);
  });

  it("clears every link when a link property is pointed at another collection, and the old pair goes to the trash", () => {
    const elsewhere = { type: "link" as const, options: { ...linkOptions, linked_table_id: "tbl9" } };
    const change = kindChange(owner, elsewhere);
    expect(change).toMatchObject({ risk: "lossy", clears: "all", linkPair: true });
    expect(change.warning).toMatch(/moves to the trash/);
    // Editing the other options of a link keeps its pair and its values.
    expect(kindChange(owner, { type: "link", options: { ...linkOptions, single: true } })).toMatchObject({ risk: "none", clears: null, linkPair: false });
  });

  it("converts a link into text one value at a time, and the pair goes to the trash", () => {
    expect(kindChange(owner, defaultKind("text", ctx))).toMatchObject({ clears: "misfits", linkPair: true });
  });

  it("clears the values that do not fit when a type is converted", () => {
    expect(kindChange(note, defaultKind("number", ctx))).toMatchObject({ risk: "lossy", clears: "misfits" });
    expect(kindChange(qty, defaultKind("text", ctx))).toMatchObject({ risk: "safe", clears: null });
  });

  it("clears nothing for a change of look: lines joined, formatting removed", () => {
    expect(kindChange(field("text", { multiline: true }, { id: "fld_m", name: "M" }), { type: "text", options: { multiline: false } })).toMatchObject({ risk: "lossy", clears: null });
    expect(kindChange(field("rich_text", {}, { id: "fld_r", name: "R" }), defaultKind("text", ctx))).toMatchObject({ risk: "lossy", clears: null });
  });

  it("clears nothing stored when the property was computed", () => {
    expect(kindChange(ALL_FIELDS.formula, defaultKind("link", ctx)).clears).toBeNull();
    expect(kindChange(ALL_FIELDS.created_time, defaultKind("number", ctx)).clears).toBeNull();
  });

  it("says how many values go", () => {
    expect(clearedSentence("all", 12)).toBe("12 values will be cleared.");
    expect(clearedSentence("all", 1)).toBe("1 value will be cleared.");
    expect(clearedSentence("misfits", 12)).toBe("Up to 12 values may be cleared: the ones that don't fit.");
    expect(clearedSentence("all", 0)).toMatch(/nothing is cleared/);
    expect(clearedSentence("all", null)).toBe("Every value will be cleared.");
    expect(clearedSentence("misfits", null)).toBe("Values that don't fit will be cleared.");
    expect(clearedSentence(null, 5)).toBeNull();
  });

  it("asks to be confirmed unless there is nothing to take away", () => {
    const lossy = kindChange(note, defaultKind("number", ctx));
    expect(needsConfirmation(lossy, 3)).toBe(true);
    expect(needsConfirmation(lossy, null)).toBe(true);
    expect(needsConfirmation(lossy, 0)).toBe(false);
    // A link change still adds or removes a property elsewhere.
    expect(needsConfirmation(kindChange(note, defaultKind("link", ctx)), 0)).toBe(true);
    expect(needsConfirmation(kindChange(qty, defaultKind("text", ctx)), 5)).toBe(false);
    // Joining lines changes values whether or not they can be counted.
    expect(needsConfirmation(kindChange(field("text", { multiline: true }, { id: "fld_m", name: "M" }), { type: "text", options: { multiline: false } }), 0)).toBe(true);
  });
});
