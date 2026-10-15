/**
 * The timeline chart: a scrolling time axis, a fixed left column (one row per record, or one per
 * swimlane), bars (or milestone diamonds), a today marker and dependency arrows, all plain DOM and
 * one SVG layer. Bars move and resize by dragging (whole days), empty lane space creates a record
 * by dragging across days, and bars also work from the keyboard (Enter opens, arrows move,
 * Shift+arrows resize the end).
 *
 * The chart is controlled: the host owns the axis window and writes dates. Scrolling near an
 * edge asks the host to extend the window, and the chart keeps the visible days steady when the
 * window or the scale changes. A bar that runs past the visible edge gets a square end and an
 * arrow there, and its label stays in view while it is scrolled.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { TimelineScale } from "@/api/types";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { choiceClass, colorDotClass } from "@/lib/colors";
import { swatchColor } from "@/lib/cells/palette";
import {
  BAR_HEIGHT,
  LANE_PAD,
  ROW_HEIGHT,
  arrowPath,
  axisWidth,
  barRect,
  centerDayOf,
  dayAtX,
  dragDays,
  dragSpan,
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
const ADD_ROW = 40;
const EDGE_PX = 240;

export interface TimelineBar extends BarInput {
  /** Palette colour name from the view's row colours. */
  color?: string;
  /** Text inside the bar when it is not the title (the dates, when the left column names the record). */
  label?: string;
  canMove: boolean;
  canResize: boolean;
  /** Dependency violated at this bar's start. */
  violated?: boolean;
}

export interface ChartLane {
  lane: Lane;
  bars: TimelineBar[];
  /** A second, quieter text in the left column (who a record is for). */
  sublabel?: string;
  /** The left column's name opens this record (rows that are one record each). */
  recordId?: string;
}

/** Imperative controls for the host's own ‹ Today › buttons. */
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
  canCreate: boolean;
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
  onCommit(recordId: string, mode: DragMode, days: number): void;
  onCreate(laneKey: string, fromDay: number, toDay: number): void;
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
  days: number;
  moved: boolean;
}

interface CreateState {
  laneKey: string;
  fromDay: number;
  toDay: number;
  startX: number;
  moved: boolean;
}

const gridLine = "border-[color-mix(in_srgb,var(--line)_55%,var(--surface))]";
const weekendBody = "bg-[color-mix(in_srgb,var(--bg)_55%,var(--surface))]";
const weekendHead = "bg-[color-mix(in_srgb,var(--line)_55%,var(--surface))]";

