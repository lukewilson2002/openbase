import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Filter, ViewConfig } from "@/api/types";
import { addSortLike, setFilter } from "@/components/viewbar/config";
import { Providers, createQueryClient } from "@/providers";
import { makeSchema, makeView, mockApi } from "@/test/utils";
import { applyTransient, canConfigureView, diffTransient, gridRecordLayout, useViewConfig } from "./useViewConfig";

const condition: Filter = { conjunction: "and", items: [{ field_id: "fld1", op: "contains", value: "x" }] };

function baseConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...makeView({ id: "viw1" }).config, ...over };
}

describe("diffTransient / applyTransient", () => {
  it("is null when nothing differs from the saved config", () => {
    const saved = baseConfig({ filter: condition, sorts: [{ field_id: "fld1", direction: "asc" }] });
    expect(diffTransient(saved, saved)).toBeNull();
    expect(applyTransient(saved, null)).toBe(saved);
  });

  it("contains only the parts that differ", () => {
    const saved = baseConfig();
    const next = baseConfig({ filter: condition });
    expect(diffTransient(saved, next)).toEqual({ filter: condition });
    const sorted = baseConfig({ sorts: [{ field_id: "fld1", direction: "desc" }], groups: [{ field_id: "fld1", direction: "asc" }] });
    expect(diffTransient(saved, sorted)).toEqual({ sorts: sorted.sorts, groups: sorted.groups });
  });

  it("clears a saved filter with a filter without items, and sorts with an empty list", () => {
    const saved = baseConfig({ filter: condition, sorts: [{ field_id: "fld1", direction: "asc" }] });
    const cleared = baseConfig();
    const t = diffTransient(saved, cleared);
    expect(t).toEqual({ filter: { conjunction: "and", items: [] }, sorts: [] });
    const effective = applyTransient(saved, t);
    expect(effective.filter).toBeNull();
    expect(effective.sorts).toEqual([]);
  });

  it("keeps the saved value of parts the override leaves out", () => {
    const saved = baseConfig({ filter: condition, groups: [{ field_id: "fld1", direction: "asc" }] });
    const effective = applyTransient(saved, { sorts: [{ field_id: "fld1", direction: "desc" }] });
    expect(effective.filter).toEqual(condition);
    expect(effective.groups).toEqual(saved.groups);
    expect(effective.sorts).toEqual([{ field_id: "fld1", direction: "desc" }]);
  });
});

describe("canConfigureView", () => {
  it("follows the server rules for shared, locked and personal views", () => {
    expect(canConfigureView("viewer", { personal: false, locked: false })).toBe(false);
    expect(canConfigureView("commenter", { personal: false, locked: false })).toBe(false);
    expect(canConfigureView("editor", { personal: false, locked: false })).toBe(true);
    expect(canConfigureView("editor", { personal: false, locked: true })).toBe(false);
    expect(canConfigureView("creator", { personal: false, locked: true })).toBe(true);
    expect(canConfigureView("editor", { personal: true, locked: true })).toBe(true);
    expect(canConfigureView("viewer", { personal: true, locked: false })).toBe(false);
  });
});

describe("gridRecordLayout", () => {
  const config = (field_order: string[], hidden_fields: string[] = []) => ({ ...makeView({ id: "x" }).config, field_order, hidden_fields });

  it("takes the first shared grid's order and hidden fields, over personal grids and other view types", () => {
    const views = [
      makeView({ id: "viwKanban", type: "kanban", config: config(["fldDue", "fldStart"]) }),
      makeView({ id: "viwMine", personal: true, config: config(["fldDue"]) }),
      makeView({ id: "viwGrid", config: config(["fldStart", "fldDue"], ["fldNotes"]) }),
    ];
    expect(gridRecordLayout({ views }, "editor")).toEqual({ field_order: ["fldStart", "fldDue"], hidden_fields: ["fldNotes"] });
  });

  it("falls back to a personal grid, and is null without any grid", () => {
    expect(gridRecordLayout({ views: [makeView({ id: "viwMine", personal: true, config: config(["fldDue"]) })] }, "editor")?.field_order).toEqual(["fldDue"]);
    expect(gridRecordLayout({ views: [makeView({ id: "viwKanban", type: "kanban" })] }, "editor")).toBeNull();
  });

  it("follows the grid as someone who cannot save it has arranged it locally", () => {
    localStorage.setItem("ob-view-local:viwGridLocal", JSON.stringify({ field_order: ["fldDue", "fldStart"] }));
    const views = [makeView({ id: "viwGridLocal", config: config(["fldStart", "fldDue"], ["fldNotes"]) })];
    expect(gridRecordLayout({ views }, "viewer")).toEqual({ field_order: ["fldDue", "fldStart"], hidden_fields: ["fldNotes"] });
    expect(gridRecordLayout({ views }, "editor")?.field_order).toEqual(["fldStart", "fldDue"]);
    localStorage.removeItem("ob-view-local:viwGridLocal");
  });
});

