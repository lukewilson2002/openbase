import { describe, expect, it } from "vitest";
import type { Field, WorkspaceSummary } from "@/api/types";
import { field, makeTable } from "@/test/fields";
import { attachmentFields, captureTargets, defaultNoteField, draftPreview, fileFields, formFields, isBlank, noteFields } from "./targets";

const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const plain = field("long_text", { rich: false }, { id: "fld_plain", name: "Plain" });
const rich = field("long_text", { rich: true }, { id: "fld_rich", name: "Rich" });
const stage = field("single_select", { choices: [{ id: "chs1", name: "Todo", color: "gray" }] }, { id: "fld_stage", name: "Stage" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fld_done", name: "Done" });
const files = field("attachment", {}, { id: "fld_files", name: "Files" });
const total = field("formula", { expression: "1", result_type: "number", format: { kind: "number", precision: 0 } }, { id: "fld_total", name: "Total" });
const table = makeTable([name, plain, rich, stage, done, files, total]);

describe("fields of a table", () => {
  it("offers rich long text first for the note, and defaults to the first rich one", () => {
    expect(noteFields(table).map((f) => f.id)).toEqual(["fld_rich", "fld_plain"]);
    expect(defaultNoteField(table)?.id).toBe("fld_rich");
    expect(defaultNoteField(makeTable([name]))).toBeUndefined();
    expect(attachmentFields(table).map((f) => f.id)).toEqual(["fld_files"]);
  });

  it("leaves the title, the note's field, computed fields and attachments out of the form", () => {
    expect(formFields(table, "fld_rich").map((f) => f.id)).toEqual(["fld_plain", "fld_stage", "fld_done"]);
    expect(formFields(table, null).map((f) => f.id)).toEqual(["fld_plain", "fld_rich", "fld_stage", "fld_done"]);
  });
});

describe("fileFields", () => {
  const base = { table, values: {}, note: "", noteFieldId: "fld_rich", attachments: [], attachmentFieldId: "fld_files" as string | null };

  it("keys by field id, trims text and leaves empty values out", () => {
    const out = fileFields({ ...base, values: { fld_name: "  Plan  ", fld_stage: "chs1", fld_done: false, fld_plain: "" }, note: "Body\n" });
    expect(out).toEqual({ fld_name: "Plan", fld_stage: "chs1", fld_rich: "Body" });
  });

  it("puts the files in the chosen attachment field as ids, and nowhere when there is none", () => {
    const refs = [{ id: "att1", filename: "a.pdf", mime: "application/pdf", size: 1 }];
    expect(fileFields({ ...base, attachments: refs })).toEqual({ fld_files: [{ id: "att1" }] });
    expect(fileFields({ ...base, attachments: refs, attachmentFieldId: null })).toEqual({});
  });

  it("sends links as record ids and never computed fields", () => {
    const link: Field = field("link", { linked_table_id: "tbl2", inverse_field_id: null, single: false } as never, { id: "fld_link", name: "Link" });
    const t = makeTable([name, link, total]);
    const out = fileFields({ ...base, table: t, noteFieldId: null, values: { fld_link: [{ id: "rec2", name: "Ada" }], fld_total: 5 } });
    expect(out).toEqual({ fld_link: ["rec2"] });
  });
});

describe("drafts", () => {
  it("previews the first line with text, without Markdown's marks", () => {
    expect(draftPreview({ body: "\n\n# **Trip** ideas\nLisbon", attachments: [] })).toBe("Trip ideas");
    expect(draftPreview({ body: "- [ ] call [Ada](https://x.test)", attachments: [] })).toBe("call Ada");
    expect(draftPreview({ body: "", attachments: [{ id: "a", filename: "scan.pdf", mime: "", size: 1 }] })).toBe("scan.pdf");
    expect(draftPreview({ body: "  ", attachments: [] })).toBe("Empty draft");
  });

  it("is blank without text and files", () => {
    expect(isBlank(" \n", [])).toBe(true);
    expect(isBlank("", [1])).toBe(false);
    expect(isBlank("x", [])).toBe(false);
  });
});

describe("captureTargets", () => {
  const ws = (role: string, tables: number): WorkspaceSummary => ({
    id: "w",
    name: "W",
    color: "green",
    role: "owner",
    member_count: 1,
    pending_invite_count: 0,
    bases: [{ id: "b", workspace_id: "w", name: "B", color: "blue", role, people: [], tables: Array.from({ length: tables }, (_, i) => ({ id: `t${i}`, name: `T${i}`, icon: null })) }],
  });

  it("offers projects where records can be created and that have a table", () => {
    expect(captureTargets([ws("editor", 1)])).toHaveLength(1);
    expect(captureTargets([ws("owner", 2)])[0]!.projects[0]!.tables).toHaveLength(2);
    expect(captureTargets([ws("commenter", 1)])).toHaveLength(0);
    expect(captureTargets([ws("viewer", 1)])).toHaveLength(0);
    expect(captureTargets([ws("editor", 0)])).toHaveLength(0);
  });
});
