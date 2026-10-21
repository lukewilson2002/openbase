import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DAY_MS, type Span } from "../common/wallTime";
import { BAR_HEIGHT, MILESTONE_SIZE, type DependencyEdge } from "./geometry";
import { TimelineChart, type ChartLane, type TimelineBar, type TimelineChartProps } from "./TimelineChart";

const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const ms = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const span = (s: number, e: number, over: Partial<Span> = {}): Span => ({ startMs: s, endMs: e, startDateOnly: true, hasEnd: true, ...over });

const AXIS = { fromDay: day(2026, 3, 1), toDay: day(2026, 6, 1), pxPerDay: 10 };

function bar(id: string, title: string, s: Span, over: Partial<TimelineBar> = {}): TimelineBar {
  return { id, title, span: s, canMove: true, canResize: s.hasEnd, ...over };
}

function chart(over: Partial<TimelineChartProps> = {}, lanes?: ChartLane[]) {
  const props: TimelineChartProps = {
    axis: AXIS,
    scale: "week",
    lanes: lanes ?? [
      {
        lane: { key: "a", label: "Platform", records: [] },
        bars: [bar("r1", "Design review", span(ms(2026, 3, 10), ms(2026, 3, 14))), bar("r2", "Ship it", span(ms(2026, 3, 20), ms(2026, 3, 21), { hasEnd: false }), { canResize: false })],
      },
      { lane: { key: "b", label: "Growth", records: [] }, bars: [bar("r3", "Launch", span(ms(2026, 3, 12), ms(2026, 3, 18)))] },
    ],
    edges: [],
    nowMs: ms(2026, 3, 15),
    showLabels: true,
    canCreate: true,
    focus: null,
    loading: false,
    onOpen: vi.fn(),
    onCommit: vi.fn(),
    onCreate: vi.fn(),
    onNeedMore: vi.fn(),
    onZoom: vi.fn(),
    onCenter: vi.fn(),
    ...over,
  };
  return { props, ...render(<TimelineChart {...props} />) };
}

