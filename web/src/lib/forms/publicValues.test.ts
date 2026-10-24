import { describe, expect, it } from "vitest";
import type { PublicFormField } from "@/api/types";
import { buildSubmission, controlKindOf, emptyInput, hasAnyValue, initialInput, isEmptyInput, shownFields } from "./publicValues";

const f = (id: string, type: PublicFormField["type"], options: unknown = {}, extra: Partial<PublicFormField> = {}): PublicFormField => ({ id, label: id, type, options: options as PublicFormField["options"], required: false, help: null, ...extra });
const ctx = { timeZone: "UTC" };

const status = f("status", "single_select", { choices: [{ id: "c1", name: "Todo", color: "gray" }, { id: "c2", name: "Done", color: "green" }] });
const tags = f("tags", "multiple_select", { choices: [{ id: "t1", name: "A", color: "gray" }, { id: "t2", name: "B", color: "blue" }] });

describe("which control a field gets", () => {
  it("maps types to controls", () => {
    expect(controlKindOf(f("a", "text"))).toBe("text");
    expect(controlKindOf(f("a", "text", { multiline: true }))).toBe("textarea");
    expect(controlKindOf(f("a", "currency", { precision: 2, symbol: "$", allow_negative: true }))).toBe("number");
    expect(controlKindOf(f("a", "duration", { format: "h_mm" }))).toBe("number");
    expect(controlKindOf(f("a", "phone"))).toBe("tel");
    expect(controlKindOf(f("a", "date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }))).toBe("date");
    expect(controlKindOf(f("a", "date", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }))).toBe("datetime");
    expect(controlKindOf(status)).toBe("select");
    expect(controlKindOf(tags)).toBe("multiselect");
    expect(controlKindOf(f("a", "checkbox"))).toBe("checkbox");
    expect(controlKindOf(f("a", "rating", { max: 5 }))).toBe("rating");
    expect(controlKindOf(f("a", "attachment"))).toBe("attachment");
  });

  it("starts with an empty input of the right shape", () => {
    expect(emptyInput(f("a", "text"))).toBe("");
    expect(emptyInput(f("a", "checkbox"))).toBe(false);
    expect(emptyInput(tags)).toEqual([]);
    expect(emptyInput(f("a", "rating", { max: 5 }))).toBe(0);
  });

  it("knows what is empty", () => {
    for (const v of ["", "  ", null, undefined, false, 0, []]) expect(isEmptyInput(v)).toBe(true);
    for (const v of ["x", "0", true, 3, ["a"]]) expect(isEmptyInput(v)).toBe(false);
  });
});

describe("building the submission", () => {
  it("reads text, numbers, selects, dates and checkboxes into stored values", () => {
    const fields = [
      f("name", "text"),
      f("qty", "number", { precision: 0, allow_negative: true }),
      f("price", "currency", { precision: 2, symbol: "$", allow_negative: true }),
      f("when", "date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }),
      f("at", "date", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }),
      status,
      tags,
      f("ok", "checkbox"),
      f("stars", "rating", { max: 5, icon: "star", color: "yellow" }),
    ];
    const { values, errors } = buildSubmission(
      fields,
      { name: "  Ada ", qty: "12", price: "$1,200.5", when: "2026-03-01", at: "2026-03-01T09:30", status: "c2", tags: ["t1", "t2"], ok: true, stars: 4 },
      ctx,
    );
    expect(errors).toEqual({});
    expect(values).toEqual({
      name: "Ada",
      qty: 12,
      price: 1200.5,
      when: "2026-03-01",
      at: "2026-03-01T09:30:00.000Z",
      status: "c2",
      tags: ["t1", "t2"],
      ok: true,
      stars: 4,
    });
  });

  it("interprets a time without a fixed zone in the visitor's zone", () => {
    const at = f("at", "date", { include_time: true, date_format: "iso", time_format: "h24", timezone: null });
    expect(buildSubmission([at], { at: "2026-01-15T12:00" }, { timeZone: "America/New_York" }).values["at"]).toBe("2026-01-15T17:00:00.000Z");
  });

  it("leaves empty optional fields out and keeps 0", () => {
    const { values, errors } = buildSubmission([f("a", "text"), f("n", "number", { precision: 0, allow_negative: true }), f("ok", "checkbox"), tags], { a: " ", n: "0", ok: false, tags: [] }, ctx);
    expect(errors).toEqual({});
    expect(values).toEqual({ n: 0 });
    expect(hasAnyValue(values)).toBe(true);
    expect(hasAnyValue({})).toBe(false);
  });

  it("flags required fields that are empty, unchecked or cleared", () => {
    const fields = [f("a", "text", {}, { required: true }), f("ok", "checkbox", {}, { required: true }), { ...tags, required: true }, f("n", "number", { precision: 0, allow_negative: true }, { required: true })];
    const { errors } = buildSubmission(fields, { a: "  ", ok: false, tags: [], n: "" }, ctx);
    expect(errors).toEqual({ a: "This field is required.", ok: "This box must be checked.", tags: "This field is required.", n: "This field is required." });
  });

  it("explains values a field cannot hold", () => {
    const fields = [
      f("n", "number", { precision: 0, allow_negative: false }),
      f("mail", "email"),
      f("site", "url"),
      f("tel", "phone"),
      f("stars", "rating", { max: 3 }),
      f("when", "date", { include_time: false, date_format: "iso", time_format: "h24", timezone: null }),
      status,
    ];
    const { values, errors } = buildSubmission(fields, { n: "abc", mail: "nope", site: "javascript:alert(1)", tel: "x", stars: 9, when: "garbage", status: "ghost" }, ctx);
    expect(values).toEqual({});
    expect(Object.keys(errors).sort()).toEqual(["mail", "n", "site", "stars", "status", "tel", "when"]);
    expect(errors["n"]).toMatch(/not a number/);
    expect(errors["mail"]).toMatch(/email/);
    expect(errors["stars"]).toMatch(/1 to 3/);
    expect(errors["status"]).toMatch(/options/);
  });

  it("rejects a negative number where the field forbids it", () => {
    const { errors } = buildSubmission([f("n", "number", { precision: 0, allow_negative: false })], { n: "-4" }, ctx);
    expect(errors["n"]).toMatch(/Negative/);
  });

  it("sends uploaded files as plain objects", () => {
    const file = { id: "att1", filename: "a.png", mime: "image/png", size: 10, width: 4 };
    const { values } = buildSubmission([f("files", "attachment")], { files: [file] }, ctx);
    expect(values["files"]).toEqual([{ id: "att1", filename: "a.png", mime: "image/png", size: 10, width: 4, height: null }]);
  });
});

describe("defaults", () => {
  it("starts a field with its default, and a number as the text a box holds", () => {
    expect(initialInput(f("a", "text", {}, { default: "Acme" }))).toBe("Acme");
    expect(initialInput(f("a", "number", { precision: 0, allow_negative: true }, { default: 3 }))).toBe("3");
    expect(initialInput(f("a", "text", {}, { default: null }))).toBe("");
    expect(initialInput(tags)).toEqual([]);
  });
});

describe("headings, paragraphs and show-if conditions", () => {
  const todo = { conjunction: "and" as const, items: [{ field_id: "status", op: "is" as const, value: "c1" }] };
  const form: PublicFormField[] = [
    f("name", "text", {}, { required: true }),
    f("status", "single_select", status.options),
    f("h", "text", {}, { block: "heading", label: "Details" }),
    f("why", "text", {}, { required: true, show_if: todo }),
    f("t", "text", {}, { block: "text", help: "Be brief", show_if: todo }),
  ];

  it("sends only the questions that are shown, and does not ask for a hidden required one", () => {
    expect(shownFields(form, { name: "A", status: "c2" }, ctx)).toEqual(new Set(["name", "status", "h"]));
    const hidden = buildSubmission(form, { name: "A", status: "c2", why: "ignored" }, ctx);
    expect(hidden.errors).toEqual({});
    expect(hidden.values).toEqual({ name: "A", status: "c2" });
  });

  it("asks for it once it is shown", () => {
    expect(shownFields(form, { name: "A", status: "c1" }, ctx)).toEqual(new Set(["name", "status", "h", "why", "t"]));
    expect(buildSubmission(form, { name: "A", status: "c1" }, ctx).errors).toEqual({ why: "This field is required." });
    expect(buildSubmission(form, { name: "A", status: "c1", why: "Because" }, ctx).values).toEqual({ name: "A", status: "c1", why: "Because" });
  });

  it("counts a condition on a question the form does not collect as unanswered", () => {
    const solo: PublicFormField[] = [f("x", "text", {}, { show_if: { conjunction: "and", items: [{ field_id: "gone", op: "is_empty", value: null }] } }), f("y", "text", {}, { show_if: { conjunction: "and", items: [{ field_id: "gone", op: "is_not_empty", value: null }] } })];
    expect(shownFields(solo, {}, ctx)).toEqual(new Set(["x"]));
  });
});
