/**
 * Calendar view: month, week, day and list layouts on FullCalendar (standard MIT plugins). Only the
 * visible date range is queried (`QueryRequest.range`); dragging an event reschedules it,
 * resizing changes its end (when the view has an end field), clicking an empty day creates a
 * record on that day, and the "Unscheduled" column lists records without a date to drag in (and
 * takes an event dragged back onto it, or Delete on a focused event, to clear its dates).
 *
 * The view's sort orders the events within a day, and the fields it shows (Hide fields) fill the
 * chips under the title. Layout and date are remembered per view in this browser, and weeks start
 * on the viewer's day (their language's, or the choice in the view settings).
 *
 * The drawing (FullCalendar, its header, the chips) is `CalendarSurface`, which a shared view uses
 * too; this file is what the signed-in view adds: where the records come from, every editing
 * gesture, the unscheduled column and the settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Draggable, type DateClickArg, type DropArg } from "@fullcalendar/interaction";
import type { EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { Info } from "lucide-react";
import type { DateRange, Field, ViewConfig } from "@/api/types";
import { FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { Field as FormField, Select } from "@/components/ui/input";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { cardFields } from "../common/cardFields";
import { DescriptionSelect, setDescriptionField, useDescriptionField } from "../common/description";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect } from "../common/FieldSelect";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import { floorDay, isDateLike, isWritableDate, likelyDateField, wallNow } from "../common/wallTime";
import type { ViewProps } from "../types";
import { CalendarSurface, MONTHS_SHORT, type ChipDescription, type CalendarSurfaceHandle } from "./CalendarSurface";
import { addDay, dateClickValues, eventWrites, readingOrder, recordEventSpan, recordsToEvents, resolveCalendarFields, unscheduleValues, unscheduledRecords, unscheduledTransient } from "./eventMath";
import { WEEK_STARTS, firstDayOf, loadWeekStart, saveWeekStart, type WeekStart } from "./layout";
import { UnscheduledList } from "../common/UnscheduledList";

export default function CalendarView(props: ViewProps) {
  return <CalendarInner key={props.view.id} {...props} />;
}

/** FullCalendar's helper makes the unscheduled column's items droppable onto a day. */
function attachCalendarDrag(list: HTMLUListElement): () => void {
  const d = new Draggable(list, {
    itemSelector: "[data-unscheduled]",
    eventData: (item) => ({ title: item.getAttribute("data-title") ?? "", create: false }),
  });
  return () => d.destroy();
}

function setCalendar(c: ViewConfig, patch: Partial<ViewConfig["calendar"]>): ViewConfig {
  return { ...c, calendar: { ...c.calendar, ...patch } };
}

const DELETE_KEYS = new Set(["Delete", "Backspace"]);

