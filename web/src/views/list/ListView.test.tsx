import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupHeader } from "@/api/types";
import { field } from "@/test/fields";
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
      ["2", "ALAda Lovelace1"], // the face's initials, then the name
      ["2", "GHGrace Hopper1"],
      ["1", "Doing1"],
    ]);
    expect(screen.getByRole("button", { name: "R1" })).toBeInTheDocument();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("collapses and expands everything", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("tree");
    await user.click(screen.getByRole("button", { name: /^(More|Tools)/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Fold all groups" }));
    expect(screen.queryByRole("button", { name: "R1" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(2); // only the top level is left visible
    await user.click(screen.getByRole("button", { name: /^(More|Tools)/ }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Fold all groups" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Fold all groups" }));
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
    expect(screen.getByText("3 items")).toBeInTheDocument();
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

  it("shows one empty message, without the outline's own empty row, when there are no records", async () => {
    setup("editor", outline, { records: [], groups: [] });
    expect(await screen.findByText("No records yet.")).toBeInTheDocument();
    expect(screen.queryByText("No records")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  describe("description", () => {
    const notes = field("text", { multiline: true }, { id: "f_notes", name: "Notes" });
    const long = "Runs entirely on local models:\n- A system one model\n- A local LLM";

    function setupNotes(config: Record<string, unknown>) {
      const view = viewWithConfig("viw1", "list", config);
      const schema = projectSchema("editor", [view]);
      schema.tables[0]!.fields = [...schema.tables[0]!.fields, notes];
      const server = { records: [rec("r1", { [F.status.id]: "s1", [notes.id]: long }), rec("r2", { [F.status.id]: "s1" })], groups: [] };
      return renderView(ListView, {
        schema,
        viewId: "viw1",
        routes: { "POST /api/views/viw1/query": queryHandler(server), "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) } as never,
      });
    }

    it("is chosen in the toolbar and saved on the view", async () => {
      const user = userEvent.setup();
      const { api } = setupNotes({});
      await screen.findByRole("button", { name: "R1" });
      // Nothing is a description until the view picks one: Notes is an ordinary field.
      expect(screen.getByRole("button", { name: "R1" }).querySelector("[data-row-description]")).toBeNull();
      await user.click(screen.getAllByRole("button", { name: "View" })[0]!);
      const select = await screen.findByRole("combobox", { name: "Description" });
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["No description", "Notes"]);
      await user.selectOptions(select, "f_notes");
      await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
      expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { description_field_id: string } }).config.description_field_id).toBe("f_notes");
    });

    it("reads an excerpt right under the title and leaves the field out of the row", async () => {
      setupNotes({ description_field_id: notes.id });
      const row = await screen.findByRole("button", { name: "R1" });
      const text = row.querySelector("[data-row-description]")!;
      expect(text.textContent).toBe("Runs entirely on local models: - A system one model - A local LLM");
      expect(text.className).toContain("line-clamp-2");
      expect(text.previousElementSibling?.textContent).toBe("R1");
      expect(within(row).queryByText("Notes")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "R2" }).querySelector("[data-row-description]")).toBeNull();
    });
  });
});

describe("ListView selection, menu and order", () => {
  const flat = viewWithConfig("viw1", "list", {});
  const three = [rec("r1", {}), rec("r2", {}), rec("r3", {})];
  const flatSetup = (role = "editor", routes: Record<string, unknown> = {}, server = { records: three, groups: [] as GroupHeader[] }, view = flat) => setup(role, view, server, routes);

  it("selects rows with Ctrl-click and deletes them from the bar after asking", async () => {
    const user = userEvent.setup();
    const { api } = flatSetup("editor", { "DELETE /api/tables/tbl1/records": null });
    await screen.findByRole("button", { name: "R1" });
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("button", { name: "R1" }));
    await user.click(screen.getByRole("button", { name: "R3" }));
    await user.keyboard("{/Control}");
    expect(screen.getByTestId("where")).not.toHaveTextContent("record=");
    const bar = screen.getByRole("toolbar", { name: "Selected records" });
    expect(bar).toHaveTextContent("2 selected");
    expect(screen.getByRole("button", { name: "R1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(bar).getByRole("button", { name: /Delete/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Delete 2 records?");
    await user.click(screen.getByRole("button", { name: "Delete 2 records" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r1", "r3"] }));
  });

  it("duplicates from the bar and from the row menu", async () => {
    const user = userEvent.setup();
    const { api } = flatSetup("editor", { "POST /api/tables/tbl1/records/duplicate": { records: [rec("c1", {})] } });
    await screen.findByRole("button", { name: "R2" });
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R2" }) });
    const menu = await screen.findByRole("menu", { name: "Record menu" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Open record", "Select", "Duplicate record", "Move to start", "Delete record"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Duplicate record" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/duplicate")[0]!.body).toEqual({ ids: ["r2"] }));
  });

  it("deletes the focused row with the Delete key, with an Undo toast", async () => {
    const user = userEvent.setup();
    const { api } = flatSetup("editor", { "DELETE /api/tables/tbl1/records": null });
    await screen.findByRole("button", { name: "R2" });
    screen.getByRole("button", { name: "R2" }).focus();
    await user.keyboard("{Delete}");
    await waitFor(() => expect(api.callsTo("DELETE /api/tables/tbl1/records")[0]!.body).toEqual({ ids: ["r2"] }));
    expect(await screen.findByText("Record deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("moves a row down with Alt+Down through the move endpoint, and shows it at once", async () => {
    const user = userEvent.setup();
    let order = three;
    const { api } = flatSetup("editor", {
      "POST /api/views/viw1/query": () => ({ total: 3, offset: 0, records: order, groups: [], colors: {} }),
      "POST /api/tables/tbl1/records/move": () => {
        order = [order[1]!, order[0]!, order[2]!];
        return { records: [] };
      },
    });
    await screen.findByRole("button", { name: "R1" });
    screen.getByRole("button", { name: "R1" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/move")[0]!.body).toEqual({ ids: ["r1"], before_id: null, after_id: "r2" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^R\d$/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["R2", "R1", "R3"]));
    expect(await screen.findByText("Record moved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "R1" })).toHaveFocus();
  });

  it("does not offer to move rows when the view sorts", async () => {
    const user = userEvent.setup();
    const sorted = viewWithConfig("viw1", "list", { sorts: [{ field_id: F.name.id, direction: "asc" }] });
    const { api } = flatSetup("editor", { "POST /api/tables/tbl1/records/move": { records: [] } }, undefined, sorted);
    await screen.findByRole("button", { name: "R1" });
    screen.getByRole("button", { name: "R1" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "R2" }) });
    expect(screen.queryByRole("menuitem", { name: "Move to start" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/tables/tbl1/records/move")).toHaveLength(0);
  });

  it("changes the group value when a row moves into another group, and the headings count it at once", async () => {
    const user = userEvent.setup();
    const byStatus = viewWithConfig("viw1", "list", { groups: [{ field_id: F.status.id, direction: "asc" }] });
    const rows = [rec("r1", { [F.status.id]: "s1" }), rec("r2", { [F.status.id]: "s1" }), rec("r3", { [F.status.id]: "s2" })];
    const heads = [header(0, F.status.id, "s1", "Todo", 0, 2, "s1"), header(0, F.status.id, "s2", "Doing", 2, 1, "s2")];
    // The server holds the change back, so what the outline shows is the view's own doing.
    const { api } = setup("editor", byStatus, { records: rows, groups: heads }, {
      "PATCH /api/tables/tbl1/records": () => new Promise(() => undefined),
    });
    await screen.findByRole("button", { name: "R2" });
    screen.getByRole("button", { name: "R2" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toMatchObject({ records: [{ id: "r2", values: { [F.status.id]: "s2" } }] });
    expect(screen.getByRole("button", { name: "Collapse Todo" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Collapse Doing" })).toHaveTextContent("2");
    const doing = screen.getByRole("group", { name: "Doing" });
    expect(within(doing).getAllByRole("button", { name: /^R\d$/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["R2", "R3"]);
  });
});

describe("ListView record panel", () => {
  it("steps Previous and Next over the rows on screen, not the records of folded groups", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-list-collapsed:viw1", JSON.stringify([`${F.status.id}:s2`]));
    const byStatus = viewWithConfig("viw1", "list", { groups: [{ field_id: F.status.id, direction: "asc" }] });
    const rows = [rec("r1", { [F.status.id]: "s1" }), rec("r2", { [F.status.id]: "s1" }), rec("r3", { [F.status.id]: "s2" }), rec("r4", { [F.status.id]: "s3" })];
    const heads = [header(0, F.status.id, "s1", "Todo", 0, 2, "s1"), header(0, F.status.id, "s2", "Doing", 2, 1, "s2"), header(0, F.status.id, "s3", "Done", 3, 1, "s3")];
    setup("editor", byStatus, { records: rows, groups: heads }, { "GET /api/tables/tbl1/records/r2": rows[1]!, "GET /api/tables/tbl1/records/r4": rows[3]! });
    await user.click(await screen.findByRole("button", { name: "R2" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Next record/ }));
    // r3 is in the folded group: the next row on screen is r4.
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r4");
    localStorage.clear();
  });

  it("keeps Previous and Next for a record that no longer matches the view", async () => {
    const user = userEvent.setup();
    const flat = viewWithConfig("viw1", "list", {});
    const all = [rec("r1", {}), rec("r2", {}), rec("r3", {})];
    let served = all;
    const { client } = setup("editor", flat, { records: all, groups: [] }, { "POST /api/views/viw1/query": () => ({ total: served.length, offset: 0, records: served, groups: [], colors: {} }), "GET /api/tables/tbl1/records/r2": all[1]! });
    await user.click(await screen.findByRole("button", { name: "R2" }));
    const dialog = await screen.findByRole("dialog");
    served = [all[0]!, all[2]!];
    await client.invalidateQueries({ queryKey: ["records"] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "R2" })).not.toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: /Previous record/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /Next record/ })).toBeEnabled();
  });
});

