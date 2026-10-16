import { describe, expect, it } from "vitest";
import { DAY_MS, type Span } from "../common/wallTime";
import {
  PX_PER_DAY,
  arrowPath,
  axisWidth,
  barRect,
  centerDayOf,
  dayAtX,
  dayNumber,
  dependencyEdges,
  dragDays,
  dragSpan,
  extendAxis,
  layoutLanes,
  majorTicks,
  makeAxis,
  minorIsDay,
  minorTicks,
  rangeTitle,
  showsWeekends,
  weekendStarts,
  windowStart,
  packRows,
  stepScale,
  xOfDay,
  xOfMs,
  ROW_HEIGHT,
  LANE_PAD,
  MILESTONE_SIZE,
} from "./geometry";

const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const ms = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const span = (startMs: number, endMs: number, over: Partial<Span> = {}): Span => ({ startMs, endMs, startDateOnly: true, hasEnd: true, ...over });

describe("axis", () => {
  const axis = { fromDay: day(2026, 3, 1), toDay: day(2026, 4, 1), pxPerDay: 10 };

  it("maps wall time to pixels and back", () => {
    expect(xOfMs(ms(2026, 3, 1), axis)).toBe(0);
    expect(xOfMs(ms(2026, 3, 11), axis)).toBe(100);
    expect(xOfMs(ms(2026, 3, 1, 12), axis)).toBe(5);
    expect(xOfDay(day(2026, 3, 3), axis)).toBe(20);
    expect(dayAtX(25, axis)).toBe(day(2026, 3, 3));
    expect(dayAtX(-1, axis)).toBe(day(2026, 2, 28));
    expect(axisWidth(axis)).toBe(310);
    expect(dayNumber(ms(2026, 3, 1, 23))).toBe(day(2026, 3, 1));
  });

  it("centres windows on a day for every scale and extends them", () => {
    for (const s of ["day", "week", "month", "quarter", "year"] as const) {
      const a = makeAxis(s, day(2026, 6, 15));
      expect(a.pxPerDay).toBe(PX_PER_DAY[s]);
      expect((a.fromDay + a.toDay) / 2).toBe(day(2026, 6, 15));
      const wider = extendAxis(a, "end", s);
      expect(wider.fromDay).toBe(a.fromDay);
      expect(wider.toDay).toBeGreaterThan(a.toDay);
      expect(extendAxis(a, "start", s).fromDay).toBeLessThan(a.fromDay);
    }
    const a = makeAxis("week", day(2026, 6, 15));
    expect(centerDayOf(0, 2 * a.pxPerDay * 10, a)).toBeCloseTo(a.fromDay + 10);
  });

  it("steps scales and stops at the ends", () => {
    expect(stepScale("week", "in")).toBe("day");
    expect(stepScale("week", "out")).toBe("month");
    expect(stepScale("day", "in")).toBe("day");
    expect(stepScale("year", "out")).toBe("year");
  });
});

describe("ticks", () => {
  it("day and week scales: a tick per day under a tick per week, weeks starting on Monday", () => {
    const a = { fromDay: day(2026, 2, 27), toDay: day(2026, 3, 3) };
    expect(minorTicks("day", a).map((t) => t.label)).toEqual(["Fri 27", "Sat 28", "Sun 1", "Mon 2"]);
    expect(minorTicks("week", a).map((t) => t.label)).toEqual(["Fri 27", "Sat 28", "Sun 1", "Mon 2"]);
    const major = majorTicks("week", a);
    expect(major.map((t) => t.label)).toEqual(["Week of Feb 23", "Week of Mar 2"]);
    expect(major[0]).toMatchObject({ startDay: day(2026, 2, 23), endDay: day(2026, 3, 2) });
    expect(majorTicks("day", a).map((t) => t.label)).toEqual(["Week of Feb 23", "Week of Mar 2"]);
    expect(minorIsDay("week")).toBe(true);
    expect(minorIsDay("month")).toBe(false);
  });

  it("month scale: weeks under months", () => {
    const ticks = minorTicks("month", { fromDay: day(2026, 3, 4), toDay: day(2026, 3, 20) }); // Wed 4th .. Fri 20th
    expect(ticks.map((t) => t.label)).toEqual(["Mar 2", "Mar 9", "Mar 16"]);
    expect(ticks.every((t) => t.endDay - t.startDay === 7)).toBe(true);
    expect(majorTicks("month", { fromDay: day(2026, 2, 20), toDay: day(2026, 3, 20) }).map((t) => t.label)).toEqual(["February 2026", "March 2026"]);
  });

  it("quarter and year scales: months under quarters or years", () => {
    const a = { fromDay: day(2025, 11, 20), toDay: day(2026, 7, 2) };
    expect(minorTicks("quarter", a).map((t) => t.label)).toEqual(["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"]);
    expect(majorTicks("quarter", a).map((t) => t.label)).toEqual(["Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026"]);
    expect(minorTicks("year", a).map((t) => t.label)).toEqual(["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"]);
    expect(majorTicks("year", a).map((t) => t.label)).toEqual(["2025", "2026"]);
  });

  it("finds the weekends in a window, including one that started the day before", () => {
    // Sun Mar 1 .. Sun Mar 15: the weekend of Feb 28, Mar 7 and Mar 14.
    expect(weekendStarts({ fromDay: day(2026, 3, 1), toDay: day(2026, 3, 16) })).toEqual([day(2026, 2, 28), day(2026, 3, 7), day(2026, 3, 14)]);
    expect(showsWeekends("week")).toBe(true);
    expect(showsWeekends("quarter")).toBe(false);
  });

  it("opens a window on the start of the period just before today, keeping today in view", () => {
    // Thursday Oct 15 2026 on the week scale with two weeks on screen: last week's Monday.
    expect(windowStart("week", day(2026, 10, 15), 14)).toBe(day(2026, 10, 5));
    // A narrow screen (five days) would lose today that way, so it opens on this week's Monday.
    expect(windowStart("week", day(2026, 10, 15), 5)).toBe(day(2026, 10, 12));
    // Starting at September would leave mid-October off a 40-day screen.
    expect(windowStart("month", day(2026, 10, 15), 40)).toBe(day(2026, 10, 1));
    expect(windowStart("month", day(2026, 10, 15), 60)).toBe(day(2026, 9, 1));
  });

  it("titles a range of days compactly", () => {
    expect(rangeTitle(day(2026, 10, 5), day(2026, 10, 18))).toBe("Oct 5 – 18, 2026");
    expect(rangeTitle(day(2026, 9, 28), day(2026, 10, 11))).toBe("Sep 28 – Oct 11, 2026");
    expect(rangeTitle(day(2026, 12, 28), day(2027, 1, 10))).toBe("Dec 28, 2026 – Jan 10, 2027");
    expect(rangeTitle(day(2026, 10, 5), day(2026, 10, 5))).toBe("Oct 5, 2026");
  });
});

