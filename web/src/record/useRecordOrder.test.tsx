import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { keys } from "@/api/keys";
import { Providers, createQueryClient } from "@/providers";
import { USER, mockApi, stubDesktop } from "@/test/utils";
import { F, projectSchema, rec, viewWithConfig } from "@/views/common/viewTestUtils";
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

const ids = (...x: string[]) => x.map((id) => rec(id, {}));

describe("the records around a record page", () => {
  it("are the view's order from the server, over every page of it", async () => {
    const asked: unknown[] = [];
    mockApi({
      [QUERY]: (call: { body: unknown }) => {
        asked.push(call.body);
        return { total: 3, offset: 0, records: ids("r1", "r2", "r3"), groups: [], colors: {} };
      },
    });
    const { result } = harness("r2");
    await waitFor(() => expect(result.current).toEqual({ prevId: "r1", nextId: "r3" }));
    expect(asked[0]).toMatchObject({ offset: 0, timezone: "UTC" });
    expect(asked[0]).not.toHaveProperty("transient");
  });

  it("have no neighbour past either end", async () => {
    mockApi({ [QUERY]: { total: 2, offset: 0, records: ids("r1", "r2"), groups: [], colors: {} } });
    const first = harness("r1");
    await waitFor(() => expect(first.result.current).toEqual({ prevId: null, nextId: "r2" }));
    const last = harness("r2");
    await waitFor(() => expect(last.result.current).toEqual({ prevId: "r1", nextId: null }));
  });

  it("follow this person's draft of the view, sent as the transient config so the server does the sorting", async () => {
    const asked: { transient?: { sorts?: unknown } }[] = [];
    mockApi({
      [QUERY]: (call: { body: unknown }) => {
        asked.push(call.body as never);
        return { total: 2, offset: 0, records: asked[asked.length - 1]!.transient ? ids("r2", "r1") : ids("r1", "r2"), groups: [], colors: {} };
      },
    });
    const sorted = applyDraft(view.config, { changes: { sorts: [{ field_id: F.name.id, direction: "desc" }] } });
    writeDraft(USER.id, "viw1", nextDraft(null, view, sorted, "grid", 1));
    const { result } = harness("r1");
    await waitFor(() => expect(result.current).toEqual({ prevId: "r2", nextId: null }));
    expect(asked[0]!.transient?.sorts).toEqual([{ field_id: F.name.id, direction: "desc" }]);
  });

  it("follow the order the layout handed over, and ask the server for nothing", async () => {
    const api = mockApi({ [QUERY]: { total: 3, offset: 0, records: ids("r1", "r2", "r3"), groups: [], colors: {} } });
    const { result } = harness("r2", ["r3", "r2", "r1"]);
    await waitFor(() => expect(result.current).toEqual({ prevId: "r3", nextId: "r1" }));
    expect(api.callsTo(QUERY)).toHaveLength(0);
  });

  it("ask the server about a record the layout did not show, and look once more, not again and again", async () => {
    let served = ids("r1", "r2");
    const api = mockApi({ [QUERY]: () => ({ total: served.length, offset: 0, records: served, groups: [], colors: {} }) });
    const { result } = harness("r9", ["r1", "r2"]);
    await waitFor(() => expect(api.callsTo(QUERY)).toHaveLength(2));
    expect(result.current).toEqual({ prevId: null, nextId: null });
    served = ids("r1", "r9", "r2");
    // The list is not asked for again and again for a record that is not there.
    await new Promise((r) => setTimeout(r, 50));
    expect(api.callsTo(QUERY)).toHaveLength(2);
  });
});
