import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryResponse, TableRecord } from "@/api/types";
import { createQueryClient } from "@/providers";
import { makeRecord } from "@/test/fields";
import { mockApi } from "@/test/utils";
import { PAGE_SIZE } from "./rowMap";
import { useGridData } from "./useGridData";

const TOTAL = 450;

function recordAt(i: number, label = "r"): TableRecord {
  return makeRecord({ fld_name: `${label}${i}` }, `rec${i}`);
}

/** A server with TOTAL records whose names can be changed to simulate other users' edits. */
function server() {
  let label = "r";
  const requests: { offset: number; limit: number; search: unknown }[] = [];
  const api = mockApi({
    "POST /api/views/viw1/query": (call: { body: unknown }) => {
      const b = call.body as { offset: number; limit: number; search?: string | null };
      requests.push({ offset: b.offset, limit: b.limit, search: b.search });
      const n = Math.max(0, Math.min(b.limit, TOTAL - b.offset));
      const res: QueryResponse = { total: TOTAL, offset: b.offset, records: Array.from({ length: n }, (_, i) => recordAt(b.offset + i, label)), groups: [], colors: { [`rec${b.offset}`]: "red" } };
      return res;
    },
  });
  return { api, requests, rename: (l: string) => (label = l) };
}

function setup(search = "") {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook((p: { search: string }) => useGridData({ tableId: "tbl1", viewId: "viw1", configKey: "k", search: p.search, timeZone: "UTC" }), { wrapper, initialProps: { search } });
  return { client, hook };
}

describe("useGridData", () => {
  it("loads the first page and reports the total", async () => {
    const s = server();
    const { hook } = setup();
    expect(hook.result.current.loading).toBe(true);
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.total).toBe(TOTAL);
    expect(hook.result.current.getRecord(0)?.id).toBe("rec0");
    expect(hook.result.current.getRecord(PAGE_SIZE - 1)?.id).toBe(`rec${PAGE_SIZE - 1}`);
    expect(hook.result.current.getRecord(PAGE_SIZE)).toBeUndefined();
    expect(hook.result.current.rowColor("rec0")).toBe("red");
    expect(s.requests).toEqual([{ offset: 0, limit: PAGE_SIZE, search: null }]);
  });

  it("fetches further pages only as they are requested", async () => {
    const s = server();
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.ensureRange(PAGE_SIZE * 2, PAGE_SIZE * 2 + 10));
    await waitFor(() => expect(hook.result.current.getRecord(PAGE_SIZE * 2 + 5)?.id).toBe(`rec${PAGE_SIZE * 2 + 5}`));
    // Page 2 and one page of look-ahead on each side (1 and, as it exists, none beyond the total).
    expect(s.requests.map((r) => r.offset).sort((a, b) => a - b)).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2]);
    expect(hook.result.current.indexOf(`rec${PAGE_SIZE * 2}`)).toBe(PAGE_SIZE * 2);
  });

  it("loadRange resolves once the pages are present", async () => {
    server();
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => hook.result.current.loadRange(PAGE_SIZE - 1, PAGE_SIZE + 1));
    expect(hook.result.current.getRecord(PAGE_SIZE + 1)?.id).toBe(`rec${PAGE_SIZE + 1}`);
  });

  it("sends the search text and starts over when it changes", async () => {
    const s = server();
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    hook.rerender({ search: "alpha" });
    await waitFor(() => expect(s.requests.some((r) => r.search === "alpha")).toBe(true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.getRecord(0)?.id).toBe("rec0");
  });

  it("applies optimistic patches and can roll them back", async () => {
    server();
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let prev: TableRecord | undefined;
    act(() => {
      prev = hook.result.current.patchValues("rec3", { fld_name: "patched", fld_gone: null, fld_x: false });
    });
    expect(hook.result.current.getRecord(3)?.values).toEqual({ fld_name: "patched" });
    expect(prev?.values.fld_name).toBe("r3");
    act(() => hook.result.current.upsertRecords([prev!]));
    expect(hook.result.current.getRecord(3)?.values.fld_name).toBe("r3");
    // Unknown records are ignored.
    expect(hook.result.current.patchValues("nope", { a: 1 })).toBeUndefined();
  });

  it("refetches visible pages in place when the table's records are invalidated, keeping old rows until then", async () => {
    const s = server();
    const { hook, client } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.ensureRange(0, 5));
    s.rename("changed");
    const before = s.requests.length;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["records", "tbl1"] });
    });
    // Old data stays readable straight away.
    expect(hook.result.current.getRecord(0)).toBeDefined();
    await waitFor(() => expect(hook.result.current.getRecord(0)?.values.fld_name).toBe("changed0"));
    expect(s.requests.length).toBeGreaterThan(before);
    expect(hook.result.current.loading).toBe(false);
  });

  it("drops pages that are out of view on invalidation and fetches them again on demand", async () => {
    const s = server();
    const { hook, client } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.ensureRange(PAGE_SIZE * 2, PAGE_SIZE * 2 + 1));
    await waitFor(() => expect(hook.result.current.getRecord(PAGE_SIZE * 2)).toBeDefined());
    // Scroll back to the top, then an update arrives: page 2 is no longer near the viewport.
    act(() => hook.result.current.ensureRange(0, 5));
    await waitFor(() => expect(s.requests.length).toBeGreaterThanOrEqual(3));
    s.rename("fresh");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["records", "tbl1"] });
    });
    await waitFor(() => expect(hook.result.current.getRecord(PAGE_SIZE * 2)).toBeUndefined());
    expect(hook.result.current.getRecord(0)?.values.fld_name).toBeDefined();
  });

  it("ignores invalidations of other tables", async () => {
    const s = server();
    const { hook, client } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const before = s.requests.length;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["records", "tbl2"] });
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(s.requests.length).toBe(before);
  });

  it("surfaces errors", async () => {
    mockApi({ "POST /api/views/viw1/query": { status: 500, json: { error: { code: "internal", message: "boom" } } } });
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.error?.message).toBe("boom"));
    expect(hook.result.current.loading).toBe(false);
  });
});
