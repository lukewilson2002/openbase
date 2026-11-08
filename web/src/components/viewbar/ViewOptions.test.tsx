import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewConfig } from "@/api/types";
import { ALL_FIELDS, makeTable } from "@/test/fields";
import { makeSchema, makeView, mockApi, renderWithProviders, stubDesktop } from "@/test/utils";
import { ViewOptions, forgetViewOptionsHandOver, type ViewOptionsProps } from "./ViewOptions";

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/download", async (orig) => ({ ...(await orig<typeof import("@/lib/download")>()), saveBlob }));

beforeEach(() => forgetViewOptionsHandOver());

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" };
const notes = { ...ALL_FIELDS.rich_text, id: "fld_notes", name: "Notes" };
const table = makeTable([name, notes]);

/** A desktop unless `phone`; jsdom matches no media query, which the control reads as a phone. */
function renderOptions(over: Partial<ViewOptionsProps> = {}, { phone = false }: { phone?: boolean } = {}) {
  if (!phone) stubDesktop();
  const view = over.view ?? makeView({ id: "viw1", name: "All tasks" });
  const props: ViewOptionsProps = {
    schema: makeSchema("viewer"),
    table,
    view,
    role: "viewer",
    config: makeView({ id: "viw1" }).config,
    update: vi.fn(),
    collaborators: [],
    layout: "grid",
    onLayoutChange: vi.fn(),
    ...over,
  };
  const { unmount } = renderWithProviders(<ViewOptions {...props} />);
  return { ...props, unmount };
}

const withConfig = (patch: Partial<ViewConfig>) => ({ ...makeView({ id: "viw1" }).config, ...patch });

async function open(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "View options" }));
  return { user, panel: await screen.findByRole("dialog") };
}

/** The config the last `update` call produces from `config`. */
const applied = (update: ViewOptionsProps["update"], config: ViewConfig) => (vi.mocked(update).mock.calls.at(-1)![0] as (c: ViewConfig) => ViewConfig)(config);

