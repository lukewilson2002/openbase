/**
 * The calendar's layouts and what is remembered about them: which layout and date each view was
 * last on, and which day the weeks start on. Both live in this browser only (a viewer's own taste,
 * not part of the saved view), and work without storage.
 */

export const LAYOUTS = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
  { value: "list", label: "List" },
] as const;
export type Layout = (typeof LAYOUTS)[number]["value"];
/** How much time a layout shows at once. */
export type Unit = "month" | "week" | "day";

/** The date field can tell the time of day: weeks and days get an hourly grid, else a grid of days. */
export type Grid = "timed" | "days";

/** FullCalendar's name for a layout. The list shows the same stretch of time as the layout before it (`unit`). */
export function viewType(layout: Layout, grid: Grid, unit: Unit = "month"): string {
  switch (layout) {
    case "month":
      return "dayGridMonth";
    case "week":
      return grid === "timed" ? "timeGridWeek" : "dayGridWeek";
    case "day":
      return grid === "timed" ? "timeGridDay" : "dayGridDay";
    case "list":
      return unit === "month" ? "listMonth" : unit === "week" ? "listWeek" : "listDay";
  }
}

/** The layout and unit behind one of FullCalendar's view names (null for one the calendar does not offer). */
export function layoutOf(type: string): { layout: Layout; unit: Unit } | null {
  switch (type) {
    case "dayGridMonth":
      return { layout: "month", unit: "month" };
    case "timeGridWeek":
    case "dayGridWeek":
      return { layout: "week", unit: "week" };
    case "timeGridDay":
    case "dayGridDay":
      return { layout: "day", unit: "day" };
    case "listMonth":
      return { layout: "list", unit: "month" };
    case "listWeek":
      return { layout: "list", unit: "week" };
    case "listDay":
      return { layout: "list", unit: "day" };
    default:
      return null;
  }
}

// ---- remembered layout and date -----------------------------------------------------------------

const STATE_KEY = "ob-calendar-state";

export interface CalendarState {
  layout: Layout;
  unit: Unit;
  /** `YYYY-MM-DD` of the day the calendar was showing. */
  date: string;
}

const isLayout = (x: unknown): x is Layout => LAYOUTS.some((l) => l.value === x);
const isUnit = (x: unknown): x is Unit => x === "month" || x === "week" || x === "day";

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The layout and date a view was last left on, if this browser remembers them. */
export function loadCalendarState(viewId: string): CalendarState | null {
  const s = readAll()[viewId];
  if (!s || typeof s !== "object") return null;
  const { layout, unit, date } = s as Record<string, unknown>;
  if (!isLayout(layout) || !isUnit(unit) || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { layout, unit, date };
}

export function saveCalendarState(viewId: string, state: CalendarState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...readAll(), [viewId]: state }));
  } catch {
    /* storage unavailable: the layout lasts for this page view */
  }
}

// ---- first day of the week ----------------------------------------------------------------------

const WEEK_START_KEY = "ob-calendar-week-start";

/** Day numbers as FullCalendar counts them: 0 is Sunday. */
export type WeekStart = "auto" | "0" | "1" | "6";
export const WEEK_STARTS: readonly { value: WeekStart; label: string }[] = [
  { value: "auto", label: "Follow my language" },
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "6", label: "Saturday" },
];

export function loadWeekStart(): WeekStart {
  try {
    const v = localStorage.getItem(WEEK_START_KEY);
    return WEEK_STARTS.some((w) => w.value === v) ? (v as WeekStart) : "auto";
  } catch {
    return "auto";
  }
}

export function saveWeekStart(value: WeekStart): void {
  try {
    if (value === "auto") localStorage.removeItem(WEEK_START_KEY);
    else localStorage.setItem(WEEK_START_KEY, value);
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
}

/** Regions whose weeks start on Saturday and Sunday; the CLDR default (Monday) applies elsewhere. */
const SATURDAY_REGIONS = new Set(["AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY"]);
const SUNDAY_REGIONS = new Set(["AG", "AS", "BD", "BR", "BS", "BT", "BW", "BZ", "CA", "CO", "DM", "DO", "ET", "GT", "GU", "HK", "HN", "ID", "IL", "IN", "JM", "JP", "KE", "KH", "KR", "LA", "MH", "MM", "MO", "MT", "MX", "MZ", "NI", "NP", "PA", "PE", "PH", "PK", "PR", "PT", "PY", "SA", "SG", "SV", "TH", "TT", "TW", "UM", "US", "VE", "VI", "WS", "YE", "ZA", "ZW"]);

/** The first day of the week (0 = Sunday) in a language tag such as "en-GB", Sunday when it cannot be told. */
export function localeFirstDay(tag: string | undefined): number {
  if (!tag) return 0;
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    // Intl counts Monday 1 .. Sunday 7.
    if (info) return info.firstDay % 7;
    const region = (locale.region ?? locale.maximize().region) ?? "";
    if (SATURDAY_REGIONS.has(region)) return 6;
    return SUNDAY_REGIONS.has(region) ? 0 : 1;
  } catch {
    return 0;
  }
}

/** The day weeks start on: the viewer's choice, else their browser language's. */
export function firstDayOf(pref: WeekStart, tag: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language): number {
  return pref === "auto" ? localeFirstDay(tag) : Number(pref);
}
