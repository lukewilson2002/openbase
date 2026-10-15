/**
 * Calendar view: month, week and list layouts on FullCalendar (standard MIT plugins). Only the
 * visible date range is queried (`QueryRequest.range`); dragging an event reschedules it,
 * resizing changes its end (when the view has an end field), clicking an empty day creates a
 * record on that day, and the "Unscheduled" sidebar lists records without a date to drag in.
 *
 * FullCalendar runs in its UTC mode on wall times (see ../common/wallTime.ts), so the
 * viewer's and the fields' time zones, not the browser's, decide where events sit.
 */
import { useCallback, useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, { type DateClickArg, type DropArg } from "@fullcalendar/interaction";
import type { DatesSetArg, EventClickArg, EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { CalendarClock } from "lucide-react";
import type { DateRange, ViewConfig } from "@/api/types";
import { Spinner } from "@/components/ui/spinner";
import { useViewRecords } from "../common/useViewRecords";
import { useViewSetup } from "../common/useViewSetup";
import { FieldSelect, SetupPrompt, ViewSettings } from "../common/ViewSettings";
import { ViewFrame } from "../common/ViewFrame";
import { isDateLike, isWritableDate, wallNow } from "../common/wallTime";
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

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];

// FullCalendar's stylesheet is in by now; its data: icon font would only trip the CSP (see iconFont.ts).
removeIconFont();

function CalendarInner(props: ViewProps) {
  const setup = useViewSetup(props);
  const { table, view, config, cfg, writes, timeZone } = setup;
  const dateFields = useMemo(() => table.fields.filter(isDateLike), [table.fields]);
  const fields = useMemo(() => resolveCalendarFields(table.fields, config.calendar.date_field_id, config.calendar.end_field_id), [table.fields, config.calendar.date_field_id, config.calendar.end_field_id]);
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  const [visible, setVisible] = useState<{ from: string; to: string } | null>(null);
  const [sidebar, setSidebar] = useState(false);

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
  const all = useViewRecords({ tableId: table.id, viewId: view.id, configKey: setup.configKey, search: setup.debouncedSearch, timeZone, enabled: !!fields && sidebar, variant: "unscheduled", transient });

  const events = useMemo(
    () => (fields && records.data ? recordsToEvents(records.data.records, { fields, primary, format: setup.format, colors: records.data.colors, canEdit: setup.canEdit }) : []),
    [fields, records.data, primary, setup.format, setup.canEdit],
  );
  const unscheduled = useMemo(() => (fields && all.data ? unscheduledRecords(all.data.records, fields, timeZone) : []), [fields, all.data, timeZone]);

  const startWritable = setup.canEdit && isWritableDate(fields?.start.field);

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    const next = visibleRange(arg.start.getTime(), arg.end.getTime());
    setVisible((cur) => (next && (cur?.from !== next.from || cur?.to !== next.to) ? next : cur));
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
      if (!fields) return;
      const rec = await writes.create(dateClickValues(wallMs, allDay, fields, timeZone));
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

  const note = cfg.canConfigure ? undefined : "You do not have permission to change this view.";
  const settings = (
    <>
      <ViewSettings label="Calendar settings" note={note}>
        <FieldSelect
          label="Date field"
          fields={dateFields}
          value={fields?.start.field.id ?? ""}
          disabled={!cfg.canConfigure}
          onChange={(id) => cfg.update((c) => setCalendar(c, { date_field_id: id }))}
        />
        <FieldSelect
          label="End date field"
          fields={dateFields.filter((f) => f.id !== fields?.start.field.id)}
          value={fields?.end?.field.id ?? ""}
          noneLabel="No end date"
          disabled={!cfg.canConfigure || !fields}
          onChange={(id) => cfg.update((c) => setCalendar(c, { end_field_id: id }))}
          hint="Shows records as ranges and lets you resize them."
        />
      </ViewSettings>
      {fields && (
        <button
          type="button"
          aria-pressed={sidebar}
          onClick={() => setSidebar((s) => !s)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium hover:bg-hover ${sidebar ? "bg-primary-soft text-primary" : "text-fg"}`}
        >
          <CalendarClock aria-hidden className="size-4" />
          <span className="hidden sm:inline">Unscheduled{sidebar && all.data ? ` (${unscheduled.length})` : ""}</span>
          <span className="sr-only sm:hidden">Unscheduled</span>
        </button>
      )}
    </>
  );

  let body: React.ReactNode;
  if (!fields) {
    body = (
      <SetupPrompt
        title="Choose a date field"
        description={dateFields.length === 0 ? "This table has no date field. Add one to place records on the calendar." : cfg.canConfigure ? "Pick the field that decides which day each record appears on." : "Ask someone who can edit this view to pick the date field."}
      >
        {dateFields.length > 0 && cfg.canConfigure && <FieldSelect label="Date field" fields={dateFields} value="" onChange={(id) => cfg.update((c) => setCalendar(c, { date_field_id: id }))} />}
      </SetupPrompt>
    );
  } else {
    body = (
      <div className="absolute inset-0 flex">
        <div className="ob-calendar relative min-w-0 flex-1 p-2">
          <FullCalendar
            plugins={PLUGINS}
            initialView="dayGridMonth"
            headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listMonth" }}
            // FullCalendar draws prev/next with an icon font it inlines as a data: URI, which the
            // server's Content-Security-Policy (default-src 'self') blocks, so the buttons say it in
            // words (and iconFont.ts removes the font itself).
            buttonIcons={false}
            buttonText={{ prev: "Prev", next: "Next", today: "Today", month: "Month", week: "Week", list: "List" }}
            timeZone="UTC"
            now={() => new Date(wallNow(timeZone))}
            nowIndicator
            height="100%"
            dayMaxEvents
            scrollTime="08:00:00"
            events={events}
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
          {records.fetching && (
            <div className="pointer-events-none absolute right-4 top-3">
              <Spinner className="size-4" label="Loading records" />
            </div>
          )}
        </div>
        {sidebar && <UnscheduledList records={unscheduled} primary={primary} format={setup.format} loading={all.loading} truncated={!!all.data?.truncated} draggable={startWritable} onOpen={setup.openRecord} />}
      </div>
    );
  }

  const data = records.data;
  return (
    <ViewFrame
      setup={setup}
      recordIds={data?.records.map((r) => r.id)}
      features={{ group: false, rowHeight: false }}
      hideFieldsNoun="Event fields"
      toolbarExtra={settings}
      footer={
        fields ? (
          <>
            <span aria-live="polite">
              {events.length.toLocaleString()} item{events.length === 1 ? "" : "s"} in this range
            </span>
            {data?.truncated && <span role="status">Showing the first {data.records.length.toLocaleString()} of {data.total.toLocaleString()} records in this range.</span>}
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