describe("View options: the button and its sections", () => {
  it("is one button named View options, and opens a panel with the sections in order", async () => {
    renderOptions({ role: "creator", schema: makeSchema("creator"), features: { rowHeight: true }, toggles: [{ id: "t", label: "Fold all groups", checked: false, onToggle: vi.fn() }] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const { panel } = await open();
    const headings = within(panel).getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["View options", "Layout", "Row height"]);
    expect(within(panel).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      ...["List", "Grid", "Board", "Calendar", "Gallery", "Timeline", "Form"],
      ...["Sort None", "Group None", "Color None", "Properties 2 shown"],
      ...["Short", "Medium", "Tall", "Extra tall"],
      "Add property",
      "Download CSV",
    ]);
    // The row-height group, the wrap switch and the layout's switches follow the rows.
    expect(within(panel).getAllByRole("switch").map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });

  it("shows the current value on each row", async () => {
    renderOptions({
      config: withConfig({
        sorts: [{ field_id: "fld_name", direction: "desc" }],
        groups: [{ field_id: "fld_name", direction: "asc" }],
        row_color: { mode: "by_conditions", rules: [{ color: "red", filter: { conjunction: "and", items: [] } }] },
        hidden_fields: ["fld_notes"],
      }),
    });
    const { panel } = await open();
    expect(within(panel).getByRole("button", { name: "Sort Name, Z to A" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Group By Name" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Color By conditions" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Properties 1 shown, 1 hidden" })).toBeInTheDocument();
  });

  it("is for everyone: a viewer changes sorts, groups, colors and row height as drafts too", async () => {
    const props = renderOptions({ features: { rowHeight: true } });
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /^Group/ }));
    // No note about permission or about not being saved: the changes bar under the filter bar says it.
    expect(screen.queryByText(/not saved|permission|apply only to you/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add (a )?group/i }));
    expect(props.update).toHaveBeenCalledTimes(1);
  });

  it("leaves out the sections a layout does not have", async () => {
    renderOptions({ features: { group: false, color: false, rowHeight: false, csv: false, addProperty: false }, role: "creator", schema: makeSchema("creator") });
    const { panel } = await open();
    expect(within(panel).queryByRole("button", { name: /^Group/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Color/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("group", { name: "Row height" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Add property" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /^Sort/ })).toBeInTheDocument();
  });

  it("is only the layout for a form", async () => {
    renderOptions({ layout: "form", features: { sort: false, group: false, color: false, properties: false, addProperty: false } });
    const { panel } = await open();
    expect(within(panel).getByRole("button", { name: "Form", pressed: true })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^(Sort|Group|Color|Properties)/ })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  });

  it("keeps nothing in the browser's storage", async () => {
    renderOptions();
    await open();
    expect(localStorage.length).toBe(0);
  });

  it("closes on Escape and gives focus back to the button", async () => {
    renderOptions();
    const { user } = await open();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "View options" })).toHaveFocus();
  });
});

describe("View options: layout", () => {
  it("shows the layout in use as the one pressed tile", async () => {
    renderOptions({ layout: "kanban" });
    const { panel } = await open();
    const group = within(panel).getByRole("group", { name: "Layout" });
    expect(within(group).getAllByRole("button").map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`)).toEqual([
      "List:false",
      "Grid:false",
      "Board:true",
      "Calendar:false",
      "Gallery:false",
      "Timeline:false",
      "Form:false",
    ]);
    expect(within(group).getByRole("button", { name: "Board" })).toHaveClass("border-primary", "bg-primary-soft");
  });

  it("shows four tiles to a row on a desktop and three on a phone", async () => {
    renderOptions();
    const { panel } = await open();
    expect(within(panel).getByRole("group", { name: "Layout" })).toHaveClass("grid-cols-3", "md:grid-cols-4");
  });

  it("switches the layout with one tap, and does nothing for the layout already shown", async () => {
    const props = renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Calendar" }));
    expect(props.onLayoutChange).toHaveBeenCalledExactlyOnceWith("calendar");
    await user.click(within(panel).getByRole("button", { name: "Grid" }));
    expect(props.onLayoutChange).toHaveBeenCalledTimes(1);
  });

  it("opens again, on the new layout, after the layout is switched", async () => {
    const first = renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Calendar" }));
    // The next layout is a new component: its View options starts open where this one left off.
    first.unmount();
    renderOptions({ layout: "calendar" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Calendar", pressed: true })).toBeInTheDocument();
  });

  it("puts the layout's own settings right under the tiles", async () => {
    renderOptions({ layout: "kanban", layoutSettings: <label>Stack by <select /></label> });
    const { panel } = await open();
    const tiles = within(panel).getByRole("group", { name: "Layout" });
    const settings = within(panel).getByLabelText("Stack by");
    const sort = within(panel).getByRole("button", { name: /^Sort/ });
    expect(tiles.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(settings.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hands a layout's settings a way to close the panel (the form's builder)", async () => {
    renderOptions({ layout: "form", layoutSettings: (close) => <button onClick={close}>Open the form builder</button> });
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Open the form builder" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("View options: Sort, Group, Color and Properties screens", () => {
  it("opens a screen in the same panel with a Back button, and Back puts focus on its row", async () => {
    const { update } = renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /^Sort/ }));
    expect(screen.getByRole("heading", { name: "Sort" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Layout" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to View options" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /Add (a )?sort/i }));
    expect(update).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Back to View options" }));
    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sort/ })).toHaveFocus();
  });

  it("starts at the top again when the panel is closed and opened", async () => {
    renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /^Group/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(user);
    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
  });

  it("lets them color records: row colors are a draft the server computes", async () => {
    const props = renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /^Color/ }));
    expect(screen.getByRole("group", { name: "Color records" })).toBeEnabled();
    await user.click(screen.getByRole("radio", { name: "By conditions" }));
    expect(props.update).toHaveBeenCalledTimes(1);
    expect(applied(props.update, props.config).row_color).toMatchObject({ mode: "by_conditions" });
  });

  it("is where the description and card properties sit, under the properties", async () => {
    renderOptions({ propertySettings: <label>Description property <select /></label> });
    const { user, panel } = await open();
    expect(within(panel).queryByLabelText("Description property")).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /^Properties/ }));
    const list = screen.getByRole("textbox", { name: "Find a property" });
    expect(list.compareDocumentPosition(screen.getByLabelText("Description property")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe("grouping by a date", () => {
    const due = { ...ALL_FIELDS.date, id: "fld_due", name: "Due" };
    const created = { ...ALL_FIELDS.created_time, id: "fld_created", name: "Created" };
    const dated = makeTable([name, due, created]);

    async function openGroups(groups: ViewConfig["groups"]) {
      const config = withConfig({ groups });
      const props = renderOptions({ table: dated, config, role: "creator", schema: makeSchema("creator") });
      const { user, panel } = await open();
      await user.click(within(panel).getByRole("button", { name: /^Group/ }));
      return { props, config };
    }

    it("offers day, week, month, quarter and year for a date level only, defaulting to day", async () => {
      await openGroups([
        { field_id: "fld_due", direction: "asc" },
        { field_id: "fld_name", direction: "asc" },
      ]);
      const pick = screen.getByRole("combobox", { name: "Granularity for group 1" });
      expect(pick).toHaveValue("day");
      expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["by day", "by week", "by month", "by quarter", "by year"]);
      expect(screen.queryByRole("combobox", { name: "Granularity for group 2" })).not.toBeInTheDocument();
    });

    it("keeps the chosen granularity on the level", async () => {
      const { props, config } = await openGroups([{ field_id: "fld_created", direction: "desc", granularity: "year" }]);
      const pick = screen.getByRole("combobox", { name: "Granularity for group 1" });
      expect(pick).toHaveValue("year");
      await userEvent.selectOptions(pick, "month");
      expect(applied(props.update, config).groups).toEqual([{ field_id: "fld_created", direction: "desc", granularity: "month" }]);
    });
  });

  describe("Properties: order", () => {
    const f = (n: number) => ({ ...ALL_FIELDS.text, id: `fld_${n}`, name: `Field ${n}` });
    const four = makeTable([f(1), f(2), f(3), f(4)], { primary_field_id: "fld_1" });

    async function openProperties(over: Partial<ViewConfig> = {}) {
      const props = renderOptions({ table: four, config: withConfig(over) });
      const { user, panel } = await open();
      await user.click(within(panel).getByRole("button", { name: /^Properties/ }));
      return { props, user };
    }

    it("moves a property up or down from its row, never above the title property", async () => {
      const { props, user } = await openProperties();
      expect(screen.getByRole("button", { name: "Move Field 2 up" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Move Field 4 down" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Move Field 3 up" }));
      expect(applied(props.update, props.config).field_order).toEqual(["fld_1", "fld_3", "fld_2", "fld_4"]);
      await user.click(screen.getByRole("button", { name: "Move Field 2 down" }));
      expect(applied(props.update, props.config).field_order).toEqual(["fld_1", "fld_3", "fld_2", "fld_4"]);
    });

    it("has a drag handle on every property but the title", async () => {
      await openProperties();
      expect(screen.getByRole("button", { name: "Drag Field 4 to reorder" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Drag Field 1 to reorder" })).not.toBeInTheDocument();
    });

    it("offers no reordering while the list is filtered by the search box", async () => {
      const { user } = await openProperties();
      await user.type(screen.getByRole("textbox", { name: "Find a property" }), "Field 3");
      expect(screen.queryByRole("button", { name: /^Move Field/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Drag Field/ })).not.toBeInTheDocument();
    });

    it("hides and shows a property with its switch, and all of them at once", async () => {
      const { props, user } = await openProperties();
      await user.click(screen.getByRole("switch", { name: "Field 2" }));
      expect(applied(props.update, props.config).hidden_fields).toEqual(["fld_2"]);
      expect(screen.getByRole("switch", { name: "Field 1" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Hide all" }));
      expect(applied(props.update, props.config).hidden_fields).toEqual(["fld_2", "fld_3", "fld_4"]);
      await user.click(screen.getByRole("button", { name: "Show all" }));
      expect(applied(props.update, props.config).hidden_fields).toEqual([]);
    });
  });
});

describe("View options: row height and wrapped headers (a grid's)", () => {
  it("sets the row height from four choices, the current one pressed", async () => {
    const props = renderOptions({ role: "creator", schema: makeSchema("creator"), features: { rowHeight: true }, config: withConfig({ row_height: "tall" }) });
    const { user, panel } = await open();
    const group = within(panel).getByRole("group", { name: "Row height" });
    expect(within(group).getAllByRole("button").map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`)).toEqual(["Short:false", "Medium:false", "Tall:true", "Extra tall:false"]);
    await user.click(within(group).getByRole("button", { name: "Extra tall" }));
    expect(applied(props.update, props.config).row_height).toBe("extra_tall");
  });

  it("turns Wrap headers on and off", async () => {
    const props = renderOptions({ features: { rowHeight: true } });
    const { user, panel } = await open();
    const wrap = within(panel).getByRole("switch", { name: "Wrap headers" });
    expect(wrap).toHaveAttribute("aria-checked", "false");
    await user.click(wrap);
    expect(applied(props.update, props.config).wrap_headers).toBe(true);
  });

  it("is left out of the other layouts", async () => {
    renderOptions();
    const { panel } = await open();
    expect(within(panel).queryByRole("switch", { name: "Wrap headers" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("group", { name: "Row height" })).not.toBeInTheDocument();
  });
});

describe("View options: footer", () => {
  it("lists the layout's switches, checked or not, and flips them", async () => {
    const onToggle = vi.fn();
    renderOptions({ toggles: [{ id: "hide", label: "Hide empty stacks", checked: true, onToggle }] });
    const { user, panel } = await open();
    const item = within(panel).getByRole("switch", { name: "Hide empty stacks" });
    expect(item).toHaveAttribute("aria-checked", "true");
    await user.click(item);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("shows a switch that cannot be used as disabled", async () => {
    renderOptions({ toggles: [{ id: "x", label: "Hide empty stacks", checked: false, disabled: true, onToggle: vi.fn() }] });
    const { panel } = await open();
    expect(within(panel).getByRole("switch", { name: "Hide empty stacks" })).toBeDisabled();
  });

  it("downloads the view as CSV for everyone who can see it, and closes", async () => {
    const api = mockApi({ "GET /api/views/viw1/export.csv": { text: "Name\n", headers: { "Content-Type": "text/csv" } } });
    renderOptions();
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(api.callsTo("GET /api/views/viw1/export.csv")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers no Add property to an editor", async () => {
    renderOptions({ role: "editor", schema: makeSchema("editor") });
    const { panel } = await open();
    expect(within(panel).queryByRole("button", { name: "Add property" })).not.toBeInTheDocument();
  });

  it("offers Add property to a creator, and opens the new property dialog", async () => {
    mockApi({});
    renderOptions({ role: "creator", schema: makeSchema("creator") });
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Add property" }));
    expect(await screen.findByRole("dialog", { name: "Add a field" })).toBeInTheDocument();
    // The options panel made way for it.
    expect(screen.queryByRole("group", { name: "Layout" })).not.toBeInTheDocument();
  });

  it("has no Share view of its own: sharing a view is in the Share dialog and the view's menu", async () => {
    renderOptions({ role: "creator", schema: makeSchema("creator") });
    const { panel } = await open();
    expect(within(panel).queryByRole("button", { name: /Share/ })).not.toBeInTheDocument();
  });
});

describe("View options on a phone", () => {
  it("opens as a sheet with a Done button, and the layout tiles", async () => {
    renderOptions({}, { phone: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View options" }));
    const sheet = await screen.findByRole("dialog", { name: "View options" });
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Grid", pressed: true })).toBeInTheDocument();
    expect(within(sheet).getByRole("group", { name: "Layout" })).toHaveClass("grid-cols-3");
  });

  it("is an icon button, 44 px, named View options", () => {
    renderOptions({}, { phone: true });
    const button = screen.getByRole("button", { name: "View options" });
    expect(button).toHaveTextContent("");
    expect(button).toHaveClass("max-md:size-control-touch");
  });

  it("opens Sort in the sheet, with Back", async () => {
    const props = renderOptions({}, { phone: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "View options" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Sort/ }));
    await user.click(within(sheet).getByRole("button", { name: /Add (a )?sort/i }));
    expect(props.update).toHaveBeenCalledTimes(1);
    await user.click(within(sheet).getByRole("button", { name: "Back to View options" }));
    expect(within(sheet).getByRole("group", { name: "Layout" })).toBeInTheDocument();
  });
});
