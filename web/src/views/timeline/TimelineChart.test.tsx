import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY_MS } from "../common/wallTime";
import { BAR_HEIGHT, MILESTONE_SIZE, type DependencyEdge, type TimelineSpan } from "./geometry";
import { TimelineChart, type ChartLane, type TimelineBar, type TimelineChartProps } from "./TimelineChart";

const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const ms = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const span = (s: number, e: number, over: Partial<TimelineSpan> = {}): TimelineSpan => ({ startMs: s, endMs: e, startDateOnly: true, hasEnd: true, ...over });

const AXIS = { fromDay: day(2026, 3, 1), toDay: day(2026, 6, 1), pxPerDay: 10 };

function bar(id: string, title: string, s: TimelineSpan, over: Partial<TimelineBar> = {}): TimelineBar {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rectOf = (left: number, right: number) => ({ x: left, y: 0, left, top: 0, right, bottom: 400, width: right - left, height: 400, toJSON: () => ({}) }) as DOMRect;

/** Animation frames run by hand; the layer is placed where the scroll has taken it, as a browser would. */
function manualFrames(scroller: HTMLElement, layerEl: HTMLElement) {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rectOf(0, 400));
  vi.spyOn(layerEl, "getBoundingClientRect").mockImplementation(() => rectOf(-scroller.scrollLeft, 0));
  let t = 1000;
  return () => {
    const f = frames.shift();
    if (f) f((t += 16));
  };
}

