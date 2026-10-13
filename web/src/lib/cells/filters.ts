/**
 * Filter operator tables per field type (mirror of og_core::query::filter_ops_for) and the
 * operand shapes the server accepts for each operator.
 */
import type { Condition, DateOperand, Field, Filter, FilterItem, FilterOp } from "@/api/types";
import { kindClassOf, type FieldKindClass } from "./kinds";

const TEXT: FilterOp[] = ["contains", "does_not_contain", "is", "is_not", "starts_with", "ends_with", "is_empty", "is_not_empty"];
const NUMBER: FilterOp[] = ["is", "is_not", "lt", "lte", "gt", "gte", "is_empty", "is_not_empty"];
const SELECT: FilterOp[] = ["is", "is_not", "is_any_of", "is_none_of", "is_empty", "is_not_empty"];
const MULTI: FilterOp[] = ["has_any_of", "has_all_of", "has_none_of", "is_exactly", "is_empty", "is_not_empty"];
const DATE: FilterOp[] = ["is", "is_not", "is_before", "is_after", "is_on_or_before", "is_on_or_after", "is_within", "is_empty", "is_not_empty"];
const ATTACHMENT: FilterOp[] = ["contains", "does_not_contain", "is_empty", "is_not_empty"];
const LINK: FilterOp[] = ["contains", "does_not_contain", "has_any_of", "has_all_of", "has_none_of", "is_exactly", "is_empty", "is_not_empty"];

const OPS_BY_CLASS: Record<FieldKindClass, readonly FilterOp[]> = {
  text: TEXT,
  number: NUMBER,
  bool: ["is"],
  select: SELECT,
  user: SELECT,
  multi_select: MULTI,
  user_multi: MULTI,
  date: DATE,
  attachment: ATTACHMENT,
  link: LINK,
  list: LINK,
  inert: [],
};

/** Operators available for a field; empty for buttons (not filterable). */
export function filterOpsFor(field: Field): FilterOp[] {
  return [...OPS_BY_CLASS[kindClassOf(field)]];
}

export function isFilterable(field: Field): boolean {
  return filterOpsFor(field).length > 0;
}

const BASE_LABELS: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  contains: "contains",
  does_not_contain: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  is_any_of: "is any of",
  is_none_of: "is none of",
  has_any_of: "has any of",
  has_all_of: "has all of",
  has_none_of: "has none of",
  is_exactly: "is exactly",
  is_before: "is before",
  is_after: "is after",
  is_on_or_before: "is on or before",
  is_on_or_after: "is on or after",
  is_within: "is within",
};

/** Label for an operator in the context of a field (numbers use =, ≠). */
export function opLabel(op: FilterOp, field?: Field): string {
  if (field && kindClassOf(field) === "number") {
    if (op === "is") return "=";
    if (op === "is_not") return "≠";
  }
  return BASE_LABELS[op];
}

export function opNeedsOperand(op: FilterOp): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

/** Which operand editor an operator needs for a field. */
export type OperandKind = "none" | "text" | "number" | "bool" | "choice_one" | "choice_many" | "user_one" | "user_many" | "record_many" | "text_list" | "date";

export function operandKindFor(field: Field, op: FilterOp): OperandKind {
  if (!opNeedsOperand(op)) return "none";
  switch (kindClassOf(field)) {
    case "text":
      return "text";
    case "number":
      return "number";
    case "bool":
      return "bool";
    case "select":
      return op === "is" || op === "is_not" ? "choice_one" : "choice_many";
    case "multi_select":
      return "choice_many";
    case "user":
      return op === "is" || op === "is_not" ? "user_one" : "user_many";
    case "user_multi":
      return "user_many";
    case "date":
      return "date";
    case "attachment":
      return "text";
    case "link":
      return op === "contains" || op === "does_not_contain" ? "text" : "record_many";
    case "list":
      return op === "contains" || op === "does_not_contain" ? "text" : "text_list";
    case "inert":
      return "none";
  }
}

/** Date operand modes available for an operator (`is_within` takes ranges; the rest take one day). */
export const SINGLE_DAY_MODES = [
  "today",
  "tomorrow",
  "yesterday",
  "one_week_ago",
  "one_week_from_now",
  "one_month_ago",
  "one_month_from_now",
  "number_of_days_ago",
  "number_of_days_from_now",
  "exact_date",
] as const;

export const RANGE_MODES = ["past_week", "past_month", "past_year", "next_week", "next_month", "next_year", "past_number_of_days", "next_number_of_days", "this_calendar_month", "this_calendar_year"] as const;

