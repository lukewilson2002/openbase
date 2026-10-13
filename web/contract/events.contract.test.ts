/**
 * Live events: the real client code (`connectBaseEvents`) streaming `/api/bases/{id}/events`
 * from the real server, while a second client writes. Asserts the frames, their payloads
 * against the generated `EventEnvelope`, the writer's client id (the echo-skip key), and that
 * access changes end the stream.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { connectBaseEvents } from "../src/api/events";
import { commentsApi, recordsApi, schemaApi } from "../src/api/records";
import type { EventEnvelope } from "../src/api/types";
import { FetchEventSource, readFrames } from "./sse";
import { createWorld, joinBase, newUser, Profile, seeded, sleep, type World } from "./support";
import { parse } from "./typecheck";

let w: World;
let reader: Profile;
let writer: Profile;
let tableId = "";
let nameField = "";

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

interface Subscription {
  events: EventEnvelope[];
  statuses: number[];
  reconnects: number;
  /** Resolves with the first event matching `pred` (already received or still to come). */
  next(pred: (e: EventEnvelope) => boolean, ms?: number): Promise<EventEnvelope>;
}

/** Subscribe as `profile` using the real client, with fast reconnects. */
async function subscribe(profile: Profile, baseId: string): Promise<Subscription> {
  const sub: Subscription = {
    events: [],
    statuses: [],
    reconnects: 0,
    async next(pred, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = sub.events.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no matching event within ${ms}ms; got ${JSON.stringify(sub.events)}`);
        await sleep(20);
      }
    },
  };
  // The server subscribes to the event bus before it answers, so a 200 means nothing is missed.
  const opened = new Promise<void>((resolve) => {
    const stop = connectBaseEvents({
      baseId,
      clientId: profile.clientId,
      backoff: { initialMs: 50, maxMs: 100, factor: 1 },
      onEvent: (env) => {
        sub.events.push(parse("EventEnvelope", env));
      },
      onReconnect: () => void sub.reconnects++,
      createEventSource: (url) =>
        new FetchEventSource(url, {
          baseUrl: seeded.baseUrl,
          fetch: profile.jar.fetch,
          onResponse: (status) => {
            sub.statuses.push(status);
            if (status === 200) resolve();
          },
        }),
    });
    disposers.push(stop);
  });
  await opened;
  return sub;
}

beforeAll(async () => {
  w = await createWorld("Events");
  tableId = w.base.tables[0]!.id;
  nameField = w.base.tables[0]!.primary_field_id;
  reader = await newUser(w.owner, "reader");
  writer = await newUser(w.owner, "writer");
  await joinBase(w.owner, w.baseId, reader, "viewer");
  await joinBase(w.owner, w.baseId, writer, "editor");
});

describe("base events", () => {
  it("delivers a records_changed frame with the writer's client id when another client writes", async () => {
    const sub = await subscribe(reader, w.baseId);
    const created = (await writer.run(() => recordsApi.create(tableId, { records: [{ values: { [nameField]: "live" } }] }))).records[0]!;
    const env = await sub.next((e) => e.event.kind === "records_changed");
    expect(env).toMatchObject({ base_id: w.baseId, client_id: writer.clientId, user_id: writer.id });
    expect(env.event).toEqual({ kind: "records_changed", table_id: tableId, created: [created.id], updated: [], deleted: [] });
    expect(sub.statuses).toEqual([200]);
  });

  it("reports updates and deletes with the record ids", async () => {
    const rec = (await writer.run(() => recordsApi.create(tableId, { records: [{ values: { [nameField]: "x" } }] }))).records[0]!;
    const sub = await subscribe(reader, w.baseId);
    await writer.run(() => recordsApi.update(tableId, { records: [{ id: rec.id, values: { [nameField]: "y" } }] }));
    await writer.run(() => recordsApi.remove(tableId, [rec.id]));
    const updated = await sub.next((e) => e.event.kind === "records_changed" && e.event.updated.includes(rec.id));
    expect(updated.client_id).toBe(writer.clientId);
    const deleted = await sub.next((e) => e.event.kind === "records_changed" && e.event.deleted.includes(rec.id));
    expect(deleted.event).toMatchObject({ kind: "records_changed", table_id: tableId, created: [], updated: [] });
  });

  it("the real client does not hand a tab its own changes (echo skipping)", async () => {
    const sub = await subscribe(writer, w.baseId);
    await writer.run(() => recordsApi.create(tableId, { records: [{ values: { [nameField]: "mine" } }] }));
    const other = (await w.owner.run(() => recordsApi.create(tableId, { records: [{ values: { [nameField]: "theirs" } }] }))).records[0]!;
    await sub.next((e) => e.event.kind === "records_changed" && e.event.created.includes(other.id));
    // Only the other client's change arrived.
    expect(sub.events.filter((e) => e.event.kind === "records_changed")).toHaveLength(1);
    expect(sub.events.every((e) => e.client_id !== writer.clientId)).toBe(true);
  });

  it("announces schema changes, comment changes and base changes", async () => {
    const sub = await subscribe(reader, w.baseId);
    await w.owner.run(() => schemaApi.createField(tableId, { name: "Added live", type: "number", options: {} } as never));
    const schema = await sub.next((e) => e.event.kind === "schema_changed");
    expect(schema.event).toMatchObject({ kind: "schema_changed", table_id: tableId });
    expect(schema.client_id).toBe(w.owner.clientId);

    const rec = (await writer.run(() => recordsApi.create(tableId, { records: [{ values: {} }] }))).records[0]!;
    await writer.run(() => commentsApi.create(rec.id, "hello"));
    const comment = await sub.next((e) => e.event.kind === "comments_changed");
    expect(comment.event).toEqual({ kind: "comments_changed", record_id: rec.id });

    await w.owner.run(() => api.bases.update(w.baseId, { name: "Renamed live" }));
    const base = await sub.next((e) => e.event.kind === "base_changed");
    expect(base.event).toEqual({ kind: "base_changed" });
  });

  it("does not leak events of other bases", async () => {
    const other = await createWorld("Elsewhere");
    const sub = await subscribe(reader, w.baseId);
    await other.owner.run(() => recordsApi.create(other.base.tables[0]!.id, { records: [{ values: {} }] }));
    const mine = (await writer.run(() => recordsApi.create(tableId, { records: [{ values: {} }] }))).records[0]!;
    await sub.next((e) => e.event.kind === "records_changed" && e.event.created.includes(mine.id));
    expect(sub.events.every((e) => e.base_id === w.baseId)).toBe(true);
  });
});

describe("raw stream", () => {
  it("is text/event-stream with one named frame per event whose name is the event kind", async () => {
    const controller = new AbortController();
    const res = await reader.jar.fetch(`${seeded.baseUrl}/api/bases/${w.baseId}/events`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = readFrames(res.body!);
    const rec = (await writer.run(() => recordsApi.create(tableId, { records: [{ values: {} }] }))).records[0]!;
    const frame = (await frames.next()).value!;
    expect(frame.event).toBe("records_changed");
    const env = parse("EventEnvelope", JSON.parse(frame.data));
    expect(env.event).toMatchObject({ kind: "records_changed", created: [rec.id] });
    controller.abort();
  });
});

describe("access", () => {
  it("refuses people who cannot read the base", async () => {
    const outsider = await newUser(w.owner, "outsider");
    const res = await outsider.jar.fetch(`${seeded.baseUrl}/api/bases/${w.baseId}/events`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const anon = new Profile("anon");
    expect((await anon.jar.fetch(`${seeded.baseUrl}/api/bases/${w.baseId}/events`)).status).toBe(401);
  });

  it("ends the stream when the reader is removed from the base", async () => {
    const guest = await newUser(w.owner, "guest");
    await joinBase(w.owner, w.baseId, guest, "viewer");
    const res = await guest.jar.fetch(`${seeded.baseUrl}/api/bases/${w.baseId}/events`, { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    const frames = readFrames(res.body!);
    await w.owner.run(() => api.bases.removeMember(w.baseId, guest.id));
    // The membership change is announced (base_changed), then access is re-checked and the stream ends.
    const outcome = await Promise.race([
      (async () => {
        for (;;) {
          const next = await frames.next();
          if (next.done) return "closed";
        }
      })(),
      sleep(5000).then(() => "still open"),
    ]);
    expect(outcome).toBe("closed");
  });
});