function coarsePointer() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) => ({ matches: q === "(pointer: coarse)", media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList,
  );
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

  it("deletes the record of a selected bar with Delete or Backspace, and takes it off the timeline with U", async () => {
    const user = userEvent.setup();
    const onUnschedule = vi.fn();
    const onDelete = vi.fn();
    const { unmount } = chart({ onUnschedule, onDelete });
    screen.getByRole("button", { name: /^Launch/ }).focus();
    await user.keyboard("{Delete}");
    expect(onDelete).toHaveBeenCalledWith("r3");
    screen.getByRole("button", { name: /^Ship it/ }).focus();
    await user.keyboard("{Backspace}");
    expect(onDelete).toHaveBeenLastCalledWith("r2");
    expect(onUnschedule).not.toHaveBeenCalled();
    await user.keyboard("u");
    expect(onUnschedule).toHaveBeenCalledWith("r2");
    unmount();
    onUnschedule.mockClear();
    chart({ onUnschedule }, [{ lane: { key: "a", label: "A", records: [] }, bars: [bar("r1", "Locked", span(ms(2026, 3, 10), ms(2026, 3, 14)), { canMove: false, canResize: false })] }]);
    screen.getByRole("button", { name: /^Locked/ }).focus();
    await user.keyboard("{Delete}u");
    expect(onUnschedule).not.toHaveBeenCalled();
  });

  it("gives a milestone an end handle, and repairs a reversed end by dragging it", () => {
    const onCommit = vi.fn();
    chart({ onCommit }, [
      {
        lane: { key: "a", label: "A", records: [] },
        bars: [
          bar("m1", "Start only", span(ms(2026, 3, 10), ms(2026, 3, 11), { hasEnd: false }), { canResize: true }),
          bar("m2", "Backwards", span(ms(2026, 3, 20), ms(2026, 3, 21), { hasEnd: false, reversed: true }), { canResize: true, hint: "Its end is before its start." }),
        ],
      },
    ]);
    const m1 = screen.getByRole("button", { name: /^Start only/ });
    expect(m1.querySelector("[data-handle=end]")).not.toBeNull();
    expect(m1.querySelector("[data-handle=start]")).toBeNull();
    const m2 = screen.getByRole("button", { name: /^Backwards.*Its end is before its start/ });
    expect(m2).toHaveAttribute("data-invalid", "true");
    const handle = m2.querySelector("[data-handle=end]")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(m2, { clientX: 104, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(m2, { clientX: 104, clientY: 20, pointerId: 1 });
    // Not a day away, but the bar has no valid end: it is written.
    expect(onCommit).toHaveBeenCalledWith("m2", "end", 0);
  });

  it("draws the ghost of a new record as one day when only the first day is saved", () => {
    const { container } = chart({ createSpansDays: false });
    const lane = container.querySelector("[data-lane=a]")!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 300, pointerId: 1 });
    const ghost = container.querySelector(".border-dashed") as HTMLElement;
    expect(ghost.style.width).toBe(`${AXIS.pxPerDay}px`);
  });

  it("says what can be done when there are no bars, and names the today line", () => {
    const { rerender, props } = chart({}, []);
    expect(screen.getByRole("status")).toHaveTextContent("No records with dates in this range. Drag across a lane to add one.");
    rerender(<TimelineChart {...props} lanes={[]} canCreate={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^No records with dates in this range\.$/);
    rerender(<TimelineChart {...props} lanes={[]} emptyMessage="Nothing here, but a record is far away." />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing here, but a record is far away.");
    expect(screen.getByRole("img", { name: "Today" })).toBeInTheDocument();
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

  describe("dragging near the edge", () => {
    it("scrolls the chart while a bar is held near its edge, and counts the days it scrolled", () => {
      const { props } = chart();
      const scroller = screen.getByTestId("timeline-scroller");
      const b = screen.getByRole("button", { name: /^Design review/ });
      const frame = manualFrames(scroller, b.parentElement!);
      fireEvent.pointerDown(b, { button: 0, clientX: 200, pointerId: 1 });
      fireEvent.pointerMove(b, { clientX: 390, pointerId: 1 }); // 19 days on, and near the right edge
      frame();
      frame();
      expect(scroller.scrollLeft).toBeGreaterThan(10);
      // The pointer has not moved since, yet the bar is further: the days under the pointer changed.
      fireEvent.pointerUp(b, { clientX: 390, pointerId: 1 });
      const days = (props.onCommit as ReturnType<typeof vi.fn>).mock.calls[0]![2] as number;
      expect(days).toBeGreaterThan(19);
      // Let go: nothing scrolls any more.
      const at = scroller.scrollLeft;
      frame();
      frame();
      expect(scroller.scrollLeft).toBe(at);
    });

    it("scrolls toward the start at the left edge, past the label column's end", () => {
      const { props } = chart();
      const scroller = screen.getByTestId("timeline-scroller");
      scroller.scrollLeft = 200;
      const b = screen.getByRole("button", { name: /^Design review/ });
      const frame = manualFrames(scroller, b.parentElement!);
      fireEvent.pointerDown(b, { button: 0, clientX: 300, pointerId: 1 });
      fireEvent.pointerMove(b, { clientX: 140, pointerId: 1 }); // the chart starts at 132, after the label column
      frame();
      expect(scroller.scrollLeft).toBeLessThan(200);
      fireEvent.pointerUp(b, { clientX: 140, pointerId: 1 });
      expect((props.onCommit as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeLessThan(-16);
    });

    it("stays put in the middle of the chart", () => {
      chart();
      const scroller = screen.getByTestId("timeline-scroller");
      const b = screen.getByRole("button", { name: /^Design review/ });
      const frame = manualFrames(scroller, b.parentElement!);
      fireEvent.pointerDown(b, { button: 0, clientX: 200, pointerId: 1 });
      fireEvent.pointerMove(b, { clientX: 260, pointerId: 1 });
      frame();
      expect(scroller.scrollLeft).toBe(0);
    });

    it("scrolls while a new record is dragged out across the days", () => {
      const { props, container } = chart();
      const scroller = screen.getByTestId("timeline-scroller");
      const lane = container.querySelector("[data-lane='b']")!;
      const frame = manualFrames(scroller, screen.getByRole("button", { name: /^Launch/ }).parentElement!);
      fireEvent.pointerDown(lane, { button: 0, clientX: 150, pointerId: 1 });
      fireEvent.pointerMove(lane, { clientX: 395, pointerId: 1 });
      frame();
      frame();
      fireEvent.pointerUp(lane, { clientX: 395, pointerId: 1 });
      const [, from, to] = (props.onCreate as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, number, number];
      expect(from).toBe(AXIS.fromDay + 15);
      expect(to).toBeGreaterThan(AXIS.fromDay + 39);
    });
  });

  describe("resize handles", () => {
    it("are 6px wide for a mouse and sit inside a wide bar", () => {
      chart();
      const b = screen.getByRole("button", { name: /^Design review/ });
      expect(b.querySelector("[data-handle=start]")).toHaveStyle({ left: "0px", width: "6px" });
      expect(b.querySelector("[data-handle=end]")).toHaveStyle({ right: "0px", width: "6px" });
    });

    it("are bigger for a finger, and stand outside a narrow bar so its body can still be grabbed to move it", () => {
      coarsePointer();
      const { props } = chart({}, [{ lane: { key: "a", label: "A", records: [] }, bars: [bar("n1", "Narrow", span(ms(2026, 3, 10), ms(2026, 3, 11)))] }]);
      const b = screen.getByRole("button", { name: /^Narrow/ });
      expect(b.querySelector("[data-handle=start]")).toHaveStyle({ left: "-20px", width: "20px" });
      expect(b.querySelector("[data-handle=end]")).toHaveStyle({ right: "-20px", width: "20px" });
      // Pressing the bar itself moves it.
      fireEvent.pointerDown(b, { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(b, { clientX: 130, pointerId: 1 });
      fireEvent.pointerUp(b, { clientX: 130, pointerId: 1 });
      expect(props.onCommit).toHaveBeenCalledWith("n1", "move", 3);
    });
  });

  describe("keyboard", () => {
    it("opens a bar with Space as well as Enter", async () => {
      const user = userEvent.setup();
      const { props } = chart();
      screen.getByRole("button", { name: /^Launch/ }).focus();
      await user.keyboard(" ");
      expect(props.onOpen).toHaveBeenCalledWith("r3");
    });

    it("moves the start edge with Alt+Shift+Left or Right, not for a bar that cannot resize", async () => {
      const user = userEvent.setup();
      const { props } = chart();
      screen.getByRole("button", { name: /^Design review/ }).focus();
      await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
      expect(props.onCommit).toHaveBeenLastCalledWith("r1", "start", -1);
      await user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
      expect(props.onCommit).toHaveBeenLastCalledWith("r1", "start", 1);
      // Alt alone is the browser's (back), and moves nothing.
      await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
      expect(props.onCommit).toHaveBeenCalledTimes(2);
      screen.getByRole("button", { name: /^Ship it/ }).focus();
      await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
      expect(props.onCommit).toHaveBeenCalledTimes(2);
    });

    it("goes to today with T, zooms with + and -, and pages with [ and ]", async () => {
      const user = userEvent.setup();
      const onToday = vi.fn();
      const { props } = chart({ onToday });
      screen.getByRole("button", { name: /^Launch/ }).focus();
      await user.keyboard("t");
      expect(onToday).toHaveBeenCalledTimes(1);
      await user.keyboard("+");
      expect(props.onZoom).toHaveBeenLastCalledWith("in");
      await user.keyboard("-");
      expect(props.onZoom).toHaveBeenLastCalledWith("out");
      const scroller = screen.getByTestId("timeline-scroller");
      scroller.scrollTo = vi.fn() as never;
      await user.keyboard("]");
      expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
      // Typing in a field inside the chart is not a shortcut.
      onToday.mockClear();
      const input = document.createElement("input");
      scroller.appendChild(input);
      input.focus();
      await user.keyboard("t");
      expect(onToday).not.toHaveBeenCalled();
    });

    it("names the chart and says its keys", () => {
      chart({ onLink: vi.fn() });
      const region = screen.getByRole("region", { name: "Timeline" });
      expect(region).toHaveAccessibleDescription(/T goes to today.*Alt and Shift.*L starts a dependency/);
    });

    it("adds a record to a lane from a button that is out of sight until it is tabbed to", async () => {
      const user = userEvent.setup();
      const { props } = chart();
      await user.click(screen.getByRole("button", { name: "Add a record to Growth" }));
      const today = day(2026, 3, 15);
      expect(props.onCreate).toHaveBeenCalledWith("b", today, today);
      expect(screen.getByRole("button", { name: "Add a record to Growth" })).toHaveClass("opacity-0");
    });

    it("has no add button in a lane where records cannot be created", () => {
      chart({ canCreate: false });
      expect(screen.queryByRole("button", { name: /^Add a record to/ })).toBeNull();
    });
  });

  describe("dependencies", () => {
    const connector = (name: RegExp, side: "start" | "end") => screen.getByRole("button", { name }).querySelector(`[data-connector=${side}]`)!;
    // r1 (Mar 10-13) is on row 0 of lane a; r3 (Mar 12-17) is the only bar of lane b, one lane (46px) down.
    const dragConnector = (el: Element, to: { x: number; y: number }) => {
      fireEvent.pointerDown(el, { button: 0, clientX: 140, clientY: 14, pointerId: 1 });
      fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, pointerId: 1 });
      return () => fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1 });
    };

    it("shows no connectors unless dependencies can be made", () => {
      chart();
      expect(document.querySelector("[data-connector]")).toBeNull();
    });

    it("makes the bar it is dropped on come after the bar it was dragged from (end connector)", () => {
      const onLink = vi.fn();
      const { container } = chart({ onLink });
      const up = dragConnector(connector(/^Design review/, "end"), { x: 150, y: 70 });
      // The link is drawn to the pointer, and the bar it would join is marked.
      expect(container.querySelector("[data-link-preview]")).not.toBeNull();
      expect(screen.getByRole("button", { name: /^Launch/ })).toHaveAttribute("data-link-target");
      up();
      expect(onLink).toHaveBeenCalledWith("r1", "r3");
      expect(container.querySelector("[data-link-preview]")).toBeNull();
    });

    it("makes the bar it is dropped on come before this one (start connector)", () => {
      const onLink = vi.fn();
      chart({ onLink });
      dragConnector(connector(/^Launch/, "start"), { x: 110, y: 14 })();
      expect(onLink).toHaveBeenCalledWith("r1", "r3");
    });

    it("does nothing when dropped on empty space, on itself, on an existing dependency, or where it would make a loop", () => {
      const onLink = vi.fn();
      const edges: DependencyEdge[] = [{ fromId: "r1", toId: "r3", violated: false }];
      chart({ onLink, edges });
      dragConnector(connector(/^Design review/, "end"), { x: 600, y: 14 })(); // empty space
      dragConnector(connector(/^Design review/, "end"), { x: 130, y: 14 })(); // itself
      dragConnector(connector(/^Design review/, "end"), { x: 150, y: 70 })(); // already so
      dragConnector(connector(/^Launch/, "end"), { x: 130, y: 14 })(); // r3 -> r1 would loop
      expect(onLink).not.toHaveBeenCalled();
    });

    it("does not move the bar when its connector is pressed", () => {
      const onCommit = vi.fn();
      chart({ onLink: vi.fn(), onCommit });
      dragConnector(connector(/^Design review/, "end"), { x: 400, y: 14 })();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("makes a dependency from the keyboard: L on the first bar, Enter on the one that comes after", async () => {
      const user = userEvent.setup();
      const onLink = vi.fn();
      const { props } = chart({ onLink, edges: [{ fromId: "r3", toId: "r2", violated: false }] });
      screen.getByRole("button", { name: /^Design review/ }).focus();
      await user.keyboard("l");
      expect(screen.getByText(/Design review comes first/)).toBeInTheDocument();
      screen.getByRole("button", { name: /^Launch/ }).focus();
      await user.keyboard("{Enter}");
      expect(onLink).toHaveBeenCalledWith("r1", "r3");
      expect(props.onOpen).not.toHaveBeenCalled();
      expect(screen.queryByText(/comes first/)).toBeNull();
      // A refused pair says why; Escape gives up.
      screen.getByRole("button", { name: /^Ship it/ }).focus();
      await user.keyboard("l");
      screen.getByRole("button", { name: /^Launch/ }).focus();
      await user.keyboard(" ");
      expect(screen.getByText(/can't come after Ship it/)).toBeInTheDocument();
      expect(onLink).toHaveBeenCalledTimes(1);
      screen.getByRole("button", { name: /^Design review/ }).focus();
      await user.keyboard("l{Escape}");
      screen.getByRole("button", { name: /^Launch/ }).focus();
      await user.keyboard("{Enter}");
      expect(props.onOpen).toHaveBeenCalledWith("r3");
    });

    it("selects an arrow with a click, removes it from its button, and says what it joins", async () => {
      const user = userEvent.setup();
      const onUnlink = vi.fn();
      const edges: DependencyEdge[] = [{ fromId: "r1", toId: "r3", violated: true }];
      const { container } = chart({ onUnlink, edges });
      const hit = container.querySelector("[data-dependency-hit]")!;
      expect(hit).toHaveAccessibleName("Launch comes after Design review, but they overlap. Delete removes this dependency.");
      expect(screen.queryByRole("button", { name: /^Remove dependency/ })).toBeNull();
      await user.click(hit);
      expect(container.querySelector("path[data-dependency][data-selected]")).not.toBeNull();
      await user.click(screen.getByRole("button", { name: /^Remove dependency: Launch comes after Design review/ }));
      expect(onUnlink).toHaveBeenCalledWith("r1", "r3");
      expect(screen.queryByRole("button", { name: /^Remove dependency/ })).toBeNull();
    });

    it("removes the dependency of a focused arrow with Delete, and leaves arrows alone when it cannot", async () => {
      const user = userEvent.setup();
      const onUnlink = vi.fn();
      const edges: DependencyEdge[] = [{ fromId: "r1", toId: "r3", violated: false }];
      const { container, unmount } = chart({ onUnlink, edges });
      (container.querySelector("[data-dependency-hit]") as SVGElement).focus();
      await user.keyboard("{Delete}");
      expect(onUnlink).toHaveBeenCalledWith("r1", "r3");
      unmount();
      const plain = chart({ edges });
      expect(plain.container.querySelector("[data-dependency-hit]")).toBeNull();
      expect(plain.container.querySelectorAll("path[data-dependency]")).toHaveLength(1);
    });
  });
});
