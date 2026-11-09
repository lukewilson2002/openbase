import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { keys } from "@/api/keys";
import { Providers, createQueryClient } from "@/providers";
import { USER, mockApi, stubDesktop } from "@/test/utils";
import { F, projectSchema, viewWithConfig } from "@/views/common/viewTestUtils";
import { applyDraft } from "@/views/drafts/draft";
import { writeDraft } from "@/views/drafts/store";
import { nextDraft } from "@/views/drafts/draft";
import { useRecordOrder } from "./useRecordOrder";

const view = viewWithConfig("viw1", "grid", {});
const table = projectSchema("editor", [view]).tables[0]!;
const QUERY = "POST /api/views/viw1/query";

function harness(recordId: string, handed?: readonly string[]) {
  stubDesktop();
  const client = createQueryClient();
  client.setQueryData(keys.me, USER);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Providers client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </Providers>
  );
  return renderHook(() => useRecordOrder({ table, view, recordId, timeZone: "UTC", handed }), { wrapper });
}

/** The answer of a view that holds `all` in this order, as the server gives it for `neighbours_of`. */
function serve(all: readonly string[], asked?: unknown[]) {
  return (call: { body: unknown }) => {
    const body = call.body as { neighbours_of: string };
    asked?.push(call.body);
    const i = all.indexOf(body.neighbours_of);
    return { total: all.length, offset: 0, records: [], groups: [], colors: {}, neighbours: { previous: (i > 0 && all[i - 1]) || null, next: (i >= 0 && all[i + 1]) || null } };
  };
}

describe("the records around a record page", () => {
  it("are the view's order from the server, asked for as the two ids around the record and no records", async () => {
    const asked: unknown[] = [];
    mockApi({ [QUERY]: serve(["r1", "r2", "r3"], asked) });
    const { result } = harness("r2");
    await waitFor(() => expect(result.current).toEqual({ prevId: "r1", nextId: "r3" }));
    expect(asked[0]).toMatchObject({ limit: 0, neighbours_of: "r2", timezone: "UTC" });
    expect(asked[0]).not.toHaveProperty("transient");
  });

  it("have no neighbour past either end", async () => {
    mockApi({ [QUERY]: serve(["r1", "r2"]) });
    const first = harness("r1");
    await waitFor(() => expect(first.result.current).toEqual({ prevId: null, nextId: "r2" }));
    const last = harness("r2");
    await waitFor(() => expect(last.result.current).toEqual({ prevId: "r1", nextId: null }));
  });

  it("do not stop at some count of records: the server finds the place in a view of any size", async () => {
    const api = mockApi({ [QUERY]: serve(Array.from({ length: 12_000 }, (_, i) => `r${i}`)) });
    const { result } = harness("r9500");
    await waitFor(() => expect(result.current).toEqual({ prevId: "r9499", nextId: "r9501" }));
    // One small request for the record, and one each for the two it can step to.
    await waitFor(() => expect(api.callsTo(QUERY)).toHaveLength(3));
  });

  it("follow this person's draft of the view, sent as the transient config so the server does the sorting", async () => {
    const asked: { transient?: { sorts?: unknown } }[] = [];
    mockApi({ [QUERY]: (call: { body: unknown }) => serve((call.body as { transient?: unknown }).transient ? ["r2", "r1"] : ["r1", "r2"], asked)(call) });
    const sorted = applyDraft(view.config, { changes: { sorts: [{ field_id: F.name.id, direction: "desc" }] } });
    writeDraft(USER.id, "viw1", nextDraft(null, view, sorted, "grid", 1));
    const { result } = harness("r1");
    await waitFor(() => expect(result.current).toEqual({ prevId: "r2", nextId: null }));
    expect(asked[0]!.transient?.sorts).toEqual([{ field_id: F.name.id, direction: "desc" }]);
  });

  it("follow the order the layout handed over, and ask the server for nothing", async () => {
    const api = mockApi({ [QUERY]: serve(["r1", "r2", "r3"]) });
    const { result } = harness("r2", ["r3", "r2", "r1"]);
    await waitFor(() => expect(result.current).toEqual({ prevId: "r3", nextId: "r1" }));
    expect(api.callsTo(QUERY)).toHaveLength(0);
  });

  it("ask the server about a record the layout did not show", async () => {
    const api = mockApi({ [QUERY]: serve(["r1", "r9", "r2"]) });
    const { result } = harness("r9", ["r1", "r2"]);
    await waitFor(() => expect(result.current).toEqual({ prevId: "r1", nextId: "r2" }));
    expect(api.callsTo(QUERY).length).toBeGreaterThan(0);
  });
});
