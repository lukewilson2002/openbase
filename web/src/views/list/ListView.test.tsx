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
