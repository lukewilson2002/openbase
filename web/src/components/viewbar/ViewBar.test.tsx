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

const name = { ...ALL_FIELDS.single_line_text, id: "fld_name", name: "Name" };
const notes = { ...ALL_FIELDS.long_text, id: "fld_notes", name: "Notes" };
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
      expect(screen.getByRole("button", { name: label })).toHaveClass("bg-primary-soft");
    }
    expect(screen.getByRole("button", { name: "More" })).not.toHaveClass("bg-primary-soft");
  });

  it("are plain words while not in use, with no collapsed state to remember", () => {
    renderBar();
    for (const label of ["Filter", "Sort", "Group", "Hide fields", "More"]) expect(screen.getByRole("button", { name: label })).not.toHaveClass("bg-primary-soft");
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
  it("without room for names, shows icons only, views of one type sharing a button that lists them", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" });
    const nav = screen.getByRole("navigation", { name: "Views of Tasks" });
    // All tasks and My tasks are both grids: one button, open because All tasks is.
    const grids = within(nav).getByRole("button", { name: "2 grid views, All tasks open" });
    expect(within(nav).getAllByRole("link").map((l) => [l.getAttribute("aria-label"), l.getAttribute("href")])).toEqual([["Board", "/base/app1/tbl1/viw2"]]);
    expect(within(nav).getByRole("link", { name: "Board" })).toHaveTextContent("");
    expect(within(nav).queryByText("All tasks")).not.toBeInTheDocument();
    await user.click(grids);
    const menu = await screen.findByRole("menu", { name: "Grid views of Tasks" });
    expect(within(menu).getAllByRole("menuitem").map((i) => [i.textContent, i.getAttribute("href"), i.getAttribute("aria-current")])).toEqual([
      ["All tasks", "/base/app1/tbl1/viw1", "page"],
      ["My tasks", "/base/app1/tbl1/viw3", null],
    ]);
    expect(within(menu).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
  });

  it("with room for every name, gives each view its own button with its name, merging none", () => {
    const widths = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(200);
    const room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    try {
      const schema = makeSchema("creator");
      const t = schema.tables[0]!;
      renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { phone: true });
      const views = within(screen.getByRole("navigation", { name: "Views of Tasks" })).getAllByRole("link");
      expect(views.map((l) => [l.getAttribute("aria-label"), l.textContent])).toEqual([
        ["All tasks", "All tasks"],
        ["Board", "Board"],
        ["My tasks", "My tasks"],
      ]);
      expect(views.map((l) => l.getAttribute("aria-current"))).toEqual(["page", null, null]);
      expect(within(views[2]!).getByRole("img", { name: "Personal view" })).toBeInTheDocument();
    } finally {
      widths.mockRestore();
      room.mockRestore();
    }
  });

  it("marks a locked view", () => {
    const view = makeView({ id: "viw1", name: "Frozen", locked: true });
    const schema = makeSchema("viewer");
    const t = { ...schema.tables[0]!, views: [view] };
    renderBar({ schema, table: t, view, config: view.config });
    expect(within(screen.getByRole("link", { name: "Frozen" })).getByRole("img", { name: "Locked view" })).toBeInTheDocument();
  });

  it("puts the buttons that do not fit into a … menu, four on a phone, keeping the open view in sight", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("viewer");
    const types = ["grid", "kanban", "gallery", "calendar", "timeline", "list"] as const;
    const views = types.map((type, i) => makeView({ id: `v${i + 1}`, name: `View ${i + 1}`, type }));
    const t = { ...schema.tables[0]!, views };
    // The open view is the sixth: it takes the last of the four places.
    renderBar({ schema, table: t, view: views[5]!, config: views[5]!.config }, { phone: true });
    const nav = screen.getByRole("navigation", { name: "Views of Tasks" });
    expect(within(nav).getAllByRole("link").map((l) => l.getAttribute("aria-label"))).toEqual(["View 1", "View 2", "View 3", "View 6"]);
    expect(within(nav).getByRole("link", { name: "View 6" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "2 more views" }));
    const menu = await screen.findByRole("menu", { name: "More views of Tasks" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View 4", "View 5"]);
    expect(within(menu).getByRole("menuitem", { name: "View 5" })).toHaveAttribute("href", "/base/app1/tbl1/v5");
  });

  it("opens the project's dialog for a new view of the chosen type", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog });
    await user.click(screen.getByRole("button", { name: "Add view" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Calendar/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "create-view", table: t, type: "calendar" });
  });

  it("opens a view's menu on a right-click of its button, for those who may change it", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const widths = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(200);
    const room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    try {
      const schema = makeSchema("creator");
      const t = schema.tables[0]!;
      const { unmount } = renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { phone: true, onDialog });
      fireEvent.contextMenu(screen.getByRole("link", { name: "Board" }), { clientX: 40, clientY: 30 });
      const menu = await screen.findByRole("menu", { name: "Options for Board" });
      expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Rename view", "Duplicate view", "Share view…", "Lock view", "Delete view"]);
      await user.click(within(menu).getByRole("menuitem", { name: /Rename view/ }));
      expect(onDialog).toHaveBeenCalledWith({ kind: "rename-view", view: t.views[1] });
      unmount();
      // A viewer has nothing to do with a view: the browser's own menu stays.
      const viewer = makeSchema("viewer");
      renderBar({ schema: viewer, table: viewer.tables[0]!, view: viewer.tables[0]!.views[0]!, config: viewer.tables[0]!.views[0]!.config }, { phone: true, onDialog });
      expect(fireEvent.contextMenu(screen.getByRole("link", { name: "Board" }))).toBe(true);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      widths.mockRestore();
      room.mockRestore();
    }
  });

  it("opens a view's menu on a right-click of it in a shared button's list, over the list, which stays open", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    // No room for names (jsdom measures nothing): All tasks and My tasks share the grid button.
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { phone: true, onDialog });
    await user.click(screen.getByRole("button", { name: "2 grid views, All tasks open" }));
    const list = await screen.findByRole("menu", { name: "Grid views of Tasks" });
    fireEvent.contextMenu(within(list).getByRole("menuitem", { name: /My tasks/ }), { clientX: 60, clientY: 80 });
    let menu = await screen.findByRole("menu", { name: "Options for My tasks" });
    expect(screen.getByRole("menu", { name: "Grid views of Tasks" })).toBeInTheDocument();
    // Escape closes the view's menu only; the list is still there to right-click another.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Options for My tasks" })).not.toBeInTheDocument());
    expect(screen.getByRole("menu", { name: "Grid views of Tasks" })).toBeInTheDocument();
    fireEvent.contextMenu(within(screen.getByRole("menu", { name: "Grid views of Tasks" })).getByRole("menuitem", { name: /My tasks/ }), { clientX: 60, clientY: 80 });
    menu = await screen.findByRole("menu", { name: "Options for My tasks" });
    await user.click(within(menu).getByRole("menuitem", { name: /Rename view/ }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "rename-view", view: t.views[2] });
  });

  it("opens a view's menu on a held press, and the lift does not also open the view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const schema = makeSchema("creator");
      const t = schema.tables[0]!;
      renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { phone: true, onDialog: vi.fn() });
      const board = screen.getByRole("link", { name: "Board" });
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

  it("tells editors they can make personal views only, and offers viewers no +", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("editor");
    const t = schema.tables[0]!;
    const { unmount } = renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "editor" }, { onDialog: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Add view" }));
    expect(await screen.findByText("Editors can create personal views.")).toBeInTheDocument();
    unmount();
    renderBar({}, { onDialog: vi.fn() });
    expect(screen.queryByRole("button", { name: "Add view" })).not.toBeInTheDocument();
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
