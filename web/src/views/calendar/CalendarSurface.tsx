/**
 * The calendar itself: FullCalendar with the card's own header (Today, ‹ title ›, Month | Week | List), the chips, and the sheet a
 * phone's "+N more" opens. It draws the events it is given and reports the stretch of days on screen; what the events are, where
 * they come from and what may be done to them belongs to the host. The signed-in `CalendarView` hands it the view's records and
 * every editing gesture; a shared view hands it the link's records and none.
 *
 * Layout and date are remembered per `stateKey` in this browser, and FullCalendar runs in its UTC mode on wall times (see
 * ../common/wallTime.ts), so the viewer's and the fields' time zones, not the browser's, decide where events sit.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type KeyboardEventHandler, type ReactNode, type Ref } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type { CalendarOptions, DatesSetArg, DayCellContentArg, EventClickArg, EventContentArg, EventMountArg, MoreLinkArg } from "@fullcalendar/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Field, TableRecord } from "@/api/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { choiceClass } from "@/lib/colors";
import { DescriptionHover } from "../common/description";
import { SegmentedSwitch } from "../common/SegmentedSwitch";
import { wallNow, wallYmd } from "../common/wallTime";
import "./calendar.css";
import { removeIconFont } from "./iconFont";
import { visibleRange, type CalendarEvent, type CalendarFields } from "./eventMath";
import { LAYOUTS, layoutOf, loadCalendarState, saveCalendarState, viewType, type Grid, type Layout, type Unit } from "./layout";

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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


// FullCalendar's stylesheet is in by now; its data: icon font would only trip the CSP (see iconFont.ts).
removeIconFont();

/** Where an event chip finds its record's description (null: the view has none). */
export interface ChipDescription {
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
  const timed = !!arg.timeText && !arg.event.allDay;
  const chip = (
    <span className={cn("ob-cal-chip", color ? choiceClass(color) : "ob-cal-chip-plain", details && !timed && "ob-cal-chip-detailed")}>
      {timed && <span className="shrink-0 font-medium opacity-80">{arg.timeText}</span>}
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

/** A day's records, for the sheet a "+N more" opens on a phone (PH-3), where FullCalendar's own pop-over is too small to tap in. */
interface DayList {
  title: string;
  items: { id: string; title: string; time?: string }[];
}

const DAY_TITLE = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

function dayListOf(arg: MoreLinkArg): DayList {
  return {
    title: DAY_TITLE.format(arg.date),
    items: arg.allSegs.map((seg) => ({
      id: String(seg.event.extendedProps.recordId),
      title: seg.event.title || "Untitled",
      time: !seg.event.allDay && seg.event.start ? CLOCK.format(seg.event.start) : undefined,
    })),
  };
}

/**
 * FullCalendar opens its pop-over for an empty or "popover" answer and zooms to a view for a string; any other answer does
 * nothing, which is what a function that has opened its own sheet wants. (Its types only know the first two.)
 */
const NO_FURTHER_ACTION = true as unknown as string;


export interface CalendarSurfaceHandle {
  /** The stretch of time on screen (wall ms, end exclusive), or null before the first draw. */
  period(): { start: number; end: number } | null;
}

export interface CalendarSurfaceProps {
  /** What the layout and date this calendar was last on are remembered under: a view's id, a shared view's token. */
  stateKey: string;
  fields: CalendarFields;
  events: readonly CalendarEvent[];
  timeZone: string;
  desktop: boolean;
  /** FullCalendar's `firstDay`: 0 for Sunday. */
  firstDay: number;
  /** The view sorts, so its order decides before the start time does. */
  sorted: boolean;
  /** A load is in flight. */
  fetching: boolean;
  description: ChipDescription | null;
  /** The stretch of days on screen changed (an ISO day each, end exclusive): the records for it are wanted. */
  onVisibleRange(range: { from: string; to: string }): void;
  /** A record's event was chosen. */
  onOpen(recordId: string): void;
  /** A line under the header (why events cannot be moved). */
  notice?: ReactNode;
  /** Room under the days for something that floats over them (the phone's Unscheduled pill). */
  padFoot?: boolean;
  /** FullCalendar options the host adds: its editing gestures. */
  options?: Partial<CalendarOptions>;
  boxRef?: Ref<HTMLDivElement>;
  onBoxKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

export const CalendarSurface = forwardRef<CalendarSurfaceHandle, CalendarSurfaceProps>(function CalendarSurface(
  { stateKey, fields, events, timeZone, desktop, firstDay, sorted, fetching, description, onVisibleRange, onOpen, notice, padFoot, options, boxRef, onBoxKeyDown },
  handle,
) {
  const calendar = useRef<FullCalendar>(null);
  const [title, setTitle] = useState("");
  const [dayList, setDayList] = useState<DayList | null>(null);
  const onMoreLink = (arg: MoreLinkArg) => {
    setDayList(dayListOf(arg));
    return NO_FURTHER_ACTION;
  };
  // Where the view was left last time; FullCalendar reads it when it starts (and again if the date field's kind changes).
  const remembered = useMemo(() => loadCalendarState(stateKey), [stateKey]);
  const [layout, setLayout] = useState<Layout>(remembered?.layout ?? "month");
  const [unit, setUnit] = useState<Unit>(remembered?.unit ?? "month");
  const shownDate = useRef(remembered?.date);
  const period = useRef<{ start: number; end: number } | null>(null);
  useImperativeHandle(handle, () => ({ period: () => period.current }), []);
  // A date field that tells the time of day gets an hourly grid for week and day; a date-only one a grid of days.
  const grid: Grid = fields.start.opts.include_time ? "timed" : "days";

  const onDatesSet = useCallback(
    (arg: DatesSetArg) => {
      const next = visibleRange(arg.start.getTime(), arg.end.getTime());
      if (next) onVisibleRange(next);
      setTitle(arg.view.title);
      period.current = { start: arg.view.currentStart.getTime(), end: arg.view.currentEnd.getTime() };
      const shown = layoutOf(arg.view.type);
      if (!shown) return;
      setLayout(shown.layout);
      setUnit(shown.unit);
      shownDate.current = wallYmd(arg.view.calendar.getDate().getTime());
      saveCalendarState(stateKey, { layout: shown.layout, unit: shown.unit, date: shownDate.current });
    },
    [stateKey, onVisibleRange],
  );
  const api = () => calendar.current?.getApi();

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-2.5 pl-2.5 pr-3">
          <Button size="sm" onClick={() => api()?.today()}>
            Today
          </Button>
          {/* The arrows step around the dates they change; the title keeps a width so › stays put. */}
          <div className="flex items-center gap-0.5">
            <IconButton label={`Previous ${unit}`} size="sm" onClick={() => api()?.prev()}>
              <ChevronLeft aria-hidden className="size-4" />
            </IconButton>
            <h3 aria-live="polite" className="min-w-[10.5rem] text-center text-h3 num">
              {title}
            </h3>
            <IconButton label={`Next ${unit}`} size="sm" onClick={() => api()?.next()}>
              <ChevronRight aria-hidden className="size-4" />
            </IconButton>
          </div>
          {fetching && <Spinner className="size-4" label="Loading records" />}
          {/* The list shows the stretch of time the layout before it did (a week's worth after Week). */}
          <SegmentedSwitch label="Calendar range" className="ml-auto" value={layout} options={LAYOUTS} onChange={(v) => api()?.changeView(viewType(v, grid, unit))} />
        </div>
        {notice}
        {/* On a phone the closed Unscheduled pill floats over the foot of the view: room is left for it, or it would sit over the last week's "+N more". */}
        <div ref={boxRef} className={cn("ob-calendar relative min-h-0 flex-1", padFoot && "pb-14")} onKeyDown={onBoxKeyDown}>
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
            // A desktop gets FullCalendar's pop-over; a phone gets the day's records in a bottom sheet.
            moreLinkClick={desktop ? "popover" : onMoreLink}
            // FullCalendar gives the "+N more" link aria-expanded and no role, which a link does not allow.
            moreLinkDidMount={(arg) => arg.el.setAttribute("role", "button")}
            scrollTime="08:00:00"
            events={events as CalendarEvent[]}
            eventOrder={sorted ? SORTED_EVENT_ORDER : EVENT_ORDER}
            eventBackgroundColor="transparent"
            eventBorderColor="transparent"
            eventContent={(arg) => <EventChip arg={arg} description={description} />}
            eventDidMount={onEventMount}
            dayCellContent={(arg) => <DayNumber arg={arg} />}
            // FullCalendar names a day's cell by its date number alone, while the cell also draws the day's records: the
            // name would not hold the drawn text (WCAG 2.5.3). Without it the cell is named by its content, number first.
            dayCellDidMount={(arg) => arg.el.removeAttribute("aria-labelledby")}
            // FullCalendar's weekday headers are `th` without a scope (A11Y-3).
            dayHeaderDidMount={(arg) => arg.el.setAttribute("scope", "col")}
            datesSet={onDatesSet}
            eventClick={(arg: EventClickArg) => {
              arg.jsEvent.preventDefault();
              onOpen(String(arg.event.extendedProps.recordId));
            }}
            {...options}
          />
        </div>
      </div>
      <SheetMenu open={!!dayList} onOpenChange={(open) => !open && setDayList(null)} title={dayList?.title ?? ""}>
        <SheetMenuGroup>
          {dayList?.items.map((item, i) => (
            <SheetMenuRow key={`${item.id}-${i}`} hint={item.time} onSelect={() => onOpen(item.id)}>
              {item.title}
            </SheetMenuRow>
          ))}
        </SheetMenuGroup>
      </SheetMenu>
    </>
  );
});

// Every event can be focused and carries its record, for Delete.
function onEventMount(arg: EventMountArg) {
  arg.el.setAttribute("data-record-id", String(arg.event.extendedProps.recordId));
  if (!arg.el.hasAttribute("tabindex")) arg.el.tabIndex = 0;
}
