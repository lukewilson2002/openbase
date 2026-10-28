/**
 * People who cannot save a view (viewers, commenters, editors of a locked view) can still filter,
 * sort and group in every view type: the override travels with each query, is marked "Not saved"
 * and can be reset. The grid has its own tests (useViewConfig, useGridData); these cover the views
 * that share ViewFrame, useViewRecords and the gallery's paged query.
 */
import type { ComponentType } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "@/api/types";
import { installBoardLayout, type BoardLayout } from "../kanban/boardLayout";
import CalendarView from "../calendar/CalendarView";
import GalleryView from "../gallery/GalleryView";
import KanbanView from "../kanban/KanbanView";
import ListView from "../list/ListView";
import TimelineView from "../timeline/TimelineView";
import type { ViewProps } from "../types";
import { F, projectSchema, queryHandler, rec, renderView, viewWithConfig } from "./viewTestUtils";

let layout: BoardLayout;
beforeEach(() => {
  layout = installBoardLayout();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-12T12:00:00Z") });
});
afterEach(() => {
  layout.restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const records = [rec("r1", { [F.start.id]: "2026-03-10", [F.status.id]: "s1" }), rec("r2", { [F.start.id]: "2026-03-11" })];

const CASES: [string, ComponentType<ViewProps>, ReturnType<typeof viewWithConfig>][] = [
  ["kanban", KanbanView, viewWithConfig("viw1", "kanban", { kanban: { stack_field_id: F.status.id, cover_field_id: null, hide_empty_stacks: false, stack_order: [], hidden_stacks: [], show_all_people: false, cover_fit: false } })],
  ["gallery", GalleryView, viewWithConfig("viw1", "gallery", { gallery: { cover_field_id: null, cover_crop: false } })],
  ["calendar", CalendarView, viewWithConfig("viw1", "calendar", { calendar: { date_field_id: F.start.id, end_field_id: null } })],
  ["timeline", TimelineView, viewWithConfig("viw1", "timeline", { timeline: { start_field_id: F.start.id, end_field_id: null, group_field_id: null, dependency_field_id: null, scale: "week" } })],
  ["list", ListView, viewWithConfig("viw1", "list", {})],
];

function setup(Component: ComponentType<ViewProps>, view: ReturnType<typeof viewWithConfig>, role: string) {
  const asked: QueryRequest[] = [];
  const rendered = renderView(Component, { schema: projectSchema(role, [view]), viewId: "viw1", routes: { "POST /api/views/viw1/query": queryHandler({ records }, asked) } as never });
  return { asked, ...rendered };
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

/**
 * The calendar's unscheduled column and the timeline's "without a date" count ask with a transient
 * "start is empty" filter of their own; these tests are about the viewer's override, so they skip those.
 */
const viewerQueries = (asked: QueryRequest[]) => asked.filter((a) => !a.transient?.filter?.items.some((i) => "op" in i && i.op === "is_empty"));

describe.each(CASES)("%s view without save rights", (_name, Component, view) => {
  it("sends a sort as a transient override, marks it Not saved and resets it", async () => {
    const u = user();
    const { asked, api } = setup(Component, view, "viewer");
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(viewerQueries(asked).every((a) => !a.transient)).toBe(true);
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: /Sort/ }));
    await u.click(await screen.findByRole("button", { name: "Add sort" }));
    await waitFor(() => expect(viewerQueries(asked).some((a) => a.transient?.sorts?.length === 1)).toBe(true));
    expect(viewerQueries(asked).find((a) => a.transient)!.transient).toEqual({ sorts: [{ field_id: expect.any(String) as string, direction: "asc" }] });
    expect(await screen.findByText("Not saved")).toBeInTheDocument();
    // The override is never saved to the view.
    expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(0);

    const before = viewerQueries(asked).length;
    await u.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(viewerQueries(asked).length).toBeGreaterThan(before));
    expect(viewerQueries(asked).at(-1)!.transient).toBeUndefined();
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });

  it("does not use a transient override for editors, who save the view instead", async () => {
    const u = user();
    const { asked, api } = setup(Component, view, "editor");
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await u.click(screen.getByRole("button", { name: /Sort/ }));
    await u.click(await screen.findByRole("button", { name: "Add sort" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/views/viw1")).toHaveLength(1));
    expect(viewerQueries(asked).every((a) => !a.transient)).toBe(true);
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });
});
