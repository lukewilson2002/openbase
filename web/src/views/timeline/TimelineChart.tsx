/**
 * The timeline chart: a scrolling time axis, swimlanes, bars (or milestone diamonds), a today
 * marker and dependency arrows, all plain DOM and one SVG layer. Bars move and resize by
 * dragging (whole days), empty lane space creates a record by dragging across days, and bars
 * also work from the keyboard (Enter opens, arrows move, Shift+arrows resize the end).
 *
 * The chart is controlled: the host owns the axis window and writes dates. Scrolling near an
 * edge asks the host to extend the window, and the chart keeps the visible days steady when the
 * window or the scale changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TimelineScale } from "@/api/types";
import { cn } from "@/lib/cn";
import { paletteColor } from "@/lib/cells/palette";
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
  minorTicks,
  xOfDay,
  xOfMs,
  type Axis,
  type BarInput,
  type DependencyEdge,
  type DragMode,
} from "./geometry";
import { spanLabel, type Lane } from "./lanes";

export const HEADER_HEIGHT = 52;
export const LABEL_WIDTH = 168;
const EDGE_PX = 240;

export interface TimelineBar extends BarInput {
  /** Palette colour name from the view's row colours. */
  color?: string;
  canMove: boolean;
  canResize: boolean;
  /** Dependency violated at this bar's start. */
  violated?: boolean;
}

export interface ChartLane {
  lane: Lane;
  bars: TimelineBar[];
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
  canCreate: boolean;
  /** Centre the chart on this day when `nonce` changes. */
  focus: { day: number; nonce: number } | null;
  loading: boolean;
  onOpen(recordId: string): void;
  onCommit(recordId: string, mode: DragMode, days: number): void;
  onCreate(laneKey: string, fromDay: number, toDay: number): void;
  onNeedMore(side: "start" | "end"): void;
  onZoom(dir: "in" | "out"): void;
  /** The day at the centre of the visible chart, reported after scrolling and layout changes. */
  onCenter(day: number): void;
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

export function TimelineChart(props: TimelineChartProps) {
  const { axis, scale, lanes, edges, nowMs, showLabels, canCreate, focus, loading } = props;
  const labelW = showLabels ? LABEL_WIDTH : 0;
  const scroller = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Pointer handlers read the gesture from refs (events can arrive faster than React re-renders);
  // the state copies only drive what is drawn.
  const dragRef = useRef<DragState | null>(null);
  const creatingRef = useRef<CreateState | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const [creating, setCreatingState] = useState<CreateState | null>(null);
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
  const totalBars = lanes.reduce((n, l) => n + l.bars.length, 0);

  // ---- keep the view steady when the window or scale changes, and honour focus requests -------
  const prev = useRef<{ axis: Axis; scrollLeft: number; width: number } | null>(null);
  const lastFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const viewW = Math.max(0, el.clientWidth - labelW);
    const before = prev.current;
    if (before && (before.axis.fromDay !== axis.fromDay || before.axis.pxPerDay !== axis.pxPerDay)) {
      if (before.axis.pxPerDay === axis.pxPerDay) el.scrollLeft = before.scrollLeft + (before.axis.fromDay - axis.fromDay) * axis.pxPerDay;
      else el.scrollLeft = xOfDay(centerDayOf(before.scrollLeft, before.width, before.axis), axis) - viewW / 2;
    }
    if (focus && lastFocus.current !== focus.nonce) {
      lastFocus.current = focus.nonce;
      el.scrollLeft = xOfDay(focus.day, axis) - viewW / 2;
    }
    prev.current = { axis, scrollLeft: el.scrollLeft, width: viewW };
    props.onCenter(centerDayOf(el.scrollLeft, viewW, axis));
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const viewW = Math.max(0, el.clientWidth - labelW);
    prev.current = { axis, scrollLeft: el.scrollLeft, width: viewW };
    props.onCenter(centerDayOf(el.scrollLeft, viewW, axis));
    if (el.scrollLeft < EDGE_PX) props.onNeedMore("start");
    else if (el.scrollWidth - el.clientWidth - el.scrollLeft < EDGE_PX) props.onNeedMore("end");
  };

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

