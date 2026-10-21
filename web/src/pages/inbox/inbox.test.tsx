/** The Inbox page: the capture box and its drafts, attaching files, and saving into a table. */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentRef, InboxItem, WorkspaceSummary } from "@/api/types";
import { field, makeTable } from "@/test/fields";
import { USER, apiError, makeSchema, mockApi, renderApp, stubDesktop, type Handler, type RecordedCall } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const item = (id: string, body: string, attachments: AttachmentRef[] = [], ago = 60_000, title = ""): InboxItem => ({ id, title, body, attachments, created_at: NOW - ago, updated_at: NOW - ago });
const att = (id: string, filename: string, size = 2048): AttachmentRef => ({ id, filename, mime: "application/pdf", size });

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const notes = field("rich_text", {}, { id: "fld_notes", name: "Notes" });
const details = field("rich_text", {}, { id: "fld_details", name: "Details" });
const status = field("single_select", { choices: [{ id: "chs1", name: "Todo", color: "gray" }] }, { id: "fld_status", name: "Status" });
const files = field("attachment", {}, { id: "fld_files", name: "Files" });
const tasks = makeTable([name, notes, details, status, files], { name: "Tasks" });

const workspaces: WorkspaceSummary[] = [
  {
    id: "wsp1",
    name: "Acme",
    color: "green",
    role: "owner",
    member_count: 1,
    pending_invite_count: 0,
    bases: [
      { id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "editor", people: [], tables: [{ id: "tbl1", name: "Tasks", icon: null }, { id: "tbl2", name: "People", icon: null }] },
      { id: "app2", workspace_id: "wsp1", name: "Read only", color: "blue", role: "commenter", people: [], tables: [{ id: "tbl9", name: "Secrets", icon: null }] },
    ],
  },
];

function routes(extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /api/auth/me": USER,
    "GET /api/workspaces": workspaces,
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/inbox": [],
    "GET /api/bases/app1": makeSchema("editor", { tables: [tasks] }),
    "GET /api/bases/app1/collaborators": [],
    ...extra,
  });
}

