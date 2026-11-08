/**
 * The TemporaryChangesBar of a view (COL-5): what it says, which buttons each role has, Save as view, and
 * the line for a view that changed on the server. Rendered inside a list view, which draws it through ViewFrame.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { QueryRequest, View, ViewConfig } from "@/api/types";
import { fingerprint, type ViewDraft } from "@/views/drafts/draft";
import { writeDraft } from "@/views/drafts/store";
import { F, draftChanges, projectSchema, rec, renderView, viewWithConfig } from "@/views/common/viewTestUtils";
import ListView from "@/views/list/ListView";
import type { Handler, RecordedCall } from "@/test/utils";

const filtered: Partial<ViewConfig> = { filter: { conjunction: "and", items: [{ field_id: F.status.id, op: "is", value: "s1" }] } };
const sorted: Partial<ViewConfig> = { sorts: [{ field_id: F.name.id, direction: "asc" }] };

const records = Array.from({ length: 12 }, (_, i) => rec(`r${i}`, { [F.status.id]: i < 3 ? "s1" : "s2" }));

/** A server that holds 12 records, 3 of them Todo, and counts what the draft's filter lets through. */
function server(asked: QueryRequest[] = []): Handler {
  return (call: RecordedCall) => {
    const body = call.body as QueryRequest;
    asked.push(body);
    const filter = body.transient?.filter;
    const all = filter ? records.filter((r) => filter.items.length > 0 && r.values[F.status.id] === "s1") : records;
    return { total: all.length, offset: body.offset ?? 0, records: all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 100)), groups: [], colors: {} };
  };
}

function draftOf(view: View, changes: Partial<ViewConfig>, over: Partial<ViewDraft> = {}) {
  writeDraft("usr1", view.id, { v: 1, base: fingerprint(view.config), started: 1, changes, ...over });
}

function setup(role: string, { view = viewWithConfig("viw1", "list", {}), noun = "", draft }: { view?: View; noun?: string; draft?: Partial<ViewConfig> | null } = {}) {
  const schema = projectSchema(role, [view]);
  schema.tables[0]!.record_noun = noun;
  if (draft) draftOf(view, draft);
  const asked: QueryRequest[] = [];
  const rendered = renderView(ListView, { schema, viewId: "viw1", routes: { "POST /api/views/viw1/query": server(asked) } as never });
  return { asked, ...rendered };
}

describe("what the bar says", () => {
  it("counts what the draft's filter shows against what the view shows, in the collection's own word", async () => {
    setup("viewer", { noun: "client", draft: filtered });
    expect(await screen.findByText("Showing 3 of 12 clients.")).toBeInTheDocument();
    expect(screen.getByText(/These changes are only for now\./)).toBeInTheDocument();
  });

  it("says records when the collection has no record name", async () => {
    setup("viewer", { draft: filtered });
    expect(await screen.findByText("Showing 3 of 12 records.")).toBeInTheDocument();
  });

  it("drops the count when the filter did not change", async () => {
    const { asked } = setup("viewer", { noun: "client", draft: sorted });
    expect(await screen.findByText(/These changes are only for now\./)).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    // No count was even asked for.
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.some((a) => a.limit === 1)).toBe(false);
  });

  it("asks the server for both numbers with one-record queries, the draft one carrying the filter", async () => {
    const { asked } = setup("viewer", { draft: filtered });
    await screen.findByText("Showing 3 of 12 records.");
    const ones = asked.filter((a) => a.limit === 1);
    expect(ones.some((a) => a.transient?.filter)).toBe(true);
    expect(ones.some((a) => !a.transient)).toBe(true);
  });

  it("is a live region that stays in the page without a draft", () => {
    setup("viewer");
    const region = screen.getAllByRole("status").find((r) => r.getAttribute("aria-live") === "polite" && r.textContent === "");
    expect(region).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("adds a line when the view changed on the server since the draft started, and keeps the draft", async () => {
    const view = viewWithConfig("viw1", "list", {});
    draftOf(view, sorted, { base: "an-older-version" });
    const schema = projectSchema("editor", [view]);
    renderView(ListView, { schema, viewId: "viw1", routes: { "POST /api/views/viw1/query": server() } as never });
    expect(await screen.findByText(/This view changed since you started\./)).toBeInTheDocument();
    expect(draftChanges()?.sorts).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByText(/This view changed since you started\./)).not.toBeInTheDocument();
  });

  it("does not say the view changed when it did not", async () => {
    setup("editor", { draft: sorted });
    await screen.findByText(/These changes are only for now\./);
    expect(screen.queryByText(/changed since you started/)).not.toBeInTheDocument();
  });
});

