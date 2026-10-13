import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupHeader } from "@/api/types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import ListView from "./ListView";

afterEach(() => vi.unstubAllGlobals());

const header = (depth: number, field_id: string, key: string, label: string, start: number, count: number, value: unknown): GroupHeader => ({ depth, field_id, key, label, value: value as GroupHeader["value"], start, count });

const records = [rec("r1", { [F.status.id]: "s1", [F.owner.id]: ["usr1"] }), rec("r2", { [F.status.id]: "s1", [F.owner.id]: ["usr2"] }), rec("r3", { [F.status.id]: "s2" })];
const groups = [
  header(0, F.status.id, "s1", "Todo", 0, 2, "s1"),
  header(1, F.owner.id, "usr1", "Ada Lovelace", 0, 1, ["usr1"]),
  header(1, F.owner.id, "usr2", "Grace Hopper", 1, 1, ["usr2"]),
  header(0, F.status.id, "s2", "Doing", 2, 1, "s2"),
];

const outline = viewWithConfig("viw1", "list", { groups: [{ field_id: F.status.id, direction: "asc" }, { field_id: F.owner.id, direction: "asc" }] });

function setup(role = "editor", view = outline, server = { records, groups }, routes: Record<string, unknown> = {}) {
  return renderView(ListView, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler(server), ...routes } as never });
}

describe("ListView", () => {
  it("renders the view's groups as a nested outline with counts", async () => {
    setup();
    await screen.findByRole("tree", { name: "Grouped records" });
    const items = screen.getAllByRole("treeitem").map((i) => [i.getAttribute("aria-level"), i.textContent]);
    expect(items).toEqual([
      ["1", "Todo2"],
      ["2", "Ada Lovelace1"],
      ["2", "Grace Hopper1"],
      ["1", "Doing1"],
    ]);
    expect(screen.getByRole("button", { name: "R1" })).toBeInTheDocument();
    expect(screen.getByText("3 records")).toBeInTheDocument();
  });

  it("collapses and expands everything", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("tree");
    await user.click(screen.getByRole("button", { name: /Collapse all/ }));
    expect(screen.queryByRole("button", { name: "R1" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(2); // only the top level is left visible
    await user.click(screen.getByRole("button", { name: /Expand all/ }));
    expect(screen.getByRole("button", { name: "R1" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ob-list-collapsed:viw1") ?? "[]")).toEqual([]);
  });

  it("collapses one group and remembers it", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "Collapse Todo" }));
    expect(screen.queryByRole("button", { name: "R1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "R3" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ob-list-collapsed:viw1")!)).toEqual([`${F.status.id}:s1`]);
  });

  it("adds a record inside a nested group with every level's value, then opens it", async () => {
    const user = userEvent.setup();
    const created = rec("r9", {});
    const { api } = setup("editor", outline, { records, groups }, { "POST /api/tables/tbl1/records": { records: [created] }, "GET /api/tables/tbl1/records/r9": created });
    await user.click(await screen.findByRole("button", { name: "Add record to Grace Hopper" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records")[0]!.body).toMatchObject({ typecast: true, records: [{ values: { f_status: "s1", f_owner: ["usr2"] } }] });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?record=r9"));
  });

  it("shows a flat list with an add button when the view has no groups", async () => {
    const user = userEvent.setup();
    const flat = viewWithConfig("viw1", "list", {});
    const created = rec("r9", {});
    const { api } = setup("editor", flat, { records, groups: [] }, { "POST /api/tables/tbl1/records": { records: [created] }, "GET /api/tables/tbl1/records/r9": created });
    expect(await screen.findByRole("list", { name: "Records" })).toBeInTheDocument();
    expect(screen.getByText(/Use Group in the toolbar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse all/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
  });

  it("is read-only for commenters: no add buttons, rows still open the record", async () => {
    const user = userEvent.setup();
    setup("commenter", outline, { records, groups }, { "GET /api/tables/tbl1/records/r1": records[0]! });
    await screen.findByRole("tree");
    expect(screen.queryByRole("button", { name: /^Add record/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "R1" }));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r1");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "R1" })).toBeInTheDocument();
    // Previous/next follow the list order.
    expect(within(dialog).getByRole("button", { name: /Next record/ })).toBeEnabled();
  });
});
