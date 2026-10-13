import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import KanbanView from "./KanbanView";

afterEach(() => vi.unstubAllGlobals());

const board = (patch: Record<string, unknown> = {}, over = {}) =>
  viewWithConfig("viw1", "kanban", { kanban: { stack_field_id: F.status.id, cover_field_id: null, hide_empty_stacks: false, stack_order: [], ...patch } }, over);

const records = [
  rec("r1", { [F.status.id]: "s1", [F.effort.id]: 5 }),
  rec("r2", { [F.status.id]: "s1" }),
  rec("r3", { [F.status.id]: "s2" }),
  rec("r4", {}),
];

function setup(role = "editor", view = board(), extraRoutes: Record<string, unknown> = {}) {
  const asked: QueryRequest[] = [];
  const server = { records };
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
    expect(screen.getByText("4 cards")).toBeInTheDocument();
  });

  it("shows the setup prompt when no stack field is chosen and saves the choice", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "kanban", {});
    const { api } = setup("editor", view, { "PATCH /api/views/viw1": (call: { body: { config: unknown } }) => ({ ...view, config: call.body.config }) });
    expect(await screen.findByText("Choose how to stack cards")).toBeInTheDocument();
    expect(api.callsTo("POST /api/views/viw1/query")).toHaveLength(0); // nothing to query yet
    await user.selectOptions(screen.getByRole("combobox", { name: "Stack cards by" }), "Status");
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    const saved = api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { kanban: { stack_field_id: string } } };
    expect(saved.config.kanban.stack_field_id).toBe("f_status");
  });

  it("only offers fields that can stack, and tells viewers to ask an editor", async () => {
    setup("viewer", viewWithConfig("viw1", "kanban", {}));
    expect(await screen.findByText(/Ask someone who can edit this view/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Stack cards by" })).not.toBeInTheDocument();
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

  it("filters through the shared toolbar's search (sent with the query)", async () => {
    const user = userEvent.setup();
    const { asked } = setup();
    await screen.findByRole("listitem", { name: "Stack: Todo" });
    await user.click(screen.getByRole("button", { name: /Search records/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search records" }), "docs");
    await waitFor(() => expect(asked.some((a) => a.search === "docs")).toBe(true));
  });
});
