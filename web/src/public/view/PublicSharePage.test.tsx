import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupHeader, PublicField, PublicRecord, PublicView, QueryRequest } from "@/api/types";
import { apiError, mockApi, renderApp, type Handler, type RecordedCall } from "@/test/utils";
import { installBoardLayout, type BoardLayout } from "@/views/kanban/boardLayout";

let layout: BoardLayout;
beforeEach(() => {
  layout = installBoardLayout();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
});
afterEach(() => {
  layout.restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const dateOpts = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
const FIELDS: PublicField[] = [
  { id: "f_name", name: "Name", type: "single_line_text", options: {}, description: null },
  { id: "f_status", name: "Status", type: "single_select", options: { choices: [{ id: "s1", name: "Todo", color: "gray" }, { id: "s2", name: "Done", color: "green" }] }, description: null },
  { id: "f_owner", name: "Owner", type: "user", options: { multiple: false, notify: false }, description: null },
  { id: "f_start", name: "Start", type: "date", options: dateOpts, description: null },
  { id: "f_cover", name: "Cover", type: "attachment", options: {}, description: null },
];

const config = { field_widths: {}, frozen_columns: 0, kanban_stack_field_id: null, kanban_cover_field_id: null, description_field_id: null, kanban_hide_empty_stacks: false, gallery_cover_field_id: null, calendar_date_field_id: null, calendar_end_field_id: null, timeline_start_field_id: null, timeline_end_field_id: null, timeline_group_field_id: null };

function view(type: PublicView["type"], patch: Partial<PublicView["config"]> = {}, fields = FIELDS): PublicView {
  return { kind: "view", name: "Team board", type, table_name: "Tasks", base_name: "Studio", fields, config: { ...config, ...patch } };
}

const img = { id: "att1", filename: "logo.png", mime: "image/png", size: 100, width: 10, height: 10 };
const pdf = { id: "att2", filename: "spec.pdf", mime: "application/pdf", size: 2048 };

const record = (n: number, values: Record<string, unknown> = {}): PublicRecord => ({ id: `rec${n}`, values: { f_name: `Task ${n}`, ...values } });
const RECORDS: PublicRecord[] = [
  record(1, { f_status: "s1", f_owner: [{ name: "Ada Lovelace" }], f_start: "2026-03-10", f_cover: [img] }),
  record(2, { f_status: "s2", f_start: "2026-03-11", f_cover: [pdf] }),
  record(3, {}),
];

/** A `POST …/query` handler paging `all`, recording what was asked. */
function queryHandler(all: PublicRecord[], log: QueryRequest[] = [], extra: Partial<{ groups: GroupHeader[]; colors: Record<string, string> }> = {}): Handler {
  return (call: RecordedCall) => {
    const body = call.body as QueryRequest;
    log.push(body);
    const offset = body.offset ?? 0;
    const q = (body.search ?? "").toLowerCase();
    const rows = q ? all.filter((r) => String(r.values["f_name"]).toLowerCase().includes(q)) : all;
    return { total: rows.length, offset, records: rows.slice(offset, offset + (body.limit ?? 100)), groups: extra.groups ?? [], colors: extra.colors ?? {} };
  };
}

function open(v: PublicView, routes: Record<string, Handler> = {}, path = "/share/tok_s") {
  const asked: QueryRequest[] = [];
  const api = mockApi({ "GET /api/public/shares/tok_s": v, "POST /api/public/shares/tok_s/query": queryHandler(RECORDS, asked), ...routes });
  const app = renderApp({ route: path });
  return { api, asked, ...app };
}

describe("a shared grid", () => {
  it("shows the visible fields and records read-only, with the footer, and never asks who you are", async () => {
    const { api, onUnauthorized } = open(view("grid"));
    expect(await screen.findByRole("heading", { name: "Team board" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Records" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Status", "Owner", "Start", "Cover"]);
    await within(table).findByText("Task 1");
    const row = within(table).getByText("Task 1").closest("tr")!;
    expect(within(row).getByText("Todo")).toBeInTheDocument();
    expect(within(row).getByText("Ada Lovelace")).toBeInTheDocument(); // people by name
    expect(within(row).getByText("2026-03-10")).toBeInTheDocument();
    expect(screen.getByText("1–3 of 3 records")).toBeInTheDocument();
    expect(screen.getByText("Powered by")).toBeInTheDocument();
    // No editors: nothing in the table is editable.
    expect(within(table).queryAllByRole("textbox")).toHaveLength(0);
    expect(api.calls.map((c) => `${c.method} ${c.path}`).filter((k) => !k.startsWith("GET /api/attachments"))).toEqual(["GET /api/public/shares/tok_s", "POST /api/public/shares/tok_s/query"]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("answers on /s/:token as well", async () => {
    open(view("grid"), {}, "/s/tok_s");
    expect(await screen.findByRole("heading", { name: "Team board" })).toBeInTheDocument();
  });

  it("searches", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked } = open(view("grid"));
    await screen.findByText("Task 1");
    await user.type(screen.getByRole("searchbox", { name: "Search records" }), "task 2");
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    await waitFor(() => expect(asked.some((a) => a.search === "task 2")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Task 1")).not.toBeInTheDocument());
    expect(screen.getByText("Task 2")).toBeInTheDocument();
  });

  it("pages through long results", async () => {
    const many = Array.from({ length: 230 }, (_, i) => record(i + 1));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const asked: QueryRequest[] = [];
    open(view("grid"), { "POST /api/public/shares/tok_s/query": queryHandler(many, asked) });
    expect(await screen.findByText("1–100 of 230 records")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("101–200 of 230 records")).toBeInTheDocument();
    expect(asked.map((a) => a.offset)).toContain(100);
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("201–230 of 230 records")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  });

  it("sorts on a header click with a one-off override that is never saved", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked, api } = open(view("grid"));
    await screen.findByText("Task 1");
    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(asked.some((a) => a.transient?.sorts?.[0]?.direction === "asc")).toBe(true));
    expect(asked.find((a) => a.transient)!.transient).toEqual({ sorts: [{ field_id: "f_name", direction: "asc" }] });
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(asked.some((a) => a.transient?.sorts?.[0]?.direction === "desc")).toBe(true));
    expect(api.calls.every((c) => c.method === "GET" || c.path.endsWith("/query"))).toBe(true);
  });

  it("shows group header rows from the server's groups", async () => {
    const groups: GroupHeader[] = [
      { depth: 0, field_id: "f_status", key: "s1", label: "Todo", value: "s1", start: 0, count: 1 },
      { depth: 0, field_id: "f_status", key: "s2", label: "Done", value: "s2", start: 1, count: 2 },
    ];
    open(view("list"), { "POST /api/public/shares/tok_s/query": queryHandler(RECORDS, [], { groups }) });
    const table = await screen.findByRole("table", { name: "Records" });
    await within(table).findByText("Task 1");
    expect(within(table).getByText("2 records")).toBeInTheDocument();
    const order = [...table.querySelectorAll("tbody tr")].map((tr) => tr.textContent);
    expect(order[0]).toContain("Todo");
    expect(order[1]).toContain("Task 1");
    expect(order[2]).toContain("Done");
  });

  it("explains an empty result", async () => {
    open(view("grid"), { "POST /api/public/shares/tok_s/query": queryHandler([]) });
    expect(await screen.findByText("No records to show.")).toBeInTheDocument();
  });
});

describe("attachments in a shared view", () => {
  it("uses the share token on thumbnail and download addresses for an open link", async () => {
    open(view("grid"));
    const table = await screen.findByRole("table", { name: "Records" });
    await within(table).findByText("Task 1");
    const thumb = table.querySelector("tr[data-record-id='rec1'] img");
    expect(thumb).toHaveAttribute("src", "/api/attachments/att1/thumb?share=tok_s");
    // A PDF shows its first page, through the share too.
    expect(table.querySelector("tr[data-record-id='rec2'] img")).toHaveAttribute("src", "/api/attachments/att2/thumb?share=tok_s");
  });

  it("fetches images with the password header for a protected link (an <img> cannot send it)", async () => {
    const created = vi.fn(() => "blob:thumb-1");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const guard = (h: Handler) => (call: RecordedCall) => (call.headers.get("X-Share-Password") === "pw12" ? (typeof h === "function" ? h(call) : h) : apiError(401, call.headers.get("X-Share-Password") ? "share_password_invalid" : "share_password_required", "no"));
    const api = open(view("grid"), {
      "GET /api/public/shares/tok_s": guard(view("grid")),
      "POST /api/public/shares/tok_s/query": guard(queryHandler(RECORDS)),
      "GET /api/attachments/att1/thumb": (call) => {
        expect(call.query.get("share")).toBe("tok_s");
        return call.headers.get("X-Share-Password") === "pw12" ? { status: 200, text: "PNGDATA" } : apiError(404, "not_found", "x");
      },
    });
    await user.type(await screen.findByLabelText("Password"), "pw12");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const table = await screen.findByRole("table", { name: "Records" });
    await waitFor(() => expect(table.querySelector("tr[data-record-id='rec1'] img")).toHaveAttribute("src", "blob:thumb-1"));
    const thumbCall = api.api.callsTo("GET /api/attachments/att1/thumb")[0]!;
    expect(thumbCall.headers.get("X-Share-Password")).toBe("pw12");
  });
});

describe("a protected shared view", () => {
  it("asks for the password before anything is shown and keeps it for the records", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const seen: (string | null)[] = [];
    const guard = (h: Handler) => (call: RecordedCall) => {
      const pw = call.headers.get("X-Share-Password");
      seen.push(pw);
      if (pw === "hunter22") return typeof h === "function" ? h(call) : h;
      return apiError(401, pw ? "share_password_invalid" : "share_password_required", "no");
    };
    open(view("grid"), { "GET /api/public/shares/tok_s": guard(view("grid")), "POST /api/public/shares/tok_s/query": guard(queryHandler(RECORDS)) });
    expect(await screen.findByText("This page is password protected")).toBeInTheDocument();
    expect(screen.queryByText("Task 1")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That password is not correct. Try again.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Task 1")).toBeInTheDocument();
    // The page request and the records request both carried it.
    expect(seen.filter((p) => p === "hunter22")).toHaveLength(2);
    expect(JSON.stringify({ ...localStorage })).not.toContain("hunter22");
  });
});

describe("problems with a shared view", () => {
  it("says an unavailable link is not available", async () => {
    open(view("grid"), { "GET /api/public/shares/tok_s": apiError(404, "not_found", "share link not found") });
    expect(await screen.findByRole("heading", { name: "This page is not available" })).toBeInTheDocument();
  });

  it("shows a retry when loading records fails", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api } = open(view("grid"), { "POST /api/public/shares/tok_s/query": apiError(400, "bad_request", "transient refers to a field that is not shown") });
    expect(await screen.findByText(/Could not load records: transient refers to a field/)).toBeInTheDocument();
    api.set("POST /api/public/shares/tok_s/query", queryHandler(RECORDS));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Task 1")).toBeInTheDocument();
  });
});

