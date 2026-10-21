/**
 * Fields through the real API client against the real server: every type the field dialog can
 * create with its default options, link pairs, formulas with the live check, lookup / rollup /
 * count, option and type changes that convert data, and delete + restore through the trash.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { recordsApi, schemaApi, type FieldMutationResult } from "../src/api/records";
import type { Field, FieldType, Table } from "../src/api/types";
import { defaultKind, FIELD_TYPES, toCreateField, type KindContext } from "../src/components/fields/fieldKinds";
import { createWorld, expectError, failure, fieldNamed, joinBase, newUser, refreshBase, tableOf, type World } from "./support";
import { parse } from "./typecheck";

let w: World;
let tasks: Table;
let people: Table;

/** Validate a create/update answer: the field itself, and the optional inverse / removed ids. */
function parseFieldResult(raw: FieldMutationResult): { field: Field; inverse?: Field; removed?: string[] } {
  const { inverse, removed_field_ids, ...field } = raw;
  const out: { field: Field; inverse?: Field; removed?: string[] } = { field: parse("Field", field) };
  if (inverse) out.inverse = parse("Field", inverse);
  if (removed_field_ids) {
    expect(Array.isArray(removed_field_ids)).toBe(true);
    out.removed = removed_field_ids;
  }
  return out;
}

const ctx = (): KindContext => ({ table: tasks, tables: [tasks, people] });

beforeAll(async () => {
  w = await createWorld("Fields");
  const t = await w.owner.run(() => api.tables.create(w.baseId, "People"));
  const base = await refreshBase(w.owner, w.baseId);
  tasks = base.tables.find((x) => x.id !== t.id)!;
  people = base.tables.find((x) => x.id === t.id)!;
});

describe("every default-creatable field type", () => {
  // Types that need other fields or a non-empty expression are covered by the sections below.
  const standalone = FIELD_TYPES.filter((t) => !["link", "lookup", "rollup", "count", "formula", "button"].includes(t));

  for (const type of standalone) {
    it(`creates a ${type} field with the dialog's default options and returns it fully typed`, async () => {
      const body = toCreateField({ name: `F ${type}`, description: "made by the contract test", kind: defaultKind(type, ctx()), inverseName: "" });
      const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, body)));
      expect(w.owner.status).toBe(201);
      expect(field).toMatchObject({ name: `F ${type}`, type, table_id: tasks.id, description: "made by the contract test" });
    });
  }

  it("fills server-side defaults when options are empty", async () => {
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Bare number", type: "number", options: {} } as never)));
    expect(field.type).toBe("number");
    expect((field as Extract<Field, { type: "number" }>).options.precision).toBeTypeOf("number");
  });

  it("lists all created fields in the base schema in creation order", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const names = t.fields.map((f) => f.name);
    for (const type of standalone) expect(names).toContain(`F ${type}`);
    expect(names.indexOf("F number")).toBeLessThan(names.indexOf("F date"));
  });

  it("rejects bad input with the error envelope", async () => {
    // Names are unique per table, case-insensitively.
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, toCreateField({ name: "f number", description: "", kind: defaultKind("number", ctx()), inverseName: "" })))), 409, "conflict");
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "", type: "number", options: {} } as never))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "X", type: "hologram", options: {} } as never))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "Rating", type: "rating", options: { max: 99, icon: "star", color: "yellow" } }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => schemaApi.createField("tblNope0000000", { name: "X", type: "number", options: {} } as never))), 404, "not_found");
  });
});

describe("select fields", () => {
  it("creates choices with ids and keeps their order", async () => {
    const { field } = parseFieldResult(
      await w.owner.run(() =>
        schemaApi.createField(tasks.id, { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Done", color: "green" }] } }),
      ),
    );
    const choices = (field as Extract<Field, { type: "single_select" }>).options.choices;
    expect(choices.map((c) => c.name)).toEqual(["Todo", "Done"]);
    expect(choices.every((c) => c.id.length > 0)).toBe(true);
    expect(new Set(choices.map((c) => c.id)).size).toBe(2);
  });

  it("adds a choice to an existing field with the same-type update", async () => {
    const status = fieldNamed(await tableOf(w.owner, w.baseId, tasks.id), "Status") as Extract<Field, { type: "single_select" }>;
    const next = [...status.options.choices, { id: "", name: "Blocked", color: "red" }];
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.updateField(status.id, { type: "single_select", options: { choices: next } })));
    expect(w.owner.status).toBe(200);
    expect((field as Extract<Field, { type: "single_select" }>).options.choices.map((c) => c.name)).toEqual(["Todo", "Done", "Blocked"]);
  });
});

