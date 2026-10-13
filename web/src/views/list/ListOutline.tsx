/**
 * The list view's body: a collapsible outline. Group headers show their label and record count
 * and offer an add button that pre-fills the group's values; records are compact rows with the
 * title and a few non-empty fields.
 */
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { Field, GroupHeader, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { cn } from "@/lib/cn";
import type { FormatCtx } from "@/lib/cells/format";
import { swatchColor } from "@/lib/cells/palette";
import { cardTitle, fieldsToShow } from "../common/cardFields";
import { buildOutline, flattenOutline, groupDefaults, type GroupNode } from "./outline";

/** Rows rendered per group before "Show more" (a group can hold thousands). */
export const ROWS_PER_GROUP = 200;
/** Fields shown beside the title in a row. */
export const ROW_FIELDS = 3;

export interface ListOutlineProps {
  records: readonly TableRecord[];
  groups: readonly GroupHeader[];
  primary: Field | undefined;
  fields: readonly Field[];
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  colors: Readonly<Record<string, string>>;
  collapsed: ReadonlySet<string>;
  canEdit: boolean;
  onToggle(path: string): void;
  onOpen(recordId: string): void;
  /** Add a record starting with these field values (a group's values; empty when ungrouped). */
  onAdd(defaults: Record<string, unknown>): void;
}

function Row({ record, p }: { record: TableRecord; p: ListOutlineProps }) {
  const shown = fieldsToShow(p.fields, record, p.format, ROW_FIELDS);
  const color = p.colors[record.id];
  const open = () => p.onOpen(record.id);
  return (
    <div
      role="button"
      tabIndex={0}
      data-record-id={record.id}
      aria-label={cardTitle(p.primary, record, p.format)}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a")) open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="relative flex min-h-9 cursor-pointer flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-line py-1.5 pl-4 pr-3 outline-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 w-1" style={{ background: swatchColor(color) }} />}
      <span className="w-full min-w-0 truncate text-[0.8125rem] font-medium sm:w-72 sm:shrink-0">{cardTitle(p.primary, record, p.format)}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5">
        {shown.map((f) => (
          <span key={f.id} className="flex min-w-0 max-w-64 items-center gap-1.5 text-xs">
            <span className="shrink-0 text-faint">{f.name}</span>
            <CellValue field={f} value={record.values[f.id] ?? null} format={p.format} emails={p.emails} className="truncate text-xs" markdown={false} />
          </span>
        ))}
      </span>
    </div>
  );
}

function Records({ node, p }: { node: GroupNode | null; p: ListOutlineProps }) {
  const [limit, setLimit] = useState(ROWS_PER_GROUP);
  const start = node?.start ?? 0;
  const count = node?.count ?? p.records.length;
  const slice = p.records.slice(start, start + Math.min(count, limit));
  return (
    <>
      {slice.map((r) => (
        <Row key={r.id} record={r} p={p} />
      ))}
      {count > limit && (
        <button type="button" onClick={() => setLimit((l) => l + ROWS_PER_GROUP)} className="w-full border-b border-line py-1.5 text-xs text-muted hover:bg-hover">
          Show {Math.min(ROWS_PER_GROUP, count - limit)} more ({count - limit} hidden)
        </button>
      )}
      {count === 0 && <p className="border-b border-line py-2 pl-4 text-xs text-faint">No records</p>}
    </>
  );
}

export function ListOutline(p: ListOutlineProps) {
  if (p.groups.length === 0) {
    return (
      <div role="list" aria-label="Records">
        <Records node={null} p={p} />
      </div>
    );
  }
  const rows = flattenOutline(buildOutline(p.groups), p.collapsed);
  return (
    <div role="tree" aria-label="Grouped records">
      {rows.map((row) =>
        row.kind === "group" ? (
          <div
            key={`g:${row.node.path}`}
            role="treeitem"
            aria-expanded={!row.collapsed}
            aria-level={row.depth + 1}
            data-group={row.node.path}
            className="group/header flex items-center gap-1 border-b border-line bg-subtle pr-2 text-[0.8125rem]"
            style={{ paddingLeft: 8 + row.depth * 20 }}
          >
            <button type="button" onClick={() => p.onToggle(row.node.path)} className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 text-left font-semibold" aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.node.header.label}`}>
              <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform", row.collapsed && "-rotate-90")} />
              <span className="truncate">{row.node.header.label}</span>
              <span className="ml-1 rounded-full bg-hover px-1.5 text-xs font-normal tabular-nums text-muted" aria-label={`${row.node.count} records`}>
                {row.node.count}
              </span>
            </button>
            {p.canEdit && (
              <button
                type="button"
                aria-label={`Add record to ${row.node.header.label}`}
                onClick={() => p.onAdd(groupDefaults(row.node))}
                className="inline-flex size-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
              >
                <Plus aria-hidden className="size-4" />
              </button>
            )}
          </div>
        ) : (
          <div key={`r:${row.node.path}`} role="group" style={{ paddingLeft: Math.max(0, row.depth - 1) * 20 }}>
            <Records node={row.node} p={p} />
          </div>
        ),
      )}
    </div>
  );
}
