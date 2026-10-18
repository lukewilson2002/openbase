/** The expanded record's view mode: fields are shown rendered and become their editors when clicked. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema, mockApi } from "@/test/utils";
import { ExpandedRecord, type ExpandedRecordProps } from "./ExpandedRecord";

const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const empty = field("single_line_text", {}, { id: "fld_empty", name: "Nickname" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const tags = field("multiple_select", { choices: CHOICES }, { id: "fld_tags", name: "Tags" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fld_done", name: "Done" });
const notes = field("long_text", { rich: true }, { id: "fld_notes", name: "Notes" });
const plain = field("long_text", { rich: false }, { id: "fld_plain", name: "Plain notes" });
const stamp = field("created_time", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }, { id: "fld_stamp", name: "Created" });
const budget = field("currency", { precision: 2, symbol: "$", allow_negative: true }, { id: "fld_budget", name: "Budget" });
const table = makeTable([name, empty, status, tags, done, notes, plain, stamp, budget]);
const schema = { ...makeSchema("owner"), tables: [table] };
const record = makeRecord({ fld_name: "Launch", fld_status: "chs2", fld_notes: "See the [docs](https://example.com/docs) first.", fld_plain: "line one", fld_stamp: 1_700_000_000_000 }, "rec1");

const PATCH = "PATCH /api/tables/tbl1/records";

function setup(over: Partial<ExpandedRecordProps> = {}, routes: Record<string, unknown> = {}) {
  let current = record;
  const api = mockApi({
    "GET /api/tables/tbl1/records/rec1": () => current,
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec1/history": [],
    [PATCH]: (call: { body: unknown }) => {
      current = { ...current, values: { ...current.values, ...(call.body as { records: { values: object }[] }).records[0]!.values } };
      return { records: [current] };
    },
    ...routes,
  } as never);
  const props: ExpandedRecordProps = {
    schema,
    table,
    role: "owner",
    recordId: "rec1",
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    ...over,
  };
  render(
    <Providers client={createQueryClient()}>
      <ExpandedRecord {...props} />
    </Providers>,
  );
  return { api, props };
}

const area = (field: string) => screen.findByRole("button", { name: `Edit ${field}` });
const row = (field: string) => screen.getByRole("group", { name: field });

describe("ExpandedRecord: view mode", () => {
  it("shows each value rendered, not as an input, and an Empty placeholder where there is none", async () => {
    setup();
    await area("Name");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(row("Name")).getByText("Launch")).toBeInTheDocument();
    // Pills, formatted dates and rendered Markdown, as in the views.
    expect(within(row("Status")).getByText("In progress")).toHaveClass("rounded-full");
    expect(within(row("Notes")).getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(within(row("Plain notes")).getByText("line one")).toBeInTheDocument();
    expect(within(row("Nickname")).getByText("Empty")).toHaveClass("text-faint");
    expect(within(row("Tags")).getByText("Empty")).toBeInTheDocument();
    // The placeholder is the descriptive text of its button, which is named after the field.
    expect(screen.getByRole("button", { name: "Edit Nickname" })).toHaveAccessibleDescription("Empty");
    expect(screen.getByRole("button", { name: "Edit Name" })).toHaveAccessibleDescription("Launch");
  });

  it("tints editable values under the pointer, and nothing else", async () => {
    setup();
    const name = await area("Name");
    expect(name).toHaveClass("hover:bg-hover", "cursor-text", "min-h-8", "pointer-coarse:min-h-11");
    expect(name).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Edit Status" })).toHaveClass("cursor-pointer");
    // A computed field has no button, no tint.
    expect(within(row("Created")).queryByRole("button")).not.toBeInTheDocument();
    expect(row("Created").innerHTML).not.toContain("hover:bg-hover");
  });

  it("clicking a value replaces it with its editor, focused with the caret at the end", async () => {
    setup();
    await userEvent.click(await area("Name"));
    const input = await screen.findByRole("textbox", { name: "Name" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Launch");
    expect((input as HTMLInputElement).selectionStart).toBe(6);
    expect(screen.queryByRole("button", { name: "Edit Name" })).not.toBeInTheDocument();
  });

  it("enters the edit from the keyboard with Enter or Space", async () => {
    setup();
    (await area("Name")).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    const back = await area("Name");
    expect(back).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("commits when focus leaves and shows the new value", async () => {
    const { api } = setup();
    await userEvent.click(await area("Name"));
    const input = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Ship it");
    await userEvent.tab();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument());
    expect(within(row("Name")).getByText("Ship it")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_name: "Ship it" } }] });
  });

  it("commits when another field is clicked, and that one starts its edit", async () => {
    const { api } = setup();
    await userEvent.click(await area("Name"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "!");
    await userEvent.click(screen.getByRole("button", { name: "Edit Plain notes" }));
    expect(await screen.findByRole("textbox", { name: "Plain notes" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(within(row("Name")).getByText("Launch!")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
  });

  it("a menu of another field is not this field's: clicking a select while typing ends the typing and opens the menu", async () => {
    const { api } = setup();
    await userEvent.click(await area("Name"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "!");
    await userEvent.click(screen.getByRole("button", { name: "Edit Status" }));
    await screen.findByRole("listbox", { name: "Status" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument());
    expect(within(row("Name")).getByText("Launch!")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    // Clicking from the open menu to another value closes the menu and starts that edit.
    await userEvent.click(screen.getByRole("button", { name: "Edit Plain notes" }));
    expect(await screen.findByRole("textbox", { name: "Plain notes" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Status" })).toBeInTheDocument();
  });

  it("Escape cancels an uncommitted single-line change and returns to the old value, leaving the record open", async () => {
    const { api, props } = setup();
    await userEvent.click(await area("Name"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), " changed");
    await userEvent.keyboard("{Escape}");
    expect(await area("Name")).toHaveFocus();
    expect(within(row("Name")).getByText("Launch")).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.callsTo(PATCH)).toHaveLength(0);
    // The next Escape is the record's.
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open to be corrected when the text does not parse, and Escape gives it up", async () => {
    const { api } = setup();
    await userEvent.click(await area("Budget"));
    const input = await screen.findByRole("textbox", { name: "Budget" });
    await userEvent.type(input, "lots");
    await userEvent.tab();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole("textbox", { name: "Budget" })).toBeInTheDocument();
    expect(api.callsTo(PATCH)).toHaveLength(0);
    await userEvent.click(screen.getByRole("textbox", { name: "Budget" }));
    await userEvent.keyboard("{Escape}");
    expect(await area("Budget")).toBeInTheDocument();
    expect(within(row("Budget")).getByText("Empty")).toBeInTheDocument();
  });

  it("toggles a checkbox with one click, no edit step", async () => {
    const { api } = setup();
    const box = await screen.findByRole("checkbox", { name: /Done/ });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_done: true } }] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Done/ })).toBeChecked());
    expect(screen.queryByRole("button", { name: "Edit Done" })).not.toBeInTheDocument();
  });

  it("opens a link in rendered long text without starting an edit", async () => {
    setup();
    const link = within(await screen.findByRole("group", { name: "Notes" })).getByRole("link", { name: "docs" });
    // jsdom does not navigate; the click must simply not be taken for a click on the value.
    link.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(link);
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Notes" })).toBeInTheDocument();
    // The text around the link does start one.
    await userEvent.click(within(row("Notes")).getByText(/first\./));
    expect(await screen.findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  });

  it("leaves the rich text editor on blur, back to the rendered text", async () => {
    setup();
    await userEvent.click(await area("Notes"));
    expect(await screen.findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".ProseMirror")).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Edit Name" }));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument());
    expect(within(row("Notes")).getByRole("link", { name: "docs" })).toBeInTheDocument();
  });

  it("opens a select's menu straight away, and the menu opening is not the field being left", async () => {
    const { api } = setup();
    await userEvent.click(await area("Status"));
    const list = await screen.findByRole("listbox", { name: "Status" });
    // Focus has moved into the menu (in a portal); give a blur check every chance to end the edit wrongly.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole("listbox", { name: "Status" })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Edit Status" })).toHaveFocus();
    expect(within(row("Status")).getByText("Done")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_status: "chs3" } }] });
  });

  it("closes a menu with Escape back to the value, saving nothing", async () => {
    const { api, props } = setup();
    await userEvent.click(await area("Status"));
    await screen.findByRole("listbox", { name: "Status" });
    await userEvent.keyboard("{Escape}");
    expect(await area("Status")).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(api.callsTo(PATCH)).toHaveLength(0);
  });

  it("saves a multiple select picked in its menu when the menu closes", async () => {
    const { api } = setup();
    await userEvent.click(await area("Tags"));
    const list = await screen.findByRole("listbox", { name: "Tags" });
    await userEvent.click(within(list).getByRole("button", { name: "Todo" }));
    await userEvent.click(within(list).getByRole("button", { name: "Done" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_tags: ["chs1", "chs3"] } }] });
    expect(await screen.findByRole("button", { name: "Edit Tags" })).toBeInTheDocument();
  });

  it("keeps what could not be saved on screen with its error", async () => {
    setup({}, { [PATCH]: apiError(500, "internal", "disk full") });
    await userEvent.click(await area("Name"));
    const input = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Lost?");
    await userEvent.tab();
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    expect(within(row("Name")).getByText("Lost?")).toBeInTheDocument();
    expect(within(row("Name")).getByRole("alert")).toHaveTextContent(/disk full/);
    // Clicking again offers the text that was typed.
    await userEvent.click(screen.getByRole("button", { name: "Edit Name" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Lost?");
  });

  it("starts the primary field of a record just added in edit mode, focused", async () => {
    setup({ justCreated: true });
    const input = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(input).toHaveFocus());
    // The other fields are read as usual.
    expect(screen.getByRole("button", { name: "Edit Status" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Plain notes" })).not.toBeInTheDocument();
  });

  it("gives viewers the plain values: no button, no tint, no checkbox to toggle", async () => {
    setup({ role: "viewer" });
    await screen.findByRole("heading", { name: "Launch" });
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(row("Name")).getByText("Launch").closest("[class*='hover:bg-hover']")).toBeNull();
  });
});
