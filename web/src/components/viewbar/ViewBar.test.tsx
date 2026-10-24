import { createRef } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ViewConfig } from "@/api/types";
import { BaseDialogContext } from "@/base/BaseDialogs";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeSchema, makeView, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { ViewBar, type ViewBarProps } from "./ViewBar";

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/download", async (orig) => ({ ...(await orig<typeof import("@/lib/download")>()), saveBlob }));

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" };
const notes = { ...ALL_FIELDS.rich_text, id: "fld_notes", name: "Notes" };
const table = makeTable([name, notes]);

/** A desktop unless `phone`; jsdom matches no media query, which the toolbar reads as a phone. */
function renderBar(over: Partial<ViewBarProps> = {}, { phone = false, onDialog }: { phone?: boolean; onDialog?: () => void } = {}) {
  if (!phone) stubDesktop();
  const view = over.view ?? makeView({ id: "viw1", name: "All tasks" });
  const props: ViewBarProps = {
    schema: makeSchema("viewer"),
    table,
    view,
    role: "viewer",
    config: view.config,
    canConfigure: false,
    hasLocalQuery: false,
    onResetLocalQuery: vi.fn(),
    saving: false,
    update: vi.fn(),
    collaborators: [],
    currentUserId: null,
    search: "",
    onSearchChange: vi.fn(),
    searchOpen: false,
    onSearchOpenChange: vi.fn(),
    searchInputRef: createRef<HTMLInputElement>(),
    ...over,
  };
  const bar = <ViewBar {...props} />;
  const { unmount } = renderWithProviders(onDialog ? <BaseDialogContext.Provider value={onDialog}>{bar}</BaseDialogContext.Provider> : bar);
  return { ...props, unmount };
}

const withConfig = (patch: Partial<ViewConfig>) => {
  const view = makeView({ id: "viw1", name: "All tasks" });
  const v = { ...view, config: { ...view.config, ...patch } };
  return { view: v, config: v.config };
};

describe("ViewBar for people who cannot save the view", () => {
  it("lets them filter, and says it applies only to them", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByText(/apply only to you and are not saved/)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add condition" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(props.update).toHaveBeenCalledTimes(1);
  });

  it("lets them sort and group too", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByText(/apply only to you and are not saved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add (a )?sort/i })).toBeEnabled();
  });

  it("keeps colours read-only (the override does not cover them)", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(screen.getByRole("group", { name: "Color records" })).toBeDisabled();
  });

  it("shows no Not saved marker while nothing local is in effect", () => {
    renderBar({ hasLocalQuery: false });
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });

  it("the Not saved marker resets the local query", async () => {
    const props = renderBar({ hasLocalQuery: true });
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onResetLocalQuery).toHaveBeenCalledTimes(1);
  });
});

describe("ViewBar for people who can save the view", () => {
  it("shows no marker and no read-only note", async () => {
    renderBar({ canConfigure: true, hasLocalQuery: true, role: "editor", schema: makeSchema("editor") });
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
  });

  it("shows the locked badge on a locked view", () => {
    renderBar({ view: makeView({ id: "viw1", locked: true }), canConfigure: false });
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });

  it("sets the row height from the toolbar", async () => {
    const props = renderBar({ canConfigure: true, role: "creator", schema: makeSchema("creator") });
    await userEvent.click(screen.getByRole("button", { name: "Row height" }));
    await userEvent.click(screen.getByRole("radio", { name: "Tall" }));
    expect(props.update).toHaveBeenCalledTimes(1);
  });
});

