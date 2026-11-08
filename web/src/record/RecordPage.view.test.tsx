/** The record page's view mode: fields are shown rendered and become their editors when clicked. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { Providers, createQueryClient } from "@/providers";
import { CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema, mockApi, stubDesktop } from "@/test/utils";
import { rememberNewRecord } from "./newRecords";
import { RECORD_FOLDS_KEY } from "./useRecordFolds";
import { RecordPage, type RecordPageProps } from "./RecordPage";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const empty = field("text", { multiline: false }, { id: "fld_empty", name: "Nickname" });
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const tags = field("multiple_select", { choices: CHOICES }, { id: "fld_tags", name: "Tags" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fld_done", name: "Done" });
const notes = field("rich_text", {}, { id: "fld_notes", name: "Notes" });
const plain = field("text", { multiline: true }, { id: "fld_plain", name: "Plain notes" });
const stamp = field("created_time", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }, { id: "fld_stamp", name: "Created" });
const budget = field("currency", { precision: 2, symbol: "$", allow_negative: true }, { id: "fld_budget", name: "Budget" });
const table = makeTable([name, company, empty, status, tags, done, notes, plain, stamp, budget]);
const schema = { ...makeSchema("owner"), tables: [table] };
const record = makeRecord({ fld_name: "Launch", fld_company: "Acme", fld_status: "chs2", fld_notes: "See the [docs](https://example.com/docs) first.", fld_plain: "line one", fld_stamp: 1_700_000_000_000 }, "rec1");

const PATCH = "PATCH /api/tables/tbl1/records";

function setup(over: Partial<RecordPageProps> = {}, routes: Record<string, unknown> = {}, folded = false) {
  stubDesktop();
  // Properties with nothing in them are folded away; most of these tests are about editing them, so they start unfolded.
  if (!folded) localStorage.setItem(RECORD_FOLDS_KEY, JSON.stringify({ tbl1: { empty: true } }));
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
  const props: RecordPageProps = {
    schema,
    table,
    role: "owner",
    recordId: "rec1",
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    collectionHref: "/base/app1/tbl1/viw1",
    onOpenLinked: vi.fn(),
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    ...over,
  };
  render(
    <Providers client={createQueryClient()}>
      <MemoryRouter>
        <RecordPage {...props} />
      </MemoryRouter>
    </Providers>,
  );
  return { api, props };
}

const area = (field: string) => screen.findByRole("button", { name: `Edit ${field}` });
const row = (name: string) => within(screen.getByRole("region", { name: "Properties" })).getByText(name, { selector: "dt *" }).closest("dt")!.parentElement as HTMLElement;

describe("RecordPage: view mode", () => {
  it("shows each value rendered, not as an input, and an Empty placeholder where there is none", async () => {
    setup();
    await area("Company");
    // Every value is text; the one box on the page is the title.
    expect(screen.getAllByRole("textbox").map((t) => t.getAttribute("aria-label"))).toEqual(["Name"]);
    expect(within(row("Company")).getByText("Acme")).toBeInTheDocument();
    // Pills, formatted dates and rendered Markdown, as in the views.
    expect(within(row("Status")).getByText("In progress").closest(".choice")).toHaveClass("rounded-pill");
    expect(within(row("Notes")).getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(within(row("Plain notes")).getByText("line one")).toBeInTheDocument();
    expect(within(row("Nickname")).getByText("Empty")).toHaveClass("text-faint");
    expect(within(row("Tags")).getByText("Empty")).toBeInTheDocument();
    // The placeholder is the descriptive text of its button, which is named after the field.
    expect(screen.getByRole("button", { name: "Edit Nickname" })).toHaveAccessibleDescription("Empty");
    expect(screen.getByRole("button", { name: "Edit Company" })).toHaveAccessibleDescription("Acme");
  });

  it("tints editable values under the pointer, and nothing else", async () => {
    setup();
    const name = await area("Company");
    expect(name).toHaveClass("hover:bg-hover", "cursor-text", "min-h-8", "pointer-coarse:min-h-11");
    expect(name).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Edit Status" })).toHaveClass("cursor-pointer");
    // A computed field has no button, no tint.
    expect(within(row("Created")).queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(row("Created").querySelector("dd")!.innerHTML).not.toContain("hover:bg-hover");
  });

  it("clicking a value replaces it with its editor, focused with the caret at the end", async () => {
    setup();
    await userEvent.click(await area("Company"));
    const input = await screen.findByRole("textbox", { name: "Company" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Acme");
    expect((input as HTMLInputElement).selectionStart).toBe(4);
    expect(screen.queryByRole("button", { name: "Edit Company" })).not.toBeInTheDocument();
  });

  it("enters the edit from the keyboard with Enter or Space", async () => {
    setup();
    (await area("Company")).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("textbox", { name: "Company" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    const back = await area("Company");
    expect(back).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(await screen.findByRole("textbox", { name: "Company" })).toHaveFocus();
  });

  it("commits when focus leaves and shows the new value", async () => {
    const { api } = setup();
    await userEvent.click(await area("Company"));
    const input = await screen.findByRole("textbox", { name: "Company" });
    await userEvent.clear(input);
    await userEvent.type(input, "Ship it");
    await userEvent.tab();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Company" })).not.toBeInTheDocument());
    expect(within(row("Company")).getByText("Ship it")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_company: "Ship it" } }] });
  });

  it("commits when another field is clicked, and that one starts its edit", async () => {
    const { api } = setup();
    await userEvent.click(await area("Company"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Company" }), "!");
    await userEvent.click(screen.getByRole("button", { name: "Edit Plain notes" }));
    expect(await screen.findByRole("textbox", { name: "Plain notes" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Company" })).not.toBeInTheDocument();
    expect(within(row("Company")).getByText("Acme!")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
  });

  it("a menu of another field is not this field's: clicking a select while typing ends the typing and opens the menu", async () => {
    const { api } = setup();
    await userEvent.click(await area("Company"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Company" }), "!");
    await userEvent.click(screen.getByRole("button", { name: "Edit Status" }));
    await screen.findByRole("listbox", { name: "Status" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Company" })).not.toBeInTheDocument());
    expect(within(row("Company")).getByText("Acme!")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    // Clicking from the open menu to another value closes the menu and starts that edit.
    await userEvent.click(screen.getByRole("button", { name: "Edit Plain notes" }));
    expect(await screen.findByRole("textbox", { name: "Plain notes" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Status" })).toBeInTheDocument();
  });

  it("Escape cancels an uncommitted single-line change and returns to the old value, leaving the record open", async () => {
    const { api, props } = setup();
    await userEvent.click(await area("Company"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Company" }), " changed");
    await userEvent.keyboard("{Escape}");
    expect(await area("Company")).toHaveFocus();
    expect(within(row("Company")).getByText("Acme")).toBeInTheDocument();
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

  it("opens a link in rendered multiline text without starting an edit", async () => {
    setup();
    await area("Notes");
    const link = within(row("Notes")).getByRole("link", { name: "docs" });
    // jsdom does not navigate; the click must simply not be taken for a click on the value.
    link.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(link);
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(row("Notes")).queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Notes" })).toBeInTheDocument();
    // The text around the link does start one.
    await userEvent.click(within(row("Notes")).getByText(/first\./));
    expect(await within(row("Notes")).findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  });

  it("leaves the rich text editor on blur, back to the rendered text", async () => {
    setup();
    await userEvent.click(await area("Notes"));
    expect(await within(row("Notes")).findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    await waitFor(() => expect(row("Notes").querySelector(".ProseMirror")).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Edit Company" }));
    await waitFor(() => expect(within(row("Notes")).queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument());
    expect(within(row("Notes")).getByRole("link", { name: "docs" })).toBeInTheDocument();
  });

  it("Escape in multiline text ends the edit, keeps the text and leaves the record open", async () => {
    const { props } = setup();
    // Rich text: the editor gives way to the rendered text.
    await userEvent.click(await area("Notes"));
    await waitFor(() => expect(row("Notes").querySelector(".ProseMirror")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(row("Notes")).queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument());
    expect(await area("Notes")).toHaveFocus();
    expect(within(row("Notes")).getByRole("link", { name: "docs" })).toBeInTheDocument();
    // Multiline text: the same, and what was typed stays.
    await userEvent.click(await area("Plain notes"));
    await userEvent.type(await screen.findByRole("textbox", { name: "Plain notes" }), " and two");
    await userEvent.keyboard("{Escape}");
    expect(await area("Plain notes")).toHaveFocus();
    expect(within(row("Plain notes")).getByText(/line one and two/)).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("keeps a value only as tall as what it shows, whatever its editor's size", async () => {
    setup();
    for (const f of ["Notes", "Plain notes", "Nickname"]) {
      const cls = (await area(f)).className;
      expect(cls).toContain("min-h-8");
      expect(cls).not.toMatch(/min-h-\[/);
    }
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
    await userEvent.click(await area("Company"));
    const input = await screen.findByRole("textbox", { name: "Company" });
    await userEvent.clear(input);
    await userEvent.type(input, "Lost?");
    await userEvent.tab();
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    expect(within(row("Company")).getByText("Lost?")).toBeInTheDocument();
    expect(within(row("Company")).getByRole("alert")).toHaveTextContent(/disk full/);
    // Clicking again offers the text that was typed.
    await userEvent.click(screen.getByRole("button", { name: "Edit Company" }));
    expect(await screen.findByRole("textbox", { name: "Company" })).toHaveValue("Lost?");
  });

  it("starts the title of a record just added focused, with the other properties read as usual", async () => {
    // Records added from a collection screen are noted as new until their page has been left.
    rememberNewRecord("rec1", {});
    setup();
    const input = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("button", { name: "Edit Status" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Plain notes" })).not.toBeInTheDocument();
  });

});
