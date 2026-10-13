/**
 * A shared timeline: the signed-in timeline chart with every editing gesture switched off (no
 * drag, resize or create), fed with the records of the share. The window starts around today and
 * is widened to cover every dated record; scrolling toward an edge extends it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, ZoomIn, ZoomOut } from "lucide-react";
import type { Field, TimelineScale, TransientConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cardTitle } from "@/views/common/cardFields";
import type { DateFields } from "@/views/common/dateFields";
import { DAY_MS, recordSpan, wallNow, type Span } from "@/views/common/wallTime";
import { PX_PER_DAY, SCALES, SCALE_LABELS, dayNumber, extendAxis, makeAxis, stepScale, type Axis } from "@/views/timeline/geometry";
import { NO_LANE, groupIntoLanes, lanesFromGroups, type Lane } from "@/views/timeline/lanes";
import { TimelineChart, type ChartLane } from "@/views/timeline/TimelineChart";
import { useShare } from "./ShareContext";
import { usePublicAll } from "./usePublicRecords";
import type { SharedFields } from "./publicFields";

const MAX_WINDOW_DAYS = 40_000;
const NOOP = () => {};

/** The default window for `scale`, widened to include `[firstDay, lastDay]` (padded a fortnight). */
export function axisCovering(scale: TimelineScale, centerDay: number, firstDay: number | null, lastDay: number | null): Axis {
  const base = makeAxis(scale, centerDay);
  if (firstDay === null || lastDay === null) return base;
  const fromDay = Math.min(base.fromDay, firstDay - 14);
  const toDay = Math.max(base.toDay, lastDay + 14);
  return toDay - fromDay > MAX_WINDOW_DAYS ? base : { ...base, fromDay, toDay };
}

export interface PublicTimelineProps {
  fields: SharedFields;
  dates: DateFields;
  groupField: Field | undefined;
  search: string;
  transient: TransientConfig | null;
}

export function PublicTimeline({ fields, dates, groupField, search, transient }: PublicTimelineProps) {
  const { token, password, format } = useShare();
  const zone = format.timeZone;
  const records = usePublicAll({ token, password, fields, search, timeZone: zone, transient });
  const data = records.data;
  const today = dayNumber(wallNow(zone));
  const [scale, setScale] = useState<TimelineScale>("week");
  const [grown, setGrown] = useState<{ scale: TimelineScale; axis: Axis } | null>(null);
  const [focus, setFocus] = useState<{ day: number; nonce: number }>({ day: today, nonce: 0 });
  const centerDay = useRef(today);
  const placed = useRef(false);

  const spans = useMemo(() => {
    const m = new Map<string, Span>();
    for (const r of data?.records ?? []) {
      const s = recordSpan(r.values, { id: dates.start.field.id, opts: dates.start.opts }, dates.end && { id: dates.end.field.id, opts: dates.end.opts }, zone);
      if (s) m.set(r.id, s);
    }
    return m;
  }, [data, dates, zone]);

  const [firstDay, lastDay] = useMemo<[number | null, number | null]>(() => {
    let lo: number | null = null;
    let hi: number | null = null;
    for (const s of spans.values()) {
      const a = Math.floor(s.startMs / DAY_MS);
      const b = Math.floor(Math.max(s.endMs - 1, s.startMs) / DAY_MS);
      lo = lo === null ? a : Math.min(lo, a);
      hi = hi === null ? b : Math.max(hi, b);
    }
    return [lo, hi];
  }, [spans]);

  // Once the records are in, open at today, or at the nearest day with records when today has none.
  useEffect(() => {
    if (placed.current || firstDay === null || lastDay === null) return;
    placed.current = true;
    setFocus((f) => ({ day: Math.min(Math.max(today, firstDay), lastDay), nonce: f.nonce + 1 }));
  }, [firstDay, lastDay, today]);

  const base = useMemo(() => axisCovering(scale, today, firstDay, lastDay), [scale, today, firstDay, lastDay]);
  // Scrolling near an edge widens the window; changing the scale starts over from the base window.
  const axis = useMemo<Axis>(
    () => (grown && grown.scale === scale && grown.axis.pxPerDay === PX_PER_DAY[scale] ? { ...base, fromDay: Math.min(base.fromDay, grown.axis.fromDay), toDay: Math.max(base.toDay, grown.axis.toDay) } : base),
    [grown, scale, base],
  );

  const lanes = useMemo<Lane[]>(() => {
    if (!data) return [{ ...NO_LANE }];
    if (groupField) return groupIntoLanes(data.records, groupField, format);
    if (data.groups.length > 0) return lanesFromGroups(data.records, data.groups);
    return [{ ...NO_LANE, records: data.records }];
  }, [data, groupField, format]);

  const chartLanes = useMemo<ChartLane[]>(
    () =>
      lanes.map((lane) => ({
        lane,
        bars: lane.records.flatMap((r) => {
          const span = spans.get(r.id);
          return span ? [{ id: r.id, title: cardTitle(fields.title, r, format), span, color: data?.colors[r.id], canMove: false, canResize: false }] : [];
        }),
      })),
    [lanes, spans, fields.title, format, data?.colors],
  );
  const barCount = chartLanes.reduce((n, l) => n + l.bars.length, 0);
  const showLabels = chartLanes.length > 1 || chartLanes.some((l) => l.lane.label !== "");

  const onNeedMore = useCallback(
    (side: "start" | "end") => {
      if (axis.toDay - axis.fromDay >= MAX_WINDOW_DAYS) return;
      setGrown({ scale, axis: extendAxis(axis, side, scale) });
    },
    [axis, scale],
  );

  return (
    <section aria-label="Timeline" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="public-timeline-scale">
          Timeline scale
        </label>
        <span className="w-28">
          <Select id="public-timeline-scale" value={scale} onChange={(e) => setScale(e.target.value as TimelineScale)} className="h-7 text-[0.8125rem]">
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {SCALE_LABELS[s]}
              </option>
            ))}
          </Select>
        </span>
        <IconButton label="Zoom out" size="sm" disabled={scale === "year"} onClick={() => setScale(stepScale(scale, "out"))}>
          <ZoomOut aria-hidden className="size-4" />
        </IconButton>
        <IconButton label="Zoom in" size="sm" disabled={scale === "day"} onClick={() => setScale(stepScale(scale, "in"))}>
          <ZoomIn aria-hidden className="size-4" />
        </IconButton>
        <Button size="sm" onClick={() => setFocus((f) => ({ day: today, nonce: f.nonce + 1 }))}>
          <CalendarCheck aria-hidden className="size-4" /> Today
        </Button>
        {records.fetching && <Spinner className="size-4" label="Loading records" />}
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {barCount.toLocaleString()} record{barCount === 1 ? "" : "s"} with dates
        </span>
      </div>
      {records.error && !data && <p role="alert" className="text-[0.8125rem] text-danger">Could not load records: {records.error.message}</p>}
      <div className="relative h-[min(36rem,70dvh)] overflow-hidden rounded-lg border border-line bg-surface">
        <TimelineChart
          axis={axis}
          scale={scale}
          lanes={chartLanes}
          edges={[]}
          nowMs={wallNow(zone)}
          showLabels={showLabels}
          canCreate={false}
          focus={focus}
          loading={records.loading}
          onOpen={NOOP}
          onCommit={NOOP}
          onCreate={NOOP}
          onNeedMore={onNeedMore}
          onZoom={(dir) => setScale((s) => stepScale(s, dir))}
          onCenter={(d) => {
            centerDay.current = d;
          }}
        />
      </div>
      {data?.truncated && <p className="text-xs text-muted">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records.</p>}
    </section>
  );
}
