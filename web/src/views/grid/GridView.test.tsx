/**
 * The grid view's wiring around the canvas. Glide draws to a canvas jsdom has none of, so the canvas
 * is replaced by a stand-in that keeps the props the view hands it; the tests call those props the way
 * the canvas would (Delete pressed, rows ticked, text pasted) and look at what the view does.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MutationObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupHeader } from "@/api/types";
import { field } from "@/test/fields";
import { F, draftChanges, openViewOptions, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import type { GridAdapterProps, GridSelectionInfo } from "./adapter";

const canvas = vi.hoisted(() => ({ props: null as unknown, clear: vi.fn() }));
vi.mock("./glide/GlideGrid", async () => {
  const React = await import("react");
  return {
    gridHeaderHeight: (wrap?: boolean) => (wrap ? 56 : 44),
    GlideGrid: React.forwardRef(function FakeGrid(props: unknown, ref: React.ForwardedRef<unknown>) {
      canvas.props = props;
      React.useImperativeHandle(ref, () => ({
        focus: () => {},
        scrollToRow: () => {},
        selectCell: () => {},
        clearSelection: () => canvas.clear(),
        cellBounds: () => ({ x: 10, y: 10, width: 100, height: 30 }),
        invalidate: () => {},
      }));
      return <div data-testid="canvas" />;
    }),
  };
});
import GridView from "./GridView";

const grid = () => canvas.props as GridAdapterProps;
const selection = (over: Partial<GridSelectionInfo>): GridSelectionInfo => ({ cell: null, ranges: [], rows: [], columns: [], ...over });
const records = Array.from({ length: 12 }, (_, i) => rec(`r${i + 1}`, { [F.effort.id]: i }));

function setup(over: { recs?: typeof records; groups?: GroupHeader[]; routes?: Record<string, unknown>; route?: string } = {}) {
  const view = viewWithConfig("viw1", "grid", {});
  const asked: unknown[] = [];
  const out = renderView(GridView, {
    schema: projectSchema("editor", [view]),
    viewId: "viw1",
    route: over.route,
    routes: {
      "POST /api/views/viw1/query": queryHandler({ records: over.recs ?? records, groups: over.groups }, asked as never),
      "DELETE /api/tables/tbl1/records": { status: 204 },
      "POST /api/tables/tbl1/records/restore": { records: [] },
      "POST /api/tables/tbl1/records/duplicate": { status: 201, json: { records: [rec("c1", {})] } },
      "PATCH /api/tables/tbl1/records": { records: [] },
      ...over.routes,
    } as never,
  });
  return { ...out, asked };
}

async function loaded() {
  await waitFor(() => expect(grid().getCell(0, 0).kind).toBe("cell"));
}

beforeEach(() => {
  canvas.clear.mockReset();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("GridView: record pages", () => {
  it("opens a row as its page, with the view in the address", async () => {
    setup();
    await loaded();
    act(() => grid().onExpand(1));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/base/app1/tbl1/viw1/r/r2"));
    // The page returns to the collection it was opened from, not to some earlier step.
    expect(JSON.parse(screen.getByTestId("trail").textContent!)).toEqual({ from: "/base/app1/tbl1/viw1", steps: 1 });
  });
});

describe("GridView: Delete on selected rows", () => {
  it("deletes the records after a count confirmation, not their cells", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    act(() => grid().onClear(selection({ rows: [0, 1, 2] })));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 3 records?")).toBeInTheDocument();
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete 3 records" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r1", "r2", "r3"] });
    // The rows that were selected are not any more: they would now name other records.
    await waitFor(() => expect(canvas.clear).toHaveBeenCalled());
  });

  it("deletes a single record at once and offers Undo in a toast", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    act(() => grid().onClear(selection({ rows: [4] })));
    await screen.findByText("Record deleted");
    expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r5"] });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/restore")[0]!.body).toEqual({ ids: ["r5"] });
  });

  it("asks before it empties a big block of cells, and empties them on yes", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    act(() => grid().onClear(selection({ ranges: [{ x: 0, y: 0, width: 8, height: 12 }] })));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/^Clear \d+ cells\?$/)).toBeInTheDocument();
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Clear cells" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
  });

  it("clears a few cells without asking", async () => {
    const { api } = setup();
    await loaded();
    act(() => grid().onClear(selection({ ranges: [{ x: 0, y: 0, width: 1, height: 2 }] })));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("GridView: selection bar", () => {
  it("shows the count with Duplicate, Delete and a way to let go", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    expect(screen.queryByRole("toolbar", { name: "Selected records" })).not.toBeInTheDocument();
    act(() => grid().onSelectionChange(selection({ rows: [0, 1] })));
    const bar = await screen.findByRole("toolbar", { name: "Selected records" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")[0]!.body).toEqual({ ids: ["r1", "r2"] });
    await screen.findByText("Record duplicated");
    await user.click(within(bar).getByRole("button", { name: /^Clear selection/ }));
    expect(canvas.clear).toHaveBeenCalled();
  });

  it("counts rows that are not loaded yet, and loads them for the operation", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 450 }, (_, i) => rec(`m${i}`, {}));
    const { api } = setup({ recs: many });
    await waitFor(() => expect(grid().getCell(0, 0).kind).toBe("cell"));
    expect(grid().getCell(0, 449).kind).toBe("loading");
    act(() => grid().onSelectionChange(selection({ rows: Array.from({ length: 450 }, (_, i) => i).concat([450]) })));
    const bar = await screen.findByRole("toolbar", { name: "Selected records" });
    // 450 records; row 450 is the summary row, which is not a record.
    expect(within(bar).getByText("450 selected")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 450 records?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete 450 records" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body as { ids: string[] }).ids).toHaveLength(450);
  });
});

describe("GridView: empty states (COL-9)", () => {
  it("says there is nothing yet under the header, with New record", async () => {
    const { api } = setup({ recs: [], routes: { "POST /api/tables/tbl1/records": { status: 201, json: { records: [rec("n1", {})] } }, "GET /api/tables/tbl1/records/n1": rec("n1", {}) } });
    expect(await screen.findByText("No records yet")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "New record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
  });

  it("says the filter is why when it matches nothing, and Reset shows every record again as a draft", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", { filter: { conjunction: "and", items: [{ field_id: F.status.id, op: "is", value: "s3" }] } });
    const server = { records: [] as typeof records, groups: undefined };
    renderView(GridView, { schema: projectSchema("viewer", [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler(server) } as never });
    expect(await screen.findByText("No records match these filters")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New record" })).not.toBeInTheDocument();
    server.records = records;
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await loaded();
    expect(screen.queryByText("No records match these filters")).not.toBeInTheDocument();
    expect(draftChanges()?.filter).toBeNull();
  });
});

describe("GridView: selection on a phone", () => {
  it("is the count and Actions, with Duplicate and Delete in a sheet", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", {});
    const { api } = renderView(GridView, { schema: projectSchema("editor", [view]), viewId: "viw1", phone: true, routes: { "POST /api/views/viw1/query": queryHandler({ records }), "POST /api/tables/tbl1/records/duplicate": { status: 201, json: { records: [rec("c1", {})] } } } as never });
    await loaded();
    act(() => grid().onSelectionChange(selection({ rows: [0, 1] })));
    const bar = await screen.findByRole("toolbar", { name: "Selected records" });
    expect(within(bar).queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Actions" }));
    const sheet = within(await screen.findByRole("dialog", { name: "2 selected" }));
    await user.click(sheet.getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")).toHaveLength(1));
  });

  it("shows a row's menu as a sheet", async () => {
    const view = viewWithConfig("viw1", "grid", {});
    renderView(GridView, { schema: projectSchema("editor", [view]), viewId: "viw1", phone: true, routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never });
    await loaded();
    act(() => grid().onCellContextMenu({ col: 0, row: 1 }, { x: 5, y: 5, width: 1, height: 1 }));
    const sheet = within(await screen.findByRole("dialog", { name: "Record" }));
    expect(sheet.getByRole("button", { name: "Expand record" })).toBeInTheDocument();
    expect(sheet.getByRole("button", { name: "Delete record" })).toBeInTheDocument();
  });
});

describe("GridView: record menu", () => {
  it("says why Insert is off while the view is searched", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", { sorts: [{ field_id: F.name.id, direction: "asc" }] });
    renderView(GridView, { schema: projectSchema("editor", [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never });
    await loaded();
    act(() => grid().onCellContextMenu({ col: 0, row: 0 }, { x: 5, y: 5, width: 1, height: 1 }));
    const menu = await screen.findByRole("menu", { name: "Record menu" });
    expect(within(menu).getByRole("menuitem", { name: "Insert record above" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText(/cannot be inserted at a place while the view is sorted/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("counts a selection that includes unloaded rows in its Delete item", async () => {
    setup();
    await loaded();
    act(() => grid().onSelectionChange(selection({ rows: [0, 1, 2] })));
    act(() => grid().onCellContextMenu({ col: 0, row: 1 }, { x: 5, y: 5, width: 1, height: 1 }));
    expect(await screen.findByRole("menuitem", { name: "Delete 3 records" })).toBeInTheDocument();
  });

  it("opens no menu from the Add field header", async () => {
    setup();
    await loaded();
    act(() => grid().onHeaderMenu(grid().columns.length, { x: 5, y: 5, width: 1, height: 1 }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    act(() => grid().onHeaderMenu(1, { x: 5, y: 5, width: 1, height: 1 }));
    expect(await screen.findByRole("menu", { name: /Column menu for/ })).toBeInTheDocument();
  });
});

describe("GridView: paste", () => {
  it("pastes the cells that fit and says what it skipped", async () => {
    const { api } = setup();
    await loaded();
    const cover = grid().columns.findIndex((c) => c.id === F.cover.id);
    const effort = grid().columns.findIndex((c) => c.id === F.effort.id);
    expect(cover).toBeGreaterThan(0);
    const line = grid().columns.map((c) => (c.id === F.name.id ? "Pasted" : c.id === F.cover.id ? "photo.png" : c.id === F.effort.id ? "oops" : ""));
    act(() => grid().onPaste({ col: 0, row: 0 }, [line.slice(0, Math.max(cover, effort) + 1)]));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values).toEqual({ [F.name.id]: "Pasted" });
    const toast = await screen.findByText("Pasted into 1 cell");
    expect(toast.parentElement).toHaveTextContent("Skipped 2 cells");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("does not link a name that two records share", async () => {
    const { api } = setup({
      routes: { "GET /api/tables/tbl1/records/lookup": { records: [{ id: "recA", name: "Acme" }, { id: "recB", name: "Acme" }] } },
    });
    await loaded();
    const col = grid().columns.findIndex((c) => c.id === F.deps.id);
    act(() => grid().onPaste({ col, row: 0 }, [["Acme"]]));
    await screen.findByText("Nothing was pasted");
    expect(screen.getByText(/matches more than one record/)).toBeInTheDocument();
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
  });
});

describe("GridView: groups", () => {
  const groups: GroupHeader[] = [
    { depth: 0, field_id: F.status.id, key: "s1", value: "s1", label: "Todo", count: 2, start: 0 },
    { depth: 0, field_id: F.status.id, key: "s2", value: "s2", label: "Doing", count: 2, start: 2 },
  ];
  const four = records.slice(0, 4);

  it("folds a group from the keyboard and remembers it", async () => {
    const { unmount } = setup({ recs: four, groups });
    // Two headers, four records, and the add row that closes each group.
    await waitFor(() => expect(grid().rowCount).toBe(8));
    expect(grid().getCell(0, 0).kind).toBe("group");
    let handled = false;
    act(() => {
      handled = grid().onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, cell: { col: 0, row: 0 } });
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(grid().rowCount).toBe(5));
    unmount();
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(5));
  });

  it("folds and unfolds every group with the Fold all groups switch in View options", async () => {
    const user = userEvent.setup();
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    await openViewOptions(user);
    await user.click(screen.getByRole("switch", { name: "Fold all groups" }));
    await waitFor(() => expect(grid().rowCount).toBe(2));
    expect(screen.getByRole("switch", { name: "Fold all groups" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("switch", { name: "Fold all groups" }));
    await waitFor(() => expect(grid().rowCount).toBe(8));
  });

  it("has no Fold all groups switch while nothing is grouped", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await openViewOptions(user);
    expect(screen.queryByRole("switch", { name: "Fold all groups" })).not.toBeInTheDocument();
  });

  it("opens a summary cell's menu from the keyboard", async () => {
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    act(() => {
      grid().onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, cell: { col: 1, row: 8 } });
    });
    expect(await screen.findByRole("menu", { name: "Summary options" })).toBeInTheDocument();
  });
});

describe("GridView: add rows and new rows", () => {
  const groups: GroupHeader[] = [
    { depth: 0, field_id: F.status.id, key: "s1", value: "s1", label: "Todo", count: 2, start: 0 },
    { depth: 0, field_id: F.status.id, key: "s2", value: "s2", label: "Doing", count: 2, start: 2 },
  ];
  const four = records.slice(0, 4);
  const made = rec("new1", {});
  const routes = {
    "POST /api/tables/tbl1/records": { status: 201, json: { records: [made] } },
    "GET /api/tables/tbl1/records/new1": made,
    "POST /api/tables/tbl1/records/new1/discard": { discarded: true },
  };
  /** The focus goes to somewhere else on the page. */
  const clickOff = () => act(() => void screen.getByTestId("canvas").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })));

  it("adds from the header's New button into the group of the selected cell, else the group in view, else the end", async () => {
    const user = userEvent.setup();
    const { api } = setup({ recs: four, groups, routes });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    const sent = () => api.callsTo("POST /api/tables/tbl1/records").map((c) => (c.body as { records: { values: unknown }[] }).records[0]!.values);
    act(() => grid().onSelectionChange(selection({ cell: { col: 1, row: 6 }, ranges: [{ x: 1, y: 6, width: 1, height: 1 }] })));
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ [F.status.id]: "s2" });
    // Nothing selected: the rows at the top of the screen are in the second group.
    act(() => grid().onSelectionChange(selection({})));
    act(() => grid().onVisibleRowsChange(5, 7));
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({ [F.status.id]: "s2" });
    act(() => grid().onVisibleRowsChange(0, 3));
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]).toEqual({ [F.status.id]: "s1" });
  });

  it("closes each group with a row that adds into that group", async () => {
    const { api } = setup({ recs: four, groups, routes });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    expect(grid().getCell(0, 3).kind).toBe("add");
    expect(grid().getCell(1, 3).kind).toBe("blank");
    expect(grid().rowNumber(3)).toBeNull();
    act(() => grid().onAddRow(7));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records[0]!.values).toEqual({ [F.status.id]: "s2" });
  });

  it("adds from the keyboard on an add row, and never pastes into one", async () => {
    const { api } = setup({ recs: four, groups, routes: { ...routes, "PATCH /api/tables/tbl1/records": { records: [] } } });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    act(() => void grid().onPaste({ col: 0, row: 3 }, [["x"]]));
    let handled = false;
    act(() => {
      handled = grid().onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, cell: { col: 0, row: 3 } });
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: unknown }[] }).records).toEqual([{ values: { [F.status.id]: "s1" } }]);
  });

  it("shows no add rows to someone who cannot edit", async () => {
    const view = viewWithConfig("viw1", "grid", {});
    renderView(GridView, { schema: projectSchema("viewer", [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: four, groups }) } as never });
    await waitFor(() => expect(grid().rowCount).toBe(6));
    expect([0, 1, 2, 3, 4, 5].some((r) => grid().getCell(0, r).kind === "add")).toBe(false);
  });

  it("takes an untouched new row back silently when the focus leaves, and forgets its Undo step", async () => {
    const { api } = setup({ recs: four, groups, routes });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    act(() => grid().onAddRow(3));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Undo: Add record/ })).toBeEnabled());
    // Wait for the page that has the new row to be known, then click off.
    clickOff();
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/new1/discard")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Undo/ })).toBeDisabled());
    expect(screen.queryByText(/deleted/i)).toBeNull();
    expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("keeps a new row something was written into", async () => {
    const { api } = setup({ recs: four, groups, routes: { ...routes, "GET /api/tables/tbl1/records/new1": rec("new1", { [F.name.id]: "Hello" }) } });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    act(() => grid().onAddRow(3));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    clickOff();
    await waitFor(() => expect(api.callsTo("GET /api/tables/tbl1/records/new1")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/records/new1/discard")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Undo: Add record/ })).toBeEnabled();
  });

  it("keeps a new row when the server says it is no longer untouched", async () => {
    const { api } = setup({ recs: four, groups, routes: { ...routes, "POST /api/tables/tbl1/records/new1/discard": { discarded: false } } });
    await waitFor(() => expect(grid().rowCount).toBe(8));
    act(() => grid().onAddRow(3));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    clickOff();
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/new1/discard")).toHaveLength(1));
    expect(screen.getByRole("button", { name: /^Undo: Add record/ })).toBeEnabled();
  });
});

