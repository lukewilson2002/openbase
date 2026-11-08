/**
 * The words View options shows beside each of its rows (COL-6): what the sort, grouping, color and
 * properties currently are, so a row says its state without opening. Pure, so the wording is tested.
 */
import type { DateGranularity, Field, Group, RowColor, Table, ViewConfig } from "@/api/types";
import { kindClassOf } from "@/lib/cells/kinds";
import { resolveFieldOrder } from "./config";

const NONE = "None";

/** "soonest" for a date sorted ascending: the order read as a person would say it. */
function directionWords(field: Field | undefined, direction: Group["direction"]): string {
  const asc = direction === "asc";
  switch (field ? kindClassOf(field) : "text") {
    case "number":
      return asc ? "lowest first" : "highest first";
    case "date":
      return asc ? "soonest" : "latest";
    case "bool":
      return asc ? "unchecked first" : "checked first";
    default:
      return asc ? "A to Z" : "Z to A";
  }
}

const GRANULARITY_WORDS: Record<DateGranularity, string> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };

const more = (count: number) => (count > 1 ? `, and ${count - 1} more` : "");

/** "Next follow-up, soonest", "Status, A to Z, and 1 more", or "None". */
export function sortSummary(fields: readonly Field[], sorts: readonly Group[]): string {
  const first = sorts[0];
  if (!first) return NONE;
  const field = fields.find((f) => f.id === first.field_id);
  return `${field?.name ?? "Deleted property"}, ${directionWords(field, first.direction)}${more(sorts.length)}`;
}

/** "By Status", "By Due, month", "By Status, and 1 more", or "None". */
export function groupSummary(fields: readonly Field[], groups: readonly Group[]): string {
  const first = groups[0];
  if (!first) return NONE;
  const field = fields.find((f) => f.id === first.field_id);
  const by = first.granularity && field && kindClassOf(field) === "date" ? `, ${GRANULARITY_WORDS[first.granularity]}` : "";
  return `By ${field?.name ?? "deleted property"}${by}${more(groups.length)}`;
}

/** "By Status", "By conditions" or "None". */
export function colorSummary(fields: readonly Field[], rowColor: RowColor | null | undefined): string {
  if (!rowColor) return NONE;
  if (rowColor.mode === "by_select") return `By ${fields.find((f) => f.id === rowColor.field_id)?.name ?? "a property"}`;
  return rowColor.rules.length > 0 ? "By conditions" : NONE;
}

/** "4 shown, 1 hidden", or "5 shown" when nothing is hidden. The title property is always shown. */
export function propertiesSummary(table: Pick<Table, "fields" | "primary_field_id">, config: Pick<ViewConfig, "field_order" | "hidden_fields">): string {
  const { visible, hidden } = resolveFieldOrder(table, config);
  return hidden.length > 0 ? `${visible.length} shown, ${hidden.length} hidden` : `${visible.length} shown`;
}