  return (
    <div ref={scroller} onScroll={onScroll} className="relative h-full overflow-auto" data-testid="timeline-scroller">
      <div className="relative" style={{ width: labelW + width, minHeight: HEADER_HEIGHT + Math.max(lanesHeight, 1) }}>
        {/* Header: two tick rows, pinned to the top. */}
        <div className="sticky top-0 z-30 flex border-b border-line bg-surface" style={{ height: HEADER_HEIGHT }}>
          {showLabels && <div className="sticky left-0 z-40 shrink-0 border-r border-line bg-surface" style={{ width: LABEL_WIDTH }} />}
          <div className="relative overflow-clip" style={{ width }}>
            {major.map((t) => (
              <div key={`M${t.startDay}`} className="absolute top-0 h-[26px] overflow-clip border-l border-line text-xs font-medium text-muted" style={{ left: xOfDay(t.startDay, axis), width: (t.endDay - t.startDay) * axis.pxPerDay }}>
                <span className="sticky inline-block whitespace-nowrap px-2 py-1" style={{ left: labelW }}>
                  {t.label}
                </span>
              </div>
            ))}
            {minor.map((t) => (
              <div key={`m${t.startDay}`} className="absolute top-[26px] h-[26px] overflow-hidden whitespace-nowrap border-l border-t border-line px-1.5 py-1 text-xs text-muted" style={{ left: xOfDay(t.startDay, axis), width: (t.endDay - t.startDay) * axis.pxPerDay }}>
                {t.label}
              </div>
            ))}
            {todayVisible && (
              <span className="absolute top-0 z-10 -translate-x-1/2 rounded-b bg-danger px-1.5 text-[0.6875rem] font-medium leading-4 text-danger-fg" style={{ left: todayX }}>
                Today
              </span>
            )}
          </div>
        </div>

        {/* Lane rows: backgrounds, labels and the target of create-by-dragging. */}
        {placed.map((p, i) => {
          const lane = lanes[i]!.lane;
          return (
            <div
              key={p.key || "__none"}
              data-lane={p.key}
              onPointerDown={(e) => startCreate(lane.key, e)}
              onPointerMove={moveCreate}
              onPointerUp={() => endCreate()}
              onPointerCancel={() => endCreate(true)}
              className={cn("absolute left-0 border-b border-line", canCreate && "cursor-crosshair")}
              style={{ top: HEADER_HEIGHT + p.top, height: p.height, width: labelW + width }}
            >
              {showLabels && (
                <div className="pointer-events-none sticky left-0 z-20 flex h-full flex-col gap-0.5 border-r border-line bg-surface px-2 py-2" style={{ width: LABEL_WIDTH }}>
                  <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
                    {lane.color && <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: paletteColor(lane.color).bg }} />}
                    <span className="truncate" title={lane.label}>
                      {lane.label}
                    </span>
                  </span>
                  <span className="text-xs text-muted">{lanes[i]!.bars.length} bar{lanes[i]!.bars.length === 1 ? "" : "s"}</span>
                </div>
              )}
            </div>
          );
        })}

        {/* Grid lines, today line and arrows. */}
        <div className="pointer-events-none absolute z-[5]" style={{ left: labelW, top: HEADER_HEIGHT, width, height: lanesHeight }}>
          {minor.map((t) => (
            <div key={t.startDay} className="absolute inset-y-0 border-l border-line/60" style={{ left: xOfDay(t.startDay, axis) }} />
          ))}
          {todayVisible && <div className="absolute inset-y-0 w-px bg-danger" style={{ left: todayX }} />}
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
            const p = bar.color ? paletteColor(bar.color) : null;
            const label = `${bar.title}, ${spanLabel(bar.span)}`;
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
                  r.milestone ? "" : cn("rounded-md text-xs font-medium", !p && "bg-primary text-primary-fg", bar.violated && "ring-2 ring-danger"),
                )}
                style={{ left: r.x, top: r.y, width: r.width, height: BAR_HEIGHT, ...(!r.milestone && p ? { background: p.bg, color: p.fg } : {}) }}
              >
                {r.milestone ? (
                  <>
                    <span aria-hidden className={cn("size-3.5 shrink-0 rotate-45 rounded-[2px]", !p && "bg-primary", bar.violated && "ring-2 ring-danger")} style={{ marginLeft: (r.width - 14) / 2, ...(p ? { background: p.bg, outline: `1px solid ${p.fg}` } : {}) }} />
                    <span className="pointer-events-none absolute whitespace-nowrap text-xs font-medium" style={{ left: r.width + 4 }}>
                      {bar.title}
                    </span>
                  </>
                ) : (
                  <>
                    {bar.canResize && <span aria-hidden data-handle="start" className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md hover:bg-black/20" />}
                    <span className="pointer-events-none min-w-0 flex-1 truncate px-2">{bar.title}</span>
                    {bar.canResize && <span aria-hidden data-handle="end" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md hover:bg-black/20" />}
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
  return <div aria-hidden className="absolute rounded-md border-2 border-dashed border-primary bg-primary-soft" style={{ left: xOfDay(a, axis), top, width: (b - a) * axis.pxPerDay, height: BAR_HEIGHT }} />;
}

