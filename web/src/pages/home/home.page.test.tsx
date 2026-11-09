/** Home (HOME-1 to HOME-10): the capture box, Due soon, Recently changed, the Inbox card and the live updates. */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeDue, HomeRecent, HomeResponse, InboxItem, WorkspaceSummary } from "@/api/types";
import { field, makeRecord, makeTable } from "@/test/fields";
import { USER, apiError, makeSchema, mockApi, renderApp, stubDesktop, stubPhone, type Handler, type MockApi } from "@/test/utils";

// Sunday, November 8 2026, noon UTC. Only the clock is faked: timers stay real so queries and toasts run.
const NOW = Date.UTC(2026, 10, 8, 12, 0);

// The collection the person last captured into on this device; a capture goes there (HOME-3), else to Inbox.
const REMEMBER_TASKS = JSON.stringify({ wsp1: { baseId: "app1", tableId: "tbl1" } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  stubDesktop();
  localStorage.setItem("ob-last-capture", REMEMBER_TASKS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const due = field("date", { include_time: false, date_format: "friendly", time_format: "h12", timezone: null }, { id: "fld_due", name: "Due" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fld_done", name: "Done" });
const notes = field("rich_text", {}, { id: "fld_notes", name: "Notes" });
const files = field("attachment", {}, { id: "fld_files", name: "Files" });
const status = field("single_select", { choices: [{ id: "chs1", name: "Todo", color: "gray" }, { id: "chs2", name: "Doing", color: "blue" }] }, { id: "fld_status", name: "Status" });
const details = field("text", { multiline: true }, { id: "fld_details", name: "Details" });
const tasks = makeTable([name, due, done, notes, files, status, details], { name: "Tasks", home_date_field_id: "fld_due", done_field_id: "fld_done", body_field_id: "fld_notes" });
// A collection whose Home date has a time of day.
const startsAt = field("date", { include_time: true, date_format: "friendly", time_format: "h12", timezone: null }, { id: "fld_starts", name: "Start" });
const events = makeTable([name, startsAt], { id: "tbl4", name: "Events", home_date_field_id: "fld_starts" });
// A collection with no Home date and no attachments, and one whose title is a number (not offered by the capture box, offered when filing).
const ideas = makeTable([name], { id: "tbl2", name: "Ideas" });
const counts = makeTable([field("number", { precision: 0, allow_negative: false }, { id: "fld_n", name: "Count" })], { id: "tbl3", name: "Counts" });

const summary = (id: string, title: string) => ({ id, name: title, icon: null, color: "blue", record_count: 0, record_noun: "", body_field_id: null, home_date_field_id: null, done_field_id: null });
const workspace = (role = "owner", tables = ["tbl1", "tbl2", "tbl3"]): WorkspaceSummary => ({
  id: "wsp1",
  name: "Acme",
  color: "green",
  role: "owner",
  member_count: 1,
  pending_invite_count: 0,
  root_base_id: "app1",
  bases: [
    {
      id: "app1",
      workspace_id: "wsp1",
      name: "Project tracker",
      color: "green_dark",
      role,
      is_top_level: true,
      people: [],
      tables: tables.map((t) => summary(t, { tbl1: "Tasks", tbl2: "Ideas", tbl3: "Counts", tbl4: "Events" }[t] ?? t)),
    },
  ],
});

const dueRow = (id: string, title: string, date: string, over: Partial<HomeDue> = {}): HomeDue => ({
  record_id: id,
  table_id: "tbl1",
  base_id: "app1",
  base_name: "Project tracker",
  title,
  table_name: "Tasks",
  table_color: "blue",
  date,
  has_time: false,
  time: null,
  has_done: true,
  done_field_id: "fld_done",
  overdue: date < "2026-11-08",
  can_edit: true,
  ...over,
});
const recentRow = (id: string, title: string, at = NOW - 3_600_000): HomeRecent => ({ record_id: id, table_id: "tbl1", base_id: "app1", base_name: "Project tracker", title, table_name: "Tasks", table_color: "blue", kind: "update", author: { id: "usr2", name: "Grace" }, at });
const homeOf = (over: Partial<HomeResponse> = {}): HomeResponse => ({ today: "2026-11-08", timezone: "UTC", due: [], truncated: false, recent: [], drafts: [], ...over });
const draft = (id: string, title: string, body = ""): InboxItem => ({ id, title, body, attachments: [], created_at: NOW - 60_000, updated_at: NOW - 60_000 });

function routes(extra: Record<string, Handler> = {}, ws: WorkspaceSummary = workspace()): MockApi {
  return mockApi({
    "GET /api/auth/me": { ...USER, timezone: "UTC" },
    "GET /api/workspaces": [ws],
    "GET /api/notifications": { notifications: [], unread: 0 },
    "GET /api/workspaces/wsp1/home": homeOf(),
    "GET /api/bases/app1": makeSchema("owner", { tables: [tasks, ideas, counts, events] }),
    "GET /api/bases/app1/collaborators": [],
    ...extra,
  });
}

const box = () => screen.findByRole("textbox", { name: "Add a task, a note, a meal, anything" });
const toasts = () => screen.getByRole("region", { name: "Notifications" });
const created = (api: MockApi) => api.callsTo("POST /api/tables/tbl1/records")[0]?.body as { records: { values: Record<string, unknown> }[] };

async function openHome() {
  renderApp({ route: "/workspace/wsp1" });
  return await box();
}

describe("the header (HOME-2)", () => {
  it("shows today's date in the person's time zone above the title", async () => {
    routes({ "GET /api/auth/me": { ...USER, timezone: "Pacific/Auckland" } });
    renderApp({ route: "/workspace/wsp1" });
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Monday, November 9")).toBeInTheDocument();
  });
});

describe("the lists (HOME-6, HOME-7)", () => {
  it("fills Due soon and Recently changed from one request, with the date in words, red when overdue", async () => {
    const api = routes({
      "GET /api/workspaces/wsp1/home": homeOf({
        due: [dueRow("rec1", "Send the invoice", "2026-11-05"), dueRow("rec2", "Call the printer", "2026-11-08", { has_time: true, time: "09:00" }), dueRow("rec3", "Plan the offsite", "2026-11-12", { has_done: false, done_field_id: null })],
        recent: [recentRow("rec4", "Quarterly plan")],
      }),
    });
    await openHome();
    const dueList = within(await screen.findByRole("region", { name: "Due soon" }));
    expect(dueList.getByText("3 days ago")).toHaveClass("text-danger");
    expect(dueList.getByText("Today, 9:00 am")).toBeInTheDocument();
    expect(dueList.getByText("Thursday")).toBeInTheDocument();
    // A collection with no Done property gets no checkbox.
    expect(dueList.getAllByRole("checkbox")).toHaveLength(2);
    expect(dueList.getByRole("link", { name: /Send the invoice/ })).toHaveAttribute("href", "/base/app1/tbl1/r/rec1");
    const recent = within(screen.getByRole("region", { name: "Recently changed" }));
    expect(recent.getByRole("link", { name: /Quarterly plan/ })).toBeInTheDocument();
    expect(recent.getByText("1 hour ago")).toBeInTheDocument();
    expect(recent.getByRole("link", { name: "All activity" })).toHaveAttribute("href", "/history?workspace=wsp1");
    expect(api.callsTo("GET /api/workspaces/wsp1/home")).toHaveLength(1);
  });

  it("shows 8 rows, then Show more up to what the server sent, and says when the scan budget ran out", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/workspaces/wsp1/home": homeOf({ due: Array.from({ length: 11 }, (_, i) => dueRow(`rec${i}`, `Task ${i}`, "2026-11-08")), truncated: true }) });
    await openHome();
    const dueList = within(await screen.findByRole("region", { name: "Due soon" }));
    expect(dueList.getAllByRole("checkbox")).toHaveLength(8);
    await user.click(dueList.getByRole("button", { name: "Show more (3)" }));
    expect(dueList.getAllByRole("checkbox")).toHaveLength(11);
    expect(dueList.getByText(/Some collections weren't checked/)).toBeInTheDocument();
    await user.click(dueList.getByRole("button", { name: "Show fewer" }));
    expect(dueList.getAllByRole("checkbox")).toHaveLength(8);
  });

  it("says so when nothing is due", async () => {
    routes();
    await openHome();
    expect(await screen.findByText("Nothing is due soon.")).toBeInTheDocument();
  });
});

describe("the Done checkbox (HOME-6)", () => {
  it("marks the record done, takes the row off Home and Undo puts it back", async () => {
    const user = userEvent.setup();
    let isDone = false;
    const api = routes({
      "GET /api/workspaces/wsp1/home": () => homeOf({ due: isDone ? [] : [dueRow("rec1", "Send the invoice", "2026-11-08")] }),
      "PATCH /api/tables/tbl1/records": (call) => {
        isDone = (call.body as { records: { values: { fld_done: boolean } }[] }).records[0]!.values.fld_done;
        return { records: [makeRecord({}, "rec1")] };
      },
    });
    await openHome();
    await user.click(await screen.findByRole("checkbox", { name: "Mark Send the invoice done" }));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]?.body).toEqual({ records: [{ id: "rec1", values: { fld_done: true } }] });
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Mark Send the invoice done" })).not.toBeInTheDocument());
    await user.click(await within(toasts()).findByRole("button", { name: "Undo" }));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[1]?.body).toEqual({ records: [{ id: "rec1", values: { fld_done: false } }] });
    expect(await screen.findByRole("checkbox", { name: "Mark Send the invoice done" })).toBeInTheDocument();
  });

  it("is disabled for people who cannot edit that collection", async () => {
    routes({ "GET /api/workspaces/wsp1/home": homeOf({ due: [dueRow("rec1", "Send the invoice", "2026-11-08", { can_edit: false })] }) });
    await openHome();
    expect(await screen.findByRole("checkbox", { name: "Mark Send the invoice done" })).toBeDisabled();
  });

  it("brings the row back and says so when the write fails", async () => {
    const user = userEvent.setup();
    routes({
      "GET /api/workspaces/wsp1/home": homeOf({ due: [dueRow("rec1", "Send the invoice", "2026-11-08")] }),
      "PATCH /api/tables/tbl1/records": apiError(403, "forbidden", "You can't edit this"),
    });
    await openHome();
    await user.click(await screen.findByRole("checkbox", { name: "Mark Send the invoice done" }));
    expect(await within(toasts()).findByText("Couldn't mark it done")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "Mark Send the invoice done" })).toBeInTheDocument();
  });
});

describe("the capture box (HOME-3)", () => {
  it("goes to Inbox until a collection has been captured into, and fetches no folder to say so", async () => {
    localStorage.clear();
    const api = routes();
    await openHome();
    expect(await screen.findByRole("button", { name: /Goes to Inbox/ })).toBeInTheDocument();
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);
  });

  it("goes to the collection captured into last, and offers Inbox and the others whose title is text in a searchable list", async () => {
    const user = userEvent.setup();
    routes();
    await openHome();
    const chip = await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.click(chip);
    const list = await screen.findByRole("listbox", { name: "Collections" });
    // Counts has a number for a title: not offered.
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["InboxFile it later", "Tasks", "Ideas", "Events"]);
    await user.type(screen.getByRole("combobox", { name: "Search collections" }), "ide");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ideas"]);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: /Goes to Ideas/ })).toBeInTheDocument();
  });

  it("opens on the collection captured into last, and writes the first line as the title and the rest as the page", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-last-capture", JSON.stringify({ wsp1: { baseId: "app1", tableId: "tbl2" } }));
    const api = routes({ "POST /api/tables/tbl2/records": { records: [makeRecord({}, "rec9")] }, "PUT /api/tables/tbl2/records/rec9/page": { field_id: "fld_page", created: true, record: makeRecord({}, "rec9") } });
    await openHome();
    expect(await screen.findByRole("button", { name: /Goes to Ideas/ })).toBeInTheDocument();
    await user.type(await box(), "Garden shed{Shift>}{Enter}{/Shift}Needs a new roof{Shift>}{Enter}{/Shift}and a door{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl2/records")).toHaveLength(1));
    expect(api.callsTo("POST /api/tables/tbl2/records")[0]?.body).toEqual({ records: [{ values: { fld_name: "Garden shed" } }] });
    // Ideas has no page property yet: the server makes one as the page is saved.
    await waitFor(() => expect(api.callsTo("PUT /api/tables/tbl2/records/rec9/page")[0]?.body).toEqual({ text: "Needs a new roof\nand a door" }));
    expect(await within(toasts()).findByText("Added to Ideas")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toHaveValue("");
    expect(JSON.parse(localStorage.getItem("ob-last-capture")!)).toEqual({ wsp1: { baseId: "app1", tableId: "tbl2" } });
  });

  it("writes the page into the collection's page property when it has one, and the toast opens the record or takes it back", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] }, "POST /api/tables/tbl1/records/rec9/discard": { discarded: true } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Call Dana{Shift>}{Enter}{/Shift}about the quote{Enter}");
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana", fld_notes: "about the quote" });
    await user.click(await within(toasts()).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records/rec9/discard")).toHaveLength(1));
  });

  it("opens the new record from the toast", async () => {
    const user = userEvent.setup();
    routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] }, "GET /api/tables/tbl1/records/rec9": makeRecord({ fld_name: "Call Dana" }, "rec9") });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Call Dana{Enter}");
    await user.click(await within(toasts()).findByRole("button", { name: "Open" }));
    // The record page's own tests cover what it shows; here the address is the point.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Add a task, a note, a meal, anything" })).not.toBeInTheDocument());
  });

  it("saves a draft when it goes to Inbox, and Undo deletes it", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/inbox": draft("inb9", "Buy a cake", "for Sunday"), "DELETE /api/inbox/inb9": { status: 204 } });
    await openHome();
    await user.click(await screen.findByRole("button", { name: /Goes to Tasks/ }));
    await user.click(await screen.findByRole("option", { name: /^Inbox/ }));
    await user.type(await box(), "Buy a cake{Shift>}{Enter}{/Shift}for Sunday{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1));
    expect(api.callsTo("POST /api/inbox")[0]?.body).toEqual({ title: "Buy a cake", body: "for Sunday", attachments: [] });
    expect(await within(toasts()).findByText("Added to Inbox")).toBeInTheDocument();
    await user.click(within(toasts()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/inbox/inb9")).toHaveLength(1));
  });

  it("adds nothing for an empty box", async () => {
    const user = userEvent.setup();
    const api = routes();
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(await box(), "   {Enter}");
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("falls back to Inbox when the person can add to no collection", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/inbox": draft("inb9", "Idea") }, workspace("viewer"));
    await openHome();
    expect(await screen.findByRole("button", { name: /Goes to Inbox/ })).toBeInTheDocument();
    await user.type(await box(), "Idea{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1));
    // Nothing was fetched to find a title type: the folder cannot be added to.
    expect(api.callsTo("GET /api/bases/app1")).toHaveLength(0);
  });

  it("shows one empty state below the box for a workspace with no collections, and still captures to Inbox", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/inbox": draft("inb9", "First thought") }, workspace("owner", []));
    await openHome();
    expect(await screen.findByRole("button", { name: "Make your first collection" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Goes to Inbox/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Due soon" })).not.toBeInTheDocument();
    await user.type(await box(), "First thought{Enter}");
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1));
  });

  it("sets another property from the dashed Property chip", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Call Dana");
    await user.click(screen.getByRole("button", { name: "Property" }));
    await user.click(await screen.findByRole("button", { name: "Status" }));
    await user.type(screen.getByRole("textbox", { name: "Status" }), "Doing{Enter}");
    expect(await screen.findByText("Status: Doing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana", fld_status: "chs2" });
  });

  it("starts a new property from a value, guessing its type, for people who can make properties", async () => {
    const user = userEvent.setup();
    const api = routes({
      "POST /api/tables/tbl1/fields": { id: "fld_budget", table_id: "tbl1", name: "Budget", type: "currency", options: { precision: 2, symbol: "$", allow_negative: true } },
      "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] },
    });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Plan party");
    await user.click(screen.getByRole("button", { name: "Property" }));
    await user.click(await screen.findByRole("button", { name: "New property" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Budget");
    await user.type(screen.getByRole("textbox", { name: "Value" }), "$40");
    expect(screen.getByText(/Currency · Guessed from/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(api.callsTo("POST /api/tables/tbl1/fields")).toHaveLength(1);
    expect(created(api).records[0]!.values.fld_budget).toBe(40);
  });

  it("attaches a pasted file to the collection's first attachment property", async () => {
    const user = userEvent.setup();
    const api = routes({
      "POST /api/bases/app1/attachments": { id: "att1", filename: "scan.pdf", mime: "application/pdf", size: 3 },
      "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] },
    });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Receipt");
    const file = new File(["abc"], "scan.pdf", { type: "application/pdf" });
    fireEvent.paste(text, { clipboardData: { files: [file], types: ["Files"], getData: () => "" } });
    const chips = await screen.findByRole("list", { name: "Attached files" });
    expect(within(chips).getByText("scan.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Receipt", fld_files: [{ id: "att1" }] });
  });

  it("keeps what was typed and not added for the next visit, and forgets it once added", async () => {
    const user = userEvent.setup();
    routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    const first = renderApp({ route: "/workspace/wsp1" });
    await user.type(await box(), "Half a thought");
    first.unmount();
    renderApp({ route: "/workspace/wsp1" });
    expect(await box()).toHaveValue("Half a thought");
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Add a task, a note, a meal, anything" })).toHaveValue(""));
    expect(localStorage.getItem("ob-capture-text")).toBeNull();
  });

  it("lets Return start a new line on a finger's keyboard, which has no Shift+Enter", async () => {
    stubPhone();
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] }, "PUT /api/tables/tbl1/records/rec9/page": { field_id: "fld_notes", created: false, record: makeRecord({}, "rec9") } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Call Dana{Enter}about the quote");
    expect(text).toHaveValue("Call Dana\nabout the quote");
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana", fld_notes: "about the quote" });
  });

  it("does not take a file before it knows where the capture goes", async () => {
    const api = routes({ "GET /api/bases/app1": () => new Promise(() => {}) });
    await openHome();
    const text = await box();
    fireEvent.paste(text, { clipboardData: { files: [new File(["abc"], "scan.png", { type: "image/png" })], types: ["Files"], getData: () => "" } });
    expect(await screen.findByText("Still loading where this goes. Try again in a moment.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/bases/app1/attachments")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
  });

  it("says so when the collection has nowhere to keep a dropped file", async () => {
    routes();
    localStorage.setItem("ob-last-capture", JSON.stringify({ wsp1: { baseId: "app1", tableId: "tbl2" } }));
    await openHome();
    await screen.findByRole("button", { name: /Goes to Ideas/ });
    const text = await box();
    fireEvent.drop(text.closest("[role=group]")!, { dataTransfer: { files: [new File(["abc"], "scan.pdf")], types: ["Files"] } });
    expect(await screen.findByText(/Ideas has no attachment property/)).toBeInTheDocument();
  });
});

describe("the on-screen keyboard (PH-5)", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("docks Add just above the keyboard while the box has focus, and lets it back into the card after", async () => {
    stubPhone();
    const user = userEvent.setup();
    routes();
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    // A keyboard that covers the bottom 300 px of the screen.
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { height: window.innerHeight - 300, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} } });
    const add = screen.getByRole("button", { name: "Add" });
    expect(add.parentElement).not.toHaveAttribute("data-docked");
    await user.click(await box());
    await waitFor(() => expect(add.parentElement).toHaveAttribute("data-docked"));
    expect(add.parentElement).toHaveStyle({ bottom: "300px" });
    expect(add.parentElement).toHaveClass("fixed");
    await user.tab();
    await user.tab();
    await waitFor(() => expect(add.parentElement).not.toHaveAttribute("data-docked"));
  });
});

describe("date chips (HOME-4)", () => {
  it("turns a date phrase into a chip on the Home date, leaving the title without the words", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Call Dana tomorrow");
    expect(screen.getByText("Due tomorrow")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana", fld_due: "2026-11-09" });
  });

  it("reads the phrase in the person's time zone", async () => {
    const user = userEvent.setup();
    // Saturday evening in Los Angeles is already Sunday in UTC.
    vi.setSystemTime(Date.UTC(2026, 10, 8, 0, 30));
    const api = routes({ "GET /api/auth/me": { ...USER, timezone: "America/Los_Angeles" }, "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Pay rent today{Enter}");
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values.fld_due).toBe("2026-11-07");
  });

  it("takes the words out of the box once it loses focus, and puts them back when the chip is removed", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Call Dana by Friday");
    expect(text).toHaveValue("Call Dana by Friday");
    await user.tab();
    expect(text).toHaveValue("Call Dana");
    expect(screen.getByText("Due Fri")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Due Fri" }));
    expect(text).toHaveValue("Call Dana by Friday");
    // The button left with its chip: the keyboard is back in the box, not at the top of the page.
    expect(text).toHaveFocus();
    expect(screen.queryByText("Due Fri")).not.toBeInTheDocument();
    // The words stay a title once the chip is off.
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana by Friday" });
  });

  it("changes the date by tapping its chip: typed in the box's words, or picked on the calendar", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/tables/tbl1/records": { records: [makeRecord({}, "rec9")] } });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Call Dana tomorrow");
    await user.click(screen.getByRole("button", { name: "Due tomorrow, change date" }));
    await user.type(await screen.findByLabelText("Date"), "Fri{Enter}");
    expect(screen.getByText("Due Fri")).toBeInTheDocument();
    // The words that were read left the box with the first change, and the box has the keyboard back.
    expect(text).toHaveValue("Call Dana");
    expect(text).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Due Fri, change date" }));
    fireEvent.change(await screen.findByLabelText("Or pick a day"), { target: { value: "2026-11-20" } });
    expect(await screen.findByText("Due Nov 20")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(created(api)).toBeDefined());
    expect(created(api).records[0]!.values).toEqual({ fld_name: "Call Dana", fld_due: "2026-11-20" });
  });

  it("says why a date that was typed in the chip's picker cannot be used, and keeps the old one", async () => {
    const user = userEvent.setup();
    routes({});
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    await user.type(await box(), "Call Dana tomorrow");
    await user.click(screen.getByRole("button", { name: "Due tomorrow, change date" }));
    await user.type(await screen.findByLabelText("Date"), "banana{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Type a date");
    expect(screen.getByText("Due tomorrow")).toBeInTheDocument();
  });

  it("keeps the words when the collection has no Home date", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-last-capture", JSON.stringify({ wsp1: { baseId: "app1", tableId: "tbl2" } }));
    routes();
    await openHome();
    await screen.findByRole("button", { name: /Goes to Ideas/ });
    await user.type(await box(), "Call Dana tomorrow");
    expect(screen.queryByText("Due tomorrow")).not.toBeInTheDocument();
  });

  it("puts the words back when the collection changes to one without a Home date", async () => {
    const user = userEvent.setup();
    routes();
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Call Dana tomorrow");
    await user.tab();
    expect(text).toHaveValue("Call Dana");
    await user.click(screen.getByRole("button", { name: /Goes to Tasks/ }));
    await user.click(await screen.findByRole("option", { name: /^Ideas/ }));
    await waitFor(() => expect(text).toHaveValue("Call Dana tomorrow"));
    expect(screen.queryByText("Due tomorrow")).not.toBeInTheDocument();
  });
});