describe("GridView: undo", () => {
  it("has Undo and Redo buttons that follow the history", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    const undo = screen.getByRole("button", { name: /^Undo/ });
    expect(undo).toBeDisabled();
    act(() => grid().onClear(selection({ rows: [0] })));
    await screen.findByText("Record deleted");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Undo: Delete record/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /^Undo: Delete record/ }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/restore")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Redo: Delete record/ })).toBeEnabled());
  });

  it("puts a dragged row back with Undo", async () => {
    const user = userEvent.setup();
    const { api } = setup({ routes: { "POST /api/tables/tbl1/records/move": { records: [rec("r2", {})] } } });
    await loaded();
    act(() => grid().onRowMove(1, 4));
    await screen.findByText("Record moved");
    expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toEqual({ ids: ["r2"], before_id: null, after_id: "r5" });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(2));
    expect(api.callsTo("POST /api/tables/tbl1/records/move")[1]!.body).toEqual({ ids: ["r2"], before_id: null, after_id: "r1" });
  });
});

describe("GridView: column menu", () => {
  it("moves a column left or right, never before the primary field, as a draft", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", { hidden_fields: [F.start.id] });
    const { api } = renderView(GridView, {
      schema: projectSchema("editor", [view]),
      viewId: "viw1",
      routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never,
    });
    await loaded();
    const ids = grid().columns.map((c) => c.id);
    expect(ids).toEqual([F.name.id, F.status.id, F.end.id, F.owner.id, F.cover.id, F.deps.id, F.effort.id]);
    act(() => grid().onHeaderMenu(1, { x: 5, y: 5, width: 1, height: 1 }));
    const first = await screen.findByRole("menu", { name: /Column menu for Status/ });
    expect(within(first).getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    act(() => grid().onHeaderMenu(2, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: "Move left" }));
    await waitFor(() => expect(draftChanges()?.field_order).toBeDefined());
    // The hidden Start field keeps its slot between Status and End.
    expect(draftChanges()!.field_order!.slice(0, 4)).toEqual([F.name.id, F.end.id, F.start.id, F.status.id]);
    // The new order is this person's until they update the view.
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);
  });
});

