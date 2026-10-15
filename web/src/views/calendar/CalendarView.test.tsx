import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { stubDesktop } from "@/test/utils";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import CalendarView from "./CalendarView";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Pin "today" so the visible month is predictable.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
});

const cal = (patch: Record<string, unknown> = {}) => viewWithConfig("viw1", "calendar", { calendar: { date_field_id: F.start.id, end_field_id: F.end.id, ...patch } });

const records = [
  rec("r1", { [F.start.id]: "2026-03-10", [F.end.id]: "2026-03-12", [F.status.id]: "s2" }),
  rec("r2", { [F.start.id]: "2026-03-20" }),
  rec("r3", {}),
];

function setup(role = "editor", view = cal(), routes: Record<string, unknown> = {}) {
  const asked: QueryRequest[] = [];
  return { asked, ...renderView(CalendarView, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records, colors: { r1: "blue" } }, asked), ...routes } as never }) };
}

describe("CalendarView", () => {
  it("queries only the visible range (padded a day) with the end field and the viewer's zone", async () => {
    const { asked } = setup();
    await screen.findByText("March 2026");
    await waitFor(() => expect(asked.some((a) => a.range)).toBe(true));
    // The month shows its own weeks: Sun Mar 1 .. Sat Apr 4 (Mar 1 is a Sunday); the query pads a day each side.
    const ranged = asked.find((a) => a.range)!;
    expect(ranged.range).toEqual({ field_id: "f_start", end_field_id: "f_end", from: "2026-02-28", to: "2026-04-05" });
    expect(ranged.timezone).toBe("UTC");
  });

  it("renders records with a start date as events, ranges across their days, and colours them", async () => {
    setup();
    const ev1 = await screen.findByText("R1");
    expect(screen.getByText("R2")).toBeInTheDocument();
    expect(within(document.querySelector<HTMLElement>(".fc")!).queryByText("R3")).not.toBeInTheDocument(); // no date: unscheduled
    // The chip takes the record's colour; a record without one gets the primary tint.
    expect(ev1.closest(".ob-cal-chip")).toHaveClass("choice-blue");
    expect(screen.getByText("R2").closest(".ob-cal-chip")).toHaveClass("ob-cal-chip-plain");
  });

  it("opens the record when an event is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup("viewer", cal(), { "GET /api/tables/tbl1/records/r2": records[1]! });
    await user.click(await screen.findByText("R2"));
    expect(screen.getByTestId("where")).toHaveTextContent("?record=r2");
  });

  it("switches between month, week and list layouts", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup();
    await screen.findByText("March 2026");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(await screen.findByText(/Mar 8 – 14, 2026/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List" }));
    await waitFor(() => expect(document.querySelector(".fc-list")).not.toBeNull());
  });

  it("navigates with the card's own buttons (FullCalendar's icon font is blocked by the server's CSP) and queries the new range", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked } = setup();
    await screen.findByText("March 2026");
    expect(document.querySelector(".fc-icon")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("April 2026")).toBeInTheDocument();
    await waitFor(() => expect(asked.some((a) => a.range?.from === "2026-03-28")).toBe(true));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("February 2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByText("March 2026")).toBeInTheDocument();
  });

  it("marks today and names the first of the month", async () => {
    setup();
    await screen.findByText("March 2026");
    expect(document.querySelector(".fc-day-today .ob-cal-today")).toHaveTextContent("12");
    expect(screen.getByText("Mar 1")).toBeInTheDocument();
  });

  it("asks for a date field when none is set and saves the choice", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = viewWithConfig("viw1", "calendar", {});
    const { api, asked } = setup("editor", view, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    expect(await screen.findByText("Choose a date field")).toBeInTheDocument();
    expect(asked).toHaveLength(0);
    // The likely field (the first date people fill in) is chosen already.
    expect(screen.getByRole("combobox", { name: "Date field" })).toHaveValue("f_start");
    await user.click(screen.getByRole("button", { name: "Show calendar" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { calendar: { date_field_id: string } } }).config.calendar.date_field_id).toBe("f_start");
  });

  it("lists records without a date in the unscheduled column, asking the server with a transient is_empty filter", async () => {
    const { asked } = setup();
    await screen.findByText("R1");
    const side = await screen.findByRole("complementary", { name: "Unscheduled records" });
    expect(await within(side).findByText("R3")).toBeInTheDocument();
    expect(within(side).queryByText("R1")).not.toBeInTheDocument();
    // The sidebar's query has no date range and carries the override; the calendar's own query has neither.
    const sidebarQuery = asked.find((a) => a.transient);
    expect(sidebarQuery).toBeDefined();
    expect(sidebarQuery!.range).toBeNull();
    expect(sidebarQuery!.transient).toEqual({ filter: { conjunction: "and", items: [{ field_id: "f_start", op: "is_empty", value: null }] } });
    expect(asked.filter((a) => a.range).every((a) => !a.transient)).toBe(true);
  });

  it("folds the unscheduled column into a strip that still counts, and remembers it", async () => {
    stubDesktop();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup();
    const side = await screen.findByRole("complementary", { name: "Unscheduled records" });
    await within(side).findByText("R3");
    await user.click(within(side).getByRole("button", { name: "Hide unscheduled records" }));
    const strip = screen.getByRole("button", { name: "Show unscheduled records, 1" });
    expect(strip).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("ob-calendar-unscheduled-folded")).toContain("viw1");
    await user.click(strip);
    expect(await screen.findByRole("complementary", { name: "Unscheduled records" })).toBeInTheDocument();
  });

  it("keeps the view's saved filter in the unscheduled query", async () => {
    const saved ={ conjunction: "and" as const, items: [{ field_id: "f_status", op: "is" as const, value: "s2" }] };
    const view = viewWithConfig("viw1", "calendar", { filter: saved, calendar: { date_field_id: F.start.id, end_field_id: null } });
    const { asked } = setup("editor", view);
    await screen.findByText("March 2026");
    await waitFor(() => expect(asked.some((a) => a.transient)).toBe(true));
    expect(asked.find((a) => a.transient)!.transient!.filter!.items).toEqual([...saved.items, { field_id: "f_start", op: "is_empty", value: null }]);
  });

  it("is read-only for viewers: dates cannot be changed and days cannot be clicked to create", async () => {
    const { api } = setup("viewer");
    await screen.findByText("R1");
    expect(document.querySelector(".fc-event-draggable")).toBeNull();
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
  });
});
