import type { ReactNode } from "react";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Filter } from "@/api/types";
import { ToastProvider } from "@/components/ui/toast";
import { apiError, mockApi } from "@/test/utils";
import { makeRecord } from "@/test/fields";
import type { ViewRecordsData } from "./cache";
import { TABLE_FIELDS } from "./viewTestUtils";
import { isNewRecord } from "@/record/newRecords";
import { forgetUndoHistories } from "@/lib/undo/registry";
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

// Undo histories outlive a screen, so each test gets a view of its own, as each has its own folder in real use.
let views = 0;
function harness(canEdit = true, extra: { queryConfig?: { filter: Filter } } = {}, viewId = `viw${++views}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(KEY, data());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useRecordWrites({ baseId: "app1", viewId, tableId: "tbl1", fields: TABLE_FIELDS, canEdit, ...extra }), { wrapper });
  const cached = () => client.getQueryData<ViewRecordsData>(KEY)!;
  return { client, ...hook, cached };
}

const ids = (d: ViewRecordsData) => d.records.map((r) => r.id);

describe("useRecordWrites", () => {
  it("keeps its undo history when the screen is gone and back, as it is across a record's page", async () => {
    mockApi({ "PATCH /api/tables/tbl1/records": (c: { body: { records: { id: string }[] } }) => ({ records: [makeRecord({ f_status: "s3" }, c.body.records[0]!.id)] }) });
    const first = harness(true, {}, "viwShared");
    await act(async () => void (await first.result.current.update("r1", { f_status: "s3" })));
    expect(first.result.current.history.canUndo).toBe(true);
    first.unmount();
    // Back from the page: the screen is built again, on the same history.
    const again = harness(true, {}, "viwShared");
    expect(again.result.current.history.canUndo).toBe(true);
    again.unmount();
    // Staying in the folder keeps it; leaving the folder for good lets it go.
    forgetUndoHistories("app1");
    expect(harness(true, {}, "viwShared").result.current.history.canUndo).toBe(true);
    forgetUndoHistories("app2");
    expect(harness(true, {}, "viwShared").result.current.history.canUndo).toBe(false);
  });

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
    const first = harness(true, {}, "viwShared");
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

  it("updateAndMove rolls everything back when the value cannot be saved", async () => {
    mockApi({ "PATCH /api/tables/tbl1/records": apiError(400, "invalid_value", "nope") });
    const { result, cached } = harness();
    await act(async () => {
      expect(await result.current.updateAndMove("r1", { f_status: "s2" }, { afterId: "r3" })).toBe(false);
    });
    expect(ids(cached())).toEqual(["r1", "r2", "r3"]);
    expect(cached().records[0]!.values).toEqual({ f_status: "s1" });
    expect(result.current.history.canUndo).toBe(false);
  });

  it("keeps a saved value when only the move fails, refetches, and can still undo the value", async () => {
    const api = mockApi({ "PATCH /api/tables/tbl1/records": { records: [makeRecord({ f_status: "s2" }, "r1")] }, "POST /api/tables/tbl1/records/move": apiError(500, "internal", "nope") });
    const { result, cached } = harness();
    await act(async () => {
      expect(await result.current.updateAndMove("r1", { f_status: "s2" }, { afterId: "r3" })).toBe(false);
    });
    expect(ids(cached())).toEqual(["r1", "r2", "r3"]);
    expect(cached().records[0]!.values).toEqual({ f_status: "s2" });
    expect(await screen.findByText("The change was saved, but the record could not be moved to that place")).toBeTruthy();
    expect(result.current.history.undoLabel).toBe("Edit record");
    await act(async () => result.current.history.undo());
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[1]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s1" } }] });
  });

  it("undoes and redoes an edit with the values it replaced", async () => {
    const api = mockApi({ "PATCH /api/tables/tbl1/records": (c: { body: { records: { id: string; values: Record<string, unknown> }[] } }) => ({ records: [makeRecord(c.body.records[0]!.values, "r1")] }) });
    const { result, cached } = harness();
    await act(async () => void (await result.current.update("r1", { f_status: "s3" }, { label: "Edit status" })));
    expect(result.current.history).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Edit status" });
    await act(async () => result.current.history.undo());
    expect(cached().records[0]!.values).toEqual({ f_status: "s1" });
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[1]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s1" } }] });
    expect(result.current.history).toMatchObject({ canUndo: false, canRedo: true });
    await act(async () => result.current.history.redo());
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[2]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s3" } }] });
  });

  it("undoes a drop (value and place) as one step", async () => {
    const api = mockApi({ "PATCH /api/tables/tbl1/records": { records: [makeRecord({ f_status: "s2" }, "r1")] }, "POST /api/tables/tbl1/records/move": { records: [] } });
    const { result, cached } = harness();
    await act(async () => void (await result.current.updateAndMove("r1", { f_status: "s2" }, { afterId: "r3" })));
    expect(ids(cached())).toEqual(["r2", "r3", "r1"]);
    // The drop shows a toast with Undo.
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    await act(async () => result.current.history.undo());
    const moves = api.callsTo("POST /api/tables/tbl1/records/move");
    expect(moves[1]!.body).toEqual({ ids: ["r1"], before_id: "r2", after_id: null });
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[1]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s1" } }] });
  });

  it("deletes records at once, with a toast whose Undo restores them", async () => {
    const api = mockApi({ "DELETE /api/tables/tbl1/records": null, "POST /api/tables/tbl1/records/restore": { records: [] } });
    const { result, cached } = harness();
    await act(async () => void (await result.current.remove(["r1", "r2"])));
    expect(ids(cached())).toEqual(["r3"]);
    expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r1", "r2"] });
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/restore")[0]!.body).toEqual({ ids: ["r1", "r2"] }));
    expect(result.current.history.canRedo).toBe(true);
  });

  it("puts a record back when the delete fails", async () => {
    mockApi({ "DELETE /api/tables/tbl1/records": apiError(500, "internal", "nope") });
    const { result, cached } = harness();
    await act(async () => expect(await result.current.remove(["r1"])).toBe(false));
    expect(ids(cached())).toEqual(["r1", "r2", "r3"]);
    expect(result.current.history.canUndo).toBe(false);
  });

  it("duplicates records in one request and undoes the copies together", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/records/duplicate": { records: [makeRecord({}, "copy1"), makeRecord({}, "copy2")] }, "DELETE /api/tables/tbl1/records": null });
    const { result, cached } = harness();
    let copies: unknown[] = [];
    await act(async () => void (copies = await result.current.duplicate(cached().records.slice(0, 2))));
    expect(copies).toHaveLength(2);
    expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")).toHaveLength(1);
    expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")[0]!.body).toEqual({ ids: ["r1", "r2"] });
    await act(async () => result.current.history.undo());
    expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["copy1", "copy2"] });
  });

  it("adds one record for a double click", async () => {
    let release!: () => void;
    const api = mockApi({ "POST /api/tables/tbl1/records": () => new Promise<unknown>((r) => (release = () => r({ records: [makeRecord({}, "new1")] }))) });
    const { result } = harness();
    let first!: Promise<unknown>;
    let second: unknown = "pending";
    act(() => {
      first = result.current.create({});
    });
    await act(async () => void (second = await result.current.create({})));
    expect(second).toBeNull();
    release();
    await act(async () => void (await first));
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1);
  });

  it("starts a new record with the values of the view's filter, under the values given", async () => {
    const filter: Filter = { conjunction: "and", items: [{ field_id: "f_status", op: "is", value: "s3" }, { field_id: "f_name", op: "is", value: "Task" }] };
    const api = mockApi({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "new1")] } });
    const { result } = harness(true, { queryConfig: { filter } });
    expect(result.current.prefill({ f_status: "s2" })).toEqual({ f_status: "s2", f_name: "Task" });
    await act(async () => void (await result.current.create({ f_name: "Mine" })));
    expect((api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records[0]!.values).toEqual({ f_status: "s3", f_name: "Mine" });
  });

  it("tells the record page what the new record was made with, and forgets it when its add is undone or it is deleted", async () => {
    const made = makeRecord({ f_status: "s1" }, "new1");
    mockApi({ "POST /api/tables/tbl1/records": { records: [made] }, "DELETE /api/tables/tbl1/records": null });
    const { result } = harness();
    await act(async () => void (await result.current.create({ f_status: "s1" })));
    expect(isNewRecord("new1")).toBe(true);
    await act(async () => void (await result.current.remove(["new1"])));
    expect(isNewRecord("new1")).toBe(false);
    await act(async () => void (await result.current.create({ f_status: "s1" })));
    expect(isNewRecord("new1")).toBe(true);
    await act(async () => void (await result.current.history.undo()));
    expect(isNewRecord("new1")).toBe(false);
  });

  it("undoes the add of a record that was already taken back without an error", async () => {
    // The grid takes back a new record left untouched, and undo moves the selection off it, so the two can race.
    mockApi({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "new1")] }, "DELETE /api/tables/tbl1/records": apiError(404, "not_found", "no such record") });
    const { result } = harness();
    await act(async () => void (await result.current.create({})));
    await act(async () => void (await result.current.history.undo()));
    expect(screen.queryByText(/Could not undo/)).toBeNull();
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
