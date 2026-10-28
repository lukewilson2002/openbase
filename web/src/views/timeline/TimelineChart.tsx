/**
 * The timeline chart: a scrolling time axis, a fixed left column (one row per record, or one per
 * swimlane), bars (or milestone diamonds), a today marker and dependency arrows, all plain DOM and
 * one SVG layer. Bars move and resize by dragging (whole days), empty lane space creates a record
 * by dragging across days, a bar's connector dragged onto another bar makes a dependency, and bars
 * also work from the keyboard (Enter or Space opens, arrows move, Shift+arrows resize the end,
 * Alt+Shift+arrows the start). Dragging near the chart's edge scrolls it.
 *
 * The chart is controlled: the host owns the axis window and writes dates. Scrolling near an
 * edge asks the host to extend the window, and the chart keeps the visible days steady when the
 * window or the scale changes. A bar that runs past the visible edge gets a square end and an
 * arrow there, and its label stays in view while it is scrolled.
 */
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type { TimelineScale } from "@/api/types";
import { COARSE_POINTER, useMediaQuery } from "@/hooks/useMediaQuery";
import { useHoldToDrag } from "@/lib/holdToDrag";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { cn } from "@/lib/cn";
import { RECORD_DRAG_TYPE } from "../common/UnscheduledList";
import { accentHue, choiceClass } from "@/lib/colors";
import { DescriptionHover, hasDescription, type DescriptionSource } from "../common/description";
import {
  BAR_HEIGHT,
  LANE_PAD,
  ROW_HEIGHT,
  arrowPath,
  axisWidth,
  barRect,
  canDepend,
  centerDayOf,
  dayAtX,
  dragSpan,
  edgeScrollSpeed,
  handleBox,
  layoutLanes,
  majorTicks,
  minorIsDay,
  minorTicks,
  showsWeekends,
  weekendStarts,
  windowStart,
  xOfDay,
  xOfMs,
  type Axis,
  type BarInput,
  type DependencyEdge,
  type DragMode,
} from "./geometry";
import { spanLabel, type Lane } from "./lanes";
import "./timeline.css";

const MAJOR_ROW = 30;
const MINOR_ROW = 32;
export const HEADER_HEIGHT = MAJOR_ROW + MINOR_ROW;
/** The left column: wide enough for a record's name and who it is for; narrower on a phone. */
export const LABEL_WIDTH = 216;
const LABEL_WIDTH_PHONE = 132;
/** How far the left column's divider can be dragged (the server keeps the same 80 to 480). */
export const LABEL_WIDTH_MIN = 80;
export const LABEL_WIDTH_MAX = 480;
const LABEL_KEY_STEP = 16;
const clampLabel = (w: number) => Math.round(Math.min(LABEL_WIDTH_MAX, Math.max(LABEL_WIDTH_MIN, w)));
const ADD_ROW = 40;
const EDGE_PX = 240;

export interface TimelineBar extends BarInput {
  /** Palette colour name from the view's row colours. */
  color?: string;
  /** Text inside the bar when it is not the title (the dates, when the left column names the record). */
  label?: string;
  canMove: boolean;
  /** The end edge can be dragged (a milestone grows an end this way). */
  canResize: boolean;
  /** The start edge can be dragged (when absent, as `canResize`). */
  canResizeStart?: boolean;
  /** Dependencies can start or end at this bar (default: yes, when the chart can make them). */
  canLink?: boolean;
  /** Dependency violated at this bar's start. */
  violated?: boolean;
  /** Something to know about its dates, said in its name and on hover ("The end is before the start"). */
  hint?: string;
}

export interface ChartLane {
  lane: Lane;
  bars: TimelineBar[];
  /** A second, quieter text in the left column (who a record is for). */
  sublabel?: string;
  /** The left column's name opens this record (rows that are one record each). */
  recordId?: string;
}

/** Imperative controls for the host's own Today and ‹ › buttons. */
export interface TimelineChartHandle {
  /** Scroll one screen earlier or later. */
  page(dir: -1 | 1): void;
}

export interface TimelineChartProps {
  axis: Axis;
  scale: TimelineScale;
  lanes: readonly ChartLane[];
  edges: readonly DependencyEdge[];
  /** Wall time "now" for the today marker. */
  nowMs: number;
  /** Lane names are shown in a left column. */
  showLabels: boolean;
  /** Heading of the left column ("Chore", or the field the lanes group by). */
  labelHeading?: string;
  /** The left column's width on a desktop, as saved on the view (else just wide enough for its labels). */
  labelWidth?: number | null;
  /** Saves a width dragged on the column's divider (`null`: back to fitting the labels); without it a drag holds only until the page changes. */
  onLabelWidth?: (width: number | null) => void;
  canCreate: boolean;
  /** Dragging across days to add a record gives it an end (else only the first day is saved, and the ghost shows just that). */
  createSpansDays?: boolean;
  /** Said where the chart has no bars (the host knows about records outside the window and the unscheduled ones). */
  emptyMessage?: ReactNode;
  /**
   * Bring this day into view when `nonce` changes: centred, or (`start`) at the start of its period
   * with a little of what came before, the way the view opens.
   */
  focus: { day: number; nonce: number; align?: "center" | "start" } | null;
  loading: boolean;
  /** Height follows the rows (inside a card that grows with them) instead of filling the parent. */
  fitContent?: boolean;
  /** A "+ Add" row under the left column. */
  onAddRow?: () => void;
  onOpen(recordId: string): void;
  /** The record behind a bar and the view's description field, to read in full on hover. */
  describe?(recordId: string): DescriptionSource | null;
  /** A drag or arrow key changed a bar: by `days`, and (a moved bar) into the swim lane `toLane`. */
  onCommit(recordId: string, mode: DragMode, days: number, toLane?: string): void;
  onCreate(laneKey: string, fromDay: number, toDay: number): void;
  /** A record dragged in from the unscheduled list (`RECORD_DRAG_TYPE`) and dropped on a lane's day. */
  onDropRecord?(recordId: string, laneKey: string, day: number): void;
  /** Takes a bar off the timeline (clears its dates): U on a selected bar, or a bar dropped on `unscheduleZone`. */
  onUnschedule?(recordId: string): void;
  /** Delete or Backspace on a selected bar. */
  onDelete?(recordId: string): void;
  /** Where a dragged bar can be dropped to unschedule it (the unscheduled column). */
  unscheduleZone?: RefObject<HTMLElement | null>;
  /** A dragged bar is over `unscheduleZone` (or no longer is), for the column to show it takes the drop. */
  onOverUnschedule?(over: boolean): void;
  /** Makes `toId` depend on `fromId` (an arrow from the end of `fromId` to the start of `toId`): a connector dragged onto a bar, or L then Enter on bars. Without it, bars show no connectors. */
  onLink?(fromId: string, toId: string): void;
  /** Removes that dependency: Delete on a selected arrow, or its remove button. Without it, arrows cannot be selected. */
  onUnlink?(fromId: string, toId: string): void;
  /** The T key. */
  onToday?(): void;
  onNeedMore(side: "start" | "end"): void;
  onZoom(dir: "in" | "out"): void;
  /** The day at the centre of the visible chart, reported after scrolling and layout changes. */
  onCenter(day: number): void;
  /** The first and last day on screen (for a "Oct 5 – 18, 2026" title). */
  onVisibleDays?(fromDay: number, lastDay: number): void;
  ref?: Ref<TimelineChartHandle>;
}

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  /** The (fractional) day under the pointer when it was pressed: days moved are counted from it, so scrolling while dragging counts too. */
  startDay: number;
  days: number;
  moved: boolean;
  /** The swim lane a moved bar is over, when it is another lane it can go to. */
  toLane?: string;
  /** Over the unscheduled column: dropping it there clears its dates. */
  unschedule?: boolean;
}