describe("a date phrase that has left the box for its chip is never lost (HOME-4)", () => {
  it("puts the words back when Goes to changes to Inbox", async () => {
    const user = userEvent.setup();
    const api = routes({ "POST /api/inbox": draft("inb9", "Pay rent tomorrow") });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    await user.type(text, "Pay rent tomorrow");
    await user.tab();
    expect(text).toHaveValue("Pay rent");
    expect(screen.getByText("Due tomorrow")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Goes to Tasks/ }));
    await user.click(await screen.findByRole("option", { name: /^Inbox/ }));
    await waitFor(() => expect(text).toHaveValue("Pay rent tomorrow"));
    expect(screen.queryByText("Due tomorrow")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox")).toHaveLength(1));
    expect(api.callsTo("POST /api/inbox")[0]?.body).toEqual({ title: "Pay rent tomorrow", body: "", attachments: [] });
  });

  it("puts the words back when Goes to changes to a collection whose Home date has no room for the time", async () => {
    const user = userEvent.setup();
    localStorage.setItem("ob-last-capture", JSON.stringify({ wsp1: { baseId: "app1", tableId: "tbl4" } }));
    routes({}, workspace("owner", ["tbl1", "tbl4"]));
    await openHome();
    await screen.findByRole("button", { name: /Goes to Events/ });
    const text = await box();
    await user.type(text, "Call Dana tomorrow 9am");
    await user.tab();
    expect(text).toHaveValue("Call Dana");
    expect(screen.getByText("Start: tomorrow · 9:00 am")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Goes to Events/ }));
    await user.click(await screen.findByRole("option", { name: /^Tasks/ }));
    await waitFor(() => expect(text).toHaveValue("Call Dana tomorrow 9am"));
    expect(screen.queryByText(/tomorrow ·/)).not.toBeInTheDocument();
  });
});

