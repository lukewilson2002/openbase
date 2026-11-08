import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Condition, Field, Filter, ViewConfig } from "@/api/types";
import { ALL_FIELDS, CHOICES, field, makeTable } from "@/test/fields";
import { USER, makeSchema, makeView, mockApi, renderWithProviders, stubDesktop, stubPhone } from "@/test/utils";
import { ViewFilterBar } from "./ViewFilterBar";

const name = { ...ALL_FIELDS.text, id: "fld_name", name: "Name" } as Field;
const status = { ...ALL_FIELDS.single_select, id: "fld_status", name: "Status" } as Field;
const amount = { ...ALL_FIELDS.number, id: "fld_amount", name: "Amount" } as Field;
const due = field("date", { include_time: false, date_format: "us", time_format: "h12", timezone: null }, { id: "fld_due", name: "Next follow-up" });
const notes = { ...ALL_FIELDS.rich_text, id: "fld_notes", name: "Notes" } as Field;
const page = { ...ALL_FIELDS.rich_text, id: "fld_page", name: "Page" } as Field;
const table = makeTable([name, status, amount, due, notes, page], { body_field_id: "fld_page" });

const and = (...items: Filter["items"]): Filter => ({ conjunction: "and", items });
const is = (field_id: string, value: unknown, op: Condition["op"] = "is"): Condition => ({ field_id, op, value: value as Condition["value"] });

interface Spy {
  config: () => ViewConfig;
  search: () => string;
}

/** The bar over a config it changes itself, as a view's draft does, so a test reads what the bar did to the filter. */
function renderBar({ filter = null, phone = false, search = "", trailing }: { filter?: Filter | null; phone?: boolean; search?: string; trailing?: React.ReactNode } = {}): Spy & { user: ReturnType<typeof userEvent.setup> } {
  if (phone) stubPhone();
  else stubDesktop();
  mockApi({ "GET /api/auth/me": USER });
  const view = makeView({ id: "viw1" });
  let current: ViewConfig = { ...view.config, filter };
  let searched = search;
  function Harness() {
    const [config, setConfig] = useState(current);
    const [text, setText] = useState(search);
    current = config;
    searched = text;
    return (
      <ViewFilterBar
        schema={makeSchema("editor")}
        table={table}
        config={config}
        update={(mutate) => setConfig((c) => mutate(c))}
        collaborators={[{ id: "usr2", name: "Grace Hopper", email: "grace@example.com" }]}
        currentUserId="usr1"
        search={text}
        onSearchChange={setText}
        timeZone="UTC"
        trailing={trailing}
      />
    );
  }
  renderWithProviders(<Harness />);
  return { user: userEvent.setup(), config: () => current, search: () => searched };
}

const field_ = () => screen.getByRole("combobox", { name: "Filter or search" });
const done = CHOICES[2]!;

describe("ViewFilterBar chips", () => {
  it("shows each condition of a filter as a chip in words", () => {
    renderBar({ filter: and(is("fld_status", done.id), is("fld_amount", 500, "gt")) });
    expect(screen.getByText("Status is Done")).toBeInTheDocument();
    expect(screen.getByText("Amount is over 500")).toBeInTheDocument();
  });

  it("shows a filter that uses OR as one Advanced filter chip with its count", () => {
    renderBar({ filter: { conjunction: "or", items: [is("fld_status", done.id), is("fld_amount", 500, "gt"), is("fld_name", "x", "contains")] } });
    expect(screen.getByText("Advanced filter, 3 conditions")).toBeInTheDocument();
    expect(screen.queryByText("Status is Done")).not.toBeInTheDocument();
  });

  it("shows a filter with a group inside as one Advanced filter chip", () => {
    renderBar({ filter: and(is("fld_status", done.id), { conjunction: "or", items: [is("fld_amount", 1), is("fld_amount", 2)] }) });
    expect(screen.getByText("Advanced filter, 3 conditions")).toBeInTheDocument();
  });

  it("removes a chip with its button", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id), is("fld_amount", 500, "gt")) });
    await bar.user.click(screen.getByRole("button", { name: "Remove Status is Done" }));
    expect(bar.config().filter).toEqual(and(is("fld_amount", 500, "gt")));
    await bar.user.click(screen.getByRole("button", { name: "Remove Amount is over 500" }));
    expect(bar.config().filter).toBeNull();
  });

  it("takes the last chip off with Backspace twice", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id), is("fld_amount", 500, "gt")) });
    await bar.user.click(field_());
    await bar.user.keyboard("{Backspace}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id), is("fld_amount", 500, "gt")));
    await bar.user.keyboard("{Backspace}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id)));
  });

  it("removes the whole Advanced filter with its chip", async () => {
    const bar = renderBar({ filter: { conjunction: "or", items: [is("fld_status", done.id), is("fld_amount", 5)] } });
    await bar.user.click(screen.getByRole("button", { name: "Remove Advanced filter, 2 conditions" }));
    expect(bar.config().filter).toBeNull();
  });
});

