/**
 * Reading the value half of a phrase: choices and people ("A or B"), numbers, durations, ratings
 * and dates. Every reader returns null for text it does not fully understand, because a half-read
 * value would become a wrong filter.
 */
import type { DateOperand, Field } from "@/api/types";
import { zonedParts, zonedToInstant, ymdToIso } from "@/lib/cells/dates";
import { parseDuration, parseNumber } from "@/lib/cells/text";
import { guessDate, type DateContext } from "@/lib/dateGuess";
import { tokenWords, tokenWordsWithCommas, wordsOf, type Token } from "./tokens";

/** One thing a value can name: a choice, or a person (who may be known by several spellings). */
export interface ChoiceEntry {
  id: string;
  /** How the value reads in a label. */
  label: string;
  words: string[];
}

export interface Segmented {
  entries: ChoiceEntry[];
  /** How the names were joined; null for a single name. */
  joiner: "or" | "and" | null;
}

const SEPARATORS = new Set(["or", "and"]);

/**
 * Split `words` into whole choice names joined by "or" (or by "and"). A choice that itself holds
 * "or" or "and" ("Sales or marketing") reads as one name before it reads as two. The first reading
 * that uses every word wins, trying the longest name first.
 */
export function segment(words: readonly string[], entries: readonly ChoiceEntry[], allowAnd: boolean): Segmented | null {
  if (words.length === 0) return null;
  const n = words.length;
  const startsAt = (i: number, e: ChoiceEntry): boolean => e.words.length > 0 && i + e.words.length <= n && e.words.every((w, k) => words[i + k] === w);

  const failed = new Set<string>();
  const walk = (i: number, joiner: "or" | "and" | null): Segmented | null => {
    const memo = `${i}:${joiner}`;
    if (failed.has(memo)) return null;
    const fits = entries.filter((e) => startsAt(i, e)).sort((a, b) => b.words.length - a.words.length);
    for (const e of fits) {
      const j = i + e.words.length;
      if (j === n) return { entries: [e], joiner };
      const sep = words[j]!;
      if (!SEPARATORS.has(sep) || (sep === "and" && !allowAnd)) continue;
      if (joiner !== null && joiner !== sep) continue;
      const rest = walk(j + 1, sep as "or" | "and");
      if (rest) {
        const seen = new Set<string>();
        const all = [e, ...rest.entries].filter((x) => !seen.has(x.id) && !!seen.add(x.id));
        return { entries: all, joiner: rest.joiner };
      }
    }
    failed.add(memo);
    return null;
  };
  return walk(0, null);
}

/**
 * `segment` for the tokens of a typed value. A comma between names reads as `comma` ("or" unless the
 * operator asks for all of them), unless the names themselves hold the comma ("Lead, qualified"),
 * which is tried first.
 */
export function segmentValue(tokens: readonly Token[], entries: readonly ChoiceEntry[], allowAnd: boolean, comma: "or" | "and" = "or"): Segmented | null {
  return segment(tokenWords(tokens), entries, allowAnd) ?? segment(tokenWordsWithCommas(tokens, comma), entries, allowAnd);
}

/** Entries for the choices of a select property. */
export function choiceEntries(choices: readonly { id: string; name: string }[]): ChoiceEntry[] {
  return choices.map((c) => ({ id: c.id, label: c.name, words: wordsOf(c.name) })).filter((e) => e.words.length > 0);
}

/** The marker the server reads as "whoever is asking". */
export const ME = "me";

/**
 * Entries for a people property: the current person under the words for "me", and the
 * collaborators by full name, plus by first name when no other collaborator shares it.
 */