const editorOf = () => (document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
const body = (call: RecordedCall) => call.body as Record<string, unknown>;

/** Writes into the note box as if typed. */
async function write(text: string) {
  await screen.findByRole("textbox", { name: "Note" });
  act(() => void editorOf().commands.insertContent(text));
}

const SAVE_WAIT = { timeout: 3000 };

describe("the Inbox page", () => {
  it("greets with a box to write in, and keeps the first line for later", async () => {
    stubDesktop();
    routes();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    const box = await screen.findByRole("textbox", { name: "Note" });
    expect(box.querySelector("p")).toHaveAttribute("data-placeholder", "Write something…");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to…" })).toBeInTheDocument();
    expect(await screen.findByText("No drafts. What you write above is saved here as you type.")).toBeInTheDocument();
  });
});

describe("drafts", () => {
  it("creates one draft when the first words are typed, then saves later changes with a PATCH once typing pauses", async () => {
    stubDesktop();
    const api = routes({
      "POST /api/inbox": (call) => item("inb1", String(body(call).body)),
      "PATCH /api/inbox/inb1": (call) => item("inb1", String(body(call).body)),
    });
    renderApp();
    await write("Hello");
    await write(" there");
    // Two changes in quick succession are one save, and it is the first, so a POST.
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1), SAVE_WAIT);
    expect(body(api.callsTo("POST /api/inbox")[0]!)).toEqual({ title: "", body: "Hello there", attachments: [] });
    expect(await screen.findByText("Saved as draft")).toBeInTheDocument();
    expect(api.callsTo("PATCH /api/inbox/inb1")).toHaveLength(0);

    await write(" again");
    expect(screen.getByRole("status", { name: "Draft status" })).toHaveTextContent("Saving…");
    await waitFor(() => expect(api.callsTo("PATCH /api/inbox/inb1")).toHaveLength(1), SAVE_WAIT);
    expect(body(api.callsTo("PATCH /api/inbox/inb1")[0]!)).toMatchObject({ body: "Hello there again" });
    expect(api.callsTo("POST /api/inbox")).toHaveLength(1);
    // It shows in the list under the box.
    expect(await screen.findByRole("button", { name: /Hello there again/ })).toBeInTheDocument();
  });

  it("keeps a title on its own as a draft, and lists the draft by it", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const reply = (call: RecordedCall) => item("inb1", String(body(call).body), [], 0, String(body(call).title));
    const api = routes({ "POST /api/inbox": reply, "PATCH /api/inbox/inb1": reply });
    renderApp();
    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("placeholder", "Title");
    const saves = () => [...api.callsTo("POST /api/inbox"), ...api.callsTo("PATCH /api/inbox/inb1")].map(body);
    await user.type(title, "Cabin for the offsite");
    // One draft is made (a slow typist's pause may save part of the title first, then the rest).
    await waitFor(() => expect(saves().at(-1)).toMatchObject({ title: "Cabin for the offsite", body: "" }), SAVE_WAIT);
    expect(api.callsTo("POST /api/inbox")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /Cabin for the offsite/ })).toBeInTheDocument();
  });

  it("saves at once on Ctrl+Enter, without waiting for typing to pause", async () => {
    stubDesktop();
    const api = routes({ "POST /api/inbox": (call) => item("inb1", String(body(call).body)) });
    renderApp();
    await write("Quick one");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note" }), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1), { timeout: 400 });
    // The shortcut is not a line break in the note.
    expect(editorOf().getText()).toBe("Quick one");
  });

  it("lists your drafts with a preview, how long ago and how many files, and loads one into the box", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({
      "GET /api/inbox": [item("inb2", "# Trip ideas\n\nLisbon in May", [att("att1", "map.pdf")], 3 * 3600_000), item("inb3", "Buy **milk**", [], 2 * 86400_000)],
    });
    renderApp();
    const drafts = within(await screen.findByRole("region", { name: "Drafts" }));
    const first = await drafts.findByRole("button", { name: /Trip ideas/ });
    expect(first).toHaveTextContent("3 hours ago");
    expect(first).toHaveTextContent("1 file");
    expect(drafts.getByRole("button", { name: /Buy milk/ })).toHaveTextContent("2 days ago");

    await user.click(first);
    const box = await screen.findByRole("textbox", { name: "Note" });
    await waitFor(() => expect(box).toHaveTextContent("Lisbon in May"));
    expect(screen.getByRole("list", { name: "Attached files" })).toHaveTextContent("map.pdf");
    expect(first).toHaveAttribute("aria-current", "true");
  });

  it("saves the draft being written before another one opens, and New note starts from an empty box", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/inbox": [item("inb2", "Older draft")],
      "POST /api/inbox": (call) => item("inb9", String(body(call).body)),
    });
    renderApp();
    await write("Half a thought");
    await user.click(await screen.findByRole("button", { name: /Older draft/ }));
    // Opening saved the one in the box first (it did not wait for typing to pause).
    expect(api.callsTo("POST /api/inbox")).toHaveLength(1);
    expect(body(api.callsTo("POST /api/inbox")[0]!)).toMatchObject({ body: "Half a thought" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveTextContent("Older draft"));

    await user.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).not.toHaveTextContent("Older draft"));
    expect(editorOf().getText()).toBe("");
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
    // Both drafts are still there.
    expect(screen.getByRole("button", { name: /Half a thought/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Older draft/ })).toBeInTheDocument();
  });

  it("keeps a draft when the box is emptied, and deletes it only on Discard, after asking", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/inbox": [item("inb2", "Keep me")],
      "PATCH /api/inbox/inb2": (call) => item("inb2", String(body(call).body)),
      "DELETE /api/inbox/inb2": { status: 204 },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Keep me/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveTextContent("Keep me"));
    act(() => void editorOf().commands.clearContent(true));
    await waitFor(() => expect(api.callsTo("PATCH /api/inbox/inb2")).toHaveLength(1), SAVE_WAIT);
    expect(body(api.callsTo("PATCH /api/inbox/inb2")[0]!)).toMatchObject({ body: "" });
    expect(api.callsTo("DELETE /api/inbox/inb2")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Discard this draft?" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(api.callsTo("DELETE /api/inbox/inb2")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/inbox/inb2")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Keep me/ })).not.toBeInTheDocument());
  });
});

