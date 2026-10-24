import { describe, expect, it } from "vitest";
import type { Condition, Filter, FilterOp } from "@/api/types";
import { ALL_FIELDS, CHOICES, field } from "@/test/fields";
import { canTestInShowIf, restrictShowIf, showIfFieldIds, showIfHolds, shownEntries } from "./showIf";

const kind = field("single_select", { choices: CHOICES }, { id: "f_kind", name: "Kind" });
const tags = field("multiple_select", { choices: CHOICES }, { id: "f_tags", name: "Tags" });
const title = field("text", { multiline: false }, { id: "f_title", name: "Title" });
const qty = field("number", { precision: 0, allow_negative: true }, { id: "f_qty", name: "Qty" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "f_done", name: "Done" });
const fields = [kind, tags, title, qty, done];
const byId = (id: string) => fields.find((f) => f.id === id);

const one = (field_id: string, op: FilterOp, value: unknown = null): Filter => ({ conjunction: "and", items: [{ field_id, op, value } as Condition] });
const holds = (f: Filter, answers: Record<string, unknown>, unknown: "skip" | "unanswered" = "skip") => showIfHolds(f, byId, answers, unknown);

describe("which questions a show-if can read", () => {
  it("accepts text, number, rating, checkbox and select questions only", () => {
    const ok = Object.values(ALL_FIELDS).filter(canTestInShowIf).map((f) => f.type);
    expect(ok.sort()).toEqual(["checkbox", "currency", "email", "multiple_select", "number", "percent", "phone", "rating", "rich_text", "single_select", "text", "url"]);
  });
});

describe("evaluating a show-if like a view filter", () => {
  it("shows an entry without a condition, and one whose conditions are all empty", () => {
    expect(showIfHolds(null, byId, {}, "skip")).toBe(true);
    expect(holds({ conjunction: "and", items: [] }, {})).toBe(true);
    // An empty operand is ignored by the server, so the entry stays shown.
    expect(holds(one("f_kind", "is", ""), {})).toBe(true);
    expect(holds(one("f_title", "contains", ""), {})).toBe(true);
    expect(holds(one("f_qty", "gt", ""), {})).toBe(true);
    expect(holds(one("f_tags", "has_any_of", []), {})).toBe(true);
  });

  it("tests a single select by choice id", () => {
    const [a, b] = CHOICES;
    expect(holds(one("f_kind", "is", a!.id), { f_kind: a!.id })).toBe(true);
    expect(holds(one("f_kind", "is", a!.id), { f_kind: b!.id })).toBe(false);
    expect(holds(one("f_kind", "is", a!.id), {})).toBe(false);
    expect(holds(one("f_kind", "is_not", a!.id), {})).toBe(true);
    expect(holds(one("f_kind", "is_any_of", [a!.id, b!.id]), { f_kind: b!.id })).toBe(true);
    expect(holds(one("f_kind", "is_none_of", [a!.id]), { f_kind: b!.id })).toBe(true);
    expect(holds(one("f_kind", "is_empty"), {})).toBe(true);
    expect(holds(one("f_kind", "is_not_empty"), { f_kind: a!.id })).toBe(true);
  });

  it("tests a multiple select", () => {
    const [a, b] = CHOICES;
    expect(holds(one("f_tags", "has_any_of", [a!.id]), { f_tags: [a!.id, b!.id] })).toBe(true);
    expect(holds(one("f_tags", "has_all_of", [a!.id, b!.id]), { f_tags: [a!.id] })).toBe(false);
    expect(holds(one("f_tags", "has_none_of", [a!.id]), {})).toBe(true);
    expect(holds(one("f_tags", "is_exactly", [a!.id]), { f_tags: [a!.id] })).toBe(true);
    expect(holds(one("f_tags", "is_exactly", [a!.id]), { f_tags: [a!.id, b!.id] })).toBe(false);
  });

  it("tests text without regard to case, except for is and is not", () => {
    expect(holds(one("f_title", "contains", "BUG"), { f_title: "Found a bug" })).toBe(true);
    expect(holds(one("f_title", "starts_with", "found"), { f_title: "Found a bug" })).toBe(true);
    expect(holds(one("f_title", "ends_with", "BUG"), { f_title: "Found a bug" })).toBe(true);
    expect(holds(one("f_title", "is", "found a bug"), { f_title: "Found a bug" })).toBe(false);
    expect(holds(one("f_title", "is_not", "x"), {})).toBe(true);
    expect(holds(one("f_title", "does_not_contain", "x"), {})).toBe(true);
    expect(holds(one("f_title", "contains", "x"), {})).toBe(false);
  });

  it("compares numbers, and an unanswered number only meets is not", () => {
    expect(holds(one("f_qty", "gt", 3), { f_qty: 4 })).toBe(true);
    expect(holds(one("f_qty", "gt", 3), { f_qty: 3 })).toBe(false);
    expect(holds(one("f_qty", "gte", "3"), { f_qty: 3 })).toBe(true);
    expect(holds(one("f_qty", "lt", 3), { f_qty: 2 })).toBe(true);
    expect(holds(one("f_qty", "lte", 3), { f_qty: 3 })).toBe(true);
    expect(holds(one("f_qty", "is", 3), { f_qty: 3 })).toBe(true);
    expect(holds(one("f_qty", "gt", 3), {})).toBe(false);
    expect(holds(one("f_qty", "is_not", 3), {})).toBe(true);
  });

  it("tests a checkbox", () => {
    expect(holds(one("f_done", "is", true), { f_done: true })).toBe(true);
    expect(holds(one("f_done", "is", true), {})).toBe(false);
    expect(holds(one("f_done", "is", false), {})).toBe(true);
    expect(holds(one("f_done", "is_empty"), {})).toBe(true);
  });

  it("combines conditions and groups with and / or, dropping the ones that are ignored", () => {
    const [a, b] = CHOICES;
    const both: Filter = { conjunction: "and", items: [{ field_id: "f_kind", op: "is", value: a!.id }, { field_id: "f_qty", op: "gt", value: 1 }] };
    expect(holds(both, { f_kind: a!.id, f_qty: 2 })).toBe(true);
    expect(holds(both, { f_kind: a!.id, f_qty: 1 })).toBe(false);
    const either: Filter = { conjunction: "or", items: [{ field_id: "f_kind", op: "is", value: a!.id }, { field_id: "f_kind", op: "is", value: b!.id }] };
    expect(holds(either, { f_kind: b!.id })).toBe(true);
    expect(holds(either, {})).toBe(false);
    const nested: Filter = { conjunction: "and", items: [{ field_id: "f_qty", op: "gt", value: 1 }, either] };
    expect(holds(nested, { f_kind: b!.id, f_qty: 2 })).toBe(true);
    expect(holds(nested, { f_kind: b!.id })).toBe(false);
    // A half-filled condition does not block the other.
    const half: Filter = { conjunction: "and", items: [{ field_id: "f_kind", op: "is", value: "" }, { field_id: "f_qty", op: "gt", value: 1 }] };
    expect(holds(half, { f_qty: 2 })).toBe(true);
    expect(holds(half, {})).toBe(false);
  });

  it("treats a field that is gone as met, and one the form does not collect as unanswered", () => {
    expect(holds(one("f_gone", "is", "x"), {}, "skip")).toBe(true);
    expect(holds(one("f_gone", "is", "x"), {}, "unanswered")).toBe(false);
    expect(holds(one("f_gone", "is_not", "x"), {}, "unanswered")).toBe(true);
    expect(holds(one("f_gone", "is_empty"), {}, "unanswered")).toBe(true);
    expect(holds(one("f_gone", "is_not_empty"), {}, "unanswered")).toBe(false);
  });
});

