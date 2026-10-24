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
 * FullCalendar runs in its UTC mode on wall times (see ../common/wallTime.ts), so the
 * viewer's and the fields' time zones, not the browser's, decide where events sit.
 *
 * FullCalendar's own toolbar is off: the card's header (Today, ‹ title ›, Month | Week | List)
 * drives it through its API, so it looks like the rest of the app's views.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, { Draggable, type DateClickArg, type DropArg } from "@fullcalendar/interaction";
import type { DatesSetArg, DayCellContentArg, EventClickArg, EventContentArg, EventDropArg, EventMountArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { DateRange, Field, TableRecord, ViewConfig } from "@/api/types";
import { FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { IconButton } from "@/components/ui/icon-button";
import { Field as FormField, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { choiceClass } from "@/lib/colors";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { cardFields } from "../common/cardFields";
import { DescriptionHover, DescriptionSelect, setDescriptionField, useDescriptionField } from "../common/description";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import { usePersistedSet } from "../common/usePersistedSet";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, ViewSettings } from "../common/ViewSettings";
import { ViewSetupState } from "../common/ViewSetupState";
import { ViewFrame } from "../common/ViewFrame";
import { floorDay, isDateLike, isWritableDate, wallNow, wallYmd } from "../common/wallTime";
import type { ViewProps } from "../types";
import "./calendar.css";
import { removeIconFont } from "./iconFont";
import { addDay, dateClickValues, eventWrites, readingOrder, recordEventSpan, recordsToEvents, resolveCalendarFields, unscheduleValues, unscheduledRecords, unscheduledTransient, visibleRange } from "./eventMath";
import { LAYOUTS, WEEK_STARTS, firstDayOf, layoutOf, loadCalendarState, loadWeekStart, saveCalendarState, saveWeekStart, viewType, type Grid, type Layout, type Unit, type WeekStart } from "./layout";
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

/** The date field a new calendar most likely wants: one people fill in, else any date. */
export function likelyDateField(fields: readonly Field[]): Field | undefined {
  return fields.find(isWritableDate) ?? fields[0];
}

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "Sun 11", like the timeline's day ticks (the locale's own order puts the number first).
const dayHeader = { dayHeaderContent: (arg: { date: Date }) => `${WEEKDAYS_SHORT[arg.date.getUTCDay()]} ${arg.date.getUTCDate()}` };
const VIEW_OPTIONS = {
  dayGridMonth: { dayHeaderFormat: { weekday: "short" } },
  timeGridWeek: dayHeader,
  timeGridDay: dayHeader,
  dayGridWeek: dayHeader,
  dayGridDay: dayHeader,
} as const;
/** FullCalendar's own order of events within a day; with a sort, the view's order decides before any of it. */
const EVENT_ORDER = ["start", "-duration", "allDay", "title"];
const SORTED_EVENT_ORDER = ["sortIndex", ...EVENT_ORDER];
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

// FullCalendar's stylesheet is in by now; its data: icon font would only trip the CSP (see iconFont.ts).
removeIconFont();

/** Where an event chip finds its record's description (null: the view has none). */
interface ChipDescription {
  field: Field;
  byId: ReadonlyMap<string, TableRecord>;
  format: FormatCtx;
}

/**
 * An event as a chip tinted with the record's colour (the primary tint when it has none). A chip
 * has room for the title only; pointing at it shows the record's description.
 */
function EventChip({ arg, description }: { arg: EventContentArg; description: ChipDescription | null }) {
  const color = arg.event.extendedProps.color as string | undefined;
  const details = arg.event.extendedProps.details as string[] | undefined;
  const chip = (
    <span className={cn("ob-cal-chip", color ? choiceClass(color) : "ob-cal-chip-plain")}>
      {arg.timeText && !arg.event.allDay && <span className="shrink-0 font-medium opacity-80">{arg.timeText}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ob-cal-title">{arg.event.title}</span>
        {details && <span className="ob-cal-details">{details.join(" · ")}</span>}
      </span>
    </span>
  );
  const record = description?.byId.get(String(arg.event.extendedProps.recordId));
  if (!description || !record) return chip;
  return (
    <DescriptionHover field={description.field} record={record} title={arg.event.title} format={description.format}>
      {chip}
    </DescriptionHover>
  );
}

/** "Oct 1" on the first of the month, the bare day number elsewhere; today is a filled circle. */
function DayNumber({ arg }: { arg: DayCellContentArg }) {
  // The week and day layouts have no day numbers (their column headers carry the dates).
  if (arg.view.type !== "dayGridMonth") return null;
  const d = arg.date.getUTCDate();
  const text = d === 1 && !arg.isOther ? `${MONTHS_SHORT[arg.date.getUTCMonth()]} 1` : arg.dayNumberText;
  return arg.isToday ? <span className="ob-cal-today">{d}</span> : <span>{text}</span>;
}

/** Why events cannot be moved, when the date fields are computed (null when they can be). */
function readOnlyReason(fields: { start: Field; end: Field | null }): string | null {
  const kind = (f: Field) => (f.type === "created_time" || f.type === "last_modified_time" ? `a ${FIELD_TYPE_LABELS[f.type]} field, which fills itself in` : `a ${FIELD_TYPE_LABELS[f.type]} field, which is worked out from other fields`);
  if (!isWritableDate(fields.start)) return `Events cannot be moved, resized or added by clicking a day: ${fields.start.name} is ${kind(fields.start)}. Pick a date field you can edit as the Date field under View.`;
  if (fields.end && !isWritableDate(fields.end)) return `Events cannot be moved or resized: ${fields.end.name} is ${kind(fields.end)}. Pick a date field you can edit as the End date field, or none, under View.`;
  return null;
}

function CalendarInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, timeZone, addRecord } = setup;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const calendar = useRef<FullCalendar>(null);
  const dateFields = useMemo(() => table.fields.filter(isDateLike), [table.fields]);
  const fields = useMemo(() => resolveCalendarFields(table.fields, config.calendar.date_field_id, config.calendar.end_field_id), [table.fields, config.calendar.date_field_id, config.calendar.end_field_id]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [visible, setVisible] = useState<{ from: string; to: string } | null>(null);
  const [title, setTitle] = useState("");
  // Where the view was left last time; FullCalendar reads it when it starts (and again if the date field's kind changes).
  const remembered = useMemo(() => loadCalendarState(view.id), [view.id]);
  const [layout, setLayout] = useState<Layout>(remembered?.layout ?? "month");
  const [unit, setUnit] = useState<Unit>(remembered?.unit ?? "month");
  const shownDate = useRef(remembered?.date);
  // The stretch of time on screen (wall ms, end exclusive): Add creates on today only when it is in it.
  const period = useRef<{ start: number; end: number } | null>(null);
  const [weekPref, setWeekPref] = useState<WeekStart>(loadWeekStart);
  const firstDay = firstDayOf(weekPref);
  // The column is remembered per view on a desktop; a phone has no room for it until asked.
  const [folded, toggleFolded] = usePersistedSet("ob-calendar-unscheduled-folded");
  const [phoneOpen, setPhoneOpen] = useState(false);
  const unscheduledOpen = desktop ? !folded.has(view.id) : phoneOpen;
  const toggleUnscheduled = () => (desktop ? toggleFolded(view.id) : setPhoneOpen((o) => !o));
  // A date field that tells the time of day gets an hourly grid for week and day; a date-only one a grid of days.
  const grid: Grid = fields?.start.opts.include_time ? "timed" : "days";

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

  const onDatesSet = useCallback(
    (arg: DatesSetArg) => {
      const next = visibleRange(arg.start.getTime(), arg.end.getTime());
      setVisible((cur) => (next && (cur?.from !== next.from || cur?.to !== next.to) ? next : cur));
      setTitle(arg.view.title);
      period.current = { start: arg.view.currentStart.getTime(), end: arg.view.currentEnd.getTime() };
      const shown = layoutOf(arg.view.type);
      if (!shown) return;
      setLayout(shown.layout);
      setUnit(shown.unit);
      shownDate.current = wallYmd(arg.view.calendar.getDate().getTime());
      saveCalendarState(view.id, { layout: shown.layout, unit: shown.unit, date: shownDate.current });
    },
    [view.id],
  );

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
    const shown = period.current;
    void createOn(shown ? addDay(now, shown.start, shown.end) : floorDay(now), true);
  };

  const onDateClick = (arg: DateClickArg) => {
    if (startWritable) void createOn(arg.date.getTime(), arg.allDay);
  };

  const onDrop = (arg: DropArg) => {
    const id = arg.draggedEl.getAttribute("data-record-id");
    if (!id || !fields) return;
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
  const zone = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const [overZone, setOverZone] = useState(false);
  // While an event is dragged, the column shows whether the pointer is over it.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent | TouchEvent) => setOverZone(inside(zone.current, pointOf(e)));
    document.addEventListener("mousemove", move);
    document.addEventListener("touchmove", move, { passive: true });
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("touchmove", move);
      setOverZone(false);
    };
  }, [dragging]);
  const onEventDragStop = (arg: { event: { extendedProps: Record<string, unknown> }; jsEvent: MouseEvent }) => {
    setDragging(false);
    if (startWritable && inside(zone.current, pointOf(arg.jsEvent))) unschedule(String(arg.event.extendedProps.recordId));
  };
  // Every event can be focused and carries its record, for Delete.
  const onEventMount = (arg: EventMountArg) => {
    arg.el.setAttribute("data-record-id", String(arg.event.extendedProps.recordId));
    if (!arg.el.hasAttribute("tabindex")) arg.el.tabIndex = 0;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!startWritable || !DELETE_KEYS.has(e.key) || !(e.target instanceof Element)) return;
    const id = e.target.closest(".fc-event")?.getAttribute("data-record-id");
    if (!id) return;
    e.preventDefault();
    unschedule(id);
  };

  const api = () => calendar.current?.getApi();
  const chooseDate = (id: string | null) => cfg.update((c) => setCalendar(c, { date_field_id: id }));
  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <ViewSettings note={note}>
      <FieldSelect
        label="Date field"
        fields={dateFields}
        value={fields?.start.field.id ?? ""}
        disabled={!cfg.canConfigure}
        onChange={chooseDate}
        hint={fields && !isWritableDate(fields.start.field) ? `${FIELD_TYPE_LABELS[fields.start.field.type]} fields are filled in for you, so events cannot be moved or added on a day. Pick a date field you can edit to do that.` : undefined}
      />
      <FieldSelect
        label="End date field"
        fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
        value={fields?.end?.field.id ?? ""}
        noneLabel="No end date"
        disabled={!cfg.canConfigure || !fields}
        onChange={(id) => cfg.update((c) => setCalendar(c, { end_field_id: id }))}
        hint={fields?.end && !isWritableDate(fields.end.field) ? `${FIELD_TYPE_LABELS[fields.end.field.type]} fields are worked out for you, so events cannot be moved or resized. Pick a date field you can edit to do that.` : "Shows records as ranges and lets you resize them."}
      />
      <DescriptionSelect
        candidates={descriptionFields}
        field={descriptionField}
        disabled={!cfg.canConfigure}
        onChange={(id) => cfg.update((c) => setDescriptionField(c, id))}
        hint={descriptionFields.length === 0 ? "Add a text field to show a description with each event." : "A text field read in full when you point at an event."}
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
    </ViewSettings>
  );

  let body: React.ReactNode;
  if (!fields) {
    body = (
      <ViewSetupState
        setup={setup}
        picture="calendar"
        heading="Choose a date field"
        body="Pick the field that decides which day each record shows up on."
        emptyBody="This table has no date field yet."
        pickers={[{ label: "Date field", fields: dateFields, initial: likelyDateField(dateFields)?.id ?? "" }]}
        button="Show calendar"
        onApply={([id]) => chooseDate(id ?? null)}
        footText="Need a different date?"
        footLink="Add a date field"
        addType="date"
        accepts={isDateLike}
      />
    );
  } else {
    body = (
      <div className="absolute inset-0 flex">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-2.5 pl-2.5 pr-3">
            <button type="button" onClick={() => api()?.today()} className="h-8 rounded-lg border border-line bg-surface px-3 text-[0.8125rem] font-semibold hover:bg-hover pointer-coarse:h-10">
              Today
            </button>
            {/* The arrows step around the dates they change; the title keeps a width so › stays put. */}
            <div className="flex items-center gap-0.5">
              <IconButton label={`Previous ${unit}`} size="sm" onClick={() => api()?.prev()}>
                <ChevronLeft aria-hidden className="size-4" />
              </IconButton>
              <h3 aria-live="polite" className="min-w-[10.5rem] text-center text-base font-bold tabular-nums">
                {title}
              </h3>
              <IconButton label={`Next ${unit}`} size="sm" onClick={() => api()?.next()}>
                <ChevronRight aria-hidden className="size-4" />
              </IconButton>
            </div>
            {records.fetching && <Spinner className="size-4" label="Loading records" />}
            {/* The list shows the stretch of time the layout before it did (a week's worth after Week). */}
            <SegmentedSwitch label="Calendar range" className="ml-auto" value={layout} options={LAYOUTS} onChange={(v) => api()?.changeView(viewType(v, grid, unit))} />
          </div>
          {reason && (
            <p role="status" className="flex items-start gap-2 border-b border-line bg-warning-soft px-3 py-2 text-[0.8125rem] leading-snug">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              {reason}
            </p>
          )}
          <div className="ob-calendar relative min-h-0 flex-1" onKeyDown={onKeyDown}>
            <FullCalendar
              // A different kind of date field draws weeks and days differently: start over in the same layout.
              key={grid}
              ref={calendar}
              plugins={PLUGINS}
              initialView={viewType(layout, grid, unit)}
              initialDate={shownDate.current}
              headerToolbar={false}
              // FullCalendar draws icons with a font it inlines as a data: URI, which the server's
              // Content-Security-Policy (default-src 'self') blocks; the header above has its own.
              buttonIcons={false}
              timeZone="UTC"
              firstDay={firstDay}
              now={() => new Date(wallNow(timeZone))}
              nowIndicator
              height="100%"
              fixedWeekCount={false}
              views={VIEW_OPTIONS}
              dayMaxEvents
              scrollTime="08:00:00"
              events={events}
              eventOrder={sorted ? SORTED_EVENT_ORDER : EVENT_ORDER}
              eventBackgroundColor="transparent"
              eventBorderColor="transparent"
              eventContent={(arg) => <EventChip arg={arg} description={chipDescription} />}
              eventDidMount={onEventMount}
              dayCellContent={(arg) => <DayNumber arg={arg} />}
              editable={startWritable}
              droppable={startWritable}
              eventStartEditable={startWritable}
              eventDurationEditable={startWritable && !!fields.end}
              datesSet={onDatesSet}
              eventClick={(arg: EventClickArg) => {
                arg.jsEvent.preventDefault();
                setup.openRecord(String(arg.event.extendedProps.recordId));
              }}
              eventDragStart={() => setDragging(true)}
              eventDragStop={onEventDragStop}
              eventDrop={onEventDrop}
              eventResize={onEventResize}
              dateClick={onDateClick}
              drop={onDrop}
            />
          </div>
        </div>
        <UnscheduledList
          open={unscheduledOpen}
          onToggle={toggleUnscheduled}
          records={unscheduled}
          primary={primary}
          fields={cardFieldList}
          descriptionField={descriptionField}
          table={table}
          role={setup.role}
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
    fields && (data?.truncated || (records.error && !data) || cfg.saving) ? (
      <>
        {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records in this range.</span>}
        {records.error && !data && <span role="alert">Could not load records: {records.error.message}</span>}
        {cfg.saving && <span className="ml-auto text-xs">Saving view…</span>}
      </>
    ) : undefined;

  return (
    <ViewFrame
      setup={setup}
      recordIds={fields ? recordIds : undefined}
      layout={fields ? "fill" : "bare"}
      features={{ group: false, rowHeight: false }}
      toolbarSetting={settings}
      onAdd={setup.canEdit ? addHere : undefined}
      footer={footer}
    >
      {body}
    </ViewFrame>
  );
}
