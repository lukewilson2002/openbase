import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { apiError, mockApi } from "@/test/utils";
import { makeRecord } from "@/test/fields";
import type { ViewRecordsData } from "./cache";
import { TABLE_FIELDS } from "./viewTestUtils";
import { useRecordWrites } from "./useRecordWrites";

afterEach(() => vi.unstubAllGlobals());

const KEY = ["records", "tbl1", "viw1", "query", "cfg", "", "all", "", null, "UTC", 5000] as const;
const data = (): ViewRecordsData => ({
  records: [makeRecord({ f_status: "s1" }, "r1"), makeRecord({ f_status: "s1" }, "r2"), makeRecord({ f_status: "s2" }, "r3")],
  total: 3,
  groups: [],
  colors: {},
  truncated: false,
});

function harness(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(KEY, data());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useRecordWrites({ tableId: "tbl1", fields: TABLE_FIELDS, canEdit }), { wrapper });
  const cached = () => client.getQueryData<ViewRecordsData>(KEY)!;
  return { client, ...hook, cached };
}

const ids = (d: ViewRecordsData) => d.records.map((r) => r.id);

describe("useRecordWrites", () => {
  it("applies an edit to the cache immediately and sends one PATCH with wire values", async () => {
    const api = mockApi({ "PATCH /api/tables/tbl1/records": (c: { body: { records: { id: string }[] } }) => ({ records: [makeRecord({ f_status: "s3", f_owner: ["usr1"] }, c.body.records[0]!.id)] }) });
    const { result, cached } = harness();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.update("r1", { f_status: "s3", f_owner: ["usr1"] });
    });
    await waitFor(() => expect(cached().records[0]!.values).toMatchObject({ f_status: "s3" }));
    expect(await pending).toBe(true);
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s3", f_owner: ["usr1"] } }] });
  });

  it("rolls back and reports the error when the server rejects the edit", async () => {
    mockApi({ "PATCH /api/tables/tbl1/records": apiError(400, "invalid_value", "Not an option") });
    const { result, cached } = harness();
    let ok = true;
    await act(async () => {
      ok = await result.current.update("r1", { f_status: "s3" });
    });
    expect(ok).toBe(false);
    expect(cached().records[0]!.values).toEqual({ f_status: "s1" });
  });

  it("moves a record optimistically then calls the move endpoint; rolls back if it fails", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/records/move": { records: [] } });
    const first = harness();
    await act(async () => {
      expect(await first.result.current.move("r3", { beforeId: "r1" })).toBe(true);
    });
    expect(ids(first.cached())).toEqual(["r3", "r1", "r2"]);
    expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toEqual({ ids: ["r3"], before_id: "r1", after_id: null });

    mockApi({ "POST /api/tables/tbl1/records/move": apiError(500, "internal", "nope") });
    const second = harness();
    await act(async () => {
      expect(await second.result.current.move("r3", { beforeId: "r1" })).toBe(false);
    });
    expect(ids(second.cached())).toEqual(["r1", "r2", "r3"]);
  });

  it("updateAndMove writes the value and the order together and undoes both on failure", async () => {
    mockApi({ "PATCH /api/tables/tbl1/records": { records: [makeRecord({ f_status: "s2" }, "r1")] }, "POST /api/tables/tbl1/records/move": apiError(500, "internal", "nope") });
    const { result, cached } = harness();
    await act(async () => {
      expect(await result.current.updateAndMove("r1", { f_status: "s2" }, { afterId: "r3" })).toBe(false);
    });
    expect(ids(cached())).toEqual(["r1", "r2", "r3"]);
    expect(cached().records[0]!.values).toEqual({ f_status: "s1" });
  });

  it("does nothing without permission to edit", async () => {
    const api = mockApi({});
    const { result } = harness(false);
    await act(async () => {
      expect(await result.current.update("r1", { f_status: "s3" })).toBe(false);
      expect(await result.current.create({})).toBeNull();
    });
    expect(api.calls).toHaveLength(0);
  });

  it("creates a record in wire form, optionally after another", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "new1")] } });
    const { result } = harness();
    let created;
    await act(async () => {
      created = await result.current.create({ f_deps: [{ id: "r1", name: "R1" }], f_status: "s2" }, { afterRecordId: "r2" });
    });
    expect(created).toMatchObject({ id: "new1" });
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toEqual({ records: [{ values: { f_deps: ["r1"], f_status: "s2" } }], typecast: true, after_record_id: "r2" });
  });
});