describe("working out what is shown, going down the form", () => {
  const [a] = CHOICES;
  const entries = [
    { id: "f_kind", showIf: null, answer: () => undefined as unknown },
    { id: "f_qty", showIf: one("f_kind", "is", a!.id), answer: () => 5 as unknown },
    { id: "f_title", showIf: one("f_qty", "gt", 3), answer: () => "x" as unknown },
    { id: "head", showIf: one("f_kind", "is", a!.id) },
  ];

  it("hides what a hidden question's answer would have shown", () => {
    // Kind is unanswered: Qty and the heading are hidden, so Title cannot see Qty's 5.
    expect([...shownEntries(entries, byId, "skip")]).toEqual(["f_kind"]);
    entries[0]!.answer = () => a!.id;
    expect([...shownEntries(entries, byId, "skip")]).toEqual(["f_kind", "f_qty", "f_title", "head"]);
  });
});

describe("the fields a show-if reads", () => {
  it("lists them, and can cut a show-if down to the allowed ones", () => {
    const f: Filter = { conjunction: "or", items: [{ field_id: "a", op: "is_empty", value: null }, { conjunction: "and", items: [{ field_id: "b", op: "is_empty", value: null }] }] };
    expect(showIfFieldIds(f)).toEqual(["a", "b"]);
    expect(restrictShowIf(f, new Set(["b"]))).toEqual({ conjunction: "or", items: [{ conjunction: "and", items: [{ field_id: "b", op: "is_empty", value: null }] }] });
    expect(restrictShowIf(f, new Set())).toBeNull();
    expect(restrictShowIf(null, new Set(["a"]))).toBeNull();
  });
});