export function peopleEntries(userId: string | null | undefined, collaborators: readonly { id: string; name: string }[]): ChoiceEntry[] {
  const out: ChoiceEntry[] = [];
  if (userId) for (const w of ["me", "myself", "mine"]) out.push({ id: ME, label: "me", words: [w] });
  const firstNames = new Map<string, number>();
  for (const c of collaborators) {
    const first = wordsOf(c.name)[0];
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  for (const c of collaborators) {
    const words = wordsOf(c.name);
    if (words.length === 0 || c.id === userId) continue;
    out.push({ id: c.id, label: c.name, words });
    const first = words[0]!;
    if (words.length > 1 && firstNames.get(first) === 1 && !ME_LIKE.has(first)) out.push({ id: c.id, label: c.name, words: [first] });
  }
  return out;
}

const ME_LIKE = new Set(["me", "myself", "mine"]);

// ---- numbers ----

const SHORT_THOUSANDS = /^(-?)([$€£¥]?)(-?\d[\d.,]*)\s?k$/iu;

/**
 * A number typed for this property, or null. "5k" is 5,000. A percent property reads "50%" and "50"
 * the same; a duration needs a unit or a colon (a bare "90" could be seconds or minutes); a rating
 * is a whole number up to its maximum, or stars.
 */
export function numberValue(field: Field, raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // Digits split by a space ("5 6") or a comma that is not a thousands group ("1,5") are not one
  // number, though the cell parser would run them together.
  if (/\d\s+\d/.test(s) && field.type !== "duration") return null;
  if (/,(?!\d{3}(?!\d))/.test(s) && field.type !== "duration") return null;
  if (field.type === "rating") {
    const stars = /^([★⭐]+)$/u.exec(s);
    const n = stars ? [...stars[1]!].length : /^(\d+)\s*(?:stars?|★)?$/iu.exec(s)?.[1];
    if (n === undefined || n === null) return null;
    const v = Number(n);
    return Number.isInteger(v) && v >= 0 && v <= field.options.max ? v : null;
  }
  if (field.type === "duration") {
    if (!/[:a-z]/i.test(s)) return null;
    return parseDuration(s);
  }
  const symbol = field.type === "currency" ? field.options.symbol : null;
  const thousands = SHORT_THOUSANDS.exec(s);
  const parsed = parseNumber(thousands ? thousands[3]! : s, symbol);
  if (!parsed) return null;
  if (parsed.percent && field.type !== "percent") return null;
  const value = thousands ? parsed.value * 1000 * (thousands[1] ? -1 : 1) : parsed.value;
  return Number.isFinite(value) ? value : null;
}

/** A number as a label reads it. */
export function numberLabel(field: Field, value: number, raw: string): string {
  if (field.type === "duration") return raw.trim();
  if (field.type === "rating") return `${value} ${value === 1 ? "star" : "stars"}`;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: 8 });
  if (field.type === "percent") return `${text}%`;
  if (field.type === "currency") return value < 0 ? `-${field.options.symbol}${text.slice(1)}` : `${field.options.symbol}${text}`;
  return text;
}

// ---- dates ----

export interface DateValue {
  operand: DateOperand;
  /** A span of days (this week), which only "is within" takes, rather than one day. */
  range: boolean;
  /** How the value reads in a label. */
  label: string;
}

const MAX_DAYS = 100_000;

