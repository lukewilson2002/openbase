/**
 * A condition in words, for the chip it becomes ("Next follow-up is this week"). The same words the
 * suggestions use, so applying a suggestion does not change how the filter reads; but this works from the
 * condition alone, so it also reads a filter that was saved, built by hand or made by someone else.
 */
import type { Collaborator, Condition, DateOperand, Field } from "@/api/types";
import { zonedParts } from "@/lib/cells/dates";
import { opNeedsOperand, operandKindFor } from "@/lib/cells/filters";
import { displayText } from "@/lib/cells/format";
import { selectChoicesOf } from "@/lib/cells/kinds";
import type { LabelPart } from "./index";
import { ME, dayLabel, numberLabel } from "./values";
import { OP_TEXT } from "./words";

/** Shown where a condition has no value yet, or one that no longer exists. */
const UNSET = "…";

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** A date operand as a label reads it: "today", "this week", "Nov 14", "next 7 days". */
export function dateOperandLabel(operand: DateOperand, thisYear: number): string {
  switch (operand.mode) {
    case "today":
    case "tomorrow":
    case "yesterday":
      return operand.mode;
    case "one_week_ago":
      return "a week ago";
    case "one_week_from_now":
      return "in a week";
    case "one_month_ago":
      return "a month ago";
    case "one_month_from_now":
      return "in a month";
    case "number_of_days_ago":
      return `${days(operand.days)} ago`;
    case "number_of_days_from_now":
      return `in ${days(operand.days)}`;
    case "exact_date":
      return /^\d{4}-\d{2}-\d{2}$/.test(operand.date) ? dayLabel(operand.date, thisYear) : UNSET;
    case "past_week":
    case "past_month":
    case "past_year":
      return `past ${operand.mode.slice(5)}`;
    case "next_week":
    case "next_month":
    case "next_year":
      return `the next ${operand.mode.slice(5)}`;
    case "past_number_of_days":
      return `past ${days(operand.days)}`;
    case "next_number_of_days":
      return `next ${days(operand.days)}`;
    case "this_calendar_week":
      return "this week";
    case "next_calendar_week":
      return "next week";
    case "last_calendar_week":
      return "last week";
    case "this_calendar_month":
      return "this month";
    case "next_calendar_month":
      return "next month";
    case "last_calendar_month":
      return "last month";
    case "this_calendar_year":
      return "this year";
  }
}

export interface DescribeContext {
  collaborators?: readonly Pick<Collaborator, "id" | "name">[];
  /** The zone and moment that decide which year a spelled-out day is in. */
  timeZone?: string;
  now?: Date | number;
}

function valueText(field: Field, cond: Condition, ctx: DescribeContext): string {
  const v = cond.value;
  switch (operandKindFor(field, cond.op)) {
    case "none":
      return "";
    case "bool":
      return typeof v === "boolean" ? (v ? "checked" : "unchecked") : UNSET;
    case "date": {
      if (!v || typeof v !== "object" || Array.isArray(v) || !("mode" in v)) return UNSET;
      const now = ctx.now ?? Date.now();
      const thisYear = zonedParts(typeof now === "number" ? now : now.getTime(), ctx.timeZone ?? "UTC").y;
      return dateOperandLabel(v as unknown as DateOperand, thisYear);
    }
    case "choice_one":
    case "choice_many": {
      const ids = Array.isArray(v) ? v : [v];
      const choices = selectChoicesOf(field);
      const names = ids.map((id) => choices.find((c) => c.id === id)?.name).filter((n): n is string => !!n);
      return names.length > 0 ? names.join(", ") : UNSET;
    }
    case "user_one":
    case "user_many": {
      const ids = (Array.isArray(v) ? v : [v]).filter((id): id is string => typeof id === "string" && id !== "");
      const names = ids.map((id) => (id === ME ? "me" : (ctx.collaborators?.find((c) => c.id === id)?.name ?? "someone")));
      return names.length > 0 ? names.join(", ") : UNSET;
    }
    case "record_many": {
      const n = Array.isArray(v) ? v.length : 0;
      return n === 0 ? UNSET : `${n} linked ${n === 1 ? "record" : "records"}`;
    }
    case "text_list":
      return Array.isArray(v) && v.length > 0 ? v.join(", ") : UNSET;
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return typeof v === "string" && v.trim() !== "" ? v : UNSET;
      return field.type === "duration" ? displayText(field, v) : numberLabel(field, v, String(v));
    }
    case "text":
      return typeof v === "string" && v !== "" ? v : UNSET;
  }
}

/** The condition as label parts: the property and the value are the ones a suggestion draws in bold. */
export function describeCondition(cond: Condition, fields: readonly Field[], ctx: DescribeContext = {}): LabelPart[] {
  const field = fields.find((f) => f.id === cond.field_id);
  const parts: LabelPart[] = [
    { role: "property", text: field?.name ?? "Deleted property" },
    { role: "operator", text: OP_TEXT[cond.op] },
  ];
  if (field && opNeedsOperand(cond.op)) {
    const value = valueText(field, cond, ctx);
    if (value) parts.push({ role: "value", text: value });
  }
  return parts;
}

/** The condition as one line: "Next follow-up is this week". */
export function conditionLabel(cond: Condition, fields: readonly Field[], ctx: DescribeContext = {}): string {
  return describeCondition(cond, fields, ctx)
    .map((p) => p.text)
    .join(" ");
}
