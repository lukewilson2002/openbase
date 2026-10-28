/**
 * Collaboration and automation through the real API client against the real server: comments
 * (with @mentions that notify), notifications, and automations (CRUD, the dry-run test endpoint,
 * a real run through the webhook, run history). Every response is checked against the
 * generated bindings.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { commentsApi, recordsApi, schemaApi } from "../src/api/records";
import type { Automation, Table, TableRecord } from "../src/api/types";
import { rawFetch } from "./cookieJar";
import { createWorld, expectError, failure, joinBase, newUser, Profile, seeded, sleep, type World } from "./support";
import { parse, parseList } from "./typecheck";

let w: World;
let table: Table;
let nameField = "";
let rec: TableRecord;
let commenter: Profile;
let viewer: Profile;
let editor: Profile;
let outsider: Profile;

beforeAll(async () => {
  w = await createWorld("Collab");
  table = w.base.tables[0]!;
  nameField = table.primary_field_id;
  await w.owner.run(() => schemaApi.createField(table.id, { name: "Qty", type: "number", options: { precision: 0, allow_negative: true } }));
  rec = (await w.owner.run(() => recordsApi.create(table.id, { records: [{ values: { [nameField]: "Commented record" } }] }))).records[0]!;
  commenter = await newUser(w.owner, "commenter");
  viewer = await newUser(w.owner, "viewer");
  editor = await newUser(w.owner, "editor");
  outsider = await newUser(w.owner, "outsider");
  await joinBase(w.owner, w.baseId, commenter, "commenter");
  await joinBase(w.owner, w.baseId, viewer, "viewer");
  await joinBase(w.owner, w.baseId, editor, "editor");
});

describe("comments", () => {
  let commentId = "";

  it("starts empty, as a bare array", async () => {
    expect(parseList("Comment", await w.owner.run(() => commentsApi.list(rec.id)))).toEqual([]);
  });

  it("lets a commenter comment (201 Comment) with the author's name", async () => {
    const c = parse("Comment", await commenter.run(() => commentsApi.create(rec.id, "First thoughts")));
    expect(commenter.status).toBe(201);
    expect(c).toMatchObject({ record_id: rec.id, body: "First thoughts", user_id: commenter.id });
    expect(c.user_name).toBeTruthy();
    commentId = c.id;
  });

  it("lists oldest first, to viewers too", async () => {
    await w.owner.run(() => commentsApi.create(rec.id, "Second"));
    const list = parseList("Comment", await viewer.run(() => commentsApi.list(rec.id)));
    expect(list.map((c) => c.body)).toEqual(["First thoughts", "Second"]);
    expect(list[0]!.created_at).toBeLessThanOrEqual(list[1]!.created_at);
  });

  it("keeps viewers from commenting and outsiders from reading", async () => {
    expectError(await failure(viewer.run(() => commentsApi.create(rec.id, "I am only watching"))), 403, "forbidden");
    expectError(await failure(outsider.run(() => commentsApi.list(rec.id))), 404, "not_found");
  });

  it("rejects empty and oversize bodies", async () => {
    expectError(await failure(commenter.run(() => commentsApi.create(rec.id, "   "))), 400, "bad_request");
    expectError(await failure(commenter.run(() => commentsApi.create(rec.id, "x".repeat(20_000)))), 400, "bad_request");
  });

  it("edits a comment as its author only (200 Comment)", async () => {
    const edited = parse("Comment", await commenter.run(() => commentsApi.update(commentId, "First thoughts (edited)")));
    expect(commenter.status).toBe(200);
    expect(edited).toMatchObject({ id: commentId, body: "First thoughts (edited)" });
    expect(edited.updated_at).toBeGreaterThanOrEqual(edited.created_at);
    expectError(await failure(w.owner.run(() => commentsApi.update(commentId, "hijacked"))), 403, "forbidden");
  });

  it("deletes with 204: the author, or a base owner for someone else's comment; nobody else", async () => {
    const mine = parse("Comment", await commenter.run(() => commentsApi.create(rec.id, "to delete")));
    const gone = await commenter.run(() => commentsApi.remove(mine.id));
    expect(gone).toBeUndefined();
    expect(commenter.status).toBe(204);
    const other = parse("Comment", await commenter.run(() => commentsApi.create(rec.id, "owner removes")));
    expectError(await failure(editor.run(() => commentsApi.remove(other.id))), 403, "forbidden");
    await w.owner.run(() => commentsApi.remove(other.id));
    expect(w.owner.status).toBe(204);
    expect((await w.owner.run(() => commentsApi.list(rec.id))).map((c) => c.body)).not.toContain("owner removes");
    expectError(await failure(commenter.run(() => commentsApi.remove(mine.id))), 404, "not_found");
  });
});

describe("mentions and notifications", () => {
  it("notifies a mentioned collaborator, newest first with an unread count", async () => {
    const before = parse("NotificationsResponse", await editor.run(api.notifications.list));
    parse("Comment", await commenter.run(() => commentsApi.create(rec.id, `Please look, @[Editor](${editor.id})`)));
    const after = parse("NotificationsResponse", await editor.run(api.notifications.list));
    expect(after.unread).toBe(before.unread + 1);
    const n = after.notifications[0]!;
    expect(n.kind).toBe("mention");
    expect(n.read_at ?? null).toBeNull();
    expect(n.payload).toMatchObject({ record_id: rec.id });
  });

  it("does not notify people who cannot read the base, nor yourself", async () => {
    await commenter.run(() => commentsApi.create(rec.id, `@[Out](${outsider.id}) and @[Me](${commenter.id})`));
    expect(parse("NotificationsResponse", await outsider.run(api.notifications.list)).notifications).toEqual([]);
    expect(parse("NotificationsResponse", await commenter.run(api.notifications.list)).notifications.filter((n) => n.kind === "mention")).toEqual([]);
  });

  it("marks selected notifications read, then everything", async () => {
    await commenter.run(() => commentsApi.create(rec.id, `again @[Editor](${editor.id})`));
    const list = parse("NotificationsResponse", await editor.run(api.notifications.list));
    expect(list.unread).toBeGreaterThanOrEqual(2);
    const first = list.notifications[0]!;
    expect(parse("OkResponse", await editor.run(() => api.notifications.markRead([first.id])))).toEqual({ ok: true });
    const some = parse("NotificationsResponse", await editor.run(api.notifications.list));
    expect(some.unread).toBe(list.unread - 1);
    expect(some.notifications.find((n) => n.id === first.id)!.read_at).toBeGreaterThan(0);
    expect(parse("OkResponse", await editor.run(() => api.notifications.markRead()))).toEqual({ ok: true });
    expect(parse("NotificationsResponse", await editor.run(api.notifications.list)).unread).toBe(0);
  });

  it("ignores ids of other users' notifications", async () => {
    await commenter.run(() => commentsApi.create(rec.id, `third @[Viewer](${viewer.id})`));
    const theirs = parse("NotificationsResponse", await viewer.run(api.notifications.list));
    expect(theirs.unread).toBe(1);
    await editor.run(() => api.notifications.markRead(theirs.notifications.map((n) => n.id)));
    expect(parse("NotificationsResponse", await viewer.run(api.notifications.list)).unread).toBe(1);
  });

  it("requires a session", async () => {
    const anon = new Profile("anon");
    expectError(await failure(anon.run(api.notifications.list)), 401, "unauthorized");
  });
});

describe("automations", () => {
  let automation: Automation;

  const notify = (message: string) => ({ type: "notify" as const, user_ids: [w.owner.id], message });

  it("creates an automation (201), off by default, with the trigger and actions as sent", async () => {
    automation = parse(
      "Automation",
      await w.owner.run(() => api.automations.create(w.baseId, { name: "  Greeter ", trigger: { type: "record_created", table_id: table.id }, actions: [notify("hello {{trigger.record.fields.Name}}")] })),
    );
    expect(w.owner.status).toBe(201);
    expect(automation).toMatchObject({ name: "Greeter", enabled: false, base_id: w.baseId, created_by: w.owner.id });
    expect(automation.trigger).toEqual({ type: "record_created", table_id: table.id });
    expect(automation.webhook_token ?? null).toBeNull();
  });

  it("reads it back, lists it, renames and enables it", async () => {
    expect(parse("Automation", await w.owner.run(() => api.automations.get(automation.id)))).toEqual(automation);
    expect(parseList("Automation", await w.owner.run(() => api.automations.list(w.baseId))).map((a) => a.id)).toContain(automation.id);
    const updated = parse("Automation", await w.owner.run(() => api.automations.update(automation.id, { name: "Greeter v2", enabled: true })));
    expect(w.owner.status).toBe(200);
    expect(updated).toMatchObject({ name: "Greeter v2", enabled: true });
    automation = updated;
  });

  it("replaces the trigger and the actions", async () => {
    const updated = parse(
      "Automation",
      await w.owner.run(() => api.automations.update(automation.id, { trigger: { type: "record_updated", table_id: table.id, field_ids: [] }, actions: [notify("changed"), notify("twice")] })),
    );
    expect(updated.trigger.type).toBe("record_updated");
    expect(updated.actions).toHaveLength(2);
    automation = updated;
  });

  it("rejects invalid definitions with the reason", async () => {
    expectError(await failure(w.owner.run(() => api.automations.create(w.baseId, { name: "", trigger: { type: "webhook" }, actions: [] }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => api.automations.create(w.baseId, { name: "bad table", trigger: { type: "record_created", table_id: "tblNope0000000" }, actions: [] }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => api.automations.create(w.baseId, { name: "bad cron", trigger: { type: "schedule", cron: "not a cron", timezone: "UTC" }, actions: [] }))), 400, "bad_request");
    expectError(await failure(w.owner.run(() => api.automations.create(w.baseId, { name: "bad url", trigger: { type: "webhook" }, actions: [{ type: "http_request", method: "GET", url: "ftp://example.com", headers: {} }] }))), 400, "bad_request");
  });

  it("keeps automations to creators: editors can neither read nor write definitions", async () => {
    expectError(await failure(editor.run(() => api.automations.list(w.baseId))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.automations.get(automation.id))), 403, "forbidden");
    expectError(await failure(editor.run(() => api.automations.create(w.baseId, { name: "x", trigger: { type: "webhook" }, actions: [] }))), 403, "forbidden");
    expectError(await failure(outsider.run(() => api.automations.get(automation.id))), 404, "not_found");
  });

  describe("testing", () => {
    it("dry-runs by default: renders templates and sends or writes nothing", async () => {
      const result = parse("TestResult", await w.owner.run(() => api.automations.test(automation.id)));
      expect(result).toMatchObject({ dry_run: true, status: "succeeded" });
      expect(result.run_id ?? null).toBeNull();
      expect(result.log.map((l) => l.status)).toEqual(["succeeded", "succeeded"]);
      expect(result.log[0]!.action).toBe("notify");
    });

    it("uses the requested record as the trigger record", async () => {
      const created = await w.owner.run(() => api.automations.create(w.baseId, { name: "Templated", trigger: { type: "record_created", table_id: table.id }, actions: [notify("record {{trigger.record.fields.Name}}")] }));
      const result = parse("TestResult", await w.owner.run(() => api.automations.test(created.id, { record_id: rec.id, dry_run: true })));
      expect(result.log[0]!.output).toMatchObject({ message: "record Commented record" });
      expectError(await failure(w.owner.run(() => api.automations.test(created.id, { record_id: "recNope0000000", dry_run: true }))), 400, "bad_request");
    });

    it("a dry run of a create_record action writes nothing", async () => {
      const writer = await w.owner.run(() =>
        api.automations.create(w.baseId, { name: "Writer", trigger: { type: "webhook" }, actions: [{ type: "create_record", table_id: table.id, values: { Name: "from automation" } }] }),
      );
      const before = (await w.owner.run(() => recordsApi.query(table.views[0]!.id, { limit: 0 }))).total;
      const dry = parse("TestResult", await w.owner.run(() => api.automations.test(writer.id, { dry_run: true })));
      expect(dry.status).toBe("succeeded");
      expect((await w.owner.run(() => recordsApi.query(table.views[0]!.id, { limit: 0 }))).total).toBe(before);
      const real = parse("TestResult", await w.owner.run(() => api.automations.test(writer.id, { dry_run: false })));
      expect(real).toMatchObject({ dry_run: false, status: "succeeded" });
      expect(real.run_id).toBeGreaterThan(0);
      expect((await w.owner.run(() => recordsApi.query(table.views[0]!.id, { limit: 0 }))).total).toBe(before + 1);
    });
  });

  describe("webhooks and run history", () => {
    let hook: Automation;
    let token = "";

    it("returns the webhook token once, on create", async () => {
      hook = parse("Automation", await w.owner.run(() => api.automations.create(w.baseId, { name: "Hook", enabled: true, trigger: { type: "webhook" }, actions: [notify("hooked {{trigger.body.sku}}")] })));
      expect(hook.webhook_token).toMatch(/^obh_/);
      token = hook.webhook_token!;
      expect(parse("Automation", await w.owner.run(() => api.automations.get(hook.id))).webhook_token ?? null).toBeNull();
    });

    it("accepts a webhook call (202), runs it, and records the run", async () => {
      const post = (body: unknown) =>
        rawFetch(`${seeded.baseUrl}/api/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.1" }, body: JSON.stringify(body) });
      const res = await post({ sku: "A-1" });
      expect(res.status).toBe(202);
      const accepted = parse("WebhookAccepted", await res.json());
      expect(accepted.ok).toBe(true);

      let runs = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id)));
      for (let i = 0; i < 50 && !runs.runs.some((r) => r.status === "succeeded"); i++) {
        await sleep(100);
        runs = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id)));
      }
      expect(runs.total).toBe(1);
      expect(runs.runs[0]).toMatchObject({ id: accepted.run_id, status: "succeeded", automation_id: hook.id });
      expect(runs.runs[0]!.log[0]).toMatchObject({ action: "notify", status: "succeeded" });
      expect(runs.next_before ?? null).toBeNull();
    });

    it("pages the run history newest first", async () => {
      for (let i = 0; i < 4; i++) {
        const r = await rawFetch(`${seeded.baseUrl}/api/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.1" }, body: JSON.stringify({ sku: `B-${i}` }) });
        expect(r.status).toBe(202);
      }
      let all = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id, { limit: 50 })));
      for (let i = 0; i < 50 && all.runs.filter((r) => r.status === "succeeded").length < 5; i++) {
        await sleep(100);
        all = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id, { limit: 50 })));
      }
      expect(all.total).toBe(5);
      const first = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id, { limit: 2 })));
      expect(first.runs.map((r) => r.id)).toEqual(all.runs.slice(0, 2).map((r) => r.id));
      expect(first.next_before).toBe(first.runs[1]!.id);
      const next = parse("RunsPage", await w.owner.run(() => api.automations.runs(hook.id, { limit: 2, before: first.next_before! })));
      expect(next.runs.map((r) => r.id)).toEqual(all.runs.slice(2, 4).map((r) => r.id));
      expect(first.runs[0]!.id).toBeGreaterThan(first.runs[1]!.id);
    });

    it("lets editors read the run history but not the definition", async () => {
      expect(parse("RunsPage", await editor.run(() => api.automations.runs(hook.id))).total).toBe(5);
      expectError(await failure(viewer.run(() => api.automations.runs(hook.id))), 403, "forbidden");
    });

    it("rotates the token: the old one stops working", async () => {
      const rotated = parse("Automation", await w.owner.run(() => api.automations.update(hook.id, { rotate_webhook_token: true })));
      expect(rotated.webhook_token).toMatch(/^obh_/);
      expect(rotated.webhook_token).not.toBe(token);
      const old = await rawFetch(`${seeded.baseUrl}/api/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.2" }, body: "{}" });
      expect(old.status).toBe(404);
      expect(((await old.json()) as { error: { code: string } }).error.code).toBe("not_found");
      const fresh = await rawFetch(`${seeded.baseUrl}/api/hooks/${rotated.webhook_token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.2" }, body: "{}" });
      expect(fresh.status).toBe(202);
    });

    it("answers 404 for a disabled automation's webhook", async () => {
      const rotated = parse("Automation", await w.owner.run(() => api.automations.update(hook.id, { enabled: false, rotate_webhook_token: true })));
      const res = await rawFetch(`${seeded.baseUrl}/api/hooks/${rotated.webhook_token}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.3" }, body: "{}" });
      expect(res.status).toBe(404);
    });
  });

  it("deletes an automation with 200 ok", async () => {
    expect(parse("OkResponse", await w.owner.run(() => api.automations.remove(automation.id)))).toEqual({ ok: true });
    expect(w.owner.status).toBe(200);
    expectError(await failure(w.owner.run(() => api.automations.get(automation.id))), 404, "not_found");
    expect(parseList("Automation", await w.owner.run(() => api.automations.list(w.baseId))).map((a) => a.id)).not.toContain(automation.id);
  });
});

describe("trash across the base", () => {
  it("lists what was deleted (creators only) and restores it with the RestoreResponse", async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Trashable")));
    await w.owner.run(() => api.tables.remove(t.id));
    const trash = parse("TrashListing", await w.owner.run(() => api.trash.forBase(w.baseId)));
    expect(trash.items.find((i) => i.id === t.id)).toMatchObject({ kind: "table", name: "Trashable" });
    expect(trash.items.find((i) => i.id === t.id)!.deleted_at).toBeGreaterThan(0);
    // Editors see only the records they deleted themselves (audit #5), never tables.
    expect(parse("TrashListing", await editor.run(() => api.trash.forBase(w.baseId))).items.map((i) => i.id)).not.toContain(t.id);
    expectError(await failure(editor.run(() => api.trash.restore({ kind: "table", id: t.id }))), 403, "forbidden");
    expect(parse("RestoreResponse", await w.owner.run(() => api.trash.restore({ kind: "table", id: t.id })))).toEqual({ ok: true, restored_field_ids: [] });
    expectError(await failure(w.owner.run(() => api.trash.restore({ kind: "table", id: t.id }))), 409, "conflict");
    expectError(await failure(w.owner.run(() => api.trash.restore({ kind: "hologram", id: t.id }))), 400, "bad_request");
  });

  it("lists everything in one trash, with where it was and who deleted it, filtered by base and kind", async () => {
    const t = parse("Table", await w.owner.run(() => api.tables.create(w.baseId, "Everywhere")));
    await w.owner.run(() => api.tables.remove(t.id));
    const all = parse("TrashListing", await w.owner.run(() => api.trash.all()));
    const item = all.items.find((i) => i.id === t.id)!;
    expect(item).toMatchObject({ kind: "table", name: "Everywhere", base_id: w.baseId, deleted_by_id: w.owner.id });
    expect(item.workspace_name).toBeTruthy();
    expect(item.expires_at).toBeGreaterThan(item.deleted_at);
    const tables = parse("TrashListing", await w.owner.run(() => api.trash.all({ base_id: w.baseId, kind: "table" })));
    expect(tables.items.every((i) => i.kind === "table" && i.base_id === w.baseId)).toBe(true);
    expect(parse("TrashListing", await editor.run(() => api.trash.all())).items.map((i) => i.id)).not.toContain(t.id);
    expectError(await failure(w.owner.run(() => api.trash.all({ kind: "hologram" as "table" }))), 400, "bad_request");
    await w.owner.run(() => api.trash.restore({ kind: "table", id: t.id }));
  });
});

describe("search everything", () => {
  it("finds names and record text the caller can open, as a SearchResponse", async () => {
    const found = parse("SearchResponse", await w.owner.run(() => api.search.everything("commented record")));
    expect(found.results[0]).toMatchObject({ kind: "record", record_id: rec.id, table_id: table.id, base_id: w.baseId, name: "Commented record" });
    expect(parse("SearchResponse", await outsider.run(() => api.search.everything("commented record"))).results).toEqual([]);
    expectError(await failure(w.owner.run(() => api.search.everything("   "))), 400, "bad_request");
  });
});