describe("drafts: switching", () => {
  it("does nothing when the draft that is already open is tapped, and keeps the text typed since it was last saved", async () => {
    // The row holds the draft as the list had it when it last rendered: loading that into the box would put
    // back text from before the typing, and the next keystroke would save it over the newer text.
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/inbox": [item("inb2", "Old")],
      "PATCH /api/inbox/inb2": (call) => item("inb2", String(body(call).body)),
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Old/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveTextContent("Old"));
    await write(" newer");
    await user.click(screen.getByRole("button", { name: /Old/ }));
    expect(editorOf().getText()).toBe("Old newer");
    act(() => void editorOf().commands.insertContent("!"));
    const sent = () => api.callsTo("PATCH /api/inbox/inb2").map((c) => body(c).body);
    await waitFor(() => expect(sent()).toContain("Old newer!"), SAVE_WAIT);
    expect(sent()).not.toContain("Old");
  });

  it("stays on the text that could not be saved when another draft is tapped, and says so", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/inbox": [item("inb2", "Older draft")],
      "POST /api/inbox": apiError(500, "internal", "disk full"),
    });
    renderApp();
    await write("Half a thought");
    await user.click(await screen.findByRole("button", { name: /Older draft/ }));
    expect(await screen.findByText(/Could not save the draft: disk full/)).toBeInTheDocument();
    // Still the unsaved text in the box, not the other draft.
    expect(editorOf().getText()).toBe("Half a thought");
    expect(screen.getByRole("button", { name: /Older draft/ })).not.toHaveAttribute("aria-current");

    // Once the save works, the same tap switches.
    api.set("POST /api/inbox", (call) => item("inb9", String(body(call).body)));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Saved as draft");
    await user.click(screen.getByRole("button", { name: /Older draft/ }));
    await waitFor(() => expect(editorOf().getText()).toBe("Older draft"));
  });

  it("keeps an unsaved change when New note is pressed", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes({
      "GET /api/inbox": [item("inb2", "Older draft")],
      "PATCH /api/inbox/inb2": apiError(500, "internal", "offline"),
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Older draft/ }));
    await waitFor(() => expect(editorOf().getText()).toBe("Older draft"));
    await write(" plus more");
    await user.click(screen.getByRole("button", { name: "New note" }));
    expect(await screen.findByText(/Could not save the draft: offline/)).toBeInTheDocument();
    expect(editorOf().getText()).toBe("Older draft plus more");
  });
});