describe("TimelineChart", () => {
  it("places bars by their dates: left from the start, width from the exclusive end", () => {
    chart();
    const b = screen.getByRole("button", { name: /^Design review/ });
    expect(b).toHaveStyle({ left: `${9 * AXIS.pxPerDay}px`, width: `${4 * AXIS.pxPerDay}px`, height: `${BAR_HEIGHT}px` });
    expect(b).not.toHaveAttribute("data-milestone");
  });

  it("draws a milestone diamond for a record without an end, centred on its day", () => {
    chart();
    const m = screen.getByRole("button", { name: /^Ship it/ });
    expect(m).toHaveAttribute("data-milestone", "true");
    expect(m).toHaveStyle({ width: `${MILESTONE_SIZE}px`, left: `${19 * AXIS.pxPerDay + AXIS.pxPerDay / 2 - MILESTONE_SIZE / 2}px` });
  });

  it("shows swimlane labels with counts, and no label column when told not to", () => {
    const { unmount } = chart();
    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("2 bars")).toBeInTheDocument();
    expect(screen.getByText("1 bar")).toBeInTheDocument();
    unmount();
    chart({ showLabels: false });
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
  });

  it("shows the today marker inside the window and the scale's tick labels", () => {
    const { unmount } = chart();
    // Day ticks: today's own tick becomes the pill.
    expect(document.querySelector("[data-today]")).toHaveTextContent("Sun 15");
    expect(screen.getByText("Week of Mar 9")).toBeInTheDocument(); // coarse row: weeks from Monday
    expect(screen.getByText("Mon 9")).toBeInTheDocument(); // fine row: days
    unmount();
    // Coarser scales have no day ticks, so the pill sits on today's line and says so.
    chart({ scale: "month" });
    expect(document.querySelector("[data-today]")).toHaveTextContent("Today");
    expect(screen.getByText("March 2026")).toBeInTheDocument();
  });

  it("leaves the today marker out when today is outside the window", () => {
    chart({ nowMs: ms(2027, 1, 1), scale: "month" });
    expect(document.querySelector("[data-today]")).toBeNull();
  });

  it("shades weekends where a day is wide enough to see them", () => {
    const { container, unmount } = chart();
    // March 2026 to May 2026 has 13 weekends (the axis starts on Sunday Mar 1, the tail of one).
    expect(container.querySelectorAll("[class*='--bg)_55%']").length).toBe(14);
    unmount();
    const coarse = chart({ scale: "quarter" });
    expect(coarse.container.querySelectorAll("[class*='--bg)_55%']").length).toBe(0);
  });

  it("names records in the left column and draws their bars with the given label", async () => {
    const user = userEvent.setup();
    const { props } = chart({ labelHeading: "Task" }, [
      { lane: { key: "r1", label: "Design review", records: [] }, recordId: "r1", sublabel: "Ada", bars: [bar("r1", "Design review", span(ms(2026, 3, 10), ms(2026, 3, 14)), { label: "Mar 10 – Mar 13" })] },
    ]);
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Design review, / })).toHaveTextContent("Mar 10 – Mar 13");
    await user.click(screen.getByRole("button", { name: "Design review" }));
    expect(props.onOpen).toHaveBeenCalledWith("r1");
  });

  it("draws dependency arrows, red when violated", () => {
    const edges: DependencyEdge[] = [
      { fromId: "r1", toId: "r3", violated: false },
      { fromId: "r3", toId: "r2", violated: true },
    ];
    const { container } = chart({ edges });
    const arrows = [...container.querySelectorAll("path[data-dependency]")];
    expect(arrows.map((a) => a.getAttribute("data-dependency"))).toEqual(["ok", "violated"]);
    expect(arrows[1]).toHaveAttribute("stroke", "var(--danger)");
    expect(arrows[0]!.getAttribute("d")).toMatch(/^M \d/);
  });

  it("selects a bar on a click, and opens it on a double-click or Enter", async () => {
    const user = userEvent.setup();
    const { props } = chart();
    const launch = screen.getByRole("button", { name: /^Launch/ });
    await user.click(launch);
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(launch).toHaveFocus();
    await user.dblClick(launch);
    expect(props.onOpen).toHaveBeenCalledWith("r3");
    screen.getByRole("button", { name: /^Ship it/ }).focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith("r2");
  });

  it("opens a bar it may not change on a click: there is nothing to select it for", async () => {
    const user = userEvent.setup();
    const { props } = chart({}, [{ lane: { key: "a", label: "A", records: [] }, bars: [bar("r1", "Locked", span(ms(2026, 3, 10), ms(2026, 3, 14)), { canMove: false, canResize: false })] }]);
    await user.click(screen.getByRole("button", { name: /^Locked/ }));
    expect(props.onOpen).toHaveBeenCalledWith("r1");
  });

  it("takes a selected bar off the timeline with Delete or Backspace, if it may move", async () => {
    const user = userEvent.setup();
    const onUnschedule = vi.fn();
    const { unmount } = chart({ onUnschedule });
    screen.getByRole("button", { name: /^Launch/ }).focus();
    await user.keyboard("{Delete}");
    expect(onUnschedule).toHaveBeenCalledWith("r3");
    screen.getByRole("button", { name: /^Ship it/ }).focus();
    await user.keyboard("{Backspace}");
    expect(onUnschedule).toHaveBeenLastCalledWith("r2");
    unmount();
    onUnschedule.mockClear();
    chart({ onUnschedule }, [{ lane: { key: "a", label: "A", records: [] }, bars: [bar("r1", "Locked", span(ms(2026, 3, 10), ms(2026, 3, 14)), { canMove: false, canResize: false })] }]);
    screen.getByRole("button", { name: /^Locked/ }).focus();
    await user.keyboard("{Delete}");
    expect(onUnschedule).not.toHaveBeenCalled();
  });

  it("takes a bar dropped on the unscheduled column off the timeline", () => {
    const zone = document.createElement("div");
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({ x: 500, y: 0, left: 500, top: 0, right: 700, bottom: 400, width: 200, height: 400, toJSON: () => ({}) } as DOMRect);
    const onUnschedule = vi.fn();
    const onOverUnschedule = vi.fn();
    const { props } = chart({ onUnschedule, onOverUnschedule, unscheduleZone: { current: zone } });
    const b = screen.getByRole("button", { name: /^Design review/ });
    fireEvent.pointerDown(b, { button: 0, clientX: 100, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 300, clientY: 20, pointerId: 1 });
    expect(onOverUnschedule).not.toHaveBeenCalled();
    fireEvent.pointerMove(b, { clientX: 600, clientY: 20, pointerId: 1 });
    expect(onOverUnschedule).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(b, { clientX: 600, clientY: 20, pointerId: 1 });
    expect(onUnschedule).toHaveBeenCalledWith("r1");
    expect(onOverUnschedule).toHaveBeenLastCalledWith(false);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("moves a bar by whole days when dragged and reports the commit", () => {
    const { props } = chart();
    const b = screen.getByRole("button", { name: /^Design review/ });
    fireEvent.pointerDown(b, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 134, pointerId: 1 }); // 34px = 3 days at 10px/day
    expect(b).toHaveStyle({ left: `${12 * AXIS.pxPerDay}px` }); // follows the pointer in whole days
    fireEvent.pointerUp(b, { clientX: 134, pointerId: 1 });
    expect(props.onCommit).toHaveBeenCalledWith("r1", "move", 3);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("resizes from the edges", () => {
    const { props } = chart();
    const b = screen.getByRole("button", { name: /^Design review/ });
    const endHandle = b.querySelector("[data-handle='end']")!;
    fireEvent.pointerDown(endHandle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 520, pointerId: 1 });
    fireEvent.pointerUp(b, { clientX: 520, pointerId: 1 });
    expect(props.onCommit).toHaveBeenCalledWith("r1", "end", 2);

    const startHandle = b.querySelector("[data-handle='start']")!;
    fireEvent.pointerDown(startHandle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 470, pointerId: 1 });
    fireEvent.pointerUp(b, { clientX: 470, pointerId: 1 });
    expect(props.onCommit).toHaveBeenLastCalledWith("r1", "start", -3);
  });

  it("does not drag a read-only bar, and has no resize handles on milestones", () => {
    const { props } = chart({}, [{ lane: { key: "a", label: "A", records: [] }, bars: [bar("r1", "Locked", span(ms(2026, 3, 10), ms(2026, 3, 14)), { canMove: false, canResize: false })] }]);
    const b = screen.getByRole("button", { name: /^Locked/ });
    expect(b.querySelector("[data-handle]")).toBeNull();
    fireEvent.pointerDown(b, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(b, { clientX: 160, pointerId: 1 });
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Locked/ })).toHaveStyle({ left: `${9 * AXIS.pxPerDay}px` });
  });

  it("moves with the arrow keys and resizes the end with Shift", async () => {
    const user = userEvent.setup();
    const { props } = chart();
    screen.getByRole("button", { name: /^Design review/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onCommit).toHaveBeenLastCalledWith("r1", "move", 1);
    await user.keyboard("{ArrowLeft}");
    expect(props.onCommit).toHaveBeenLastCalledWith("r1", "move", -1);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(props.onCommit).toHaveBeenLastCalledWith("r1", "end", 1);
    // A milestone cannot resize.
    screen.getByRole("button", { name: /^Ship it/ }).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(props.onCommit).toHaveBeenCalledTimes(3);
  });

  it("creates a record by dragging across empty lane space (days, either direction)", () => {
    const { props, container } = chart();
    const lane = container.querySelector("[data-lane='b']")!;
    // The chart's left edge is at x = 0 in jsdom, so a pointer at x = 45 is day index 4 (Mar 5).
    fireEvent.pointerDown(lane, { button: 0, clientX: 45, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 15, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 15, pointerId: 1 });
    expect(props.onCreate).toHaveBeenCalledWith("b", AXIS.fromDay + 4, AXIS.fromDay + 1);
  });

  it("ignores a plain click on a lane and does not create when creating is disabled", () => {
    const first = chart();
    const lane = first.container.querySelector("[data-lane='a']")!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 45, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 45, pointerId: 1 });
    expect(first.props.onCreate).not.toHaveBeenCalled();
    first.unmount();

    const off = chart({ canCreate: false });
    const l2 = off.container.querySelector("[data-lane='a']")!;
    fireEvent.pointerDown(l2, { button: 0, clientX: 45, pointerId: 1 });
    fireEvent.pointerMove(l2, { clientX: 95, pointerId: 1 });
    fireEvent.pointerUp(l2, { clientX: 95, pointerId: 1 });
    expect(off.props.onCreate).not.toHaveBeenCalled();
  });

  it("asks for more days when scrolled near an edge", () => {
    const { props } = chart();
    const scroller = screen.getByTestId("timeline-scroller");
    // jsdom has no layout: scrollLeft 0 is "near the start".
    fireEvent.scroll(scroller);
    expect(props.onNeedMore).toHaveBeenCalledWith("start");
  });

  it("reports the centre day and shows an empty note when nothing is in range", () => {
    const { props } = chart({}, [{ lane: { key: "", label: "", records: [] }, bars: [] }]);
    expect(props.onCenter).toHaveBeenCalled();
    expect(screen.getByText(/No records with dates in this range/)).toBeInTheDocument();
  });

  it("zooms with Ctrl+wheel", () => {
    const { props } = chart();
    const scroller = screen.getByTestId("timeline-scroller");
    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: -100 });
    expect(props.onZoom).toHaveBeenCalledWith("in");
  });

  it("keeps the chart steady when the window grows to the left", () => {
    const { rerender, props } = chart();
    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollLeft = 300;
    fireEvent.scroll(scroller); // the browser reports where the user scrolled to
    const wider = { ...props, axis: { ...AXIS, fromDay: AXIS.fromDay - 50 } };
    rerender(<TimelineChart {...wider} />);
    expect(scroller.scrollLeft).toBe(300 + 50 * AXIS.pxPerDay);
  });
});
