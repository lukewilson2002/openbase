/**
 * The open table as the last part of the top bar's breadcrumb: its name, bold and in the accent
 * colour, with no icon (the table's menu in the sidebar changes its icon).
 */
import type { Table } from "@/api/types";
import { cn } from "@/lib/cn";

/** Each part of the desktop path (workspace, project, table): the same type, without icons. */
export const CRUMB_TEXT = "text-[0.875rem] font-normal text-fg";
/** The last part, what is open (the table, else the project): the only bold one, in the accent colour. */
export const CRUMB_OPEN = "font-semibold text-primary-text";

export function TableCrumb({ table }: { table: Table }) {
  return (
    <h2 className={cn("flex min-w-0 items-center", CRUMB_TEXT, CRUMB_OPEN)}>
      <span className="min-w-0 truncate">{table.name}</span>
    </h2>
  );
}
