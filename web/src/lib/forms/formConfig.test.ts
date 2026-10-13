import { describe, expect, it } from "vitest";
import type { FormConfig } from "@/api/types";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import {
  addAllFormFields,
  addFormField,
  addableFields,
  canBeInForm,
  cleanForm,
  liveEntries,
  moveFormField,
  moveFormFieldById,
  pruneForm,
  publicStatus,
  redirectUrlProblem,
  removeFormField,
  sameForm,
  summarizeForm,
  updateFormField,
  updateFormSettings,
} from "./formConfig";

const name = field("single_line_text", {}, { id: "f_name", name: "Name" });
const notes = field("long_text", { rich: false }, { id: "f_notes", name: "Notes" });
const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
const parent = field("link", { linked_table_id: "tbl1", inverse_field_id: "f_kids", single: true }, { id: "f_parent", name: "Parent" });
const total = field("formula", { expression: "1", result_type: "number" }, { id: "f_total", name: "Total" });
const table = makeTable([name, notes, owner, parent, total]);

const empty: FormConfig = { title: "", description: "", fields: [], submit_label: "", success_message: "", redirect_url: null, show_submit_another: false };
const entry = (id: string, extra: Partial<FormConfig["fields"][number]> = {}) => ({ field_id: id, required: false, label: null, help: null, ...extra });
const ids = (f: FormConfig) => f.fields.map((x) => x.field_id);

describe("which fields a form may hold", () => {
  it("rejects every computed type and accepts the rest", () => {
    const computed = Object.values(ALL_FIELDS).filter((f) => !canBeInForm(f)).map((f) => f.type);
    expect(computed.sort()).toEqual(["autonumber", "button", "count", "created_by", "created_time", "formula", "last_modified_by", "last_modified_time", "lookup", "rollup"]);
    expect(canBeInForm(ALL_FIELDS.attachment!)).toBe(true);
  });

  it("offers only editable fields that are not in the form yet, in table order", () => {
    const form = { ...empty, fields: [entry("f_notes")] };
    expect(addableFields(form, table).map((f) => f.id)).toEqual(["f_name", "f_owner", "f_parent"]);
  });
});