const RANGES: Record<string, { mode: DateOperand["mode"]; label: string }> = {
  "this week": { mode: "this_calendar_week", label: "this week" },
  "next week": { mode: "next_calendar_week", label: "next week" },
  "last week": { mode: "last_calendar_week", label: "last week" },
  "previous week": { mode: "last_calendar_week", label: "last week" },
  "this month": { mode: "this_calendar_month", label: "this month" },
  "next month": { mode: "next_calendar_month", label: "next month" },
  "last month": { mode: "last_calendar_month", label: "last month" },
  "previous month": { mode: "last_calendar_month", label: "last month" },
  "this year": { mode: "this_calendar_year", label: "this year" },
  "past week": { mode: "past_week", label: "past week" },
  "past month": { mode: "past_month", label: "past month" },
  "past year": { mode: "past_year", label: "past year" },
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function days(n: number, unit: string): number {
  return unit.startsWith("week") ? n * 7 : n;
}

/** A calendar day as a label reads it: "Nov 14", and the year when it is not this one. */
export function dayLabel(iso: string, thisYear: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return y === thisYear ? `${MONTHS_SHORT[m - 1]} ${d}` : `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

const EXACT_KINDS = new Set(["weekday", "this-weekday", "next-weekday", "month-day", "numeric", "iso"]);

/**
 * A date value, or null: today, tomorrow, yesterday, "3 days ago", "in 3 days", a week or month
 * ago or ahead, "this week", "next month", "past 7 days", "next 30 days", and a day written as
 * "Nov 14", "11/14", "Friday" or "2026-11-14". A time of day is not a filter value.
 */
export function dateValue(raw: string, ctx: DateContext): DateValue | null {
  const s = raw
    .toLowerCase()
    .replace(/[.,;!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const bare = s.replace(/^the /, "");

  const range = RANGES[bare];
  if (range) return { operand: { mode: range.mode } as DateOperand, range: true, label: range.label };

  const span = /^(past|last|previous|next|coming|upcoming) (\d+) (days?|weeks?)$/.exec(bare);
  if (span) {
    const n = days(Number(span[2]), span[3]!);
    if (n < 1 || n > MAX_DAYS) return null;
    const past = span[1] === "past" || span[1] === "last" || span[1] === "previous";
    return { operand: { mode: past ? "past_number_of_days" : "next_number_of_days", days: n }, range: true, label: `${past ? "past" : "next"} ${plural(n, "day")}` };
  }

  if (s === "today" || s === "tomorrow" || s === "yesterday") return { operand: { mode: s }, range: false, label: s };

  const unitSpan = (n: number, unit: string, ahead: boolean): DateValue | null => {
    const d = days(n, unit);
    if (d < 1 || d > MAX_DAYS) return null;
    const mode = ahead ? "number_of_days_from_now" : "number_of_days_ago";
    return { operand: { mode, days: d }, range: false, label: ahead ? `in ${plural(d, "day")}` : `${plural(d, "day")} ago` };
  };
  const ago = /^(\d+|an?) (days?|weeks?|months?) ago$/.exec(s);
  const ahead = /^in (\d+|an?) (days?|weeks?|months?)$/.exec(s) ?? /^(\d+|an?) (days?|weeks?|months?) from (?:now|today)$/.exec(s);
  for (const [m, isAhead] of [[ago, false], [ahead, true]] as const) {
    if (!m) continue;
    const n = m[1]!.startsWith("a") ? 1 : Number(m[1]);
    const unit = m[2]!;
    if (unit.startsWith("month")) {
      if (n !== 1) return null;
      return { operand: { mode: isAhead ? "one_month_from_now" : "one_month_ago" }, range: false, label: isAhead ? "in a month" : "a month ago" };
    }
    if (n === 1 && unit.startsWith("week")) return { operand: { mode: isAhead ? "one_week_from_now" : "one_week_ago" }, range: false, label: isAhead ? "in a week" : "a week ago" };
    return unitSpan(n, unit, isAhead);
  }

  const phrase = raw.trim().replace(/[.,;!?]+$/u, "");
  const nowMs = typeof ctx.now === "number" ? ctx.now : ctx.now.getTime();
  const thisYear = zonedParts(nowMs, ctx.timeZone).y;
  let g = guessDate(phrase, ctx);
  // A filter looks back as often as ahead: "since Nov 1" in November is this year's Nov 1, so a
  // day written without a year is read from the start of the year, not from today.
  if (g && (g.kind === "month-day" || g.kind === "numeric")) {
    const startOfYear = zonedToInstant({ y: thisYear, m: 1, d: 1, h: 0, mi: 0, s: 0, ms: 0 }, ctx.timeZone);
    g = guessDate(phrase, { ...ctx, now: startOfYear });
  }
  if (!g || g.rest.trim() !== "" || g.time !== null || !EXACT_KINDS.has(g.kind) || g.ambiguity.includes("more-phrases")) return null;
  const iso = ymdToIso(g.date);
  return { operand: { mode: "exact_date", date: iso }, range: false, label: dayLabel(iso, thisYear) };
}