describe("attaching files", () => {
  const upload = async (user: ReturnType<typeof userEvent.setup>, file: File) => user.upload(await screen.findByLabelText("Attach files"), file);

  it("uploads to the inbox, shows a chip with the name and size, saves it in the draft, and removes it again", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox/attachments": att("att1", "report.pdf", 2048),
      "POST /api/inbox": (call) => item("inb1", String(body(call).body), (body(call).attachments as AttachmentRef[]) ?? []),
      "PATCH /api/inbox/inb1": (call) => item("inb1", "", (body(call).attachments as AttachmentRef[]) ?? []),
    });
    renderApp();
    await upload(user, new File(["%PDF"], "report.pdf", { type: "application/pdf" }));
    const chips = await screen.findByRole("list", { name: "Attached files" });
    expect(chips).toHaveTextContent("report.pdf");
    expect(chips).toHaveTextContent("2.0 KB");
    // The chip opens the file in a new tab.
    const open = within(chips).getByRole("link", { name: /report\.pdf/ });
    expect(open).toHaveAttribute("target", "_blank");
    expect(open.getAttribute("href")).toMatch(/^\/api\/attachments\/[^/]+\/report\.pdf$/);
    const form = api.callsTo("POST /api/inbox/attachments")[0]!.body as FormData;
    expect((form.get("file") as File).name).toBe("report.pdf");
    // A file alone is worth a draft, and is saved straight away.
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1), { timeout: 500 });
    expect(body(api.callsTo("POST /api/inbox")[0]!).attachments).toEqual([att("att1", "report.pdf", 2048)]);

    await user.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.callsTo("PATCH /api/inbox/inb1")).toHaveLength(1), { timeout: 500 });
    expect(body(api.callsTo("PATCH /api/inbox/inb1")[0]!).attachments).toEqual([]);
  });

  it("embeds a file inserted into the note: it goes up to the inbox and lives in the note, not in the chips", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox/attachments": { ...att("att7", "photo one.png", 900), mime: "image/png" },
      "POST /api/inbox": (call) => item("inb1", String(body(call).body), (body(call).attachments as AttachmentRef[]) ?? []),
      "PATCH /api/inbox/inb1": (call) => item("inb1", String(body(call).body), (body(call).attachments as AttachmentRef[]) ?? []),
    });
    renderApp();
    await screen.findByRole("textbox", { name: "Note" });
    await user.upload(await screen.findByLabelText("Media files"), new File(["png"], "photo one.png", { type: "image/png" }));
    await waitFor(() => expect(document.querySelector("figure.ob-media img")).toHaveAttribute("src", "/api/attachments/att7/photo%20one.png"));
    const form = api.callsTo("POST /api/inbox/attachments")[0]!.body as FormData;
    expect((form.get("file") as File).name).toBe("photo one.png");
    await waitFor(() => expect(api.callsTo("POST /api/inbox").length + api.callsTo("PATCH /api/inbox/inb1").length).toBeGreaterThan(0), SAVE_WAIT);
    const saved = [...api.callsTo("POST /api/inbox"), ...api.callsTo("PATCH /api/inbox/inb1")].map(body).at(-1)!;
    expect(saved.body).toBe("![](/api/attachments/att7/photo%20one.png)");
    expect(saved.attachments ?? []).toEqual([]);
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
  });

  it("leaves a file out of whichever draft is open when it finishes uploading, if it started in another", async () => {
    stubDesktop();
    const user = userEvent.setup();
    let finish!: () => void;
    const api = routes({
      "GET /api/inbox": [item("inb2", "Draft A"), item("inb3", "Draft B")],
      "POST /api/inbox/attachments": async () => {
        await new Promise<void>((r) => (finish = r));
        return att("att1", "slow.pdf");
      },
      "PATCH /api/inbox/inb3": (call) => item("inb3", String(body(call).body), (body(call).attachments as AttachmentRef[]) ?? []),
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Draft A/ }));
    await waitFor(() => expect(editorOf().getText()).toBe("Draft A"));
    await upload(user, new File(["%PDF"], "slow.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/attachments")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /Draft B/ }));
    await waitFor(() => expect(editorOf().getText()).toBe("Draft B"));
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("slow.pdf"));
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(api.callsTo("PATCH /api/inbox/inb3")).toHaveLength(0);
    expect(api.callsTo("POST /api/inbox")).toHaveLength(0);
  });

  it("does not make a new draft of a file that finishes uploading after Discard", async () => {
    stubDesktop();
    const user = userEvent.setup();
    let finish!: () => void;
    const api = routes({
      "GET /api/inbox": [item("inb2", "Draft A")],
      "POST /api/inbox/attachments": async () => {
        await new Promise<void>((r) => (finish = r));
        return att("att1", "slow.pdf");
      },
      "DELETE /api/inbox/inb2": { status: 204 },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Draft A/ }));
    await waitFor(() => expect(editorOf().getText()).toBe("Draft A"));
    await upload(user, new File(["%PDF"], "slow.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/attachments")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/inbox/inb2")).toHaveLength(1));
    await act(async () => finish());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/inbox")).toHaveLength(0);
  });

  it("says in plain words when there is no room for a file, and when uploads come too fast", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({ "POST /api/inbox/attachments": apiError(413, "payload_too_large", "request body too large") });
    renderApp();
    await upload(user, new File(["x"], "huge.zip"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("huge.zip: no room for this file");
    expect(alert).not.toHaveTextContent("request body too large");
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /api/inbox")).toHaveLength(0);

    api.set("POST /api/inbox/attachments", apiError(429, "rate_limited", "slow down"));
    await upload(user, new File(["x"], "again.zip"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("again.zip: too many uploads in a short time"));
  });
});

