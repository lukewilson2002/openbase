/** Record writes of the grid against the response shapes the server really sends (docs/plans §3.1). */
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RecordsResponse, TableRecord } from "@/api/types";
import { ToastProvider } from "@/components/ui/toast";
import { createQueryClient } from "@/providers";
import { ALL_FIELDS, makeRecord } from "@/test/fields";
import { mockApi } from "@/test/utils";
import { UndoStack } from "./undo";
import type { GridData } from "./useGridData";
import { useRecordOps } from "./useRecordOps";

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" };

function fakeData(): GridData & { upserted: TableRecord[][] } {
  const upserted: TableRecord[][] = [];
  return {
    total: 0,
    groups: [],
    loading: false,
    error: null,
    version: 0,
    getRecord: () => undefined,
    rowColor: () => undefined,
    indexOf: () => -1,
    ensureRange: () => {},
    loadRange: async () => {},
    upsertRecords: (r) => void upserted.push([...r]),
    patchValues: () => undefined,
    refresh: () => {},
    upserted,
  };
}

function setup() {
  const data = fakeData();
  const stack = new UndoStack();
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useRecordOps({ tableId: "tbl1", fields: [name], data, stack, canEdit: true }), { wrapper });
  return { hook, data, stack };
}

const created = (ids: string[]): RecordsResponse => ({ records: ids.map((id) => makeRecord({}, id)) });

describe("useRecordOps against the server's record contract", () => {
  it("inserts above with a single create request carrying before_record_id (no create-then-move)", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/records": { status: 201, json: created(["recNew"]) } });
    const { hook, stack } = setup();
    let out: TableRecord[] = [];
    await act(async () => {
      out = await hook.result.current.createRecords({ beforeRecordId: "recAnchor" });
    });
    expect(out.map((r) => r.id)).toEqual(["recNew"]);
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1);
    expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(0);
    expect(api.calls[0]!.body).toMatchObject({ typecast: true, before_record_id: "recAnchor", after_record_id: null });
    expect(stack.canUndo).toBe(true);
  });

  it("inserts below with after_record_id", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/records": { status: 201, json: created(["recNew"]) } });
    const { hook } = setup();
    await act(async () => void (await hook.result.current.createRecords({ afterRecordId: "recAnchor" })));
    expect(api.calls[0]!.body).toMatchObject({ after_record_id: "recAnchor", before_record_id: null });
  });

  it("keeps the order of big batches: the anchor applies to the first batch, the next ones follow the previous", async () => {
    let n = 0;
    const api = mockApi({
      "POST /api/tables/tbl1/records": (call: { body: unknown }) => {
        const count = (call.body as { records: unknown[] }).records.length;
        const ids = Array.from({ length: count }, () => `rec${n++}`);
        return { status: 201, json: created(ids) };
      },
    });
    const { hook } = setup();
    await act(async () => void (await hook.result.current.createRecords({ count: 501, beforeRecordId: "recAnchor" })));
    const bodies = api.callsTo("POST /api/tables/tbl1/records").map((c) => c.body as { records: unknown[]; before_record_id: string | null; after_record_id: string | null });
    expect(bodies.map((b) => b.records.length)).toEqual([500, 1]);
    expect(bodies[0]).toMatchObject({ before_record_id: "recAnchor", after_record_id: null });
    expect(bodies[1]).toMatchObject({ before_record_id: null, after_record_id: "rec499" });
  });

  it("deletes with a JSON body of ids, treats the 204 as success and records an undo entry", async () => {
    const api = mockApi({ "DELETE /api/tables/tbl1/records": { status: 204 } });
    const { hook, stack } = setup();
    let ok = false;
    await act(async () => {
      ok = await hook.result.current.deleteRecords(["rec1", "rec2"]);
    });
    expect(ok).toBe(true);
    expect(api.calls[0]!.body).toEqual({ ids: ["rec1", "rec2"] });
    expect(stack.peekUndo()).toMatchObject({ kind: "delete", ids: ["rec1", "rec2"] });
  });

  it("undoing a delete restores the same ids", async () => {
    const api = mockApi({
      "DELETE /api/tables/tbl1/records": { status: 204 },
      "POST /api/tables/tbl1/records/restore": created(["rec1"]),
    });
    const { hook } = setup();
    await act(async () => void (await hook.result.current.deleteRecords(["rec1"])));
    await act(async () => hook.result.current.undo());
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/restore")[0]!.body).toEqual({ ids: ["rec1"] });
  });

  it("a failed delete (404, nothing deleted) reports the error and leaves no undo entry", async () => {
    mockApi({ "DELETE /api/tables/tbl1/records": { status: 404, json: { error: { code: "not_found", message: "record not found" } } } });
    const { hook, stack } = setup();
    let ok = true;
    await act(async () => {
      ok = await hook.result.current.deleteRecords(["recGone"]);
    });
    expect(ok).toBe(false);
    expect(stack.canUndo).toBe(false);
  });

  it("move answers RecordsResponse and the moved records are written into the cache", async () => {
    const moved = makeRecord({ fld_name: "moved" }, "rec7");
    const api = mockApi({ "POST /api/tables/tbl1/records/move": { records: [moved] } });
    const { hook, data } = setup();
    let ok = false;
    await act(async () => {
      ok = await hook.result.current.moveRecords(["rec7"], { beforeId: "rec1" });
    });
    expect(ok).toBe(true);
    expect(api.calls[0]!.body).toEqual({ ids: ["rec7"], before_id: "rec1", after_id: null });
    expect(data.upserted).toEqual([[moved]]);
  });

  it("cell edits PATCH the wire value and reconcile with the RecordsResponse", async () => {
    const saved = makeRecord({ fld_name: "after" }, "rec1");
    const api = mockApi({ "PATCH /api/tables/tbl1/records": { records: [saved] } });
    const { hook, data } = setup();
    await act(async () => void (await hook.result.current.applyChanges([{ recordId: "rec1", fieldId: "fld_name", before: "before", after: "after" }], "Edit cell")));
    expect(api.calls[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_name: "after" } }] });
    expect(data.upserted.at(-1)).toEqual([saved]);
  });
});
