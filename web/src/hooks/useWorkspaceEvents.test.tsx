import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClientId } from "@/api/client";
import type { EventSourceLike } from "@/api/events";
import { COUNT_REFRESH_MS } from "./useCountRefresh";
import { useWorkspaceEvents } from "./useWorkspaceEvents";

class Fake implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  closed = false;
  url = "";
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

function Probe({ source, workspaceId }: { source: Fake; workspaceId: string | undefined }) {
  useWorkspaceEvents(workspaceId, {
    createEventSource: (url) => {
      source.url = url;
      return source;
    },
  });
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (workspaceId: string | null = "wsp1") => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const source = new Fake();
  const view = render(
    <QueryClientProvider client={qc}>
      <Probe source={source} workspaceId={workspaceId ?? undefined} />
    </QueryClientProvider>,
  );
  const workspaces = () => spy.mock.calls.filter((c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ["workspaces"] })).length;
  return { source, view, spy, workspaces };
};

describe("useWorkspaceEvents (BE-9)", () => {
  it("opens the workspace's stream, and closes it with the screen", () => {
    const { source, view } = setup();
    expect(source.url).toBe("/api/workspaces/wsp1/events");
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it("opens nothing without a workspace", () => {
    const { source } = setup(null);
    expect(source.url).toBe("");
  });

  it("refreshes the collections at once on a schema change in any of its folders", () => {
    const { source, workspaces } = setup();
    source.emit("schema_changed", { base_id: "app2", client_id: "other", event: { kind: "schema_changed", table_id: null } });
    expect(workspaces()).toBe(1);
  });

  it("refreshes the counts once per few seconds while others add or delete records, and not for an edit", () => {
    const { source, workspaces } = setup();
    const records = (created: string[], updated: string[], deleted: string[]) =>
      source.emit("records_changed", { base_id: "app2", client_id: "other", event: { kind: "records_changed", table_id: "tbl7", created, updated, deleted } });
    records([], ["rec1"], []);
    vi.advanceTimersByTime(10_000);
    expect(workspaces()).toBe(0);
    records(["rec2"], [], []);
    records([], [], ["rec2"]);
    vi.advanceTimersByTime(COUNT_REFRESH_MS);
    expect(workspaces()).toBe(1);
  });

  it("ignores its own tab's changes, like the folder's stream", () => {
    const { source, workspaces } = setup();
    source.emit("schema_changed", { base_id: "app2", client_id: getClientId(), event: { kind: "schema_changed", table_id: null } });
    expect(workspaces()).toBe(0);
  });
});
