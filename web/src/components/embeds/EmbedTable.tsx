/**
 * The small read-only table both live embeds show (REC-6): a caption and an Open link above, then the records'
 * titles and their first three properties, and a footer for what the embed adds (the "+ Link" row, "Showing 10
 * of 14"). A row's title opens the record's page.
 *
 * The cells are the plain read-only values. They are drawn with no embeds alive and with links as chips, so a
 * record that is itself shown here, whose own Page embeds this table, does not open it again inside itself.
 */
import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import type { Field, Table, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { CompactLinksProvider, LinkedRecordsProvider, titleOf } from "@/components/record/linked/LinkedRecords";
import { Button } from "@/components/ui/button";
import type { FormatCtx } from "@/lib/cells/format";
import { cn } from "@/lib/cn";
import { recordPath } from "@/lib/recordPath";
import { EmbedHostProvider } from "./host";

/** A cell, with the borders, padding and widths the page's table styles would otherwise give it taken off. */
const CELL = "min-w-0 border-0 bg-transparent px-3 py-0 align-middle";

export interface EmbedTableProps {
  /** The collection of the records. */
  table: Table;
  baseId: string;
  /** The view the records are listed from, so the page opened from a row goes through the same records. */
  viewId?: string;
  /** The title property is always the first column; these are the others, at most three. */
  fields: readonly Field[];
  records: readonly TableRecord[];
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  /** What the table is: "Invoices · linked to this client, 2". */
  caption: ReactNode;
  /** The Open link: where it goes, what it says, and what is done before it is followed. */
  open?: { to: string; label: string; onFollow?: () => void };
  /** Said when there are no records. */
  empty: string;
  /** Under the rows. */
  footer?: ReactNode;
  /** After the Open link (the editor's Remove button). */
  trailing?: ReactNode;
}

export function EmbedTable({ table, baseId, viewId, fields, records, format, emails, caption, open, empty, footer, trailing }: EmbedTableProps) {
  const captionId = useId();
  const primary = table.fields.find((f) => f.id === table.primary_field_id);
  return (
    <section aria-labelledby={captionId} className="ob-embed my-3 overflow-hidden rounded-lg border border-line bg-surface text-ui">
      <div className="flex min-h-control-md items-center justify-between gap-3 border-b border-line px-3 py-1 max-md:min-h-control-touch">
        <p id={captionId} className="min-w-0 truncate text-label font-semibold text-muted">
          {caption}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {open && (
            <Button asChild variant="ghost" size="sm" className="no-underline">
              <Link to={open.to} onClick={open.onFollow}>
                {open.label}
              </Link>
            </Button>
          )}
          {trailing}
        </div>
      </div>
      <EmbedHostProvider value={null}>
        {/* Linked records in the cells are plain chips: the row's title is what opens a record. */}
        <LinkedRecordsProvider value={{}}>
          <CompactLinksProvider value>
            {records.length === 0 ? (
              <p className="px-3 py-3 text-label text-muted">{empty}</p>
            ) : (
              <div className="overflow-x-auto overscroll-x-contain">
                {/* The page's own table styles (`ob-prose`) are for tables people write; this one is drawn here. */}
                <table className="table w-full min-w-max border-collapse text-left">
                  <thead>
                    <tr className="text-label text-muted">
                      <th scope="col" className={cn(CELL, "h-8 font-medium")}>
                        {primary?.name ?? "Name"}
                      </th>
                      {fields.map((f) => (
                        <th key={f.id} scope="col" className={cn(CELL, "h-8 font-medium")}>
                          {f.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-t border-line hover:bg-hover">
                        <td className={cn(CELL, "max-w-72 px-0")}>
                          {/* The whole cell is the target: 46 px, 44 on a phone. */}
                          <Link to={recordPath(baseId, table.id, r.id, viewId)} className="flex h-row-table items-center px-3 font-medium text-fg no-underline underline-offset-2 hover:underline focus-visible:underline max-md:h-control-touch">
                            <span className="truncate">{titleOf(table, r, "", format)}</span>
                          </Link>
                        </td>
                        {fields.map((f) => (
                          <td key={f.id} className={cn(CELL, "h-row-table max-w-56 text-label max-md:h-control-touch [&_a]:no-underline [&_p]:truncate")}>
                            <CellValue field={f} value={r.values[f.id] ?? null} format={format} emails={emails} markdown={false} className="truncate" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CompactLinksProvider>
        </LinkedRecordsProvider>
      </EmbedHostProvider>
      {footer}
    </section>
  );
}
