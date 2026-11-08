/**
 * The name Save as view suggests: the changes in plain words, as the filter chips read them
 * ("Proposal sent, follow-up this week"). A pure function, so the same draft always gets the same name.
 */
import type { Condition, DateOperand, Field, Filter, ViewConfig, ViewType } from "@/api/types";
import { DATE_MODE_LABELS, opLabel } from "@/lib/cells/filters";
import { kindClassOf, selectChoicesOf } from "@/lib/cells/kinds";
import { VIEW_TYPE_META } from "@/views/meta";

const MAX_NAME = 80;

function choiceNames(field: Field, ids: readonly string[]): string[] {
  const choices = selectChoicesOf(field);
  return ids.map((id) => choices.find((c) => c.id === id)?.name ?? "").filter(Boolean);
}

function dateText(v: unknown): string | null {
  const operand = v as Partial<DateOperand> | null;
  if (!operand || typeof operand !== "object" || !operand.mode) return null;
  const mode = operand.mode;
  if (mode === "exact_date") return "date" in operand && operand.date ? String(operand.date) : null;
  const label = DATE_MODE_LABELS[mode];
  if (!label) return null;
  return "days" in operand && typeof operand.days === "number" ? label.replace("number of days", `${operand.days} days`) : label;
}

/** One condition as a short phrase: a choice by its name, a date range by its words, the rest as "Property is value". */
export function conditionPhrase(c: Condition, fields: readonly Field[]): string {
  const field = fields.find((f) => f.id === c.field_id);
  if (!field) return "";
  if (c.op === "is_empty") return `no ${field.name}`;
  if (c.op === "is_not_empty") return `has ${field.name}`;
  // A condition still being written has no value yet: it says nothing.
  if (c.value === "" || c.value === null || c.value === undefined || (Array.isArray(c.value) && c.value.length === 0)) return "";
  const ids = Array.isArray(c.value) ? c.value.map(String) : typeof c.value === "string" && c.value ? [c.value] : [];
  const kind = kindClassOf(field);
  if (kind === "select" || kind === "multi_select") {
    const names = choiceNames(field, ids);
    if (names.length > 0) return `${c.op === "is_not" || c.op === "is_none_of" || c.op === "has_none_of" ? "not " : ""}${names.join(" or ")}`;
  }
  if (kind === "date") {
    const when = dateText(c.value);
    return when ? (c.op === "is" || c.op === "is_within" ? `${field.name} ${when}` : `${field.name} ${opLabel(c.op, field)} ${when}`) : field.name;
  }
  if (typeof c.value === "boolean") return c.value ? field.name : `not ${field.name}`;
  if (typeof c.value === "string" || typeof c.value === "number") return `${field.name} ${opLabel(c.op, field)} ${c.value}`;
  return field.name;
}

function filterPhrases(filter: Filter | null | undefined, fields: readonly Field[]): string[] {
  const out: string[] = [];
  for (const item of filter?.items ?? []) {
    if ("items" in item) out.push(...filterPhrases(item, fields));
    else {
      const phrase = conditionPhrase(item, fields);
      if (phrase) out.push(phrase);
    }
  }
  return out;
}

function listOf(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export interface NameInput {
  config: Pick<ViewConfig, "filter" | "sorts" | "groups">;
  fields: readonly Field[];
  layout: ViewType;
  /** The layout the view being changed has. */
  savedLayout: ViewType;
  /** The name of the view being changed, the last resort. */
  viewName: string;
}

/** The suggested name: the filter chips, else the sort or the grouping, else the layout, else the view's name. */
export function suggestViewName({ config, fields, layout, savedLayout, viewName }: NameInput): string {
  const chips = filterPhrases(config.filter, fields);
  let name = "";
  if (chips.length > 0) name = chips.join(", ");
  else {
    const named = (list: readonly { field_id: string }[]) => list.map((s) => fields.find((f) => f.id === s.field_id)?.name).filter((n): n is string => !!n);
    const sorts = named(config.sorts);
    const groups = named(config.groups);
    if (groups.length > 0) name = `By ${listOf(groups)}`;
    else if (sorts.length > 0) name = `Sorted by ${listOf(sorts)}`;
    else if (layout !== savedLayout) name = VIEW_TYPE_META[layout].defaultName;
    else name = `${viewName} copy`;
  }
  const trimmed = name.charAt(0).toUpperCase() + name.slice(1);
  return trimmed.length > MAX_NAME ? `${trimmed.slice(0, MAX_NAME - 1).trimEnd()}…` : trimmed;
}
