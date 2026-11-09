import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupHeader, PublicField, PublicRecord, PublicView, QueryRequest } from "@/api/types";
import { apiError, mockApi, renderApp, stubDesktop, type Handler, type RecordedCall } from "@/test/utils";
import { groupsWithin } from "./PublicList";
import { installBoardLayout, type BoardLayout } from "@/views/kanban/boardLayout";
import type { GridAdapterProps } from "@/views/grid/adapter";

// Glide draws to a canvas jsdom has none of: a stand-in keeps the props the page hands it and lists the cells those props describe.
const canvas = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("@/views/grid/glide/GlideGrid", async () => {
  const React = await import("react");
  return {
    gridHeaderHeight: () => 44,
    GlideGrid: React.forwardRef(function FakeGrid(props: GridAdapterProps, ref: React.ForwardedRef<unknown>) {
      canvas.props = props;
      React.useImperativeHandle(ref, () => ({ invalidate: () => {}, focus: () => {} }));
      const rows = Array.from({ length: props.rowCount }, (_, r) =>
        props.columns.map((_c, c) => {
          const cell = props.getCell(c, r);
          return cell.kind === "cell" ? cell.display : cell.kind === "group" ? `${cell.label} ${cell.count} records${cell.collapsed ? " folded" : ""}` : "";
        }),
      );
      return (
        <div data-testid="canvas">
          {rows.map((cells, r) => (
            <div key={r} role="row">
              {cells.join(" | ")}
            </div>
          ))}
        </div>
      );
    }),
  };
});
const grid = () => canvas.props as GridAdapterProps;
const rowsText = () => screen.getAllByRole("row").map((r) => r.textContent);

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
  { id: "f_name", name: "Name", type: "text", options: { multiline: false }, description: null },
  { id: "f_status", name: "Status", type: "single_select", options: { choices: [{ id: "s1", name: "Todo", color: "gray" }, { id: "s2", name: "Done", color: "green" }] }, description: null },
  { id: "f_owner", name: "Owner", type: "user", options: { multiple: false, notify: false }, description: null },
  { id: "f_start", name: "Start", type: "date", options: dateOpts, description: null },
  { id: "f_cover", name: "Cover", type: "attachment", options: {}, description: null },
];

