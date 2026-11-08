import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/api/keys";
import { Providers, createQueryClient } from "@/providers";
import { USER } from "@/test/utils";
import type { ViewDraft } from "./draft";
import { draftStorageKey, resetDraftStore, legacyChanges, migrateLegacyDrafts, readDraft, useViewDraft, writeDraft } from "./store";

const sorted: ViewDraft = { v: 1, base: "abc", started: 7, changes: { sorts: [{ field_id: "fld1", direction: "asc" }] } };

beforeEach(() => {
  localStorage.clear();
  resetDraftStore();
});
afterEach(() => {
  vi.restoreAllMocks();
  // Whatever a test left in memory because storage refused it.
  for (const user of ["usr1", "usr2", null]) for (const view of ["viw1", "viw2"]) writeDraft(user, view, null);
});

describe("where a draft lives", () => {
  it("is kept on this device for the person and the view, and survives a reload", () => {
    writeDraft("usr1", "viw1", sorted);
    expect(localStorage.getItem("ob-view-draft:usr1:viw1")).not.toBeNull();
    expect(draftStorageKey("usr1", "viw1")).toBe("ob-view-draft:usr1:viw1");
    // A reload forgets everything but storage.
    expect(JSON.parse(localStorage.getItem("ob-view-draft:usr1:viw1")!)).toEqual(sorted);
    expect(readDraft("usr1", "viw1")).toEqual(sorted);
  });

  it("belongs to the person: someone else on the same browser does not see it, nor does another view", () => {
    writeDraft("usr1", "viw1", sorted);
    expect(readDraft("usr2", "viw1")).toBeNull();
    expect(readDraft("usr1", "viw2")).toBeNull();
  });

  it("hands back the same object while the stored text is the same, and a new one when it changes", () => {
    writeDraft("usr1", "viw1", sorted);
    const first = readDraft("usr1", "viw1");
    expect(readDraft("usr1", "viw1")).toBe(first);
    writeDraft("usr1", "viw1", { ...sorted, started: 8 });
    expect(readDraft("usr1", "viw1")).not.toBe(first);
  });

  it("is removed with null, and a stored value that is not a draft reads as none", () => {
    writeDraft("usr1", "viw1", sorted);
    writeDraft("usr1", "viw1", null);
    expect(localStorage.getItem("ob-view-draft:usr1:viw1")).toBeNull();
    localStorage.setItem("ob-view-draft:usr1:viw1", "{not json");
    expect(readDraft("usr1", "viw1")).toBeNull();
    localStorage.setItem("ob-view-draft:usr1:viw1", JSON.stringify({ v: 1, changes: { sorts: "no" } }));
    expect(readDraft("usr1", "viw1")).toBeNull();
  });

  it("lasts as long as the page when storage refuses it, and does not throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => writeDraft("usr1", "viw1", sorted)).not.toThrow();
    expect(readDraft("usr1", "viw1")).toEqual(sorted);
    vi.restoreAllMocks();
    writeDraft("usr1", "viw1", null);
    expect(readDraft("usr1", "viw1")).toBeNull();
  });

  it("works with storage that cannot even be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readDraft("usr1", "viw1")).toBeNull();
    expect(() => migrateLegacyDrafts("usr1")).not.toThrow();
  });

  it("keeps the drafts of a person who is not known yet in memory only", () => {
    writeDraft(null, "viw1", sorted);
    expect(readDraft(null, "viw1")).toEqual(sorted);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("ob-view-draft:usr"))).toEqual([]);
  });
});

