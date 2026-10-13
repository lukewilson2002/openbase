/**
 * Server-Sent Events for a base (`GET /api/bases/{id}/events`).
 *
 * The browser's own EventSource reconnection gives up for good on an HTTP error
 * (for example an expired session), so this helper manages the connection itself:
 * on any error it closes the source and reopens it after an exponential backoff
 * with jitter. Events caused by this tab (matching `X-Client-Id`) are ignored
 * because the originating mutation already updated the cache.
 */
import { getClientId } from "./client";
import { api } from "./endpoints";
import { keys } from "./keys";
import type { EventEnvelope } from "./types";

/** The `event:` names the server uses (BaseEvent kinds, snake_case). */
export const EVENT_KINDS = ["records_changed", "schema_changed", "comments_changed", "base_changed"] as const;

/** The subset of EventSource this helper needs (lets tests inject a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

export interface BackoffConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = { initialMs: 1000, maxMs: 30_000, factor: 2 };

/** Delay before reconnect attempt number `attempt` (0-based), with 50-100% jitter. */
export function backoffDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const base = Math.min(cfg.maxMs, cfg.initialMs * cfg.factor ** attempt);
  return Math.round(base * (0.5 + 0.5 * random()));
}

/** Parse one SSE `data:` payload; returns null for anything that is not an EventEnvelope. */
export function parseEnvelope(data: string): EventEnvelope | null {
  try {
    const v: unknown = JSON.parse(data);
    if (!v || typeof v !== "object") return null;
    const env = v as Partial<EventEnvelope>;
    if (typeof env.base_id !== "string" || !env.event || typeof env.event !== "object") return null;
    if (typeof (env.event as { kind?: unknown }).kind !== "string") return null;
    return env as EventEnvelope;
  } catch {
    return null;
  }
}

export interface ConnectOptions {
  baseId: string;
  onEvent: (envelope: EventEnvelope) => void;
  /** Called when the stream opens again after a failure: events may have been missed. */
  onReconnect?: () => void;
  /** Defaults to this tab's id. */
  clientId?: string;
  backoff?: BackoffConfig;
  random?: () => number;
  createEventSource?: (url: string) => EventSourceLike;
}

/** Open the stream; returns a function that closes it and cancels any pending reconnect. */
export function connectBaseEvents(opts: ConnectOptions): () => void {
  const clientId = opts.clientId ?? getClientId();
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const create = opts.createEventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike);
  const url = api.bases.eventsUrl(opts.baseId);
  if (!opts.createEventSource && typeof EventSource === "undefined") return () => {};

  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let failed = false;
  let disposed = false;

  const handle = (ev: MessageEvent<string>) => {
    if (disposed) return;
    const env = parseEnvelope(typeof ev.data === "string" ? ev.data : "");
    if (!env || env.base_id !== opts.baseId) return;
    if (env.client_id && env.client_id === clientId) return;
    opts.onEvent(env);
  };

  const open = () => {
    if (disposed) return;
    const es = create(url);
    source = es;
    for (const kind of EVENT_KINDS) es.addEventListener(kind, handle);
    es.addEventListener("message", handle);
    es.onopen = () => {
      if (disposed || source !== es) return;
      attempt = 0;
      if (failed) {
        failed = false;
        opts.onReconnect?.();
      }
    };
    es.onerror = () => {
      if (disposed || source !== es) return;
      failed = true;
      es.close();
      source = null;
      const delay = backoffDelay(attempt, backoff, opts.random);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        open();
      }, delay);
    };
  };

  open();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };
}

/** Query-key prefixes to invalidate for an event (see keys.ts). */
export function queryKeysForEvent(env: EventEnvelope): (readonly unknown[])[] {
  const ev = env.event;
  switch (ev.kind) {
    case "records_changed":
      return [keys.records(ev.table_id)];
    case "schema_changed":
      // Schema changes can alter what record queries return (new fields, view config).
      return [keys.base(env.base_id), ["records"]];
    case "comments_changed":
      return [keys.comments(ev.record_id)];
    case "base_changed":
      return [keys.base(env.base_id), keys.workspaces];
  }
}