const config = { field_widths: {}, frozen_columns: 0, kanban_stack_field_id: null, kanban_cover_field_id: null, description_field_id: null, kanban_hide_empty_stacks: false, kanban_stack_order: [], kanban_hidden_stacks: [], kanban_card_field_limit: null, kanban_cover_fit: false, gallery_cover_field_id: null, calendar_date_field_id: null, calendar_end_field_id: null, timeline_start_field_id: null, timeline_end_field_id: null, timeline_group_field_id: null };

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
  it("draws the visible properties and records on the signed-in grid's canvas, read-only, with the footer, and never asks who you are", async () => {
    const { api, onUnauthorized } = open(view("grid"));
    expect(await screen.findByRole("heading", { name: "Team board" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Records" })).toBeInTheDocument();
    await screen.findByText(/^Task 1/);
    expect(grid().columns.map((c) => c.title)).toEqual(["Name", "Status", "Owner", "Start", "Cover"]);
    // People by name, dates as written, choices by name.
    expect(rowsText()[0]).toBe("Task 1 | Todo | Ada Lovelace | 2026-03-10 | logo.png");
    expect(screen.getByText("3 records")).toBeInTheDocument();
    expect(screen.getByText("Powered by")).toBeInTheDocument();
    // Nothing is editable, and a record has no page to open from here.
    expect(grid().canEdit).toBe(false);
    expect(grid().canExpand).toBe(false);
    expect(grid().canAddField).toBe(false);
    expect(grid().canReorderRows || grid().canReorderColumns).toBe(false);
    expect(grid().getCell(0, 0)).toMatchObject({ kind: "cell", readOnly: true });
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
    await screen.findByText(/^Task 1/);
    await user.type(screen.getByRole("searchbox", { name: "Search records" }), "task 2");
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    await waitFor(() => expect(asked.some((a) => a.search === "task 2")).toBe(true));
    await waitFor(() => expect(screen.queryByText(/^Task 1/)).not.toBeInTheDocument());
    expect(screen.getByText(/^Task 2/)).toBeInTheDocument();
  });

  it("loads the pages of a long result as the rows come into view", async () => {
    const many = Array.from({ length: 450 }, (_, i) => record(i + 1));
    const asked: QueryRequest[] = [];
    open(view("grid"), { "POST /api/public/shares/tok_s/query": queryHandler(many, asked) });
    expect(await screen.findByText("450 records")).toBeInTheDocument();
    expect(asked.map((a) => a.offset)).toEqual([0]);
    expect(grid().rowCount).toBe(450);
    expect(grid().getCell(0, 300).kind).toBe("loading");
    act(() => grid().onVisibleRowsChange(300, 320));
    await waitFor(() => expect(asked.map((a) => a.offset)).toContain(200));
    await waitFor(() => expect(grid().getCell(0, 300)).toMatchObject({ kind: "cell", display: "Task 301" }));
  });

  it("sorts from a header's menu with a one-off override that is never saved", async () => {
    stubDesktop();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked, api } = open(view("grid"));
    await screen.findByText(/^Task 1/);
    act(() => grid().onHeaderMenu(0, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: "Sort A → Z" }));
    await waitFor(() => expect(asked.some((a) => a.transient?.sorts?.[0]?.direction === "asc")).toBe(true));
    expect(asked.find((a) => a.transient)!.transient).toEqual({ sorts: [{ field_id: "f_name", direction: "asc" }] });
    act(() => grid().onHeaderMenu(0, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: "Sort Z → A" }));
    await waitFor(() => expect(asked.some((a) => a.transient?.sorts?.[0]?.direction === "desc")).toBe(true));
    // The way back to the view's own order.
    act(() => grid().onHeaderMenu(0, { x: 5, y: 5, width: 1, height: 1 }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove sort" }));
    await waitFor(() => expect(asked.at(-1)!.transient).toBeUndefined());
    expect(api.calls.every((c) => c.method === "GET" || c.path.endsWith("/query"))).toBe(true);
  });

  it("shows group header rows from the server's groups, and folds a group without saving anything", async () => {
    const groups: GroupHeader[] = [
      { depth: 0, field_id: "f_status", key: "s1", label: "Todo", value: "s1", start: 0, count: 1 },
      { depth: 0, field_id: "f_status", key: "s2", label: "Done", value: "s2", start: 1, count: 2 },
    ];
    const { api } = open(view("grid"), { "POST /api/public/shares/tok_s/query": queryHandler(RECORDS, [], { groups }) });
    await screen.findByText(/^Task 1/);
    expect(rowsText().map((t) => t!.split(" | ")[0])).toEqual(["Todo 1 records", "Task 1", "Done 2 records", "Task 2", "Task 3"]);
    act(() => grid().onGroupToggle(1));
    await waitFor(() => expect(rowsText().map((t) => t!.split(" | ")[0])).toEqual(["Todo 1 records", "Task 1", "Done 2 records folded"]));
    expect(api.calls.every((c) => c.method === "GET" || c.path.endsWith("/query"))).toBe(true);
  });

  it("explains an empty result", async () => {
    open(view("grid"), { "POST /api/public/shares/tok_s/query": queryHandler([]) });
    expect(await screen.findByText("No records to show.")).toBeInTheDocument();
  });
});