describe("which buttons each role has", () => {
  const shared = () => viewWithConfig("viw1", "list", {});
  it.each([
    ["viewer", shared(), ["Reset"]],
    ["commenter", shared(), ["Reset"]],
    ["editor", shared(), ["Reset", "Update view", "Save as view"]],
    ["creator", shared(), ["Reset", "Update view", "Save as view"]],
    ["owner", shared(), ["Reset", "Update view", "Save as view"]],
    // Locked: only a creator changes it, but an editor can still make a view of their own from it.
    ["editor", viewWithConfig("viw1", "list", {}, { locked: true }), ["Reset", "Save as view"]],
    ["creator", viewWithConfig("viw1", "list", {}, { locked: true }), ["Reset", "Update view", "Save as view"]],
    // The default view: its filter can only become a new view.
    ["editor", viewWithConfig("viw1", "list", {}, { is_default: true }), ["Reset", "Save as view"]],
  ] as [string, View, string[]][])("%s on %s", async (role, view, expected) => {
    setup(role, { view, draft: sorted });
    await screen.findByText(/These changes are only for now\./);
    const names = ["Reset", "Update view", "Save as view"].filter((n) => screen.queryByRole("button", { name: n }));
    expect(names).toEqual(expected);
  });

  it("on the default view, a layout change gives Update view back", async () => {
    setup("editor", { view: viewWithConfig("viw1", "list", {}, { is_default: true }), draft: { field_widths: { [F.name.id]: 300 } } });
    expect(await screen.findByRole("button", { name: "Update view" })).toBeInTheDocument();
  });

  it("Reset drops the draft", async () => {
    setup("viewer", { draft: sorted });
    await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(draftChanges()).toBeUndefined();
    expect(screen.queryByText(/These changes are only for now\./)).not.toBeInTheDocument();
  });

  it("Update view saves the draft to the view", async () => {
    const view = viewWithConfig("viw1", "list", {});
    const { api } = setup("editor", { view, draft: sorted });
    api.set("PATCH /api/views/viw1", (c: { body: unknown }) => ({ ...view, config: (c.body as { config: ViewConfig }).config }));
    await userEvent.click(await screen.findByRole("button", { name: "Update view" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: ViewConfig }).config.sorts).toEqual(sorted.sorts);
    await waitFor(() => expect(draftChanges()).toBeUndefined());
  });
});

describe("Save as view", () => {
  it("opens a dialog with the name from the chips, Only me chosen, and Everyone for creators only", async () => {
    setup("editor", { draft: filtered });
    await userEvent.click(await screen.findByRole("button", { name: "Save as view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as view" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Todo");
    expect(within(dialog).getByRole("radio", { name: /Only me/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Everyone/ })).toBeDisabled();
    expect(within(dialog).getByText(/Creators can share a view with everyone/)).toBeInTheDocument();
  });

  it("makes a personal view, opens it and clears the draft", async () => {
    const created = viewWithConfig("viwNew", "list", {}, { name: "Todo", personal: true });
    const { api } = setup("editor", { draft: filtered });
    api.set("POST /api/tables/tbl1/views", created);
    await userEvent.click(await screen.findByRole("button", { name: "Save as view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as view" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
    const body = api.callsTo("POST /api/tables/tbl1/views")[0]!.body as { name: string; type: string; personal: boolean; config: ViewConfig };
    expect(body).toMatchObject({ name: "Todo", type: "list", personal: true });
    expect(body.config.filter).toEqual(filtered.filter);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viwNew"));
    expect(draftChanges()).toBeUndefined();
    expect(await screen.findByText("Saved as “Todo”")).toBeInTheDocument();
  });

  it("lets a creator share it with everyone, under a name of their own", async () => {
    const created = viewWithConfig("viwNew", "list", {}, { name: "Open deals" });
    const { api } = setup("creator", { draft: filtered });
    api.set("POST /api/tables/tbl1/views", created);
    await userEvent.click(await screen.findByRole("button", { name: "Save as view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as view" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Open deals");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Everyone/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/views")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/views")[0]!.body).toMatchObject({ name: "Open deals", personal: false });
  });

  it("keeps the dialog and the draft, and says why, when the server refuses", async () => {
    const { api } = setup("editor", { draft: filtered });
    api.set("POST /api/tables/tbl1/views", { status: 403, json: { error: { code: "forbidden", message: "too many views" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Save as view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as view" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("too many views");
    expect(draftChanges()?.filter).toEqual(filtered.filter);
  });

  it("will not save a view without a name", async () => {
    setup("editor", { draft: filtered });
    await userEvent.click(await screen.findByRole("button", { name: "Save as view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as view" });
    await userEvent.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    expect(within(dialog).getByRole("button", { name: "Save as view" })).toBeDisabled();
  });
});
