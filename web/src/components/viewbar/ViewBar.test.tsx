import { createRef } from "react";
import { screen, waitFor, within } from "@testing-library/react";
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
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Color" }));
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

  it("sets the row height from More", async () => {
    const props = renderBar({ canConfigure: true, role: "creator", schema: makeSchema("creator") });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Row height" }));
    await userEvent.click(screen.getByRole("radio", { name: "Tall" }));
    expect(props.update).toHaveBeenCalledTimes(1);
    // Back to the list of tools without closing.
    await userEvent.click(screen.getByRole("button", { name: "Back to the tools" }));
    expect(screen.getByRole("menuitem", { name: "Download CSV" })).toBeInTheDocument();
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
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Add field", "Color", "Row height", "Download CSV"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add field" }));
    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "More view tools" })).not.toBeInTheDocument();
  });

  it("can leave the CSV out (form views)", async () => {
    renderBar({ features: { csv: false } });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Color" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Download CSV" })).not.toBeInTheDocument();
  });

  it("has no Share view of its own: sharing a view is in the base's Share dialog and the view's menu", () => {
    renderBar({ role: "creator", schema: makeSchema("creator") });
    expect(screen.queryByRole("button", { name: /Share view/ })).not.toBeInTheDocument();
  });
});

describe("ViewBar table and view picker", () => {
  it("names the table and view, and lists the tables with the pointed-at table's views", async () => {
    const user = userEvent.setup();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog: vi.fn() });
    const trigger = screen.getByRole("button", { name: "Showing the Tasks table, All tasks view. Switch table or view" });
    expect(trigger).toHaveTextContent("Tasks/All tasks");
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Pick a table, then a view" });
    expect(within(menu).getByRole("menuitemradio", { name: "Tasks" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "All tasks" })).toHaveAttribute("href", "/base/app1/tbl1/viw1");
    expect(within(menu).getByRole("menuitemradio", { name: "All tasks" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /My tasks/ })).toHaveAttribute("aria-checked", "false");
    // Pointing at another table previews its views; the open view stays checked where it is.
    await user.click(within(menu).getByRole("menuitemradio", { name: "People" }));
    expect(within(menu).getByRole("menuitemradio", { name: "Everyone" })).toHaveAttribute("href", "/base/app1/tbl2/viw4");
    expect(within(menu).getByRole("group", { name: "Views of People" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "New table" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Add view" })).toBeInTheDocument();
  });

  it("opens the base's dialogs for a new table and a new view", async () => {
    const user = userEvent.setup();
    const onDialog = vi.fn();
    const schema = makeSchema("creator");
    const t = schema.tables[0]!;
    renderBar({ schema, table: t, view: t.views[0]!, config: t.views[0]!.config, role: "creator" }, { onDialog });
    await user.click(screen.getByRole("button", { name: /^Showing the Tasks table/ }));
    await user.click(await screen.findByRole("menuitem", { name: "New table" }));
    expect(onDialog).toHaveBeenCalledWith({ kind: "create-table" });
    await user.click(screen.getByRole("button", { name: /^Showing the Tasks table/ }));
    // By keyboard: jsdom has no layout, so a pointer leaving the submenu's trigger closes it.
    (await screen.findByRole("menuitem", { name: "Add view" })).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: /^Calendar/ })).toBeInTheDocument();
    await user.keyboard("cal{Enter}");
    expect(onDialog).toHaveBeenLastCalledWith({ kind: "create-view", table: t, type: "calendar" });
  });

  it("offers neither to people who cannot make tables or views", async () => {
    const user = userEvent.setup();
    renderBar({}, { onDialog: vi.fn() });
    await user.click(screen.getByRole("button", { name: /^Showing the Tasks table/ }));
    const menu = await screen.findByRole("menu", { name: "Pick a table, then a view" });
    expect(within(menu).queryByRole("menuitem", { name: "New table" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Add view" })).not.toBeInTheDocument();
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
  it("adds a record from the toolbar on a desktop, tinted with the base's colour", async () => {
    const onAdd = vi.fn();
    renderBar({ onAdd });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveTextContent("Add");
    expect(add.closest("[role=toolbar]")).not.toBeNull();
    expect(add).toHaveClass("ob-hue-green", "ob-tint-button");
    expect(add).not.toHaveClass("bg-primary");
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("floats at the bottom corner on a phone", async () => {
    const onAdd = vi.fn();
    renderBar({ onAdd }, { phone: true });
    const add = screen.getByRole("button", { name: "Add record" });
    expect(add).toHaveClass("fixed", "ob-tint-button");
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("is left out when there is no way to add", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Add record" })).not.toBeInTheDocument();
  });
});