describe("attachments in a shared view", () => {
  it("uses the share token on the thumbnail addresses the canvas draws for an open link", async () => {
    open(view("grid"));
    await screen.findByText(/^Task 1/);
    expect(grid().thumbUrl?.("att1")).toBe("/api/attachments/att1/thumb?share=tok_s");
    // A PDF shows its first page, through the share too.
    expect(grid().thumbUrl?.("att2")).toBe("/api/attachments/att2/thumb?share=tok_s");
  });

  it("fetches images with the password header for a protected link (an image cannot send it) and draws the tile's type until they arrive", async () => {
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
    await screen.findByText(/^Task 1/);
    expect(grid().thumbUrl?.("att1")).toBeNull();
    await waitFor(() => expect(grid().thumbUrl?.("att1")).toBe("blob:thumb-1"));
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
    expect(await screen.findByText(/^Task 1/)).toBeInTheDocument();
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
    expect(await screen.findByText(/^Task 1/)).toBeInTheDocument();
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

  it("draws the board with the signed-in board's own component, told it only shows: no card is a button, no stack has a menu, and a stack can be folded", async () => {
    const user = userEvent.setup();
    open(view("kanban", { kanban_stack_field_id: "f_status" }));
    const todo = await screen.findByRole("listitem", { name: "Stack: Todo" });
    // The signed-in board's stack and card (`data-stack-key`, `data-record-id`), not a second drawing of them.
    expect(todo).toHaveAttribute("data-stack-key");
    expect(within(todo).getByRole("article", { name: "Task 1" })).toHaveAttribute("data-record-id");
    expect(screen.queryByRole("button", { name: "Task 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Options for/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse Todo" }));
    expect(within(todo).queryByRole("article", { name: "Task 1" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Todo" }));
    expect(within(todo).getByRole("article", { name: "Task 1" })).toBeInTheDocument();
  });

  it("draws a gallery's cards with the signed-in card body", async () => {
    open(view("gallery", { gallery_cover_field_id: "f_cover" }));
    const list = await screen.findByRole("list", { name: "Records" });
    const card = await within(list).findByRole("article", { name: "Task 1" });
    expect(card.querySelector("h3")).toHaveClass("line-clamp-2", "font-semibold");
    expect(card.querySelector("img")).toHaveAttribute("src", expect.stringContaining("?share=tok_s"));
  });

  it("draws a list with the signed-in List's outline, its rows showing the title and the other values", async () => {
    open(view("list"));
    const tree = await screen.findByRole("tree");
    const row = await within(tree).findByRole("treeitem", { name: /Task 1/ });
    expect(row).toHaveAttribute("data-nav");
    expect(row).toHaveTextContent("Todo");
    expect(row).toHaveTextContent("Ada Lovelace");
    // The canvas is the grid's, not the list's.
    expect(screen.queryByRole("region", { name: "Records" })).not.toBeInTheDocument();
    expect(screen.getByText("3 records")).toBeInTheDocument();
  });

  it("puts every record of a grouped list under its own group, however many there are", async () => {
    // More than a page (100): a page of it would start in the middle of the headers' numbering.
    const many = Array.from({ length: 150 }, (_, i) => record(i + 1, { f_status: i < 120 ? "s1" : "s2" }));
    const groups: GroupHeader[] = [
      { depth: 0, field_id: "f_status", key: "s1", label: "Todo", value: "s1", start: 0, count: 120 },
      { depth: 0, field_id: "f_status", key: "s2", label: "Done", value: "s2", start: 120, count: 30 },
    ];
    const { asked } = open(view("list"), { "POST /api/public/shares/tok_s/query": queryHandler(many, [], { groups }) });
    const tree = await screen.findByRole("tree");
    const done = await within(tree).findByRole("treeitem", { name: /^Done/ });
    const rows = within(tree).getAllByRole("treeitem");
    const after = rows.slice(rows.indexOf(done) + 1);
    expect(after).toHaveLength(30);
    expect(after[0]).toHaveTextContent("Task 121");
    expect(after[29]).toHaveTextContent("Task 150");
    expect(within(tree).queryByRole("treeitem", { name: "Loading records" })).not.toBeInTheDocument();
    expect(screen.getByText("150 records")).toBeInTheDocument();
    // No page to turn to: the one list is the whole result.
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
    expect(asked.every((a) => a.offset === 0 || a.offset === undefined)).toBe(true);
  });

  it("cuts a group at the records it has when the share is longer than what loads", async () => {
    const groups: GroupHeader[] = [
      { depth: 0, field_id: "f_status", key: "s1", label: "Todo", value: "s1", start: 0, count: 2 },
      { depth: 0, field_id: "f_status", key: "s2", label: "Done", value: "s2", start: 2, count: 1 },
    ];
    expect(groupsWithin(groups, 1)).toEqual([{ ...groups[0], count: 1 }]);
    expect(groupsWithin(groups, 3)).toEqual(groups);
  });

  it("folds a list's groups, which are the visitor's own and saved nowhere", async () => {
    const user = userEvent.setup();
    const groups: GroupHeader[] = [
      { depth: 0, field_id: "f_status", key: "s1", label: "Todo", value: "s1", start: 0, count: 1 },
      { depth: 0, field_id: "f_status", key: "s2", label: "Done", value: "s2", start: 1, count: 2 },
    ];
    const { api } = open(view("list"), { "POST /api/public/shares/tok_s/query": queryHandler(RECORDS, [], { groups }) });
    const tree = await screen.findByRole("tree");
    await within(tree).findByRole("treeitem", { name: /Task 1/ });
    await user.click(within(tree).getAllByRole("treeitem", { name: /^Todo/ })[0]!);
    expect(within(tree).queryByRole("treeitem", { name: /Task 1/ })).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/query"))).toEqual([]);
  });

  it("follows the board's stack order and leaves its hidden stacks off", async () => {
    open(view("kanban", { kanban_stack_field_id: "f_status", kanban_stack_order: ["s2", "s1"], kanban_hidden_stacks: [""] }));
    await screen.findByRole("listitem", { name: "Stack: Done" });
    const stacks = within(screen.getByRole("list", { name: "Stacks" })).getAllByRole("listitem", { name: /^Stack: / }).map((s) => s.getAttribute("aria-label"));
    expect(stacks).toEqual(["Stack: Done", "Stack: Todo"]);
  });

  it("shows a board's description under the card title instead of as a row", async () => {
    const notes: PublicField = { id: "f_notes", name: "Notes", type: "rich_text", options: {}, description: null };
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
    expect(await screen.findByText("This Board needs a property that is not shared, so its records are shown as a table.")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Records" })).toBeInTheDocument();
  });

  it("draws the signed-in calendar's surface with the link's records, one query per stretch of days on screen, and nothing that edits", async () => {
    stubDesktop();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked, api } = open(view("calendar", { calendar_date_field_id: "f_start" }));
    expect(await screen.findByRole("heading", { name: "March 2026" })).toBeInTheDocument();
    // The chip is the signed-in calendar's: the record's colour-less tint, its title, no editing.
    const chip = await screen.findByText("Task 1");
    expect(chip.closest(".ob-cal-chip")).toHaveClass("ob-cal-chip-plain");
    expect(screen.getByText("Task 2")).toBeInTheDocument();
    // The month shows its own weeks, Sun Mar 1 to Sat Apr 4; the query pads a day each side.
    expect(asked.find((a) => a.range)!.range).toEqual({ field_id: "f_start", end_field_id: null, from: "2026-02-28", to: "2026-04-05" });
    expect(document.querySelector(".fc-event-draggable")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("heading", { name: "April 2026" })).toBeInTheDocument();
    await waitFor(() => expect(asked.some((a) => a.range?.from === "2026-03-28")).toBe(true));
    // Week and List are the surface's too.
    expect(screen.getByRole("button", { name: "Week" })).toBeInTheDocument();
    expect(api.calls.every((c) => c.method === "GET" || c.path.endsWith("/query"))).toBe(true);
  });

  it("draws the timeline chart without any editing gesture", async () => {
    open(view("timeline", { timeline_start_field_id: "f_start" }));
    const bar = await screen.findByRole("button", { name: /^Task 1, Mar 10/ });
    expect(bar).toHaveAttribute("data-bar");
    expect(screen.getByText("2 records with dates")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Timeline scale" })).toBeInTheDocument();
  });
});

describe("the header of a shared view", () => {
  it("shows the collection's color mark beside the view's name, and no icons", async () => {
    open({ ...view("grid"), table_icon: "truck", base_icon: "store", table_color: "teal" });
    await screen.findByRole("heading", { name: "Team board" });
    const header = document.querySelector("header")!;
    expect(header.querySelector(".ob-mark")).toBeInTheDocument();
    expect(header.querySelector("svg")).toBeNull();
    expect(header).toHaveTextContent("Tasks · Studio · read-only");
  });

  it("ends with the small OpenBase mark", async () => {
    open(view("grid"));
    await screen.findByRole("heading", { name: "Team board" });
    expect(document.querySelector("footer")).toHaveTextContent("Powered by OpenBase");
  });
});
