/**
 * Timeline view (with Gantt mode): records as bars from a start to an end date (a diamond when
 * there is no end), in swimlanes, with dependency arrows from a link-to-self field. Only the
 * dates around the visible window are queried (`QueryRequest.range`); the window grows as you
 * scroll toward its edges.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { CalendarCheck, Plus, ZoomIn, ZoomOut } from "lucide-react";
import type { DateRange, TimelineScale, ViewConfig } from "@/api/types";
import { isGroupable } from "@/components/viewbar/config";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { resolveDateFields } from "../common/dateFields";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, SetupPrompt, ViewSettings } from "../common/ViewSettings";
import { ViewFrame } from "../common/ViewFrame";
import { DAY_MS, isDateLike, isWritableDate, padRange, recordSpan, wallNow, wallYmd, type Span } from "../common/wallTime";
import { cardTitle } from "../common/cardFields";
import type { ViewProps } from "../types";
import { SCALES, SCALE_LABELS, dayNumber, dependencyEdges, dragSpan, extendAxis, makeAxis, stepScale, type Axis, type DragMode } from "./geometry";
import { NO_LANE, createWrites, dragWrites, groupIntoLanes, lanesFromGroups, type Lane } from "./lanes";
import { TimelineChart, type ChartLane, type TimelineBar } from "./TimelineChart";

/** The window never grows past about a century of days. */
const MAX_WINDOW_DAYS = 40_000;

export default function TimelineView(props: ViewProps) {
  return <TimelineInner key={props.view.id} {...props} />;
}

function setTimeline(c: ViewConfig, patch: Partial<ViewConfig["timeline"]>): ViewConfig {
  return { ...c, timeline: { ...c.timeline, ...patch } };
}

function TimelineInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, timeZone } = setup;
  const tl = config.timeline;
  const fields = useMemo(() => resolveDateFields(table.fields, tl.start_field_id, tl.end_field_id), [table.fields, tl.start_field_id, tl.end_field_id]);
  const dateFields = useMemo(() => table.fields.filter(isDateLike), [table.fields]);
  const groupFields = useMemo(() => table.fields.filter(isGroupable), [table.fields]);
  const groupField = table.fields.find((f) => f.id === tl.group_field_id);
  const selfLinks = useMemo(() => table.fields.filter((f) => f.type === "link" && f.options.linked_table_id === table.id), [table.fields]);
  const depField = selfLinks.find((f) => f.id === tl.dependency_field_id);

  // Viewers cannot save the scale, so they keep their own choice for the session.
  const [localScale, setLocalScale] = useState<TimelineScale | null>(null);
  const scale: TimelineScale = cfg.canConfigure ? tl.scale : (localScale ?? tl.scale);

  const today = dayNumber(wallNow(timeZone));
  const [axis, setAxis] = useState<Axis>(() => makeAxis(scale, today));
  const [focus, setFocus] = useState<{ day: number; nonce: number } | null>({ day: today, nonce: 1 });
  const centerDay = useRef(today);

  const range = useMemo<DateRange | null>(() => {
    if (!fields) return null;
    const padded = padRange(wallYmd(axis.fromDay * DAY_MS), wallYmd((axis.toDay - 1) * DAY_MS), 1);
    return padded && { field_id: fields.start.field.id, end_field_id: fields.end?.field.id ?? null, ...padded };
  }, [fields, axis.fromDay, axis.toDay]);
  const records = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, range, enabled: !!range });
  const data = records.data;

  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const canEditDates = setup.canEdit && isWritableDate(fields?.start.field);
  const endWritable = !fields?.end || isWritableDate(fields.end.field);

  // ---- bars, lanes, dependencies -----------------------------------------------------------------
  const spans = useMemo(() => {
    const m = new Map<string, Span>();
    if (!fields || !data) return m;
    for (const r of data.records) {
      const s = recordSpan(r.values, { id: fields.start.field.id, opts: fields.start.opts }, fields.end && { id: fields.end.field.id, opts: fields.end.opts }, timeZone);
      if (s) m.set(r.id, s);
    }
    return m;
  }, [fields, data, timeZone]);

  const edges = useMemo(() => (depField && data ? dependencyEdges(data.records, depField.id, spans) : []), [depField, data, spans]);
  const violatedTargets = useMemo(() => new Set(edges.filter((e) => e.violated).map((e) => e.toId)), [edges]);

  const laneModels = useMemo<Lane[]>(() => {
    if (!data) return [{ ...NO_LANE }];
    if (groupField) return groupIntoLanes(data.records, groupField, setup.format);
    if (data.groups.length > 0) return lanesFromGroups(data.records, data.groups);
    return [{ ...NO_LANE, records: data.records }];
  }, [data, groupField, setup.format]);

  const chartLanes = useMemo<ChartLane[]>(
    () =>
      laneModels.map((lane) => ({
        lane,
        bars: lane.records.flatMap((r): TimelineBar[] => {
          const span = spans.get(r.id);
          if (!span) return [];
          return [
            {
              id: r.id,
              title: cardTitle(primary, r, setup.format),
              span,
              color: data?.colors[r.id],
              canMove: canEditDates && endWritable,
              canResize: canEditDates && endWritable && span.hasEnd && !!fields?.end,
              violated: violatedTargets.has(r.id),
            },
          ];
        }),
      })),
    [laneModels, spans, primary, setup.format, data?.colors, canEditDates, endWritable, fields?.end, violatedTargets],
  );
  const barCount = chartLanes.reduce((n, l) => n + l.bars.length, 0);
  const showLabels = chartLanes.length > 1 || chartLanes.some((l) => l.lane.label !== "");

  // ---- axis and scale ------------------------------------------------------------------------------
  const changeScale = useCallback(
    (next: TimelineScale) => {
      if (next === scale) return;
      if (cfg.canConfigure) cfg.update((c) => setTimeline(c, { scale: next }));
      else setLocalScale(next);
      setAxis(makeAxis(next, centerDay.current));
    },
    [scale, cfg],
  );
  const onNeedMore = useCallback(
    (side: "start" | "end") =>
      setAxis((a) => (a.toDay - a.fromDay >= MAX_WINDOW_DAYS ? a : extendAxis(a, side, scale))),
    [scale],
  );
  const goToday = () => {
    const now = dayNumber(wallNow(timeZone));
    if (now < axis.fromDay + 10 || now > axis.toDay - 10) setAxis(makeAxis(scale, now));
    setFocus((f) => ({ day: now, nonce: (f?.nonce ?? 0) + 1 }));
  };

  // ---- writes ------------------------------------------------------------------------------------
  const onCommit = useCallback(
    (recordId: string, mode: DragMode, days: number) => {
      const span = spans.get(recordId);
      if (!span || !fields) return;
      const values = dragWrites(span, dragSpan(span, mode, days), mode, fields, timeZone);
      if (Object.keys(values).length > 0) void writes.update(recordId, values);
    },
    [spans, fields, timeZone, writes],
  );
  const create = useCallback(
    async (values: Record<string, unknown>) => {
      const rec = await writes.create(values);
      if (rec) setup.openRecord(rec.id);
    },
    [writes, setup],
  );
  const onCreate = useCallback(
    (laneKey: string, fromDay: number, toDay: number) => {
      if (!fields) return;
      const values: Record<string, unknown> = createWrites(fromDay, toDay, fields, timeZone);
      const lane = laneModels.find((l) => l.key === laneKey);
      if (lane?.fieldId && lane.value !== undefined && lane.value !== null && !(lane.fieldId in values)) values[lane.fieldId] = lane.value;
      void create(values);
    },
    [fields, timeZone, laneModels, create],
  );

  // ---- toolbar -------------------------------------------------------------------------------------
  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <>
      <ViewSettings label="Timeline settings" note={note}>
        <FieldSelect label="Start date field" fields={dateFields} value={fields?.start.field.id ?? ""} disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setTimeline(c, { start_field_id: id }))} />
        <FieldSelect
          label="End date field"
          fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
          value={fields?.end?.field.id ?? ""}
          noneLabel="No end date (milestones)"
          disabled={!cfg.canConfigure || !fields}
          onChange={(id) => cfg.update((c) => setTimeline(c, { end_field_id: id }))}
        />
        <FieldSelect label="Swimlanes" fields={groupFields} value={groupField?.id ?? ""} noneLabel="No swimlanes" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setTimeline(c, { group_field_id: id }))} hint="Without a field, the view's grouping (if any) makes the lanes." />
        <FieldSelect
          label="Dependencies"
          fields={selfLinks}
          value={depField?.id ?? ""}
          noneLabel="No dependencies"
          disabled={!cfg.canConfigure}
          onChange={(id) => cfg.update((c) => setTimeline(c, { dependency_field_id: id }))}
          hint={selfLinks.length === 0 ? "Add a link field to this same table to draw dependency arrows (Gantt)." : "Arrows run from each linked predecessor's end to the record's start; red when they overlap."}
        />
      </ViewSettings>
      {fields && (
        <>
          <label className="sr-only" htmlFor="timeline-scale">
            Timeline scale
          </label>
          <span className="w-28">
            <Select id="timeline-scale" value={scale} onChange={(e) => changeScale(e.target.value as TimelineScale)} className="h-7 text-[0.8125rem]">
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {SCALE_LABELS[s]}
                </option>
              ))}
            </Select>
          </span>
          <IconButton label="Zoom out" size="sm" disabled={scale === "year"} onClick={() => changeScale(stepScale(scale, "out"))}>
            <ZoomOut aria-hidden className="size-4" />
          </IconButton>
          <IconButton label="Zoom in" size="sm" disabled={scale === "day"} onClick={() => changeScale(stepScale(scale, "in"))}>
            <ZoomIn aria-hidden className="size-4" />
          </IconButton>
          <Button size="sm" variant="ghost" onClick={goToday}>
            <CalendarCheck aria-hidden className="size-4" /> Today
          </Button>
          {canEditDates && (
            <Button size="sm" variant="ghost" onClick={() => void create(createWrites(dayNumber(wallNow(timeZone)), dayNumber(wallNow(timeZone)), fields, timeZone))}>
              <Plus aria-hidden className="size-4" /> Add record
            </Button>
          )}
        </>
      )}
    </>
  );

  const body = !fields ? (
    <SetupPrompt
      title="Choose the date fields"
      description={dateFields.length === 0 ? "This table has no date field. Add one to place records on the timeline." : cfg.canConfigure ? "Pick the field that says when each record starts. Add an end field for bars; without one, records are milestones." : "Ask someone who can edit this view to pick the date fields."}
    >
      {dateFields.length > 0 && cfg.canConfigure && <FieldSelect label="Start date field" fields={dateFields} value="" onChange={(id) => cfg.update((c) => setTimeline(c, { start_field_id: id }))} />}
    </SetupPrompt>
  ) : (
    <div className="absolute inset-0">
      <TimelineChart
        axis={axis}
        scale={scale}
        lanes={chartLanes}
        edges={edges}
        nowMs={wallNow(timeZone)}
        showLabels={showLabels}
        canCreate={canEditDates && endWritable}
        focus={focus}
        loading={records.loading}
        onOpen={setup.openRecord}
        onCommit={onCommit}
        onCreate={onCreate}
        onNeedMore={onNeedMore}
        onZoom={(dir) => changeScale(stepScale(scale, dir))}
        onCenter={(d) => {
          centerDay.current = d;
        }}
      />
      {records.fetching && (
        <div className="pointer-events-none absolute right-4 top-14 z-40">
          <Spinner className="size-4" label="Loading records" />
        </div>
      )}
    </div>
  );

  return (
    <ViewFrame
      setup={setup}
      recordIds={data?.records.map((r) => r.id)}
      features={{ group: true, rowHeight: false }}
      hideFieldsNoun="Bar fields"
      toolbarExtra={settings}
      footer={
        fields ? (
          <>
            <span aria-live="polite">
              {barCount.toLocaleString()} record{barCount === 1 ? "" : "s"} in this window
            </span>
            {depField && edges.some((e) => e.violated) && <span className="text-danger">{edges.filter((e) => e.violated).length} dependencies overlap</span>}
            {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records in this window.</span>}
            {records.error && !data && <span role="alert">Could not load records: {records.error.message}</span>}
            <span className="hidden sm:inline">Drag bars to move, edges to resize, empty lane space to add. Ctrl+scroll zooms.</span>
            {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
          </>
        ) : undefined
      }
    >
      {body}
    </ViewFrame>
  );
}
