/**
 * Timeline view (with Gantt mode): records as bars from a start to an end date (a diamond when
 * there is no end), with dependency arrows from a link-to-self field. Without swimlanes every
 * record has its own row, named in the left column, and its bar says its dates; with swimlanes
 * (a lane field or the view's grouping) the lanes pack their bars. Only the dates around the
 * visible window are queried (`QueryRequest.range`); the window grows as you scroll toward its edges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRange, Field, TimelineScale, ViewConfig } from "@/api/types";
import { isGroupable } from "@/components/viewbar/config";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { displayText } from "@/lib/cells/format";
import { resolveDateFields } from "../common/dateFields";
import { unscheduledTransient } from "../calendar/eventMath";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import { DAY_MS, isDateLike, isWritableDate, padRange, recordSpan, wallNow, wallYmd, type Span } from "../common/wallTime";
import { cardFields, cardTitle, fieldsToShow, itemsLabel } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField, type DescriptionSource } from "../common/description";
import type { ViewProps } from "../types";
import { PX_PER_DAY, SCALES, SCALE_LABELS, dayNumber, dependencyEdges, dragSpan, extendAxis, makeAxis, rangeTitle, stepScale, type Axis, type DragMode } from "./geometry";
import { NO_LANE, createWrites, dragWrites, groupIntoLanes, lanesFromGroups, spanLabel, type Lane } from "./lanes";
import { TimelineChart, type ChartLane, type TimelineBar, type TimelineChartHandle } from "./TimelineChart";

/** The window never grows past about a century of days. */
const MAX_WINDOW_DAYS = 40_000;

export default function TimelineView(props: ViewProps) {
  return <TimelineInner key={props.view.id} {...props} />;
}

function setTimeline(c: ViewConfig, patch: Partial<ViewConfig["timeline"]>): ViewConfig {
  return { ...c, timeline: { ...c.timeline, ...patch } };
}

/** The start and end a new timeline most likely wants: the first two date fields people fill in. */
export function likelyDates(fields: readonly Field[]): { start: Field | undefined; end: Field | undefined } {
  const writable = fields.filter(isWritableDate);
  const start = writable[0] ?? fields[0];
  return { start, end: writable.find((f) => f !== start) };
}

