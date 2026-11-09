import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { field, makeRecord, makeTable } from "@/test/fields";
import { mockApi } from "@/test/utils";
import { discardNewRecord, forgetNewRecord, isNewRecord, rememberNewRecord } from "./newRecords";

afterEach(() => vi.unstubAllGlobals());

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const status = field("single_select", { choices: [{ id: "s1", name: "Todo", color: "blue" }] }, { id: "fld_status", name: "Status" });
const table = makeTable([name, status]);
const record = (values: Record<string, unknown>) => makeRecord(values, "new1");

const GET = "GET /api/tables/tbl1/records/new1";
const DISCARD = "POST /api/tables/tbl1/records/new1/discard";

describe("a record added a moment ago", () => {
  it("is taken back when nothing was put into it, the values its view filled in counting as nothing", async () => {
    const api = mockApi({ [GET]: record({ fld_status: "s1" }), [DISCARD]: { discarded: true } });
    rememberNewRecord("new1", { fld_status: "s1" });
    expect(isNewRecord("new1")).toBe(true);
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(true);
    expect(api.callsTo(DISCARD)).toHaveLength(1);
    // Neither the trash nor a delete: it was never really there.
    expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(0);
    expect(isNewRecord("new1")).toBe(false);
  });

  it("takes its add out of the undo history when it is taken back, and keeps it there when it stays", async () => {
    mockApi({ [GET]: record({}), [DISCARD]: { discarded: true } });
    const dropped = vi.fn();
    rememberNewRecord("new1", {}, dropped);
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(true);
    expect(dropped).toHaveBeenCalledTimes(1);

    mockApi({ [GET]: record({ fld_name: "Typed" }) });
    const kept = vi.fn();
    rememberNewRecord("new1", {}, kept);
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(false);
    expect(kept).not.toHaveBeenCalled();
  });

  it("stays when the server says it was touched", async () => {
    mockApi({ [GET]: record({}), [DISCARD]: { discarded: false } });
    rememberNewRecord("new1", {});
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(false);
  });

  it("stays when something was typed into it, and is not asked about twice", async () => {
    const api = mockApi({ [GET]: record({ fld_name: "Typed" }), [DISCARD]: { discarded: true } });
    rememberNewRecord("new1", {});
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(false);
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(false);
    expect(api.callsTo(DISCARD)).toHaveLength(0);
    expect(api.callsTo(GET)).toHaveLength(1);
  });

  it("is left alone when it was not just added, or is already gone", async () => {
    const api = mockApi({ [GET]: record({}) });
    expect(await discardNewRecord(new QueryClient(), table, "other")).toBe(false);
    rememberNewRecord("new1", {});
    forgetNewRecord("new1");
    expect(await discardNewRecord(new QueryClient(), table, "new1")).toBe(false);
    expect(api.calls).toHaveLength(0);
  });
});