interface CreateState {
  laneKey: string;
  fromDay: number;
  toDay: number;
  startX: number;
  moved: boolean;
}

/** A dependency being made by dragging a bar's connector: from its `side`, to the bar under the pointer. */
interface LinkState {
  fromId: string;
  side: "start" | "end";
  /** The pointer, in the bars' layer. */
  x: number;
  y: number;
  /** The bar a drop here would link to (one that is allowed). */
  targetId?: string;
}

/** What auto-scrolling re-applies each frame, with the pointer where it last was. */
type EdgeDrag = { x: number; y: number } & ({ kind: "bar"; bar: TimelineBar } | { kind: "create" } | { kind: "link"; bar: TimelineBar; side: "start" | "end" });

const edgeKey = (fromId: string, toId: string) => `${fromId}>${toId}`;

const gridLine = "border-[color-mix(in_srgb,var(--line)_55%,var(--surface))]";
const weekendBody = "bg-[color-mix(in_srgb,var(--bg)_55%,var(--surface))]";
const weekendHead = "bg-[color-mix(in_srgb,var(--line)_55%,var(--surface))]";

export function TimelineChart(props: TimelineChartProps) {
  const { axis, scale, lanes, edges, nowMs, showLabels, canCreate, focus, loading } = props;
  const wide = useMediaQuery(DESKTOP_QUERY);
  // The width while its divider is dragged (or dragged by someone who cannot save it), else the view's.
  const [liveLabelW, setLiveLabelW] = useState<number | null>(null);
  // Without a saved width the column is as narrow as its longest label allows (measured below).
  const [fitLabelW, setFitLabelW] = useState<number | null>(null);
  const labelW = showLabels ? (wide ? (liveLabelW ?? clampLabel(props.labelWidth ?? fitLabelW ?? LABEL_WIDTH)) : LABEL_WIDTH_PHONE) : 0;
  const labelDrag = useRef<{ x: number; width: number; last: number } | null>(null);
  const saveLabel = (w: number | null) => {
    if (props.onLabelWidth) {
      props.onLabelWidth(w);
      setLiveLabelW(null);
    } else setLiveLabelW(w);
  };
  const onLabelPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    labelDrag.current = { x: e.clientX, width: labelW, last: labelW };
  };
  const onLabelPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = labelDrag.current;
    if (!d) return;
    d.last = clampLabel(d.width + e.clientX - d.x);
    setLiveLabelW(d.last);
  };
  const onLabelPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = labelDrag.current;
    if (!d) return;
    labelDrag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A press without a drag changes nothing.
    if (d.last !== d.width) saveLabel(d.last);
    else setLiveLabelW(null);
  };
  // The widest label as drawn (name, its colour dot or second text, and the heading), plus the cell's
  // padding (14 px each side) and its line: the column's width until one is chosen. Measured with the
  // page's font on a canvas, so the labels are not drawn twice.
  useLayoutEffect(() => {
    if (!showLabels || !wide) return;
    const ctx = document.createElement("canvas").getContext("2d");
    const el = scroller.current;
    if (!ctx || !el) return;
    let live = true;
    const measure = () => {
      if (!live) return;
      const family = getComputedStyle(el).fontFamily;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const text = (t: string, size: number, weight: number) => {
        ctx.font = `${weight} ${size * rem}px ${family}`;
        return ctx.measureText(t).width;
      };
      let widest = props.labelHeading ? text(props.labelHeading, 0.875, 600) : 0;
      for (const cl of lanes) {
        const name = text(cl.lane.label, 0.875, 500);
        const count = `${cl.bars.length} bar${cl.bars.length === 1 ? "" : "s"}`;
        const row = cl.recordId ? name + (cl.sublabel ? 8 + text(cl.sublabel, 0.8125, 400) : 0) : Math.max(name, text(count, 0.75, 400));
        widest = Math.max(widest, row);
      }
      setFitLabelW(widest > 0 ? clampLabel(Math.ceil(widest) + 29) : null);
    };
    measure();
    // Again once the page's font has loaded: a fallback font measures differently.
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, [lanes, props.labelHeading, showLabels, wide]);
  const onLabelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowLeft" ? labelW - LABEL_KEY_STEP : e.key === "ArrowRight" ? labelW + LABEL_KEY_STEP : e.key === "Home" ? LABEL_WIDTH_MIN : e.key === "End" ? LABEL_WIDTH_MAX : null;
    if (next === null) return;
    e.preventDefault();
    saveLabel(clampLabel(next));
  };
  const scroller = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Pointer handlers read the gesture from refs (events can arrive faster than React re-renders);
  // the state copies only drive what is drawn.
  const dragRef = useRef<DragState | null>(null);
  const creatingRef = useRef<CreateState | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const [creating, setCreatingState] = useState<CreateState | null>(null);
  // Where a record dragged in from the unscheduled list would land, while it is over a lane.
  const [dropAt, setDropAt] = useState<{ laneKey: string; day: number } | null>(null);
  // The visible part of the axis (chart x), for the square ends of bars that run past it.
  const [view, setView] = useState({ left: 0, right: 0 });
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const setCreating = (c: CreateState | null) => {
    creatingRef.current = c;
    setCreatingState(c);
  };
  const width = axisWidth(axis);
  const coarse = useMediaQuery(COARSE_POINTER);
  const linkingRef = useRef<LinkState | null>(null);
  const [linking, setLinkingState] = useState<LinkState | null>(null);
  const setLinking = (l: LinkState | null) => {
    linkingRef.current = l;
    setLinkingState(l);
  };
  // The arrow that is selected (focused), as `edgeKey`, to remove it.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // Linking from the keyboard: the bar chosen with L, waiting for the bar that comes after it.
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  // Something to tell the person that is not in a bar's name (a link that was refused).
  const [note, setNote] = useState<string | null>(null);

  const placed = useMemo(() => layoutLanes(lanes.map((l) => ({ key: l.lane.key, bars: l.bars })), axis), [lanes, axis]);
  const lanesHeight = placed.length ? placed[placed.length - 1]!.top + placed[placed.length - 1]!.height : 0;
  const major = useMemo(() => majorTicks(scale, axis), [scale, axis]);
  const minor = useMemo(() => minorTicks(scale, axis), [scale, axis]);
  const weekends = useMemo(() => (showsWeekends(scale) ? weekendStarts(axis) : []), [scale, axis]);
  const totalBars = lanes.reduce((n, l) => n + l.bars.length, 0);
  const addRow = props.onAddRow ? ADD_ROW : 0;

  const visibleWidth = (el: HTMLDivElement) => Math.max(0, el.clientWidth - labelW);
  const report = (el: HTMLDivElement) => {
    const viewW = visibleWidth(el);
    props.onCenter(centerDayOf(el.scrollLeft, viewW, axis));
    props.onVisibleDays?.(dayAtX(el.scrollLeft, axis), dayAtX(el.scrollLeft + Math.max(1, viewW) - 1, axis));
    setView((v) => (v.left === el.scrollLeft && v.right === el.scrollLeft + viewW ? v : { left: el.scrollLeft, right: el.scrollLeft + viewW }));
  };

  // ---- keep the view steady when the window or scale changes, and honour focus requests -------
  const prev = useRef<{ axis: Axis; scrollLeft: number; width: number } | null>(null);
  const lastFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const viewW = visibleWidth(el);
    const before = prev.current;
    if (before && (before.axis.fromDay !== axis.fromDay || before.axis.pxPerDay !== axis.pxPerDay)) {
      if (before.axis.pxPerDay === axis.pxPerDay) el.scrollLeft = before.scrollLeft + (before.axis.fromDay - axis.fromDay) * axis.pxPerDay;
      else el.scrollLeft = xOfDay(centerDayOf(before.scrollLeft, before.width, before.axis), axis) - viewW / 2;
    }
    if (focus && lastFocus.current !== focus.nonce) {
      lastFocus.current = focus.nonce;
      el.scrollLeft = focus.align === "start" ? xOfDay(windowStart(scale, focus.day, viewW / axis.pxPerDay), axis) : xOfDay(focus.day, axis) - viewW / 2;
    }
    prev.current = { axis, scrollLeft: el.scrollLeft, width: viewW };
    report(el);
  });

  // The visible width changes with the window and the sidebar, not only with scrolling. One
  // observer for the chart's life, calling the latest `report` (it closes over the current axis).
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => reportRef.current(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    prev.current = { axis, scrollLeft: el.scrollLeft, width: visibleWidth(el) };
    report(el);
    if (el.scrollLeft < EDGE_PX) props.onNeedMore("start");
    else if (el.scrollWidth - el.clientWidth - el.scrollLeft < EDGE_PX) props.onNeedMore("end");
  };

  // ---- scrolling toward the edge while something is dragged -------------------------------------
  const edgeRef = useRef<EdgeDrag | null>(null);
  const edgeFrame = useRef(0);
  const edgeAt = useRef(0);
  const edgeTickRef = useRef<(now: number) => void>(() => {});
  const stopEdge = () => {
    edgeRef.current = null;
    if (edgeFrame.current) cancelAnimationFrame(edgeFrame.current);
    edgeFrame.current = 0;
    edgeAt.current = 0;
  };
  const scheduleEdge = () => {
    if (!edgeFrame.current && edgeRef.current && typeof requestAnimationFrame === "function") edgeFrame.current = requestAnimationFrame((t) => edgeTickRef.current(t));
  };
  /** The pointer of a drag is at (x, y): while it is near the chart's left or right edge the chart scrolls, and the drag is worked out again. */
  const pullEdge = (e: EdgeDrag) => {
    edgeRef.current = e;
    scheduleEdge();
  };
  edgeTickRef.current = (now) => {
    edgeFrame.current = 0;
    const e = edgeRef.current;
    const el = scroller.current;
    if (!e || !el) return;
    const dt = edgeAt.current ? Math.min(50, now - edgeAt.current) : 16;
    edgeAt.current = now;
    const rect = el.getBoundingClientRect();
    const speed = edgeScrollSpeed(e.x, rect.left + labelW, rect.right);
    if (speed !== 0) {
      const before = el.scrollLeft;
      el.scrollLeft = before + (speed * dt) / 1000;
      if (el.scrollLeft !== before) {
        if (e.kind === "bar") moveBarTo(e.bar, e.x, e.y);
        else if (e.kind === "create") moveCreateTo(e.x);
        else moveLinkTo(e.bar, e.side, e.x, e.y);
      }
    }
    scheduleEdge();
  };
  useEffect(
    () => () => {
      if (edgeFrame.current) cancelAnimationFrame(edgeFrame.current);
    },
    [],
  );

  const pageBy = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    // Whole days, so a page lands on a day boundary like the first screen did.
    const days = Math.max(1, Math.floor(visibleWidth(el) / axis.pxPerDay));
    const target = el.scrollLeft + dir * days * axis.pxPerDay;
    if (typeof el.scrollTo === "function") el.scrollTo({ left: target, behavior: "smooth" });
    else el.scrollLeft = target;
  };
  useImperativeHandle(props.ref, () => ({ page: pageBy }));

  // Keys for the chart as a whole, from anything inside it that did not use the key: T is today, + and - zoom, [ and ] page.
  const helpId = useId();
  const chartKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    if (e.key === "t" || e.key === "T") props.onToday?.();
    else if (e.key === "+" || e.key === "=") props.onZoom("in");
    else if (e.key === "-" || e.key === "_") props.onZoom("out");
    else if (e.key === "[") pageBy(-1);
    else if (e.key === "]") pageBy(1);
    else return;
    e.preventDefault();
  };
  // The day a record added from the keyboard gets: today when it is on screen, else the middle of what is.
  const keyboardDay = () => {
    const todayDay = Math.floor(nowMs / 86_400_000);
    if (view.right <= view.left) return todayDay;
    const first = dayAtX(view.left, axis);
    const last = dayAtX(view.right - 1, axis);
    return todayDay >= first && todayDay <= last ? todayDay : Math.floor(centerDayOf(view.left, view.right - view.left, axis));
  };
  // What was said about a refused or begun link goes away on its own.
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 8000);
    return () => window.clearTimeout(t);
  }, [note]);

  // Ctrl/Cmd + wheel zooms (a non-passive listener is needed to stop the browser zooming the page).
  const zoomRef = useRef(props.onZoom);
  zoomRef.current = props.onZoom;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      zoomRef.current(e.deltaY < 0 ? "in" : "out");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- geometry of each bar, including a bar being dragged -------------------------------------
  const rects = useMemo(() => {
    const m = new Map<string, { x: number; y: number; width: number; milestone: boolean }>();
    for (const lane of placed) for (const p of lane.bars) m.set(p.bar.id, { x: p.x, y: p.y, width: p.width, milestone: p.milestone });
    return m;
  }, [placed]);
  // The swim lane each bar is drawn in (a chart with one row per record has none to move between).
  const laneOfBar = useMemo(() => {
    const m = new Map<string, ChartLane>();
    for (const l of lanes) if (!l.recordId) for (const b of l.bars) m.set(b.id, l);
    return m;
  }, [lanes]);
  /** The lane under a point of the bars' layer that the bar may move into (its field can be set), if any. */
  const laneAt = (barId: string, y: number): string | undefined => {
    const from = laneOfBar.get(barId);
    if (!from?.lane.fieldId) return undefined;
    const p = placed.find((q) => y >= q.top && y < q.top + q.height);
    const to = p && lanes.find((l) => l.lane.key === p.key);
    if (!to || to.recordId || to.lane.key === from.lane.key || to.lane.value === undefined || to.lane.fieldId !== from.lane.fieldId) return undefined;
    return to.lane.key;
  };
  /** Dragging this bar's end edge, even by nothing, writes the end it is missing (it is before the start). */
  const repairs = (bar: TimelineBar, mode: DragMode, moved: boolean) => moved && mode === "end" && !!bar.span.reversed;
  const live = (id: string) => {
    const base = rects.get(id);
    if (!base) return undefined;
    if (!drag || drag.id !== id) return base;
    const bar = lanes.flatMap((l) => l.bars).find((b) => b.id === id);
    if (!bar) return base;
    // A reversed record's end edge repairs it even without moving a day.
    if (drag.days === 0 && !drag.toLane && !repairs(bar, drag.mode, drag.moved)) return base;
    const r = barRect(dragSpan(bar.span, drag.mode, drag.days), axis);
    // Over another lane, the bar is drawn on that lane's first row.
    const into = drag.toLane !== undefined ? placed.find((p) => p.key === drag.toLane) : undefined;
    return { ...base, ...r, y: into ? into.top + LANE_PAD + (ROW_HEIGHT - BAR_HEIGHT) / 2 : base.y };
  };

  // A finger holds a bar (or a lane) for a moment before it drags; a swipe scrolls the chart.
  const barGate = useHoldToDrag();
  const laneGate = useHoldToDrag();
  const capture = (el: Element, pointerId: number) => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };

  /** The (fractional) day under a pointer position: the axis scrolls and grows, so this is always read from the layer's current place. */
  const dayFracAt = (clientX: number) => (clientX - (layer.current?.getBoundingClientRect().left ?? 0)) / axis.pxPerDay + axis.fromDay;
  const allows = (bar: TimelineBar, mode: DragMode) => (mode === "move" ? bar.canMove : mode === "start" ? (bar.canResizeStart ?? bar.canResize) : bar.canResize);

  const startBar = (bar: TimelineBar, e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).dataset.handle as "start" | "end" | undefined;
    const allowed = allows(bar, handle ?? "move");
    // A bar that cannot change still takes the press, so that releasing it opens the record (one that
    // can is selected instead: see the bar's pointer up).
    const mode: DragMode = allowed ? (handle ?? "move") : "move";
    const { currentTarget: el, pointerId, clientX: startX, clientY: startY } = e;
    const startDay = dayFracAt(startX);
    barGate.press(e, () => {
      capture(el, pointerId);
      setDrag({ id: bar.id, mode, startX, startY, startDay, days: 0, moved: false });
    });
  };
  const moveBar = (bar: TimelineBar, e: PointerEvent<HTMLDivElement>) => moveBarTo(bar, e.clientX, e.clientY);
  const moveBarTo = (bar: TimelineBar, clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d || d.id !== bar.id) return;
    const dx = clientX - d.startX;
    const dy = clientY - d.startY;
    const allowed = allows(bar, d.mode);
    const moved = d.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
    // Over the unscheduled column, a moved bar goes back to it (it stays drawn where it was until dropped).
    const zone = allowed && d.mode === "move" && props.onUnschedule ? props.unscheduleZone?.current?.getBoundingClientRect() : undefined;
    const unschedule = !!zone && clientX >= zone.left && clientX < zone.right && clientY >= zone.top && clientY < zone.bottom;
    if (unschedule !== !!d.unschedule) props.onOverUnschedule?.(unschedule);
    if (unschedule) {
      stopEdge();
      return setDrag({ ...d, days: 0, toLane: undefined, unschedule, moved });
    }
    // A moved bar can also go up or down into another swim lane.
    const toLane = allowed && d.mode === "move" ? laneAt(bar.id, clientY - (layer.current?.getBoundingClientRect().top ?? 0)) : undefined;
    // Counted from the day under the pointer when it was pressed, so scrolling under a held pointer moves the bar too.
    setDrag({ ...d, days: allowed ? Math.round(dayFracAt(clientX) - d.startDay) : 0, toLane, unschedule: false, moved });
    if (moved && allowed) pullEdge({ kind: "bar", bar, x: clientX, y: clientY });
  };
  /** `select`: the bar a mouse released without moving, selected rather than opened (see the bar's pointer up). */
  const endBar = (bar: TimelineBar, cancel = false, select?: HTMLElement) => {
    const d = dragRef.current;
    setDrag(null);
    stopEdge();
    if (d?.unschedule) props.onOverUnschedule?.(false);
    if (!d || d.id !== bar.id || cancel) return;
    if (!d.moved) {
      if (select) select.focus();
      else props.onOpen(bar.id);
    } else if (d.unschedule) props.onUnschedule?.(bar.id);
    else if (d.toLane !== undefined) props.onCommit(bar.id, d.mode, d.days, d.toLane);
    else if (d.days !== 0 || repairs(bar, d.mode, d.moved)) props.onCommit(bar.id, d.mode, d.days);
  };
  const barKey = (bar: TimelineBar, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && linkFrom) {
      e.preventDefault();
      setLinkFrom(null);
      setNote(null);
      return;
    }
    // Enter or Space opens the bar, or (after L on another bar) makes this the bar that comes after it.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (linkFrom && linkFrom !== bar.id) linkByKey(linkFrom, bar);
      else if (linkFrom) {
        // The bar chosen with L is not its own successor: that gives up the link instead of opening the record.
        setLinkFrom(null);
        setNote(null);
      } else props.onOpen(bar.id);
      return;
    }
    // L starts a dependency from this bar: focus the bar that comes after it, and press Enter.
    if ((e.key === "l" || e.key === "L") && !e.ctrlKey && !e.metaKey && !e.altKey && props.onLink) {
      e.preventDefault();
      setLinkFrom(bar.id);
      setNote(`${bar.title} comes first. Move to the bar that comes after it and press Enter, or Escape to cancel.`);
      return;
    }
    // Alt+Shift+Left or Right moves the start edge; other Alt keys are the browser's (Alt+Left is back).
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const edge = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (e.shiftKey && edge && allows(bar, "start")) {
        e.preventDefault();
        props.onCommit(bar.id, "start", edge);
      }
      return;
    }
    // Delete deletes the record of a selected bar; U takes it off the timeline, back to the unscheduled records.
    // The bar goes away, so the keyboard stays in the chart (its keys still work) instead of falling to the page.
    if ((e.key === "Delete" || e.key === "Backspace") && props.onDelete) {
      e.preventDefault();
      scroller.current?.focus();
      props.onDelete(bar.id);
      return;
    }
    if ((e.key === "u" || e.key === "U") && !e.ctrlKey && !e.metaKey && !e.altKey && bar.canMove && props.onUnschedule) {
      e.preventDefault();
      scroller.current?.focus();
      props.onUnschedule(bar.id);
      return;
    }
    // Up and down move a bar into the swim lane above or below (one it can go to).
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step && bar.canMove) {
      const from = laneOfBar.get(bar.id);
      const order = placed.map((p) => p.key);
      for (let i = order.indexOf(from?.lane.key ?? "\u0000") + step; from && i >= 0 && i < order.length; i += step) {
        const to = laneAt(bar.id, placed[i]!.top + 1);
        if (to !== undefined) {
          e.preventDefault();
          props.onCommit(bar.id, "move", 0, to);
          return;
        }
      }
      return;
    }
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    if (e.shiftKey) {
      if (!bar.canResize) return;
      e.preventDefault();
      props.onCommit(bar.id, "end", dir);
    } else if (bar.canMove) {
      e.preventDefault();
      props.onCommit(bar.id, "move", dir);
    }
  };

  // ---- create by dragging on empty lane space ---------------------------------------------------
  const dayUnder = (clientX: number) => dayAtX(clientX - (layer.current?.getBoundingClientRect().left ?? 0), axis);
  const startCreate = (laneKey: string, e: PointerEvent<HTMLDivElement>) => {
    if (!canCreate || e.button !== 0 || e.target !== e.currentTarget) return;
    const { currentTarget: el, pointerId, clientX: startX } = e;
    const day = dayUnder(startX);
    laneGate.press(e, () => {
      capture(el, pointerId);
      setCreating({ laneKey, fromDay: day, toDay: day, startX, moved: false });
    });
  };
  const moveCreate = (e: PointerEvent<HTMLDivElement>) => moveCreateTo(e.clientX);
  const moveCreateTo = (clientX: number) => {
    const c = creatingRef.current;
    if (!c) return;
    const moved = c.moved || Math.abs(clientX - c.startX) > 6;
    setCreating({ ...c, toDay: dayUnder(clientX), moved });
    if (moved) pullEdge({ kind: "create", x: clientX, y: 0 });
  };
  const endCreate = (cancel = false) => {
    const c = creatingRef.current;
    setCreating(null);
    stopEdge();
    if (c && c.moved && !cancel) props.onCreate(c.laneKey, c.fromDay, c.toDay);
  };

  // ---- dependencies: made by dragging a connector, or L then Enter; removed from a selected arrow ----------
  const linkGate = useHoldToDrag();
  const titleOf = useMemo(() => new Map(lanes.flatMap((l) => l.bars).map((b) => [b.id, b.title] as const)), [lanes]);
  const layerPoint = (clientX: number, clientY: number) => {
    const r = layer.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };
  /** The bar under a point of the bars' layer, other than `exceptId` (a little slack around it). */
  const barAt = (x: number, y: number, exceptId: string): string | undefined => {
    for (const [id, r] of rects) if (id !== exceptId && x >= r.x - 4 && x <= r.x + r.width + 4 && y >= r.y - 2 && y <= r.y + BAR_HEIGHT + 2) return id;
    return undefined;
  };
  /** The bar a connector of `fromId` dropped at this point would link to, if the link is allowed. */
  const linkTarget = (fromId: string, side: "start" | "end", x: number, y: number): string | undefined => {
    const id = barAt(x, y, fromId);
    return id && (side === "end" ? canDepend(edges, fromId, id) : canDepend(edges, id, fromId)) ? id : undefined;
  };
  const startLink = (bar: TimelineBar, side: "start" | "end", e: PointerEvent<HTMLSpanElement>) => {
    // The press is the connector's, not the bar's (which would move it).
    e.stopPropagation();
    if (e.button !== 0) return;
    const { currentTarget: el, pointerId, clientX, clientY } = e;
    const p = layerPoint(clientX, clientY);
    linkGate.press(e, () => {
      capture(el, pointerId);
      setLinking({ fromId: bar.id, side, ...p });
    });
  };
  const moveLinkTo = (bar: TimelineBar, side: "start" | "end", clientX: number, clientY: number) => {
    const l = linkingRef.current;
    if (!l || l.fromId !== bar.id) return;
    const p = layerPoint(clientX, clientY);
    setLinking({ ...l, ...p, targetId: linkTarget(bar.id, side, p.x, p.y) });
    pullEdge({ kind: "link", bar, side, x: clientX, y: clientY });
  };
  const endLink = (bar: TimelineBar, cancel = false) => {
    const l = linkingRef.current;
    setLinking(null);
    stopEdge();
    if (!l || l.fromId !== bar.id || cancel || !l.targetId) return;
    if (l.side === "end") props.onLink?.(bar.id, l.targetId);
    else props.onLink?.(l.targetId, bar.id);
  };
  /** Enter on the bar that comes after the one chosen with L. */
  const linkByKey = (fromId: string, to: TimelineBar) => {
    if (canDepend(edges, fromId, to.id)) {
      props.onLink?.(fromId, to.id);
      setNote(null);
    } else setNote(`${to.title} can't come after ${titleOf.get(fromId) ?? "it"}: it already does, or that would make a loop. Choose another bar, or press Escape.`);
    setLinkFrom(null);
  };
  const unlink = (edge: DependencyEdge) => {
    setSelectedEdge(null);
    props.onUnlink?.(edge.fromId, edge.toId);
  };
  const edgeName = (edge: DependencyEdge) => `${titleOf.get(edge.toId) ?? "A record"} comes after ${titleOf.get(edge.fromId) ?? "another"}${edge.violated ? ", but they overlap" : ""}`;

  const arrows = edges.flatMap((edge) => {
    const from = live(edge.fromId);
    const to = live(edge.toId);
    if (!from || !to) return [];
    const a = { x: from.x + from.width, y: from.y + BAR_HEIGHT / 2 };
    const b = { x: to.x, y: to.y + BAR_HEIGHT / 2 };
    return [{ edge, d: arrowPath(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }];
  });
  const selected = arrows.find((a) => edgeKey(a.edge.fromId, a.edge.toId) === selectedEdge);
  const linkSource = linking ? rects.get(linking.fromId) : undefined;

  const todayX = xOfMs(nowMs, axis);
  const todayVisible = todayX >= 0 && todayX <= width;
  const todayDay = Math.floor(nowMs / 86_400_000);
  const dayTicks = minorIsDay(scale);
  const bodyHeight = lanesHeight + addRow;

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      onKeyDown={chartKey}
      onBlur={(e) => {
        // A dependency begun with L is given up when focus leaves the chart.
        if (linkFrom && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setLinkFrom(null);
          setNote(null);
        }
      }}
      role="region"
      aria-label="Timeline"
      aria-describedby={helpId}
      tabIndex={0}
      className={cn("relative overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", props.fitContent ? "min-h-0 shrink" : "h-full")}
      data-testid="timeline-scroller"
    >
      <p id={helpId} className="sr-only">
        Keys: T goes to today, plus and minus zoom, [ and ] page earlier and later. On a bar: Enter or Space opens it, the arrow keys move it, Shift with Left or Right moves its end, Alt and Shift with Left or Right moves its start, Up and Down change swimlane, U takes it off the timeline, Delete deletes it
        {props.onLink ? ", L starts a dependency from it" : ""}.
      </p>
      <div className="relative" style={{ width: labelW + width, minHeight: HEADER_HEIGHT + Math.max(bodyHeight, 1) }}>
        {/* The left column's divider, the whole height and pinned with the column: drag it (or use the arrow keys) to widen or narrow the column. */}
        {showLabels && wide && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-50" style={{ width: labelW + width }}>
            <div className="pointer-events-none sticky left-0 h-full" style={{ width: labelW }}>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the left column"
                aria-valuenow={labelW}
                aria-valuemin={LABEL_WIDTH_MIN}
                aria-valuemax={LABEL_WIDTH_MAX}
                tabIndex={0}
                onPointerDown={onLabelPointerDown}
                onPointerMove={onLabelPointerMove}
                onPointerUp={onLabelPointerUp}
                onPointerCancel={onLabelPointerUp}
                onKeyDown={onLabelKeyDown}
                onDoubleClick={() => saveLabel(null)}
                title="Drag to resize; double-click to fit the labels"
                className="group pointer-events-auto absolute inset-y-0 -right-1.5 flex w-3 cursor-col-resize touch-none justify-center focus-visible:outline-none"
              >
                <span aria-hidden className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-ring group-active:bg-primary" />
              </div>
            </div>
          </div>
        )}
        {/* Header: the coarse row over the fine row, pinned to the top. */}
        <div className="sticky top-0 z-30 flex border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))]" style={{ height: HEADER_HEIGHT }}>
          {showLabels && (
            <div
              className="sticky left-0 z-40 flex shrink-0 items-end border-r border-line bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))] px-3.5 pb-2 text-[0.875rem] font-semibold text-muted"
              style={{ width: labelW }}
            >
              <span className="truncate">{props.labelHeading}</span>
            </div>
          )}
          <div className="relative overflow-clip" style={{ width }}>
            {major.map((t) => (
              <div
                key={`M${t.startDay}`}
                className="absolute top-0 overflow-clip border-l border-line text-xs font-semibold"
                style={{ left: xOfDay(t.startDay, axis), width: (t.endDay - t.startDay) * axis.pxPerDay, height: MAJOR_ROW }}
              >
                <span className="sticky inline-block whitespace-nowrap px-2.5 py-[7px]" style={{ left: labelW }}>
                  {t.label}
                </span>
              </div>
            ))}
            {weekends.map((d) =>
              dayTicks ? <div key={`w${d}`} aria-hidden className={cn("absolute", weekendHead)} style={{ left: xOfDay(d, axis), width: 2 * axis.pxPerDay, top: MAJOR_ROW, height: MINOR_ROW }} /> : null,
            )}
            {minor.map((t) => {
              const isToday = dayTicks && t.startDay === todayDay;
              return (
                <div
                  key={`m${t.startDay}`}
                  className={cn("absolute flex items-center overflow-hidden whitespace-nowrap border-l border-t text-xs text-muted", gridLine, dayTicks ? "justify-center" : "px-2")}
                  style={{ left: xOfDay(t.startDay, axis), width: (t.endDay - t.startDay) * axis.pxPerDay, top: MAJOR_ROW, height: MINOR_ROW }}
                >
                  {isToday ? (
                    <span data-today className="rounded-full bg-primary px-[7px] py-0.5 font-bold text-primary-fg" title="Today">
                      {t.label}
                    </span>
                  ) : (
                    t.label
                  )}
                </div>
              );
            })}
            {todayVisible && !dayTicks && (
              <span data-today className="absolute z-10 -translate-x-1/2 rounded-full bg-primary px-[7px] py-0.5 text-xs font-bold text-primary-fg" style={{ left: todayX, top: MAJOR_ROW + 7 }}>
                Today
              </span>
            )}
          </div>
        </div>

        {/* A word about a dependency being made or refused, pinned at the top left of the rows. */}
        <div aria-live="polite" className="sticky left-0 z-50 h-0 w-max max-w-full">
          {note && <p className="mx-2 mt-2 w-fit max-w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface px-3 py-1.5 text-[0.8125rem] shadow-pop">{note}</p>}
        </div>

        {/* Weekends and grid lines, under the rows so the row lines stay visible across weekends. */}
        <div className="pointer-events-none absolute" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {weekends.map((d) => (
            <div key={`w${d}`} className={cn("absolute inset-y-0", weekendBody)} style={{ left: xOfDay(d, axis), width: 2 * axis.pxPerDay }} />
          ))}
          {minor.map((t) => (
            <div key={t.startDay} className={cn("absolute inset-y-0 border-l", gridLine)} style={{ left: xOfDay(t.startDay, axis) }} />
          ))}
        </div>

        {/* Lane rows: the left column and the target of create-by-dragging. */}
        {placed.map((p, i) => {
          const cl = lanes[i]!;
          const lane = cl.lane;
          return (
            <div
              key={p.key || "__none"}
              data-lane={p.key}
              onPointerDown={(e) => startCreate(lane.key, e)}
              onPointerMove={(e) => laneGate.move(e) && moveCreate(e)}
              onPointerUp={(e) => laneGate.release(e) === "drag" && endCreate()}
              onPointerCancel={(e) => laneGate.release(e, true) === "drag" && endCreate(true)}
              onDragOver={(e) => {
                if (!props.onDropRecord || !e.dataTransfer.types.includes(RECORD_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const day = dayUnder(e.clientX);
                if (Number.isFinite(day)) setDropAt((cur) => (cur?.laneKey === lane.key && cur.day === day ? cur : { laneKey: lane.key, day }));
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
              }}
              onDrop={(e) => {
                setDropAt(null);
                const id = e.dataTransfer.getData(RECORD_DRAG_TYPE);
                const day = dayUnder(e.clientX);
                if (!id || !props.onDropRecord || !Number.isFinite(day)) return;
                e.preventDefault();
                props.onDropRecord(id, lane.key, day);
              }}
              className={cn("absolute left-0 border-b", gridLine, canCreate && "cursor-crosshair", !cl.recordId && lane.color && `ob-hue-${accentHue(lane.color)} ob-lane`)}
              style={{ top: HEADER_HEIGHT + p.top, height: p.height, width: labelW + width }}
            >
              {showLabels &&
                (cl.recordId ? (
                  <div className="sticky left-0 z-20 flex h-full items-center gap-2 border-r border-line bg-surface px-3.5" style={{ width: labelW }}>
                    <button type="button" onClick={() => props.onOpen(cl.recordId!)} className="min-w-0 flex-1 truncate text-left text-[0.875rem] font-medium hover:underline" title={lane.label}>
                      {lane.label}
                    </button>
                    {cl.sublabel && <span className="max-w-[45%] shrink-0 truncate text-[0.8125rem] text-muted">{cl.sublabel}</span>}
                  </div>
                ) : (
                  // A coloured lane's name sits on its colour (no dot), like a kanban stack's.
                  <div className={cn("pointer-events-none sticky left-0 z-20 flex h-full flex-col justify-center gap-0.5 border-r border-line px-3.5", lane.color ? `ob-hue-${accentHue(lane.color)} ob-fill` : "bg-surface")} style={{ width: labelW }}>
                    <span className="flex items-center gap-2 text-[0.875rem] font-medium">
                      <span className="truncate" title={lane.label}>
                        {lane.label}
                      </span>
                    </span>
                    <span className="text-xs text-muted">
                      {cl.bars.length} bar{cl.bars.length === 1 ? "" : "s"}
                    </span>
                    {/* Out of sight until it is tabbed to: adds a record to this lane on the day in view, for people who cannot drag. */}
                    {canCreate && (
                      <button
                        type="button"
                        onClick={() => {
                          const day = keyboardDay();
                          props.onCreate(lane.key, day, day);
                        }}
                        aria-label={`Add a record to ${lane.label || "this lane"}`}
                        title="Add a record on the day in view"
                        className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs font-semibold text-fg opacity-0 focus-visible:opacity-100"
                      >
                        <Plus aria-hidden className="size-3" /> Add
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
        })}

        {props.onAddRow && (
          <div className="absolute left-0 flex" style={{ top: HEADER_HEIGHT + lanesHeight, height: ADD_ROW, width: labelW + width }}>
            <button
              type="button"
              onClick={props.onAddRow}
              className="group/add sticky left-0 z-20 flex h-full shrink-0 items-center gap-1.5 border-r border-line bg-surface px-3.5 text-left text-[0.875rem] text-muted hover:bg-hover hover:text-fg"
              style={{ width: Math.max(labelW, 120) }}
            >
              {/* Quiet until the button is pointed at or focused (always shown on touch, which cannot hover). */}
              <span className="flex items-center gap-1.5 opacity-50 transition-opacity group-hover/add:opacity-100 group-focus-visible/add:opacity-100 pointer-coarse:opacity-100">
                <Plus aria-hidden className="size-[15px]" /> Add
              </span>
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute z-[5]" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {todayVisible && <div role="img" aria-label="Today" data-today-line className="absolute inset-y-0 -ml-px w-0.5 bg-primary opacity-55" style={{ left: todayX }} />}
          <svg className="absolute inset-0 overflow-visible" width={width} height={lanesHeight} role={props.onUnlink && arrows.length ? "group" : undefined} aria-label={props.onUnlink && arrows.length ? "Dependencies" : undefined} aria-hidden={props.onUnlink && arrows.length ? undefined : true}>
            <defs>
              <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--faint)" />
              </marker>
              <marker id="tl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--danger)" />
              </marker>
            </defs>
            {arrows.map(({ edge, d }) => {
              const key = edgeKey(edge.fromId, edge.toId);
              const on = key === selectedEdge;
              return (
                <g key={key}>
                  <path
                    d={d}
                    data-dependency={edge.violated ? "violated" : "ok"}
                    data-selected={on || undefined}
                    fill="none"
                    strokeWidth={on ? 3 : 1.5}
                    stroke={on ? "var(--primary)" : edge.violated ? "var(--danger)" : "var(--faint)"}
                    markerEnd={`url(#${edge.violated ? "tl-arrow-bad" : "tl-arrow"})`}
                  />
                  {/* A wide invisible stroke to point at, and the way to it from the keyboard: Delete removes the dependency. */}
                  {props.onUnlink && (
                    <path
                      d={d}
                      data-dependency-hit={key}
                      role="button"
                      tabIndex={0}
                      aria-label={`${edgeName(edge)}. Delete removes this dependency.`}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={coarse ? 24 : 14}
                      style={{ pointerEvents: "stroke", cursor: "pointer", outline: "none" }}
                      onClick={(e) => {
                        setSelectedEdge(key);
                        (e.currentTarget as SVGPathElement).focus();
                      }}
                      onFocus={() => setSelectedEdge(key)}
                      onBlur={() => setSelectedEdge((cur) => (cur === key ? null : cur))}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          unlink(edge);
                        } else if (e.key === "Escape") (e.currentTarget as SVGPathElement).blur();
                      }}
                    />
                  )}
                </g>
              );
            })}
            {linking && linkSource && (
              <>
                <path
                  d={`M ${linking.side === "end" ? linkSource.x + linkSource.width : linkSource.x} ${linkSource.y + BAR_HEIGHT / 2} L ${linking.x} ${linking.y}`}
                  data-link-preview
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                />
                <circle cx={linking.x} cy={linking.y} r={4} fill="var(--primary)" />
              </>
            )}
          </svg>
        </div>

        {/* Bars. */}
        <div ref={layer} className="pointer-events-none absolute z-10" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {lanes.flatMap((l) => l.bars).map((bar) => {
            const r = live(bar.id);
            if (!r) return null;
            const dragging = drag?.id === bar.id && drag.moved;
            const label = `${bar.title}, ${spanLabel(bar.span)}${bar.hint ? `. ${bar.hint}` : ""}`;
            // Only a laid-out chart knows its visible edges; before that every bar is drawn whole.
            const measured = view.right > view.left;
            const offLeft = measured && !r.milestone && r.x < view.left - 1;
            const offRight = measured && !r.milestone && r.x + r.width > view.right + 1;
            const hb = handleBox(r.width, coarse);
            const cs = coarse ? 20 : 12;
            // The knob a dependency is dragged from, beside the bar's edge: seen when the bar is pointed at or selected
            // (always, at the end, on a touch screen). Dropped on another bar it makes that one come after (end) or before (start).
            const connector = (side: "start" | "end", left: number) =>
              props.onLink && bar.canLink !== false && !(coarse && side === "start") ? (
                <span
                  aria-hidden
                  data-connector={side}
                  onPointerDown={(e) => startLink(bar, side, e)}
                  onPointerMove={(e) => {
                    e.stopPropagation();
                    if (linkGate.move(e)) moveLinkTo(bar, side, e.clientX, e.clientY);
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    if (linkGate.release(e) === "drag") endLink(bar);
                  }}
                  onPointerCancel={(e) => {
                    e.stopPropagation();
                    if (linkGate.release(e, true) === "drag") endLink(bar, true);
                  }}
                  title={side === "end" ? "Drag onto a bar to make it come after this one" : "Drag onto a bar to make it come before this one"}
                  className="absolute top-1/2 z-[2] -translate-y-1/2 cursor-crosshair rounded-full border-2 border-primary bg-surface opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 pointer-coarse:opacity-70"
                  style={{ left, width: cs, height: cs }}
                />
              ) : null;
            const described = props.describe?.(bar.id) ?? null;
            const withDescription = !!described && hasDescription(described.field, described.record, described.format);
            const el = (
              <div
                key={bar.id}
                role="button"
                tabIndex={0}
                aria-label={label}
                data-bar
                data-record-id={bar.id}
                data-milestone={r.milestone || undefined}
                data-violated={bar.violated || undefined}
                data-invalid={bar.span.reversed || undefined}
                data-link-target={linking?.targetId === bar.id || undefined}
                title={withDescription ? undefined : label}
                onPointerDown={(e) => startBar(bar, e)}
                onPointerMove={(e) => barGate.move(e) && moveBar(bar, e)}
                onPointerUp={(e) => {
                  const r = barGate.release(e);
                  // A mouse selects a bar it may move, for its keys (Delete); a bar it may not change has nothing
                  // to select for, and opens as before. A finger has no keys: a tap opens it.
                  const select = e.pointerType === "mouse" && bar.canMove;
                  if (r === "tap") {
                    if (select) e.currentTarget.focus();
                    else props.onOpen(bar.id);
                  } else if (r === "drag") endBar(bar, false, select ? e.currentTarget : undefined);
                }}
                onDoubleClick={() => props.onOpen(bar.id)}
                onPointerCancel={(e) => barGate.release(e, true) === "drag" && endBar(bar, true)}
                onKeyDown={(e) => barKey(bar, e)}
                className={cn(
                  // Selected (focused, by a click or the keyboard), it is outlined.
                  "group pointer-events-auto absolute flex touch-pan-x touch-pan-y select-none items-center [-webkit-touch-callout:none] outline-none focus:outline-2 focus:outline-offset-2 focus:outline-ring",
                  bar.canMove ? "cursor-grab" : "cursor-pointer",
                  dragging && "z-20 cursor-grabbing shadow-pop",
                  dragging && drag?.unschedule && "opacity-50",
                  !r.milestone &&
                    cn(
                      "ob-tl-bar rounded-[7px] border text-xs font-semibold transition-shadow hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)]",
                      bar.color ? choiceClass(bar.color) : "ob-tl-bar-plain",
                      offLeft && "rounded-l-none",
                      offRight && "rounded-r-none",
                      bar.violated && "ring-2 ring-danger",
                    ),
                  (linking?.targetId === bar.id || linkFrom === bar.id) && "ring-2 ring-primary",
                )}
                style={{ left: r.x, top: r.y, width: r.width, height: BAR_HEIGHT }}
              >
                {r.milestone ? (
                  <>
                    <span
                      aria-hidden
                      className={cn("size-3.5 shrink-0 rotate-45 rounded-[2px] border", bar.color ? choiceClass(bar.color) : "ob-tl-bar-plain", (bar.violated || bar.span.reversed) && "ring-2 ring-danger")}
                      style={{ marginLeft: (r.width - 14) / 2 }}
                    />
                    {/* A milestone gets an end by dragging this edge out (a reversed end is repaired the same way). */}
                    {bar.canResize && <span aria-hidden data-handle="end" className="absolute inset-y-0 z-[1] cursor-ew-resize rounded-r-[7px] hover:bg-black/15" style={{ right: -(coarse ? 14 : 8), width: coarse ? 22 : 12 }} />}
                    {connector("start", -(cs + 4))}
                    {connector("end", r.width + 4)}
                    <span className="pointer-events-none absolute whitespace-nowrap text-xs font-medium" style={{ left: r.width + 4 + (props.onLink ? cs + 4 : 0) }}>
                      {bar.label ?? bar.title}
                    </span>
                  </>
                ) : (
                  <>
                    {(bar.canResizeStart ?? bar.canResize) && <span aria-hidden data-handle="start" className="absolute inset-y-0 z-[1] cursor-ew-resize rounded-l-[7px] hover:bg-black/15" style={{ left: -hb.outside, width: hb.size }} />}
                    {connector("start", -(hb.outside + cs + 4))}
                    {/* Sticky, so the start of a bar scrolled past the left column still says what it is. */}
                    <span className="pointer-events-none sticky flex min-w-0 items-center gap-1.5 overflow-hidden px-2.5" style={{ left: labelW }}>
                      {offLeft && <ChevronLeft aria-hidden className="-ml-1 size-3.5 shrink-0" />}
                      <span className="truncate">{bar.label ?? bar.title}</span>
                    </span>
                    {offRight && (
                      <span className="pointer-events-none sticky right-0 ml-auto flex shrink-0 pr-1.5">
                        <ChevronRight aria-hidden className="size-3.5" />
                      </span>
                    )}
                    {bar.canResize && <span aria-hidden data-handle="end" className="absolute inset-y-0 z-[1] cursor-ew-resize rounded-r-[7px] hover:bg-black/15" style={{ right: -hb.outside, width: hb.size }} />}
                    {connector("end", r.width + hb.outside + 4)}
                  </>
                )}
                {dragging && drag && (
                  <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 text-[0.6875rem] text-surface">
                    {spanLabel(dragSpan(bar.span, drag.mode, drag.days))}
                  </span>
                )}
              </div>
            );
            // A bar is one line: pointing at it reads the record's description (never mid-drag).
            return withDescription && described ? (
              <DescriptionHover key={bar.id} field={described.field} record={described.record} title={bar.title} format={described.format} suppress={!!drag}>
                {el}
              </DescriptionHover>
            ) : (
              el
            );
          })}
          {selected && props.onUnlink && (
            <button
              type="button"
              tabIndex={-1}
              data-unlink
              aria-label={`Remove dependency: ${edgeName(selected.edge)}`}
              title="Remove this dependency"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => unlink(selected.edge)}
              className="pointer-events-auto absolute z-30 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-pop hover:text-danger pointer-coarse:size-9"
              style={{ left: selected.mid.x, top: selected.mid.y }}
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
          {creating?.moved && (
            <GhostBar creating={creating} spanDays={props.createSpansDays ?? true} axis={axis} top={(placed.find((p) => p.key === creating.laneKey)?.top ?? 0) + LANE_PAD + (ROW_HEIGHT - BAR_HEIGHT) / 2} />
          )}
          {dropAt && (
            <GhostBar
              creating={{ laneKey: dropAt.laneKey, fromDay: dropAt.day, toDay: dropAt.day, startX: 0, moved: true }}
              spanDays
              axis={axis}
              top={(placed.find((p) => p.key === dropAt.laneKey)?.top ?? 0) + LANE_PAD + (ROW_HEIGHT - BAR_HEIGHT) / 2}
            />
          )}
        </div>

        {!loading && totalBars === 0 && (
          <p className="pointer-events-none absolute z-10 max-w-[min(32rem,calc(100vw-4rem))] text-[0.8125rem] text-muted" role="status" style={{ top: HEADER_HEIGHT + 24, left: labelW + 24 }}>
            {props.emptyMessage ?? <>No records with dates in this range.{canCreate && " Drag across a lane to add one."}</>}
          </p>
        )}
      </div>
    </div>
  );
}

/** The days a new record would get: `spanDays` false saves only the first, so only that one is drawn. */
function GhostBar({ creating, spanDays, axis, top }: { creating: CreateState; spanDays: boolean; axis: Axis; top: number }) {
  const a = Math.min(creating.fromDay, creating.toDay);
  const b = spanDays ? Math.max(creating.fromDay, creating.toDay) + 1 : a + 1;
  return <div aria-hidden className="absolute rounded-[7px] border-2 border-dashed border-primary bg-primary-soft" style={{ left: xOfDay(a, axis), top, width: (b - a) * axis.pxPerDay, height: BAR_HEIGHT }} />;
}