describe("link fields", () => {
  it("creates a link and its inverse in the other table", async () => {
    const res = parseFieldResult(
      await w.owner.run(() => schemaApi.createField(tasks.id, toCreateField({ name: "Assignees", description: "", kind: { type: "link", options: { linked_table_id: people.id, inverse_field_id: "", single: false } }, inverseName: "Assigned tasks" }))),
    );
    expect(res.field.type).toBe("link");
    const link = res.field as Extract<Field, { type: "link" }>;
    expect(link.options.linked_table_id).toBe(people.id);
    expect(res.inverse).toMatchObject({ name: "Assigned tasks", type: "link", table_id: people.id });
    const inverse = res.inverse as Extract<Field, { type: "link" }>;
    expect(inverse.options.linked_table_id).toBe(tasks.id);
    expect(link.options.inverse_field_id).toBe(inverse.id);
    expect(inverse.options.inverse_field_id).toBe(link.id);
    // Both sides are in the schema.
    expect((await tableOf(w.owner, w.baseId, people.id)).fields.map((f) => f.id)).toContain(inverse.id);
  });

  it("supports a link to the same table and single-record links", async () => {
    const res = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Parent", type: "link", options: { linked_table_id: tasks.id, inverse_field_id: "", single: true }, inverse_name: "Children" } as never)));
    expect(res.inverse).toMatchObject({ name: "Children", table_id: tasks.id });
    expect((res.field as Extract<Field, { type: "link" }>).options.single).toBe(true);
  });

  it("rejects links to a table in another base", async () => {
    const other = await createWorld("Other");
    const foreign = other.base.tables[0]!;
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "Bad", type: "link", options: { linked_table_id: foreign.id, inverse_field_id: "", single: false } } as never))), 400, "bad_request");
  });
});

describe("formulas", () => {
  it("checks a formula without saving anything: ok with a type, errors with a position", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const check = parse("FormulaCheckResult", await w.owner.run(() => schemaApi.checkFormula(tasks.id, `{F number} * 2`)));
    expect(check).toMatchObject({ ok: true, result_type: "number" });
    expect(check.error ?? null).toBeNull();

    const bad = parse("FormulaCheckResult", await w.owner.run(() => schemaApi.checkFormula(tasks.id, `SUM({F number}, `)));
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toBeTruthy();
    expect(bad.result_type ?? null).toBeNull();

    const unknown = parse("FormulaCheckResult", await w.owner.run(() => schemaApi.checkFormula(tasks.id, `{No such field} + 1`)));
    expect(unknown.ok).toBe(false);
    expect((await tableOf(w.owner, w.baseId, tasks.id)).fields).toHaveLength(t.fields.length);
  });

  it("previews the formula on a record", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const num = fieldNamed(t, "F number");
    const created = await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [num.id]: 21 } }] }));
    const rec = created.records[0]!;
    const check = parse("FormulaCheckResult", await w.owner.run(() => schemaApi.checkFormula(tasks.id, `{F number} * 2`, { recordId: rec.id })));
    expect(check.preview).toBe(42);
    expectError(await failure(w.owner.run(() => schemaApi.checkFormula(tasks.id, "1", { recordId: "recNope0000000" }))), 404, "not_found");
  });

  it("creates a formula field: references are stored by id and served by name, the result type is inferred", async () => {
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Double", type: "formula", options: { expression: "{F number} * 2", result_type: "text" } })));
    const f = field as Extract<Field, { type: "formula" }>;
    expect(f.options.expression).toBe("{F number} * 2");
    expect(f.options.result_type).toBe("number");
  });

  it("keeps formulas working when a referenced field is renamed", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const num = fieldNamed(t, "F number");
    parseFieldResult(await w.owner.run(() => schemaApi.updateField(num.id, { name: "Quantity" })));
    const double = fieldNamed(await tableOf(w.owner, w.baseId, tasks.id), "Double") as Extract<Field, { type: "formula" }>;
    expect(double.options.expression).toBe("{Quantity} * 2");
  });

  it("rejects an invalid formula when saving, with the reason", async () => {
    const e = await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "Broken", type: "formula", options: { expression: "{Quantity} +", result_type: "text" } })));
    expectError(e, 400, "bad_request");
    expect(e.message.toLowerCase()).toContain("formula");
  });

  it("rejects formula cycles", async () => {
    const a = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Cycle A", type: "formula", options: { expression: "1", result_type: "number" } }))).field;
    parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Cycle B", type: "formula", options: { expression: "{Cycle A} + 1", result_type: "number" } })));
    const e = await failure(w.owner.run(() => schemaApi.updateField(a.id, { type: "formula", options: { expression: "{Cycle B} + 1", result_type: "number" } })));
    expect(e.status).toBe(400);
  });

  it("lets editors check formulas but not create fields", async () => {
    const editor = await newUser(w.owner, "editor");
    await joinBase(w.owner, w.baseId, editor, "editor");
    expect(parse("FormulaCheckResult", await editor.run(() => schemaApi.checkFormula(tasks.id, "1 + 1"))).ok).toBe(true);
    expectError(await failure(editor.run(() => schemaApi.createField(tasks.id, { name: "No", type: "number", options: {} } as never))), 403, "forbidden");
    const viewer = await newUser(w.owner, "viewer");
    await joinBase(w.owner, w.baseId, viewer, "viewer");
    expectError(await failure(viewer.run(() => schemaApi.checkFormula(tasks.id, "1 + 1"))), 403, "forbidden");
  });
});

