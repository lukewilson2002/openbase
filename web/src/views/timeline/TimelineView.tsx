/**
 * Timeline view (with Gantt mode): records as bars from a start to an end date (a diamond when
 * there is no end), with dependency arrows from a link-to-self field. Without swimlanes every
 * record has its own row, named in the left column, and its bar says its dates; with swimlanes
 * (a lane field or the view's grouping) the lanes pack their bars. Only the dates around the
 * visible window are queried (`QueryRequest.range`); the window grows as you scroll toward its edges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { DateRange, Field, TimelineScale, ViewConfig } from "@/api/types";
import { isGroupable } from "@/components/viewbar/config";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { displayText } from "@/lib/cells/format";
import { cn } from "@/lib/cn";
import { resolveDateFields } from "../common/dateFields";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { unscheduledTransient } from "../calendar/eventMath";
import { UnscheduledList } from "../common/UnscheduledList";
import { usePersistedSet } from "../common/usePersistedSet";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import { DAY_MS, isDateLike, isWritableDate, padRange, wallNow, wallYmd } from "../common/wallTime";
import { linkRefs } from "@/lib/cells/kinds";
import { cardFields, cardTitle, fieldsToShow, itemsLabel } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField, type DescriptionSource } from "../common/description";
import type { ViewProps } from "../types";
import { PX_PER_DAY, SCALES, SCALE_LABELS, dayNumber, dependencyEdges, dragSpan, extendAxis, makeAxis, rangeTitle, skippedDependencies, stepScale, type Axis, type DragMode, type TimelineSpan } from "./geometry";
import { NO_LANE, createWrites, dragWrites, dropWrites, groupIntoLanes, lanesFromGroups, spanLabel, timelineSpan, type Lane } from "./lanes";
import { TimelineChart, type ChartLane, type TimelineBar, type TimelineChartHandle } from "./TimelineChart";
import { useWallNow } from "./useWallNow";

/** The window never grows past about a century of days. */
const MAX_WINDOW_DAYS = 40_000;

export default function TimelineView(props: ViewProps) {
  return <TimelineInner key={props.view.id} {...props} />;
}

