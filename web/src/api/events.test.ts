import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKOFF, backoffDelay, connectBaseEvents, parseEnvelope, queryKeysForEvent, type EventSourceLike } from "./events";
import type { EventEnvelope } from "./types";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() {
    this.onopen?.(new Event("open"));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
  emit(type: string, data: string) {
    for (const l of this.listeners.get(type) ?? []) l({ data } as MessageEvent<string>);
  }
}

const envelope = (over: Partial<EventEnvelope> = {}): EventEnvelope => ({
  base_id: "app1",
  client_id: "other-tab",
  user_id: "usr1",
  event: { kind: "records_changed", table_id: "tbl1", created: ["rec1"], updated: [], deleted: [] },
  ...over,
});

const create = (url: string) => new FakeEventSource(url);

describe("backoffDelay", () => {
  it("doubles per attempt up to the cap, with jitter between 50% and 100%", () => {
    const full = (n: number) => backoffDelay(n, DEFAULT_BACKOFF, () => 1);
    expect([0, 1, 2, 3, 4].map(full)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(full(5)).toBe(30_000);
    expect(full(20)).toBe(30_000);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBe(2000);
  });
});

describe("parseEnvelope", () => {
  it("accepts a valid envelope and rejects junk", () => {
    expect(parseEnvelope(JSON.stringify(envelope()))?.event.kind).toBe("records_changed");
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope(JSON.stringify({ base_id: "a" }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ base_id: "a", event: {} }))).toBeNull();
  });
});

describe("connectBaseEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects to the base events URL and delivers parsed events", () => {
    const onEvent = vi.fn();
    connectBaseEvents({ baseId: "app1", clientId: "me", onEvent, createEventSource: create });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/bases/app1/events");
    es.emit("records_changed", JSON.stringify(envelope()));
    es.emit("schema_changed", JSON.stringify(envelope({ event: { kind: "schema_changed", table_id: null } })));
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[1]?.[0].event.kind).toBe("schema_changed");
  });

  it("ignores events caused by this tab's own client id", () => {
    const onEvent = vi.fn();
    connectBaseEvents({ baseId: "app1", clientId: "me", onEvent, createEventSource: create });
    const es = FakeEventSource.instances[0]!;
    es.emit("records_changed", JSON.stringify(envelope({ client_id: "me" })));
    expect(onEvent).not.toHaveBeenCalled();
    es.emit("records_changed", JSON.stringify(envelope({ client_id: "someone-else" })));
    es.emit("records_changed", JSON.stringify(envelope({ client_id: null })));
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed payloads and events for another base", () => {
    const onEvent = vi.fn();
    connectBaseEvents({ baseId: "app1", clientId: "me", onEvent, createEventSource: create });
    const es = FakeEventSource.instances[0]!;
    es.emit("records_changed", "{oops");
    es.emit("records_changed", JSON.stringify(envelope({ base_id: "app2" })));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reconnects with exponential backoff after errors and resets after a successful open", () => {
    const onReconnect = vi.fn();
    connectBaseEvents({ baseId: "app1", clientId: "me", onEvent: vi.fn(), onReconnect, createEventSource: create, random: () => 1 });
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]!.fail();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second consecutive failure waits twice as long.
    FakeEventSource.instances[1]!.fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A successful open resets the backoff and reports a reconnect (events may have been missed).
    FakeEventSource.instances[2]!.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    FakeEventSource.instances[2]!.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("does not report a reconnect for the very first open", () => {
    const onReconnect = vi.fn();
    connectBaseEvents({ baseId: "app1", clientId: "me", onEvent: vi.fn(), onReconnect, createEventSource: create });
    FakeEventSource.instances[0]!.open();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("stops everything when disposed, including a pending reconnect", () => {
    const onEvent = vi.fn();
    const dispose = connectBaseEvents({ baseId: "app1", clientId: "me", onEvent, createEventSource: create });
    const first = FakeEventSource.instances[0]!;
    first.fail();
    dispose();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    const dispose2 = connectBaseEvents({ baseId: "app1", clientId: "me", onEvent, createEventSource: create });
    const live = FakeEventSource.instances[1]!;
    dispose2();
    expect(live.closed).toBe(true);
    live.emit("records_changed", JSON.stringify(envelope()));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("queryKeysForEvent", () => {
  it("maps events to query-key prefixes", () => {
    expect(queryKeysForEvent(envelope())).toEqual([["records", "tbl1"]]);
    expect(queryKeysForEvent(envelope({ event: { kind: "schema_changed", table_id: "tbl1" } }))).toContainEqual(["base", "app1"]);
    expect(queryKeysForEvent(envelope({ event: { kind: "comments_changed", record_id: "rec9" } }))).toEqual([["comments", "rec9"]]);
    expect(queryKeysForEvent(envelope({ event: { kind: "base_changed" } }))).toContainEqual(["base", "app1"]);
  });
});
