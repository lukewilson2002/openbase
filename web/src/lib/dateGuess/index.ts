/**
 * Date guessing for capture (HOME-4, decision 7): finds one date or date-time phrase in text,
 * resolves it against an injected clock, zone and week start, and hands back the text without it.
 * A deterministic rule set: no model, no network, and the same input always gives the same answer.
 *
 * Forms understood: today, tonight, tomorrow, weekday names (Fri, Friday, this Friday, next Friday),
 * "Nov 14", "November 14th", "14 Nov", "14th of Nov", with or without a year, "11/14", "14/11",
 * "11/14/2026", "2026-11-14" (with an optional time and offset), and times: "9am", "9:30 pm",
 * "14:30", "noon". A date and a time written together ("tomorrow at 9am", "9am on Friday")
 * are one phrase.
 *
 * Choices the spec leaves open (recorded in the UX overhaul progress file):
 * - A bare weekday is the next one after today ("Friday" said on a Friday is a week away);
 *   "this Friday" counts today; "next Friday" is that day in the following calendar week.
 * - "Nov 14" and "11/14" without a year are the next such day on or after today. "3/4" is March 4
 *   unless the first number is above 12.
 * - A time on its own is its next occurrence: later today, else tomorrow.
 * - With several candidate phrases the last one that holds a date wins (a task states when at its
 *   end), else the last bare time; `more-phrases` flags that others were left in the text.
 * - Lowercase "sat", "sun", "wed" and "may" are ordinary words, not dates.
 * - A preposition in front of the phrase ("by Friday", "at 9am", "due Nov 14") goes with it.
 */
import { findDates, findTimes, type DatePart, type Found, type TimePart } from "./phrases";
import { resolve, type Ambiguity, type DateContext, type Resolved } from "./resolve";

export type { Ambiguity, DateContext, PhraseKind, Resolved } from "./resolve";

export interface DateGuess extends Resolved {
  /** The text that was read, untouched. */
  text: string;
  /** The phrase's span in `text`, including a preposition that led into it. */
  start: number;
  end: number;
  phrase: string;
  /** `text` without the phrase, the seam tidied. */
  rest: string;
  /** Where in `rest` the phrase came out of, for putting it back. */
  restAt: number;
}

interface Candidate {
  start: number;
  end: number;
  date: DatePart | null;
  time: TimePart | null;
}

/** What may sit between a date and a time written as one phrase: a space, a comma, "at", "on", "@". */
const JOINER = /^(?:\s*,\s*|\s+|\s*@\s*)(?:(?:at|on)\s+)?$/i;
const LEAD = /(^|[\s(\[])(?:on|at|by|before|until|till|due)\s+$/i;
const LEAD_AT_SIGN = /(^|[\s(\[])@\s*$/;

function joined(text: string, from: number, to: number): boolean {
  return JOINER.test(text.slice(from, to));
}

function candidates(text: string): Candidate[] {
  const dates = findDates(text);
  // A time inside a date phrase (an ISO "…T10:00") is part of it.
  const times = findTimes(text).filter((t) => !dates.some((d) => t.start < d.end && d.start < t.end));
  const claimed = new Set<Found<TimePart>>();
  const out: Candidate[] = [];
  for (const d of dates) {
    const own = d.part.form === "iso" && d.part.time !== null;
    const after = own ? undefined : times.find((t) => !claimed.has(t) && t.start >= d.end && joined(text, d.end, t.start));
    const before = own || after ? undefined : [...times].reverse().find((t) => !claimed.has(t) && t.end <= d.start && joined(text, t.end, d.start));
    const t = after ?? before;
    if (t) claimed.add(t);
    out.push({
      start: Math.min(d.start, t?.start ?? d.start),
      end: Math.max(d.end, t?.end ?? d.end),
      date: d.part,
      time: t?.part ?? null,
    });
  }
  for (const t of times) {
    if (!claimed.has(t)) out.push({ start: t.start, end: t.end, date: null, time: t.part });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Pull "by", "at", "on", "due" or "@" into the span, so "Send it by Friday" leaves "Send it". */
function withLead(text: string, start: number): number {
  let s = start;
  for (let i = 0; i < 2; i++) {
    const before = text.slice(0, s);
    const m = LEAD.exec(before) ?? LEAD_AT_SIGN.exec(before);
    if (!m) break;
    s = before.length - (m[0].length - m[1]!.length);
  }
  return s;
}

const CLOSING = /^[.,;:!?)\]]/;

/** The text with `[start, end)` cut out and the join left neat; `at` is where the cut happened. */
export function cutSpan(text: string, start: number, end: number): { rest: string; at: number } {
  // `[^\S\n]` is whitespace that is not a line break: a capture box can hold several lines.
  let before = text.slice(0, start).replace(/[^\S\n]+$/, "");
  let after = text.slice(end);
  const atLineStart = before === "" || before.endsWith("\n");
  const atLineEnd = /^[^\S\n]*(\n|$)/.test(after);
  if (atLineStart) {
    // "Tomorrow, call Dana" starts with the date; the comma that followed it goes too.
    after = after.replace(/^[^\S\n]*[,;:\-–—]?[^\S\n]*/, "");
  } else if (atLineEnd) {
    before = before.replace(/[^\S\n]*[,;:\-–—][^\S\n]*$/, "");
    after = after.replace(/^[^\S\n]+/, "");
  } else {
    // "Call Dana, tomorrow, about it" must not keep both commas.
    if (/[,;]$/.test(before)) after = after.replace(/^[^\S\n]*[,;]/, "");
    after = after.replace(/^[^\S\n]+(?=[.,;:!?)\]])/, "").replace(/^[^\S\n]+/, " ");
  }
  return { rest: before + after, at: before.length };
}

/**
 * Find the date or date-time phrase in `text`, or null when there is none. `ctx.now` is read as an
 * instant in `ctx.timeZone`; the result never depends on the machine's own clock or zone.
 */
export function guessDate(text: string, ctx: DateContext): DateGuess | null {
  const found = candidates(text);
  const dated = found.filter((c) => c.date !== null);
  const pool = dated.length > 0 ? dated : found;
  const pick = pool[pool.length - 1];
  if (!pick) return null;

  const start = withLead(text, pick.start);
  const resolved = resolve(pick.date, pick.time, ctx);
  const ambiguity: Ambiguity[] = found.length > 1 ? [...resolved.ambiguity, "more-phrases"] : resolved.ambiguity;
  const { rest, at } = cutSpan(text, start, pick.end);
  return { ...resolved, ambiguity, text, start, end: pick.end, phrase: text.slice(start, pick.end), rest, restAt: at };
}

/**
 * Put the removed words back (the chip was taken off). Untouched `rest` gives the original text
 * exactly; if the person kept typing, the phrase goes back where it came out, spaced to fit.
 */
export function restorePhrase(guess: DateGuess, currentRest: string): string {
  if (currentRest === guess.rest) return guess.text;
  const at = Math.min(guess.restAt, currentRest.length);
  const left = currentRest.slice(0, at);
  const right = currentRest.slice(at);
  const spaceBefore = left !== "" && !/\s$/.test(left) ? " " : "";
  const spaceAfter = right !== "" && !/^\s/.test(right) && !CLOSING.test(right) ? " " : "";
  return left + spaceBefore + guess.phrase + spaceAfter + right;
}