/** Why some of a timeline's dates cannot be changed: calculated fields (created time, modified time, formulas) are read-only. */
function datesNote(start: Field, end: Field | undefined): string | undefined {
  const startFixed = !isWritableDate(start);
  const endFixed = !!end && !isWritableDate(end);
  if (startFixed && endFixed) return `The start (${start.name}) and end (${end.name}) dates are calculated, so they can't be changed here: bars can't be moved or resized, and Add makes a record to fill in.`;
  if (startFixed) return `The start date (${start.name}) is calculated, so bars can't be moved, and Add makes a record to fill in.${end ? ` You can still change the end (${end.name}) by dragging a bar's right edge.` : ""}`;
  if (endFixed) return `The end date (${end.name}) is calculated, so only the start can be changed here: drag a bar or its left edge.`;
  return undefined;
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

  const nowMs = useWallNow(timeZone);
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
  // A one-record query for the footer's count of the view's records.
  const counted = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, transient: setup.transient, cap: 1, variant: "count", enabled: !!fields });
  // The records without a start date, listed in the unscheduled column to drag onto the timeline
  // (loaded even while it is folded: the folded strip says how many there are).
  const undatedTransient = useMemo(() => (fields ? { ...setup.transient, ...unscheduledTransient(cfg.queryConfig.filter, fields.start.field.id) } : null), [fields, setup.transient, cfg.queryConfig.filter]);
  const undated = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, transient: undatedTransient, variant: "undated", enabled: !!fields });
  // Records dropped on the timeline leave the list at once, before the refetch lands (and a record
  // the list still has once it has a date is left out too); an id is forgotten once the list no longer has it.
  const [placedIds, setPlacedIds] = useState<ReadonlySet<string>>(() => new Set());
  const forgetPlaced = useCallback(
    (recordId: string) =>
      setPlacedIds((s) => {
        if (!s.has(recordId)) return s;
        const next = new Set(s);
        next.delete(recordId);
        return next;
      }),
    [],
  );
  useEffect(() => {
    const present = new Set((undated.data?.records ?? []).map((r) => r.id));
    setPlacedIds((s) => {
      const kept = [...s].filter((id) => present.has(id));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [undated.data]);
  const undatedById = useMemo(() => new Map((undated.data?.records ?? []).map((r) => [r.id, r])), [undated.data]);
  const startId = fields?.start.field.id;
  const unscheduled = useMemo(() => (undated.data?.records ?? []).filter((r) => !placedIds.has(r.id) && (!startId || r.values[startId] == null || r.values[startId] === "")), [undated.data, placedIds, startId]);
  // Like the calendar's: remembered per view on a desktop (open until folded); a phone opens it when asked.
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [folded, toggleFolded] = usePersistedSet("ob-timeline-unscheduled-folded");
  const [phoneOpen, setPhoneOpen] = useState(false);
  const unscheduledOpen = desktop ? !folded.has(view.id) : phoneOpen;
  const toggleUnscheduled = () => (desktop ? toggleFolded(view.id) : setPhoneOpen((o) => !o));

  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  // Only plain date fields can be written; created time, modified time and formulas are calculated.
  // What is writable still works: a calculated end leaves the bars movable, a calculated start leaves the ends.
  const canEditDates = setup.canEdit && isWritableDate(fields?.start.field);
  const canEditEnd = setup.canEdit && !!fields?.end && isWritableDate(fields.end.field);
  const dateNote = setup.canEdit && fields ? datesNote(fields.start.field, fields.end?.field) : undefined;

  // ---- bars, lanes, dependencies -----------------------------------------------------------------
  const spans = useMemo(() => {
    const m = new Map<string, TimelineSpan>();
    if (!fields || !data) return m;
    for (const r of data.records) {
      const s = timelineSpan(r.values, fields, timeZone);
      if (s) m.set(r.id, s);
    }
    return m;
  }, [fields, data, timeZone]);

  const edges = useMemo(() => (depField && data ? dependencyEdges(data.records, depField.id, spans) : []), [depField, data, spans]);
  const violatedEdges = useMemo(() => edges.filter((e) => e.violated), [edges]);
  // Dependencies with no arrow: the other record has no dates, or is outside the loaded window.
  const undrawnDependencies = useMemo(() => (depField && data ? skippedDependencies(data.records, depField.id, spans) : 0), [depField, data, spans]);
  const titleById = useMemo(() => new Map((data?.records ?? []).map((r) => [r.id, cardTitle(primary, r, setup.format)] as const)), [data, primary, setup.format]);
  // What a violated dependency says in the bars' names (a colour alone is not enough): who each bar clashes with.
  const dependencyHints = useMemo(() => {
    const names = (ids: string[]) => {
      const t = ids.map((id) => titleById.get(id) ?? "another record");
      return t.length > 3 ? `${t.slice(0, 3).join(", ")} and ${t.length - 3} more` : t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}` : t[0]!;
    };
    const before = new Map<string, string[]>();
    const after = new Map<string, string[]>();
    for (const e of violatedEdges) {
      before.set(e.toId, [...(before.get(e.toId) ?? []), e.fromId]);
      after.set(e.fromId, [...(after.get(e.fromId) ?? []), e.toId]);
    }
    const out = new Map<string, string>();
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const parts: string[] = [];
      const preds = before.get(id);
      const succs = after.get(id);
      if (preds) parts.push(`Dependency overlap: it starts before ${names(preds)} ends.`);
      if (succs) parts.push(`Dependency overlap: it ends after ${names(succs)} starts.`);
      out.set(id, parts.join(" "));
    }
    return out;
  }, [violatedEdges, titleById]);
  const violatedTargets = useMemo(() => new Set(violatedEdges.map((e) => e.toId)), [violatedEdges]);

  // The lanes of a choice or person field are all its choices or all the base's collaborators, not just those with bars in the
  // window; the view's own grouping, with nothing in the window, still has them.
  const viewGroupField = table.fields.find((f) => f.id === cfg.queryConfig.groups[0]?.field_id);
  const laneModels = useMemo<Lane[]>(() => {
    if (!data) return [{ ...NO_LANE }];
    if (groupField) return groupIntoLanes(data.records, groupField, setup.format, setup.people);
    if (data.groups.length > 0) return lanesFromGroups(data.records, data.groups, table.fields.find((f) => f.id === data.groups[0]!.field_id), setup.people);
    const empty = viewGroupField ? lanesFromGroups([], [], viewGroupField, setup.people) : [];
    return empty.length > 0 ? empty : [{ ...NO_LANE, records: data.records }];
  }, [data, groupField, viewGroupField, table.fields, setup.format, setup.people]);
  const grouped = !!groupField || (data?.groups.length ?? 0) > 0 || laneModels.some((l) => l.fieldId !== undefined);

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
    const barOf = (r: (typeof laneModels)[number]["records"][number], span: TimelineSpan, label?: string): TimelineBar => ({
      id: r.id,
      title: cardTitle(primary, r, setup.format),
      label,
      span,
      color: data?.colors[r.id],
      // A record with only an end moves that end; any other moves its start (and its end with it, when that can be written).
      canMove: span.endOnly ? canEditEnd : canEditDates,
      // The end edge also gives a milestone (no end, or one before the start) its end.
      canResize: canEditEnd && !span.endOnly,
      canResizeStart: canEditDates && span.hasEnd,
      violated: violatedTargets.has(r.id),
      hint: [span.reversed ? "Its end is before its start. Drag its right edge to set the end." : span.endOnly ? "It has no start date." : undefined, dependencyHints.get(r.id)].filter(Boolean).join(" ") || undefined,
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
  }, [grouped, laneModels, spans, primary, setup.format, data, canEditDates, canEditEnd, violatedTargets, dependencyHints, sideFields, hasSorts]);
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
    (recordId: string, mode: DragMode, days: number, toLane?: string) => {
      const span = spans.get(recordId);
      if (!span || !fields) return;
      const after = dragSpan(span, mode, days);
      const values: Record<string, unknown> = days !== 0 || span.reversed ? dragWrites(span, after, mode, fields, timeZone) : {};
      // Into another swim lane: the lane's value. A field with several values keeps the others; only
      // the one that drew it in its old lane (its first) becomes the new lane's. A date the drag just
      // wrote (the lanes group by the start or end field) is kept: the drop day, not the lane's first day.
      const lane = toLane !== undefined ? laneModels.find((l) => l.key === toLane) : undefined;
      const record = recordById.get(recordId);
      if (lane?.fieldId && lane.value !== undefined && record && !(lane.fieldId in values)) {
        const cur = record.values[lane.fieldId];
        const idOf = (x: unknown) => (x && typeof x === "object" ? (x as { id?: unknown }).id : x);
        if (Array.isArray(cur) && cur.length > 1 && (lane.value === null || Array.isArray(lane.value))) {
          const target = Array.isArray(lane.value) ? lane.value[0] : undefined;
          values[lane.fieldId] = target === undefined ? cur.slice(1) : [target, ...cur.slice(1).filter((x) => idOf(x) !== idOf(target))];
        } else values[lane.fieldId] = lane.value;
      }
      if (Object.keys(values).length === 0) return;
      void writes.update(recordId, values, toLane !== undefined ? { label: "Move bar", toast: `Moved to ${lane?.label || "(Empty)"}` } : { label: mode === "move" ? "Move bar" : "Resize bar" });
    },
    [spans, fields, timeZone, writes, laneModels, recordById],
  );
  const onCreate = useCallback(
    (laneKey: string, fromDay: number, toDay: number) => {
      if (!fields) return;
      const values: Record<string, unknown> = createWrites(fromDay, toDay, fields, timeZone);
      const lane = laneModels.find((l) => l.key === laneKey);
      if (lane?.fieldId && lane.value !== undefined && lane.value !== null && !(lane.fieldId in values)) values[lane.fieldId] = lane.value;
      void setup.addRecord(values);
    },
    [fields, timeZone, laneModels, setup],
  );

  // A record dragged in from the unscheduled column: given that day as its start (an end it has is
  // kept when it is not before the start, else the end is that day too), and moved into the lane it
  // was dropped on when lanes come from a field. If the write fails it is back in the column.
  const onDropRecord = useCallback(
    (recordId: string, laneKey: string, day: number) => {
      if (!fields) return;
      const values: Record<string, unknown> = dropWrites(day, undatedById.get(recordId)?.values ?? {}, fields, timeZone);
      const lane = laneModels.find((l) => l.key === laneKey);
      if (lane?.fieldId && lane.value !== undefined && !(lane.fieldId in values)) values[lane.fieldId] = lane.value;
      setPlacedIds((s) => new Set(s).add(recordId));
      void writes.update(recordId, values, { label: "Schedule record", toast: `Scheduled for ${spanLabel({ startMs: day * DAY_MS, endMs: day * DAY_MS, startDateOnly: true, hasEnd: false })}` }).then((ok) => {
        if (!ok) forgetPlaced(recordId);
      });
    },
    [fields, timeZone, laneModels, writes, undatedById, forgetPlaced],
  );
  // A bar taken off the timeline (U, or dropped on the unscheduled column): its dates cleared (the ones that
  // can be written), it goes back to the unscheduled records, and Undo puts the dates back.
  const onUnschedule = useCallback(
    (recordId: string) => {
      if (!fields) return;
      const values: Record<string, unknown> = { [fields.start.field.id]: null };
      if (fields.end && isWritableDate(fields.end.field)) values[fields.end.field.id] = null;
      forgetPlaced(recordId);
      void writes.update(recordId, values, { label: "Unschedule record", toast: "Moved to Unscheduled" });
    },
    [fields, writes, forgetPlaced],
  );
  const onDeleteBar = useCallback((recordId: string) => setup.actions.requestDelete([recordId]), [setup.actions]);
  // Dependencies are the successor's link field: it lists the records it comes after.
  const dependsOn = useCallback((recordId: string) => (depField ? linkRefs(recordById.get(recordId)?.values[depField.id]) : []), [depField, recordById]);
  const onLink = useCallback(
    (fromId: string, toId: string) => {
      if (!depField) return;
      const cur = dependsOn(toId);
      if (cur.some((x) => x.id === fromId)) return;
      const ref = { id: fromId, name: titleById.get(fromId) ?? fromId };
      // A field that holds one link is given this one instead of the old.
      const next = depField.type === "link" && depField.options.single ? [ref] : [...cur, ref];
      void writes.update(toId, { [depField.id]: next }, { label: "Add dependency", toast: `${titleById.get(toId) || "Record"} now comes after ${ref.name || "the other record"}` });
    },
    [depField, dependsOn, titleById, writes],
  );
  const onUnlink = useCallback(
    (fromId: string, toId: string) => {
      if (!depField) return;
      void writes.update(toId, { [depField.id]: dependsOn(toId).filter((x) => x.id !== fromId) }, { label: "Remove dependency", toast: "Dependency removed" });
    },
    [depField, dependsOn, writes],
  );
  const unscheduleZone = useRef<HTMLDivElement>(null);
  const [overUnscheduled, setOverUnscheduled] = useState(false);

  // ---- toolbar -------------------------------------------------------------------------------------
  const note = [cfg.canConfigure ? undefined : "You do not have permission to change this view.", dateNote].filter(Boolean).join(" ") || undefined;
  // Lanes come from the Swimlanes setting, or else the toolbar's grouping, never both.
  const groupingIgnored = !!groupField && (data?.groups.length ?? 0) > 0;
  const groupingName = table.fields.find((f) => f.id === data?.groups[0]?.field_id)?.name;
  const settings = (
    <ViewSettings note={note}>
      <FieldSelect label="Start date field" fields={dateFields} value={fields?.start.field.id ?? ""} disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setTimeline(c, { start_field_id: id }))} />
      <FieldSelect
        label="End date field"
        fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
        value={fields?.end?.field.id ?? ""}
        noneLabel="No end date (milestones)"
        disabled={!cfg.canConfigure || !fields}
        onChange={(id) => cfg.update((c) => setTimeline(c, { end_field_id: id }))}
      />
      <FieldSelect label="Swimlanes" fields={groupFields} value={groupField?.id ?? ""} noneLabel="No swimlanes" disabled={!cfg.canConfigure} onChange={(id) => cfg.update((c) => setTimeline(c, { group_field_id: id }))} hint={groupingIgnored ? `The view is also grouped${groupingName ? ` by ${groupingName}` : ""}, but swimlanes take over here: that grouping is not used for the lanes. Choose no swimlanes to use it.` : "Without a field, the view's grouping (if any) makes the lanes."} />
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

  const addToday = fields && canEditDates ? () => void setup.addRecord(createWrites(dayNumber(wallNow(timeZone)), dayNumber(wallNow(timeZone)), fields, timeZone)) : undefined;
  const pageLabel = SCALE_LABELS[scale].toLowerCase();

  // What to say when no bar is in the window: what the person can do, and where the other records are.
  const unscheduledCount = undated.data?.total ?? unscheduled.length;
  const elsewhere = (counted.data?.total ?? 0) - (data?.total ?? 0) - unscheduledCount;
  const emptyMessage = (
    <>
      No records with dates in this range.
      {elsewhere > 0 && " Other records are dated outside it: use Today or the arrows to find them."}
      {unscheduledCount > 0 && ` ${unscheduledCount.toLocaleString()} ${unscheduledCount === 1 ? "record has" : "records have"} no start date${canEditDates ? `: drag ${unscheduledCount === 1 ? "it" : "them"} in from the Unscheduled column.` : ", and are listed in the Unscheduled column."}`}
      {canEditDates && " Drag across a lane to add one."}
    </>
  );

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
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-2.5 pl-2.5 pr-3">
          <button type="button" onClick={goToday} title="Go to today (T)" className="h-8 rounded-lg border border-line bg-surface px-3 text-[0.8125rem] font-semibold hover:bg-hover pointer-coarse:h-10">
            Today
          </button>
          {/* The arrows step around the dates they change; the title keeps a width so › stays put. */}
          <div className="flex items-center gap-0.5">
            <IconButton label={`Earlier ${pageLabel}s`} size="sm" onClick={() => chart.current?.page(-1)}>
              <ChevronLeft aria-hidden className="size-4" />
            </IconButton>
            <h3 className="min-w-[10.5rem] text-center text-base font-bold tabular-nums">{shown ? rangeTitle(shown.from, shown.last) : ""}</h3>
            <IconButton label={`Later ${pageLabel}s`} size="sm" onClick={() => chart.current?.page(1)}>
              <ChevronRight aria-hidden className="size-4" />
            </IconButton>
          </div>
          {records.fetching && <Spinner className="size-4" label="Loading records" />}
          <SegmentedSwitch label="Timeline scale" className="ml-auto" value={scale} options={SCALE_OPTIONS} onChange={changeScale} />
          {dateNote && (
            <p role="status" className="flex basis-full items-start gap-1.5 text-xs text-muted">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" /> {dateNote}
            </p>
          )}
          {groupingIgnored && (
            <p role="status" className="flex basis-full flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>
                The lanes come from the Swimlanes setting ({groupField!.name}), so the view's grouping{groupingName ? ` by ${groupingName}` : ""} is not used here.
              </span>
              {cfg.canConfigure && (
                <button type="button" onClick={() => cfg.update((c) => setTimeline(c, { group_field_id: null }))} className="font-semibold text-fg underline hover:no-underline">
                  Use the grouping instead
                </button>
              )}
            </p>
          )}
        </div>
        <TimelineChart
          ref={chart}
          axis={axis}
          scale={scale}
          lanes={lanesToDraw}
          edges={edges}
          nowMs={nowMs}
          showLabels={showLabels}
          labelHeading={grouped ? (groupField?.name ?? table.fields.find((f) => f.id === data?.groups[0]?.field_id)?.name) : primary?.name}
          labelWidth={tl.label_width}
          onLabelWidth={cfg.canConfigure ? (w) => cfg.update((c) => setTimeline(c, { label_width: w })) : undefined}
          canCreate={canEditDates}
          createSpansDays={canEditEnd}
          emptyMessage={emptyMessage}
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
          onDropRecord={canEditDates ? onDropRecord : undefined}
          onUnschedule={canEditDates ? onUnschedule : undefined}
          onDelete={setup.actions.canEdit ? onDeleteBar : undefined}
          onLink={depField && setup.canEdit ? onLink : undefined}
          onUnlink={depField && setup.canEdit ? onUnlink : undefined}
          onToday={goToday}
          unscheduleZone={unscheduleZone}
          onOverUnschedule={setOverUnscheduled}
        />
        </div>
        {/* No height of its own: as tall as the timeline beside it, scrolling inside. */}
        <div ref={unscheduleZone} className={cn("relative shrink-0", unscheduledOpen ? "w-52" : "w-11")}>
          <div className="absolute inset-0 flex">
            <UnscheduledList
              open={unscheduledOpen}
              onToggle={toggleUnscheduled}
              records={unscheduled}
              primary={primary}
              fields={sideFields}
              descriptionField={descriptionField}
              table={table}
              role={setup.role}
              format={setup.format}
              emails={setup.emails}
              loading={undated.loading}
              truncated={!!undated.data?.truncated}
              draggable={canEditDates}
              nativeDrag
              dropActive={overUnscheduled}
              hint={canEditDates ? "Drag a record onto the timeline to give it a date, or a bar here to clear its dates (or press U on a selected bar)." : setup.canEdit ? "These records have no start date. The start date is calculated, so they cannot be scheduled here." : "These records have no start date."}
              onOpen={setup.openRecord}
            />
          </div>
        </div>
      </div>
    );
  }

  const total = counted.data?.total;
  return (
    <ViewFrame
      setup={setup}
      recordIds={chartLanes.flatMap((l) => l.bars.map((b) => b.id))}
      layout={fields ? "hug" : "bare"}
      features={{ group: true, rowHeight: false }}
      toolbarSetting={settings}
      // With dates that cannot be written, Add still makes a record, left blank for the person to fill in.
      onAdd={addToday ?? (setup.canEdit ? () => void setup.addRecord({}) : undefined)}
      footer={
        fields ? (
          <>
            {total !== undefined && (
              <span aria-live="polite">
                {itemsLabel(total)}
              </span>
            )}
            {depField && violatedEdges.length > 0 && (
              <span className="flex flex-wrap items-baseline gap-x-1.5 text-danger">
                <span>
                  {violatedEdges.length} {violatedEdges.length === 1 ? "dependency overlaps" : "dependencies overlap"}
                </span>
                {violatedEdges.slice(0, 3).map((e) => (
                  <button key={`${e.fromId}>${e.toId}`} type="button" onClick={() => setup.openRecord(e.toId)} title={`${titleById.get(e.toId)} starts before ${titleById.get(e.fromId)} ends`} className="underline hover:no-underline">
                    {titleById.get(e.toId) || "Untitled"} after {titleById.get(e.fromId) || "Untitled"}
                  </button>
                ))}
                {violatedEdges.length > 3 && <span>and {violatedEdges.length - 3} more</span>}
              </span>
            )}
            {depField && undrawnDependencies > 0 && (
              <span role="status">
                {undrawnDependencies} {undrawnDependencies === 1 ? "dependency has" : "dependencies have"} no arrow: the other record has no dates or is outside this window.
              </span>
            )}
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