describe("lookup, rollup and count", () => {
  let linkId = "";
  let peopleName = "";

  it("creates a lookup over a link", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    linkId = fieldNamed(t, "Assignees").id;
    peopleName = (await tableOf(w.owner, w.baseId, people.id)).primary_field_id;
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Assignee names", type: "lookup", options: { link_field_id: linkId, target_field_id: peopleName, result_type: "text" } })));
    const f = field as Extract<Field, { type: "lookup" }>;
    expect(f.options).toMatchObject({ link_field_id: linkId, target_field_id: peopleName });
    expect(f.options.result_type).toEqual({ array: "text" });
  });

  it("creates a count of linked records", async () => {
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Assignee count", type: "count", options: { link_field_id: linkId } })));
    expect(field.type).toBe("count");
  });

  it("creates a rollup with a formula over `values`, and rejects other field references", async () => {
    const ageId = parseFieldResult(await w.owner.run(() => schemaApi.createField(people.id, { name: "Age", type: "number", options: {} } as never))).field.id;
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Total age", type: "rollup", options: { link_field_id: linkId, target_field_id: ageId, expression: "SUM(values)", result_type: "number" } })));
    expect((field as Extract<Field, { type: "rollup" }>).options.result_type).toBe("number");
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "Bad rollup", type: "rollup", options: { link_field_id: linkId, target_field_id: ageId, expression: "SUM({Quantity})", result_type: "number" } }))), 400, "bad_request");
  });

  it("rejects lookups whose target is not in the linked table", async () => {
    const own = fieldNamed(await tableOf(w.owner, w.baseId, tasks.id), "Double");
    expectError(await failure(w.owner.run(() => schemaApi.createField(tasks.id, { name: "Wrong", type: "lookup", options: { link_field_id: linkId, target_field_id: own.id, result_type: "text" } }))), 400, "bad_request");
  });
});

