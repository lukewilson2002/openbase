/**
 * Property type guessing (FLD-1, decision 7): the type a typed-in value most likely wants, so a
 * new property can start from a value and be corrected afterwards. Fourteen rules tried in the
 * order of the spec's table; the first that matches wins. A pure function of the text: no model,
 * no network, no clock.
 *
 * It never guesses links or choices; the type picker offers those. CSV import keeps the server's
 * column guesser (`infer_kind`), which looks at a whole column; `examples.json` is the one table of
 * example values both are tested against, so they agree wherever both apply.
 */
import type { FieldKind } from "@/api/types";
import { guessDate, type DateContext } from "@/lib/dateGuess";

/** A field type with complete options (ready for `POST …/fields`) and the table row that chose it. */
export type TypeGuess = FieldKind & {
  /** 1 to 14: the row of the FLD-1 table that matched. */
  rule: number;
};

// Date phrases do not depend on the day they are read, only on which words and numbers form one,
// so the guess uses a fixed reference moment and stays pure.
const REFERENCE: DateContext = { now: Date.UTC(2000, 0, 1, 12), timeZone: "UTC", weekStart: 0 };

const NUMBER = String.raw`(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?`;
const SYMBOLS = "$€£¥";
const CHECKBOX_WORDS = /^(?:yes|no|true|false|✓|✗)$/i;
const EMAIL = /^[^@\s/:]+@[^@\s/]+\.[^@\s/]+$/;
const DOMAIN = String.raw`(?:[a-z0-9-]+\.)+[a-z]{2,}`;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const URL_WWW = new RegExp(String.raw`^www\.${DOMAIN}(?::\d+)?(?:[/?#]\S*)?$`, "i");
const URL_PATH = new RegExp(String.raw`^${DOMAIN}(?::\d+)?[/?#]\S*$`, "i");
const PHONE = /^\+?[\d(][\d ()-]*[\d)]$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_BEFORE = new RegExp(String.raw`^(-?)([${SYMBOLS}])\s?(-?)(${NUMBER})$`);
const CURRENCY_AFTER = new RegExp(String.raw`^(-?)(${NUMBER})\s?([${SYMBOLS}])$`);
const PERCENT = new RegExp(String.raw`^(-?${NUMBER})\s?%$`);
const PLAIN_NUMBER = new RegExp(String.raw`^-?${NUMBER}$`);
const CLOCK_DURATION = /^(\d{1,4}):([0-5]\d)(?::([0-5]\d))?$/;
const UNIT_DURATION = /^(?:(\d+(?:\.\d+)?)\s?(h|hr|hrs|hour|hours))?\s?(?:(\d+(?:\.\d+)?)\s?(m|min|mins|minute|minutes))?\s?(?:(\d+(?:\.\d+)?)\s?(s|sec|secs|second|seconds))?$/i;
const STARS = /^[★☆⭐]+$/u;

const decimals = (text: string): number => /\.(\d+)/.exec(text)?.[1]?.length ?? 0;
const digits = (text: string): number => text.replace(/\D/g, "").length;

/**
 * A figure the server's own importer would keep as a number: at most 15 digits (an f64 holds no
 * more) and at most 8 decimals. Anything longer is an identifier, a card number, a barcode.
 */
function figure(text: string): { precision: number } | null {
  if (digits(text) > 15 || decimals(text) > 8) return null;
  return { precision: decimals(text) };
}

function currency(v: string): TypeGuess | null {
  const before = CURRENCY_BEFORE.exec(v);
  const after = before ? null : CURRENCY_AFTER.exec(v);
  if (!before && !after) return null;
  const symbol = before ? before[2]! : after![3]!;
  const num = before ? before[4]! : after![2]!;
  // A sign on both sides of the symbol ("-$-5") says nothing sensible.
  if (before && before[1] && before[3]) return null;
  const f = figure(num);
  if (!f) return null;
  return { rule: 6, type: "currency", options: { precision: Math.max(2, f.precision), symbol, allow_negative: true } };
}

function duration(v: string): TypeGuess | null {
  const clock = CLOCK_DURATION.exec(v);
  if (clock) return { rule: 8, type: "duration", options: { format: clock[3] === undefined ? "h_mm" : "h_mm_ss" } };
  const m = UNIT_DURATION.exec(v);
  if (!m) return null;
  const parts = [m[2], m[4], m[6]].filter((u) => u !== undefined) as string[];
  if (parts.length === 0) return null;
  // "5m" and "30s" on their own are as likely meters, millions or sizes as time.
  if (parts.length === 1 && /^[ms]$/i.test(parts[0]!)) return null;
  return { rule: 8, type: "duration", options: { format: m[6] === undefined ? "h_mm" : "h_mm_ss" } };
}

function phone(v: string): boolean {
  if (!PHONE.test(v) || ISO_DATE_SHAPE.test(v)) return false;
  const n = digits(v);
  if (n < 7 || n > 15) return false;
  // A bare run of digits is a number or an identifier; a phone number is written with something between.
  if (/^\d+$/.test(v)) return false;
  return v.split("(").length === v.split(")").length;
}

function url(v: string): boolean {
  return URL_SCHEME.test(v) || URL_WWW.test(v) || URL_PATH.test(v);
}

function rating(v: string): TypeGuess | null {
  if (!STARS.test(v)) return null;
  const glyphs = [...v];
  const hollow = glyphs.filter((g) => g === "☆").length;
  if (hollow === glyphs.length || glyphs.length > 10) return null;
  return { rule: 12, type: "rating", options: { max: hollow > 0 ? glyphs.length : Math.max(5, glyphs.length), icon: "star", color: "yellow" } };
}

function date(v: string): TypeGuess | null {
  const g = guessDate(v, REFERENCE);
  // The value must be the phrase and nothing else: "Call Dana tomorrow" is text. A time alone is not a date.
  if (!g || g.phrase !== v || g.kind === "time") return null;
  const withTime = g.time !== null;
  return {
    rule: withTime ? 9 : 10,
    type: "date",
    options: { include_time: withTime, date_format: g.dateFormat, time_format: g.timeFormat },
  };
}

export function guessType(value: string): TypeGuess {
  const v = value.trim();
  if (v === "") return { rule: 1, type: "text", options: { multiline: false } };

  if (!/[\r\n]/.test(v)) {
    if (CHECKBOX_WORDS.test(v)) return { rule: 2, type: "checkbox", options: { icon: "check", color: "green" } };
    if (EMAIL.test(v)) return { rule: 3, type: "email", options: {} };
    if (url(v)) return { rule: 4, type: "url", options: {} };
    if (phone(v)) return { rule: 5, type: "phone", options: {} };
    const money = currency(v);
    if (money) return money;
    const pct = PERCENT.exec(v);
    const pctFigure = pct && figure(pct[1]!);
    if (pctFigure) return { rule: 7, type: "percent", options: { precision: pctFigure.precision, allow_negative: true } };
    const time = duration(v);
    if (time) return time;
    const when = date(v);
    if (when) return when;
    const num = PLAIN_NUMBER.test(v) ? figure(v) : null;
    if (num) return { rule: 11, type: "number", options: { precision: num.precision, allow_negative: true } };
    const stars = rating(v);
    if (stars) return stars;
    return { rule: 14, type: "text", options: { multiline: false } };
  }
  return { rule: 13, type: "text", options: { multiline: true } };
}