describe("barRect", () => {
  const a = { fromDay: day(2026, 3, 1), toDay: day(2026, 4, 1), pxPerDay: 10 };

  it("spans start to exclusive end, with a minimum width", () => {
    expect(barRect(span(ms(2026, 3, 2), ms(2026, 3, 5)), a)).toEqual({ x: 10, width: 30, milestone: false });
    expect(barRect(span(ms(2026, 3, 2), ms(2026, 3, 2) + 1), a).width).toBeGreaterThanOrEqual(8);
  });

  it("draws a milestone diamond, centred in the day for date-only starts", () => {
    expect(barRect(span(ms(2026, 3, 2), ms(2026, 3, 3), { hasEnd: false }), a)).toEqual({ x: 10 + 5 - MILESTONE_SIZE / 2, width: MILESTONE_SIZE, milestone: true });
    expect(barRect(span(ms(2026, 3, 2, 12), ms(2026, 3, 2, 12), { hasEnd: false, startDateOnly: false }), a).x).toBe(15 - MILESTONE_SIZE / 2);
  });
});

describe("dragging", () => {
  const a = { fromDay: 0, toDay: 100, pxPerDay: 10 };
  const bar = span(ms(2026, 3, 10), ms(2026, 3, 13)); // Mar 10-12

  it("snaps pixel movement to whole days", () => {
    expect(dragDays(24, a)).toBe(2);
    expect(dragDays(-26, a)).toBe(-3);
    expect(dragDays(4, a)).toBe(0);
  });

  it("moves both edges", () => {
    expect(dragSpan(bar, "move", 2)).toMatchObject({ startMs: ms(2026, 3, 12), endMs: ms(2026, 3, 15) });
    expect(dragSpan(bar, "move", -10)).toMatchObject({ startMs: ms(2026, 2, 28), endMs: ms(2026, 3, 3) });
  });

  it("resizes one edge and never inverts the bar", () => {
    expect(dragSpan(bar, "end", 3)).toMatchObject({ startMs: ms(2026, 3, 10), endMs: ms(2026, 3, 16) });
    expect(dragSpan(bar, "end", -9)).toMatchObject({ endMs: ms(2026, 3, 11) }); // keeps one day
    expect(dragSpan(bar, "start", -2)).toMatchObject({ startMs: ms(2026, 3, 8), endMs: ms(2026, 3, 13) });
    expect(dragSpan(bar, "start", 9)).toMatchObject({ startMs: ms(2026, 3, 12) });
    const timed = span(ms(2026, 3, 10, 9), ms(2026, 3, 10, 10), { startDateOnly: false });
    expect(dragSpan(timed, "start", 2).startMs).toBe(ms(2026, 3, 10, 10) - 15 * 60_000);
  });

  it("leaves a milestone's edges alone", () => {
    const m = span(ms(2026, 3, 10), ms(2026, 3, 11), { hasEnd: false });
    expect(dragSpan(m, "end", 3)).toBe(m);
    expect(dragSpan(m, "move", 3).startMs).toBe(ms(2026, 3, 13));
  });
});

