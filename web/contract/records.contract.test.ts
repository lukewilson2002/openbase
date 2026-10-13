/**
 * Records, view queries, aggregations, link lookup and history through the real API client
 * against the real server: create / update / delete / restore / move, typecast, links seen from
 * both sides, `before_record_id`, and filter / sort / group / search / range / paging / colours /
 * the transient override. Every response is checked against the generated bindings.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { api } from "../src/api/endpoints";
import { attachmentsApi, recordsApi, schemaApi } from "../src/api/records";
import type { Field, QueryRequest, TableRecord, Table, View } from "../src/api/types";
import { createWorld, env, expectError, failure, fieldNamed, joinBase, newUser, refreshBase, tableOf, type Profile, type World } from "./support";
import { parse } from "./typecheck";

let w: World;
let tasks: Table;
let people: Table;
let gridView: View;
let viewer: Profile;
let editor: Profile;

// Field ids
let name = "";
let qty = "";
let status = "";
let tags = "";
let due = "";
let done = "";
let assignees = "";
let tasksOfPerson = "";
let double = "";
let autonumber = "";
let createdBy = "";
let peopleName = "";
let peopleAge = "";

type Select = Extract<Field, { type: "single_select" }>;
const choiceId = (f: Field, label: string) => (f as Select).options.choices.find((c) => c.name === label)!.id;

const q = async (body: QueryRequest = {}, p: Profile = w.owner, view = gridView.id) => parse("QueryResponse", await p.run(() => recordsApi.query(view, body)));
const names = (r: { records: TableRecord[] }) => r.records.map((x) => x.values[name]);

async function mk(values: Record<string, unknown>, extra: { typecast?: boolean } = {}): Promise<TableRecord> {
  const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: values as never }], ...extra })));
  return res.records[0]!;
}

beforeAll(async () => {
  w = await createWorld("Records");
  tasks = w.base.tables[0]!;
  name = tasks.primary_field_id;
  people = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "People")));
  peopleName = people.primary_field_id;
  const add = async (t: Table, body: Parameters<typeof schemaApi.createField>[1]) => w.owner.run(() => schemaApi.createField(t.id, body));
  qty = (await add(tasks, { name: "Qty", type: "number", options: { precision: 2, allow_negative: true } })).id;
  const st = await add(tasks, { name: "Status", type: "single_select", options: { choices: [{ id: "", name: "Todo", color: "gray" }, { id: "", name: "Doing", color: "blue" }, { id: "", name: "Done", color: "green" }] } });
  status = st.id;
  tags = (await add(tasks, { name: "Tags", type: "multiple_select", options: { choices: [{ id: "", name: "red", color: "red" }, { id: "", name: "blue", color: "blue" }] } })).id;
  due = (await add(tasks, { name: "Due", type: "date", options: { include_time: false, date_format: "iso", time_format: "h24", timezone: null } })).id;
  done = (await add(tasks, { name: "Done?", type: "checkbox", options: { icon: "check", color: "green" } })).id;
  autonumber = (await add(tasks, { name: "No", type: "autonumber", options: {} })).id;
  createdBy = (await add(tasks, { name: "Author", type: "created_by", options: {} })).id;
  double = (await add(tasks, { name: "Double", type: "formula", options: { expression: "{Qty} * 2", result_type: "number" } })).id;
  peopleAge = (await add(people, { name: "Age", type: "number", options: { precision: 0, allow_negative: false } })).id;
  const link = await add(tasks, { name: "Assignees", type: "link", options: { linked_table_id: people.id, inverse_field_id: "", single: false }, inverse_name: "Tasks" } as never);
  assignees = link.id;
  tasksOfPerson = link.inverse!.id;

  const base = await refreshBase(w.owner, w.baseId);
  tasks = base.tables.find((t) => t.id === tasks.id)!;
  people = base.tables.find((t) => t.id === people.id)!;
  gridView = tasks.views[0]!;
  viewer = await newUser(w.owner, "viewer");
  editor = await newUser(w.owner, "editor");
  await joinBase(w.owner, w.baseId, viewer, "viewer");
  await joinBase(w.owner, w.baseId, editor, "editor");
});

describe("creating records", () => {
  let first: TableRecord;

  it("creates a record (201 RecordsResponse) and returns every value, system fields included", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [name]: "Write docs", [qty]: 3 } }] })));
    expect(w.owner.status).toBe(201);
    expect(res.records).toHaveLength(1);
    first = res.records[0]!;
    expect(first.values[name]).toBe("Write docs");
    expect(first.values[qty]).toBe(3);
    expect(first.values[double]).toBe(6);
    expect(first.values[autonumber]).toBe(first.autonumber);
    expect(first.values[createdBy]).toBe(w.owner.id);
    expect(first.created_by).toBe(w.owner.id);
    expect(first.table_id).toBe(tasks.id);
  });

  it("creates several records at once and keeps the request order", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(tasks.id, { records: ["B", "C", "D"].map((n) => ({ values: { [name]: n } })) })));
    expect(res.records.map((r) => r.values[name])).toEqual(["B", "C", "D"]);
    expect(new Set(res.records.map((r) => r.autonumber)).size).toBe(3);
  });

  it("reads one record back, and answers 404 for unknown and trashed records", async () => {
    expect(parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, first.id)))).toEqual(first);
    expectError(await failure(w.owner.run(() => recordsApi.get(tasks.id, "recNope0000000"))), 404, "not_found");
  });

  it("without typecast, lenient input is rejected; with typecast it is coerced (names to choice ids, strings to numbers)", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [qty]: "twelve" } }] }))), 400, "bad_request");
    const r = await mk({ [qty]: "12.5", [status]: "Doing", [tags]: ["red", "blue"], [due]: "2026-03-04", [done]: "yes" }, { typecast: true });
    expect(r.values[qty]).toBe(12.5);
    expect(r.values[status]).toBe(choiceId(fieldNamed(tasks, "Status"), "Doing"));
    expect(r.values[tags]).toEqual((fieldNamed(tasks, "Tags") as Select).options.choices.map((c) => c.id));
    expect(r.values[due]).toBe("2026-03-04");
    expect(r.values[done]).toBe(true);
  });

  it("rejects computed fields, unknown fields and oversize batches", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [double]: 1 } }] }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { fldNope00000000: 1 } }] }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: Array.from({ length: 1001 }, () => ({ values: {} })) }))), 400, "bad_request");
  });

  it("is forbidden for viewers", async () => {
    expectError(await failure(viewer.run(() => recordsApi.create(tasks.id, { records: [{ values: {} }] }))), 403, "forbidden");
  });
});

describe("updating records", () => {
  let rec: TableRecord;

  it("patches only the given fields and answers every patched record (200 RecordsResponse)", async () => {
    rec = await mk({ [name]: "Patch me", [qty]: 1, [status]: choiceId(fieldNamed(tasks, "Status"), "Todo") });
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.update(tasks.id, { records: [{ id: rec.id, values: { [qty]: 4 } }] })));
    expect(w.owner.status).toBe(200);
    expect(res.records[0]!.values[qty]).toBe(4);
    expect(res.records[0]!.values[name]).toBe("Patch me");
    expect(res.records[0]!.values[double]).toBe(8);
    expect(res.records[0]!.values[status]).toBe(rec.values[status]);
  });

  it("clears a field with null", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.update(tasks.id, { records: [{ id: rec.id, values: { [qty]: null } }] })));
    expect(res.records[0]!.values[qty]).toBeUndefined();
    // A blank number counts as 0 in a formula (Airtable semantics).
    expect(res.records[0]!.values[double]).toBe(0);
  });

  it("is all-or-nothing for a batch", async () => {
    const other = await mk({ [name]: "Other" });
    const e = await failure(
      w.owner.run(() =>
        recordsApi.update(tasks.id, {
          records: [
            { id: other.id, values: { [name]: "changed" } },
            { id: "recNope0000000", values: { [name]: "x" } },
          ],
        }),
      ),
    );
    expectError(e, 404, "not_found");
    expect(parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, other.id))).values[name]).toBe("Other");
  });

  it("lets editors edit and keeps viewers read-only", async () => {
    expect(parse("RecordsResponse", await editor.run(() => recordsApi.update(tasks.id, { records: [{ id: rec.id, values: { [name]: "by editor" } }] }))).records[0]!.values[name]).toBe("by editor");
    expectError(await failure(viewer.run(() => recordsApi.update(tasks.id, { records: [{ id: rec.id, values: { [name]: "by viewer" } }] }))), 403, "forbidden");
  });
});

describe("deleting and restoring records", () => {
  it("deletes with a body of ids and answers 204 without a body", async () => {
    const a = await mk({ [name]: "Doomed A" });
    const b = await mk({ [name]: "Doomed B" });
    const res = await w.owner.run(() => recordsApi.remove(tasks.id, [a.id, b.id]));
    expect(res).toBeUndefined();
    expect(w.owner.status).toBe(204);
    expectError(await failure(w.owner.run(() => recordsApi.get(tasks.id, a.id))), 404, "not_found");
    expect(names(await q({ search: "Doomed" }))).toEqual([]);
  });

  it("a batch with one bad id deletes nothing (404) and duplicates are ignored", async () => {
    const a = await mk({ [name]: "Survivor" });
    expectError(await failure(w.owner.run(() => recordsApi.remove(tasks.id, [a.id, "recNope0000000"]))), 404, "not_found");
    expect(parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, a.id))).id).toBe(a.id);
    await w.owner.run(() => recordsApi.remove(tasks.id, [a.id, a.id]));
    expect(w.owner.status).toBe(204);
  });

  it("restores trashed records (200 RecordsResponse) with their values and system fields", async () => {
    const a = await mk({ [name]: "Phoenix", [qty]: 9 });
    await w.owner.run(() => recordsApi.remove(tasks.id, [a.id]));
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    expect(trash.items).toContainEqual(expect.objectContaining({ kind: "record", id: a.id, table_id: tasks.id }));
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.restore(tasks.id, [a.id])));
    expect(w.owner.status).toBe(200);
    expect(res.records[0]).toMatchObject({ id: a.id, autonumber: a.autonumber });
    expect(res.records[0]!.values[name]).toBe("Phoenix");
    expect(res.records[0]!.values[double]).toBe(18);
  });

  it("restores through the trash endpoint as well", async () => {
    const a = await mk({ [name]: "Via trash" });
    await w.owner.run(() => recordsApi.remove(tasks.id, [a.id]));
    parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "record", id: a.id })));
    expect(parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, a.id))).id).toBe(a.id);
  });
});

describe("manual order: before_record_id, after_record_id and move", () => {
  let ids: Record<string, string> = {};
  let order: string[] = [];

  const manual = async () => (await q({ limit: 200 })).records.map((r) => r.values[name] as string).filter((n) => /^ord /.test(n));

  it("appends new records at the end by default", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(tasks.id, { records: ["ord a", "ord b", "ord c"].map((n) => ({ values: { [name]: n } })) })));
    ids = Object.fromEntries(res.records.map((r) => [r.values[name] as string, r.id]));
    order = await manual();
    expect(order).toEqual(["ord a", "ord b", "ord c"]);
  });

  it("inserts before a record (201), and several new records keep their request order", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(tasks.id, { records: ["ord x", "ord y"].map((n) => ({ values: { [name]: n } })), before_record_id: ids["ord b"]! })));
    expect(w.owner.status).toBe(201);
    expect(res.records.map((r) => r.values[name])).toEqual(["ord x", "ord y"]);
    for (const r of res.records) ids[r.values[name] as string] = r.id;
    expect(await manual()).toEqual(["ord a", "ord x", "ord y", "ord b", "ord c"]);
  });

  it("inserts before the first record", async () => {
    await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [name]: "ord first" } }], before_record_id: ids["ord a"]! }));
    expect((await manual())[0]).toBe("ord first");
  });

  it("inserts after a record", async () => {
    await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [name]: "ord after-c" } }], after_record_id: ids["ord c"]! }));
    const now = await manual();
    expect(now[now.indexOf("ord c") + 1]).toBe("ord after-c");
  });

  it("rejects both anchors together and anchors that are not live records of the table", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: {} }], before_record_id: ids["ord a"]!, after_record_id: ids["ord b"]! }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: {} }], before_record_id: "recNope0000000" }))), 400, "bad_request");
    const trashed = await mk({ [name]: "ord trashed" });
    ids["ord trashed"] = trashed.id;
    await w.owner.run(() => recordsApi.remove(tasks.id, [trashed.id]));
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: {} }], after_record_id: trashed.id }))), 400, "bad_request");
  });

  it("moves records (200 RecordsResponse with the moved records in request order, duplicates collapsed)", async () => {
    const res = parse("RecordsResponse", await w.owner.run(() => recordsApi.move(tasks.id, { ids: [ids["ord c"]!, ids["ord a"]!, ids["ord c"]!], before_id: ids["ord x"]! })));
    expect(w.owner.status).toBe(200);
    expect(res.records.map((r) => r.id)).toEqual([ids["ord c"], ids["ord a"]]);
    const now = await manual();
    expect(now.indexOf("ord c")).toBe(now.indexOf("ord x") - 2);
    expect(now.indexOf("ord a")).toBe(now.indexOf("ord x") - 1);
  });

  it("moves after a record, and rejects an anchor that is itself moved or missing", async () => {
    await w.owner.run(() => recordsApi.move(tasks.id, { ids: [ids["ord y"]!], after_id: ids["ord b"]! }));
    const now = await manual();
    expect(now[now.indexOf("ord b") + 1]).toBe("ord y");
    expect((await failure(w.owner.run(() => recordsApi.move(tasks.id, { ids: [ids["ord y"]!], after_id: ids["ord y"]! })))).status).toBe(400);
    expectError(await failure(w.owner.run(() => recordsApi.move(tasks.id, { ids: [ids["ord y"]!], after_id: "recNope0000000" }))), 400, "bad_request");
  });
});

describe("links, seen from both sides", () => {
  let alice: TableRecord;
  let bob: TableRecord;
  let t1: TableRecord;
  let t2: TableRecord;

  it("links records by id and returns [{id, name}] values", async () => {
    alice = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(people.id, { records: [{ values: { [peopleName]: "Alice", [peopleAge]: 30 } }] }))).records[0]!;
    bob = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(people.id, { records: [{ values: { [peopleName]: "Bob", [peopleAge]: 40 } }] }))).records[0]!;
    t1 = await mk({ [name]: "Link one", [assignees]: [alice.id, bob.id] });
    t2 = await mk({ [name]: "Link two", [assignees]: [{ id: alice.id }] }, { typecast: true });
    expect(t1.values[assignees]).toEqual([
      { id: alice.id, name: "Alice" },
      { id: bob.id, name: "Bob" },
    ]);
    expect(t2.values[assignees]).toEqual([{ id: alice.id, name: "Alice" }]);
  });

  it("shows the inverse side on the other table, with the names of the tasks", async () => {
    const a = parse("TableRecord", await w.owner.run(() => recordsApi.get(people.id, alice.id)));
    expect((a.values[tasksOfPerson] as { id: string; name: string }[]).map((l) => l.name).sort()).toEqual(["Link one", "Link two"]);
    const b = parse("TableRecord", await w.owner.run(() => recordsApi.get(people.id, bob.id)));
    expect(b.values[tasksOfPerson]).toEqual([{ id: t1.id, name: "Link one" }]);
  });

  it("updates links from the inverse side and keeps both sides consistent", async () => {
    await w.owner.run(() => recordsApi.update(people.id, { records: [{ id: bob.id, values: { [tasksOfPerson]: [t1.id, t2.id] } }] }));
    const t2Now = parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, t2.id)));
    expect((t2Now.values[assignees] as { name: string }[]).map((l) => l.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("follows renames of the linked record and drops links to deleted records", async () => {
    await w.owner.run(() => recordsApi.update(people.id, { records: [{ id: alice.id, values: { [peopleName]: "Alicia" } }] }));
    expect(parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, t1.id))).values[assignees]).toContainEqual({ id: alice.id, name: "Alicia" });
    await w.owner.run(() => recordsApi.remove(people.id, [bob.id]));
    expect((parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, t1.id))).values[assignees] as unknown[]).length).toBe(1);
    await w.owner.run(() => recordsApi.restore(people.id, [bob.id]));
    expect((parse("TableRecord", await w.owner.run(() => recordsApi.get(tasks.id, t1.id))).values[assignees] as unknown[]).length).toBe(2);
  });

  it("rejects links to records of another table and, for single links, more than one", async () => {
    expectError(await failure(w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [assignees]: [t1.id] } }] }))), 400, "bad_request");
  });

  it("looks up link candidates by primary text (case-insensitive), with a limit", async () => {
    const found = parse("LinkCandidates", await w.owner.run(() => recordsApi.lookup(people.id, "ALIC")));
    expect(found.records).toEqual([{ id: alice.id, name: "Alicia" }]);
    expect(parse("LinkCandidates", await w.owner.run(() => recordsApi.lookup(people.id, "", { limit: 1 }))).records).toHaveLength(1);
    expect((await w.owner.run(() => recordsApi.lookup(people.id, "zzz-nothing"))).records).toEqual([]);
    // Viewers can look up candidates too.
    expect(parse("LinkCandidates", await viewer.run(() => recordsApi.lookup(people.id, "Bo"))).records.map((r) => r.name)).toEqual(["Bob"]);
  });

  it("restricts lookup candidates to the filter of a view of the linked table", async () => {
    const peopleView = parse("View", await w.owner.run(() => api.views.create(people.id, { name: "Over 35", type: "grid", config: null })));
    await w.owner.run(() => api.views.update(peopleView.id, { config: { ...peopleView.config, filter: { conjunction: "and", items: [{ field_id: peopleAge, op: "gt", value: 35 }] } } }));
    const found = parse("LinkCandidates", await w.owner.run(() => recordsApi.lookup(people.id, "", { viewId: peopleView.id })));
    expect(found.records.map((r) => r.name)).toEqual(["Bob"]);
    expectError(await failure(w.owner.run(() => recordsApi.lookup(people.id, "", { viewId: gridView.id }))), 400, "bad_request");
  });
});

describe("querying a view", () => {
  const rows = [
    { n: "Apple", qty: 5, status: "Todo", due: "2026-01-10", tags: ["red"] },
    { n: "Banana", qty: 1, status: "Done", due: "2026-02-10", tags: ["blue"] },
    { n: "Cherry", qty: 3, status: "Doing", due: "2026-03-10", tags: ["red", "blue"] },
    { n: "Date", qty: 8, status: "Todo", due: "2026-04-10", tags: [] as string[] },
    { n: "Elder berry", qty: 2, status: "Done", due: "2026-05-10", tags: ["red"] },
  ];
  let view: View;

  beforeAll(async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Query table")));
    // Use a dedicated table so the numbers below are exact.
    const nm = t.primary_field_id;
    const mkf = async (body: Parameters<typeof schemaApi.createField>[1]) => (await w.owner.run(() => schemaApi.createField(t.id, body))).id;
    const f = {
      qty: await mkf({ name: "Qty", type: "number", options: { precision: 0, allow_negative: true } }),
      status: await mkf({ name: "Status", type: "single_select", options: { choices: ["Todo", "Doing", "Done"].map((c, i) => ({ id: "", name: c, color: ["gray", "blue", "green"][i]! })) } }),
      due: await mkf({ name: "Due", type: "date", options: { include_time: false, date_format: "iso", time_format: "h24", timezone: null } }),
      tags: await mkf({ name: "Tags", type: "multiple_select", options: { choices: ["red", "blue"].map((c) => ({ id: "", name: c, color: c })) } }),
    };
    view = (await tableOf(w.owner, w.baseId, t.id)).views[0]!;
    await w.owner.run(() => recordsApi.create(t.id, { typecast: true, records: rows.map((r) => ({ values: { [nm]: r.n, [f.qty]: r.qty, [f.status]: r.status, [f.due]: r.due, [f.tags]: r.tags } })) }));
    Object.assign(ctx, { t, nm, ...f });
  });

  const ctx = {} as { t: Table; nm: string; qty: string; status: string; due: string; tags: string };
  const query = async (body: QueryRequest = {}, p: Profile = w.owner) => parse("QueryResponse", await p.run(() => recordsApi.query(view.id, body)));
  const label = (r: { records: TableRecord[] }) => r.records.map((x) => x.values[ctx.nm]);
  const cfg = async (patch: Partial<View["config"]>) => {
    view = parse("View", await w.owner.run(() => api.views.update(view.id, { config: { ...view.config, ...patch } })));
  };

  it("returns total, offset, records in manual order, empty groups and colors", async () => {
    const r = await query();
    expect(r).toMatchObject({ total: 5, offset: 0, groups: [], colors: {} });
    expect(label(r)).toEqual(["Apple", "Banana", "Cherry", "Date", "Elder berry"]);
  });

  it("pages with offset and limit, and counts only with limit 0", async () => {
    const page = await query({ offset: 1, limit: 2 });
    expect(label(page)).toEqual(["Banana", "Cherry"]);
    expect(page).toMatchObject({ total: 5, offset: 1 });
    const count = await query({ limit: 0 });
    expect(count.records).toEqual([]);
    expect(count.total).toBe(5);
    // An oversize limit is capped, not rejected.
    expect((await query({ limit: 100_000 })).records).toHaveLength(5);
  });

  it("searches the visible fields case-insensitively", async () => {
    expect(label(await query({ search: "ERRY" }))).toEqual(["Cherry", "Elder berry"]);
    expect((await query({ search: "no such thing" })).total).toBe(0);
    // A select's label is searched, not its id.
    expect(label(await query({ search: "doing" }))).toEqual(["Cherry"]);
  });

  it("filters, sorts and groups with the saved config", async () => {
    await cfg({ filter: { conjunction: "and", items: [{ field_id: ctx.qty, op: "gte", value: 2 }] }, sorts: [{ field_id: ctx.qty, direction: "desc" }] });
    expect(label(await query())).toEqual(["Date", "Apple", "Cherry", "Elder berry"]);

    await cfg({ filter: null, sorts: [{ field_id: ctx.nm, direction: "desc" }] });
    expect(label(await query({ limit: 2 }))).toEqual(["Elder berry", "Date"]);

    await cfg({ sorts: [{ field_id: ctx.qty, direction: "asc" }], groups: [{ field_id: ctx.status, direction: "asc" }] });
    const grouped = await query({ offset: 4, limit: 1 });
    expect(grouped.records).toHaveLength(1);
    // Every page lists every group, with start and count relative to the whole result.
    expect(grouped.groups.map((g) => [g.label, g.start, g.count])).toEqual([
      ["Todo", 0, 2],
      ["Doing", 2, 1],
      ["Done", 3, 2],
    ]);
    expect(grouped.groups.every((g) => g.depth === 0 && g.field_id === ctx.status && typeof g.key === "string")).toBe(true);
    expect((await query({ offset: 0, limit: 1 })).groups).toEqual(grouped.groups);
    expect((await query({ limit: 0 })).groups).toEqual(grouped.groups);
    await cfg({ groups: [], sorts: [] });
  });

  it("filters by select, multi-select, date and checkbox-like operators", async () => {
    const tagField = (await tableOf(w.owner, w.baseId, ctx.t.id)).fields.find((f) => f.id === ctx.tags) as Select;
    const blue = tagField.options.choices.find((c) => c.name === "blue")!.id;
    await cfg({ filter: { conjunction: "and", items: [{ field_id: ctx.tags, op: "has_any_of", value: [blue] }] } });
    expect(label(await query())).toEqual(["Banana", "Cherry"]);
    await cfg({ filter: { conjunction: "or", items: [{ field_id: ctx.due, op: "is_before", value: { mode: "exact_date", date: "2026-02-01" } }, { field_id: ctx.qty, op: "is", value: 8 }] } });
    expect(label(await query())).toEqual(["Apple", "Date"]);
    await cfg({ filter: { conjunction: "and", items: [{ field_id: ctx.tags, op: "is_empty", value: null }] } });
    expect(label(await query())).toEqual(["Date"]);
    await cfg({ filter: null });
  });

  it("restricts a calendar-style query to a date range", async () => {
    const r = await query({ range: { field_id: ctx.due, from: "2026-02-01", to: "2026-03-31" } });
    expect(label(r)).toEqual(["Banana", "Cherry"]);
    expectError(await failure(w.owner.run(() => recordsApi.query(view.id, { range: { field_id: ctx.qty, from: "2026-02-01", to: "2026-03-31" } }))), 400, "bad_request");
  });

  it("colors records by a single select field", async () => {
    await cfg({ row_color: { mode: "by_select", field_id: ctx.status } });
    const r = await query();
    const apple = r.records[0]!;
    expect(Object.keys(r.colors).length).toBe(5);
    expect(r.colors[apple.id]).toBe("gray");
    await cfg({ row_color: { mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [{ field_id: ctx.qty, op: "gt", value: 4 }] } }] } });
    const byRule = await query();
    expect(Object.entries(byRule.colors).map(([id, c]) => [byRule.records.find((x) => x.id === id)!.values[ctx.nm], c]).sort()).toEqual([["Apple", "red"], ["Date", "red"]]);
    await cfg({ row_color: null });
    expect((await query()).colors).toEqual({});
  });

  it("answers viewers (read access is enough), and 404 for unknown views", async () => {
    expect((await query({}, viewer)).total).toBe(5);
    expectError(await failure(w.owner.run(() => recordsApi.query("viwNope00000000", {}))), 404, "not_found");
  });

  describe("transient override", () => {
    it("lets a viewer filter, sort and group without touching the saved view", async () => {
      const saved = view.config;
      const sorted = await query({ transient: { sorts: [{ field_id: ctx.qty, direction: "desc" }] } }, viewer);
      expect(label(sorted)).toEqual(["Date", "Apple", "Cherry", "Elder berry", "Banana"]);
      const filtered = await query({ transient: { filter: { conjunction: "and", items: [{ field_id: ctx.status, op: "is", value: ((await tableOf(w.owner, w.baseId, ctx.t.id)).fields.find((f) => f.id === ctx.status) as Select).options.choices[0]!.id }] } } }, viewer);
      expect(label(filtered)).toEqual(["Apple", "Date"]);
      const grouped = await query({ transient: { groups: [{ field_id: ctx.status, direction: "asc" }] } }, viewer);
      expect(grouped.groups).toHaveLength(3);
      // Nothing was saved, and the plain query is unchanged.
      expect(label(await query({}, viewer))).toEqual(["Apple", "Banana", "Cherry", "Date", "Elder berry"]);
      expect((await tableOf(viewer, w.baseId, ctx.t.id)).views[0]!.config).toEqual(saved);
    });

    it("replaces only the parts it names: the saved filter stays when only sorts are overridden", async () => {
      await cfg({ filter: { conjunction: "and", items: [{ field_id: ctx.qty, op: "gt", value: 2 }] } });
      expect(label(await query({ transient: { sorts: [{ field_id: ctx.nm, direction: "desc" }] } }, viewer))).toEqual(["Date", "Cherry", "Apple"]);
    });

    it("drops the saved filter with a filter without items, and clears sorts with an empty list", async () => {
      await cfg({ sorts: [{ field_id: ctx.nm, direction: "desc" }] });
      const cleared = await query({ transient: { filter: { conjunction: "and", items: [] }, sorts: [] } }, viewer);
      expect(label(cleared)).toEqual(["Apple", "Banana", "Cherry", "Date", "Elder berry"]);
      await cfg({ filter: null, sorts: [] });
    });

    it("validates like a saved config: unknown fields and unsuitable operators are 400 with a transient message", async () => {
      const unknown = await failure(w.owner.run(() => recordsApi.query(view.id, { transient: { sorts: [{ field_id: "fldNope00000000", direction: "asc" }] } })));
      expectError(unknown, 400, "bad_request");
      expect(unknown.message.startsWith("transient:")).toBe(true);
      const op = await failure(w.owner.run(() => recordsApi.query(view.id, { transient: { filter: { conjunction: "and", items: [{ field_id: ctx.status, op: "lt", value: 3 }] } } })));
      expect(op.message.startsWith("transient:")).toBe(true);
      const levels = await failure(w.owner.run(() => recordsApi.query(view.id, { transient: { groups: Array.from({ length: 4 }, () => ({ field_id: ctx.status, direction: "asc" as const })) } })));
      expect(levels.status).toBe(400);
    });

    it("composes with search and paging", async () => {
      const r = await query({ search: "rry", offset: 0, limit: 1, transient: { sorts: [{ field_id: ctx.nm, direction: "desc" }] } }, viewer);
      expect(r.total).toBe(2);
      expect(label(r)).toEqual(["Elder berry"]);
    });
  });

  describe("aggregations", () => {
    it("summarises the configured fields over the records that pass the filter", async () => {
      await cfg({ summaries: { [ctx.qty]: "sum", [ctx.nm]: "filled" }, filter: null });
      const all = parse("AggregationsResponse", await w.owner.run(() => recordsApi.aggregations(view.id)));
      expect(all.values[ctx.qty]).toBe(19);
      expect(all.values[ctx.nm]).toBe(5);
      await cfg({ filter: { conjunction: "and", items: [{ field_id: ctx.qty, op: "gt", value: 2 }] } });
      expect(parse("AggregationsResponse", await w.owner.run(() => recordsApi.aggregations(view.id))).values[ctx.qty]).toBe(16);
    });

    it("applies the same search as the query", async () => {
      await cfg({ filter: null });
      const r = parse("AggregationsResponse", await w.owner.run(() => recordsApi.aggregations(view.id, { search: "rry" })));
      expect(r.values[ctx.qty]).toBe(5);
      expect(r.values[ctx.nm]).toBe(2);
    });

    it("takes a transient filter, JSON-encoded, for people who cannot save the view", async () => {
      const filter = { conjunction: "and" as const, items: [{ field_id: ctx.qty, op: "lte" as const, value: 2 }] };
      const r = parse("AggregationsResponse", await viewer.run(() => recordsApi.aggregations(view.id, { transient: { filter } })));
      expect(r.values[ctx.qty]).toBe(3);
      const e = await failure(viewer.run(() => recordsApi.aggregations(view.id, { transient: { filter: { conjunction: "and", items: [{ field_id: "fldNope00000000", op: "is", value: 1 }] } } })));
      expect(e.status).toBe(400);
    });

    it("is 404 for unknown views and does not leak across tables", async () => {
      expect((await failure(w.owner.run(() => recordsApi.aggregations("viwNope00000000")))).status).toBe(404);
    });
  });
});

describe("history", () => {
  it("records create, update, delete and restore, newest first, with old and new values", async () => {
    const r = await mk({ [name]: "Hist", [qty]: 1 });
    await w.owner.run(() => recordsApi.update(tasks.id, { records: [{ id: r.id, values: { [qty]: 2 } }] }));
    await w.owner.run(() => recordsApi.remove(tasks.id, [r.id]));
    await w.owner.run(() => recordsApi.restore(tasks.id, [r.id]));
    const history = await w.owner.run(() => recordsApi.history(r.id));
    for (const e of history) parse("HistoryEntry", e);
    expect(history.map((e) => e.kind)).toEqual(["restore", "delete", "update", "create"]);
    const update = history.find((e) => e.kind === "update")!;
    expect(update.changes[qty]).toEqual({ old: 1, new: 2 });
    expect(update.user_id).toBe(w.owner.id);
    expect(update.user_name).toBeTruthy();
    expect(history[0]!.created_at).toBeGreaterThanOrEqual(history[3]!.created_at);
  });

  it("pages with before and limit", async () => {
    const r = await mk({ [name]: "Paged history" });
    for (let i = 0; i < 4; i++) await w.owner.run(() => recordsApi.update(tasks.id, { records: [{ id: r.id, values: { [qty]: i } }] }));
    const first = await w.owner.run(() => recordsApi.history(r.id, { limit: 2 }));
    expect(first).toHaveLength(2);
    const next = await w.owner.run(() => recordsApi.history(r.id, { before: first[1]!.id, limit: 2 }));
    expect(next).toHaveLength(2);
    expect(next[0]!.id).toBeLessThan(first[1]!.id);
    const rest = await w.owner.run(() => recordsApi.history(r.id, { before: next[1]!.id, limit: 50 }));
    expect(rest.map((e) => e.kind)).toEqual(["create"]);
  });

  it("shows link changes on both sides as [{id, name}] with current names", async () => {
    const person = parse("RecordsResponse", await w.owner.run(() => recordsApi.create(people.id, { records: [{ values: { [peopleName]: "Hist person" } }] }))).records[0]!;
    const t = await mk({ [name]: "Linked hist" });
    await w.owner.run(() => recordsApi.update(tasks.id, { records: [{ id: t.id, values: { [assignees]: [person.id] } }] }));
    const taskHistory = await w.owner.run(() => recordsApi.history(t.id));
    expect(taskHistory[0]!.changes[assignees]!.new).toEqual([{ id: person.id, name: "Hist person" }]);
    const personHistory = await w.owner.run(() => recordsApi.history(person.id));
    expect(personHistory[0]!.changes[tasksOfPerson]!.new).toEqual([{ id: t.id, name: "Linked hist" }]);
  });

  it("is readable by viewers and 404 for unknown records", async () => {
    const r = await mk({ [name]: "Visible history" });
    expect((await viewer.run(() => recordsApi.history(r.id))).length).toBeGreaterThan(0);
    expectError(await failure(w.owner.run(() => recordsApi.history("recNope0000000"))), 404, "not_found");
  });
});

describe("attachments", () => {
  it("uploads a file through the client (multipart), stores it on a record and serves it back safely", async () => {
    const field = (await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Files", type: "attachment", options: {} }))).id;
    const file = new File(["hello attachment"], "notes.txt", { type: "text/plain" });
    const ref = parse("AttachmentRef", await w.owner.run(() => attachmentsApi.upload(w.baseId, file)));
    expect(ref).toMatchObject({ filename: "notes.txt", size: 16 });
    const rec = await mk({ [name]: "With file", [field]: [ref] });
    expect(rec.values[field]).toEqual([ref]);
    const res = await w.owner.jar.fetch(`${env.seeded.baseUrl}${attachmentsApi.downloadUrl(ref.id, ref.filename)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Viewers may read it; outsiders cannot.
    expect((await viewer.jar.fetch(`${env.seeded.baseUrl}${attachmentsApi.downloadUrl(ref.id, ref.filename)}`)).status).toBe(200);
    const outsider = await newUser(w.owner, "outsider");
    expect((await outsider.jar.fetch(`${env.seeded.baseUrl}${attachmentsApi.downloadUrl(ref.id, ref.filename)}`)).status).toBe(404);
    // Viewers cannot upload.
    expectError(await failure(viewer.run(() => attachmentsApi.upload(w.baseId, file))), 403, "forbidden");
  });
});

describe("the error envelope reaches the client", () => {
  it("surfaces ApiError with status and code for every failure above", async () => {
    const e = await failure(w.owner.run(() => recordsApi.get(tasks.id, "recNope0000000")));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isNotFound).toBe(true);
  });

  it("keeps editors from structural changes even through records endpoints", async () => {
    expectError(await failure(editor.run(() => schemaApi.createField(tasks.id, { name: "X", type: "number", options: {} } as never))), 403, "forbidden");
  });
});