/** "12 Mar" for toasts. */
function dayLabel(wallMs: number): string {
  const d = new Date(wallMs);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** Where a mouse or touch event is on the page. */
function pointOf(e: MouseEvent | TouchEvent | undefined): { x: number; y: number } | null {
  if (!e) return null;
  if ("changedTouches" in e) {
    const t = e.touches[0] ?? e.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  return { x: e.clientX, y: e.clientY };
}

function inside(el: Element | null | undefined, p: { x: number; y: number } | null): boolean {
  if (!el || !p) return false;
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

/** Why events cannot be moved, when the date fields are computed (null when they can be). */
function readOnlyReason(fields: { start: Field; end: Field | null }): string | null {
  const kind = (f: Field) => (f.type === "created_time" || f.type === "last_modified_time" ? `a ${FIELD_TYPE_LABELS[f.type]} property, which fills itself in` : `a ${FIELD_TYPE_LABELS[f.type]} property, which is worked out from other properties`);
  if (!isWritableDate(fields.start)) return `Events cannot be moved, resized or added by clicking a day: ${fields.start.name} is ${kind(fields.start)}. Pick a date property you can edit as the Date under View options.`;
  if (fields.end && !isWritableDate(fields.end)) return `Events cannot be moved or resized: ${fields.end.name} is ${kind(fields.end)}. Pick a date property you can edit as the End date, or none, under View options.`;
  return null;
}

function CalendarInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, timeZone, addRecord } = setup;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const surface = useRef<CalendarSurfaceHandle>(null);
  const zone = useRef<HTMLElement>(null);
  // The event being dragged was let go over the unscheduled column (FullCalendar tells us this before it tells us where it landed).
  const releasedOnZone = useRef(false);
  const dateFields = useMemo(() => table.fields.filter(isDateLike), [table.fields]);
  const fields = useMemo(() => resolveCalendarFields(table.fields, config.calendar.date_field_id, config.calendar.end_field_id), [table.fields, config.calendar.date_field_id, config.calendar.end_field_id]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [visible, setVisible] = useState<{ from: string; to: string } | null>(null);
  const onVisibleRange = useCallback((next: { from: string; to: string }) => setVisible((cur) => (cur?.from !== next.from || cur?.to !== next.to ? next : cur)), []);
  const [weekPref, setWeekPref] = useState<WeekStart>(loadWeekStart);
  const firstDay = firstDayOf(weekPref);
  // The column is remembered per view on a desktop; a phone has no room for it until asked.
  const [folded, toggleFolded] = usePersistedSet("ob-calendar-unscheduled-folded");
  const [phoneOpen, setPhoneOpen] = useState(false);
  const unscheduledOpen = desktop ? !folded.has(view.id) : phoneOpen;
  const toggleUnscheduled = () => (desktop ? toggleFolded(view.id) : setPhoneOpen((o) => !o));
  const range = useMemo<DateRange | null>(
    () => (fields && visible ? { field_id: fields.start.field.id, end_field_id: fields.end?.field.id ?? null, from: visible.from, to: visible.to } : null),
    [fields, visible],
  );
  const records = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, range, transient: setup.transient, enabled: !!range });
  // The unscheduled list asks the server for the view's records whose date is empty (a transient
  // filter that keeps the saved one); the client filter below also drops a record the moment it is
  // dropped onto the calendar, before the refetch lands.
  // Sorts and groups of a viewer's own (unsaved) override carry over; only the filter is replaced.
  const viewerTransient = setup.transient;
  const transient = useMemo(
    () => (fields ? { ...viewerTransient, ...unscheduledTransient(cfg.queryConfig.filter, fields.start.field.id) } : null),
    [fields, cfg.queryConfig.filter, viewerTransient],
  );
  // Loaded even while the column is folded: the folded strip still says how many there are.
  const all = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, enabled: !!fields, variant: "unscheduled", transient });

  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
  const cardFieldList = useMemo(
    () => cardFields(table, config, new Set([fields?.start.field.id ?? "", fields?.end?.field.id ?? "", descriptionField?.id ?? ""])),
    [table, config, fields, descriptionField?.id],
  );
  const events = useMemo(
    () => (fields && records.data ? recordsToEvents(records.data.records, { fields, primary, format: setup.format, colors: records.data.colors, canEdit: setup.canEdit, chipFields: cardFieldList }) : []),
    [fields, records.data, primary, setup.format, setup.canEdit, cardFieldList],
  );
  const unscheduled = useMemo(() => (fields && all.data ? unscheduledRecords(all.data.records, fields, timeZone) : []), [fields, all.data, timeZone]);
  const sorted = config.sorts.length > 0;
  // The record panel's previous and next read the calendar the way it is drawn: day by day, the sort within a day.
  const recordIds = useMemo(() => readingOrder(events, sorted, unscheduled.map((r) => r.id)), [events, sorted, unscheduled]);
  const chipDescription = useMemo<ChipDescription | null>(
    () => (descriptionField && records.data ? { field: descriptionField, byId: new Map(records.data.records.map((r) => [r.id, r])), format: setup.format } : null),
    [descriptionField, records.data, setup.format],
  );
  const recordsById = useMemo(() => new Map((records.data?.records ?? []).map((r) => [r.id, r] as const)), [records.data]);

  const startWritable = setup.canEdit && isWritableDate(fields?.start.field);
  const reason = setup.canEdit && fields ? readOnlyReason({ start: fields.start.field, end: fields.end?.field ?? null }) : null;

  const apply = useCallback(
    (recordId: string, times: { startMs: number; endMs: number | null; allDay: boolean; change: "move" | "resize" }, toast: string, revert?: () => void) => {
      if (!fields) return;
      const record = recordsById.get(recordId);
      const before = record ? recordEventSpan(record, fields, timeZone) : null;
      void writes.update(recordId, eventWrites({ ...times, before }, fields, timeZone), { label: times.change === "move" ? "Move event" : "Resize event", toast }).then((ok) => {
        if (!ok) revert?.();
      });
    },
    [fields, writes, timeZone, recordsById],
  );

  const times = (arg: EventDropArg | EventResizeDoneArg, change: "move" | "resize") => ({ startMs: arg.event.start!.getTime(), endMs: arg.event.end?.getTime() ?? null, allDay: arg.event.allDay, change });
  const onEventDrop = (arg: EventDropArg) => {
    // Let go over the unscheduled sheet, which on a phone lies over the days: that is an unschedule (see onEventDragStop), not a move.
    if (releasedOnZone.current) {
      arg.revert();
      return;
    }
    const t = times(arg, "move");
    apply(String(arg.event.extendedProps.recordId), t, `Moved to ${dayLabel(t.startMs)}`, arg.revert);
  };
  const onEventResize = (arg: EventResizeDoneArg) => apply(String(arg.event.extendedProps.recordId), times(arg, "resize"), "Event resized", arg.revert);

  // New records start with the values of the view's filter; with a computed date field they get no date of their own.
  const createOn = useCallback(
    async (wallMs: number, allDay: boolean) => {
      await addRecord(fields && isWritableDate(fields.start.field) ? dateClickValues(wallMs, allDay, fields, timeZone) : {});
    },
    [fields, addRecord, timeZone],
  );
  // Add puts the record on today when today is on screen, else on the first day shown.
  const addHere = () => {
    const now = wallNow(timeZone);
    const shown = surface.current?.period() ?? null;
    void createOn(shown ? addDay(now, shown.start, shown.end) : floorDay(now), true);
  };

  const onDateClick = (arg: DateClickArg) => {
    if (startWritable) void createOn(arg.date.getTime(), arg.allDay);
  };

  const onDrop = (arg: DropArg) => {
    const id = arg.draggedEl.getAttribute("data-record-id");
    // Let go over the unscheduled sheet (over the days on a phone): the record stays where it was.
    if (!id || !fields || inside(zone.current, pointOf(arg.jsEvent))) return;
    void writes.update(id, dateClickValues(arg.date.getTime(), arg.allDay, fields, timeZone), { label: "Schedule record", toast: `Scheduled for ${dayLabel(arg.date.getTime())}` });
  };

  // An event taken off the calendar (dropped on the unscheduled column, or Delete on it): its dates cleared.
  const unschedule = useCallback(
    (recordId: string) => {
      if (!fields) return;
      void writes.update(recordId, unscheduleValues(fields), { label: "Unschedule record", toast: "Moved to Unscheduled" });
    },
    [fields, writes],
  );
  const [dragging, setDragging] = useState(false);
  const [overZone, setOverZone] = useState(false);
  // The record of the event being dragged, until its drag has been dealt with.
  const dragged = useRef<string | null>(null);
  // While an event is dragged, the column shows whether the pointer is over it.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent | TouchEvent) => setOverZone(inside(zone.current, pointOf(e)));
    // Let go over the column: FullCalendar would first slide its preview back to the day it came from and
    // only then report the drag's end, so the preview is hidden and the dates cleared at once.
    const up = (e: MouseEvent | TouchEvent) => {
      if (!startWritable || !dragged.current || !inside(zone.current, pointOf(e))) return;
      // The preview is FullCalendar's fixed copy of the event (the event itself, hidden while dragged, is left alone).
      for (const el of document.querySelectorAll<HTMLElement>(".fc-event-dragging")) if (el.style.position === "fixed") el.style.visibility = "hidden";
      releasedOnZone.current = true;
      unschedule(dragged.current);
      dragged.current = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("touchmove", move, { passive: true });
    document.addEventListener("mouseup", up, true);
    document.addEventListener("touchend", up, true);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("touchend", up, true);
      setOverZone(false);
    };
  }, [dragging, startWritable, unschedule]);
  const onEventDragStop = (arg: { event: { extendedProps: Record<string, unknown> }; jsEvent: MouseEvent }) => {
    setDragging(false);
    // Already unscheduled when it was let go (see above).
    if (!dragged.current) return;
    dragged.current = null;
    releasedOnZone.current = startWritable && inside(zone.current, pointOf(arg.jsEvent));
    if (releasedOnZone.current) unschedule(String(arg.event.extendedProps.recordId));
  };
  // After Delete the focus goes to the event beside the one taken off, once the calendar has redrawn without it.
  const box = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    const timer = setTimeout(() => {
      const id = focusNext.current;
      focusNext.current = null;
      if (id) box.current?.querySelector<HTMLElement>(`.fc-event[data-record-id="${id}"]`)?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [events]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!startWritable || !DELETE_KEYS.has(e.key) || !(e.target instanceof Element)) return;
    const id = e.target.closest(".fc-event")?.getAttribute("data-record-id");
    if (!id) return;
    e.preventDefault();
    // An event drawn over several weeks is several elements: the records in the order they are drawn.
    const shown = [...new Set([...(box.current?.querySelectorAll(".fc-event[data-record-id]") ?? [])].map((el) => el.getAttribute("data-record-id")!))];
    const at = shown.indexOf(id);
    focusNext.current = shown[at + 1] ?? shown[at - 1] ?? null;
    unschedule(id);
  };

  const chooseDate = (id: string | null) => cfg.update((c) => setCalendar(c, { date_field_id: id }));
  const settings = (
    <>
      <FieldSelect
        label="Date"
        fields={dateFields}
        value={fields?.start.field.id ?? ""}
        onChange={chooseDate}
        hint={fields && !isWritableDate(fields.start.field) ? `${FIELD_TYPE_LABELS[fields.start.field.type]} properties are filled in for you, so events cannot be moved or added on a day. Pick a date property you can edit to do that.` : undefined}
      />
      <FieldSelect
        label="End date"
        fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
        value={fields?.end?.field.id ?? ""}
        noneLabel="No end date"
        disabled={!fields}
        onChange={(id) => cfg.update((c) => setCalendar(c, { end_field_id: id }))}
        hint={fields?.end && !isWritableDate(fields.end.field) ? `${FIELD_TYPE_LABELS[fields.end.field.type]} properties are worked out for you, so events cannot be moved or resized. Pick a date property you can edit to do that.` : "Shows records as ranges and lets you resize them."}
      />
      {/* This browser's own taste, not part of the saved view: anyone can set it. */}
      <FormField label="Week starts on" hint="Only changes how you see the calendar.">
        {(ctl) => (
          <Select {...ctl} value={weekPref} onChange={(e) => { const next = e.target.value as WeekStart; saveWeekStart(next); setWeekPref(next); }}>
            {WEEK_STARTS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </>
  );
  const propertySettings = (
    <DescriptionSelect
      candidates={descriptionFields}
      field={descriptionField}
      onChange={(id) => cfg.update((c) => setDescriptionField(c, id))}
      hint={descriptionFields.length === 0 ? "Add a text property to show a description with each event." : "A text property read in full when you point at an event."}
    />
  );

  let body: React.ReactNode;
  if (!fields) {
    body = (
      <ViewSetupState
        setup={setup}
        heading="Choose a date property"
        body="Pick the property that decides which day each record shows up on."
        emptyBody="This collection has no date property yet."
        pickers={[{ label: "Date property", fields: dateFields, initial: likelyDateField(dateFields)?.id ?? "" }]}
        button="Show calendar"
        onApply={([id]) => chooseDate(id ?? null)}
        footText="Need a different date?"
        footLink="Add a date property"
        addType="date"
        accepts={isDateLike}
      />
    );
  } else {
    body = (
      <div className={cn("absolute inset-0 flex", !desktop && "flex-col")}>
        <CalendarSurface
          ref={surface}
          stateKey={view.id}
          fields={fields}
          events={events}
          timeZone={timeZone}
          desktop={desktop}
          firstDay={firstDay}
          sorted={sorted}
          fetching={records.fetching}
          description={chipDescription}
          onVisibleRange={onVisibleRange}
          onOpen={setup.openRecord}
          notice={
            reason && (
              <p role="status" className="flex items-start gap-2 border-b border-line bg-warning-soft px-3 py-2 text-label">
                <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                {reason}
              </p>
            )
          }
          padFoot={!desktop && !unscheduledOpen}
          boxRef={box}
          onBoxKeyDown={onKeyDown}
          options={{
            editable: startWritable,
            droppable: startWritable,
            eventStartEditable: startWritable,
            eventDurationEditable: startWritable && !!fields.end,
            eventDragStart: (arg) => {
              releasedOnZone.current = false;
              dragged.current = String(arg.event.extendedProps.recordId);
              setDragging(true);
            },
            eventDragStop: onEventDragStop,
            eventDrop: onEventDrop,
            eventResize: onEventResize,
            dateClick: onDateClick,
            drop: onDrop,
          }}
        />
        <UnscheduledList
          open={unscheduledOpen}
          onToggle={toggleUnscheduled}
          records={unscheduled}
          primary={primary}
          // On a phone the sheet is only a title per record, so it leaves the days room.
          fields={desktop ? cardFieldList : []}
          descriptionField={desktop ? descriptionField : undefined}
          table={table}
          format={setup.format}
          emails={setup.emails}
          loading={all.loading}
          truncated={!!all.data?.truncated}
          draggable={startWritable}
          attachDrag={attachCalendarDrag}
          hint={desktop ? "Drag a record onto a day to give it a date, or an event here to clear its date." : undefined}
          dropActive={overZone}
          stacked={!desktop}
          zoneRef={zone}
          onOpen={setup.openRecord}
        />
      </div>
    );
  }

  const data = records.data;
  const footer =
    fields && (data?.truncated || (records.error && !data)) ? (
      <>
        {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records in this range.</span>}
        {records.error && !data && <span role="alert">Could not load records: {records.error.message}</span>}
      </>
    ) : undefined;

  return (
    <ViewFrame
      setup={setup}
      recordIds={fields ? recordIds : undefined}
      layout={fields ? "fill" : "bare"}
      features={{ group: false, rowHeight: false }}
      layoutSettings={settings}
      propertySettings={propertySettings}
      onAdd={setup.canEdit ? addHere : undefined}
      footer={footer}
    >
      {body}
    </ViewFrame>
  );
}
