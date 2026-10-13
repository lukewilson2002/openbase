import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { EventSourceLike } from "@/api/events";
import { useBaseEvents } from "./useBaseEvents";

class Fake implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  closed = false;
  addEventListener(type: string, l: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, payload: object) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

function Probe({ source }: { source: Fake }) {
  useBaseEvents("app1", { createEventSource: () => source });
  return null;
}

describe("useBaseEvents", () => {
  it("invalidates schema and record queries from live events and closes on unmount", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const source = new Fake();
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <Probe source={source} />
      </QueryClientProvider>,
    );

    source.emit("records_changed", { base_id: "app1", client_id: "other", event: { kind: "records_changed", table_id: "tbl1", created: [], updated: ["rec1"], deleted: [] } });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["records", "tbl1"] });

    spy.mockClear();
    source.emit("schema_changed", { base_id: "app1", client_id: "other", event: { kind: "schema_changed", table_id: null } });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["base", "app1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["records"] });

    unmount();
    expect(source.closed).toBe(true);
  });

  it("refetches the base and records after the stream reconnects", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const made: Fake[] = [];
    vi.useFakeTimers();
    try {
      function Probe2() {
        useBaseEvents("app1", {
          createEventSource: () => {
            const f = new Fake();
            made.push(f);
            return f;
          },
        });
        return null;
      }
      render(
        <QueryClientProvider client={qc}>
          <Probe2 />
        </QueryClientProvider>,
      );
      expect(made).toHaveLength(1);
      made[0]!.onopen?.(new Event("open"));
      expect(spy).not.toHaveBeenCalled(); // first connection: nothing was missed

      made[0]!.onerror?.(new Event("error"));
      vi.advanceTimersByTime(1000);
      expect(made).toHaveLength(2);
      made[1]!.onopen?.(new Event("open"));
      expect(spy).toHaveBeenCalledWith({ queryKey: ["base", "app1"] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["records"] });
    } finally {
      vi.useRealTimers();
    }
  });
});
