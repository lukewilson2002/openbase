import type { DateOptions, Field } from "@/api/types";
import { dateOptionsOf } from "@/lib/cells/kinds";

/** The start (and optional end) date fields of a calendar or timeline, with their date options. */
export interface DateFields {
  start: { field: Field; opts: DateOptions };
  end: { field: Field; opts: DateOptions } | null;
}

/** Resolve configured field ids; null until the start field names a date-valued field. */
export function resolveDateFields(fields: readonly Field[], startId: string | null | undefined, endId: string | null | undefined): DateFields | null {
  const start = fields.find((f) => f.id === startId);
  const startOpts = start && dateOptionsOf(start);
  if (!start || !startOpts) return null;
  const end = endId && endId !== start.id ? fields.find((f) => f.id === endId) : undefined;
  const endOpts = end && dateOptionsOf(end);
  return { start: { field: start, opts: startOpts }, end: end && endOpts ? { field: end, opts: endOpts } : null };
}
