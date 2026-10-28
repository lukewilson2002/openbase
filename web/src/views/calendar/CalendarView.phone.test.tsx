import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "../common/viewTestUtils";
import CalendarView from "./CalendarView";

// A phone: no query matches (the desktop one least of all).
vi.mock("@/hooks/useMediaQuery", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/hooks/useMediaQuery")>()), useMediaQuery: () => false }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

const view = viewWithConfig("viw1", "calendar", { calendar: { date_field_id: F.start.id, end_field_id: F.end.id } });
const records = [rec("r1", { [F.start.id]: "2026-03-10" }), rec("r3", {})];

function setup(routes: Record<string, unknown> = {}) {
  return renderView(CalendarView, { schema: projectSchema("editor", [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }), ...routes } as never });
}

describe("CalendarView on a phone", () => {
  it("keeps the unscheduled records in a pill until asked, so the month keeps the whole width", async () => {
    setup();
    await screen.findByText("R1");
    expect(screen.queryByRole("complementary", { name: "Unscheduled records" })).not.toBeInTheDocument();
    const pill = await screen.findByRole("button", { name: "Show unscheduled records, 1" });
    expect(pill).toHaveClass("absolute");
  });

  it("opens them as a sheet under the calendar rather than a column beside it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup();
    await user.click(await screen.findByRole("button", { name: /^Show unscheduled records/ }));
    const sheet = await screen.findByRole("complementary", { name: "Unscheduled records" });
    expect(sheet).toHaveAttribute("data-stacked");
    expect(sheet).toHaveClass("max-h-[40%]");
    expect(sheet).not.toHaveClass("w-52");
    expect(await within(sheet).findByText("R3")).toBeInTheDocument();
    expect(within(sheet).getByText(/Hold a record/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Hide unscheduled records" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Unscheduled records" })).not.toBeInTheDocument());
  });

  it("adds on the month on screen, not on today", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const made = rec("rnew", {});
    const api = setup({ "POST /api/tables/tbl1/records": { records: [made] }, "GET /api/tables/tbl1/records/rnew": made });
    await screen.findByText("March 2026");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await screen.findByText("April 2026");
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await waitFor(() => expect(api.api.callsTo("POST /api/tables/tbl1/records")).toHaveLength(1));
    expect((api.api.callsTo("POST /api/tables/tbl1/records")[0]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values).toMatchObject({ f_start: "2026-04-01" });
  });
});
