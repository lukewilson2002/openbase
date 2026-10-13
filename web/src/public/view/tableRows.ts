/**
 * Rows of a shared table page: the records, with group header rows in between.
 *
 * The server lists *every* group header on *every* page, with `start` and `count` relative to the
 * whole result. A page shows the headers that start inside it, and, when it opens in the middle of
 * a group, that group's headers again, marked "continued", so no row is ever without its context.
 */
import type { GroupHeader, TableRecord } from "@/api/types";

export type TableRow = { kind: "group"; header: GroupHeader; continued: boolean } | { kind: "record"; record: TableRecord };

export function layoutRows(records: readonly TableRecord[], offset: number, groups: readonly GroupHeader[]): TableRow[] {
  const rows: TableRow[] = [];
  if (records.length > 0) {
    for (const header of groups) {
      if (header.start < offset && header.start + header.count > offset) rows.push({ kind: "group", header, continued: true });
    }
  }
  records.forEach((record, i) => {
    const at = offset + i;
    for (const header of groups) if (header.start === at) rows.push({ kind: "group", header, continued: false });
    rows.push({ kind: "record", record });
  });
  return rows;
}