describe("lane layout", () => {
  const a = { fromDay: day(2026, 3, 1), toDay: day(2026, 6, 1), pxPerDay: 10 };
  const bar = (id: string, s: number, e: number, over: Partial<Span> = {}) => ({ id, title: id, span: span(ms(2026, 3, s), ms(2026, 3, e), over) });

  it("packs overlapping bars into rows and leaves gaps on one row", () => {
    const { rows, count } = packRows([
      { left: 0, right: 50 },
      { left: 20, right: 80 },
      { left: 60, right: 90 },
    ]);
    expect(rows).toEqual([0, 1, 0]);
    expect(count).toBe(2);
    expect(packRows([]).count).toBe(0);
  });

  it("stacks lanes, sizes them by rows and places bars at the right x and y", () => {
    const lanes = layoutLanes(
      [
        { key: "a", bars: [bar("one", 2, 6), bar("two", 4, 9), bar("three", 10, 12)] },
        { key: "b", bars: [] },
        { key: "c", bars: [bar("m", 5, 6, { hasEnd: false })] },
      ],
      a,
    );
    expect(lanes.map((l) => [l.key, l.top, l.rows])).toEqual([
      ["a", 0, 2],
      ["b", 2 * ROW_HEIGHT + 2 * LANE_PAD, 1],
      ["c", 3 * ROW_HEIGHT + 4 * LANE_PAD, 1],
    ]);
    const [one, two, three] = lanes[0]!.bars;
    expect(one).toMatchObject({ x: 10, width: 40, row: 0 });
    expect(two).toMatchObject({ x: 30, row: 1 });
    expect(three!.row).toBe(0);
    expect(two!.y).toBeGreaterThan(one!.y);
    expect(lanes[2]!.bars[0]!.milestone).toBe(true);
  });

  it("gives a milestone's title room so a neighbour moves to another row", () => {
    const lanes = layoutLanes([{ key: "a", bars: [bar("A long milestone title", 2, 3, { hasEnd: false }), bar("next", 3, 6)] }], a);
    expect(lanes[0]!.rows).toBe(2);
  });
});

describe("dependencies", () => {
  const sp = new Map<string, Span>([
    ["a", span(ms(2026, 3, 1), ms(2026, 3, 4))], // Mar 1-3, ends Mar 4 00:00
    ["b", span(ms(2026, 3, 4), ms(2026, 3, 6))], // starts right after a
    ["c", span(ms(2026, 3, 3), ms(2026, 3, 5))], // starts before a ends
  ]);
  const rec = (id: string, preds: unknown) => ({ id, values: { dep: preds } as Record<string, unknown> });

  it("draws an arrow from each predecessor to its successor and flags overlaps as violated", () => {
    const edges = dependencyEdges([rec("a", []), rec("b", [{ id: "a", name: "A" }]), rec("c", [{ id: "a", name: "A" }, { id: "b", name: "B" }])], "dep", sp);
    expect(edges).toEqual([
      { fromId: "a", toId: "b", violated: false },
      { fromId: "a", toId: "c", violated: true },
      { fromId: "b", toId: "c", violated: true },
    ]);
  });

  it("skips unknown, undated, self and duplicate links", () => {
    const edges = dependencyEdges([rec("b", [{ id: "zzz", name: "?" }, { id: "b", name: "self" }, "a", "a"]), rec("x", [{ id: "a", name: "A" }])], "dep", sp);
    expect(edges).toEqual([{ fromId: "a", toId: "b", violated: false }]);
  });

  it("treats a date-only milestone as occupying its day", () => {
    const m = new Map<string, Span>([
      ["m", span(ms(2026, 3, 5), ms(2026, 3, 6), { hasEnd: false })],
      ["t", span(ms(2026, 3, 5), ms(2026, 3, 7))],
    ]);
    expect(dependencyEdges([{ id: "t", values: { dep: [{ id: "m", name: "M" }] } }], "dep", m)[0]!.violated).toBe(true);
  });
});

describe("arrowPath", () => {
  it("runs straight right-down-right when there is room", () => {
    expect(arrowPath({ x: 100, y: 20 }, { x: 160, y: 80 })).toBe("M 100 20 H 114 V 80 H 160");
  });

  it("loops through the gap between rows when the successor starts too early", () => {
    expect(arrowPath({ x: 100, y: 20 }, { x: 90, y: 56 }, 36)).toBe("M 100 20 H 108 V 38 H 82 V 56 H 90");
    expect(arrowPath({ x: 100, y: 56 }, { x: 90, y: 20 }, 36)).toBe("M 100 56 H 108 V 38 H 82 V 20 H 90");
    expect(arrowPath({ x: 100, y: 20 }, { x: 100, y: 20 }, 36)).toBe("M 100 20 H 108 V 38 H 92 V 20 H 100");
  });
});
