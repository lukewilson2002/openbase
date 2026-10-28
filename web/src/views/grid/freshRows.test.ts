import { describe, expect, it, vi } from "vitest";
import { ALL_FIELDS, field, makeRecord } from "@/test/fields";
import { discardIfUntouched, isUntouched, type Fresh, type FreshDeps } from "./freshRows";

const name = { ...ALL_FIELDS.text, id: "f_name", name: "Name" };
const status = field("single_select", { choices: [{ id: "s1", name: "Todo", color: "gray" }] }, { id: "f_status", name: "Status" });
const total = { ...ALL_FIELDS.formula!, id: "f_total", name: "Total" };
const fields = [name, status, total];

function deps(over: Partial<FreshDeps> & { now?: Record<string, unknown> } = {}) {
  const discard = vi.fn(async () => ({ discarded: true }));
  const { now = {}, ...rest } = over;
  const d: FreshDeps = { fields, touched: () => false, saving: () => 0, load: async () => makeRecord(now, "rec1"), discard, sleep: async () => {}, ...rest };
  return { d, discard };
}

describe("isUntouched", () => {
  const made: Fresh = { values: { f_status: "s1" }, op: null };

  it("is true while the record holds what it was created with", () => {
    expect(isUntouched(fields, made, { values: { f_status: "s1" } })).toBe(true);
  });

  it("is false once a writable field has a value it did not start with", () => {
    expect(isUntouched(fields, made, { values: { f_status: "s1", f_name: "Hello" } })).toBe(false);
    expect(isUntouched(fields, made, { values: {} })).toBe(false);
  });

  it("ignores computed fields", () => {
    expect(isUntouched(fields, made, { values: { f_status: "s1", f_total: 12 } })).toBe(true);
  });
});

describe("discardIfUntouched", () => {
  const empty: Fresh = { values: {}, op: null };

  it("discards an empty record", async () => {
    const { d, discard } = deps();
    expect(await discardIfUntouched("rec1", empty, d)).toBe(true);
    expect(discard).toHaveBeenCalledWith("rec1");
  });

  it("keeps a record something was written into", async () => {
    const { d, discard } = deps({ now: { f_name: "Hello" } });
    expect(await discardIfUntouched("rec1", empty, d)).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it("counts a record that only holds what its view filled in as untouched", async () => {
    const { d, discard } = deps({ now: { f_status: "s1" } });
    expect(await discardIfUntouched("rec1", { values: { f_status: "s1" }, op: null }, d)).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("keeps a record that was changed, even when the old value was put back", async () => {
    const { d, discard } = deps({ touched: () => true });
    expect(await discardIfUntouched("rec1", empty, d)).toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it("waits for the saves on their way before looking", async () => {
    let pending = 2;
    const { d, discard } = deps({ saving: () => pending, sleep: async () => void pending--, now: { f_name: "typed" } });
    expect(await discardIfUntouched("rec1", empty, d)).toBe(false);
    expect(pending).toBeLessThanOrEqual(0);
    expect(discard).not.toHaveBeenCalled();
  });

  it("keeps the record when the server says it is no longer untouched", async () => {
    const { d } = deps({ discard: async () => ({ discarded: false }) });
    expect(await discardIfUntouched("rec1", empty, d)).toBe(false);
  });

  it("keeps the record when the server fails or cannot find it", async () => {
    expect(await discardIfUntouched("rec1", empty, deps({ discard: async () => Promise.reject(new Error("boom")) }).d)).toBe(false);
    expect(await discardIfUntouched("rec1", empty, deps({ load: async () => undefined }).d)).toBe(false);
    expect(await discardIfUntouched("rec1", empty, deps({ load: async () => Promise.reject(new Error("404")) }).d)).toBe(false);
  });
});
