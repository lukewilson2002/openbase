import { createRef } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ViewConfig } from "@/api/types";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeSchema, makeView, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { ViewBar, type ViewBarProps } from "./ViewBar";

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/download", async (orig) => ({ ...(await orig<typeof import("@/lib/download")>()), saveBlob }));

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" };
const notes = { ...ALL_FIELDS.rich_text, id: "fld_notes", name: "Notes" };
const table = makeTable([name, notes]);

/** A desktop unless `phone`; jsdom matches no media query, which the toolbar reads as a phone. */
function renderBar(over: Partial<ViewBarProps> = {}, { phone = false }: { phone?: boolean } = {}) {
  if (!phone) stubDesktop();
  const view = over.view ?? makeView({ id: "viw1", name: "All tasks" });
  const props: ViewBarProps = {
    schema: makeSchema("viewer"),
    table,
    view,
    role: "viewer",
    config: view.config,
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
  const { unmount } = renderWithProviders(<ViewBar {...props} />);
  return { ...props, unmount };
}

const withConfig = (patch: Partial<ViewConfig>) => {
  const view = makeView({ id: "viw1", name: "All tasks" });
  const v = { ...view, config: { ...view.config, ...patch } };
  return { view: v, config: v.config };
};

describe("ViewBar: every change is a draft, for everyone", () => {
  it.each(["viewer", "commenter", "editor", "creator"])("as %s: filters, sorts, groups, colors and row height are all there to change", async (role) => {
    const props = renderBar({ role, schema: makeSchema(role) });
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    // No note about permission or about not being saved: the changes bar under the toolbar says it.
    expect(screen.queryByText(/not saved|permission|apply only to you/i)).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add condition" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(props.update).toHaveBeenCalledTimes(1);
  });

  it("lets them sort and group too", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByRole("button", { name: /Add (a )?sort/i })).toBeEnabled();
  });

  it("lets them color records: row colors are a draft the server computes", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(screen.getByRole("group", { name: "Color records" })).toBeEnabled();
    await userEvent.click(screen.getByRole("radio", { name: "By conditions" }));
    expect(props.update).toHaveBeenCalledTimes(1);
  });

  it("has no Not saved marker and no Locked badge: the view tab says locked, the bar says what is a draft", () => {
    renderBar({ view: makeView({ id: "viw1", name: "All tasks", locked: true }) });
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Locked")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Locked view" })).not.toBeInTheDocument();
  });

  it("sets the row height from the toolbar", async () => {
    const props = renderBar({ role: "creator", schema: makeSchema("creator") });
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
    return renderBar({ table: dated, view, config, role: "creator", schema: makeSchema("creator") });
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
    const props = renderBar({ table: four, view, config });
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

  it("has a drag handle on every field but the primary one", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Drag Field 4 to reorder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drag Field 1 to reorder" })).not.toBeInTheDocument();
  });

  it("offers no reordering while the list is filtered by the search box", async () => {
    await open();
    await userEvent.type(screen.getByRole("textbox", { name: "Find a field" }), "Field 3");
    expect(screen.queryByRole("button", { name: /^Move Field/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Drag Field/ })).not.toBeInTheDocument();
  });
});
