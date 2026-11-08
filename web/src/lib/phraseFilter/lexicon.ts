/**
 * The words that stand for an operator, written once as plain phrases and matched against token
 * keys (lower case, apostrophes dropped). A phrase may be several words ("at least"); the longest
 * one that fits wins, so "is not" is never read as "is" followed by "not".
 */
import type { Token } from "./tokens";

export interface Entry<T> {
  seq: string[];
  tag: T;
}

export type Lexicon<T> = readonly Entry<T>[];

/** Build a lexicon from `tag: [phrases]`, longest phrases first. */
export function lexicon<T extends string>(table: Record<T, readonly string[]>): Lexicon<T> {
  const out: Entry<T>[] = [];
  for (const tag of Object.keys(table) as T[]) {
    for (const phrase of table[tag]) out.push({ seq: phrase.split(" "), tag });
  }
  return out.sort((a, b) => b.seq.length - a.seq.length);
}

export interface OpMatch<T> {
  tag: T;
  /** Tokens the operator uses. */
  len: number;
}

/** Every entry that starts at `tokens[0]`, longest first. */
export function operatorsAt<T>(tokens: readonly Token[], table: Lexicon<T>): OpMatch<T>[] {
  const out: OpMatch<T>[] = [];
  for (const e of table) {
    if (e.seq.length > tokens.length) continue;
    if (e.seq.every((k, i) => tokens[i]!.key === k && tokens[i]!.kind !== "quoted")) out.push({ tag: e.tag, len: e.seq.length });
  }
  return out;
}

/** The tag of a lexicon entry that is exactly all of `tokens`, if any. */
export function wholeMatch<T>(tokens: readonly Token[], table: Lexicon<T>): T | null {
  return operatorsAt(tokens, table).find((m) => m.len === tokens.length)?.tag ?? null;
}

export type EmptyTag = "empty" | "filled";

/** "Notes is empty", "Notes not empty": the whole right-hand side says it. */
export const EMPTINESS = lexicon<EmptyTag>({
  empty: ["empty", "is empty", "are empty", "blank", "is blank", "missing", "is missing", "unset", "is unset", "not set", "is not set", "isnt set", "none", "is none", "no value", "has no value", "null", "is null"],
  filled: ["not empty", "is not empty", "isnt empty", "non empty", "nonempty", "is non empty", "is nonempty", "not blank", "is not blank", "isnt blank", "filled", "is filled", "filled in", "is filled in", "set", "is set", "has value", "has a value", "has any value"],
});

/** In front of the property name: "no Contact", "with Contact". */
export const EMPTINESS_PREFIX = lexicon<EmptyTag>({
  empty: ["no", "without", "missing", "empty", "blank", "unset"],
  filled: ["with", "has", "having", "filled", "not empty", "non empty", "nonempty", "not blank"],
});

export type BoolTag = "checked" | "unchecked";

export const BOOLEAN = lexicon<BoolTag>({
  checked: ["checked", "is checked", "ticked", "is ticked", "true", "is true", "yes", "is yes", "= true", "= yes"],
  unchecked: ["unchecked", "is unchecked", "not checked", "is not checked", "isnt checked", "unticked", "is unticked", "not ticked", "is not ticked", "false", "is false", "no", "is no", "is not true", "isnt true", "= false", "= no"],
});

export const BOOLEAN_PREFIX = lexicon<BoolTag>({
  checked: ["checked", "ticked"],
  unchecked: ["unchecked", "unticked", "not"],
});

export type TextTag = "is" | "is_not" | "contains" | "does_not_contain" | "starts_with" | "ends_with";

export const TEXT_OPS = lexicon<TextTag>({
  is: ["is", "=", ":", "equals", "equal to", "is equal to", "are", "is exactly", "exactly"],
  is_not: ["is not", "isnt", "not", "!=", "not equal to", "is not equal to", "isnt equal to", "are not", "arent"],
  contains: ["contains", "contain", "containing", "includes", "include", "including", "has", "have", "having"],
  does_not_contain: ["doesnt contain", "does not contain", "dont contain", "do not contain", "not containing", "excludes", "exclude", "without", "lacks", "doesnt include", "does not include", "doesnt have", "does not have", "has no", "not contain"],
  starts_with: ["starts with", "start with", "starting with", "begins with", "begin with", "beginning with"],
  ends_with: ["ends with", "end with", "ending with"],
});

