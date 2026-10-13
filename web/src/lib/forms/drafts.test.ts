import { describe, expect, it } from "vitest";
import { ALL_FIELDS, CHOICES, field } from "@/test/fields";
import { resolveForm } from "./drafts";

const ctx = { timeZone: "UTC", users: [{ id: "usr1", name: "Ada Lovelace", email: "ada@example.com" }] };
const text = field("single_line_text", {}, { id: "f_text", name: "Name" });
const qty = field("number", { precision: 0, allow_negative: false }, { id: "f_qty", name: "Qty" });
const status = field("single_select", { choices: CHOICES }, { id: "f_status", name: "Status" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "f_done", name: "Done" });
const link = { ...ALL_FIELDS.link!, id: "f_link", name: "Parent" };
const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });

describe("resolving what was typed into a form", () => {
  it("parses typed text and passes picked JSON through, in wire form", () => {
    const { values, errors } = resolveForm(
      [text, qty, status, done, link, owner].map((f) => ({ field: f, required: false })),
      {
        f_text: { text: "Hello" },
        f_qty: { text: "12" },
        f_status: { json: "chs2" },
        f_done: { json: true },
        f_link: { json: [{ id: "rec9", name: "Parent record" }] },
        f_owner: { json: ["usr1"] },
      },
      ctx,
    );
    expect(errors).toEqual({});
    expect(values).toEqual({ f_text: "Hello", f_qty: 12, f_status: "chs2", f_done: true, f_link: ["rec9"], f_owner: ["usr1"] });
  });

  it("leaves untouched, cleared and false fields out", () => {
    const { values, errors } = resolveForm(
      [text, qty, done].map((f) => ({ field: f, required: false })),
      { f_text: { text: "  " }, f_done: { json: null } },
      ctx,
    );
    expect(values).toEqual({});
    expect(errors).toEqual({});
  });

  it("reports text a field cannot hold", () => {
    const { values, errors } = resolveForm([{ field: qty, required: false }], { f_qty: { text: "abc" } }, ctx);
    expect(values).toEqual({});
    expect(errors["f_qty"]).toMatch(/not a number/);
    expect(resolveForm([{ field: qty, required: false }], { f_qty: { text: "-3" } }, ctx).errors["f_qty"]).toMatch(/Negative/);
  });

  it("requires what the form marks as required", () => {
    const { errors } = resolveForm(
      [
        { field: text, required: true },
        { field: done, required: true },
        { field: link, required: true },
        { field: qty, required: false },
      ],
      { f_link: { json: [] } },
      ctx,
    );
    expect(errors).toEqual({ f_text: "This field is required.", f_done: "This box must be checked.", f_link: "This field is required." });
  });

  it("ignores text typed for a link field", () => {
    const { values } = resolveForm([{ field: link, required: false }], { f_link: { text: "Some name" } }, ctx);
    expect(values).toEqual({});
  });
});
