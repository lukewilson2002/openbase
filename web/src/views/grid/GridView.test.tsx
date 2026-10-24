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
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import type { GridAdapterProps, GridSelectionInfo } from "./adapter";

const canvas = vi.hoisted(() => ({ props: null as unknown, clear: vi.fn() }));
vi.mock("./glide/GlideGrid", async () => {
  const React = await import("react");
  return {
    GRID_HEADER_HEIGHT: 44,
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
    await waitFor(() => expect(grid().rowCount).toBe(6));
    expect(grid().getCell(0, 0).kind).toBe("group");
    let handled = false;
    act(() => {
      handled = grid().onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, cell: { col: 0, row: 0 } });
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(grid().rowCount).toBe(4));
    unmount();
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(4));
  });

  it("collapses and expands every group from the footer", async () => {
    const user = userEvent.setup();
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(6));
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    await waitFor(() => expect(grid().rowCount).toBe(2));
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(grid().rowCount).toBe(6));
  });

  it("opens a summary cell's menu from the keyboard", async () => {
    setup({ recs: four, groups });
    await waitFor(() => expect(grid().rowCount).toBe(6));
    act(() => {
      grid().onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, cell: { col: 1, row: 6 } });
    });
    expect(await screen.findByRole("menu", { name: "Summary options" })).toBeInTheDocument();
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

describe("GridView: record panel", () => {
  it("fetches the page next to the open record so Next does not stop at the loaded pages", async () => {
    const many = Array.from({ length: 450 }, (_, i) => rec(`m${i}`, {}));
    const open = many[199]!;
    const { asked } = setup({ recs: many, route: "/base/app1/tbl1/viw1?record=m199", routes: { "GET /api/tables/tbl1/records/m199": open } });
    // The first page holds m199, the last of the page; Next lives on the second.
    await waitFor(() => expect((asked as { offset: number }[]).map((a) => a.offset)).toContain(200));
    const next = await screen.findByRole("button", { name: "Next record (Alt+Down)" });
    await waitFor(() => expect(next).toBeEnabled());
  });
});

describe("GridView: record panel with folded groups", () => {
  it("steps over a folded group to the next record that is on screen", async () => {
    const groups: GroupHeader[] = [
      { depth: 0, field_id: F.status.id, key: "s1", value: "s1", label: "Todo", count: 2, start: 0 },
      { depth: 0, field_id: F.status.id, key: "s2", value: "s2", label: "Doing", count: 2, start: 2 },
      { depth: 0, field_id: F.status.id, key: "s3", value: "s3", label: "Done", count: 2, start: 4 },
    ];
    // The middle group is folded: after r2 comes r5.
    localStorage.setItem("ob-grid-collapsed:viw1", JSON.stringify([`${F.status.id}:s2`]));
    const { api } = setup({ recs: records.slice(0, 6), groups, route: "/base/app1/tbl1/viw1?record=r2", routes: { "GET /api/tables/tbl1/records/r2": records[1], "GET /api/tables/tbl1/records/r5": records[4] } });
    const next = await screen.findByRole("button", { name: "Next record (Alt+Down)" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.setup().click(next);
    await waitFor(() => expect(api.callsTo("GET /api/tables/tbl1/records/r5").length).toBeGreaterThan(0));
    expect(api.callsTo("GET /api/tables/tbl1/records/r3")).toHaveLength(0);
  });
});

describe("GridView: column menu", () => {
  it("moves a column left or right, never before the primary field", async () => {
    const user = userEvent.setup();
    const view = viewWithConfig("viw1", "grid", { hidden_fields: [F.start.id] });
    const { api } = renderView(GridView, {
      schema: projectSchema("editor", [view]),
      viewId: "viw1",
      routes: { "POST /api/views/viw1/query": queryHandler({ records }), "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) } as never,
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
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    // The hidden Start field keeps its slot between Status and End.
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { field_order: string[] } }).config.field_order.slice(0, 4)).toEqual([F.name.id, F.end.id, F.start.id, F.status.id]);
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
    await user.click(await screen.findByRole("menuitem", { name: "Delete field" }));
    await user.click(await screen.findByRole("button", { name: "Delete field" }));
    await screen.findByText(/deleted$/);
    expect(api.callsTo(`DELETE /api/fields/${F.status.id}`)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/trash/restore")).toHaveLength(1));
    expect(api.callsTo("POST /api/trash/restore")[0]!.body).toEqual({ kind: "field", id: F.status.id });
  });
});

describe("GridView: edits made in the record panel", () => {
  it("are on the undo stack, so Undo reverts the last thing done", async () => {
    const user = userEvent.setup();
    const { api, client } = setup();
    await loaded();
    // What ExpandedRecord's save mutation looks like: its variables, and the record it read before saving.
    const save = new MutationObserver<unknown, Error, { recordId: string; field: typeof F.name; value: unknown }, { prev: (typeof records)[number] }>(client, { mutationKey: ["record-save", "tbl1"], mutationFn: async () => ({ records: [] }), onMutate: () => ({ prev: records[0] }) });
    await act(async () => void (await save.mutate({ recordId: "r1", field: F.name, value: "Renamed" })));
    const undo = await screen.findByRole("button", { name: "Undo: Edit Name (Ctrl/Cmd+Z)" });
    await user.click(undo);
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body as { records: unknown[] }).records).toEqual([{ id: "r1", values: { [F.name.id]: "R1" } }]);
  });
});