describe("shared views of other types", () => {
  it("lays a gallery out as cards with the cover image", async () => {
    open(view("gallery", { gallery_cover_field_id: "f_cover" }));
    const list = await screen.findByRole("list", { name: "Records" });
    const card = await within(list).findByRole("article", { name: "Task 1" });
    expect(card.querySelector("img")).toHaveAttribute("src", "/api/attachments/att1/thumb?share=tok_s");
    expect(within(card).getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("3 records")).toBeInTheDocument();
  });

  it("lays a board out as read-only stacks", async () => {
    open(view("kanban", { kanban_stack_field_id: "f_status" }));
    const todo = await screen.findByRole("listitem", { name: "Stack: Todo" });
    expect(within(todo).getByRole("article", { name: "Task 1" })).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Stack: Done" })).getByRole("article", { name: "Task 2" })).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Stack: Uncategorized" })).getByRole("article", { name: "Task 3" })).toBeInTheDocument();
    // Read-only: no drag handles, no add buttons.
    expect(screen.queryByRole("button", { name: /Add card/ })).not.toBeInTheDocument();
  });

  it("shows a board's description under the card title instead of as a row", async () => {
    const notes: PublicField = { id: "f_notes", name: "Notes", type: "long_text", options: { rich: true }, description: null };
    const records = [record(1, { f_status: "s1", f_notes: "**Call** the\n\nsupplier   first" }), record(2, { f_status: "s1" })];
    open(view("kanban", { kanban_stack_field_id: "f_status", description_field_id: "f_notes" }, [...FIELDS, notes]), { "POST /api/public/shares/tok_s/query": queryHandler(records) });
    const card = await screen.findByRole("article", { name: "Task 1" });
    const text = card.querySelector("[data-card-description]")!;
    expect(text.textContent).toBe("Call the supplier first");
    expect(text.className).toContain("line-clamp-3");
    expect(within(card).queryByText("Notes")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Task 2" }).querySelector("[data-card-description]")).toBeNull();
  });

  it("falls back to a table when the board's stack field is not shared", async () => {
    open(view("kanban", { kanban_stack_field_id: null }));
    expect(await screen.findByText(/needs a field that is not shared/)).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Records" })).toBeInTheDocument();
  });

  it("shows records on the month calendar, one query per month with the range", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked } = open(view("calendar", { calendar_date_field_id: "f_start" }));
    expect(await screen.findByRole("heading", { name: "March 2026" })).toBeInTheDocument();
    const cell = await screen.findByRole("gridcell", { name: "2026-03-10" });
    expect(within(cell).getByText("Task 1")).toBeInTheDocument();
    expect(asked[0]!.range).toEqual({ field_id: "f_start", end_field_id: null, from: "2026-03-01", to: "2026-04-11" });
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("heading", { name: "April 2026" })).toBeInTheDocument();
    await waitFor(() => expect(asked.some((a) => a.range?.from === "2026-03-29")).toBe(true));
  });

  it("draws the timeline chart without any editing gesture", async () => {
    open(view("timeline", { timeline_start_field_id: "f_start" }));
    const bar = await screen.findByRole("button", { name: /^Task 1, Mar 10/ });
    expect(bar).toHaveAttribute("data-bar");
    expect(screen.getByText("2 records with dates")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Timeline scale" })).toBeInTheDocument();
  });
});

describe("icons on a shared view", () => {
  it("shows the table and base icons in the header, a plain name without them", async () => {
    open({ ...view("grid"), table_icon: "truck", base_icon: "store" });
    await screen.findByRole("heading", { name: "Team board" });
    const header = document.querySelector("header")!;
    expect(header.querySelector("svg.lucide-truck")).toBeInTheDocument();
    expect(header.querySelector("svg.lucide-store")).toBeInTheDocument();
    expect(header).toHaveTextContent("Tasks · Studio · read-only");
  });

  it("adds nothing when neither has an icon", async () => {
    open(view("grid"));
    await screen.findByRole("heading", { name: "Team board" });
    expect(document.querySelector("header svg")).toBeNull();
    expect(document.querySelector("header")).toHaveTextContent("Tasks · Studio · read-only");
  });
});
