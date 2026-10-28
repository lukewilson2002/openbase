import { describe, expect, it } from "vitest";
import type { FormConfig } from "@/api/types";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import {
  addAllFormFields,
  addFormBlock,
  addFormField,
  addableFields,
  blockText,
  canBeInForm,
  cleanForm,
  fieldDefault,
  helpFor,
  liveEntries,
  liveItems,
  moveFormField,
  moveFormFieldById,
  previewPublicFields,
  pruneForm,
  publicStatus,
  redirectAfterSubmit,
  redirectUrlProblem,
  removeFormField,
  removedFormField,
  requiredBlockedReason,
  sameForm,
  showIfSources,
  summarizeForm,
  toggleNotify,
  updateFormField,
  updateFormSettings,
} from "./formConfig";

const name = field("text", { multiline: false }, { id: "f_name", name: "Name" });
const notes = field("text", { multiline: true }, { id: "f_notes", name: "Notes" });
const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
const parent = field("link", { linked_table_id: "tbl1", inverse_field_id: "f_kids", single: true }, { id: "f_parent", name: "Parent" });
const total = field("formula", { expression: "1", result_type: "number" }, { id: "f_total", name: "Total" });
const table = makeTable([name, notes, owner, parent, total]);

const empty: FormConfig = { title: "", description: "", fields: [], submit_label: "", success_message: "", redirect_url: null, show_submit_another: false, notify_user_ids: [] };
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

describe("removing a field and adding it back", () => {
  const form = { ...empty, fields: [entry("f_name"), entry("f_notes", { label: "Comments", help: "Anything else?", required: true }), entry("f_owner")] };

  it("remembers the entry and its place", () => {
    expect(removedFormField(form, "f_notes")).toEqual({ entry: form.fields[1], index: 1 });
    expect(removedFormField(form, "zz")).toBeNull();
  });

  it("puts a removed field back where it was, with its label, help and required", () => {
    const taken = removedFormField(form, "f_notes")!;
    const without = removeFormField(form, "f_notes");
    expect(addFormField(without, table, "f_notes", taken)).toEqual(form);
    // The place is kept as well as it can be when the list got shorter meanwhile.
    expect(ids(addFormField({ ...empty, fields: [entry("f_name")] }, table, "f_notes", { ...taken, index: 5 }))).toEqual(["f_name", "f_notes"]);
  });

  it("does not add a field twice", () => {
    expect(addFormField(form, table, "f_notes", removedFormField(form, "f_notes")!)).toBe(form);
  });

  it("gives back the settings of every field added again, the others get the defaults", () => {
    const taken = new Map([["f_notes", removedFormField(form, "f_notes")!]]);
    const next = addAllFormFields({ ...empty, fields: [entry("f_name")] }, table, taken);
    expect(next.fields.find((f) => f.field_id === "f_notes")).toMatchObject({ label: "Comments", required: true });
    expect(next.fields.find((f) => f.field_id === "f_parent")).toEqual(entry("f_parent"));
  });

  it("does not bring a link or user field back as required", () => {
    const required = { entry: entry("f_owner", { required: true, label: "Who" }), index: 0 };
    expect(addFormField(empty, table, "f_owner", required).fields[0]).toEqual(entry("f_owner", { label: "Who" }));
  });
});

describe("what can be required", () => {
  it("is everything but the fields the public form cannot ask for", () => {
    expect(requiredBlockedReason(name)).toBeNull();
    expect(requiredBlockedReason(owner)).toMatch(/User fields cannot be required/);
    expect(requiredBlockedReason(parent)).toMatch(/Link fields cannot be required/);
  });
});

