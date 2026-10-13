/** Summary-bar aggregations: which are valid per field type (mirror of query::aggregations_for) and how to show them. */
import type { Aggregation, Field } from "@/api/types";
import { formatStoredDate } from "./dates";
import { dateOptionsOf, kindClassOf } from "./kinds";
import { formatGeneralNumber, formatNumber, numberFormatOf, toNumber, type FormatCtx } from "./format";

/**
 * Aggregations offered for a field: counts for every filterable type, unique counts (not
 * attachments), numeric statistics for numbers, date statistics for dates and checked counts
 * for checkboxes. Always starts with `none`.
 */
export function aggregationsFor(field: Field): Aggregation[] {
  const out: Aggregation[] = ["none"];
  const kind = kindClassOf(field);
  if (kind === "inert") return out;
  if (kind === "bool") {
    out.push("checked", "unchecked", "percent_checked", "percent_unchecked");
    return out;
  }
  out.push("empty", "filled", "percent_empty", "percent_filled");
  if (kind !== "attachment") out.push("unique", "percent_unique");
  if (kind === "number") out.push("sum", "average", "median", "min", "max", "range", "std_dev");
  if (kind === "date") out.push("earliest_date", "latest_date", "date_range_days");
  return out;
}

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  none: "None",
  empty: "Empty",
  filled: "Filled",
  unique: "Unique",
  percent_empty: "Percent empty",
  percent_filled: "Percent filled",
  percent_unique: "Percent unique",
  sum: "Sum",
  average: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  std_dev: "Standard deviation",
  checked: "Checked",
  unchecked: "Unchecked",
  percent_checked: "Percent checked",
  percent_unchecked: "Percent unchecked",
  earliest_date: "Earliest date",
  latest_date: "Latest date",
  date_range_days: "Date range (days)",
};

/** Short label drawn in the summary cell, e.g. "Sum". */
export function aggregationShortLabel(a: Aggregation): string {
  switch (a) {
    case "std_dev":
      return "Std dev";
    case "percent_empty":
      return "% empty";
    case "percent_filled":
      return "% filled";
    case "percent_unique":
      return "% unique";
    case "percent_checked":
      return "% checked";
    case "percent_unchecked":
      return "% unchecked";
    case "earliest_date":
      return "Earliest";
    case "latest_date":
      return "Latest";
    case "date_range_days":
      return "Range";
    default:
      return AGGREGATION_LABELS[a];
  }
}

/** Text of an aggregated value as the summary bar shows it. */
export function formatAggregate(field: Field, agg: Aggregation, value: unknown, ctx: FormatCtx): string {
  if (agg === "none" || value === null || value === undefined) return "";
  if (agg === "earliest_date" || agg === "latest_date") {
    const opts = dateOptionsOf(field);
    return opts ? formatStoredDate(value, opts, ctx.timeZone) : String(value);
  }
  const n = toNumber(value);
  if (n === null) return "";
  switch (agg) {
    case "percent_empty":
    case "percent_filled":
    case "percent_unique":
    case "percent_checked":
    case "percent_unchecked":
      return formatNumber(n, { kind: "percent", precision: 0 });
    case "sum":
    case "average":
    case "median":
    case "min":
    case "max":
    case "range":
    case "std_dev": {
      const fmt = numberFormatOf(field);
      // Averages and deviations of integer-like fields keep their fraction.
      if (fmt.kind === "integer" || fmt.kind === "general") return formatGeneralNumber(Math.round(n * 1e6) / 1e6);
      return formatNumber(n, fmt);
    }
    case "date_range_days":
      return `${formatGeneralNumber(n)} days`;
    default:
      return formatGeneralNumber(n);
  }
}