export type DateMode = DateOperand["mode"];

export const DATE_MODE_LABELS: Record<DateMode, string> = {
  today: "today",
  tomorrow: "tomorrow",
  yesterday: "yesterday",
  one_week_ago: "one week ago",
  one_week_from_now: "one week from now",
  one_month_ago: "one month ago",
  one_month_from_now: "one month from now",
  number_of_days_ago: "number of days ago",
  number_of_days_from_now: "number of days from now",
  exact_date: "exact date",
  past_week: "the past week",
  past_month: "the past month",
  past_year: "the past year",
  next_week: "the next week",
  next_month: "the next month",
  next_year: "the next year",
  past_number_of_days: "the past number of days",
  next_number_of_days: "the next number of days",
  this_calendar_month: "this calendar month",
  this_calendar_year: "this calendar year",
};

export function dateModesFor(op: FilterOp): readonly DateMode[] {
  return op === "is_within" ? RANGE_MODES : SINGLE_DAY_MODES;
}

export function modeHasDays(mode: DateMode): boolean {
  return mode === "number_of_days_ago" || mode === "number_of_days_from_now" || mode === "past_number_of_days" || mode === "next_number_of_days";
}

/** Build a date operand for a mode (days default to 1, exact date to `today`). */
export function makeDateOperand(mode: DateMode, extra?: { days?: number; date?: string }): DateOperand {
  switch (mode) {
    case "number_of_days_ago":
    case "number_of_days_from_now":
    case "past_number_of_days":
    case "next_number_of_days":
      return { mode, days: Math.max(0, Math.floor(extra?.days ?? 1)) };
    case "exact_date":
      return { mode, date: extra?.date ?? "" };
    default:
      return { mode } as DateOperand;
  }
}

/** The empty operand for an operator on a field. */
export function defaultOperand(field: Field, op: FilterOp): unknown {
  switch (operandKindFor(field, op)) {
    case "none":
      return null;
    case "text":
      return "";
    case "number":
      return "";
    case "bool":
      return true;
    case "choice_one":
    case "user_one":
      return "";
    case "choice_many":
    case "user_many":
    case "record_many":
    case "text_list":
      return [];
    case "date":
      return op === "is_within" ? makeDateOperand("past_week") : makeDateOperand("today");
  }
}

/** A fresh condition on `field` using its first operator. */
export function newCondition(field: Field): Condition {
  const op = filterOpsFor(field)[0] ?? "is";
  return { field_id: field.id, op, value: defaultOperand(field, op) as Condition["value"] };
}

/**
 * Condition after the user switches operator: keeps the operand when its shape is still valid,
 * otherwise resets it.
 */
export function withOp(cond: Condition, field: Field, op: FilterOp): Condition {
  const before = operandKindFor(field, cond.op);
  const after = operandKindFor(field, op);
  const keep = before === after && !(after === "date" && (cond.op === "is_within") !== (op === "is_within"));
  return { ...cond, op, value: (keep ? cond.value : defaultOperand(field, op)) as Condition["value"] };
}

/** Max nesting depth the server accepts (the top group is level 1). */
export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_CONDITIONS = 100;

export function isGroup(item: FilterItem): item is Filter {
  return "items" in item;
}

export function countConditions(filter: Filter | null | undefined): number {
  if (!filter) return 0;
  return filter.items.reduce((n, it) => n + (isGroup(it) ? countConditions(it) : 1), 0);
}

/** Whether a condition would be ignored by the server (empty operand on an operator that needs one). */
export function isIncomplete(cond: Condition, field: Field | undefined): boolean {
  if (!field) return true;
  const kind = operandKindFor(field, cond.op);
  if (kind === "none") return false;
  const v = cond.value;
  if (kind === "bool") return typeof v !== "boolean";
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (kind === "date" && typeof v === "object") return (v as DateOperand).mode === "exact_date" && !(v as { date?: string }).date;
  return false;
}

/** Drop conditions whose field no longer exists, and groups left empty. */
export function pruneFilter(filter: Filter, fieldIds: ReadonlySet<string>): Filter {
  const items: FilterItem[] = [];
  for (const it of filter.items) {
    if (isGroup(it)) {
      const g = pruneFilter(it, fieldIds);
      if (g.items.length > 0) items.push(g);
    } else if (fieldIds.has(it.field_id)) items.push(it);
  }
  return { ...filter, items };
}