describe("ViewBar tools in use", () => {
  it("say what they do: sorted, filtered and grouped by a field, and how many fields are hidden", () => {
    renderBar(
      withConfig({
        sorts: [{ field_id: "fld_name", direction: "asc" }],
        filter: { conjunction: "and", items: [{ field_id: "fld_notes", op: "contains", value: "a" }, { conjunction: "or", items: [{ field_id: "fld_name", op: "contains", value: "b" }] }] },
        groups: [{ field_id: "fld_name", direction: "asc" }],
        hidden_fields: ["fld_notes"],
      }),
    );
    for (const label of ["Sorted by Name", "Filtered by Notes and 1 more", "Grouped by Name", "1 hidden field"]) {
      // On: a neutral fill and bold words, never the accent (it marks what is selected).
      expect(screen.getByRole("button", { name: label })).toHaveClass("bg-tool-on");
      expect(screen.getByRole("button", { name: label })).not.toHaveClass("bg-primary");
    }
    expect(screen.getByRole("button", { name: "More" })).not.toHaveClass("font-semibold");
  });

  it("name the colour field, colour rules and a row height other than short, and leave More plain when nothing in it is on", () => {
    const team = { ...ALL_FIELDS.single_select, id: "fld_team", name: "Team" };
    renderBar({ ...withConfig({ row_color: { mode: "by_select", field_id: "fld_team" }, row_height: "tall" }), table: makeTable([name, notes, team]) });
    for (const label of ["Color by Team", "Tall rows"]) {
      expect(screen.getByRole("button", { name: label })).toHaveClass("bg-tool-on");
      // A grey fill says it is on; the text stays its normal weight.
      expect(screen.getByRole("button", { name: label })).not.toHaveClass("font-semibold");
    }
    expect(screen.getByRole("button", { name: "More" })).not.toHaveClass("bg-tool-on");
  });

  it("say when records are coloured by conditions", () => {
    renderBar(withConfig({ row_color: { mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [] } }] } }));
    expect(screen.getByRole("button", { name: "Color by conditions" })).toHaveClass("bg-tool-on");
  });

  it("are plain words while not in use, with no collapsed state to remember", () => {
    renderBar();
    for (const label of ["Filter", "Sort", "Group", "Hide fields", "More"]) expect(screen.getByRole("button", { name: label })).not.toHaveClass("font-semibold");
    expect(screen.queryByRole("button", { name: /Hide tools|^Tools/ })).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it("leave out what a view type does not use", () => {
    renderBar({ features: { group: false, rowHeight: false, color: false, csv: false }, hideFieldsNoun: "Card fields" });
    expect(screen.queryByRole("button", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Card fields" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});

describe("ViewBar export and sharing", () => {
  it("offers Download CSV in More to everyone who can see the view", async () => {
    const api = mockApi({ "GET /api/views/viw1/export.csv": { text: "Name\n", headers: { "Content-Type": "text/csv" } } });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Download CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(api.callsTo("GET /api/views/viw1/export.csv")).toHaveLength(1);
  });

  it("offers Add field in More where the view adds fields (the grid's header + is canvas, out of keyboard reach)", async () => {
    const onAddField = vi.fn();
    renderBar({ onAddField });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    // With room for every tool, More holds only what always lives there.
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Add field", "Download CSV"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add field" }));
    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "More view tools" })).not.toBeInTheDocument();
  });

  it("can leave the CSV out (form views), and then has no More while every tool fits", () => {
    renderBar({ features: { csv: false } });
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("has no Share view of its own: sharing a view is in the base's Share dialog and the view's menu", () => {
    renderBar({ role: "creator", schema: makeSchema("creator") });
    expect(screen.queryByRole("button", { name: /Share view/ })).not.toBeInTheDocument();
  });
});

describe("ViewBar view switcher", () => {
  /** Opens the list of views from the button naming the open one. */
  const openList = async (user: ReturnType<typeof userEvent.setup>, open = "All tasks") => {
    await user.click(screen.getByRole("button", { name: `View: ${open}` }));
    return screen.findByRole("menu", { name: "Views of Tasks" });
  };
  /** Opens the grids' submenu from their row in the list (→; a click on the row opens the view it names). */
  const openGrids = async (user: ReturnType<typeof userEvent.setup>) => {
    within(await openList(user)).getByRole("menuitem", { name: /^Grid views/ }).focus();
    await user.keyboard("{ArrowRight}");
    return screen.findByRole("menu", { name: "Grid views" });
  };

  it("names the open view on one button, which lists the views, several of one type sharing a row that opens them", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" });
    const button = screen.getByRole("button", { name: "View: All tasks" });
    expect(button).toHaveTextContent("All tasks");
    expect(button).toHaveClass("bg-primary");
    // No button per view any more.
    expect(screen.queryByRole("link", { name: "Board" })).not.toBeInTheDocument();
    const menu = await openList(user);
    // The two grids share a row named like a view (the open one), with how many more; the only kanban view stands on its own.
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows.map((i) => i.textContent)).toEqual(["All tasks+1", "Board"]);
    expect(rows[1]).toHaveAttribute("href", "/base/app1/tbl1/viw2");
    expect(within(menu).getByRole("menuitem", { name: "Grid views: All tasks and 1 more" })).toHaveAttribute("aria-haspopup", "menu");
    await user.keyboard("{Escape}");
    const sub = await openGrids(user);
    expect(within(sub).getAllByRole("menuitem").map((i) => [i.textContent, i.getAttribute("href"), i.getAttribute("aria-current")])).toEqual([
      ["All tasks", "/base/app1/tbl1/viw1", "page"],
      ["My tasks", "/base/app1/tbl1/viw3", null],
    ]);
    expect(within(sub).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
  });

  it("names a shared row after the open view of its type", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[2]!, config: t.views[2]!.config, role: "creator" });
    const menu = await openList(user, "My tasks");
    expect(within(menu).getByRole("menuitem", { name: "Grid views: My tasks and 1 more" })).toBeInTheDocument();
  });

  it("marks a locked view", () => {
    const view = makeView({ id: "viw1", name: "Frozen", locked: true });
    const schema = makeSchema("viewer");
    const t = { ...schema.tables[0]!, views: [view] };
    renderBar({ schema, table: t, view, config: view.config });
    expect(within(screen.getByRole("button", { name: "View: Frozen" })).getByRole("img", { name: "Locked view" })).toBeInTheDocument();
  });

  it("opens the project's dialog for a new view of the chosen type", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog });
    // At the end of the list of views, after a line.
    const list = await openList(user);
    expect(within(list).getAllByRole("menuitem").at(-1)).toHaveTextContent("Add view");
    await user.click(within(list).getByRole("menuitem", { name: "Add view" }));
    // A click straight on the item: jsdom has no layout for the pointer's path into the submenu.
    fireEvent.click(within(await screen.findByRole("menu", { name: "Add view" })).getByRole("menuitem", { name: /^Calendar/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "create-view", table: t, type: "calendar" });
  });

  it("opens the open view's menu on a right-click of the button, for those who may change it", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    const { unmount } = renderBar({ schema, table: t, view: t.views[1]!, config: t.views[1]!.config, role: "creator" }, { onDialog });
    fireEvent.contextMenu(screen.getByRole("button", { name: "View: Board" }), { clientX: 40, clientY: 30 });
    const menu = await screen.findByRole("menu", { name: "Options for Board" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Rename view", "Duplicate view", "Share view…", "Lock view", "Move up", "Move down", "Delete view"]);
    await user.click(within(menu).getByRole("menuitem", { name: /Rename view/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "rename-view", view: t.views[1] });
    unmount();
    // A viewer has nothing to do with a view: the browser's own menu stays.
    const viewer = makeSchema("viewer");
    renderBar({ schema: viewer, table: viewer.tables[0]!, view: viewer.tables[0]!.views[1]!, config: viewer.tables[0]!.views[1]!.config }, { onDialog });
    expect(fireEvent.contextMenu(screen.getByRole("button", { name: "View: Board" }))).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  describe("moving a view in its options menu", () => {
    const reorderUrl = "POST /api/tables/tbl1/views/reorder";
    const open = async (role: string, view: number) => {
      const schema = makeSchema(role);
      const t = schema.tables[0]!;
      renderBar({ schema, table: t, view: t.views[view]!, config: t.views[view]!.config, role }, { onDialog: vi.fn() });
      fireEvent.contextMenu(screen.getByRole("button", { name: `View: ${t.views[view]!.name}` }), { clientX: 40, clientY: 30 });
      return screen.findByRole("menu", { name: `Options for ${t.views[view]!.name}` });
    };

    it("sends the shared views' ids in the new order, leaving the personal view out", async () => {
      const user = userEvent.setup();
      const api = mockApi({ [reorderUrl]: { ok: true } });
      const menu = await open("creator", 0);
      // The first of the shared views cannot go up.
      expect(within(menu).getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
      await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(api.callsTo(reorderUrl)).toHaveLength(1));
      expect(api.callsTo(reorderUrl)[0]?.body).toEqual({ ids: ["viw2", "viw1"] });
    });

    it("disables Move down on the last of its group, and Move up sends the order back", async () => {
      const user = userEvent.setup();
      const api = mockApi({ [reorderUrl]: { ok: true } });
      const menu = await open("creator", 1);
      expect(within(menu).getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
      await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));
      await waitFor(() => expect(api.callsTo(reorderUrl)).toHaveLength(1));
      expect(api.callsTo(reorderUrl)[0]?.body).toEqual({ ids: ["viw2", "viw1"] });
    });

    it("has no Move for a lone personal view", async () => {
      mockApi({});
      const menu = await open("creator", 2);
      expect(within(menu).queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Rename view" })).toBeInTheDocument();
    });

    it("lets an editor move their personal views among themselves, with the shared ones left out", async () => {
      const user = userEvent.setup();
      const api = mockApi({ [reorderUrl]: { ok: true } });
      const schema = makeSchema("editor");
      const t = { ...schema.tables[0]!, views: [...schema.tables[0]!.views, makeView({ id: "viw5", name: "Mine too", personal: true })] };
      const mine = t.views[2]!;
      renderBar({ schema: { ...schema, tables: [t] }, table: t, view: mine, config: mine.config, role: "editor" }, { onDialog: vi.fn() });
      fireEvent.contextMenu(screen.getByRole("button", { name: "View: My tasks" }), { clientX: 40, clientY: 30 });
      const menu = await screen.findByRole("menu", { name: "Options for My tasks" });
      expect(within(menu).getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
      await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(api.callsTo(reorderUrl)).toHaveLength(1));
      expect(api.callsTo(reorderUrl)[0]?.body).toEqual({ ids: ["viw5", "viw3"] });
    });

    it("gives a viewer no menu and so no Move items", async () => {
      const schema = makeSchema("viewer");
      const t = schema.tables[0]!;
      renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config }, { onDialog: vi.fn() });
      expect(fireEvent.contextMenu(screen.getByRole("button", { name: "View: All tasks" }))).toBe(true);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /^Move/ })).not.toBeInTheDocument();
    });
  });

  it("opens a view's menu on a right-click of it in the list, over the list, which stays open", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog });
    const list = await openGrids(user);
    fireEvent.contextMenu(within(list).getByRole("menuitem", { name: /My tasks/ }), { clientX: 60, clientY: 80 });
    let menu = await screen.findByRole("menu", { name: "Options for My tasks" });
    expect(screen.getByRole("menu", { name: "Grid views" })).toBeInTheDocument();
    // Escape closes the view's menu only; the list is still there to right-click another.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Options for My tasks" })).not.toBeInTheDocument());
    expect(screen.getByRole("menu", { name: "Grid views" })).toBeInTheDocument();
    fireEvent.contextMenu(within(screen.getByRole("menu", { name: "Grid views" })).getByRole("menuitem", { name: /My tasks/ }), { clientX: 60, clientY: 80 });
    menu = await screen.findByRole("menu", { name: "Options for My tasks" });
    // Straight onto the item: in jsdom (no layout) the pointer's way out of a submenu reads as leaving it.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Rename view/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "rename-view", view: t.views[2] });
  });

  it("keeps a view's menu open while the mouse crosses the list under it on the way in", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog });
    const list = await openList(user);
    const board = within(list).getByRole("menuitem", { name: /Board/ });
    fireEvent.contextMenu(board, { clientX: 60, clientY: 80 });
    const menu = await screen.findByRole("menu", { name: "Options for Board" });
    // Off the item it was opened from, over the grids' row (which would open their submenu), and into the menu.
    await user.unhover(board);
    const grids = within(list).getByRole("menuitem", { name: /^Grid views/ });
    await user.hover(grids);
    await user.unhover(grids);
    expect(list).not.toContainElement(document.activeElement as HTMLElement);
    expect(screen.queryByRole("menu", { name: "Grid views" })).not.toBeInTheDocument();
    await user.hover(within(menu).getByRole("menuitem", { name: /Delete view/ }));
    expect(screen.getByRole("menu", { name: "Options for Board" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /Delete view/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "delete-view", table: t, view: t.views[1] });
  });

  it("opens a view's menu on a held press in the list, and the lift does not also open the view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const schema = makeSchema("creator");
      const t = schema.tables[0]!;
      renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { phone: true, onDialog: vi.fn() });
      const list = await openList(user);
      const board = within(list).getByRole("menuitem", { name: /Board/ });
      fireEvent.pointerDown(board, { pointerType: "touch", clientX: 40, clientY: 30 });
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(await screen.findByRole("menu", { name: "Options for Board" })).toBeInTheDocument();
      fireEvent.pointerUp(board, { pointerType: "touch" });
      // The click after the lift is swallowed: still on the first view.
      expect(fireEvent.click(board)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells editors they can make personal views only, and offers viewers no Add view", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("editor");
    const t = schema.tables[0]!;
    const { unmount } = renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "editor" }, { onDialog: vi.fn() });
    await user.click(within(await openList(user)).getByRole("menuitem", { name: "Add view" }));
    expect(await screen.findByText("Editors can create personal views.")).toBeInTheDocument();
    unmount();
    renderBar({}, { onDialog: vi.fn() });
    expect(within(await openList(user)).queryByRole("menuitem", { name: "Add view" })).not.toBeInTheDocument();
  });
});

