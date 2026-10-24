import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubDesktop } from "@/test/utils";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import CalendarView from "./CalendarView";

// FullCalendar's pointer drags need real layout, which jsdom does not have: stand in for the component and
// call the handlers it would call, with the same arguments, to test what the calendar does with a drag.
const fc = vi.hoisted(() => ({ props: {} as Record<string, (arg: unknown) => void> }));
vi.mock("@fullcalendar/react", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef(function FullCalendarStub(props: Record<string, (arg: unknown) => void>, ref) {
      fc.props = props;
      React.useImperativeHandle(ref, () => ({ getApi: () => ({}) }));
      return React.createElement("div", { "data-testid": "fc" });
    }),
  };
});

beforeEach(() => {
  stubDesktop();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
  // The unscheduled column is the right 200px of a 1000px page.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const column = this.getAttribute("aria-label") === "Unscheduled records";
    return { left: column ? 800 : 0, right: column ? 1000 : 800, top: 0, bottom: 600, width: 200, height: 600, x: 0, y: 0, toJSON: () => ({}) };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = viewWithConfig("viw1", "calendar", { calendar: { date_field_id: F.start.id, end_field_id: F.end.id } });
const records = [rec("r2", { [F.start.id]: "2026-03-20", [F.end.id]: "2026-03-22" }), rec("r3", {})];
const PATCH = "PATCH /api/tables/tbl1/records";

async function setup(role = "editor") {
  const view$ = renderView(CalendarView, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }), [PATCH]: { records: [records[1]!] } } as never });
  await screen.findByRole("complementary", { name: "Unscheduled records" });
  return view$;
}
const event = { extendedProps: { recordId: "r2" } };
const at = (x: number) => ({ event, jsEvent: { clientX: x, clientY: 100 } });

describe("dragging an event back to the unscheduled column", () => {
  it("clears its dates when it is let go over the column, and offers Undo", async () => {
    const { api } = await setup();
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(900)));
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "r2", values: { f_start: null, f_end: null } }] });
    expect(await screen.findByText("Moved to Unscheduled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("leaves an event let go over the calendar to FullCalendar's move", async () => {
    const { api } = await setup();
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(300)));
    expect(api.callsTo(PATCH)).toHaveLength(0);
  });

  it("does not also move the event when the column lies over the days (a phone's sheet)", async () => {
    const { api } = await setup();
    const revert = vi.fn();
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(900)));
    // FullCalendar then reports a drop on the day under the sheet.
    act(() => fc.props.eventDrop!({ event: { ...event, start: new Date("2026-03-25"), end: new Date("2026-03-28"), allDay: true }, revert }));
    expect(revert).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect((api.callsTo(PATCH)[0]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values).toEqual({ f_start: null, f_end: null });
  });

  it("moves an event dropped on a day after an earlier drag that ended over the column", async () => {
    const { api } = await setup();
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(900)));
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(300)));
    act(() => fc.props.eventDrop!({ event: { ...event, start: new Date("2026-03-25"), end: new Date("2026-03-28"), allDay: true }, revert: vi.fn() }));
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(2));
    expect((api.callsTo(PATCH)[1]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values).toEqual({ f_start: "2026-03-25", f_end: "2026-03-27" });
  });

  it("does nothing for a viewer", async () => {
    const { api } = await setup("viewer");
    act(() => fc.props.eventDragStart!({ event }));
    act(() => fc.props.eventDragStop!(at(900)));
    expect(api.callsTo(PATCH)).toHaveLength(0);
  });

  it("ignores a record dropped from the column back onto the column", async () => {
    const { api } = await setup();
    const li = document.createElement("li");
    li.setAttribute("data-record-id", "r3");
    act(() => fc.props.drop!({ draggedEl: li, date: new Date("2026-03-25"), allDay: true, jsEvent: { clientX: 900, clientY: 100 } }));
    expect(api.callsTo(PATCH)).toHaveLength(0);
    act(() => fc.props.drop!({ draggedEl: li, date: new Date("2026-03-25"), allDay: true, jsEvent: { clientX: 300, clientY: 100 } }));
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(await screen.findByText("Scheduled for 25 Mar")).toBeInTheDocument();
  });
});
