import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
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
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    // FullCalendar shows six weeks: Sun Mar 1 .. Sat Apr 11 (Mar 1 is a Sunday); the query pads a day each side.
    expect(asked[0]!.range).toEqual({ field_id: "f_start", end_field_id: "f_end", from: "2026-02-28", to: "2026-04-12" });
    expect(asked[0]!.timezone).toBe("UTC");
  });

  it("renders records with a start date as events, ranges across their days, and colours them", async () => {
    setup();
    const ev1 = await screen.findByText("R1");
    expect(screen.getByText("R2")).toBeInTheDocument();
    expect(screen.queryByText("R3")).not.toBeInTheDocument(); // no date: unscheduled
    const link = ev1.closest("a")!;
    expect(link).toHaveStyle({ backgroundColor: "rgb(207, 223, 255)" }); // palette "blue"
    expect(screen.getByText(/2 records in this range/)).toBeInTheDocument();
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

  it("asks for a date field when none is set and saves the choice", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = viewWithConfig("viw1", "calendar", {});
    const { api, asked } = setup("editor", view, { "PATCH /api/views/viw1": (c: { body: { config: unknown } }) => ({ ...view, config: c.body.config }) });
    expect(await screen.findByText("Choose a date field")).toBeInTheDocument();
    expect(asked).toHaveLength(0);
    await user.selectOptions(screen.getByRole("combobox", { name: "Date field" }), "Start");
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect((api.callsTo("PATCH /api/views/viw1")[0]!.body as { config: { calendar: { date_field_id: string } } }).config.calendar.date_field_id).toBe("f_start");
  });

  it("lists records without a date in the unscheduled sidebar (filtered client-side from the whole view)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { asked } = setup();
    await screen.findByText("R1");
    await user.click(screen.getByRole("button", { name: /Unscheduled/ }));
    const side = await screen.findByRole("complementary", { name: "Unscheduled records" });
    expect(await within(side).findByText("R3")).toBeInTheDocument();
    expect(within(side).queryByText("R1")).not.toBeInTheDocument();
    // The sidebar's query has no date range.
    expect(asked.some((a) => !a.range)).toBe(true);
  });

  it("is read-only for viewers: dates cannot be changed and days cannot be clicked to create", async () => {
    const { api } = setup("viewer");
    await screen.findByText("R1");
    expect(document.querySelector(".fc-event-draggable")).toBeNull();
    expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(0);
  });
});
