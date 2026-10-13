/**
 * What the automations UI depends on, against the real server: every trigger and action type as
 * the editor sends it (and what the server stores), the exact wording shape of validation errors
 * (`action N: ...`, which the editor attaches to that action's card), the on/off rules, schedule
 * next-run times, test runs in the history, and the setup status that decides whether the
 * send_email action can be offered. `collab.contract.test.ts` covers the webhook and paging flows.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { recordsApi, schemaApi } from "../src/api/records";
import { parseSaveError } from "../src/automations/model";
import type { ActionStep, Automation, Filter, Table } from "../src/api/types";
import { createWorld, expectError, failure, fieldNamed, joinBase, newUser, Profile, seeded, tableOf, type World } from "./support";
import { rawFetch } from "./cookieJar";
import { parse, parseList } from "./typecheck";

let w: World;
let tasks: Table;
let people: Table;
let formViewId = "";
let outsider: Profile;
let editor: Profile;
let nameId = "";
let qtyId = "";

const create = (name: string, body: Omit<Parameters<typeof api.automations.create>[1], "name">) => w.owner.run(() => api.automations.create(w.baseId, { name, ...body }));
const notify = (message = "hello"): ActionStep => ({ type: "notify", user_ids: [w.owner.id], message });

beforeAll(async () => {
  w = await createWorld("AutomationsUI");
  tasks = w.base.tables[0]!;
  nameId = tasks.primary_field_id;
  qtyId = (await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Qty", type: "number", options: { precision: 0, allow_negative: true } }))).id;
  people = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "People")));
  formViewId = parse("View", await w.owner.run(() => api.views.create(tasks.id, { name: "Signup", type: "form", personal: false, config: null }))).id;
  tasks = await tableOf(w.owner, w.baseId, tasks.id);
  await w.owner.run(() => recordsApi.create(tasks.id, { records: [{ values: { [nameId]: "Alpha", [qtyId]: 7 } }] }));
  outsider = await newUser(w.owner, "outsider");
  editor = await newUser(w.owner, "editor");
  await joinBase(w.owner, w.baseId, editor, "editor");
});

describe("every trigger type is stored as the editor sends it", () => {
  it("record_created, record_updated (with and without fields), record_matches, form_submitted, schedule and webhook", async () => {
    const filter: Filter = { conjunction: "and", items: [{ field_id: qtyId, op: "gt", value: 5 }] };
    const triggers = [
      { type: "record_created" as const, table_id: tasks.id },
      { type: "record_updated" as const, table_id: tasks.id, field_ids: [] },
      { type: "record_updated" as const, table_id: tasks.id, field_ids: [nameId, qtyId] },
      { type: "record_matches" as const, table_id: tasks.id, filter },
      { type: "record_matches" as const, table_id: tasks.id, filter: { conjunction: "and" as const, items: [] } },
      { type: "form_submitted" as const, view_id: formViewId },
      { type: "schedule" as const, cron: "30 8 * * 1", timezone: "Europe/Berlin" },
      { type: "webhook" as const },
    ];
    for (const trigger of triggers) {
      const made = parse("Automation", await create(`trigger ${trigger.type}`, { trigger, actions: [notify()] }));
      expect(made.trigger).toEqual(trigger);
      const read = parse("Automation", await w.owner.run(() => api.automations.get(made.id)));
      expect(read.trigger).toEqual(trigger);
    }
  });

  it("trims the cron expression and time zone it stores", async () => {
    const made = parse("Automation", await create("padded", { trigger: { type: "schedule", cron: "  0 9 * * *  ", timezone: " UTC " }, actions: [notify()] }));
    expect(made.trigger).toEqual({ type: "schedule", cron: "0 9 * * *", timezone: "UTC" });
  });

  it("rejects what the editor prevents too: computed watched fields, a non-form view, a deleted table", async () => {
    const formula = parse("Field", await w.owner.run(() => schemaApi.createField(tasks.id, { name: "Double", type: "formula", options: { expression: "{Qty}*2", result_type: "number", format: { kind: "number", precision: 0 } } })));
    const gridView = tasks.views.find((v) => v.type === "grid")!;
    expectError(await failure(create("computed", { trigger: { type: "record_updated", table_id: tasks.id, field_ids: [formula.id] }, actions: [] })), 400, "bad_request");
    expectError(await failure(create("not a form", { trigger: { type: "form_submitted", view_id: gridView.id }, actions: [] })), 400, "bad_request");
    expectError(await failure(create("gone", { trigger: { type: "record_created", table_id: "tblGone000000" }, actions: [] })), 400, "bad_request");
  });
});

describe("every action type is stored as the editor sends it", () => {
  it("create_record and update_record: values by name are re-keyed to field ids, templates stay as text", async () => {
    const actions: ActionStep[] = [
      { type: "create_record", table_id: people.id, values: { Name: "{{trigger.record.fields.Name}}" } },
      { type: "update_record", table_id: tasks.id, record_id: "{{trigger.record.id}}", values: { [qtyId]: 12, Name: "Seen" } },
    ];
    const made = parse("Automation", await create("records", { trigger: { type: "record_created", table_id: tasks.id }, actions }));
    const peopleName = fieldNamed(people, "Name").id;
    expect(made.actions[0]).toMatchObject({ type: "create_record", table_id: people.id, values: { [peopleName]: "{{trigger.record.fields.Name}}" } });
    expect(made.actions[1]).toMatchObject({ type: "update_record", table_id: tasks.id, record_id: "{{trigger.record.id}}", values: { [qtyId]: 12, [nameId]: "Seen" } });
  });

  it("http_request keeps method, URL, headers and body; notify keeps the people and message", async () => {
    const actions: ActionStep[] = [
      { type: "http_request", method: "PUT", url: "https://example.com/hook/{{trigger.record.id}}", headers: { "Content-Type": "application/json", "X-Token": "abc" }, body: '{"id": "{{trigger.record.id}}"}' },
      { type: "http_request", method: "GET", url: "https://example.com/ping", headers: {} },
      notify("done {{steps.1.status}}"),
    ];
    const made = parse("Automation", await create("calls", { trigger: { type: "record_created", table_id: tasks.id }, actions }));
    expect(made.actions[0]).toMatchObject(actions[0]!);
    expect(made.actions[1]).toMatchObject({ type: "http_request", method: "GET", url: "https://example.com/ping", headers: {} });
    expect(made.actions[1]!.type === "http_request" && (made.actions[1].body ?? null)).toBeNull();
    expect(made.actions[2]).toMatchObject({ type: "notify", user_ids: [w.owner.id], message: "done {{steps.1.status}}" });
  });

  it("keeps a condition (a view filter) on an action, and returns null when there is none", async () => {
    const condition: Filter = { conjunction: "and", items: [{ field_id: qtyId, op: "gte", value: 3 }] };
    const made = parse("Automation", await create("conditional", { trigger: { type: "record_created", table_id: tasks.id }, actions: [{ ...notify(), condition }, notify("always")] }));
    expect(made.actions[0]!.condition).toEqual(condition);
    expect(made.actions[1]!.condition ?? null).toBeNull();
  });

  it("send_email is refused when the server has no SMTP, with the action number in the message", async () => {
    const e = await failure(create("mail", { trigger: { type: "record_created", table_id: tasks.id }, actions: [notify(), { type: "send_email", to: "a@example.com", subject: "s", body: "b" }] }));
    expectError(e, 400, "bad_request");
    expect(e.message).toMatch(/^action 2: email is not configured/);
    expect(parseSaveError(e.message)).toEqual({ action: 1, text: expect.stringMatching(/^email is not configured/) });
  });

  it("the setup status says email is not configured here (the editor disables send_email on that)", async () => {
    const res = await rawFetch(`${seeded.baseUrl}/api/setup`, {});
    expect(parse("SetupStatus", await res.json()).email_enabled).toBe(false);
  });
});

describe("validation errors name the action", () => {
  const trigger = { type: "record_created" as const, table_id: "" };
  const t = () => ({ ...trigger, table_id: tasks.id });

  it("prefixes action errors with 'action N: ' (1-based), which the editor parses", async () => {
    const cases: { actions: ActionStep[]; n: number; text: RegExp }[] = [
      { actions: [{ type: "http_request", method: "GET", url: "ftp://example.com", headers: {} }], n: 1, text: /http:\/\/ or https:\/\// },
      { actions: [notify(), { type: "update_record", table_id: tasks.id, record_id: "", values: { Name: "x" } }], n: 2, text: /record_id is required/ },
      { actions: [notify(), notify(), { type: "create_record", table_id: tasks.id, values: { Qty: "not a number" } }], n: 3, text: /Qty/ },
      { actions: [{ type: "notify", user_ids: [], message: "x" }], n: 1, text: /at least one user/ },
      { actions: [{ type: "notify", user_ids: [w.owner.id], message: "{{trigger.body.x}}" }], n: 1, text: /trigger\.body/ },
      { actions: [{ type: "create_record", table_id: tasks.id, values: { Nope: "x" } }], n: 1, text: /unknown field "Nope"/ },
    ];
    for (const c of cases) {
      const e = await failure(create("bad", { trigger: t(), actions: c.actions }));
      expectError(e, 400, "bad_request");
      const parsed = parseSaveError(e.message);
      expect(parsed.action, e.message).toBe(c.n - 1);
      expect(parsed.text).toMatch(c.text);
    }
  });

  it("does not prefix trigger and name errors", async () => {
    for (const body of [
      { name: "bad cron", trigger: { type: "schedule" as const, cron: "nope", timezone: "UTC" }, actions: [] },
      { name: "too often", trigger: { type: "schedule" as const, cron: "* * * * *", timezone: "UTC" }, actions: [] },
      { name: "zone", trigger: { type: "schedule" as const, cron: "0 9 * * *", timezone: "Mars/Olympus" }, actions: [] },
      { name: "table", trigger: { type: "record_created" as const, table_id: "tblGone000000" }, actions: [] },
    ]) {
      const e = await failure(w.owner.run(() => api.automations.create(w.baseId, body)));
      expectError(e, 400, "bad_request");
      expect(parseSaveError(e.message).action, e.message).toBeNull();
    }
  });

  it("allows 25 actions and refuses 26", async () => {
    const many = (n: number): ActionStep[] => Array.from({ length: n }, (_, i) => notify(`m${i}`));
    expect(parse("Automation", await create("25", { trigger: t(), actions: many(25) })).actions).toHaveLength(25);
    const e = await failure(create("26", { trigger: t(), actions: many(26) }));
    expectError(e, 400, "bad_request");
    expect(e.message).toMatch(/at most 25 actions/);
  });

  it("notify only accepts people with access to the base", async () => {
    const e = await failure(create("outsider", { trigger: t(), actions: [{ type: "notify", user_ids: [outsider.id], message: "x" }] }));
    expect(parseSaveError(e.message)).toEqual({ action: 0, text: expect.stringMatching(/does not have access/) });
  });

  it("lists the base's collaborators for the notify picker", async () => {
    const ids = parseList("Collaborator", await w.owner.run(() => api.bases.collaborators(w.baseId))).map((c) => c.id);
    expect(ids).toContain(w.owner.id);
    expect(ids).toContain(editor.id);
    expect(ids).not.toContain(outsider.id);
  });
});

describe("turning automations on and off", () => {
  it("refuses to turn on an automation without actions, in create and in update", async () => {
    const e = await failure(create("empty on", { enabled: true, trigger: { type: "webhook" }, actions: [] }));
    expectError(e, 400, "bad_request");
    expect(e.message).toMatch(/at least one action/);
    const off = parse("Automation", await create("empty off", { trigger: { type: "webhook" }, actions: [] }));
    expect(off.enabled).toBe(false);
    expectError(await failure(w.owner.run(() => api.automations.update(off.id, { enabled: true }))), 400, "bad_request");
  });

  it("an enabled schedule has a next run in the future, a disabled one has none", async () => {
    const made = parse("Automation", await create("sched", { enabled: true, trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Europe/Berlin" }, actions: [notify()] }));
    expect(made.next_run_at).toBeGreaterThan(Date.now());
    expect(made.next_run_at! - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 1000);
    const off = parse("Automation", await w.owner.run(() => api.automations.update(made.id, { enabled: false })));
    expect(off.next_run_at ?? null).toBeNull();
    const on = parse("Automation", await w.owner.run(() => api.automations.update(made.id, { enabled: true })));
    expect(on.next_run_at).toBeGreaterThan(Date.now());
    // Changing the schedule moves the next run.
    const weekly = parse("Automation", await w.owner.run(() => api.automations.update(made.id, { trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "Europe/Berlin" } })));
    expect(weekly.next_run_at).toBeGreaterThan(Date.now());
    expect(weekly.trigger).toEqual({ type: "schedule", cron: "0 9 * * 1", timezone: "Europe/Berlin" });
  });

  it("a rename alone does not need valid actions or send them", async () => {
    const made = parse("Automation", await create("rename me", { trigger: { type: "record_created", table_id: tasks.id }, actions: [notify()] }));
    const renamed = parse("Automation", await w.owner.run(() => api.automations.update(made.id, { name: "renamed" })));
    expect(renamed).toMatchObject({ name: "renamed", actions: made.actions });
  });

  it("only webhook automations have a token to rotate", async () => {
    const made = parse("Automation", await create("not a hook", { trigger: { type: "record_created", table_id: tasks.id }, actions: [notify()] }));
    const e = await failure(w.owner.run(() => api.automations.update(made.id, { rotate_webhook_token: true })));
    expectError(e, 400, "bad_request");
  });

  it("switching a record automation to a webhook issues a token in that response", async () => {
    const made = parse("Automation", await create("becomes hook", { trigger: { type: "record_created", table_id: tasks.id }, actions: [notify()] }));
    expect(made.webhook_token ?? null).toBeNull();
    const hook = parse("Automation", await w.owner.run(() => api.automations.update(made.id, { trigger: { type: "webhook" } })));
    expect(hook.webhook_token).toMatch(/^obh_/);
    expect(parse("Automation", await w.owner.run(() => api.automations.get(made.id))).webhook_token ?? null).toBeNull();
  });
});

describe("testing from the editor", () => {
  it("a real test run is in the history, flagged as a test, with the step log the UI shows", async () => {
    const made = parse("Automation", await create("real test", { trigger: { type: "record_created", table_id: tasks.id }, actions: [{ type: "create_record", table_id: people.id, values: { Name: "{{trigger.record.fields.Name}}" } }, notify("made {{steps.1.record_id}}")] }));
    const dry = parse("TestResult", await w.owner.run(() => api.automations.test(made.id, { dry_run: true })));
    expect(dry).toMatchObject({ dry_run: true, status: "succeeded" });
    expect(dry.log.map((l) => [l.index, l.action, l.status])).toEqual([[0, "create_record", "succeeded"], [1, "notify", "succeeded"]]);
    expect((await w.owner.run(() => api.automations.runs(made.id))).total).toBe(0);

    const real = parse("TestResult", await w.owner.run(() => api.automations.test(made.id, { dry_run: false })));
    expect(real).toMatchObject({ dry_run: false, status: "succeeded" });
    const page = parse("RunsPage", await w.owner.run(() => api.automations.runs(made.id)));
    expect(page.total).toBe(1);
    const run = page.runs[0]!;
    expect(run).toMatchObject({ id: real.run_id, status: "succeeded", attempts: 1 });
    expect(run.trigger_data).toMatchObject({ type: "record_created", test: true });
    expect(run.trigger_data).toMatchObject({ record: { table_id: tasks.id } });
    expect(run.log).toHaveLength(2);
    expect(run.finished_at).toBeGreaterThanOrEqual(run.started_at ?? run.created_at);
    const peopleRows = await w.owner.run(() => recordsApi.query(people.views[0]!.id, { limit: 10 }));
    expect(peopleRows.records.map((r) => r.values[fieldNamed(people, "Name").id])).toContain("Alpha");
  });

  it("a failed step is reported in the log and the result, not as an HTTP error", async () => {
    const made = parse("Automation", await create("fails", { trigger: { type: "webhook" }, actions: [{ type: "update_record", table_id: tasks.id, record_id: "recNope0000000", values: { Name: "x" } }] }));
    const result = parse("TestResult", await w.owner.run(() => api.automations.test(made.id, { dry_run: false })));
    expect(w.owner.status).toBe(200);
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(result.log[0]).toMatchObject({ index: 0, action: "update_record", status: "failed" });
    expect(result.log[0]!.error).toBeTruthy();
  });

  it("webhook tests take the sample body; a schedule test takes no record", async () => {
    const hook = parse("Automation", await create("body test", { trigger: { type: "webhook" }, actions: [notify("sku {{trigger.body.sku}}")] }));
    const result = parse("TestResult", await w.owner.run(() => api.automations.test(hook.id, { dry_run: true, body: { sku: "Z-9" } })));
    expect(result.log[0]!.output).toMatchObject({ message: "sku Z-9" });
    const sched = parse("Automation", await create("sched test", { trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" }, actions: [notify("at {{trigger.type}}")] }));
    expect(parse("TestResult", await w.owner.run(() => api.automations.test(sched.id, { dry_run: true }))).log[0]!.output).toMatchObject({ message: "at schedule" });
    expectError(await failure(w.owner.run(() => api.automations.test(sched.id, { dry_run: true, record_id: "recX" }))), 400, "bad_request");
  });

  it("a form trigger tests against a record of the form's table; an empty table cannot be tested", async () => {
    const form = parse("Automation", await create("form test", { trigger: { type: "form_submitted", view_id: formViewId }, actions: [notify("from {{trigger.record.fields.Name}}")] }));
    expect(parse("TestResult", await w.owner.run(() => api.automations.test(form.id, { dry_run: true }))).log[0]!.output).toMatchObject({ message: "from Alpha" });
    const empty = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Empty")));
    expect((await w.owner.run(() => recordsApi.query(empty.views[0]!.id, { limit: 0 }))).total).toBe(0);
    const none = parse("Automation", await create("empty table", { trigger: { type: "record_created", table_id: empty.id }, actions: [notify()] }));
    const e = await failure(w.owner.run(() => api.automations.test(none.id, { dry_run: true })));
    expectError(e, 400, "bad_request");
    expect(e.message).toMatch(/no records/);
  });
});

describe("lists and deletes", () => {
  it("lists every automation of the base as full definitions, and not those of other bases", async () => {
    const list = parseList("Automation", await w.owner.run(() => api.automations.list(w.baseId)));
    expect(list.length).toBeGreaterThan(5);
    expect(list.every((a) => a.base_id === w.baseId)).toBe(true);
    expect(list.every((a) => a.webhook_token === null || a.webhook_token === undefined)).toBe(true);
    const other = await createWorld("OtherBase");
    expect(parseList("Automation", await other.owner.run(() => api.automations.list(other.baseId)))).toEqual([]);
  });

  it("deleting an automation removes its runs too", async () => {
    const made = parse("Automation", await create("to delete", { trigger: { type: "webhook" }, actions: [notify()] }));
    await w.owner.run(() => api.automations.test(made.id, { dry_run: false }));
    expect((await w.owner.run(() => api.automations.runs(made.id))).total).toBe(1);
    await w.owner.run(() => api.automations.remove(made.id));
    expectError(await failure(w.owner.run(() => api.automations.runs(made.id))), 404, "not_found");
  });

  it("an editor can read runs but nothing else about automations", async () => {
    const made: Automation = parse("Automation", await create("for editors", { trigger: { type: "webhook" }, actions: [notify()] }));
    expect(parse("RunsPage", await editor.run(() => api.automations.runs(made.id))).total).toBe(0);
    expectError(await failure(editor.run(() => api.automations.list(w.baseId))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.automations.test(made.id, { dry_run: true }))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.automations.update(made.id, { enabled: true }))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.automations.remove(made.id))), 403, "forbidden");
  });
});
