/**
 * An `EventSource` for Node built on `fetch` streaming, so the real client code
 * (`connectBaseEvents` in src/api/events.ts) can run against the real server in the contract
 * tests. Node has no EventSource, and the session cookie has to come from a cookie jar.
 */
import type { EventSourceLike } from "../src/api/events";

export interface RawFrame {
  event: string;
  data: string;
}

/** Split an SSE byte stream into frames (`event:` / `data:` lines; `:` comment lines are skipped). */
export async function* readFrames(body: ReadableStream<Uint8Array>, onComment?: (c: string) => void): AsyncGenerator<RawFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        let any = false;
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(":")) onComment?.(line.slice(1).trim());
          else if (line.startsWith("event:")) (event = line.slice(6).trim()), (any = true);
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, "")), (any = true);
        }
        if (any) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface FetchEventSourceOptions {
  /** Absolute base URL, prefixed to the path the client asks for. */
  baseUrl: string;
  /** The fetch of the browser profile (carries its cookies and client id). */
  fetch: typeof fetch;
  /** Called with every response status, so tests can see a 404 instead of a silent retry. */
  onResponse?: (status: number) => void;
}

export class FetchEventSource implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  private readonly controller = new AbortController();
  private closed = false;

  constructor(path: string, private readonly opts: FetchEventSourceOptions) {
    void this.run(path);
  }

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private fail(): void {
    if (!this.closed) this.onerror?.(new Event("error"));
  }

  private async run(path: string): Promise<void> {
    try {
      const res = await this.opts.fetch(this.opts.baseUrl + path, { headers: { accept: "text/event-stream" }, signal: this.controller.signal });
      this.opts.onResponse?.(res.status);
      if (!res.ok || !res.body) return this.fail();
      this.onopen?.(new Event("open"));
      for await (const frame of readFrames(res.body)) {
        for (const l of this.listeners.get(frame.event) ?? []) l({ data: frame.data } as MessageEvent<string>);
      }
      this.fail();
    } catch {
      this.fail();
    }
  }
}
