/**
 * Plain-language filters (COL-4, decision 7): turns what someone types into the filters it could
 * mean, best first, using the operators and operands the filter builder already has. A pure
 * function of the text, the collection's properties and the context: no model, no network, and the
 * same input always gives the same answer.
 *
 * What comes back, in this order (COL-3):
 * 1. `filter` candidates: "Next follow-up is this week", "Status is any of Lead, Won", "Amount is over 500".
 * 2. `long-text` candidates: "Notes contain “follow-up this week”", one per long-text property, and
 *    only next to a filter reading (text nothing can read yields just the search suggestion).
 * 3. One `search` candidate: "Search every property for “…”".
 *
 * Text that cannot be read as a filter is never turned into a guess: it gets the search suggestion
 * alone, and empty text gets nothing.
 *
 * Choices the spec leaves open (recorded in the UX overhaul progress file):
 * - A property needs an operator or a value that can only be read one way. "Name Dana" is not a
 *   filter (a text value without an operator could mean contains or is); "Status Won" is, because
 *   "Won" must be a choice of Status. "Done" alone, or "Notes", is not a filter.
 * - A bare value with no property names the property itself only when exactly one property can
 *   hold it: a choice of exactly one select, "mine" for people, "checked" for checkboxes, a date
 *   phrase when there is exactly one date property (created and modified times do not count).
 * - "this week", "next week", "last week", "this month", "next month", "last month" and "this year"
 *   use the calendar operands, which the server resolves with the person's week start. "next year"
 *   and "last year" have no calendar operand and are not read.
 * - A day written out ("Nov 14", "11/14", "Friday") becomes an exact date; the label shows it
 *   spelled out, with the year when it is not this one. Times of day are not filter values.
 * - "me" and "mine" write the marker `"me"`, which the server resolves for whoever opens the view,
 *   so a saved view keeps meaning "mine" for everyone. Without a `userId` they are not read.
 * - `is` on a text property is the server's exact, case-sensitive match; the person sees "is".
 */
import type { Collaborator, Condition, Field, FilterOp } from "@/api/types";
import { filterOpsFor, isFilterable } from "@/lib/cells/filters";
import { isMultilineText, kindClassOf, selectChoicesOf } from "@/lib/cells/kinds";
import type { DateContext } from "@/lib/dateGuess";
import { BARE_BOOLEAN, BOOLEAN, BOOLEAN_PREFIX, DATE_OPS, EMPTINESS, EMPTINESS_PREFIX, ITEM_TEXT_OPS, ME_PHRASES, NUMBER_OPS, SET_OPS, TEXT_OPS, operatorsAt, wholeMatch, type Lexicon, type OpMatch, type SetTag } from "./lexicon";
import { findPropertyMatches, type Quality } from "./match";
import { keysOf, tokenize, valueText, type Token } from "./tokens";
import { OP_TEXT } from "./words";
import { ME, choiceEntries, dateValue, numberLabel, numberValue, peopleEntries, segmentValue, type ChoiceEntry, type Segmented } from "./values";

export type { DateContext } from "@/lib/dateGuess";
export { conditionLabel, describeCondition } from "./describe";

export interface PhraseContext {
  /** The collection's properties, in their order. Leave out any that should not be offered, such as the Page. */
  fields: readonly Field[];
  /** The signed-in person, which is what makes "me" and "mine" readable. */
  userId?: string | null;
  /** People who can be named ("Owner is Dana"). */
  collaborators?: readonly Pick<Collaborator, "id" | "name">[];
  /** The moment the text is read, in `timeZone`, for days written as "Friday" or "Nov 14". */
  now: Date | number;
  timeZone: string;
  /** 0 = Sunday, 1 = Monday. Only "next Friday" depends on it here; calendar weeks are the server's. */
  weekStart: 0 | 1;
}

/** One piece of a label. The bar draws `property` and `value` in bold. */
export interface LabelPart {
  role: "property" | "operator" | "value" | "text";
  text: string;
}

export interface FilterCandidate {
  kind: "filter" | "long-text";
  fieldId: string;
  /** Ready for a chip or a view's filter. */
  condition: Condition;
  label: LabelPart[];
  /** Higher is more likely. Candidates come back sorted by it. */
  score: number;
  /** How the property was found: by its name (exact, prefix, partial), from a value alone, or as the long-text fallback. */
  match: Quality | "value" | "text";
}

export interface SearchCandidate {
  kind: "search";
  query: string;
  label: LabelPart[];
  score: number;
}

