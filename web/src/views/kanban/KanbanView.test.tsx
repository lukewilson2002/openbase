import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { field } from "@/test/fields";
import { apiError } from "@/test/utils";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import { installBoardLayout, type BoardLayout } from "./boardLayout";
import KanbanView from "./KanbanView";

let layout: BoardLayout;
beforeEach(() => {
  layout = installBoardLayout();
});
afterEach(() => {
  layout.restore();
  vi.unstubAllGlobals();
});

/** Pick a card up with Space, press arrow keys, drop with Space (dnd-kit listens a tick after pick-up). */
async function keyboardDrag(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, keys: string[]) {
  const pause = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  card.focus();
  await user.keyboard(" ");
  await pause();
  for (const k of keys) {
    await user.keyboard(k);
    await pause();
  }
  await user.keyboard(" ");
}

const board = (patch: Record<string, unknown> = {}, over = {}) =>
  viewWithConfig("viw1", "kanban", { kanban: { stack_field_id: F.status.id, cover_field_id: null, hide_empty_stacks: false, stack_order: [], ...patch } }, over);

const records = [
  rec("r1", { [F.status.id]: "s1", [F.effort.id]: 5 }),
  rec("r2", { [F.status.id]: "s1" }),
  rec("r3", { [F.status.id]: "s2" }),
  rec("r4", {}),
];

function setup(role = "editor", view = board(), extraRoutes: Record<string, unknown> = {}, server: { records: typeof records } = { records }) {
  const asked: QueryRequest[] = [];
  return {
    asked,
    ...renderView(KanbanView, {
      schema: projectSchema(role, [view]),
      viewId: "viw1",
      routes: { "POST /api/views/viw1/query": queryHandler(server, asked), ...extraRoutes } as never,
    }),
  };
}