/** Links, attachments and lists only offer contains and does not contain. */
export const ITEM_TEXT_OPS = lexicon<"contains" | "does_not_contain">({
  contains: ["contains", "contain", "containing", "includes", "include", "including", "has", "have", "having", "mentions"],
  does_not_contain: ["doesnt contain", "does not contain", "dont contain", "do not contain", "not containing", "excludes", "exclude", "without", "lacks", "doesnt include", "does not include", "doesnt have", "does not have", "has no", "not contain"],
});

export type NumberTag = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export const NUMBER_OPS = lexicon<NumberTag>({
  eq: ["is", "=", ":", "equals", "equal to", "is equal to", "exactly", "is exactly", "are"],
  ne: ["is not", "isnt", "not", "!=", "not equal to", "is not equal to", "isnt equal to"],
  gt: [">", "over", "above", "more than", "greater than", "bigger than", "larger than", "higher than", "exceeds", "exceeding", "is over", "is above", "is more than", "is greater than", "is bigger than", "is larger than", "is higher than"],
  gte: [">=", "at least", "minimum", "min", "no less than", "not less than", "is at least", "is no less than", "is not less than", "greater than or equal to", "is greater than or equal to", "more than or equal to", "is more than or equal to"],
  lt: ["<", "under", "below", "less than", "fewer than", "lower than", "smaller than", "beneath", "is under", "is below", "is less than", "is fewer than", "is lower than", "is smaller than"],
  lte: ["<=", "at most", "maximum", "max", "no more than", "not more than", "up to", "is at most", "is no more than", "is not more than", "less than or equal to", "is less than or equal to", "fewer than or equal to"],
});

export type DateTag = "is" | "is_not" | "before" | "after" | "on_or_before" | "on_or_after" | "since" | "within";

export const DATE_OPS = lexicon<DateTag>({
  is: ["is", "on", "=", ":", "equals", "is on", "equal to", "is equal to"],
  is_not: ["is not", "isnt", "not", "not on", "is not on", "!=", "not equal to"],
  before: ["before", "<", "is before", "earlier than", "is earlier than", "prior to", "is prior to"],
  after: ["after", ">", "is after", "later than", "is later than", "not by", "not until", "not till"],
  on_or_before: ["on or before", "<=", "by", "no later than", "is on or before", "at or before", "is by", "until", "till", "through", "is no later than", "not after", "is not after"],
  on_or_after: ["on or after", ">=", "from", "no earlier than", "is on or after", "at or after", "starting", "not before", "is not before", "is no earlier than"],
  // Looks back only: a bare weekday after it is the one just gone.
  since: ["since"],
  within: ["within", "within the", "in", "in the", "during", "during the", "is within", "is within the", "is in", "is in the"],
});

export type SetTag = "eq" | "ne" | "contains" | "does_not_contain" | "any" | "none" | "all" | "exact";

/** Choice and people properties. */
export const SET_OPS = lexicon<SetTag>({
  eq: ["is", "=", ":", "equals", "equal to", "is equal to", "are"],
  ne: ["is not", "isnt", "not", "!=", "not equal to", "is not equal to", "isnt equal to", "are not", "arent"],
  contains: ["contains", "contain", "containing", "includes", "include", "including", "has", "have", "having", "with"],
  does_not_contain: ["doesnt contain", "does not contain", "dont contain", "do not contain", "not containing", "excludes", "exclude", "without", "lacks", "doesnt include", "does not include", "doesnt have", "does not have", "has no", "not contain"],
  any: ["is any of", "any of", "is one of", "one of", "are any of", "is in", "in"],
  none: ["is none of", "none of", "not in", "is not in", "is not one of", "is not any of", "not one of", "not any of", "isnt one of", "isnt any of"],
  all: ["has all of", "all of", "contains all of", "contains all", "has all", "includes all", "includes all of", "have all of"],
  exact: ["is exactly", "exactly", "only", "is only", "equals exactly"],
});

/** Whole phrases that mean the current person, with no property named. */
export const ME_PHRASES: ReadonlySet<string> = new Set(["me", "mine", "myself"]);
export const ME_WORDS: readonly string[] = ["me", "mine", "myself"];

/** Whole phrases for a checkbox with no property named. */
export const BARE_BOOLEAN = lexicon<BoolTag>({
  checked: ["checked", "ticked"],
  unchecked: ["unchecked", "unticked", "not checked", "not ticked"],
});