describe("saving into a table", () => {
  async function pickTasks(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Save to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Save to…" });
    // Only projects where records can be added are offered, and a single one goes straight to its tables.
    expect(within(dialog).queryByText("Read only")).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save to…" })).not.toBeInTheDocument());
    return screen.findByRole("textbox", { name: "Name" });
  }

  it("turns the box into the table's form: the primary field as the title, the other fields below, the note in a rich or multiline text field", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderApp();
    const title = await pickTasks(user);
    // The draft's own title box is the primary field now, named after it.
    expect(title).toHaveAttribute("placeholder", "Name");
    expect(screen.getByText("Project tracker › Tasks")).toBeInTheDocument();
    // The note goes into the first rich text field, and another can be chosen.
    const chooser = screen.getByRole("combobox", { name: "Note goes into" });
    expect(chooser).toHaveValue("fld_notes");
    expect(within(chooser).getAllByRole("option").map((o) => o.textContent)).toEqual(["Field: Notes", "Field: Details", "As a comment", "Nowhere (discard on save)"]);
    // The other fields (not the title, not the note's field, no attachment fields: the files have their own chooser).
    const others = screen.getAllByRole("group").map((g) => g.getAttribute("aria-labelledby"));
    expect(others).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save to…" })).not.toBeInTheDocument();
  });

  it("files the draft: the title and the note go to their fields, then a link opens the record and the box is empty", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox": (call) => item("inb1", String(body(call).body)),
      "POST /api/inbox/inb1/file": { id: "rec9", table_id: "tbl1", created_at: NOW, updated_at: NOW, created_by: "usr1", updated_by: "usr1", autonumber: 1, values: {} },
    });
    renderApp();
    const title = await pickTasks(user);
    await user.type(title, "Buy milk");
    await write("From the shop on the corner");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    // The draft was created first, with the note in it.
    expect(api.callsTo("POST /api/inbox")).toHaveLength(1);
    expect(body(api.callsTo("POST /api/inbox")[0]!)).toMatchObject({ body: "From the shop on the corner" });
    expect(body(api.callsTo("POST /api/inbox/inb1/file")[0]!)).toEqual({ table_id: "tbl1", fields: { fld_name: "Buy milk", fld_notes: "From the shop on the corner" } });

    const saved = await screen.findByText("Saved to Tasks.", { selector: "span" });
    expect(within(saved.parentElement!).getByRole("link", { name: "Open record" })).toHaveAttribute("href", "/base/app1/tbl1?record=rec9");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    await waitFor(() => expect(editorOf().getText()).toBe(""));
    // The draft is gone from the list, and nothing is left to save.
    await waitFor(() => expect(screen.getByRole("region", { name: "Drafts" })).toHaveTextContent("No drafts"));
    expect(api.callsTo("PATCH /api/inbox/inb1")).toHaveLength(0);
  });

  it("sends the note to the field that was chosen, and puts the files into the attachment field", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "GET /api/inbox": [item("inb7", "Scan of the contract", [att("att7", "contract.pdf")])],
      "POST /api/inbox/inb7/file": { id: "rec1", table_id: "tbl1", created_at: NOW, updated_at: NOW, created_by: "usr1", updated_by: "usr1", autonumber: 1, values: {} },
    });
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Scan of the contract/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveTextContent("Scan of the contract"));
    const title = await pickTasks(user);
    await user.type(title, "Contract");
    await user.selectOptions(screen.getByRole("combobox", { name: "Note goes into" }), "Field: Details");
    expect(screen.getByRole("combobox", { name: "File goes into" })).toHaveValue("fld_files");
    // The chosen field is the note's now, so it is no longer one of the form's fields.
    expect(screen.queryByRole("heading", { name: "Details" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb7/file")).toHaveLength(1));
    expect(body(api.callsTo("POST /api/inbox/inb7/file")[0]!)).toEqual({
      table_id: "tbl1",
      fields: { fld_name: "Contract", fld_details: "Scan of the contract", fld_files: [{ id: "att7" }] },
    });
  });

  it("leaves the note out when it goes nowhere", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox": (call) => item("inb1", String(body(call).body)),
      "POST /api/inbox/inb1/file": { id: "rec1", table_id: "tbl1", created_at: NOW, updated_at: NOW, created_by: "usr1", updated_by: "usr1", autonumber: 1, values: {} },
    });
    renderApp();
    const title = await pickTasks(user);
    await user.type(title, "Only a title");
    await write("not for the record");
    await user.selectOptions(screen.getByRole("combobox", { name: "Note goes into" }), "Nowhere (discard on save)");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(body(api.callsTo("POST /api/inbox/inb1/file")[0]!)).toEqual({ table_id: "tbl1", fields: { fld_name: "Only a title" } });
  });

  it("adds the note as the record's first comment when that is where it goes, even with no field filled", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox": (call) => item("inb1", String(body(call).body)),
      "POST /api/inbox/inb1/file": { id: "rec1", table_id: "tbl1", created_at: NOW, updated_at: NOW, created_by: "usr1", updated_by: "usr1", autonumber: 1, values: {} },
    });
    renderApp();
    await pickTasks(user);
    await write("Ask about Tuesday");
    await user.selectOptions(screen.getByRole("combobox", { name: "Note goes into" }), "As a comment");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(body(api.callsTo("POST /api/inbox/inb1/file")[0]!)).toEqual({ table_id: "tbl1", fields: {}, note_as_comment: true });
  });

  it("files on Ctrl+Enter, and keeps the typed values if filing fails", async () => {
    stubDesktop();
    const user = userEvent.setup();
    const api = routes({
      "POST /api/inbox": (call) => item("inb1", String(body(call).body)),
      "POST /api/inbox/inb1/file": apiError(403, "forbidden", "You need the Editor role on this project."),
    });
    renderApp();
    const title = await pickTasks(user);
    await user.type(title, "Quick");
    fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(await screen.findByText("You need the Editor role on this project.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Quick");
    expect(screen.queryByText("Saved to Tasks.")).not.toBeInTheDocument();
  });

  it("goes back to a plain note when the table is removed, keeping the note and forgetting the fields once another table is picked", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderApp();
    const title = await pickTasks(user);
    await user.type(title, "Typed title");
    await write("My note");
    await user.click(screen.getByRole("button", { name: "Save as a plain note instead" }));
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveTextContent("My note");
    expect(screen.getByRole("button", { name: "Save to…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("keeps what was typed while the target stays the same, across Change", async () => {
    stubDesktop();
    const user = userEvent.setup();
    routes();
    renderApp();
    const title = await pickTasks(user);
    await user.type(title, "Stays");
    await user.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Save to…" });
    await user.click(await within(dialog).findByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Stays");
  });
});