describe("moving the old local entries over", () => {
  const reorder = ["fld2", "fld1"];

  it("turns ob-view-local and ob-view-transient into one draft and deletes both", () => {
    localStorage.setItem("ob-view-local:viwLegacy", JSON.stringify({ hidden_fields: ["fld3"], field_order: reorder, field_widths: { fld1: 300 }, frozen_columns: 1, row_height: "tall" }));
    localStorage.setItem("ob-view-transient:viwLegacy", JSON.stringify({ filter: { conjunction: "and", items: [{ field_id: "fld1", op: "contains", value: "x" }] }, sorts: [{ field_id: "fld1", direction: "desc" }], groups: [{ field_id: "fld2", direction: "asc" }] }));
    migrateLegacyDrafts("usr1");
    expect(localStorage.getItem("ob-view-local:viwLegacy")).toBeNull();
    expect(localStorage.getItem("ob-view-transient:viwLegacy")).toBeNull();
    const draft = readDraft("usr1", "viwLegacy")!;
    expect(draft.base).toBeNull();
    expect(draft.changes).toEqual({
      hidden_fields: ["fld3"],
      field_order: reorder,
      field_widths: { fld1: 300 },
      frozen_columns: 1,
      row_height: "tall",
      filter: { conjunction: "and", items: [{ field_id: "fld1", op: "contains", value: "x" }] },
      sorts: [{ field_id: "fld1", direction: "desc" }],
      groups: [{ field_id: "fld2", direction: "asc" }],
    });
  });

  it("reads an override filter without items as no filter, and moves either entry alone", () => {
    localStorage.setItem("ob-view-transient:viwA", JSON.stringify({ filter: { conjunction: "and", items: [] } }));
    localStorage.setItem("ob-view-local:viwB", JSON.stringify({ row_height: "extra_tall" }));
    migrateLegacyDrafts("usr1");
    expect(readDraft("usr1", "viwA")!.changes).toEqual({ filter: null });
    expect(readDraft("usr1", "viwB")!.changes).toEqual({ row_height: "extra_tall" });
    expect(localStorage.getItem("ob-view-transient:viwA")).toBeNull();
    expect(localStorage.getItem("ob-view-local:viwB")).toBeNull();
  });

  it("deletes entries it cannot use, and leaves a draft the person already has alone", () => {
    localStorage.setItem("ob-view-local:viwBad", "{broken");
    localStorage.setItem("ob-view-transient:viwBad", JSON.stringify({ sorts: "no" }));
    localStorage.setItem("ob-view-local:viwHas", JSON.stringify({ row_height: "tall" }));
    writeDraft("usr1", "viwHas", sorted);
    migrateLegacyDrafts("usr1");
    expect(readDraft("usr1", "viwBad")).toBeNull();
    expect(readDraft("usr1", "viwHas")).toEqual(sorted);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("ob-view-local:") || k.startsWith("ob-view-transient:"))).toEqual([]);
  });

  it("happens once per person and page load, and gives the entries to whoever is signed in first", () => {
    migrateLegacyDrafts("usr1");
    localStorage.setItem("ob-view-local:viwLate", JSON.stringify({ row_height: "tall" }));
    migrateLegacyDrafts("usr1");
    expect(localStorage.getItem("ob-view-local:viwLate")).not.toBeNull();
    migrateLegacyDrafts("usr2");
    expect(readDraft("usr2", "viwLate")!.changes).toEqual({ row_height: "tall" });
  });

  it("legacyChanges ignores what is not an object", () => {
    expect(legacyChanges(null, "x")).toEqual({});
    expect(legacyChanges({ row_height: "tall", other: 1 }, { sorts: [], extra: 1 })).toEqual({ row_height: "tall", sorts: [] });
  });
});

describe("useViewDraft", () => {
  function setup(userId: string | null, viewId = "viw1") {
    const client = createQueryClient();
    client.setQueryData(keys.me, userId ? { ...USER, id: userId } : null);
    const wrapper = ({ children }: { children: ReactNode }) => <Providers client={client}>{children}</Providers>;
    return renderHook(() => useViewDraft(viewId), { wrapper });
  }

  it("follows the draft as it is written and removed", () => {
    const { result } = setup("usr1");
    expect(result.current).toBeNull();
    act(() => writeDraft("usr1", "viw1", sorted));
    expect(result.current).toEqual(sorted);
    act(() => writeDraft("usr1", "viw1", null));
    expect(result.current).toBeNull();
  });

  it("reads a draft left by an earlier page, and migrates the old entries first", () => {
    writeDraft("usr1", "viw1", sorted);
    expect(setup("usr1").result.current).toEqual(sorted);
    resetDraftStore();
    localStorage.setItem("ob-view-local:viw2", JSON.stringify({ row_height: "tall" }));
    expect(setup("usr1", "viw2").result.current?.changes).toEqual({ row_height: "tall" });
  });

  it("follows a change made in another tab", () => {
    const { result } = setup("usr1");
    act(() => {
      localStorage.setItem("ob-view-draft:usr1:viw1", JSON.stringify(sorted));
      window.dispatchEvent(new StorageEvent("storage", { key: "ob-view-draft:usr1:viw1" }));
    });
    expect(result.current).toEqual(sorted);
  });

  it("is the signed-in person's own", () => {
    writeDraft("usr1", "viw1", sorted);
    expect(setup("usr2").result.current).toBeNull();
  });
});