export type Candidate = FilterCandidate | SearchCandidate;

/** A label as plain text: its parts, one space apart. */
export function labelText(parts: readonly LabelPart[]): string {
  return parts.map((p) => p.text).join(" ");
}

// ---- readings ----

interface Reading {
  op: FilterOp;
  value: Condition["value"];
  /** The operator as a label says it. */
  opText: string;
  /** The value as a label says it; null when the operator needs none. */
  valueLabel: string | null;
  /** Spelled out with an operator word or symbol, rather than implied by the value. */
  explicit: boolean;
}

interface Env {
  typed: string;
  ctx: PhraseContext;
  dates: DateContext;
}


function reading(op: FilterOp, value: Condition["value"], valueLabel: string | null, explicit: boolean): Reading {
  return { op, value, opText: OP_TEXT[op], valueLabel, explicit };
}

/** The operators to try on the right-hand side: each lexicon match, longest first, then none at all. */
function attempts<T>(rest: readonly Token[], table: Lexicon<T>, implicit: boolean): (OpMatch<T> | null)[] {
  const found: (OpMatch<T> | null)[] = operatorsAt(rest, table);
  if (implicit) found.push(null);
  return found;
}

function readEmptiness(field: Field, rest: readonly Token[]): Reading | null {
  const tag = wholeMatch(rest, EMPTINESS);
  return tag ? emptiness(field, tag) : null;
}

function emptiness(field: Field, tag: "empty" | "filled"): Reading | null {
  const op: FilterOp = tag === "empty" ? "is_empty" : "is_not_empty";
  return filterOpsFor(field).includes(op) ? reading(op, null, null, true) : null;
}

function readText(rest: readonly Token[], env: Env): Reading | null {
  // Text takes the longest operator only: "Name is not" must not fall back to "is" with the value "not".
  const op = operatorsAt(rest, TEXT_OPS)[0];
  if (!op) return null;
  const value = valueText(env.typed, rest.slice(op.len));
  return value ? reading(op.tag, value, value, true) : null;
}

function readItemText(rest: readonly Token[], env: Env): Reading | null {
  const op = operatorsAt(rest, ITEM_TEXT_OPS)[0];
  if (!op) return null;
  const value = valueText(env.typed, rest.slice(op.len));
  return value ? reading(op.tag, value, value, true) : null;
}

const NUMBER_OP: Record<string, FilterOp> = { eq: "is", ne: "is_not", gt: "gt", gte: "gte", lt: "lt", lte: "lte" };

function readNumber(field: Field, rest: readonly Token[], env: Env): Reading | null {
  for (const at of attempts(rest, NUMBER_OPS, true)) {
    const value = rest.slice(at?.len ?? 0);
    if (value.length === 0) continue;
    const raw = valueText(env.typed, value);
    const n = numberValue(field, raw);
    if (n === null) continue;
    return reading(NUMBER_OP[at?.tag ?? "eq"]!, n, numberLabel(field, n, raw), at !== null);
  }
  return null;
}

function readBoolean(rest: readonly Token[]): Reading | null {
  const tag = wholeMatch(rest, BOOLEAN);
  return tag ? reading("is", tag === "checked", tag, true) : null;
}

function entriesFor(field: Field, env: Env): ChoiceEntry[] {
  switch (kindClassOf(field)) {
    case "select":
    case "multi_select":
      return choiceEntries(selectChoicesOf(field));
    default:
      return peopleEntries(env.ctx.userId, env.ctx.collaborators ?? []);
  }
}

/** The operator and value for named choices or people, given how the person phrased the operator. */
function setReading(multi: boolean, tag: SetTag | null, seg: Segmented, explicit: boolean): Reading | null {
  const ids = seg.entries.map((e) => e.id);
  const one = ids.length === 1;
  const names = seg.entries.map((e) => e.label).join(", ");
  const and = seg.joiner === "and";
  const make = (op: FilterOp): Reading => reading(op, op === "is" || op === "is_not" ? ids[0]! : ids, names, explicit);
  const t = tag ?? "eq";
  if (!multi) {
    switch (t) {
      case "eq":
      case "contains":
        return make(one ? "is" : "is_any_of");
      case "ne":
      case "does_not_contain":
        return make(one ? "is_not" : "is_none_of");
      case "any":
        return make("is_any_of");
      case "none":
        return make("is_none_of");
      case "exact":
        return one ? make("is") : null;
      case "all":
        return null;
    }
  }
  switch (t) {
    case "eq":
    case "contains":
      return make(and ? "has_all_of" : "has_any_of");
    case "any":
      return and ? null : make("has_any_of");
    case "ne":
    case "does_not_contain":
    case "none":
      return and ? null : make("has_none_of");
    case "all":
      return seg.joiner === "or" ? null : make("has_all_of");
    case "exact":
      return seg.joiner === "or" ? null : make("is_exactly");
  }
}

