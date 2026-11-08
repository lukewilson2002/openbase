/**
 * How a view's filter is drawn in the filter bar (COL-3): a filter that is a plain list of conditions
 * joined by AND is one chip per condition; one that uses OR, or has a group inside it, is a single
 * "Advanced filter, 3 conditions" chip that opens the builder. These are the pure rules for reading a filter
 * as chips and for changing it by chip, so the bar and its tests share them.
 */
import type { Condition, Filter, FilterItem } from "@/api/types";
import { MAX_FILTER_CONDITIONS, countConditions, isGroup } from "@/lib/cells/filters";

export type ChipModel = { kind: "condition"; index: number; condition: Condition } | { kind: "advanced"; count: number };

/** Whether the filter is conditions joined by AND, with no group inside: the shape the chips can show one by one. */
export function isFlat(filter: Filter | null | undefined): boolean {
  if (!filter || filter.items.length === 0) return false;
  // One condition on its own has no joiner to disagree with.
  if (filter.conjunction === "or" && filter.items.length > 1) return false;
  return filter.items.every((it) => !isGroup(it));
}

/** The chips for a filter, in order. */
export function chipsOf(filter: Filter | null | undefined): ChipModel[] {
  if (!filter || filter.items.length === 0) return [];
  if (!isFlat(filter)) return [{ kind: "advanced", count: countConditions(filter) }];
  return filter.items.map((it, index) => ({ kind: "condition", index, condition: it as Condition }));
}

/** "Advanced filter, 3 conditions". */
export function advancedLabel(count: number): string {
  return `Advanced filter, ${count} ${count === 1 ? "condition" : "conditions"}`;
}

const sameCondition = (a: FilterItem, b: Condition): boolean => !isGroup(a) && a.field_id === b.field_id && a.op === b.op && JSON.stringify(a.value) === JSON.stringify(b.value);

/**
 * The filter with `condition` added, combined with the rest by AND. Adding what is already there changes
 * nothing. Over an OR filter the whole of it becomes one side of the AND, so what it said still holds.
 * Null when the limit on conditions would be passed.
 */
export function addCondition(filter: Filter | null | undefined, condition: Condition): Filter | null {
  if (!filter || filter.items.length === 0) return { conjunction: "and", items: [condition] };
  if (filter.items.some((it) => sameCondition(it, condition))) return filter;
  if (countConditions(filter) >= MAX_FILTER_CONDITIONS) return null;
  if (filter.conjunction === "and" || filter.items.length === 1) return { ...filter, conjunction: "and", items: [...filter.items, condition] };
  return { conjunction: "and", items: [filter, condition] };
}

/** The filter with the condition at `index` replaced, which only a flat filter has chips for. */
export function replaceCondition(filter: Filter, index: number, condition: Condition): Filter {
  return { ...filter, items: filter.items.map((it, i) => (i === index ? condition : it)) };
}

/** The filter without the condition at `index`; null when nothing is left. */
export function removeCondition(filter: Filter, index: number): Filter | null {
  const items = filter.items.filter((_, i) => i !== index);
  return items.length === 0 ? null : { ...filter, items };
}
