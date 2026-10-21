import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Comment, HistoryEntry } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { makeSchema, mockApi } from "@/test/utils";
import { ExpandedRecord, type ExpandedRecordProps } from "./ExpandedRecord";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const budget = field("currency", { precision: 2, symbol: "$", allow_negative: true }, { id: "fld_budget", name: "Budget" });
const owner = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_owner", name: "Owner" });
const secret = field("text", { multiline: false }, { id: "fld_secret", name: "Secret" });
const score = { ...ALL_FIELDS.formula, id: "fld_score", name: "Score" };
const table = makeTable([name, status, budget, owner, secret, score]);
const schema = { ...makeSchema("owner"), tables: [table] };
const record = makeRecord({ fld_name: "Launch", fld_status: "chs2", fld_budget: 1200, fld_owner: [{ id: "recA", name: "Alpha" }], fld_score: 24, fld_secret: "hush" }, "rec1");
const config = { ...schema.tables[0]!.views[0]!.config, hidden_fields: ["fld_secret"] };

const comments: Comment[] = [
  { id: "cmt1", record_id: "rec1", user_id: "usr2", user_name: "Grace Hopper", body: "Looks good @[Ada Lovelace](usr1)", created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 },
  { id: "cmt2", record_id: "rec1", user_id: "usr1", user_name: "Ada Lovelace", body: "**Thanks!**", created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
];

const history: HistoryEntry[] = [
  { id: 2, user_id: "usr1", user_name: "Ada Lovelace", kind: "update", created_at: 1_700_000_300_000, changes: { fld_budget: { old: 1000, new: 1200 }, fld_status: { old: "chs1", new: "chs2" }, fld_owner: { old: [], new: [{ id: "recA", name: "Alpha" }] }, fld_gone: { old: "x", new: "y" } } },
  { id: 1, user_id: "usr1", user_name: "Ada Lovelace", kind: "create", created_at: 1_700_000_000_000, changes: { fld_name: { old: null, new: "Launch" } } },
];

function setup(over: Partial<ExpandedRecordProps> = {}, routes: Record<string, unknown> = {}) {
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
  const props: ExpandedRecordProps = {
    schema,
    table,
    role: "owner",
    recordId: "rec1",
    config,
    prevId: "rec0",
    nextId: "rec2",
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

/** Starts editing a field: clicks its value and answers the editor's input. */
async function edit(field: string): Promise<HTMLInputElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${field}` }));
  return (await screen.findByRole("textbox", { name: field })) as HTMLInputElement;
}

describe("ExpandedRecord", () => {
  it("opens with the dialog itself focused (not a button whose tooltip would swallow the first Escape) and closes on Escape", async () => {
    const { props } = setup();
    await screen.findByRole("button", { name: "Edit Name" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows every field with its value, computed ones read-only, hidden ones collapsed", async () => {
    setup();
    const nameRow = await screen.findByRole("group", { name: "Name" });
    // Values are shown rendered, not as inputs.
    expect(within(nameRow).getByText("Launch")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Launch")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Budget" })).getByText("$1,200.00")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    const scoreRow = screen.getByRole("group", { name: "Score" });
    expect(within(scoreRow).getByText("24.0")).toBeInTheDocument();
    expect(within(scoreRow).getByText(/computed, read-only/)).toBeInTheDocument();
    expect(within(scoreRow).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(scoreRow).queryByRole("button")).not.toBeInTheDocument();
    // Hidden fields live in a collapsible section.
    expect(screen.queryByText("hush")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show 1 hidden field/ }));
    expect(within(screen.getByRole("group", { name: "Secret" })).getByText("hush")).toBeInTheDocument();
  });

  it("edits a field through the shared editor and sends the wire value with typecast", async () => {
    const { api } = setup();
    const input = await edit("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Ship it{Enter}");
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_name: "Ship it" } }] });
    expect(await screen.findByRole("heading", { name: "Ship it" })).toBeInTheDocument();
  });

  it("shows a validation message for an unparseable value and does not save", async () => {
    const { api } = setup();
    const input = await edit("Budget");
    await userEvent.clear(input);
    await userEvent.type(input, "lots{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a number/);
    expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("edits a field from a click on its name, as a form's label does", async () => {
    setup();
    await screen.findByRole("button", { name: "Edit Budget" });
    await userEvent.click(screen.getByRole("heading", { name: "Budget" }));
    expect(await screen.findByRole("textbox", { name: "Budget" })).toBeInTheDocument();
  });

  it("navigates between records and closes", async () => {
    const { props } = setup();
    await screen.findByRole("button", { name: "Edit Name" });
    await userEvent.click(screen.getByRole("button", { name: /Previous record/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next record/ }));
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, "rec0");
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, "rec2");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(props.onNavigate).toHaveBeenCalledTimes(3);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables navigation at the ends", async () => {
    setup({ prevId: null, nextId: null });
    await screen.findByRole("button", { name: "Edit Name" });
    expect(screen.getByRole("button", { name: /Previous record/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next record/ })).toBeDisabled();
  });

  it("viewers see values but no editors and cannot comment", async () => {
    setup({ role: "viewer" });
    await screen.findByRole("heading", { name: "Launch" });
    expect(screen.queryByDisplayValue("Launch")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    // A viewer's values are plain text: nothing to click, no hover tint, no button.
    const nameRow = screen.getByRole("group", { name: "Name" });
    expect(within(nameRow).getByText("Launch")).toBeInTheDocument();
    expect(within(nameRow).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(nameRow.innerHTML).not.toContain("hover:bg-hover");
    expect(screen.getByText(/You can read comments but not write them/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Write a comment" })).not.toBeInTheDocument();
  });

  it("shows a message when the record cannot be loaded", async () => {
    setup({}, { "GET /api/tables/tbl1/records/rec1": { status: 404, json: { error: { code: "not_found", message: "no such record" } } } });
    expect(await screen.findByText("This record could not be loaded.")).toBeInTheDocument();
  });
});

/** The Tiptap editor behind a rich text box. */
const editorIn = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;

describe("ExpandedRecord: comments", () => {
  it("lists comments with mentions rendered and marks your own", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "", hidden: false }).catch(() => null);
    void list;
    expect(await screen.findByText("Looks good")).toBeInTheDocument();
    expect(screen.getByText("@Ada Lovelace")).toHaveClass("ob-mention");
    // Comments are Markdown.
    expect(screen.getByText("Thanks!").tagName).toBe("STRONG");
    expect(screen.getByLabelText("Comment by Grace Hopper")).toBeInTheDocument();
    const mine = screen.getByLabelText("Comment by Ada Lovelace");
    expect(within(mine).getByRole("button", { name: "Edit comment" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Comment by Grace Hopper")).queryByRole("button", { name: "Edit comment" })).not.toBeInTheDocument();
  });

  it("posts a rich text comment with an @mention picked after typing @", async () => {
    const { api } = setup();
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

  it("closes the people list on Escape and keeps the record open", async () => {
    const { props } = setup();
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
    // With the list closed, Escape is the record's again.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("sends with Ctrl+Enter", async () => {
    const { api } = setup();
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
    await screen.findByRole("textbox", { name: "Write a comment" });
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });
});

describe("ExpandedRecord: history", () => {
  it("renders old -> new per field using display formatting, newest first", async () => {
    setup();
    await userEvent.click(await screen.findByRole("tab", { name: "History" }));
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
    expect(within(item("(deleted field)")).getByText("y")).toBeInTheDocument();
    expect(within(entries[1]!).getByText("Created this record")).toBeInTheDocument();
    expect(within(entries[1]!).getByText("Launch")).toBeInTheDocument();
  });

  it("scrolls as one column on a phone: the comments and history panels only scroll from md up", async () => {
    setup();
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Thanks!");
    // jsdom has no media queries: read the classes. An unprefixed overflow-y-auto outside the one
    // column (and the lists in the fields' pop-overs) is a second scroll area under the finger.
    const scrollers = [...dialog.querySelectorAll<HTMLElement>("[class*='overflow-y-auto']")].filter((el) => /(^|\s)overflow-y-auto(\s|$)/.test(el.className));
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toHaveClass("overscroll-contain");
    const panel = dialog.querySelector("aside")!;
    expect(panel.querySelector("[aria-live='polite']")).toHaveClass("md:overflow-y-auto");
    await userEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByRole("list", { name: "Revision history" })).toHaveClass("md:overflow-y-auto");
  });

  it("explains an empty history", async () => {
    setup({}, { "GET /api/records/rec1/history": [] });
    await userEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("No changes recorded yet.")).toBeInTheDocument();
  });
});