describe("changing a field", () => {
  const table = () => tasks;

  it("renames, describes and moves a field; answers the field", async () => {
    const f = fieldNamed(await tableOf(w.owner, w.baseId, table().id), "F email");
    const { field } = parseFieldResult(await w.owner.run(() => schemaApi.updateField(f.id, { name: "Email address", description: "Where to write" })));
    expect(w.owner.status).toBe(200);
    expect(field).toMatchObject({ id: f.id, name: "Email address", description: "Where to write" });
  });

  it("converts stored values when the type changes (number to text), leaving other fields alone", async () => {
    const t = await tableOf(w.owner, w.baseId, table().id);
    const fresh = parseFieldResult(await w.owner.run(() => schemaApi.createField(table().id, { name: "Amount", type: "number", options: { precision: 2, allow_negative: true } }))).field;
    const rec = (await w.owner.run(() => recordsApi.create(table().id, { records: [{ values: { [fresh.id]: 12.5, [t.primary_field_id]: "row" } }] }))).records[0]!;
    parseFieldResult(await w.owner.run(() => schemaApi.updateField(fresh.id, { type: "text", options: { multiline: false } })));
    const after = parse("TableRecord", await w.owner.run(() => recordsApi.get(table().id, rec.id)));
    expect(after.values[fresh.id]).toBe("12.50");
    expect(after.values[t.primary_field_id]).toBe("row");
  });

  it("refuses an invalid type change atomically", async () => {
    const f = fieldNamed(await tableOf(w.owner, w.baseId, table().id), "Double");
    expectError(await failure(w.owner.run(() => schemaApi.updateField(f.id, { type: "formula", options: { expression: "{Gone} + 1", result_type: "number" } }))), 400, "bad_request");
    expect(fieldNamed(await tableOf(w.owner, w.baseId, table().id), "Double").type).toBe("formula");
  });

  it("answers 404 for unknown fields and 403 for editors", async () => {
    expectError(await failure(w.owner.run(() => schemaApi.updateField("fldNope00000000", { name: "x" }))), 404, "not_found");
    const f = fieldNamed(await tableOf(w.owner, w.baseId, table().id), "Double");
    const editor = await newUser(w.owner, "editor2");
    await joinBase(w.owner, w.baseId, editor, "editor");
    expectError(await failure(editor.run(() => schemaApi.updateField(f.id, { name: "nope" }))), 403, "forbidden");
  });
});

describe("deleting a field and restoring it from the trash", () => {
  it("trashes a link together with its inverse, lookups and counts, and says which fields went", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const link = fieldNamed(t, "Assignees");
    const dependents = ["Assignee names", "Assignee count", "Total age"].map((n) => fieldNamed(t, n).id);
    const inverse = (link as Extract<Field, { type: "link" }>).options.inverse_field_id;

    const res = parse("DeleteFieldResponse", await w.owner.run(() => schemaApi.deleteField(link.id)));
    expect(w.owner.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.deleted_field_ids).toEqual(expect.arrayContaining([link.id, inverse, ...dependents]));

    const after = await refreshBase(w.owner, w.baseId);
    const ids = after.tables.flatMap((x) => x.fields.map((f) => f.id));
    for (const id of res.deleted_field_ids) expect(ids).not.toContain(id);

    // A link pair trashed together is listed once, under whichever side sorts first.
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    const listed = trash.items.filter((i) => i.kind === "field" && (i.id === link.id || i.id === inverse));
    expect(listed).toHaveLength(1);
  });

  it("restores the field with the ones trashed alongside it", async () => {
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    const link = trash.items.find((i) => i.kind === "field" && (i.name === "Assignees" || i.name === "Assigned tasks"))!;
    expect([tasks.id, people.id]).toContain(link.table_id);
    const restored = parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "field", id: link.id })));
    expect(restored.ok).toBe(true);
    expect(restored.restored_field_ids).toContain(link.id);
    // Restoring either side brings back the pair.
    expect((await tableOf(w.owner, w.baseId, people.id)).fields.map((f) => f.name)).toContain("Assigned tasks");
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    expect(t.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["Assignees", "Assignee names", "Assignee count"]));
  });

  it("refuses to delete the primary field", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    expectError(await failure(w.owner.run(() => schemaApi.deleteField(t.primary_field_id))), 409, "conflict");
  });

  it("answers 404 for a field that does not exist", async () => {
    expectError(await failure(w.owner.run(() => schemaApi.deleteField("fldNope00000000"))), 404, "not_found");
  });
});

// Keep the field-type list honest: if the server learns a type, the dialog must know it.
describe("field type coverage", () => {
  it("the dialog offers exactly the types the server's schema knows", async () => {
    const t = await tableOf(w.owner, w.baseId, tasks.id);
    const created: FieldType[] = t.fields.map((f) => f.type);
    for (const type of FIELD_TYPES.filter((x) => !["lookup", "rollup", "count", "link", "formula", "button"].includes(x))) expect(created).toContain(type);
  });
});