describe("ViewBar on a phone", () => {
  it("folds the tools into one menu, each opening its editor in place", async () => {
    const user = userEvent.setup();
    renderBar(withConfig({ sorts: [{ field_id: "fld_name", direction: "asc" }] }), { phone: true });
    expect(screen.queryByRole("button", { name: "Filter" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tools: filter, sort and more (1 on)" }));
    const menu = screen.getByRole("menu", { name: "View tools" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Filter", "SortName", "Group", "Hide fields", "Color", "Row height", "Download CSV"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Filter" }));
    expect(screen.getByRole("heading", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add condition" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the tools" }));
    expect(screen.getByRole("menu", { name: "View tools" })).toBeInTheDocument();
  });
});

describe("ViewBar Add", () => {
  it("adds a record from the toolbar on a desktop, as a secondary button", async () => {
    const onAdd = vi.fn();
    renderBar({ onAdd });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveTextContent("Add");
    expect(add.closest("[role=toolbar]")).not.toBeNull();
    expect(add).toHaveClass("border-line-strong", "bg-surface");
    expect(add).not.toHaveClass("bg-primary");
    expect(add).not.toHaveClass("ob-tint-button");
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("floats at the bottom corner on a phone", async () => {
    const onAdd = vi.fn();
    renderBar({ onAdd }, { phone: true });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveClass("fixed", "bg-surface");
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("is left out when there is no way to add", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Add record" })).not.toBeInTheDocument();
  });
});

describe("ViewBar: a view type's own setting and switches", () => {
  it("puts the view's main setting before the tools", () => {
    renderBar({ setting: <button type="button">Stacked by Status</button> });
    const tools = screen.getAllByRole("button").map((b) => b.textContent);
    expect(tools.indexOf("Stacked by Status")).toBeLessThan(tools.indexOf("Filter"));
  });

  it("lists the view's switches in More, checked or not, and flips them", async () => {
    const onToggle = vi.fn();
    renderBar({ moreToggles: [{ id: "hide", label: "Hide empty stacks", icon: null, checked: true, onToggle }] });
    await userEvent.click(screen.getByRole("button", { name: /^More/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Hide empty stacks" });
    expect(item).toHaveAttribute("aria-checked", "true");
    await userEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("shows a switch that cannot be used as disabled", async () => {
    renderBar({ moreToggles: [{ id: "crop", label: "Crop cover images", icon: null, checked: false, disabled: true, onToggle: vi.fn() }] });
    await userEvent.click(screen.getByRole("button", { name: /^More/ }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Crop cover images" })).toBeDisabled();
  });
});

describe("ViewBar on a narrow window", () => {
  it("moves the tools that do not fit into More, from the right end first, and keeps CSV there", async () => {
    // Every measured tool and More are 100 px; the row has room for two tools and More.
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    const room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(350);
    try {
      renderBar({ onAddField: vi.fn() });
      const bar = screen.getByRole("toolbar", { name: "View toolbar" });
      expect(within(bar).getByRole("button", { name: "Filter" })).toBeInTheDocument();
      expect(within(bar).getByRole("button", { name: "Sort" })).toBeInTheDocument();
      expect(within(bar).queryByRole("button", { name: "Group" })).not.toBeInTheDocument();
      await userEvent.click(within(bar).getByRole("button", { name: "More" }));
      expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Group", "Hide fields", "Color", "Row height", "Add field", "Download CSV"]);
    } finally {
      width.mockRestore();
      room.mockRestore();
    }
  });
});

describe("ViewBar grouping by a date", () => {
  const due = { ...ALL_FIELDS.date, id: "fld_due", name: "Due" };
  const created = { ...ALL_FIELDS.created_time, id: "fld_created", name: "Created" };
  const dated = makeTable([name, due, created]);

  function renderGrouped(groups: ViewConfig["groups"]) {
    const { view, config } = withConfig({ groups });
    return renderBar({ table: dated, view, config, canConfigure: true, role: "creator", schema: makeSchema("creator") });
  }
  /** Apply the updater the toolbar last passed to `update`. */
  const applied = (props: { update: ViewBarProps["update"]; config: ViewConfig }) => {
    const fn = vi.mocked(props.update).mock.lastCall![0] as (c: ViewConfig) => ViewConfig;
    return fn(props.config);
  };

  it("offers day, week, month, quarter and year for a date level only, defaulting to day", async () => {
    renderGrouped([{ field_id: "fld_due", direction: "asc" }, { field_id: "fld_name", direction: "asc" }]);
    await userEvent.click(screen.getByRole("button", { name: /^Grouped by Due/ }));
    const pick = screen.getByRole("combobox", { name: "Granularity for group 1" });
    expect(pick).toHaveValue("day");
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["by day", "by week", "by month", "by quarter", "by year"]);
    expect(screen.queryByRole("combobox", { name: "Granularity for group 2" })).not.toBeInTheDocument();
  });

  it("saves the chosen granularity on the level", async () => {
    const props = renderGrouped([{ field_id: "fld_created", direction: "desc", granularity: "year" }]);
    await userEvent.click(screen.getByRole("button", { name: /^Grouped by Created/ }));
    const pick = screen.getByRole("combobox", { name: "Granularity for group 1" });
    expect(pick).toHaveValue("year");
    await userEvent.selectOptions(pick, "month");
    expect(applied(props).groups).toEqual([{ field_id: "fld_created", direction: "desc", granularity: "month" }]);
  });
});

describe("Hide fields: order", () => {
  const f = (n: number) => ({ ...ALL_FIELDS.text, id: `fld_${n}`, name: `Field ${n}` });
  const four = makeTable([f(1), f(2), f(3), f(4)], { primary_field_id: "fld_1" });

  async function open(over: Partial<ViewConfig> = {}) {
    const { view, config } = withConfig(over);
    const props = renderBar({ table: four, view, config, canConfigure: true });
    await userEvent.click(screen.getByRole("button", { name: /Hide fields|hidden field/ }));
    return props;
  }
  /** The config the last `update` call produces from the one on screen. */
  const applied = (update: ViewBarProps["update"], config: ViewConfig) => (vi.mocked(update).mock.calls.at(-1)![0] as (c: ViewConfig) => ViewConfig)(config);

  it("moves a field up or down from its row, never above the primary field", async () => {
    const props = await open();
    expect(screen.getByRole("button", { name: "Move Field 2 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Field 4 down" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move Field 3 up" }));
    expect(applied(props.update, props.config).field_order).toEqual(["fld_1", "fld_3", "fld_2", "fld_4"]);
    await userEvent.click(screen.getByRole("button", { name: "Move Field 2 down" }));
    expect(applied(props.update, props.config).field_order).toEqual(["fld_1", "fld_3", "fld_2", "fld_4"]);
  });

  it("reorders by dragging a row's handle onto another row", async () => {
    const props = await open();
    const rows = screen.getAllByRole("listitem");
    const dragged = rows.find((r) => within(r).queryByText("Field 4"))!;
    const target = rows.find((r) => within(r).queryByText("Field 2"))!;
    expect(dragged).toHaveAttribute("draggable", "true");
    expect(rows.find((r) => within(r).queryByText("Field 1"))).toHaveAttribute("draggable", "false");
    const data = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(dragged, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data });
    fireEvent.drop(target, { dataTransfer: data });
    expect(applied(props.update, props.config).field_order).toEqual(["fld_1", "fld_4", "fld_2", "fld_3"]);
  });

  it("offers no reordering while the list is filtered by the search box", async () => {
    await open();
    await userEvent.type(screen.getByRole("textbox", { name: "Find a field" }), "Field 3");
    expect(screen.queryByRole("button", { name: /^Move Field/ })).not.toBeInTheDocument();
  });
});