function setup(role: string, view = makeView({ id: "viw1" })) {
  const schema = makeSchema(role);
  const table = schema.tables[0]!;
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => <Providers client={client}>{children}</Providers>;
  const hook = renderHook(({ v }) => useViewConfig(schema, table, v, role), { wrapper, initialProps: { v: view } });
  return { hook, view };
}

describe("useViewConfig for people who cannot save the view", () => {
  it("keeps filter, sort and group as a local override and never PATCHes the view", async () => {
    const api = mockApi({});
    const { hook } = setup("viewer");
    expect(hook.result.current.canConfigure).toBe(false);
    expect(hook.result.current.transient).toBeNull();

    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    act(() => hook.result.current.update((c) => addSortLike(c, "sorts", "fld1", "desc")));
    act(() => hook.result.current.update((c) => addSortLike(c, "groups", "fld1")));

    expect(hook.result.current.transient).toEqual({
      filter: condition,
      sorts: [{ field_id: "fld1", direction: "desc" }],
      groups: [{ field_id: "fld1", direction: "asc" }],
    });
    // What the grid renders and what the query key is built from both include the override.
    expect(hook.result.current.config.filter).toEqual(condition);
    expect(hook.result.current.queryConfig.sorts).toHaveLength(1);
    expect(hook.result.current.saving).toBe(false);
    await new Promise((r) => setTimeout(r, 450));
    expect(api.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("remembers the override per view and drops it on reset", () => {
    const first = setup("commenter");
    act(() => first.hook.result.current.update((c) => setFilter(c, condition)));
    first.hook.unmount();

    const again = setup("commenter");
    expect(again.hook.result.current.transient).toEqual({ filter: condition });
    act(() => again.hook.result.current.resetTransient());
    expect(again.hook.result.current.transient).toBeNull();
    expect(again.hook.result.current.queryConfig.filter ?? null).toBeNull();
    again.hook.unmount();

    expect(setup("commenter").hook.result.current.transient).toBeNull();
  });

  it("removing the last condition of a saved filter overrides it with an empty filter", () => {
    const view = { ...makeView({ id: "viw1" }), config: baseConfig({ filter: condition }) };
    const { hook } = setup("viewer", view);
    expect(hook.result.current.config.filter).toEqual(condition);
    act(() => hook.result.current.update((c) => setFilter(c, null)));
    expect(hook.result.current.transient).toEqual({ filter: { conjunction: "and", items: [] } });
    expect(hook.result.current.config.filter ?? null).toBeNull();
    expect(hook.result.current.queryConfig.filter ?? null).toBeNull();
  });

  it("applies to editors on a locked view too, and drops fields that no longer exist", () => {
    const view = makeView({ id: "viw1", locked: true });
    const { hook } = setup("editor", view);
    expect(hook.result.current.canConfigure).toBe(false);
    act(() => hook.result.current.update((c) => setFilter(c, { conjunction: "and", items: [{ field_id: "fld_gone", op: "is", value: "x" }] })));
    // The unknown field is sanitized away before it can reach the server.
    expect(hook.result.current.transient).toBeNull();
  });
});

describe("useViewConfig for people who can save the view", () => {
  it("PATCHes the full config right away for query changes and sends no override", async () => {
    const view = makeView({ id: "viw1" });
    const api = mockApi({ "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }) });
    const { hook } = setup("editor", view);
    expect(hook.result.current.canConfigure).toBe(true);
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: ViewConfig }).config.filter).toEqual(condition);
    expect(hook.result.current.transient).toBeNull();
  });

  it("a creator can still save a locked view", () => {
    expect(setup("creator", makeView({ id: "viw1", locked: true })).hook.result.current.canConfigure).toBe(true);
  });
});