describe("the redirect after a submission", () => {
  it("puts the new record's id into {record_id}, encoded", () => {
    expect(redirectAfterSubmit("https://example.com/t?id={record_id}&again={record_id}", "rec 1/2")).toBe("https://example.com/t?id=rec%201%2F2&again=rec%201%2F2");
    expect(redirectAfterSubmit("https://example.com/{record_id}", "recAbc")).toBe("https://example.com/recAbc");
    expect(redirectAfterSubmit("https://example.com/t?id={record_id}", null)).toBe("https://example.com/t?id=");
  });

  it("is nothing without an address and for anything but http and https", () => {
    expect(redirectAfterSubmit(null, "rec1")).toBeNull();
    expect(redirectAfterSubmit("", "rec1")).toBeNull();
    expect(redirectAfterSubmit("javascript:alert(1)", "rec1")).toBeNull();
  });
});

describe("the public form as the builder previews it", () => {
  it("lists the collectable, visible fields with the form's label, help and required", () => {
    const f = { ...empty, fields: [entry("f_name", { label: "Your name", required: true }), entry("f_owner"), entry("f_notes", { help: "Anything else?" })] };
    expect(previewPublicFields(f, table, []).map((x) => [x.id, x.label, x.help, x.required, x.type])).toEqual([
      ["f_name", "Your name", null, true, "text"],
      ["f_notes", "Notes", "Anything else?", false, "text"],
    ]);
    expect(previewPublicFields(f, table, ["f_notes"]).map((x) => x.id)).toEqual(["f_name"]);
  });
});

describe("headings and paragraphs", () => {
  it("adds them anywhere, with a made-up id and some starting text", () => {
    let form = addFormField(addFormField(empty, table, "f_name"), table, "f_notes");
    form = addFormBlock(form, "heading", 1, "blkH");
    form = addFormBlock(form, "text", undefined, "blkT");
    expect(ids(form)).toEqual(["f_name", "blkH", "f_notes", "blkT"]);
    expect(form.fields[1]).toMatchObject({ block: "heading", required: false, label: "New section" });
    expect(form.fields[3]).toMatchObject({ block: "text", help: expect.any(String) });
    expect(addFormBlock(empty, "heading").fields[0]!.field_id).toMatch(/^blk[a-z0-9]{14}$/);
  });

  it("keeps them in the layout between the questions, and out of the list of questions", () => {
    const form: FormConfig = { ...empty, fields: [entry("f_name"), entry("blkH", { block: "heading", label: "About you" }), entry("f_gone"), entry("f_notes"), entry("blkT", { block: "text", help: "  Mind the gap  " })] };
    expect(liveItems(form, table).map((i) => (i.kind === "field" ? i.field.id : `${i.block}:${i.entry.field_id}`))).toEqual(["f_name", "heading:blkH", "f_notes", "text:blkT"]);
    expect(liveEntries(form, table).map((e) => e.field.id)).toEqual(["f_name", "f_notes"]);
    expect(blockText(form.fields[1]!)).toBe("About you");
    expect(blockText(form.fields[4]!)).toBe("Mind the gap");
  });

  it("survives cleaning and pruning, is never required, and can be removed and moved like a field", () => {
    const form: FormConfig = { ...empty, fields: [entry("f_gone"), entry("blkH", { block: "heading", label: "About you", required: true }), entry("f_name")] };
    const pruned = pruneForm(form, table);
    expect(ids(pruned)).toEqual(["blkH", "f_name"]);
    expect(cleanForm(pruned).fields[0]).toEqual({ field_id: "blkH", required: false, label: "About you", help: null, block: "heading" });
    expect(ids(moveFormFieldById(pruned, "blkH", "f_name"))).toEqual(["f_name", "blkH"]);
    expect(ids(removeFormField(pruned, "blkH"))).toEqual(["f_name"]);
  });
});

