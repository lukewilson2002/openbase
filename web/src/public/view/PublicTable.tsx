/**
 * A shared grid or list: a clean read-only table. The first column sticks while scrolling
 * sideways, headers sort on click (a per-visitor override, nothing is saved), groups of the view
 * get their header rows, and row colours show as a stripe. No editing, selection or hidden
 * data: it shows exactly the fields the server sent.
 */
import { memo, useMemo } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { Field, GroupHeader, Sort, TableRecord } from "@/api/types";
import { FieldTypeIcon } from "@/components/ui/field-type-icon";
import { cn } from "@/lib/cn";
import { isSortable } from "@/components/viewbar/config";
import { paletteColor } from "@/lib/cells/palette";
import { PublicCell } from "./PublicCell";
import { layoutRows } from "./tableRows";

const DEFAULT_WIDTH = 180;

export interface PublicTableProps {
  fields: readonly Field[];
  widths: Readonly<Record<string, number>>;
  records: readonly TableRecord[];
  offset: number;
  groups: readonly GroupHeader[];
  colors: Readonly<Record<string, string>>;
  sort: Sort | null;
  onSort(next: Sort | null): void;
  loading: boolean;
}

/** Click cycle: ascending, descending, back to the view's own order. */
export function nextSort(current: Sort | null, fieldId: string): Sort | null {
  if (current?.field_id !== fieldId) return { field_id: fieldId, direction: "asc" };
  return current.direction === "asc" ? { field_id: fieldId, direction: "desc" } : null;
}

const Row = memo(function Row({ record, fields, widths, color }: { record: TableRecord; fields: readonly Field[]; widths: Readonly<Record<string, number>>; color?: string }) {
  return (
    <tr className="border-b border-line align-top hover:bg-hover/50" data-record-id={record.id}>
      {fields.map((f, i) => (
        <td
          key={f.id}
          className={cn("overflow-hidden px-2.5 py-1.5", i === 0 && "sticky left-0 z-[1] border-r border-line bg-surface font-medium")}
          style={{ width: widths[f.id] ?? DEFAULT_WIDTH, maxWidth: widths[f.id] ?? DEFAULT_WIDTH, ...(i === 0 && color ? { boxShadow: `inset 4px 0 0 ${paletteColor(color).bg}` } : {}) }}
        >
          <PublicCell field={f} value={record.values[f.id] ?? null} compact className="line-clamp-4 text-[0.8125rem]" markdown={false} />
        </td>
      ))}
    </tr>
  );
});

export function PublicTable({ fields, widths, records, offset, groups, colors, sort, onSort, loading }: PublicTableProps) {
  const rows = useMemo(() => layoutRows(records, offset, groups), [records, offset, groups]);
  const fieldName = new Map(fields.map((f) => [f.id, f.name] as const));
  return (
    <div className={cn("overflow-auto rounded-lg border border-line bg-surface", loading && "opacity-70")}>
      <table className="w-max min-w-full border-collapse text-left text-[0.8125rem]" aria-label="Records">
        <thead className="sticky top-0 z-[2] bg-subtle">
          <tr>
            {fields.map((f, i) => {
              const active = sort?.field_id === f.id ? sort.direction : null;
              const Icon = active === "asc" ? ArrowUp : active === "desc" ? ArrowDown : ChevronsUpDown;
              return (
                <th
                  key={f.id}
                  scope="col"
                  aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
                  className={cn("border-b border-line px-2.5 py-1.5 font-medium", i === 0 && "sticky left-0 z-[3] border-r bg-subtle")}
                  style={{ width: widths[f.id] ?? DEFAULT_WIDTH, minWidth: widths[f.id] ?? DEFAULT_WIDTH }}
                >
                  {isSortable(f) ? (
                    <button type="button" onClick={() => onSort(nextSort(sort, f.id))} className="flex w-full items-center gap-1.5 text-left hover:text-primary" title={`Sort by ${f.name}`}>
                      <FieldTypeIcon type={f.type} />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <Icon aria-hidden className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-faint")} />
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <FieldTypeIcon type={f.type} />
                      <span className="truncate">{f.name}</span>
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === "group" ? (
              <tr key={`g${row.header.depth}:${row.header.key}:${row.header.start}:${row.continued ? "c" : ""}`} className="border-b border-line bg-subtle/70">
                <td colSpan={fields.length} className="px-2.5 py-1.5 text-[0.8125rem] font-semibold" style={{ paddingLeft: 10 + row.header.depth * 18 }}>
                  <span className="mr-1.5 font-normal text-muted">{fieldName.get(row.header.field_id) ?? "Group"}:</span>
                  {row.header.label}
                  <span className="ml-2 font-normal text-muted">
                    {row.header.count} record{row.header.count === 1 ? "" : "s"}
                    {row.continued ? " (continued)" : ""}
                  </span>
                </td>
              </tr>
            ) : (
              <Row key={row.record.id} record={row.record} fields={fields} widths={widths} color={colors[row.record.id]} />
            ),
          )}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={Math.max(fields.length, 1)} className="px-3 py-10 text-center text-muted">
                No records to show.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