describe("GridView: title and page from a column's menu", () => {
  const notes = field("rich_text", {}, { id: "f_notes", name: "Notes" });
  const withNotes = (role: string, body: string | null = null) => {
    const schema = projectSchema(role, [viewWithConfig("viw1", "grid", {})]);
    schema.tables[0] = { ...schema.tables[0]!, fields: [...schema.tables[0]!.fields, notes], body_field_id: body };
    return schema;
  };
  const open = async (id: string) => {
    await loaded();
    act(() => grid().onHeaderMenu(grid().columns.findIndex((c) => c.id === id), { x: 5, y: 5, width: 1, height: 1 }));
    return screen.findByRole("menu", { name: /Column menu for/ });
  };

  it("makes a property the title with Use as title, which calls primary-field", async () => {
    const { api } = renderView(GridView, {
      schema: withNotes("creator"),
      viewId: "viw1",
      routes: { "POST /api/views/viw1/query": queryHandler({ records }), "POST /api/tables/tbl1/primary-field": { id: "tbl1" } } as never,
    });
    const menu = await open(F.status.id);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Use as title" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/primary-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/primary-field")[0]!.body).toEqual({ field_id: F.status.id });
    expect(await screen.findByText("“Status” is now the title")).toBeInTheDocument();
  });

  it("disables Use as title with the reason for a type that cannot be the title, and for the title itself", async () => {
    renderView(GridView, { schema: withNotes("creator"), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never });
    const menu = await open(F.cover.id);
    const item = within(menu).getByRole("menuitem", { name: /Use as title/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Attachment properties can't be the title");
    await userEvent.keyboard("{Escape}");
    const own = await open(F.name.id);
    expect(within(own).getByRole("menuitem", { name: /Use as title/ })).toHaveTextContent("It is the title already");
  });

  it("offers Use as page on rich text properties only, and sends body-field", async () => {
    const { api } = renderView(GridView, {
      schema: withNotes("creator"),
      viewId: "viw1",
      routes: { "POST /api/views/viw1/query": queryHandler({ records }), "POST /api/tables/tbl1/body-field": { id: "tbl1" } } as never,
    });
    const plain = await open(F.status.id);
    expect(within(plain).queryByRole("menuitem", { name: /Use as page/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const rich = await open(notes.id);
    await userEvent.click(within(rich).getByRole("menuitem", { name: "Use as page" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/body-field")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl1/body-field")[0]!.body).toEqual({ field_id: notes.id });
    expect(await screen.findByText("“Notes” is now the page")).toBeInTheDocument();
  });

  it("says a property is the page already, and warns before deleting it that the records have none until another is chosen", async () => {
    renderView(GridView, { schema: withNotes("creator", notes.id), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never });
    const menu = await open(notes.id);
    expect(within(menu).getByRole("menuitem", { name: /Use as page/ })).toHaveTextContent("It is the page already");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText(/It is this collection's page/)).toBeInTheDocument();
  });

  it("leaves both disabled for an editor, who cannot configure properties", async () => {
    renderView(GridView, { schema: withNotes("editor"), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }) } as never });
    const menu = await open(notes.id);
    expect(within(menu).getByRole("menuitem", { name: /Use as title/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: /Use as page/ })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("GridView: deleting a field", () => {
  it("offers Undo, which restores the field from the trash", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", {});
    const { api } = renderView(GridView, {
      schema: projectSchema("creator", [view]),
      viewId: "viw1",
      routes: {
        "POST /api/views/viw1/query": queryHandler({ records }),
        [`DELETE /api/fields/${F.status.id}`]: { ok: true, deleted_field_ids: [F.status.id] },
        "POST /api/trash/restore": { ok: true, restored_field_ids: [F.status.id] },
      } as never,
    });
    await loaded();
    const status = grid().columns.findIndex((c) => c.id === F.status.id);
    act(() => grid().onHeaderMenu(status, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete property" }));
    await screen.findByText(/deleted$/);
    expect(api.callsTo(`DELETE /api/fields/${F.status.id}`)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/trash/restore")[0]!.body).toEqual({ kind: "field", id: F.status.id });
  });
});

describe("GridView: edits made on the record page", () => {
  it("are on the undo stack, so Undo reverts the last thing done", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    await loaded();
    // What the record page's save mutation looks like: its variables, and the record it read before saving.
    const save = new MutationObserver<unknown, Error, { recordId: string; field: typeof F.name; value: unknown }, { prev: (typeof records)[number] }>(client, { mutationKey: ["record-save", "tbl1"], mutationFn: async () => ({ records: [] }), onMutate: () => ({ prev: records[0] }) });
    await act(async () => void (await save.mutate({ recordId: "r1", field: F.name, value: "Renamed" })));
    const undo = await screen.findByRole("button", { name: "Undo: Edit Name (Ctrl/Cmd+Z)" });
    await user.click(undo);
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body as { records: unknown[] }).records).toEqual([{ id: "r1", values: { [F.name.id]: "R1" } }]);
  });
});

describe("GridView: every change to the view is a draft", () => {
  it("keeps a column's width and its freeze as a draft with the changes bar, and saves nothing", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await loaded();
    expect(screen.queryByText(/These changes are only for now/)).not.toBeInTheDocument();
    act(() => grid().onColumnResize(1, 333, true));
    await waitFor(() => expect(draftChanges()?.field_widths).toEqual({ [grid().columns[1]!.id]: 333 }));
    expect(await screen.findByText(/These changes are only for now/)).toBeInTheDocument();
    // The grid draws the new width straight away.
    await waitFor(() => expect(grid().columns[1]!.width).toBe(333));

    act(() => grid().onHeaderMenu(2, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: /Freeze/ }));
    await waitFor(() => expect(draftChanges()?.frozen_columns).toBe(2));
    await new Promise((r) => setTimeout(r, 450));
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);

    // Reset gives the saved layout back.
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(draftChanges()).toBeUndefined();
    await waitFor(() => expect(grid().columns[1]!.width).not.toBe(333));
  });

  it("asks the server for a drafted summary, and for the drafted filter along with it", async () => {
    const user = userEvent.setup();
    const { api } = setup({ routes: { "GET /api/views/viw1/aggregations": () => ({ values: { [F.effort.id]: 66 } }) } });
    await loaded();
    const effort = grid().columns.findIndex((c) => c.id === F.effort.id);
    act(() => grid().onSummaryClick(effort, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Sum" }));
    await waitFor(() => expect(api.callsTo("GET /api/views/viw1/aggregations").length).toBeGreaterThan(0));
    const sent = JSON.parse(api.callsTo("GET /api/views/viw1/aggregations").at(-1)!.query.get("transient") ?? "null") as { summaries: Record<string, string> };
    expect(sent.summaries).toEqual({ [F.effort.id]: "sum" });
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);
  });
});