describe("show-if conditions", () => {
  const cond = (field_id: string) => ({ conjunction: "and" as const, items: [{ field_id, op: "is_not_empty" as const, value: null }] });

  it("may read the testable questions above an entry, and only those", () => {
    const form: FormConfig = { ...empty, fields: [entry("f_name"), entry("blkH", { block: "heading" }), entry("f_owner"), entry("f_notes"), entry("f_total")] };
    expect(showIfSources(form, table, 0)).toEqual([]);
    expect(showIfSources(form, table, 3).map((f) => f.id)).toEqual(["f_name"]);
    expect(showIfSources(form, table, 4).map((f) => f.id)).toEqual(["f_name", "f_notes"]);
  });

  it("is dropped on save where it reads something else (the server refuses it), and kept where it is fine", () => {
    const form: FormConfig = {
      ...empty,
      fields: [entry("f_name"), entry("f_notes", { show_if: cond("f_name") }), entry("f_owner", { show_if: cond("f_later") }), entry("blkH", { block: "heading", show_if: { conjunction: "or", items: [{ field_id: "f_notes", op: "is_empty", value: null }, { field_id: "f_later", op: "is_empty", value: null }] } }), entry("f_later")],
    };
    const pruned = pruneForm(form, table);
    expect(pruned.fields[1]!.show_if).toEqual(cond("f_name"));
    expect(pruned.fields[2]!.show_if).toBeNull();
    expect(pruned.fields[3]!.show_if).toEqual({ conjunction: "or", items: [{ field_id: "f_notes", op: "is_empty", value: null }] });
    expect(cleanForm(pruned).fields[2]).not.toHaveProperty("show_if");
    expect(cleanForm(pruned).fields[1]!.show_if).toEqual(cond("f_name"));
  });

  it("lets the public preview carry the show-if, the default and the field's description", () => {
    const described = { ...field("text", { multiline: false, default: "Acme" }, { id: "f_org", name: "Organization" }), description: "Who you work for" };
    const t = makeTable([name, described]);
    const form: FormConfig = { ...empty, fields: [entry("f_name"), entry("blkH", { block: "heading", label: "Work" }), entry("f_org", { show_if: cond("f_name") }), entry("blkE", { block: "text", help: " " })] };
    const got = previewPublicFields(form, t, []);
    expect(got.map((f) => f.id)).toEqual(["f_name", "blkH", "f_org"]);
    expect(got[1]).toMatchObject({ block: "heading", label: "Work", required: false });
    expect(got[2]).toMatchObject({ help: "Who you work for", default: "Acme", show_if: cond("f_name") });
    // The form's own help wins.
    expect(previewPublicFields({ ...form, fields: [entry("f_org", { help: "Ours" })] }, t, [])[0]!.help).toBe("Ours");
  });
});

describe("defaults and descriptions", () => {
  it("reads the default of text, number and percent fields", () => {
    expect(fieldDefault(field("text", { multiline: false, default: "x" }))).toBe("x");
    expect(fieldDefault(field("text", { multiline: false, default: "" }))).toBeNull();
    expect(fieldDefault(field("number", { precision: 0, allow_negative: true, default: 3 }))).toBe(3);
    expect(fieldDefault(field("number", { precision: 0, allow_negative: true }))).toBeNull();
    expect(fieldDefault(field("checkbox", { icon: "check", color: "green" }))).toBeNull();
  });

  it("uses the description as help when the form has none", () => {
    const f = { ...field("text", { multiline: false }), description: "About it" };
    expect(helpFor({ help: null }, f)).toBe("About it");
    expect(helpFor({ help: "  " }, f)).toBe("About it");
    expect(helpFor({ help: "Ours" }, f)).toBe("Ours");
    expect(helpFor({ help: null }, field("text", { multiline: false }))).toBeNull();
  });
});

describe("who is told about responses", () => {
  it("adds and removes a person without repeating them", () => {
    const a = toggleNotify(empty, "usr1", true);
    expect(a.notify_user_ids).toEqual(["usr1"]);
    expect(toggleNotify(a, "usr1", true)).toBe(a);
    expect(toggleNotify(toggleNotify(a, "usr2", true), "usr1", false).notify_user_ids).toEqual(["usr2"]);
  });
});