describe("the Inbox card (HOME-8)", () => {
  it("lists drafts on every Home, with a way to delete one", async () => {
    const user = userEvent.setup();
    let drafts = [draft("inb1", "Ideas for the offsite"), draft("inb2", "", "Call the accountant")];
    const api = routes({ "GET /api/workspaces/wsp1/home": () => homeOf({ drafts }), "DELETE /api/inbox/inb1": () => ((drafts = drafts.filter((d) => d.id !== "inb1")), { status: 204 }) });
    await openHome();
    const card = within(await screen.findByRole("region", { name: "Inbox" }));
    expect(card.getByText("Ideas for the offsite")).toBeInTheDocument();
    expect(card.getByText("Call the accountant")).toBeInTheDocument();
    await user.click(card.getByRole("button", { name: "Delete Ideas for the offsite" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/inbox/inb1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Ideas for the offsite")).not.toBeInTheDocument());
  });

  it("has no card without drafts", async () => {
    routes();
    await openHome();
    await screen.findByRole("region", { name: "Due soon" });
    expect(screen.queryByRole("region", { name: "Inbox" })).not.toBeInTheDocument();
  });

  it("files a draft through the collection's form: the title, the page and the files", async () => {
    const user = userEvent.setup();
    const withFile: InboxItem = { ...draft("inb1", "Lisbon trip", "Book flights"), attachments: [{ id: "att7", filename: "plan.pdf", mime: "application/pdf", size: 10 }] };
    const api = routes({ "GET /api/workspaces/wsp1/home": homeOf({ drafts: [withFile] }), "POST /api/inbox/inb1/file": makeRecord({}, "rec9") });
    await openHome();
    await user.click(await screen.findByRole("button", { name: "File Lisbon trip" }));
    const dialog = within(await screen.findByRole("dialog", { name: "File this draft" }));
    expect(await dialog.findByRole("textbox", { name: "Name" })).toHaveValue("Lisbon trip");
    expect(dialog.getByText("plan.pdf")).toBeInTheDocument();
    await waitFor(() => expect(dialog.getByRole("button", { name: "File" })).toBeEnabled());
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(api.callsTo("POST /api/inbox/inb1/file")[0]?.body).toEqual({ table_id: "tbl1", fields: { fld_name: "Lisbon trip", fld_notes: "Book flights", fld_files: [{ id: "att7" }] } });
    expect(await within(toasts()).findByText("Filed to Tasks")).toBeInTheDocument();
  });
});

describe("filing a draft (HOME-8)", () => {
  const withBody: InboxItem = { ...draft("inb1", "Lisbon trip", "Book flights"), attachments: [] };
  const filed = () => makeRecord({}, "rec9");
  async function openFile(item: InboxItem, extra: Record<string, Handler> = {}, label = item.title) {
    const api = routes({ "GET /api/workspaces/wsp1/home": homeOf({ drafts: [item] }), "POST /api/inbox/inb1/file": filed(), ...extra });
    await openHome();
    await userEvent.click(await screen.findByRole("button", { name: `File ${label}` }));
    const dialog = within(await screen.findByRole("dialog", { name: "File this draft" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "File" })).toBeEnabled());
    return { api, dialog, user: userEvent.setup() };
  }
  const sent = (api: MockApi) => api.callsTo("POST /api/inbox/inb1/file")[0]?.body;

  it("sends the note to the property that was chosen", async () => {
    const { api, dialog, user } = await openFile(withBody);
    await user.selectOptions(dialog.getByRole("combobox", { name: "Note goes into" }), "Property: Details");
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(sent(api)).toEqual({ table_id: "tbl1", fields: { fld_name: "Lisbon trip", fld_details: "Book flights" } });
  });

  it("leaves the note out when it goes nowhere", async () => {
    const { api, dialog, user } = await openFile(withBody);
    await user.selectOptions(dialog.getByRole("combobox", { name: "Note goes into" }), "Nowhere (discard on save)");
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(sent(api)).toEqual({ table_id: "tbl1", fields: { fld_name: "Lisbon trip" } });
  });

  it("files the note as the record's first comment when that is where it goes, even with no title", async () => {
    const { api, dialog, user } = await openFile({ ...draft("inb1", "", "Ask about Tuesday") }, {}, "Ask about Tuesday");
    await user.selectOptions(dialog.getByRole("combobox", { name: "Note goes into" }), "As a comment");
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(sent(api)).toEqual({ table_id: "tbl1", fields: {}, note_as_comment: true });
  });

  it("keeps what was typed and says why when filing fails", async () => {
    const { api, dialog, user } = await openFile(withBody, { "POST /api/inbox/inb1/file": apiError(403, "forbidden", "You need the Editor role on this folder.") });
    await user.clear(dialog.getByRole("textbox", { name: "Name" }));
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Quick");
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(await dialog.findByText("You need the Editor role on this folder.")).toBeInTheDocument();
    expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Quick");
    expect(within(toasts()).queryByText("Filed to Tasks")).not.toBeInTheDocument();
  });

  it("offers a collection whose title is a number, and leads the note with the draft's title", async () => {
    const { api, dialog, user } = await openFile(withBody);
    await user.click(dialog.getByRole("button", { name: /Files to/ }));
    await user.click(await screen.findByRole("option", { name: /^Counts/ }));
    // The title of this collection is a number: it has its own editor, and the draft's title is not lost.
    await user.type(await screen.findByRole("textbox", { name: "Count" }), "3{Enter}");
    await user.click(dialog.getByRole("button", { name: "File" }));
    await waitFor(() => expect(api.callsTo("POST /api/inbox/inb1/file")).toHaveLength(1));
    expect(sent(api)).toEqual({ table_id: "tbl3", fields: { fld_n: 3 }, note_as_comment: true });
  });
});

describe("editing a draft (HOME-8)", () => {
  const withFile: InboxItem = { ...draft("inb1", "Lisbon trip", "Book flights"), attachments: [{ id: "att7", filename: "plan.pdf", mime: "application/pdf", size: 10 }] };

  it("opens a draft to carry on: its title, text and files are saved back to it", async () => {
    const user = userEvent.setup();
    const api = routes({
      "GET /api/workspaces/wsp1/home": homeOf({ drafts: [withFile] }),
      "PATCH /api/inbox/inb1": withFile,
      "POST /api/inbox/attachments": { id: "att8", filename: "map.png", mime: "image/png", size: 4 },
    });
    await openHome();
    await user.click(await screen.findByText("Lisbon trip"));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit draft" }));
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Lisbon trip");
    expect(dialog.getByRole("textbox", { name: "Text" })).toHaveValue("Book flights");
    expect(dialog.getByText("plan.pdf")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(dialog.getByRole("textbox", { name: "Text" }), " and a hotel");
    await user.upload(dialog.getByLabelText("Add files to the draft"), new File(["abcd"], "map.png", { type: "image/png" }));
    await dialog.findByText("map.png");
    await user.click(dialog.getByRole("button", { name: "Remove plan.pdf" }));
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/inbox/inb1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/inbox/inb1")[0]?.body).toEqual({ title: "Lisbon trip", body: "Book flights and a hotel", attachments: [{ id: "att8", filename: "map.png", mime: "image/png", size: 4 }] });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit draft" })).not.toBeInTheDocument());
  });

  it("does not save a draft with nothing left in it", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/workspaces/wsp1/home": homeOf({ drafts: [draft("inb1", "Lisbon trip")] }) });
    await openHome();
    await user.click(await screen.findByText("Lisbon trip"));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit draft" }));
    await user.clear(dialog.getByRole("textbox", { name: "Title" }));
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps File and Delete working on the row that opens the draft", async () => {
    const user = userEvent.setup();
    routes({ "GET /api/workspaces/wsp1/home": homeOf({ drafts: [withFile] }) });
    await openHome();
    await user.click(await screen.findByRole("button", { name: "Delete Lisbon trip" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit draft" })).not.toBeInTheDocument();
  });
});

describe("files on the capture box (HOME-3)", () => {
  const paste = (text: HTMLElement, name: string) => fireEvent.paste(text, { clipboardData: { files: [new File(["abc"], name, { type: "application/zip" })], types: ["Files"], getData: () => "" } });

  it("says in plain words when there is no room for a file, and when uploads come too fast", async () => {
    const api = routes({ "POST /api/bases/app1/attachments": apiError(413, "payload_too_large", "request body too large") });
    await openHome();
    await screen.findByRole("button", { name: /Goes to Tasks/ });
    const text = await box();
    paste(text, "huge.zip");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("huge.zip: no room for this file");
    expect(alert).not.toHaveTextContent("request body too large");
    expect(screen.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();

    api.set("POST /api/bases/app1/attachments", apiError(429, "rate_limited", "slow down"));
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(text).toHaveFocus();
    paste(text, "again.zip");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("again.zip: too many uploads in a short time"));
  });
});

describe("live updates (HOME-10)", () => {
  class FakeEventSource {
    static all: FakeEventSource[] = [];
    onopen: ((ev: Event) => unknown) | null = null;
    onerror: ((ev: Event) => unknown) | null = null;
    listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
    constructor(public url: string) {
      FakeEventSource.all.push(this);
    }
    addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
    emit(type: string, payload: unknown) {
      for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }

  it("refetches both lists once when someone else changes records, over the workspace's one stream", async () => {
    FakeEventSource.all = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    let rows = [dueRow("rec1", "Send the invoice", "2026-11-08")];
    const api = routes({ "GET /api/workspaces/wsp1/home": () => homeOf({ due: rows }) });
    await openHome();
    await screen.findByText("Send the invoice");
    const stream = FakeEventSource.all.find((s) => s.url === "/api/workspaces/wsp1/events");
    expect(stream).toBeDefined();
    expect(FakeEventSource.all.some((s) => s.url.includes("/api/bases/"))).toBe(false);

    rows = [...rows, dueRow("rec2", "Book the venue", "2026-11-09")];
    const event = { base_id: "app1", client_id: "other-tab", user_id: "usr2", event: { kind: "records_changed", table_id: "tbl1", created: ["rec2"], updated: [], deleted: [] } };
    stream!.emit("records_changed", event);
    stream!.emit("records_changed", event);
    expect(await screen.findByText("Book the venue")).toBeInTheDocument();
    expect(api.callsTo("GET /api/workspaces/wsp1/home")).toHaveLength(2);
  });
});