export function TimelineChart(props: TimelineChartProps) {
  const { axis, scale, lanes, edges, nowMs, showLabels, canCreate, focus, loading } = props;
  const wide = useMediaQuery("(min-width: 768px)");
  const labelW = showLabels ? (wide ? LABEL_WIDTH : LABEL_WIDTH_PHONE) : 0;
  const scroller = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Pointer handlers read the gesture from refs (events can arrive faster than React re-renders);
  // the state copies only drive what is drawn.
  const dragRef = useRef<DragState | null>(null);
  const creatingRef = useRef<CreateState | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const [creating, setCreatingState] = useState<CreateState | null>(null);
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

  // The visible width changes with the window and the sidebar, not only with scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => report(el));
    ro.observe(el);
    return () => ro.disconnect();
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    prev.current = { axis, scrollLeft: el.scrollLeft, width: visibleWidth(el) };
    report(el);
    if (el.scrollLeft < EDGE_PX) props.onNeedMore("start");
    else if (el.scrollWidth - el.clientWidth - el.scrollLeft < EDGE_PX) props.onNeedMore("end");
  };

  useImperativeHandle(props.ref, () => ({
    page: (dir) => {
      const el = scroller.current;
      if (!el) return;
      // Whole days, so a page lands on a day boundary like the first screen did.
      const days = Math.max(1, Math.floor(visibleWidth(el) / axis.pxPerDay));
      const target = el.scrollLeft + dir * days * axis.pxPerDay;
      if (typeof el.scrollTo === "function") el.scrollTo({ left: target, behavior: "smooth" });
      else el.scrollLeft = target;
    },
  }));

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
  const live = (id: string) => {
    const base = rects.get(id);
    if (!base) return undefined;
    if (!drag || drag.id !== id || drag.days === 0) return base;
    const bar = lanes.flatMap((l) => l.bars).find((b) => b.id === id);
    if (!bar) return base;
    const r = barRect(dragSpan(bar.span, drag.mode, drag.days), axis);
    return { ...base, x: r.x, width: r.width };
  };

  const startBar = (bar: TimelineBar, e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).dataset.handle as "start" | "end" | undefined;
    const mode: DragMode = handle ?? "move";
    if (mode === "move" ? !bar.canMove : !bar.canResize) {
      setDrag({ id: bar.id, mode: "move", startX: e.clientX, days: 0, moved: false });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: bar.id, mode, startX: e.clientX, days: 0, moved: false });
  };
  const moveBar = (bar: TimelineBar, e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== bar.id) return;
    const dx = e.clientX - d.startX;
    const allowed = d.mode === "move" ? bar.canMove : bar.canResize;
    setDrag({ ...d, days: allowed ? dragDays(dx, axis) : 0, moved: d.moved || Math.abs(dx) > 3 });
  };
  const endBar = (bar: TimelineBar, cancel = false) => {
    const d = dragRef.current;
    setDrag(null);
    if (!d || d.id !== bar.id || cancel) return;
    if (!d.moved) props.onOpen(bar.id);
    else if (d.days !== 0) props.onCommit(bar.id, d.mode, d.days);
  };
  const barKey = (bar: TimelineBar, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      props.onOpen(bar.id);
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
    e.currentTarget.setPointerCapture(e.pointerId);
    const day = dayUnder(e.clientX);
    setCreating({ laneKey, fromDay: day, toDay: day, startX: e.clientX, moved: false });
  };
  const moveCreate = (e: PointerEvent<HTMLDivElement>) => {
    const c = creatingRef.current;
    if (!c) return;
    setCreating({ ...c, toDay: dayUnder(e.clientX), moved: c.moved || Math.abs(e.clientX - c.startX) > 6 });
  };
  const endCreate = (cancel = false) => {
    const c = creatingRef.current;
    setCreating(null);
    if (c && c.moved && !cancel) props.onCreate(c.laneKey, c.fromDay, c.toDay);
  };

  // ---- dependency arrows ------------------------------------------------------------------------
  const arrows = edges.flatMap((edge) => {
    const from = live(edge.fromId);
    const to = live(edge.toId);
    if (!from || !to) return [];
    return [{ edge, d: arrowPath({ x: from.x + from.width, y: from.y + BAR_HEIGHT / 2 }, { x: to.x, y: to.y + BAR_HEIGHT / 2 }) }];
  });

  const todayX = xOfMs(nowMs, axis);
  const todayVisible = todayX >= 0 && todayX <= width;
  const todayDay = Math.floor(nowMs / 86_400_000);
  const dayTicks = minorIsDay(scale);
  const bodyHeight = lanesHeight + addRow;

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className={cn("relative overflow-auto", props.fitContent ? "min-h-0 shrink" : "h-full")}
      data-testid="timeline-scroller"
    >
      <div className="relative" style={{ width: labelW + width, minHeight: HEADER_HEIGHT + Math.max(bodyHeight, 1) }}>
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
              onPointerMove={moveCreate}
              onPointerUp={() => endCreate()}
              onPointerCancel={() => endCreate(true)}
              className={cn("absolute left-0 border-b", gridLine, canCreate && "cursor-crosshair")}
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
                  <div className="pointer-events-none sticky left-0 z-20 flex h-full flex-col justify-center gap-0.5 border-r border-line bg-surface px-3.5" style={{ width: labelW }}>
                    <span className="flex items-center gap-2 text-[0.875rem] font-medium">
                      {lane.color && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: swatchColor(lane.color) }} />}
                      <span className="truncate" title={lane.label}>
                        {lane.label}
                      </span>
                    </span>
                    <span className="text-xs text-muted">
                      {cl.bars.length} bar{cl.bars.length === 1 ? "" : "s"}
                    </span>
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
              className="sticky left-0 z-20 flex h-full shrink-0 items-center gap-1.5 border-r border-line bg-surface px-3.5 text-left text-[0.875rem] text-muted hover:bg-hover hover:text-fg"
              style={{ width: Math.max(labelW, 120) }}
            >
              <Plus aria-hidden className="size-[15px]" /> Add
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute z-[5]" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {todayVisible && <div className="absolute inset-y-0 -ml-px w-0.5 bg-primary opacity-55" style={{ left: todayX }} />}
          <svg className="absolute inset-0 overflow-visible" width={width} height={lanesHeight} aria-hidden>
            <defs>
              <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--faint)" />
              </marker>
              <marker id="tl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--danger)" />
              </marker>
            </defs>
            {arrows.map(({ edge, d }) => (
              <path
                key={`${edge.fromId}>${edge.toId}`}
                d={d}
                data-dependency={edge.violated ? "violated" : "ok"}
                fill="none"
                strokeWidth={1.5}
                stroke={edge.violated ? "var(--danger)" : "var(--faint)"}
                markerEnd={`url(#${edge.violated ? "tl-arrow-bad" : "tl-arrow"})`}
              />
            ))}
          </svg>
        </div>

        {/* Bars. */}
        <div ref={layer} className="pointer-events-none absolute z-10" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {lanes.flatMap((l) => l.bars).map((bar) => {
            const r = live(bar.id);
            if (!r) return null;
            const dragging = drag?.id === bar.id && drag.moved;
            const label = `${bar.title}, ${spanLabel(bar.span)}`;
            // Only a laid-out chart knows its visible edges; before that every bar is drawn whole.
            const measured = view.right > view.left;
            const offLeft = measured && !r.milestone && r.x < view.left - 1;
            const offRight = measured && !r.milestone && r.x + r.width > view.right + 1;
            return (
              <div
                key={bar.id}
                role="button"
                tabIndex={0}
                aria-label={label}
                data-bar
                data-record-id={bar.id}
                data-milestone={r.milestone || undefined}
                data-violated={bar.violated || undefined}
                title={label}
                onPointerDown={(e) => startBar(bar, e)}
                onPointerMove={(e) => moveBar(bar, e)}
                onPointerUp={() => endBar(bar)}
                onPointerCancel={() => endBar(bar, true)}
                onKeyDown={(e) => barKey(bar, e)}
                className={cn(
                  "pointer-events-auto absolute flex touch-none select-none items-center outline-none focus-visible:outline-2 focus-visible:outline-ring",
                  bar.canMove ? "cursor-grab" : "cursor-pointer",
                  dragging && "z-20 cursor-grabbing shadow-pop",
                  !r.milestone &&
                    cn(
                      "ob-tl-bar rounded-[7px] border text-xs font-semibold transition-shadow hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)]",
                      bar.color ? choiceClass(bar.color) : "ob-tl-bar-plain",
                      offLeft && "rounded-l-none",
                      offRight && "rounded-r-none",
                      bar.violated && "ring-2 ring-danger",
                    ),
                )}
                style={{ left: r.x, top: r.y, width: r.width, height: BAR_HEIGHT }}
              >
                {r.milestone ? (
                  <>
                    <span
                      aria-hidden
                      className={cn("size-3.5 shrink-0 rotate-45 rounded-[2px] border", bar.color ? choiceClass(bar.color) : "ob-tl-bar-plain", bar.violated && "ring-2 ring-danger")}
                      style={{ marginLeft: (r.width - 14) / 2 }}
                    />
                    <span className="pointer-events-none absolute whitespace-nowrap text-xs font-medium" style={{ left: r.width + 4 }}>
                      {bar.label ?? bar.title}
                    </span>
                  </>
                ) : (
                  <>
                    {bar.canResize && <span aria-hidden data-handle="start" className="absolute inset-y-0 left-0 z-[1] w-1.5 cursor-ew-resize rounded-l-[7px] hover:bg-black/15" />}
                    {/* Sticky, so the start of a bar scrolled past the left column still says what it is. */}
                    <span className="pointer-events-none sticky flex min-w-0 items-center gap-1.5 overflow-hidden px-2.5" style={{ left: labelW }}>
                      {offLeft && <ChevronLeft aria-hidden className="-ml-1 size-3.5 shrink-0" />}
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", bar.color ? colorDotClass(bar.color) : "bg-primary")} />
                      <span className="truncate">{bar.label ?? bar.title}</span>
                    </span>
                    {offRight && (
                      <span className="pointer-events-none sticky right-0 ml-auto flex shrink-0 pr-1.5">
                        <ChevronRight aria-hidden className="size-3.5" />
                      </span>
                    )}
                    {bar.canResize && <span aria-hidden data-handle="end" className="absolute inset-y-0 right-0 z-[1] w-1.5 cursor-ew-resize rounded-r-[7px] hover:bg-black/15" />}
                  </>
                )}
                {dragging && drag && (
                  <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 text-[0.6875rem] text-surface">
                    {spanLabel(dragSpan(bar.span, drag.mode, drag.days))}
                  </span>
                )}
              </div>
            );
          })}
          {creating?.moved && (
            <GhostBar creating={creating} axis={axis} top={(placed.find((p) => p.key === creating.laneKey)?.top ?? 0) + LANE_PAD + (ROW_HEIGHT - BAR_HEIGHT) / 2} />
          )}
        </div>

        {!loading && totalBars === 0 && (
          <p className="pointer-events-none absolute z-10 text-[0.8125rem] text-muted" style={{ top: HEADER_HEIGHT + 24, left: labelW + 24 }}>
            No records with dates in this range. Drag across a lane to add one.
          </p>
        )}
      </div>
    </div>
  );
}

function GhostBar({ creating, axis, top }: { creating: CreateState; axis: Axis; top: number }) {
  const a = Math.min(creating.fromDay, creating.toDay);
  const b = Math.max(creating.fromDay, creating.toDay) + 1;
  return <div aria-hidden className="absolute rounded-[7px] border-2 border-dashed border-primary bg-primary-soft" style={{ left: xOfDay(a, axis), top, width: (b - a) * axis.pxPerDay, height: BAR_HEIGHT }} />;
}
