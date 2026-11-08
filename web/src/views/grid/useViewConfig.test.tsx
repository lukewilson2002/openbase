import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { keys } from "@/api/keys";
import type { BaseSchema, Filter, View, ViewConfig } from "@/api/types";
import { addSortLike, setFilter, setRowColor, setSummary } from "@/components/viewbar/config";
import { Providers, createQueryClient } from "@/providers";
import { USER, makeSchema, makeView, mockApi } from "@/test/utils";
import { readDraft, resetDraftStore, writeDraft } from "../drafts/store";
import { fingerprint } from "../drafts/draft";
import { effectiveConfig, gridRecordLayout, useViewConfig } from "./useViewConfig";

const condition: Filter = { conjunction: "and", items: [{ field_id: "fld1", op: "contains", value: "x" }] };

function baseConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...makeView({ id: "viw1" }).config, ...over };
}

beforeEach(() => {
  localStorage.clear();
  resetDraftStore();
});

describe("gridRecordLayout", () => {
  const config = (field_order: string[], hidden_fields: string[] = []) => ({ ...makeView({ id: "x" }).config, field_order, hidden_fields });

  it("takes the default grid's order and hidden fields, over the other grids and view types", () => {
    const views = [
      makeView({ id: "viwGrid", config: config(["fldDue", "fldStart"]) }),
      makeView({ id: "viwDefault", is_default: true, config: config(["fldStart", "fldDue"], ["fldNotes"]) }),
    ];
    expect(gridRecordLayout({ views })).toEqual({ field_order: ["fldStart", "fldDue"], hidden_fields: ["fldNotes"] });
  });

  it("without a default grid, takes the first shared grid's, over personal grids and other view types", () => {
    const views = [
      makeView({ id: "viwKanban", type: "kanban", config: config(["fldDue", "fldStart"]) }),
      makeView({ id: "viwMine", personal: true, config: config(["fldDue"]) }),
      makeView({ id: "viwGrid", config: config(["fldStart", "fldDue"], ["fldNotes"]) }),
    ];
    expect(gridRecordLayout({ views })).toEqual({ field_order: ["fldStart", "fldDue"], hidden_fields: ["fldNotes"] });
  });

  it("falls back to a personal grid, and is null without any grid", () => {
    expect(gridRecordLayout({ views: [makeView({ id: "viwMine", personal: true, config: config(["fldDue"]) })] })?.field_order).toEqual(["fldDue"]);
    expect(gridRecordLayout({ views: [makeView({ id: "viwKanban", type: "kanban" })] })).toBeNull();
  });

  it("is the grid as saved: a person's draft is for the view it was made in", () => {
    writeDraft("usr1", "viwGridLocal", { v: 1, base: "x", started: 1, changes: { field_order: ["fldDue", "fldStart"] } });
    const views = [makeView({ id: "viwGridLocal", config: config(["fldStart", "fldDue"], ["fldNotes"]) })];
    expect(gridRecordLayout({ views })).toEqual({ field_order: ["fldStart", "fldDue"], hidden_fields: ["fldNotes"] });
  });
});

describe("effectiveConfig", () => {
  it("cleans only the draft's own settings of properties that are gone", () => {
    const saved = baseConfig({ sorts: [{ field_id: "fldGone", direction: "asc" }] });
    const draft = { v: 1 as const, base: "x", started: 1, changes: { filter: { conjunction: "and" as const, items: [{ field_id: "fldGone", op: "is" as const, value: "x" }] }, hidden_fields: ["fld1", "fldGone"] } };
    const config = effectiveConfig(saved, draft, new Set(["fld1"]));
    expect(config.filter ?? null).toBeNull();
    expect(config.hidden_fields).toEqual(["fld1"]);
    // The saved sort was already stale: that is not the draft's doing.
    expect(config.sorts).toEqual(saved.sorts);
  });

  it("is the saved config itself without a draft", () => {
    const saved = baseConfig();
    expect(effectiveConfig(saved, null, new Set())).toBe(saved);
  });
});

function setup(role: string, over: Partial<View> = {}, opts: { user?: string } = {}) {
  const schema = makeSchema(role);
  const view = makeView({ id: "viw1", ...over });
  schema.tables[0]!.views = [view, ...schema.tables[0]!.views.filter((v) => v.id !== "viw1")];
  const table = schema.tables[0]!;
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(keys.me, { ...USER, id: opts.user ?? "usr1" });
  client.setQueryData(keys.base("app1"), schema);
  const wrapper = ({ children }: { children: ReactNode }) => <Providers client={client}>{children}</Providers>;
  const hook = renderHook(({ v }) => useViewConfig(schema, table, v, role), { wrapper, initialProps: { v: view } });
  return { hook, view, client, schema };
}