function readSet(field: Field, rest: readonly Token[], env: Env, multi: boolean): Reading | null {
  const entries = entriesFor(field, env);
  if (entries.length === 0) return null;
  for (const at of attempts(rest, SET_OPS, true)) {
    const value = rest.slice(at?.len ?? 0);
    if (value.length === 0) continue;
    const seg = segmentValue(value, entries, multi, at?.tag === "all" || at?.tag === "exact" ? "and" : "or");
    if (!seg) continue;
    const r = setReading(multi, at?.tag ?? null, seg, at !== null);
    if (r) return r;
  }
  return null;
}

function readDate(rest: readonly Token[], env: Env): Reading | null {
  for (const at of attempts(rest, DATE_OPS, true)) {
    const value = rest.slice(at?.len ?? 0);
    if (value.length === 0) continue;
    const dv = dateValue(valueText(env.typed, value), env.dates);
    if (!dv) continue;
    const explicit = at !== null;
    switch (at?.tag ?? "is") {
      case "is":
      case "within":
        return reading(dv.range ? "is_within" : "is", dv.operand, dv.label, explicit);
      case "is_not":
        if (dv.range) continue;
        return reading("is_not", dv.operand, dv.label, explicit);
      case "before":
        if (dv.range) continue;
        return reading("is_before", dv.operand, dv.label, explicit);
      case "after":
        if (dv.range) continue;
        return reading("is_after", dv.operand, dv.label, explicit);
      case "on_or_before":
        if (dv.range) continue;
        return reading("is_on_or_before", dv.operand, dv.label, explicit);
      case "on_or_after":
        if (dv.range) continue;
        return reading("is_on_or_after", dv.operand, dv.label, explicit);
    }
  }
  return null;
}

/** What the words after a property name ask of that property. */
function readRight(field: Field, rest: readonly Token[], env: Env): Reading | null {
  switch (kindClassOf(field)) {
    case "text":
      return readText(rest, env);
    case "attachment":
    case "link":
    case "list":
      return readItemText(rest, env);
    case "number":
      return readNumber(field, rest, env);
    case "bool":
      return readBoolean(rest);
    case "select":
    case "user":
      return readSet(field, rest, env, false);
    case "multi_select":
    case "user_multi":
      return readSet(field, rest, env, true);
    case "date":
      return readDate(rest, env);
    case "inert":
      return null;
  }
}

/** "no Contact", "with Contact", "unchecked Done": the words come before the name and nothing follows. */
function readLeft(field: Field, before: readonly Token[]): Reading | null {
  if (kindClassOf(field) === "bool") {
    const tag = wholeMatch(before, BOOLEAN_PREFIX);
    return tag ? reading("is", tag === "checked", tag, true) : null;
  }
  const tag = wholeMatch(before, EMPTINESS_PREFIX);
  return tag ? emptiness(field, tag) : null;
}

function readAround(field: Field, before: readonly Token[], after: readonly Token[], env: Env): Reading | null {
  if (before.length > 0) return after.length === 0 ? readLeft(field, before) : null;
  if (after.length === 0) return null;
  return readEmptiness(field, after) ?? readRight(field, after, env);
}

// ---- candidates ----

const BASE_SCORE = 1000;
const QUALITY_SCORE: Record<Quality | "value", number> = { exact: 300, prefix: 200, value: 150, partial: 100 };
const LONG_TEXT_SCORE = 500;
const SEARCH_SCORE = 100;
/** Longer text is a pasted passage, not a filter; it gets the search suggestion alone. */
const MAX_PHRASE_LENGTH = 300;

function labelFor(field: Field, r: Reading): LabelPart[] {
  const parts: LabelPart[] = [
    { role: "property", text: field.name },
    { role: "operator", text: r.opText },
  ];
  if (r.valueLabel !== null) parts.push({ role: "value", text: r.valueLabel });
  return parts;
}

interface Scored extends FilterCandidate {
  index: number;
}

function candidate(field: Field, index: number, r: Reading, match: Quality | "value", words: number, bonus = 0): Scored {
  return {
    kind: "filter",
    fieldId: field.id,
    condition: { field_id: field.id, op: r.op, value: r.value },
    label: labelFor(field, r),
    score: BASE_SCORE + QUALITY_SCORE[match] + Math.min(words, 9) * 5 + (r.explicit ? 4 : 2) + bonus,
    match,
    index,
  };
}