const SCALE_OPTIONS = SCALES.map((s) => ({ value: s, label: SCALE_LABELS[s] }));

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
  const [focus, setFocus] = useState<{ day: number; nonce: number; align: "start" } | null>({ day: today, nonce: 1, align: "start" });
  const [shown, setShown] = useState<{ from: number; last: number } | null>(null);
  const chart = useRef<TimelineChartHandle>(null);
  const centerDay = useRef(today);

  // The scale can also change from outside (the view was reconfigured elsewhere): rebuild the window.
  useEffect(() => {
    setAxis((a) => (a.pxPerDay === PX_PER_DAY[scale] ? a : makeAxis(scale, centerDay.current)));
  }, [scale]);

  const range = useMemo<DateRange | null>(() => {
    if (!fields) return null;
    const padded = padRange(wallYmd(axis.fromDay * DAY_MS), wallYmd((axis.toDay - 1) * DAY_MS), 1);
    return padded && { field_id: fields.start.field.id, end_field_id: fields.end?.field.id ?? null, ...padded };
  }, [fields, axis.fromDay, axis.toDay]);
  const records = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, range, transient: setup.transient, enabled: !!range });
  const data = records.data;
  // Two one-record queries for the footer: how many records the view has, and how many of them
  // have no start date (they can never show on the timeline, so the footer says so).
  const counted = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, transient: setup.transient, cap: 1, variant: "count", enabled: !!fields });
  const undatedTransient = useMemo(() => (fields ? { ...setup.transient, ...unscheduledTransient(cfg.queryConfig.filter, fields.start.field.id) } : null), [fields, setup.transient, cfg.queryConfig.filter]);
  const undated = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, transient: undatedTransient, cap: 1, variant: "undated", enabled: !!fields });

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

  const grouped = !!groupField || (data?.groups.length ?? 0) > 0;
  const laneModels = useMemo<Lane[]>(() => {
    if (!data) return [{ ...NO_LANE }];
    if (groupField) return groupIntoLanes(data.records, groupField, setup.format);
    if (data.groups.length > 0) return lanesFromGroups(data.records, data.groups);
    return [{ ...NO_LANE, records: data.records }];
  }, [data, groupField, setup.format]);

  // The left column names each record, so the bar can say its dates; the first other field that
  // has a value (who it is for) sits quietly beside the name.
  // The description is read on hover over the bar, so it is not the quiet text beside the name.
  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
  const sideFields = useMemo(
    () => cardFields(table, config, new Set([fields?.start.field.id ?? "", fields?.end?.field.id ?? "", descriptionField?.id ?? ""])),
    [table, config, fields, descriptionField?.id],
  );
  const recordById = useMemo(() => new Map((data?.records ?? []).map((r) => [r.id, r])), [data]);
  const describe = useCallback(
    (recordId: string): DescriptionSource | null => {
      const record = recordById.get(recordId);
      return descriptionField && record ? { field: descriptionField, record, format: setup.format } : null;
    },
    [recordById, descriptionField, setup.format],
  );
  const hasSorts = cfg.queryConfig.sorts.length > 0;
  const chartLanes = useMemo<ChartLane[]>(() => {
    const barOf = (r: (typeof laneModels)[number]["records"][number], span: Span, label?: string): TimelineBar => ({
      id: r.id,
      title: cardTitle(primary, r, setup.format),
      label,
      span,
      color: data?.colors[r.id],
      canMove: canEditDates && endWritable,
      canResize: canEditDates && endWritable && span.hasEnd && !!fields?.end,
      violated: violatedTargets.has(r.id),
    });
    if (!grouped) {
      const dated = (data?.records ?? []).filter((r) => spans.has(r.id));
      // Without a sort of its own, a schedule reads top to bottom in date order.
      if (!hasSorts) dated.sort((a, b) => spans.get(a.id)!.startMs - spans.get(b.id)!.startMs);
      return dated.map((r) => {
        const span = spans.get(r.id)!;
        const side = fieldsToShow(sideFields, r, setup.format, 1)[0];
        return {
          lane: { key: r.id, label: cardTitle(primary, r, setup.format), records: [r] },
          recordId: r.id,
          sublabel: side ? displayText(side, r.values[side.id], setup.format) : undefined,
          bars: [barOf(r, span, spanLabel(span))],
        };
      });
    }
    return laneModels.map((lane) => ({
      lane,
      bars: lane.records.flatMap((r): TimelineBar[] => {
        const span = spans.get(r.id);
        return span ? [barOf(r, span)] : [];
      }),
    }));
  }, [grouped, laneModels, spans, primary, setup.format, data, canEditDates, endWritable, fields?.end, violatedTargets, sideFields, hasSorts]);
  const showLabels = !grouped || chartLanes.length > 1 || chartLanes.some((l) => l.lane.label !== "");

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
    setFocus((f) => ({ day: now, nonce: (f?.nonce ?? 0) + 1, align: "start" }));
  };
  const onVisibleDays = useCallback((from: number, last: number) => setShown((cur) => (cur?.from === from && cur.last === last ? cur : { from, last })), []);

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
      if (rec) setup.openNewRecord(rec.id);
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
  const settingLabel = fields ? (fields.end ? `Dates: ${fields.start.field.name} → ${fields.end.field.name}` : `Dates: ${fields.start.field.name}`) : "Dates";
  const settings = (
    <ViewSettings label={settingLabel} active={!!fields} note={note}>
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
      <DescriptionSelect
        candidates={descriptionFields}
        field={descriptionField}
        disabled={!cfg.canConfigure}
        onChange={(id) => cfg.update((c) => setDescriptionField(c, id))}
        hint={descriptionFields.length === 0 ? "Add a text field to show a description with each bar." : "A text field read in full when you point at a bar."}
      />
    </ViewSettings>
  );

  const addToday = fields && canEditDates ? () => void create(createWrites(dayNumber(wallNow(timeZone)), dayNumber(wallNow(timeZone)), fields, timeZone)) : undefined;
  const pageLabel = SCALE_LABELS[scale].toLowerCase();

  let body: React.ReactNode;
  if (!fields) {
    const likely = likelyDates(dateFields);
    body = (
      <ViewSetupState
        setup={setup}
        picture="timeline"
        heading="Choose the dates"
        body="Pick when each record starts. Add an end date to draw bars; without one, each record is a diamond."
        emptyBody="This table has no date field yet."
        pickers={[
          { label: "Start date", fields: dateFields, initial: likely.start?.id ?? "" },
          { label: <>End date <span className="font-normal text-muted">· optional</span></>, fields: dateFields, initial: likely.end?.id ?? "", noneLabel: "No end date" },
        ]}
        button="Show timeline"
        onApply={([start, end]) => cfg.update((c) => setTimeline(c, { start_field_id: start ?? null, end_field_id: end && end !== start ? end : null }))}
        footText="Need a different date?"
        footLink="Add a date field"
        addType="date"
        accepts={isDateLike}
      />
    );
  } else {
    // A view with no dated records still needs a row to drag a new one across.
    const lanesToDraw = chartLanes.length > 0 ? chartLanes : [{ lane: { ...NO_LANE }, bars: [] }];
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-2.5 pl-2.5 pr-3">
          <div className="flex items-center gap-0.5">
            <IconButton label={`Earlier ${pageLabel}s`} size="sm" onClick={() => chart.current?.page(-1)}>
              <ChevronLeft aria-hidden className="size-4" />
            </IconButton>
            <button type="button" onClick={goToday} className="h-8 rounded-lg border border-line bg-surface px-3 text-[0.8125rem] font-semibold hover:bg-hover pointer-coarse:h-10">
              Today
            </button>
            <IconButton label={`Later ${pageLabel}s`} size="sm" onClick={() => chart.current?.page(1)}>
              <ChevronRight aria-hidden className="size-4" />
            </IconButton>
          </div>
          <h3 className="text-base font-bold">{shown ? rangeTitle(shown.from, shown.last) : ""}</h3>
          {records.fetching && <Spinner className="size-4" label="Loading records" />}
          <SegmentedSwitch label="Timeline scale" className="ml-auto" value={scale} options={SCALE_OPTIONS} onChange={changeScale} />
        </div>
        <TimelineChart
          ref={chart}
          axis={axis}
          scale={scale}
          lanes={lanesToDraw}
          edges={edges}
          nowMs={wallNow(timeZone)}
          showLabels={showLabels}
          labelHeading={grouped ? (groupField?.name ?? table.fields.find((f) => f.id === data?.groups[0]?.field_id)?.name) : primary?.name}
          canCreate={canEditDates && endWritable}
          focus={focus}
          loading={records.loading}
          fitContent
          onAddRow={addToday}
          onOpen={setup.openRecord}
          describe={describe}
          onCommit={onCommit}
          onCreate={onCreate}
          onNeedMore={onNeedMore}
          onZoom={(dir) => changeScale(stepScale(scale, dir))}
          onCenter={(d) => {
            centerDay.current = d;
          }}
          onVisibleDays={onVisibleDays}
        />
      </>
    );
  }

  const total = counted.data?.total;
  const undatedCount = undated.data?.total ?? 0;
  return (
    <ViewFrame
      setup={setup}
      recordIds={chartLanes.flatMap((l) => l.bars.map((b) => b.id))}
      layout={fields ? "hug" : "bare"}
      features={{ group: true, rowHeight: false }}
      toolbarSetting={settings}
      onAdd={addToday ?? (!fields && setup.canEdit ? () => void create({}) : undefined)}
      footer={
        fields ? (
          <>
            {total !== undefined && (
              <span aria-live="polite">
                {itemsLabel(total)}
                {undatedCount > 0 && ` · ${undatedCount.toLocaleString()} without a date ${undatedCount === 1 ? "isn’t" : "aren’t"} shown`}
              </span>
            )}
            {depField && edges.some((e) => e.violated) && <span className="text-danger">{edges.filter((e) => e.violated).length} dependencies overlap</span>}
            {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records in this window.</span>}
            {records.error && !data && <span role="alert">Could not load records: {records.error.message}</span>}
            {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
          </>
        ) : undefined
      }
    >
      {body}
    </ViewFrame>
  );
}
