import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Comment, HistoryEntry } from "@/api/types";
import { MemoryRouter } from "react-router";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { makeSchema, mockApi, stubDesktop, stubPhone } from "@/test/utils";
import { RecordPage, type RecordPageProps } from "./RecordPage";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const budget = field("currency", { precision: 2, symbol: "$", allow_negative: true }, { id: "fld_budget", name: "Budget" });
const owner = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_owner", name: "Owner" });
const secret = field("text", { multiline: false }, { id: "fld_secret", name: "Secret" });
const score = { ...ALL_FIELDS.formula, id: "fld_score", name: "Score" };
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const table = makeTable([name, status, budget, owner, secret, score, company]);
const schema = { ...makeSchema("owner"), tables: [table] };
const record = makeRecord({ fld_name: "Launch", fld_status: "chs2", fld_budget: 1200, fld_owner: [{ id: "recA", name: "Alpha" }], fld_score: 24, fld_secret: "hush", fld_company: "Acme" }, "rec1");
const layoutView = { ...schema.tables[0]!.views[0]!, config: { ...schema.tables[0]!.views[0]!.config, hidden_fields: ["fld_secret"] } };

const comments: Comment[] = [
  { id: "cmt1", record_id: "rec1", user_id: "usr2", user_name: "Grace Hopper", body: "Looks good @[Ada Lovelace](usr1)", created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 },
  { id: "cmt2", record_id: "rec1", user_id: "usr1", user_name: "Ada Lovelace", body: "**Thanks!**", created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
];

const history: HistoryEntry[] = [
  { id: 2, user_id: "usr1", user_name: "Ada Lovelace", kind: "update", created_at: 1_700_000_300_000, changes: { fld_budget: { old: 1000, new: 1200 }, fld_status: { old: "chs1", new: "chs2" }, fld_owner: { old: [], new: [{ id: "recA", name: "Alpha" }] }, fld_gone: { old: "x", new: "y" } } },
  { id: 1, user_id: "usr1", user_name: "Ada Lovelace", kind: "create", created_at: 1_700_000_000_000, changes: { fld_name: { old: null, new: "Launch" } } },
];

function setup(over: Partial<RecordPageProps> = {}, routes: Record<string, unknown> = {}, phone = false) {
  if (phone) stubPhone();
  else stubDesktop();
  let current = record;
  const api = mockApi({
    "GET /api/tables/tbl1/records/rec1": () => current,
    "GET /api/records/rec1/comments": comments,
    "GET /api/records/rec1/history": history,
    "PATCH /api/tables/tbl1/records": (call: { body: unknown }) => {
      current = { ...current, values: { ...current.values, ...((call.body as { records: { values: object }[] }).records[0]!.values) } };
      return { records: [current] };
    },
    "POST /api/records/rec1/comments": (call: { body: unknown }) => ({ status: 201, json: { id: "cmt3", record_id: "rec1", user_id: "usr1", user_name: "Ada Lovelace", body: (call.body as { body: string }).body, created_at: 1_700_000_500_000, updated_at: 1_700_000_500_000 } }),
    "PATCH /api/comments/cmt2": (call: { body: unknown }) => ({ ...comments[1], body: (call.body as { body: string }).body }),
    "DELETE /api/comments/cmt2": { ok: true },
    ...routes,
  } as never);
  const props: RecordPageProps = {
    schema,
    table,
    role: "owner",
    recordId: "rec1",
    layoutView,
    prevId: "rec0",
    nextId: "rec2",
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

/** A property's row: its name and its value. */
const rowOf = (name: string) => within(screen.getByRole("region", { name: "Properties" })).getByText(name, { selector: "dt *" }).closest("dt")!.parentElement as HTMLElement;

/** The page has loaded its record: the title and the properties are there. */
const ready = () => screen.findByRole("button", { name: "Edit Company" });

/** Starts editing a field: clicks its value and answers the editor's input. */
async function edit(field: string): Promise<HTMLInputElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${field}` }));
  return (await screen.findByRole("textbox", { name: field })) as HTMLInputElement;
}

/** Opens the Comments or History panel from the bar. */
async function openPanel(name: "Comments" | "History") {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) }));
}

describe("RecordPage", () => {
  it("returns to the collection on Escape, and not while something else has use for it", async () => {
    const { props } = setup();
    await ready();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("is a page: a main bar with the breadcrumb back to the collection, and the record's name as its heading", async () => {
    setup();
    await ready();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/base/app1/tbl1/viw1");
    expect(within(crumbs).getByText("Launch")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the properties that have a value, computed ones read-only, empty and hidden ones folded", async () => {
    setup();
    await ready();
    // The title is the primary property, the heading: it is not listed again.
    expect(screen.getByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(screen.queryByText("Name", { selector: "dt *" })).not.toBeInTheDocument();
    // Values are shown rendered, not as inputs.
    expect(within(rowOf("Company")).getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Company" })).not.toBeInTheDocument();
    expect(within(rowOf("Budget")).getByText("$1,200.00")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    const score = rowOf("Score");
    expect(within(score).getByText("24.0")).toBeInTheDocument();
    expect(within(score).getByText(/computed, read-only/)).toBeInTheDocument();
    expect(within(score).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(score).queryByRole("button", { name: "Edit Score" })).not.toBeInTheDocument();
    // The property the default view hides is folded away until asked for.
    expect(screen.queryByText("hush")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 hidden property" }));
    expect(within(rowOf("Secret")).getByText("hush")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide 1 hidden property" })).toHaveAttribute("aria-expanded", "true");
  });

  it("edits a property through the shared editor and sends the wire value with typecast", async () => {
    const { api } = setup();
    await ready();
    const input = await edit("Company");
    await userEvent.clear(input);
    await userEvent.type(input, "Globex{Enter}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_company: "Globex" } }] });
    expect(await within(rowOf("Company")).findByText("Globex")).toBeInTheDocument();
  });

  it("shows a validation message for an unparseable value and does not save", async () => {
    const { api } = setup();
    const input = await edit("Budget");
    await userEvent.clear(input);
    await userEvent.type(input, "lots{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a number/);
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("does not edit a value from a click on its name: that opens the property's menu", async () => {
    setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Budget" }));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Budget" })).not.toBeInTheDocument();
  });

  it("steps to the previous and next record, by button and by Alt+Arrow, and closes", async () => {
    const { props } = setup();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Previous record/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next record/ }));
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, "rec0");
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, "rec2");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(props.onNavigate).toHaveBeenCalledTimes(3);
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables navigation at the ends", async () => {
    setup({ prevId: null, nextId: null });
    await ready();
    expect(screen.getByRole("button", { name: /Previous record/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next record/ })).toBeDisabled();
  });

  it("shows a message when the record cannot be loaded", async () => {
    setup({}, { "GET /api/tables/tbl1/records/rec1": { status: 404, json: { error: { code: "not_found", message: "no such record" } } } });
    expect(await screen.findByText("This record could not be loaded.")).toBeInTheDocument();
  });
});

/** The Tiptap editor behind a rich text box. */
const editorIn = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;

describe("RecordPage: comments", () => {
  it("lists comments with mentions rendered and marks your own", async () => {
    setup();
    await openPanel("Comments");
    expect(await screen.findByText("Looks good")).toBeInTheDocument();
    expect(screen.getByText("@Ada Lovelace")).toHaveClass("ob-mention");
    // Comments are Markdown.
    expect(screen.getByText("Thanks!").tagName).toBe("STRONG");
    expect(screen.getByLabelText("Comment by Grace Hopper")).toBeInTheDocument();
    const mine = screen.getByLabelText("Comment by Ada Lovelace");
    expect(within(mine).getByRole("button", { name: "Edit comment" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Comment by Grace Hopper")).queryByRole("button", { name: "Edit comment" })).not.toBeInTheDocument();
    // Your face is the colour of yours everywhere (the sidebar's too), not a second colour of the base's assignment.
    expect(within(mine).getByRole("img", { name: "Ada Lovelace" })).toHaveClass("bg-primary");
    expect(within(screen.getByLabelText("Comment by Grace Hopper")).getByRole("img", { name: "Grace Hopper" })).not.toHaveClass("bg-primary");
  });

  it("posts a rich text comment with an @mention picked after typing @", async () => {
    const { api } = setup();
    await openPanel("Comments");
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    const editor = editorIn(box);
    act(() => box.focus());
    act(() => {
      editor.commands.insertContent("Ping @gra");
    });
    const options = await screen.findByRole("listbox", { name: "People to mention" });
    expect(within(options).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Grace Hopper")]);
    expect(box).toHaveAttribute("aria-activedescendant", within(options).getByRole("option").id);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("listbox", { name: "People to mention" })).not.toBeInTheDocument();
    expect(box.querySelector(".ob-mention")).toHaveTextContent("@Grace Hopper");
    act(() => {
      editor.commands.insertContent("please review");
    });
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(api.callsTo("POST /api/records/rec1/comments")).toHaveLength(1));
    expect(api.callsTo("POST /api/records/rec1/comments")[0]!.body).toEqual({ body: "Ping @[Grace Hopper](usr2) please review" });
    await waitFor(() => expect(box).toHaveTextContent(""));
  });

  it("closes the people list on Escape and keeps the page", async () => {
    const { props } = setup();
    await openPanel("Comments");
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    act(() => box.focus());
    act(() => {
      editorIn(box).commands.insertContent("@gr");
    });
    expect(await screen.findByRole("listbox", { name: "People to mention" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "People to mention" })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(box).toHaveTextContent("@gr");
    // In the comment box Escape is the box's own: leaving the page is for when focus is on the page.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("sends with Ctrl+Enter", async () => {
    const { api } = setup();
    await openPanel("Comments");
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    act(() => box.focus());
    act(() => {
      editorIn(box).commands.insertContent("Done");
    });
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.callsTo("POST /api/records/rec1/comments")).toHaveLength(1));
    expect(api.callsTo("POST /api/records/rec1/comments")[0]!.body).toEqual({ body: "Done" });
  });

  it("edits and deletes your own comment", async () => {
    const { api } = setup();
    await openPanel("Comments");
    const mine = await screen.findByLabelText("Comment by Ada Lovelace");
    await userEvent.click(within(mine).getByRole("button", { name: "Edit comment" }));
    const box = await within(mine).findByRole("textbox", { name: "Edit comment" });
    act(() => {
      editorIn(box).commands.setContent("Thanks a lot", { emitUpdate: true });
    });
    await userEvent.click(within(mine).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/comments/cmt2")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/comments/cmt2")[0]!.body).toEqual({ body: "Thanks a lot" });

    await userEvent.click(within(await screen.findByLabelText("Comment by Ada Lovelace")).getByRole("button", { name: "Delete comment" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/comments/cmt2")).toHaveLength(1));
  });

  it("does not post an empty comment", async () => {
    setup();
    await openPanel("Comments");
    await screen.findByRole("textbox", { name: "Write a comment" });
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });
});

describe("RecordPage: history", () => {
  it("renders old -> new per field using display formatting, newest first", async () => {
    setup();
    await openPanel("History");
    const list = await screen.findByRole("list", { name: "Revision history" });
    const entries = within(list).getAllByRole("listitem", {}).filter((li) => li.parentElement === list);
    expect(entries).toHaveLength(2);
    // Newest entry first.
    const changes = within(entries[0]!).getByRole("list", { name: "Changes" });
    const item = (label: string) => within(changes).getByText(label).closest("li")!;
    expect(within(item("Budget")).getByText("$1,000.00")).toBeInTheDocument();
    expect(within(item("Budget")).getByText("$1,200.00")).toBeInTheDocument();
    expect(within(item("Status")).getByText("Todo")).toBeInTheDocument();
    expect(within(item("Status")).getByText("In progress")).toBeInTheDocument();
    expect(within(item("Owner")).getByText("Alpha")).toBeInTheDocument();
    expect(within(item("Owner")).getByText("(empty)")).toBeInTheDocument();
    expect(within(item("(deleted property)")).getByText("y")).toBeInTheDocument();
    expect(within(entries[1]!).getByText("Created this record")).toBeInTheDocument();
    expect(within(entries[1]!).getByText("Launch")).toBeInTheDocument();
  });

  it("explains an empty history", async () => {
    setup({}, { "GET /api/records/rec1/history": [] });
    await openPanel("History");
    expect(await screen.findByText("No changes recorded yet.")).toBeInTheDocument();
  });
});
