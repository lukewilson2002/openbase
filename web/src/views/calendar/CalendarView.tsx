/**
 * Calendar view: month, week and list layouts on FullCalendar (standard MIT plugins). Only the
 * visible date range is queried (`QueryRequest.range`); dragging an event reschedules it,
 * resizing changes its end (when the view has an end field), clicking an empty day creates a
 * record on that day, and the "Unscheduled" column lists records without a date to drag in.
 *
 * FullCalendar runs in its UTC mode on wall times (see ../common/wallTime.ts), so the
 * viewer's and the fields' time zones, not the browser's, decide where events sit.
 *
 * FullCalendar's own toolbar is off: the card's header (‹ Today › title, Month | Week | List)
 * drives it through its API, so it looks like the rest of the app's views.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, { type DateClickArg, type DropArg } from "@fullcalendar/interaction";
import type { DatesSetArg, DayCellContentArg, EventClickArg, EventContentArg, EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRange, Field, TableRecord, ViewConfig } from "@/api/types";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { choiceClass, colorDotClass } from "@/lib/colors";
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
import { floorDay, isDateLike, isWritableDate, wallNow } from "../common/wallTime";
import type { ViewProps } from "../types";
import "./calendar.css";
import { removeIconFont } from "./iconFont";
import { dateClickValues, eventWrites, recordsToEvents, resolveCalendarFields, unscheduledRecords, unscheduledTransient, visibleRange } from "./eventMath";
import { UnscheduledList } from "./UnscheduledList";

export default function CalendarView(props: ViewProps) {
  return <CalendarInner key={props.view.id} {...props} />;
}

function setCalendar(c: ViewConfig, patch: Partial<ViewConfig["calendar"]>): ViewConfig {
  return { ...c, calendar: { ...c.calendar, ...patch } };
}

/** The date field a new calendar most likely wants: one people fill in, else any date. */
export function likelyDateField(fields: readonly Field[]): Field | undefined {
  return fields.find(isWritableDate) ?? fields[0];
}

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
const RANGES = [
  { value: "dayGridMonth", label: "Month" },
  { value: "timeGridWeek", label: "Week" },
  { value: "listMonth", label: "List" },
] as const;
type RangeType = (typeof RANGES)[number]["value"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VIEW_OPTIONS = {
  dayGridMonth: { dayHeaderFormat: { weekday: "short" } },
  // "Sun 11", like the timeline's day ticks (the locale's own order puts the number first).
  timeGridWeek: { dayHeaderContent: (arg: { date: Date }) => `${WEEKDAYS_SHORT[arg.date.getUTCDay()]} ${arg.date.getUTCDate()}` },
} as const;

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
  const chip = (
    <span className={cn("ob-cal-chip", color ? choiceClass(color) : "ob-cal-chip-plain")}>
      <span aria-hidden className={cn("ob-cal-dot", color ? colorDotClass(color) : "bg-primary")} />
      {arg.timeText && !arg.event.allDay && <span className="shrink-0 font-medium opacity-80">{arg.timeText}</span>}
      <span className="ob-cal-title">{arg.event.title}</span>
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
  // The week layout's all-day row has no day numbers (its column headers carry the dates).
  if (arg.view.type !== "dayGridMonth") return <>{arg.dayNumberText}</>;
  const d = arg.date.getUTCDate();
  const text = d === 1 && !arg.isOther ? `${MONTHS_SHORT[arg.date.getUTCMonth()]} 1` : arg.dayNumberText;
  return arg.isToday ? <span className="ob-cal-today">{d}</span> : <span>{text}</span>;
}

function CalendarInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, timeZone } = setup;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const calendar = useRef<FullCalendar>(null);
  const dateFields = useMemo(() => table.fields.filter(isDateLike), [table.fields]);
  const fields = useMemo(() => resolveCalendarFields(table.fields, config.calendar.date_field_id, config.calendar.end_field_id), [table.fields, config.calendar.date_field_id, config.calendar.end_field_id]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [visible, setVisible] = useState<{ from: string; to: string } | null>(null);
  const [title, setTitle] = useState("");
  const [rangeType, setRangeType] = useState<RangeType>("dayGridMonth");
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

  const events = useMemo(
    () => (fields && records.data ? recordsToEvents(records.data.records, { fields, primary, format: setup.format, colors: records.data.colors, canEdit: setup.canEdit }) : []),
    [fields, records.data, primary, setup.format, setup.canEdit],
  );
  const unscheduled = useMemo(() => (fields && all.data ? unscheduledRecords(all.data.records, fields, timeZone) : []), [fields, all.data, timeZone]);
  const { candidates: descriptionFields, field: descriptionField } = useDescriptionField(table, config);
  const chipDescription = useMemo<ChipDescription | null>(
    () => (descriptionField && records.data ? { field: descriptionField, byId: new Map(records.data.records.map((r) => [r.id, r])), format: setup.format } : null),
    [descriptionField, records.data, setup.format],
  );
  const cardFieldList = useMemo(
    () => cardFields(table, config, new Set([fields?.start.field.id ?? "", fields?.end?.field.id ?? "", descriptionField?.id ?? ""])),
    [table, config, fields, descriptionField?.id],
  );

  const startWritable = setup.canEdit && isWritableDate(fields?.start.field);

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    const next = visibleRange(arg.start.getTime(), arg.end.getTime());
    setVisible((cur) => (next && (cur?.from !== next.from || cur?.to !== next.to) ? next : cur));
    setTitle(arg.view.title);
    setRangeType(arg.view.type as RangeType);
  }, []);

  const apply = useCallback(
    (recordId: string, times: { startMs: number; endMs: number | null; allDay: boolean }, revert?: () => void) => {
      if (!fields) return;
      void writes.update(recordId, eventWrites(times, fields, timeZone)).then((ok) => {
        if (!ok) revert?.();
      });
    },
    [fields, writes, timeZone],
  );

  const onEventDrop = (arg: EventDropArg) =>
    apply(String(arg.event.extendedProps.recordId), { startMs: arg.event.start!.getTime(), endMs: arg.event.end?.getTime() ?? null, allDay: arg.event.allDay }, arg.revert);
  const onEventResize = (arg: EventResizeDoneArg) =>
    apply(String(arg.event.extendedProps.recordId), { startMs: arg.event.start!.getTime(), endMs: arg.event.end?.getTime() ?? null, allDay: arg.event.allDay }, arg.revert);

  const createOn = useCallback(
    async (wallMs: number, allDay: boolean) => {
      const rec = await writes.create(fields ? dateClickValues(wallMs, allDay, fields, timeZone) : {});
      if (rec) setup.openRecord(rec.id);
    },
    [fields, writes, timeZone, setup],
  );

  const onDateClick = (arg: DateClickArg) => {
    if (startWritable) void createOn(arg.date.getTime(), arg.allDay);
  };

  const onDrop = (arg: DropArg) => {
    const id = arg.draggedEl.getAttribute("data-record-id");
    if (!id || !fields) return;
    void writes.update(id, dateClickValues(arg.date.getTime(), arg.allDay, fields, timeZone));
  };

  const api = () => calendar.current?.getApi();
  const chooseDate = (id: string | null) => cfg.update((c) => setCalendar(c, { date_field_id: id }));
  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <ViewSettings label={fields ? `Dates from ${fields.start.field.name}` : "Date field"} active={!!fields} note={note}>
      <FieldSelect label="Date field" fields={dateFields} value={fields?.start.field.id ?? ""} disabled={!cfg.canConfigure} onChange={chooseDate} />
      <FieldSelect
        label="End date field"
        fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
        value={fields?.end?.field.id ?? ""}
        noneLabel="No end date"
        disabled={!cfg.canConfigure || !fields}
        onChange={(id) => cfg.update((c) => setCalendar(c, { end_field_id: id }))}
        hint="Shows records as ranges and lets you resize them."
      />
      <DescriptionSelect
        candidates={descriptionFields}
        field={descriptionField}
        disabled={!cfg.canConfigure}
        onChange={(id) => cfg.update((c) => setDescriptionField(c, id))}
        hint={descriptionFields.length === 0 ? "Add a text field to show a description with each event." : "A text field read in full when you point at an event."}
      />
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
            <div className="flex items-center gap-0.5">
              <IconButton label={rangeType === "timeGridWeek" ? "Previous week" : "Previous month"} size="sm" onClick={() => api()?.prev()}>
                <ChevronLeft aria-hidden className="size-4" />
              </IconButton>
              <button type="button" onClick={() => api()?.today()} className="h-8 rounded-lg border border-line bg-surface px-3 text-[0.8125rem] font-semibold hover:bg-hover pointer-coarse:h-10">
                Today
              </button>
              <IconButton label={rangeType === "timeGridWeek" ? "Next week" : "Next month"} size="sm" onClick={() => api()?.next()}>
                <ChevronRight aria-hidden className="size-4" />
              </IconButton>
            </div>
            <h3 aria-live="polite" className="text-base font-bold">
              {title}
            </h3>
            {records.fetching && <Spinner className="size-4" label="Loading records" />}
            <SegmentedSwitch label="Calendar range" className="ml-auto" value={rangeType} options={RANGES} onChange={(v) => api()?.changeView(v)} />
          </div>
          <div className="ob-calendar relative min-h-0 flex-1">
            <FullCalendar
              ref={calendar}
              plugins={PLUGINS}
              initialView="dayGridMonth"
              headerToolbar={false}
              // FullCalendar draws icons with a font it inlines as a data: URI, which the server's
              // Content-Security-Policy (default-src 'self') blocks; the header above has its own.
              buttonIcons={false}
              timeZone="UTC"
              now={() => new Date(wallNow(timeZone))}
              nowIndicator
              height="100%"
              fixedWeekCount={false}
              views={VIEW_OPTIONS}
              dayMaxEvents
              scrollTime="08:00:00"
              events={events}
              eventBackgroundColor="transparent"
              eventBorderColor="transparent"
              eventContent={(arg) => <EventChip arg={arg} description={chipDescription} />}
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
          format={setup.format}
          emails={setup.emails}
          loading={all.loading}
          truncated={!!all.data?.truncated}
          draggable={startWritable}
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
      recordIds={data?.records.map((r) => r.id)}
      layout={fields ? "fill" : "bare"}
      features={{ group: false, rowHeight: false }}
      toolbarSetting={settings}
      onAdd={setup.canEdit && (!fields || startWritable) ? () => void createOn(floorDay(wallNow(timeZone)), true) : undefined}
      footer={footer}
    >
      {body}
    </ViewFrame>
  );
}
