/**
 * Finding date and time phrases in free text (HOME-4). Pure string work: nothing here knows the
 * current time, a zone or a week start; `resolve.ts` turns what is found into a calendar date.
 *
 * Every phrase must stand on its own: a letter, a digit or a path character next to it means it is
 * part of something else ("Fridays", "a/b", "10:00:00", "Nov 14-16"), and it is not a phrase.
 */
import { daysInMonth } from "@/lib/cells/dates";

export interface Found<T> {
  start: number;
  end: number;
  part: T;
}

export type DatePart =
  | { form: "day-word"; word: "today" | "tonight" | "tomorrow" }
  | { form: "weekday"; weekday: number; qualifier: "next" | "this" | null }
  /** "Nov 14", "14 Nov 2027". `year` is null when the text gave none. */
  | { form: "month-day"; month: number; day: number; year: number | null }
  /** "11/14", "25/03/2026". `dayFirst` records which order the digits were read in. */
  | { form: "numeric"; month: number; day: number; year: number | null; dayFirst: boolean; ambiguous: boolean; shortYear: boolean }
  /** "2026-11-14", optionally with a time and a UTC offset. */
  | { form: "iso"; year: number; month: number; day: number; time: { h: number; mi: number; s: number } | null; offsetMs: number | null };

export interface TimePart {
  h: number;
  mi: number;
  /** "9am" and "noon" say which half of the day; "14:30" and "5:30" do not. */
  form: "meridiem" | "clock" | "noon";
  /** A 12-hour-looking clock time ("5:30") with nothing saying am or pm. */
  unmarked12: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?!\p{L})`;
const YEAR_RE = String.raw`((?:19|20|21)\d{2})`;
const WEEKDAY_RE = String.raw`(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)`;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Words that are also ordinary English. Written lowercase they are left alone ("I sat down",
 * "may attend"); capitalised they are the weekday or month.
 */
const NEEDS_CAPITAL = new Set(["sat", "sun", "wed", "may"]);

/** Quantities and progress such as "1/2 cup", "3/4 of the budget" or "3/4 complete" are not dates. */
const FRACTION_UNIT = /^\s+(?:of|cups?|tsp|tbsp|lbs?|oz|inch(?:es)?|miles?|mi|km|kg|ml|hours?|hrs?|days?|mins?|minutes?|done|complete|completed|finished|correct|passed)(?![\p{L}\p{N}])/iu;
/** Words that put a ratio after them: "score 7/10", "step 2/5", "page 3/4". */
const FRACTION_LEAD = /(?:score[ds]?|rated?|rating|grade[ds]?|step|page|part|chapter)\s*:?\s*$/iu;

const LEFT_BAD = /[\p{L}\p{N}_/\\:#$€£¥.\-]/u;

function leftOk(text: string, i: number): boolean {
  return i === 0 || !LEFT_BAD.test(text[i - 1]!);
}

function rightOk(text: string, j: number): boolean {
  if (j >= text.length) return true;
  const c = text[j]!;
  const next = text[j + 1] ?? "";
  if (/[\p{L}\p{N}_/\\#$€£¥-]/u.test(c)) return false;
  // "friday@example.com" is an address; "tomorrow@9am" is a date and a time.
  if (c === "@" && /\p{L}/u.test(next)) return false;
  if (c === "." && /[\p{L}\p{N}]/u.test(next)) return false;
  if (c === ":" && /\d/.test(next)) return false;
  if ((c === "'" || c === "’") && /\p{L}/u.test(next)) return false;
  return true;
}

function isCapitalised(token: string): boolean {
  return /^\p{Lu}/u.test(token);
}

function monthNumber(token: string): number | null {
  const key = token.toLowerCase().slice(0, 3);
  if (NEEDS_CAPITAL.has(key) && !isCapitalised(token)) return null;
  const i = MONTHS.indexOf(key);
  return i < 0 ? null : i + 1;
}

function weekdayNumber(token: string): number | null {
  const key = token.toLowerCase().slice(0, 3);
  if (NEEDS_CAPITAL.has(key) && !isCapitalised(token)) return null;
  const i = WEEKDAYS.indexOf(key);
  return i < 0 ? null : i;
}

/** Every regex match whose edges are clean, handing each to `read`; a null from it rejects the match. */
function scan<T>(text: string, re: RegExp, read: (m: RegExpExecArray) => T | null): Found<T>[] {
  const out: Found<T>[] = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const part = leftOk(text, start) && rightOk(text, end) ? read(m) : null;
    if (part === null) {
      // The cleaner reading may begin inside this match ("context Friday" holds "next Friday").
      rx.lastIndex = start + 1;
      continue;
    }
    out.push({ start, end, part });
  }
  return out;
}

function validDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Feb 29 is the only day-of-month that depends on the year; this accepts it for any year. */
function plausibleMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2024, month);
}

// Read as 20yy here; `resolve` moves one that lands far ahead back a century ("3/4/85" is 1985).
const twoDigitYear = (s: string): number => 2000 + Number(s);

function findDayWords(text: string): Found<DatePart>[] {
  return scan<DatePart>(text, /(today|tonight|tomorrow|tmrw)/iu, (m) => {
    const w = m[1]!.toLowerCase();
    return { form: "day-word", word: w === "tmrw" ? "tomorrow" : (w as "today" | "tonight" | "tomorrow") };
  });
}

function findWeekdays(text: string): Found<DatePart>[] {
  return scan<DatePart>(text, new RegExp(String.raw`(?:(next|this)\s+)?${WEEKDAY_RE}`, "iu"), (m) => {
    const weekday = weekdayNumber(m[2]!);
    if (weekday === null) return null;
    const q = m[1]?.toLowerCase();
    return { form: "weekday", weekday, qualifier: q === "next" || q === "this" ? q : null };
  });
}

function findMonthDays(text: string): Found<DatePart>[] {
  const monthFirst = scan<DatePart>(text, new RegExp(String.raw`${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+${YEAR_RE})?`, "iu"), (m) => {
    const month = monthNumber(m[1]!);
    const day = Number(m[2]);
    const year = m[3] === undefined ? null : Number(m[3]);
    if (month === null || (year === null ? !plausibleMonthDay(month, day) : !validDay(year, month, day))) return null;
    return { form: "month-day", month, day, year };
  });
  const dayFirst = scan<DatePart>(text, new RegExp(String.raw`(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE}\.?(?:,?\s+${YEAR_RE})?`, "iu"), (m) => {
    const month = monthNumber(m[2]!);
    const day = Number(m[1]);
    const year = m[3] === undefined ? null : Number(m[3]);
    if (month === null || (year === null ? !plausibleMonthDay(month, day) : !validDay(year, month, day))) return null;
    return { form: "month-day", month, day, year };
  });
  return [...monthFirst, ...dayFirst];
}

function findNumeric(text: string): Found<DatePart>[] {
  return scan<DatePart>(text, /(\d{1,2})\/(\d{1,2})(?:\/((?:19|20|21)\d{2}|\d{2}(?!\d)))?/u, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] === undefined ? null : m[3].length === 2 ? twoDigitYear(m[3]) : Number(m[3]);
    // Month first unless that is impossible: "11/14" and "14/11" both mean November 14.
    const dayFirst = a > 12;
    if (a > 12 && b > 12) return null;
    const month = dayFirst ? b : a;
    const day = dayFirst ? a : b;
    if (year === null ? !plausibleMonthDay(month, day) : !validDay(year, month, day)) return null;
    if (year === null && (FRACTION_UNIT.test(text.slice(m.index + m[0].length)) || FRACTION_LEAD.test(text.slice(0, m.index)))) return null;
    return { form: "numeric", month, day, year, dayFirst, ambiguous: a <= 12 && b <= 12 && a !== b, shortYear: m[3]?.length === 2 };
  });
}

const ISO_RE = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[ ]?(Z|[+-]\d{2}(?::?\d{2})?))?)?/u;

function offsetMs(z: string): number | null {
  if (/^z$/i.test(z)) return 0;
  const digits = z.slice(1).replace(":", "");
  const h = Number(digits.slice(0, 2));
  const mi = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (h > 23 || mi > 59) return null;
  return (z.startsWith("-") ? -1 : 1) * (h * 60 + mi) * 60_000;
}

function findIso(text: string): Found<DatePart>[] {
  return scan<DatePart>(text, ISO_RE, (m) => {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < 1000 || !validDay(year, month, day)) return null;
    let time: { h: number; mi: number; s: number } | null = null;
    if (m[4] !== undefined) {
      time = { h: Number(m[4]), mi: Number(m[5]), s: m[6] === undefined ? 0 : Number(m[6]) };
      if (time.h > 23 || time.mi > 59 || time.s > 59) return null;
    }
    let off: number | null = null;
    if (m[7] !== undefined) {
      off = offsetMs(m[7]);
      if (off === null || time === null) return null;
    }
    return { form: "iso", year, month, day, time, offsetMs: off };
  });
}

/** Date phrases, leftmost first; where two overlap the earlier one wins, then the longer. */
export function findDates(text: string): Found<DatePart>[] {
  const all = [...findIso(text), ...findNumeric(text), ...findMonthDays(text), ...findDayWords(text), ...findWeekdays(text)];
  return disjoint(all);
}

function findMeridiem(text: string): Found<TimePart>[] {
  return scan<TimePart>(text, /(\d{1,2})(?::(\d{2}))?[ ]?(a\.m\.|p\.m\.|am|pm)/iu, (m) => {
    const hour = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (hour < 1 || hour > 12 || mi > 59) return null;
    const pm = m[3]!.toLowerCase().startsWith("p");
    return { h: hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour, mi, form: "meridiem", unmarked12: false };
  });
}

function findClock(text: string): Found<TimePart>[] {
  return scan<TimePart>(text, /(\d{1,2}):(\d{2})/u, (m) => {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return { h, mi, form: "clock", unmarked12: h >= 1 && h <= 12 };
  });
}

function findNoon(text: string): Found<TimePart>[] {
  return scan<TimePart>(text, /noon/iu, () => ({ h: 12, mi: 0, form: "noon", unmarked12: false }));
}

export function findTimes(text: string): Found<TimePart>[] {
  return disjoint([...findMeridiem(text), ...findClock(text), ...findNoon(text)]);
}

function disjoint<T>(found: Found<T>[]): Found<T>[] {
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Found<T>[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (!last || f.start >= last.end) out.push(f);
  }
  return out;
}