describe("ViewFilterBar suggestions", () => {
  it("offers the filters the words could mean, then the search, ending with Advanced filter", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "status done");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Status is Done", "Notes contain “status done”", "Search every property for “status done”", "Advanced filter"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    // The property and the value are bold; the operator is not.
    expect(within(options[0]!).getByText("Status").tagName).toBe("STRONG");
    expect(within(options[0]!).getByText("Done").tagName).toBe("STRONG");
  });

  it("offers a long text property's contains between the filters and the search (here it is also the Notes, so Name is the filter)", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "name is dana");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Name is dana", "Notes contain “name is dana”", "Search every property for “name is dana”", "Advanced filter"]);
  });

  it("leaves the Page out: it is a collection's body, not a property to filter on", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "page is x");
    await screen.findAllByRole("option");
    expect(screen.queryByRole("option", { name: /Page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Notes contain/ })).not.toBeInTheDocument();
  });

  it("offers the search alone for words that are no filter", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "blorp");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Search every property for “blorp”", "Advanced filter"]);
  });

  it("applies the highlighted suggestion on Enter as a chip, writing the filter", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "status done{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id)));
    expect(screen.getByText("Status is Done")).toBeInTheDocument();
    expect(field_()).toHaveValue("");
    expect(field_()).toHaveFocus();
  });

  it("combines chips with AND", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.type(field_(), "amount over 500{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id), is("fld_amount", 500, "gt")));
  });

  it("uses the calendar operands for 'this week'", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "next follow-up this week{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_due", { mode: "this_calendar_week" }, "is_within")));
    expect(screen.getByText("Next follow-up is this week")).toBeInTheDocument();
  });

  it("applies a suggestion that is arrowed to", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "name is dana");
    await screen.findAllByRole("option");
    await bar.user.keyboard("{ArrowDown}{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_notes", "name is dana", "contains")));
  });

  it("applies the search suggestion as the view's search, shown as a chip, not as a filter", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "blorp{Enter}");
    expect(bar.search()).toBe("blorp");
    expect(bar.config().filter).toBeNull();
    expect(screen.getByText("Search for “blorp”")).toBeInTheDocument();
  });

  it("clears the search with its chip's button, and takes it back into the field on a click", async () => {
    const bar = renderBar({ search: "blorp" });
    await bar.user.click(screen.getByRole("button", { name: "Search for “blorp”" }));
    expect(bar.search()).toBe("");
    expect(field_()).toHaveValue("blorp");
    await bar.user.keyboard("{Enter}");
    expect(bar.search()).toBe("blorp");
    await bar.user.click(screen.getByRole("button", { name: "Remove Search for “blorp”" }));
    expect(bar.search()).toBe("");
  });

  it("does not add a filter twice", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.type(field_(), "status done{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id)));
  });

  it("keeps an OR filter whole when a chip is added: it becomes one side of the AND", async () => {
    const or: Filter = { conjunction: "or", items: [is("fld_status", done.id), is("fld_amount", 5)] };
    const bar = renderBar({ filter: or });
    await bar.user.type(field_(), "name is dana{Enter}");
    expect(bar.config().filter).toEqual(and(or, is("fld_name", "dana")));
    expect(screen.getByText("Advanced filter, 3 conditions")).toBeInTheDocument();
  });

  it("is a combobox with a listbox, and the highlighted row is the active descendant", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "status done");
    const listbox = await screen.findByRole("listbox", { name: "Suggestions" });
    expect(field_()).toHaveAttribute("aria-controls", listbox.id);
    const first = within(listbox).getAllByRole("option")[0]!;
    expect(field_()).toHaveAttribute("aria-activedescendant", first.id);
    await bar.user.keyboard("{ArrowDown}");
    expect(field_()).toHaveAttribute("aria-activedescendant", within(listbox).getAllByRole("option")[1]!.id);
  });

  it("announces what it did in a polite region", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "status done{Enter}");
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent === "Filter added: Status is Done")).toBe(true));
  });
});