const sameCondition = (c: Condition): string => JSON.stringify([c.field_id, c.op, c.value]);

/** Bare values: no property is named, so only a property that alone can hold the value is offered. */
function bareCandidates(tokens: readonly Token[], fields: readonly { field: Field; index: number }[], env: Env): Scored[] {
  const out: Scored[] = [];
  const plain = tokens.every((t) => t.kind === "word");

  if (plain) {
    const holders = fields.flatMap(({ field, index }) => {
      const cls = kindClassOf(field);
      if (cls !== "select" && cls !== "multi_select") return [];
      const multi = cls === "multi_select";
      const seg = segmentValue(tokens, choiceEntries(selectChoicesOf(field)), multi);
      const r = seg && setReading(multi, null, seg, false);
      return r ? [{ field, index, r }] : [];
    });
    if (holders.length === 1) out.push(candidate(holders[0]!.field, holders[0]!.index, holders[0]!.r, "value", 0));

    const phrase = keysOf(tokens).join(" ");
    if (env.ctx.userId && ME_PHRASES.has(phrase)) {
      for (const { field, index } of fields) {
        const cls = kindClassOf(field);
        if (cls !== "user" && cls !== "user_multi") continue;
        const seg: Segmented = { entries: [{ id: ME, label: "me", words: [phrase] }], joiner: null };
        const r = setReading(cls === "user_multi", null, seg, false);
        // Who made or last changed a record is a less likely meaning of "mine" than who it is assigned to.
        if (r) out.push(candidate(field, index, r, "value", 0, field.type === "user" ? 0 : -10));
      }
    }

    const state = wholeMatch(tokens, BARE_BOOLEAN);
    if (state) {
      for (const { field, index } of fields) {
        if (kindClassOf(field) === "bool") out.push(candidate(field, index, reading("is", state === "checked", state, false), "value", 0));
      }
    }
  }

  // Only the date properties people fill in count; created and modified times are on every collection.
  const dated = fields.filter(({ field }) => field.type === "date");
  if (dated.length === 1) {
    const { field, index } = dated[0]!;
    const r = readDate(tokens, env);
    if (r) out.push(candidate(field, index, r, "value", 0));
  }
  return out;
}

/** The suggestions for what someone has typed, best first. Empty text gives none. */
export function parsePhrase(text: string, ctx: PhraseContext): Candidate[] {
  const typed = text.trim().replace(/\s+/g, " ");
  if (typed === "") return [];
  const tokens = typed.length > MAX_PHRASE_LENGTH ? [] : tokenize(typed);
  const env: Env = { typed, ctx, dates: { now: ctx.now, timeZone: ctx.timeZone, weekStart: ctx.weekStart } };
  const fields = ctx.fields.map((field, index) => ({ field, index })).filter(({ field }) => isFilterable(field));

  const found: Scored[] = [];
  for (const m of findPropertyMatches(tokens, fields)) {
    const r = readAround(m.field, tokens.slice(0, m.startToken), tokens.slice(m.endToken), env);
    if (r) found.push(candidate(m.field, m.index, r, m.quality, m.words));
  }
  found.push(...bareCandidates(tokens, fields, env));

  found.sort((a, b) => b.score - a.score || a.index - b.index);
  const seen = new Set<string>();
  const filters = found.filter((c) => {
    const key = sameCondition(c.condition);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const out: Candidate[] = filters.map(({ index: _index, ...c }) => c);

  // The long-text reading is offered next to a filter reading, as the other way to take the words.
  if (filters.length > 0) {
    const named = new Set(filters.filter((c) => c.match !== "value").map((c) => c.fieldId));
    for (const { field } of fields) {
      if (!isMultilineText(field) || named.has(field.id)) continue;
      out.push({
        kind: "long-text",
        fieldId: field.id,
        condition: { field_id: field.id, op: "contains", value: typed },
        label: [
          { role: "property", text: field.name },
          { role: "operator", text: "contain" },
          { role: "value", text: `“${typed}”` },
        ],
        score: LONG_TEXT_SCORE,
        match: "text",
      });
    }
  }

  out.push({
    kind: "search",
    query: typed,
    label: [
      { role: "text", text: "Search every property for" },
      { role: "value", text: `“${typed}”` },
    ],
    score: SEARCH_SCORE,
  });
  return out;
}
