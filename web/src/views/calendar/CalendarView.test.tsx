import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseSchema, Field, QueryRequest, TableRecord } from "@/api/types";
import { ALL_FIELDS, field } from "@/test/fields";
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

/** The project schema with more fields on its table. */
function withFields(schema: BaseSchema, extra: Field[]): BaseSchema {
  const table = schema.tables[0]!;
  return { ...schema, tables: [{ ...table, fields: [...table.fields, ...extra] }] };
}

function setup(role = "editor", view = cal(), routes: Record<string, unknown> = {}, rows: TableRecord[] = records, extra: Field[] = []) {
  const asked: QueryRequest[] = [];
  const schema = withFields(projectSchema(role, [view]), extra);
  return { asked, ...renderView(CalendarView, { schema, viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records: rows, colors: { r1: "blue" } }, asked), ...routes } as never }) };
}

const titles = () => [...document.querySelectorAll(".ob-calendar .ob-cal-title")].map((e) => e.textContent);

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

  describe("sort and visible fields", () => {
    const sortedCal = viewWithConfig("viw1", "calendar", { sorts: [{ field_id: F.name.id, direction: "desc" }], calendar: { date_field_id: F.start.id, end_field_id: F.end.id } });
    const same = [rec("r1", { [F.name.id]: "Zed", [F.start.id]: "2026-03-10", [F.status.id]: "s2" }), rec("r2", { [F.name.id]: "Alpha", [F.start.id]: "2026-03-10" })];

    it("orders the events of a day by the view's sort, not by title", async () => {
      setup("editor", sortedCal, {}, same);
      await screen.findByText("Zed");
      expect(titles()).toEqual(["Zed", "Alpha"]);
    });

    it("keeps FullCalendar's own order (by title here) when the view has no sort", async () => {
      setup("editor", cal(), {}, same);
      await screen.findByText("Zed");
      expect(titles()).toEqual(["Alpha", "Zed"]);
    });

    it("shows the visible fields' values under the title, and none that are hidden", async () => {
      setup("editor", cal(), {}, same);
      const chip = (await screen.findByText("Zed")).closest(".ob-cal-chip") as HTMLElement;
      expect(within(chip).getByText("Doing")).toHaveClass("ob-cal-details");
    });

    it("leaves a hidden field off the chips", async () => {
      setup("editor", viewWithConfig("viw1", "calendar", { hidden_fields: [F.status.id], calendar: { date_field_id: F.start.id, end_field_id: F.end.id } }), {}, same);
      const chip = (await screen.findByText("Zed")).closest(".ob-cal-chip") as HTMLElement;
      expect(within(chip).queryByText("Doing")).not.toBeInTheDocument();
    });

    it("lets the record panel's next record follow the day's sort", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup("editor", sortedCal, { "GET /api/tables/tbl1/records/r1": same[0]!, "GET /api/tables/tbl1/records/r2": same[1]! }, same);
      await user.click(await screen.findByText("Zed"));
      await user.click(await screen.findByRole("button", { name: /next record/i }));
      expect(screen.getByTestId("where")).toHaveTextContent("?record=r2");
    });
  });

  describe("layouts", () => {
    it("offers a Day layout, drawn as a day of the grid for date-only fields", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup();
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Day" }));
      expect(await screen.findByText("March 12, 2026")).toBeInTheDocument();
      expect(document.querySelector(".fc-dayGridDay-view")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Previous day" })).toBeInTheDocument();
    });

    it("draws the week of a date-only field as a row of days, not an hourly grid", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup();
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Week" }));
      await screen.findByText(/Mar 8 – 14, 2026/);
      expect(document.querySelector(".fc-dayGridWeek-view")).not.toBeNull();
      expect(document.querySelector(".fc-timegrid")).toBeNull();
      expect(screen.getByRole("button", { name: "Next week" })).toBeInTheDocument();
    });

    it("gives a field with a time of day an hourly week and day", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const at = field("date", { include_time: true, date_format: "iso", time_format: "h24", timezone: null }, { id: "f_at", name: "At" });
      setup("editor", cal({ date_field_id: at.id, end_field_id: null }), {}, [rec("r1", { [at.id]: "2026-03-10T09:00:00.000Z" })], [at]);
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Week" }));
      await screen.findByText(/Mar 8 – 14, 2026/);
      expect(document.querySelector(".fc-timeGridWeek-view")).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Day" }));
      await waitFor(() => expect(document.querySelector(".fc-timeGridDay-view")).not.toBeNull());
    });

    it("makes the list show the stretch of time of the layout before it, and names its arrows after it", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setup();
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Week" }));
      await screen.findByText(/Mar 8 – 14, 2026/);
      await user.click(screen.getByRole("button", { name: "List" }));
      await waitFor(() => expect(document.querySelector(".fc-list")).not.toBeNull());
      expect(screen.getByRole("button", { name: "Next week" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    });

    it("comes back to the layout and date the view was left on", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const first = setup();
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Next month" }));
      await screen.findByText("April 2026");
      await user.click(screen.getByRole("button", { name: "Week" }));
      await waitFor(() => expect(document.querySelector(".fc-dayGridWeek-view")).not.toBeNull());
      const week = document.querySelector("h3[aria-live]")!.textContent;
      expect(week).not.toMatch(/Mar 8/);
      first.unmount();
      setup();
      await waitFor(() => expect(document.querySelector("h3[aria-live]")).toHaveTextContent(week!));
      expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    });

    it("starts weeks on the day the viewer picked, and asks the server for those weeks", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { asked } = setup();
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "View" }));
      await user.selectOptions(await screen.findByRole("combobox", { name: "Week starts on" }), "Monday");
      expect(localStorage.getItem("ob-calendar-week-start")).toBe("1");
      // March 2026 starts on a Sunday: with Monday first the first row is Feb 23 (the query pads a day).
      await waitFor(() => expect(asked.some((a) => a.range?.from === "2026-02-22")).toBe(true));
    });
  });

  describe("taking an event off the calendar", () => {
    it("clears its dates when Delete is pressed on it, and tells how to undo it", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { api } = setup("editor", cal(), { "PATCH /api/tables/tbl1/records": { records: [records[2]!] } });
      const chip = (await screen.findByText("R2")).closest(".fc-event") as HTMLElement;
      chip.focus();
      await user.keyboard("{Delete}");
      await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
      expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toEqual({ typecast: true, records: [{ id: "r2", values: { f_start: null, f_end: null } }] });
      expect(await screen.findByText("Moved to Unscheduled")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    });

    it("moves the keyboard focus to the event beside the one taken off", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      // The server drops the record off the calendar once its dates are cleared.
      const rows = [...records];
      setup("editor", cal(), { "PATCH /api/tables/tbl1/records": () => { rows.splice(1, 1); return { records: [records[2]!] }; } }, rows);
      const chip = (await screen.findByText("R2")).closest(".fc-event") as HTMLElement;
      chip.focus();
      await user.keyboard("{Delete}");
      await waitFor(() => expect(document.querySelector('.fc-event[data-record-id="r2"]')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe((screen.getAllByText("R1")[0] as HTMLElement).closest(".fc-event")));
    });

    it("does nothing for a viewer", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { api } = setup("viewer");
      const chip = (await screen.findByText("R2")).closest(".fc-event") as HTMLElement;
      chip.focus();
      await user.keyboard("{Delete}");
      expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(0);
    });

    it("says in the column that an event can be dragged back to it", async () => {
      setup();
      const side = await screen.findByRole("complementary", { name: "Unscheduled records" });
      expect(within(side).getByText(/an event here to clear its date/)).toBeInTheDocument();
    });
  });

  describe("a computed date field", () => {
    const created: Field = { ...ALL_FIELDS.created_time!, id: "f_created", name: "Created" };

    it("explains why events cannot be moved and how to fix it, only to people who could edit", async () => {
      setup("editor", cal({ date_field_id: created.id, end_field_id: null }), {}, [rec("r1", { [created.id]: "2026-03-10T09:00:00.000Z" })], [created]);
      const note = await screen.findByText(/Created is a Created time field/);
      expect(note).toHaveTextContent("Pick a date field you can edit as the Date field under View");
      expect(document.querySelector(".fc-event-draggable")).toBeNull();
    });

    it("says nothing to a viewer, who could not drag anyway", async () => {
      setup("viewer", cal({ date_field_id: created.id, end_field_id: null }), {}, [rec("r1", { [created.id]: "2026-03-10T09:00:00.000Z" })], [created]);
      await screen.findByText("R1");
      expect(screen.queryByText(/fills itself in/)).not.toBeInTheDocument();
    });

    it("names a computed end field the same way", async () => {
      setup("editor", cal({ end_field_id: created.id }), {}, records, [created]);
      const note = await screen.findByText(/Created is a Created time field/);
      expect(note).toHaveTextContent("End date field");
    });

    it("does not say it for a date field that can be edited", async () => {
      setup();
      await screen.findByText("R1");
      expect(screen.queryByText(/Events cannot be moved/)).not.toBeInTheDocument();
    });
  });

  describe("Add", () => {
    const made = rec("rnew", {});
    const routes = { "POST /api/tables/tbl1/records": { records: [made] }, "GET /api/tables/tbl1/records/rnew": made };
    const startOf = (api: ReturnType<typeof setup>["api"]) => (api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values;

    it("puts the record on today while today is on screen", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { api } = setup("editor", cal(), routes);
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Add record" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
      expect(startOf(api)).toMatchObject({ f_start: "2026-03-12" });
    });

    it("puts it on the first day shown when today is not on screen", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { api } = setup("editor", cal(), routes);
      await screen.findByText("March 2026");
      await user.click(screen.getByRole("button", { name: "Next month" }));
      await screen.findByText("April 2026");
      await user.click(screen.getByRole("button", { name: "Add record" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
      expect(startOf(api)).toMatchObject({ f_start: "2026-04-01" });
    });

    it("still adds a record, without a date, when the date field is computed", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const created: Field = { ...ALL_FIELDS.created_time!, id: "f_created", name: "Created" };
      const { api } = setup("editor", cal({ date_field_id: created.id, end_field_id: null }), routes, [], [created]);
      await screen.findByText(/Created is a Created time field/);
      await user.click(screen.getByRole("button", { name: "Add record" }));
      await waitFor(() => expect(api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
      expect(startOf(api)).not.toHaveProperty("f_created");
    });
  });
});