describe("ViewFilterBar chip editor", () => {
  it("opens under the chip with property, operator and value, and Done closes it with focus back on the chip", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    expect(screen.getByRole("combobox", { name: "Field" })).toHaveValue("fld_status");
    expect(screen.getByRole("combobox", { name: "Operator" })).toHaveValue("is");
    await bar.user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Operator" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Status is Done" })).toHaveFocus());
  });

  it("changes the operator, and the chip reads the new filter", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    await bar.user.selectOptions(screen.getByRole("combobox", { name: "Operator" }), "is_not");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id, "is_not")));
    expect(screen.getByRole("button", { name: "Status is not Done" })).toBeInTheDocument();
  });

  it("changes the property, starting that property's filter over", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    await bar.user.selectOptions(screen.getByRole("combobox", { name: "Field" }), "fld_amount");
    expect((bar.config().filter!.items[0] as Condition).field_id).toBe("fld_amount");
  });

  it("edits a value while typing, after a pause, and only that chip's condition", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id), is("fld_name", "dan", "contains")) });
    await bar.user.click(screen.getByRole("button", { name: "Name contains dan" }));
    const value = screen.getByRole("textbox");
    await bar.user.type(value, "a");
    await waitFor(() => expect(bar.config().filter).toEqual(and(is("fld_status", done.id), is("fld_name", "dana", "contains"))));
  });

  it("removes the filter from its editor", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id), is("fld_amount", 5)) });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    await bar.user.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(bar.config().filter).toEqual(and(is("fld_amount", 5)));
  });

  it("closes on Escape and gives focus back to the chip", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    await screen.findByRole("combobox", { name: "Operator" });
    await bar.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Operator" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Status is Done" })).toHaveFocus());
  });
});

describe("ViewFilterBar advanced filter", () => {
  it("opens the nested builder from the bottom of the list, on the whole filter", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)) });
    await bar.user.click(field_());
    await bar.user.click(await screen.findByRole("option", { name: "Advanced filter" }));
    const group = await screen.findByRole("group", { name: "Advanced filter" });
    expect(within(group).getByRole("combobox", { name: "Field" })).toHaveValue("fld_status");
    await bar.user.click(within(group).getByRole("button", { name: "Add condition" }));
    expect(bar.config().filter!.items).toHaveLength(2);
  });

  it("reaches the row with the keys", async () => {
    const bar = renderBar();
    await bar.user.click(field_());
    await bar.user.keyboard("{Enter}");
    expect(await screen.findByRole("group", { name: "Advanced filter" })).toBeInTheDocument();
  });

  it("opens from the Advanced filter chip, and a group made there stays one chip", async () => {
    const or: Filter = { conjunction: "or", items: [is("fld_status", done.id), is("fld_amount", 5)] };
    const bar = renderBar({ filter: or });
    await bar.user.click(screen.getByRole("button", { name: "Advanced filter, 2 conditions" }));
    const group = await screen.findByRole("group", { name: "Advanced filter" });
    expect(within(group).getByRole("combobox", { name: "Match all or any" })).toHaveValue("or");
    await bar.user.click(within(group).getByRole("button", { name: "Add condition" }));
    expect(await screen.findByText("Advanced filter, 3 conditions")).toBeInTheDocument();
  });

  it("closes on Escape with focus back in the field", async () => {
    const bar = renderBar();
    await bar.user.click(field_());
    await bar.user.keyboard("{Enter}");
    await screen.findByRole("group", { name: "Advanced filter" });
    await bar.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Advanced filter" })).not.toBeInTheDocument());
    await waitFor(() => expect(field_()).toHaveFocus());
  });
});

