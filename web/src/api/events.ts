/**
 * Server-Sent Events for a base (`GET /api/bases/{id}/events`) and for a whole workspace
 * (`GET /api/workspaces/{id}/events`).
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
export const EVENT_KINDS = ["records_changed", "schema_changed", "comments_changed", "base_changed", "presence_changed"] as const;

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

interface StreamOptions {
  onEvent: (envelope: EventEnvelope) => void;
  /** Called when the stream opens again after a failure: events may have been missed. */
  onReconnect?: () => void;
  /** Defaults to this tab's id. */
  clientId?: string;
  backoff?: BackoffConfig;
  random?: () => number;
  createEventSource?: (url: string) => EventSourceLike;
}

export interface ConnectOptions extends StreamOptions {
  baseId: string;
}

export interface WorkspaceConnectOptions extends StreamOptions {
  workspaceId: string;
}

/** Open a project's stream; returns a function that closes it and cancels any pending reconnect. */
export function connectBaseEvents(opts: ConnectOptions): () => void {
  return connectStream(api.bases.eventsUrl(opts.baseId), (env) => env.base_id === opts.baseId, opts);
}

/**
 * Open the stream of every project of a workspace the caller can open (Home and the Collections
 * tab; a browser holds only about six connections per site, so one stream per project is out).
 * Each envelope's `base_id` says which project it belongs to. It never counts as presence, so
 * screens that show who is viewing keep using the project stream.
 */
export function connectWorkspaceEvents(opts: WorkspaceConnectOptions): () => void {
  return connectStream(api.workspaces.eventsUrl(opts.workspaceId), () => true, opts);
}

function connectStream(url: string, accepts: (env: EventEnvelope) => boolean, opts: StreamOptions): () => void {
  const clientId = opts.clientId ?? getClientId();
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const create = opts.createEventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike);
  if (!opts.createEventSource && typeof EventSource === "undefined") return () => {};

  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let failed = false;
  let disposed = false;

  const handle = (ev: MessageEvent<string>) => {
    if (disposed) return;
    const env = parseEnvelope(typeof ev.data === "string" ? ev.data : "");
    if (!env || !accepts(env)) return;
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
      // Schema changes can alter what record queries return (new fields, view config), and the
      // sidebar draws the folder's collections (names, colors, order) from the workspaces list.
      return [keys.base(env.base_id), ["records"], keys.workspaces];
    case "comments_changed":
      return [keys.comments(ev.record_id)];
    case "base_changed":
      return [keys.base(env.base_id), keys.workspaces];
    case "presence_changed":
      // Who is viewing is not cached data: nothing to refetch.
      return [];
  }
}