describe("editing the field list", () => {
  it("adds a field once with the defaults, never a computed or unknown one", () => {
    const one = addFormField(empty, table, "f_name");
    expect(one.fields).toEqual([{ field_id: "f_name", required: false, label: null, help: null }]);
    expect(addFormField(one, table, "f_name")).toBe(one);
    expect(addFormField(one, table, "f_total")).toBe(one);
    expect(addFormField(one, table, "nope")).toBe(one);
  });

  it("adds everything that is left", () => {
    const form = addAllFormFields({ ...empty, fields: [entry("f_notes")] }, table);
    expect(ids(form)).toEqual(["f_notes", "f_name", "f_owner", "f_parent"]);
  });

  it("removes a field and leaves the others in order", () => {
    const form = { ...empty, fields: [entry("a"), entry("b"), entry("c")] };
    expect(ids(removeFormField(form, "b"))).toEqual(["a", "c"]);
    expect(removeFormField(form, "zz")).toBe(form);
  });

  it("moves a field by index and by id, ignoring impossible moves", () => {
    const form = { ...empty, fields: [entry("a"), entry("b"), entry("c")] };
    expect(ids(moveFormField(form, 0, 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveFormField(form, 2, 0))).toEqual(["c", "a", "b"]);
    expect(moveFormField(form, 1, 1)).toBe(form);
    expect(moveFormField(form, 0, 9)).toBe(form);
    expect(ids(moveFormFieldById(form, "c", "a"))).toEqual(["c", "a", "b"]);
    expect(moveFormFieldById(form, "c", "missing")).toBe(form);
  });

  it("patches one entry: label, help and required", () => {
    const form = { ...empty, fields: [entry("a"), entry("b")] };
    const next = updateFormField(form, "b", { required: true, label: "Your name", help: "As on your ID" });
    expect(next.fields[1]).toEqual({ field_id: "b", required: true, label: "Your name", help: "As on your ID" });
    expect(next.fields[0]).toBe(form.fields[0]);
    expect(updateFormField(form, "zz", { required: true })).toBe(form);
  });

  it("changes the settings without touching the fields", () => {
    const form = { ...empty, fields: [entry("a")] };
    const next = updateFormSettings(form, { title: "Contact us", show_submit_another: true });
    expect(next).toMatchObject({ title: "Contact us", show_submit_another: true });
    expect(next.fields).toBe(form.fields);
  });

  it("drops entries of deleted fields when listing what is live", () => {
    const form = { ...empty, fields: [entry("f_name"), entry("gone"), entry("f_name"), entry("f_notes")] };
    expect(liveEntries(form, table).map((e) => e.field.id)).toEqual(["f_name", "f_notes"]);
  });
});

describe("the public form policy", () => {
  it("leaves out link and user fields, and fields the form view hides", () => {
    expect(publicStatus(name, [])).toEqual({ public: true });
    expect(publicStatus(parent, [])).toMatchObject({ public: false, reason: "link" });
    expect(publicStatus(owner, [])).toMatchObject({ public: false, reason: "user" });
    expect(publicStatus(name, ["f_name"])).toMatchObject({ public: false, reason: "hidden" });
  });

  it("summarises how many fields visitors get and which are excluded", () => {
    const form = { ...empty, fields: [entry("f_name"), entry("f_owner"), entry("f_parent"), entry("f_notes")] };
    const s = summarizeForm(form, table, { hidden_fields: ["f_notes"] });
    expect(s.total).toBe(4);
    expect(s.publicCount).toBe(1);
    expect(s.excluded.map((e) => [e.field.id, e.status.reason])).toEqual([
      ["f_owner", "user"],
      ["f_parent", "link"],
      ["f_notes", "hidden"],
    ]);
    expect(s.publicEmpty).toBe(false);
    expect(summarizeForm({ ...empty, fields: [entry("f_owner")] }, table, { hidden_fields: [] }).publicEmpty).toBe(true);
  });
});

describe("the redirect address", () => {
  it("accepts nothing, http and https", () => {
    expect(redirectUrlProblem("")).toBeNull();
    expect(redirectUrlProblem("  ")).toBeNull();
    expect(redirectUrlProblem("https://example.com/thanks?x=1")).toBeNull();
    expect(redirectUrlProblem("http://localhost:3000")).toBeNull();
  });

  it("rejects other schemes, bare words and over-long addresses", () => {
    expect(redirectUrlProblem("javascript:alert(1)")).toMatch(/http/);
    expect(redirectUrlProblem("ftp://example.com")).toMatch(/http/);
    expect(redirectUrlProblem("data:text/html,hi")).toMatch(/http/);
    expect(redirectUrlProblem("example.com")).toMatch(/full address/);
    expect(redirectUrlProblem(`https://example.com/${"a".repeat(2100)}`)).toMatch(/2048/);
  });
});

describe("saving", () => {
  it("prunes entries of deleted and computed fields", () => {
    const form = { ...empty, fields: [entry("f_name"), entry("gone"), entry("f_total"), entry("f_notes")] };
    expect(ids(pruneForm(form, table))).toEqual(["f_name", "f_notes"]);
    const clean = { ...empty, fields: [entry("f_name")] };
    expect(pruneForm(clean, table)).toBe(clean);
  });

  it("turns cleared labels and an empty redirect into null", () => {
    const form: FormConfig = { ...empty, redirect_url: "  ", fields: [entry("a", { label: "  ", help: "" }), entry("b", { label: "Kept", help: "Hint", required: true })] };
    expect(cleanForm(form)).toEqual({ ...empty, redirect_url: null, fields: [entry("a"), entry("b", { label: "Kept", help: "Hint", required: true })] });
  });

  it("compares forms by what would be saved", () => {
    const a: FormConfig = { ...empty, fields: [entry("a")] };
    expect(sameForm(a, { ...empty, redirect_url: "", fields: [entry("a", { label: "" })] })).toBe(true);
    expect(sameForm(a, { ...empty, fields: [entry("a", { required: true })] })).toBe(false);
  });
});