describe("ViewFilterBar shortcuts", () => {
  it("focuses the bar on /", async () => {
    const bar = renderBar();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await bar.user.keyboard("/");
    expect(field_()).toHaveFocus();
    expect(field_()).toHaveValue("");
    outside.remove();
  });

  it("focuses the bar on Ctrl+F and Cmd+F and selects what is in it", async () => {
    const bar = renderBar();
    await bar.user.type(field_(), "abc");
    document.body.focus();
    await bar.user.keyboard("{Control>}f{/Control}");
    expect(field_()).toHaveFocus();
    expect((field_() as HTMLInputElement).selectionStart).toBe(0);
    expect((field_() as HTMLInputElement).selectionEnd).toBe(3);
    document.body.focus();
    await bar.user.keyboard("{Meta>}f{/Meta}");
    expect(field_()).toHaveFocus();
  });

  it("takes the browser's Ctrl+F away, so the page's find does not open", async () => {
    renderBar();
    const down = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("leaves / alone where it is a character: in a text field, a text editor or a dialog", () => {
    renderBar();
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inDialog = document.createElement("button");
    dialog.append(inDialog);
    document.body.append(input, editor, dialog);
    for (const el of [input, editor, inDialog]) {
      el.focus();
      const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      el.dispatchEvent(slash);
      expect(slash.defaultPrevented).toBe(false);
      expect(field_()).not.toHaveFocus();
    }
    input.remove();
    editor.remove();
    dialog.remove();
  });

  it("does not take / with a modifier", async () => {
    renderBar();
    const slash = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
  });
});

describe("ViewFilterBar slot", () => {
  it("leaves View options its place to the right of the bar", () => {
    renderBar({ trailing: <button type="button">View options</button> });
    const row = field_().closest("div.flex.shrink-0")!;
    expect(within(row as HTMLElement).getByRole("button", { name: "View options" })).toBeInTheDocument();
    expect(field_().compareDocumentPosition(screen.getByRole("button", { name: "View options" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("ViewFilterBar on a phone", () => {
  it("opens the suggestions as a panel docked above the keyboard, not a popover", async () => {
    const bar = renderBar({ phone: true });
    await bar.user.type(field_(), "status done");
    const listbox = await screen.findByRole("listbox", { name: "Suggestions" });
    expect(listbox.closest("[data-radix-popper-content-wrapper]")).toBeNull();
    expect(listbox.parentElement).toHaveClass("fixed", "inset-x-0");
    await bar.user.keyboard("{Enter}");
    expect(bar.config().filter).toEqual(and(is("fld_status", done.id)));
  });

  it("takes the first Escape to close the panel and the second to empty the field", async () => {
    const bar = renderBar({ phone: true });
    await bar.user.type(field_(), "status done");
    await screen.findByRole("listbox");
    await bar.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(field_()).toHaveValue("status done");
    await bar.user.keyboard("{Escape}");
    expect(field_()).toHaveValue("");
  });

  it("opens a chip's editor as a sheet titled with the filter", async () => {
    const bar = renderBar({ filter: and(is("fld_status", done.id)), phone: true });
    await bar.user.click(screen.getByRole("button", { name: "Status is Done" }));
    const sheet = await screen.findByRole("dialog", { name: "Status is Done" });
    expect(within(sheet).getByRole("combobox", { name: "Operator" })).toBeInTheDocument();
    // One Done: the sheet's own.
    await bar.user.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the Advanced filter as a sheet", async () => {
    const bar = renderBar({ phone: true });
    await bar.user.click(field_());
    await bar.user.click(await screen.findByRole("option", { name: "Advanced filter" }));
    const sheet = await screen.findByRole("dialog", { name: "Advanced filter" });
    expect(within(sheet).getByRole("group", { name: "Advanced filter" })).toBeInTheDocument();
  });

  it("has a field and rows at least 44 px tall by their classes", async () => {
    const bar = renderBar({ phone: true });
    expect(field_().closest("div.cursor-text")).toHaveClass("max-md:min-h-control-touch");
    await bar.user.type(field_(), "status done");
    const option = (await screen.findAllByRole("option"))[0]!;
    expect(option).toHaveClass("max-md:min-h-control-touch");
  });
});