const patchBody = (api: ReturnType<typeof mockApi>, id = "viw1") => (api.callsTo(`PATCH /api/views/${id}`).at(-1)?.body as { config: ViewConfig } | undefined)?.config;

describe("every change is a draft", () => {
  it.each(["viewer", "commenter", "editor", "creator", "owner"])("as %s: keeps filter, sort and group as a draft sent with queries, and never PATCHes the view", async (role) => {
    const api = mockApi({});
    const { hook } = setup(role);
    expect(hook.result.current.transient).toBeNull();
    expect(hook.result.current.draft).toBeNull();

    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    act(() => hook.result.current.update((c) => addSortLike(c, "sorts", "fld1", "desc")));
    act(() => hook.result.current.update((c) => addSortLike(c, "groups", "fld1")));

    expect(hook.result.current.transient).toEqual({
      filter: condition,
      sorts: [{ field_id: "fld1", direction: "desc" }],
      groups: [{ field_id: "fld1", direction: "asc" }],
    });
    // What is rendered and what the query key is built from both include the draft.
    expect(hook.result.current.config.filter).toEqual(condition);
    expect(hook.result.current.queryConfig.sorts).toHaveLength(1);
    expect(hook.result.current.saving).toBe(false);
    // There is no timer that saves it later.
    await new Promise((r) => setTimeout(r, 500));
    expect(api.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("sends row colors and summaries as part of the draft, so the server computes them", () => {
    mockApi({});
    const { hook } = setup("viewer");
    act(() => hook.result.current.update((c) => setRowColor(c, { mode: "by_select", field_id: "fld1" })));
    act(() => hook.result.current.update((c) => setSummary(c, "fld1", "count_all" as never)));
    expect(hook.result.current.transient).toEqual({ row_color: { mode: "by_select", field_id: "fld1" }, summaries: { fld1: "count_all" } });
    expect(hook.result.current.queryConfig.row_color).toEqual({ mode: "by_select", field_id: "fld1" });
    expect(hook.result.current.queryConfig.summaries).toEqual({ fld1: "count_all" });
  });

  it("keeps layout settings out of the query: widths, order, hidden fields, row height and the like", () => {
    mockApi({});
    const { hook } = setup("editor");
    act(() => hook.result.current.update((c) => ({ ...c, field_widths: { fld1: 320 }, row_height: "tall", frozen_columns: 1, hidden_fields: ["fld1"], wrap_headers: true })));
    expect(hook.result.current.transient).toBeNull();
    expect(hook.result.current.config).toMatchObject({ field_widths: { fld1: 320 }, row_height: "tall", frozen_columns: 1, wrap_headers: true });
    expect(hook.result.current.draft?.changes).toMatchObject({ field_widths: { fld1: 320 }, row_height: "tall" });
    expect(hook.result.current.queryConfig.field_widths).toEqual({});
  });

  it("takes a layout's own settings and the description property as drafts too", () => {
    mockApi({});
    const { hook } = setup("viewer", { type: "kanban" });
    act(() => hook.result.current.update((c) => ({ ...c, kanban: { ...c.kanban, stack_field_id: "fld1" }, description_field_id: "fld1" })));
    expect(hook.result.current.config.kanban.stack_field_id).toBe("fld1");
    expect(hook.result.current.config.description_field_id).toBe("fld1");
    expect(Object.keys(hook.result.current.draft!.changes).sort()).toEqual(["description_field_id", "kanban"]);
  });

  it("survives a reload, per person and view, and goes with Reset", () => {
    mockApi({});
    const first = setup("commenter");
    act(() => first.hook.result.current.update((c) => setFilter(c, condition)));
    expect(localStorage.getItem("ob-view-draft:usr1:viw1")).not.toBeNull();
    first.hook.unmount();

    const again = setup("commenter");
    expect(again.hook.result.current.transient).toEqual({ filter: condition });
    // Another person on the same browser starts clean.
    expect(setup("commenter", {}, { user: "usr2" }).hook.result.current.transient).toBeNull();
    act(() => again.hook.result.current.reset());
    expect(again.hook.result.current.transient).toBeNull();
    expect(again.hook.result.current.queryConfig.filter ?? null).toBeNull();
    expect(localStorage.getItem("ob-view-draft:usr1:viw1")).toBeNull();
    again.hook.unmount();
    expect(setup("commenter").hook.result.current.draft).toBeNull();
  });

  it("is gone once the changes are undone by hand", () => {
    mockApi({});
    const { hook } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    expect(hook.result.current.draft).not.toBeNull();
    act(() => hook.result.current.update((c) => setFilter(c, null)));
    expect(hook.result.current.draft).toBeNull();
    expect(localStorage.getItem("ob-view-draft:usr1:viw1")).toBeNull();
  });

  it("removing the last condition of a saved filter overrides it with an empty filter", () => {
    mockApi({});
    const { hook } = setup("viewer", { config: baseConfig({ filter: condition }) });
    expect(hook.result.current.config.filter).toEqual(condition);
    act(() => hook.result.current.update((c) => setFilter(c, null)));
    expect(hook.result.current.transient).toEqual({ filter: { conjunction: "and", items: [] } });
    expect(hook.result.current.config.filter ?? null).toBeNull();
    expect(hook.result.current.queryConfig.filter ?? null).toBeNull();
  });

  it("drops properties that no longer exist before they can reach the server", () => {
    mockApi({});
    const { hook } = setup("editor", { locked: true });
    act(() => hook.result.current.update((c) => setFilter(c, { conjunction: "and", items: [{ field_id: "fld_gone", op: "is", value: "x" }] })));
    expect(hook.result.current.transient).toBeNull();
    expect(hook.result.current.draft).toBeNull();
  });

  it("two changes in a row both count", () => {
    mockApi({});
    const { hook } = setup("viewer");
    act(() => {
      hook.result.current.update((c) => setFilter(c, condition));
      hook.result.current.update((c) => addSortLike(c, "sorts", "fld1"));
    });
    expect(hook.result.current.transient).toEqual({ filter: condition, sorts: [{ field_id: "fld1", direction: "asc" }] });
  });

  it("shows the same records in another layout, as a draft", () => {
    mockApi({});
    const { hook } = setup("viewer");
    expect(hook.result.current.layout).toBe("grid");
    act(() => hook.result.current.setLayout("kanban"));
    expect(hook.result.current.layout).toBe("kanban");
    expect(hook.result.current.draft?.layout).toBe("kanban");
    act(() => hook.result.current.setLayout("grid"));
    expect(hook.result.current.draft).toBeNull();
  });
});

describe("moving the old local entries into the draft", () => {
  it("shows a viewer's old local layout and override as the draft, and deletes the old entries", async () => {
    mockApi({});
    localStorage.setItem("ob-view-local:viw1", JSON.stringify({ hidden_fields: [], field_order: [], field_widths: { fld1: 280 }, frozen_columns: 0, row_height: "short" }));
    localStorage.setItem("ob-view-transient:viw1", JSON.stringify({ filter: condition, sorts: [{ field_id: "fld1", direction: "desc" }] }));
    const { hook } = setup("viewer");
    expect(hook.result.current.config.field_widths).toEqual({ fld1: 280 });
    expect(hook.result.current.transient).toEqual({ filter: condition, sorts: [{ field_id: "fld1", direction: "desc" }] });
    expect(localStorage.getItem("ob-view-local:viw1")).toBeNull();
    expect(localStorage.getItem("ob-view-transient:viw1")).toBeNull();
    // The draft meets its view: it takes the view's fingerprint and drops what equals the saved view.
    await waitFor(() => expect(hook.result.current.draft?.base).toBe(fingerprint(baseConfig())));
    expect(Object.keys(hook.result.current.draft!.changes).sort()).toEqual(["field_widths", "filter", "sorts"]);
    expect(hook.result.current.changedOnServer).toBe(false);
  });
});

describe("Update view", () => {
  it("writes the draft to the view, right then, with the whole config, and the draft is gone", async () => {
    const view = makeView({ id: "viw1" });
    const api = mockApi({ "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }) });
    const { hook, client } = setup("editor", {}, {});
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    act(() => hook.result.current.update((c) => ({ ...c, field_widths: { fld1: 300 } })));
    expect(hook.result.current.actions.canUpdate).toBe(true);
    let ok = false;
    await act(async () => void (ok = await hook.result.current.updateView()));
    expect(ok).toBe(true);
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1);
    expect(patchBody(api)).toMatchObject({ filter: condition, field_widths: { fld1: 300 }, sorts: [] });
    expect(readDraft("usr1", "viw1")).toBeNull();
    expect(client.getQueryData<BaseSchema>(keys.base("app1"))!.tables[0]!.views[0]!.config.filter).toEqual(condition);
  });

  it("is for people who may configure the view: not viewers, not editors on a locked view, and not into another layout", async () => {
    const api = mockApi({});
    for (const [role, over] of [["viewer", {}], ["commenter", {}], ["editor", { locked: true }]] as const) {
      const { hook } = setup(role, over);
      act(() => hook.result.current.update((c) => setFilter(c, condition)));
      expect(hook.result.current.actions.canUpdate).toBe(false);
      let ok = true;
      await act(async () => void (ok = await hook.result.current.updateView()));
      expect(ok).toBe(false);
      expect(hook.result.current.draft).not.toBeNull();
      hook.unmount();
      localStorage.clear();
    }
    const { hook } = setup("creator");
    act(() => hook.result.current.setLayout("kanban"));
    expect(hook.result.current.actions.canUpdate).toBe(false);
    await act(async () => void (await hook.result.current.updateView()));
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);
  });

  it("a creator can update a locked view", async () => {
    const view = makeView({ id: "viw1", locked: true });
    const api = mockApi({ "PATCH /api/views/viw1": view });
    const { hook } = setup("creator", { locked: true });
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    await act(async () => void (await hook.result.current.updateView()));
    expect(patchBody(api)?.filter).toEqual(condition);
  });

  it("keeps the draft and says so when the server refuses", async () => {
    mockApi({ "PATCH /api/views/viw1": { status: 403, json: { error: { code: "forbidden", message: "no" } } } });
    const { hook } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    let ok = true;
    await act(async () => void (ok = await hook.result.current.updateView()));
    expect(ok).toBe(false);
    expect(hook.result.current.draft?.changes.filter).toEqual(condition);
    expect(hook.result.current.saving).toBe(false);
  });

  it("on the default grid saves the layout settings only, and the filter stays a draft", async () => {
    const view = makeView({ id: "viw1", is_default: true });
    const api = mockApi({ "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }) });
    const { hook } = setup("editor", { is_default: true });
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    // A filter alone gives nothing to update: it can only become a new view.
    expect(hook.result.current.actions.canUpdate).toBe(false);
    act(() => hook.result.current.update((c) => ({ ...c, field_widths: { fld1: 320 } })));
    expect(hook.result.current.actions.canUpdate).toBe(true);
    await act(async () => void (await hook.result.current.updateView()));
    const saved = patchBody(api)!;
    expect(saved.field_widths).toEqual({ fld1: 320 });
    expect(saved.filter ?? null).toBeNull();
    expect(saved.sorts).toEqual([]);
    // The width is saved; the filter is still this person's own.
    expect(hook.result.current.draft?.changes).toEqual({ filter: condition });
    expect(hook.result.current.transient).toEqual({ filter: condition });
  });
});

describe("Save as view", () => {
  it("makes a new view of what is shown, in the layout shown, and drops the draft", async () => {
    const created = makeView({ id: "viwNew", name: "Won deals", type: "kanban", personal: true });
    const api = mockApi({ "POST /api/tables/tbl1/views": created });
    const { hook, client } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    act(() => hook.result.current.setLayout("kanban"));
    let result: View | undefined;
    await act(async () => void (result = await hook.result.current.saveAsView({ name: "Won deals", personal: true })));
    expect(result?.id).toBe("viwNew");
    const body = api.callsTo("POST /api/tables/tbl1/views")[0]!.body as { name: string; type: string; personal: boolean; config: ViewConfig };
    expect(body).toMatchObject({ name: "Won deals", type: "kanban", personal: true });
    expect(body.config.filter).toEqual(condition);
    expect(readDraft("usr1", "viw1")).toBeNull();
    // The schema is asked for again so the new view is there to open.
    expect(client.getQueryState(keys.base("app1"))?.isInvalidated).toBe(true);
  });

  it("shares with everyone when asked, and leaves the draft when the server refuses", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/views": { status: 403, json: { error: { code: "forbidden", message: "creating a shared view needs the creator role" } } } });
    const { hook } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    await act(async () => {
      await expect(hook.result.current.saveAsView({ name: "x", personal: false })).rejects.toThrow(/creator/);
    });
    expect((api.callsTo("POST /api/tables/tbl1/views")[0]!.body as { personal: boolean }).personal).toBe(false);
    expect(hook.result.current.draft).not.toBeNull();
  });

  it("makes a form from another layout with the server's own defaults", async () => {
    const api = mockApi({ "POST /api/tables/tbl1/views": makeView({ id: "viwForm", type: "form" }) });
    const { hook } = setup("editor");
    act(() => hook.result.current.setLayout("form"));
    await act(async () => void (await hook.result.current.saveAsView({ name: "Intake", personal: true })));
    expect((api.callsTo("POST /api/tables/tbl1/views")[0]!.body as { config: unknown }).config).toBeNull();
  });
});

describe("the view changed on the server", () => {
  it("says so once the saved config differs from the one the draft started from, and keeps the draft", () => {
    mockApi({});
    const { hook, view } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    expect(hook.result.current.changedOnServer).toBe(false);
    hook.rerender({ v: { ...view, config: { ...view.config, row_height: "tall" } } });
    expect(hook.result.current.changedOnServer).toBe(true);
    // The draft is still there, laid over the new saved config.
    expect(hook.result.current.config.filter).toEqual(condition);
    expect(hook.result.current.config.row_height).toBe("tall");
    act(() => hook.result.current.reset());
    expect(hook.result.current.changedOnServer).toBe(false);
  });

  it("is quiet for a view that did not change, even when its object is a new one", () => {
    mockApi({});
    const { hook, view } = setup("editor");
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    hook.rerender({ v: JSON.parse(JSON.stringify(view)) as View });
    expect(hook.result.current.changedOnServer).toBe(false);
  });
});

describe("a form saves as it is made", () => {
  const formOf = (title: string) => (c: ViewConfig): ViewConfig => ({ ...c, form: { ...c.form, title } });

  it("PATCHes right away, without a timer, and is not a draft", async () => {
    const view = makeView({ id: "viw1", type: "form" });
    const api = mockApi({ "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }) });
    const { hook, client } = setup("editor", { type: "form" });
    expect(hook.result.current.canEditForm).toBe(true);
    act(() => hook.result.current.saveNow(formOf("Intake")));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect(patchBody(api)?.form.title).toBe("Intake");
    expect(hook.result.current.draft).toBeNull();
    // The cached schema has it before the server answers, so the builder never shows the old text.
    expect(client.getQueryData<BaseSchema>(keys.base("app1"))!.tables[0]!.views[0]!.config.form.title).toBe("Intake");
  });

  it("goes through update too, and sends one request at a time with the latest state last", async () => {
    const view = makeView({ id: "viw1", type: "form" });
    let release: () => void = () => {};
    let first = true;
    const api = mockApi({
      "PATCH /api/views/viw1": async (call: { body: unknown }) => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
        return { ...view, config: (call.body as { config: ViewConfig }).config };
      },
    });
    const { hook } = setup("editor", { type: "form" });
    act(() => hook.result.current.update(formOf("I")));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    act(() => hook.result.current.update(formOf("In")));
    act(() => hook.result.current.update(formOf("Int")));
    expect(hook.result.current.saving).toBe(true);
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(2));
    expect(patchBody(api)?.form.title).toBe("Int");
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
  });

  it("does not make the view look changed under the person's own draft", async () => {
    const view = makeView({ id: "viw1", type: "form" });
    mockApi({ "PATCH /api/views/viw1": (call: { body: unknown }) => ({ ...view, config: (call.body as { config: ViewConfig }).config }) });
    const { hook, view: v0 } = setup("editor", { type: "form" });
    act(() => hook.result.current.update((c) => setFilter(c, condition)));
    act(() => hook.result.current.saveNow(formOf("Intake")));
    hook.rerender({ v: { ...v0, config: { ...v0.config, form: { ...v0.config.form, title: "Intake" } } } });
    expect(hook.result.current.changedOnServer).toBe(false);
  });

  it("is for people who may change the form: not a viewer, not a form shown as the layout of another view", () => {
    const api = mockApi({});
    const viewer = setup("viewer", { type: "form" });
    expect(viewer.hook.result.current.canEditForm).toBe(false);
    act(() => viewer.hook.result.current.saveNow(formOf("x")));
    expect(setup("editor").hook.result.current.canEditForm).toBe(false);
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);
  });

  it("asks for the schema again when the server refuses, to give the old form back", async () => {
    const api = mockApi({ "PATCH /api/views/viw1": { status: 403, json: { error: { code: "forbidden", message: "a public link is on" } } } });
    const { hook, client } = setup("editor", { type: "form" });
    act(() => hook.result.current.saveNow(formOf("Intake")));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    expect(client.getQueryState(keys.base("app1"))?.isInvalidated).toBe(true);
  });
});