describe("KanbanView", () => {
  it("queries the view and stacks its records by the stack field", async () => {
    const { asked } = setup();
    expect(await screen.findByRole("listitem", { name: "Stack: Todo" })).toBeInTheDocument();
    const stackLabels = screen.getAllByRole("listitem").map((s) => s.getAttribute("aria-label"));
    expect(stackLabels).toEqual(["Stack: Uncategorized", "Stack: Todo", "Stack: Doing", "Stack: Done"]);
    expect(within(screen.getByRole("listitem", { name: "Stack: Todo" })).getAllByRole("button", { name: /^R\d$/ })).toHaveLength(2);
    expect(within(screen.getByRole("listitem", { name: "Stack: Uncategorized" })).getByRole("button", { name: "R4" })).toBeInTheDocument();
    // Cards show the visible fields (the stack field itself is left out).
    expect(within(screen.getByRole("button", { name: "R1" })).getByText("5.00")).toBeInTheDocument();
    expect(asked[0]).toMatchObject({ offset: 0, timezone: "UTC" });
    // Each stack counts its own cards; the board has no total under it.
    expect(within(screen.getByRole("listitem", { name: "Stack: Todo" })).getByText("2 items")).toBeInTheDocument();
    expect(screen.queryByText("4 items")).not.toBeInTheDocument();
  });

  it("shows the setup prompt when no stack field is chosen and saves the choice", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "kanban", {});
    const { api } = setup("editor", view, { "PATCH /api/views/viw1": (call: { body: { config: unknown } }) => ({ ...view, config: call.body.config }) });
    expect(await screen.findByText("Choose how to stack cards")).toBeInTheDocument();
    expect(api.callsTo("POST /api/views/viw1/query")).toHaveLength(0); // nothing to query yet
    // The likely field (the first single select) is chosen already.
    expect(screen.getByRole("combobox", { name: "Stack cards by" })).toHaveValue("f_status");
    await user.click(screen.getByRole("button", { name: "Make stacks" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    const saved = api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { kanban: { stack_field_id: string } } };
    expect(saved.config.kanban.stack_field_id).toBe("f_status");
  });

  it("names the stack field in the toolbar, tinted, and keeps the stack and cover choices behind it", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    const tool = screen.getAllByRole("button", { name: "Stacked by Status" })[0]!;
    expect(tool.className).toContain("bg-primary-soft");
    await user.click(tool);
    expect(await screen.findByRole("combobox", { name: "Stack cards by" })).toHaveValue("f_status");
    expect(screen.getByRole("combobox", { name: "Cover image" })).toBeInTheDocument();
  });

  describe("description", () => {
    const notes = field("long_text", { rich: false }, { id: "f_notes", name: "Notes" });
    const brief = field("long_text", { rich: true }, { id: "f_brief", name: "Brief" });
    const label = field("formula", { expression: "{Name}", result_type: "text" }, { id: "f_label", name: "Label" });
    const total = field("formula", { expression: "1", result_type: "number" }, { id: "f_total", name: "Total" });
    // The description is the view's, not the board's: it sits beside `kanban` in the config.
    const described = (id: string) => viewWithConfig("viw1", "kanban", { description_field_id: id, kanban: { stack_field_id: F.status.id, cover_field_id: null, hide_empty_stacks: false, stack_order: [] } });
    const long = "First line of the notes.\n\n   Second   paragraph with more words than fit on three lines of a narrow card.";

    function setupNotes(view: ReturnType<typeof board>, values: Record<string, unknown> = {}) {
      const schema = projectSchema("editor", [view]);
      schema.tables[0]!.fields = [...schema.tables[0]!.fields, notes, brief, label, total];
      const server = { records: [rec("r1", { [F.status.id]: "s1", [F.effort.id]: 5, [notes.id]: long, ...values }), rec("r2", { [F.status.id]: "s1", [notes.id]: "  " })] };
      return renderView(KanbanView, {
        schema,
        viewId: "viw1",
        routes: { "POST /api/views/viw1/query": queryHandler(server), "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) } as never,
      });
    }

    it("offers text fields but not the title, starts empty and saves the choice", async () => {
      const user = userEvent.setup();
      const { api } = setupNotes(board());
      await screen.findByRole("listitem", { name: "Stack: Todo" });
      await user.click(screen.getAllByRole("button", { name: "Stacked by Status" })[0]!);
      const select = await screen.findByRole("combobox", { name: "Description" });
      // Nothing is picked for the view, even though the table has exactly one plain long text.
      expect(select).toHaveValue("");
      const options = within(select).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(["No description", "Notes", "Brief", "Label"]);
      await user.selectOptions(select, "f_notes");
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
      const saved = api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { description_field_id: string; kanban: { stack_field_id: string } } };
      expect(saved.config.description_field_id).toBe("f_notes");
      expect(saved.config.kanban).toMatchObject({ stack_field_id: F.status.id });
    });

    it("draws the description under the title, clamped, and leaves its row out", async () => {
      setupNotes(described(notes.id));
      const card = await screen.findByRole("button", { name: "R1" });
      const text = card.querySelector("[data-card-description]")!;
      expect(text.textContent).toBe("First line of the notes. Second paragraph with more words than fit on three lines of a narrow card.");
      expect(text.className).toContain("line-clamp-3");
      expect(text.previousElementSibling?.tagName).toBe("H3");
      expect(within(card).queryByText("Notes")).not.toBeInTheDocument();
      expect(within(card).getByText("5.00")).toBeInTheDocument();
      // A blank description draws nothing at all.
      expect(screen.getByRole("button", { name: "R2" }).querySelector("[data-card-description]")).toBeNull();
    });

    it("shows rich text without its markup", async () => {
      setupNotes(described(brief.id), { [brief.id]: "## Plan\n\nBuy **milk** & [eggs](https://x.test)\n- one\n- two" });
      const card = await screen.findByRole("button", { name: "R1" });
      expect(card.querySelector("[data-card-description]")!.textContent).toBe("Plan Buy milk & eggs one two");
      expect(card.querySelector("[data-card-description] a, [data-card-description] strong")).toBeNull();
      // Notes is not the description here, so it stays a row.
      expect(within(card).getByText("Notes")).toBeInTheDocument();
    });

    it("ignores a description field that is no longer text", async () => {
      setupNotes(described(total.id), { [total.id]: 3 });
      const card = await screen.findByRole("button", { name: "R1" });
      expect(card.querySelector("[data-card-description]")).toBeNull();
      expect(within(card).getByText("Total")).toBeInTheDocument();
    });
  });

  it("hides empty stacks from the More menu", async () => {
    const user = userEvent.setup();
    const view = board();
    const { api } = setup("editor", view, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    expect(await screen.findByRole("listitem", { name: "Stack: Done" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^(More|Tools)/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Hide empty stacks" });
    expect(item).toHaveAttribute("aria-checked", "false");
    await user.click(item);
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { kanban: { hide_empty_stacks: boolean } } }).config.kanban.hide_empty_stacks).toBe(true);
  });

  it("adds a stack as a new choice of the select, for people who manage fields", async () => {
    const user = userEvent.setup();
    const { api } = setup("creator", board(), { "PATCH /api/fields/f_status": (c: { body: { options: { choices: { id: string; name: string; color: string }[] } } }) => ({ ...F.status, options: { choices: c.body.options.choices.map((ch, i) => ({ ...ch, id: ch.id || `s_new${i}` })) } }) });
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    await user.click(screen.getByRole("button", { name: "Add a stack" }));
    await user.type(screen.getByRole("textbox", { name: "Name of the new stack" }), "Blocked{Enter}");
    await waitFor(() => expect(api.callsTo("PATCH /api/fields/f_status")).toHaveLength(1));
    const choices = (api.callsTo("PATCH /api/fields/f_status")[0]!.body as { options: { choices: { name: string }[] } }).options.choices;
    expect(choices.at(-1)).toMatchObject({ name: "Blocked" });
  });

  it("offers no new stacks to editors, who cannot add choices", async () => {
    setup("editor");
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    expect(screen.queryByRole("button", { name: "Add a stack" })).not.toBeInTheDocument();
  });

  it("only offers fields that can stack, and tells viewers to ask an editor", async () => {
    setup("viewer", viewWithConfig("viw1", "kanban", {}));
    expect(await screen.findByText(/Ask someone who can edit this view/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Stack cards by" })).not.toBeInTheDocument();
  });

  it("dragging a card to another stack writes the stack field, then its place, optimistically", async () => {
    const user = userEvent.setup();
    const moved = rec("r1", { [F.status.id]: "s2", [F.effort.id]: 5 });
    // A server that keeps what it is told, so the refetch after the write agrees with the drop.
    const server = { records: [...records] };
    const { api } = setup(
      "editor",
      board(),
      {
        "PATCH /api/tables/tbl1/records": () => {
          server.records = server.records.map((r) => (r.id === "r1" ? moved : r));
          return { records: [moved] };
        },
        "POST /api/tables/tbl1/records/move": { records: [moved] },
      },
      server,
    );
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    layout.overlayAt(1); // R1 is the first card of the second stack (Uncategorized comes first)
    await keyboardDrag(user, screen.getByRole("button", { name: "R1" }), ["{ArrowRight}"]);
    // The card is in its new stack at once...
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Stack: Doing" })).getByRole("button", { name: "R1" })).toBeInTheDocument());
    // ...and the server is told the new status (typecast, view form -> wire form) and the new place.
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "r1", values: { f_status: "s2" } }] });
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toMatchObject({ ids: ["r1"] });
  });

  it("puts the card back when the server rejects the drop", async () => {
    const user = userEvent.setup();
    const { api } = setup("editor", board(), { "PATCH /api/tables/tbl1/records": apiError(400, "bad_request", "Status is read-only") });
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    layout.overlayAt(1);
    await keyboardDrag(user, screen.getByRole("button", { name: "R1" }), ["{ArrowRight}"]);
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Stack: Todo" })).getByRole("button", { name: "R1" })).toBeInTheDocument());
    expect(within(screen.getByRole("listitem", { name: "Stack: Doing" })).queryByRole("button", { name: "R1" })).not.toBeInTheDocument();
    expect(await screen.findByText(/Status is read-only/)).toBeInTheDocument();
    // The move was never attempted: the field write came first and failed.
    expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(0);
  });

  it("with sorts, a drop between stacks writes only the field (no manual order)", async () => {
    const user = userEvent.setup();
    const sorted = board({}, {});
    sorted.config.sorts = [{ field_id: F.name.id, direction: "asc" }];
    const { api } = setup("editor", sorted, { "PATCH /api/tables/tbl1/records": { records: [rec("r1", { [F.status.id]: "s2" })] } });
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    layout.overlayAt(1);
    await keyboardDrag(user, screen.getByRole("button", { name: "R1" }), ["{ArrowRight}"]);
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(0);
  });

  it("adds a card prefilled with the stack value and opens it", async () => {
    const user = userEvent.setup();
    const created = rec("r9", { [F.status.id]: "s2" });
    const { api } = setup("editor", board(), {
      "POST /api/tables/tbl1/records": { records: [created] },
      "GET /api/tables/tbl1/records/r9": created,
    });
    await user.click(await screen.findByRole("button", { name: "Add card to Doing" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toMatchObject({ typecast: true, records: [{ values: { f_status: "s2" } }] });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?record=r9"));
  });

  it("adds to Uncategorized without a value", async () => {
    const user = userEvent.setup();
    const created = rec("r9", {});
    const { api } = setup("editor", board(), { "POST /api/tables/tbl1/records": { records: [created] }, "GET /api/tables/tbl1/records/r9": created });
    await user.click(await screen.findByRole("button", { name: "Add card to Uncategorized" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toMatchObject({ records: [{ values: {} }] });
  });

  it("opens the record from a card with ?record= in the URL", async () => {
    const user = userEvent.setup();
    setup("viewer", board(), { "GET /api/tables/tbl1/records/r3": records[2]! });
    await user.click(await screen.findByRole("button", { name: "R3" }));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r3");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("is read-only for viewers: no add buttons, cards are not draggable", async () => {
    setup("viewer");
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    expect(screen.queryByRole("button", { name: /^Add card to/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "R1" })).toHaveAttribute("aria-roledescription", "card");
  });

  it("hides empty stacks and follows stack_order", async () => {
    setup("editor", board({ hide_empty_stacks: true, stack_order: ["s2", "s1"] }));
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    expect(screen.getAllByRole("listitem").map((s) => s.getAttribute("aria-label"))).toEqual(["Stack: Doing", "Stack: Todo", "Stack: Uncategorized"]);
  });

  it("notes when only the first records of a very large view are loaded", async () => {
    const many = Array.from({ length: 5_300 }, (_, i) => rec(`m${i}`, { [F.status.id]: "s1" }));
    const asked: QueryRequest[] = [];
    renderView(KanbanView, { schema: projectSchema("editor", [board()]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: many }, asked) } });
    expect(await screen.findByText(/Showing the first 5,000 of 5,300 cards/)).toBeInTheDocument();
    expect(asked.map((a) => [a.offset, a.limit])).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
      [3000, 1000],
      [4000, 1000],
    ]);
  });

  it("refetches when a live event invalidates the table's records and shows the change", async () => {
    const server = { records: [...records] };
    const asked: QueryRequest[] = [];
    const { client } = renderView(KanbanView, { schema: projectSchema("editor", [board()]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler(server, asked) } });
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    expect(screen.queryByRole("button", { name: "R5" })).not.toBeInTheDocument();
    server.records.push(rec("r5", { [F.status.id]: "s3" }));
    // What a records_changed event does to the cache (see hooks/useBaseEvents).
    await client.invalidateQueries({ queryKey: ["records", "tbl1"] });
    expect(await within(screen.getByRole("listitem", { name: "Stack: Done" })).findByRole("button", { name: "R5" })).toBeInTheDocument();
    expect(asked.length).toBeGreaterThan(1);
  });

  it("filters through the shared toolbar's search (sent with the query)", async () => {
    const user = userEvent.setup();
    const { asked } = setup();
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    await user.click(screen.getByRole("button", { name: /Search records/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search records" }), "docs");
    await waitFor(() => expect(asked.some((a) => a.search === "docs")).toBe(true));
  });
});
