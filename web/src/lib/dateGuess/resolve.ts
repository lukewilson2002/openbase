/**
 * Turning a found phrase into a calendar date, given the moment it is read, the person's time zone
 * and the first day of their week. Nothing here reads the clock: `now` always comes in.
 */
import type { DateFormat, TimeFormat } from "@/api/types";
import { instantToIso, isValidTimeZone, validYmd, ymdToIso, zonedParts, zonedToInstant, type YMD } from "@/lib/cells/dates";
import type { DatePart, TimePart } from "./phrases";

export interface DateContext {
  /** The moment the text is read (a Date or Unix milliseconds). */
  now: Date | number;
  /** IANA zone the person works in; an unknown name reads as UTC. */
  timeZone: string;
  /** 0 = Sunday, 1 = Monday: the day "next Friday" counts weeks from. */
  weekStart: 0 | 1;
}

/** Other readings of the same words that a chip may want to point out. */
export type Ambiguity =
  /** "3/4" is March 4 here; the same digits read day first are April 3. */
  | "day-month"
  /** "5:30" with no am or pm is read as written (05:30). */
  | "am-pm"
  /** A bare weekday that is today's weekday means a week from today; "today" is the other way to say it. */
  | "weekday-is-today"
  /** The text holds other date phrases; only one is used. */
  | "more-phrases";

export type PhraseKind = "today" | "tonight" | "tomorrow" | "weekday" | "this-weekday" | "next-weekday" | "month-day" | "numeric" | "iso" | "time";

export interface Resolved {
  kind: PhraseKind;
  date: YMD;
  /** Wall-clock time in the context's zone, when the phrase gave one. */
  time: { h: number; mi: number } | null;
  /** The cell value for a date property: `YYYY-MM-DD`, or the instant as UTC ISO when there is a time. */
  value: string;
  /** How the person wrote it, which is how a new date property should show it. */
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  ambiguity: Ambiguity[];
}

const DAY_MS = 86_400_000;

export function addDays({ y, m, d }: YMD, n: number): YMD {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function weekdayOf({ y, m, d }: YMD): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const dayNumber = ({ y, m, d }: YMD): number => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** The first date on or after `today` that has this month and day. Feb 29 waits for a leap year. */
function nextOccurrence(month: number, day: number, today: YMD): YMD {
  for (let y = today.y; y <= today.y + 8; y++) {
    const candidate = { y, m: month, d: day };
    if (validYmd(candidate) && dayNumber(candidate) >= dayNumber(today)) return candidate;
  }
  // Unreachable for a month and day the scanner accepted; a leap day is at most 8 years away.
  return { y: today.y + 1, m: month, d: day };
}

export function resolve(date: DatePart | null, time: TimePart | null, ctx: DateContext): Resolved {
  const zone = isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
  const nowMs = typeof ctx.now === "number" ? ctx.now : ctx.now.getTime();
  const here = zonedParts(nowMs, zone);
  const today: YMD = { y: here.y, m: here.m, d: here.d };
  const ambiguity: Ambiguity[] = [];
  if (time?.unmarked12) ambiguity.push("am-pm");

  let kind: PhraseKind;
  let day: YMD;
  let dateFormat: DateFormat = "friendly";
  let clock = time ? { h: time.h, mi: time.mi } : null;
  let timeFormat: TimeFormat = time?.form === "clock" ? "h24" : "h12";
  let offsetMs: number | null = null;
  let seconds = 0;

  if (!date) {
    kind = "time";
    // A time alone means its next occurrence: this afternoon's 5pm, but tomorrow's 9am once 9 has passed.
    const later = time!.h * 60 + time!.mi > here.h * 60 + here.mi;
    day = later ? today : addDays(today, 1);
  } else {
    switch (date.form) {
      case "day-word":
        kind = date.word;
        day = date.word === "tomorrow" ? addDays(today, 1) : today;
        break;
      case "weekday": {
        const ahead = (date.weekday - weekdayOf(today) + 7) % 7;
        if (date.qualifier === "next") {
          kind = "next-weekday";
          // The same weekday in the calendar week after this one, whichever day the week starts on.
          const thisWeekStart = addDays(today, -((weekdayOf(today) - ctx.weekStart + 7) % 7));
          day = addDays(thisWeekStart, 7 + ((date.weekday - ctx.weekStart + 7) % 7));
        } else if (date.qualifier === "this") {
          kind = "this-weekday";
          day = addDays(today, ahead);
        } else {
          kind = "weekday";
          if (ahead === 0) ambiguity.push("weekday-is-today");
          day = addDays(today, ahead === 0 ? 7 : ahead);
        }
        break;
      }
      case "month-day":
        kind = "month-day";
        day = date.year === null ? nextOccurrence(date.month, date.day, today) : { y: date.year, m: date.month, d: date.day };
        break;
      case "numeric":
        kind = "numeric";
        dateFormat = date.dayFirst ? "european" : "us";
        if (date.ambiguous) ambiguity.push("day-month");
        day = date.year === null ? nextOccurrence(date.month, date.day, today) : { y: date.year, m: date.month, d: date.day };
        break;
      case "iso":
        kind = "iso";
        dateFormat = "iso";
        day = { y: date.year, m: date.month, d: date.day };
        if (date.time) {
          clock = { h: date.time.h, mi: date.time.mi };
          seconds = date.time.s;
          timeFormat = "h24";
          offsetMs = date.offsetMs;
        }
        break;
    }
  }

  if (!clock) return { kind, date: day, time: null, value: ymdToIso(day), dateFormat, timeFormat, ambiguity };

  const local = { ...day, h: clock.h, mi: clock.mi, s: seconds, ms: 0 };
  const instant = offsetMs === null ? zonedToInstant(local, zone) : Date.UTC(day.y, day.m - 1, day.d, clock.h, clock.mi, seconds) - offsetMs;
  // Show the wall clock in the person's zone, which differs from what was typed when it carried an offset.
  const shown = zonedParts(instant, zone);
  return {
    kind,
    date: { y: shown.y, m: shown.m, d: shown.d },
    time: { h: shown.h, mi: shown.mi },
    value: instantToIso(instant),
    dateFormat,
    timeFormat,
    ambiguity,
  };
}
