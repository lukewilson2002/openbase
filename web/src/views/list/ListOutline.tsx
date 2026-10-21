/**
 * The list view's body: a collapsible outline. Group headers are grey bars that fold their group
 * (with the person's face for a person field, the choice's dot for a select) and say how many
 * records they hold; each group ends with an "Add" that pre-fills the group's values. Records are
 * compact rows: the title (with the view's description under it, when it has one), then select
 * values as pills and other values as "Label value".
 */
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { Field, GroupHeader, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { accentHue } from "@/lib/colors";
import type { FormatCtx } from "@/lib/cells/format";
import { displayShapeOf, selectChoicesOf } from "@/lib/cells/kinds";
import { swatchColor } from "@/lib/cells/palette";
import { cardTitle, descriptionText, fieldsToShow } from "../common/cardFields";
import { DescriptionHover } from "../common/description";
import { buildOutline, flattenOutline, groupDefaults, type GroupNode } from "./outline";

/** Rows rendered per group before "Show more" (a group can hold thousands). */
export const ROWS_PER_GROUP = 200;
/** Indent of one outline level, and of records under their group's chevron. */
const LEVEL_PX = 20;
const ROW_PAD = 16;
const UNDER_CHEVRON = 30;

export interface ListOutlineProps {
  records: readonly TableRecord[];
  groups: readonly GroupHeader[];
  primary: Field | undefined;
  /** Fields shown beside the title (already without the description field). */
  fields: readonly Field[];
  /** Text field read under each title as a clamped excerpt (the whole of it on hover). */
  descriptionField?: Field;
  /** Every field of the table, to tell what a group header groups by (a person, a choice...). */
  tableFields: readonly Field[];
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

/** Pills say what they are by their colour and wording; other values need their field's name. */
const isPill = (f: Field) => {
  const shape = displayShapeOf(f);
  return shape === "select" || shape === "multi_select";
};

function Row({ record, indent, p }: { record: TableRecord; indent: number; p: ListOutlineProps }) {
  // Every field the view shows that has something in it (Hide fields decides which); empty ones are left out.
  const shown = fieldsToShow(p.fields, record, p.format, Infinity);
  const color = p.colors[record.id];
  const title = cardTitle(p.primary, record, p.format);
  const description = descriptionText(p.descriptionField, p.descriptionField ? record.values[p.descriptionField.id] : undefined, p.format);
  const open = () => p.onOpen(record.id);
  return (
    <div
      role="button"
      tabIndex={0}
      data-record-id={record.id}
      aria-label={title}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a")) open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      style={{ paddingLeft: indent }}
      className="relative flex min-h-11 cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-2 pr-4 outline-none hover:bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 w-1" style={{ background: swatchColor(color) }} />}
      <span className="w-full min-w-0 truncate text-[0.875rem] font-medium sm:w-[190px] sm:shrink-0">{title}</span>
      {description && (
        // Straight under the title on a phone (the title takes the whole line there); under the
        // title and its fields on a wider screen, where they sit beside the title.
        <DescriptionHover field={p.descriptionField} record={record} title={title} format={p.format}>
          <p data-row-description className="order-1 w-full min-w-0 line-clamp-2 break-words text-[0.8125rem] leading-[1.45] text-muted sm:order-3">
            {description}
          </p>
        </DescriptionHover>
      )}
      {shown.map((f) =>
        isPill(f) ? (
          <CellValue key={f.id} field={f} value={record.values[f.id] ?? null} format={p.format} emails={p.emails} className="order-2 min-w-0 text-[0.8125rem]" markdown={false} />
        ) : (
          <span key={f.id} className="order-2 flex min-w-0 max-w-72 items-center gap-1.5 text-[0.8125rem]">
            <span className="shrink-0 text-faint">{f.name}</span>
            <CellValue field={f} value={record.values[f.id] ?? null} format={p.format} emails={p.emails} className="truncate text-[0.8125rem]" markdown={false} />
          </span>
        ),
      )}
    </div>
  );
}

function Records({ node, indent, p }: { node: GroupNode | null; indent: number; p: ListOutlineProps }) {
  const [limit, setLimit] = useState(ROWS_PER_GROUP);
  const start = node?.start ?? 0;
  const count = node?.count ?? p.records.length;
  const slice = p.records.slice(start, start + Math.min(count, limit));
  return (
    <>
      {slice.map((r) => (
        <Row key={r.id} record={r} indent={indent} p={p} />
      ))}
      {count > limit && (
        <button type="button" onClick={() => setLimit((l) => l + ROWS_PER_GROUP)} className="w-full border-b border-line py-1.5 text-xs text-muted hover:bg-hover">
          Show {Math.min(ROWS_PER_GROUP, count - limit)} more ({count - limit} hidden)
        </button>
      )}
      {count === 0 && (
        <p className="border-b border-line py-2 text-xs text-faint" style={{ paddingLeft: indent }}>
          No records
        </p>
      )}
      {node && p.canEdit && (
        <button
          type="button"
          aria-label={`Add record to ${node.header.label}`}
          onClick={() => p.onAdd(groupDefaults(node))}
          style={{ paddingLeft: indent - 2 }}
          className="flex h-10 w-full items-center gap-1.5 pr-4 text-left text-[0.875rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          <Plus aria-hidden className="size-[15px]" /> Add
        </button>
      )}
    </>
  );
}

/** The face of a person group beside the group's name (a choice group's colour fills its heading instead). */
function GroupMark({ header, p }: { header: GroupHeader; p: ListOutlineProps }) {
  const field = p.tableFields.find((f) => f.id === header.field_id);
  if (!field || header.key === "" || displayShapeOf(field) !== "user") return null;
  return (
    <span aria-hidden className="contents">
      <Avatar name={header.label} email={p.emails.get(header.key)} color={p.format.userColor?.(header.key)} size="sm" className="size-[22px] text-[0.6875rem]" />
    </span>
  );
}

/** A heading's background: a choice group's is filled with the choice's colour, the rest are neutral. */
function headingFill(header: GroupHeader, p: ListOutlineProps): string {
  const field = p.tableFields.find((f) => f.id === header.field_id);
  const shape = field && header.key !== "" ? displayShapeOf(field) : null;
  const color = field && (shape === "select" || shape === "multi_select") ? selectChoicesOf(field).find((c) => c.id === header.key)?.color : null;
  return color ? `ob-hue-${accentHue(color)} ob-fill ob-fill-hover` : "bg-subtle hover:bg-hover";
}

export function ListOutline(p: ListOutlineProps) {
  if (p.groups.length === 0) {
    return (
      <div role="list" aria-label="Records">
        <Records node={null} indent={ROW_PAD} p={p} />
      </div>
    );
  }
  const rows = flattenOutline(buildOutline(p.groups), p.collapsed);
  return (
    <div role="tree" aria-label="Grouped records">
      {rows.map((row) =>
        row.kind === "group" ? (
          <div key={`g:${row.node.path}`} role="treeitem" aria-expanded={!row.collapsed} aria-level={row.depth + 1} data-group={row.node.path}>
            <h3 className="text-[0.875rem]">
              <button
                type="button"
                onClick={() => p.onToggle(row.node.path)}
                aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.node.header.label}`}
                style={{ paddingLeft: ROW_PAD + row.depth * LEVEL_PX }}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] pr-4 text-left font-semibold",
                  headingFill(row.node.header, p),
                )}
              >
                <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform duration-200", row.collapsed && "-rotate-90")} />
                <GroupMark header={row.node.header} p={p} />
                <span className="min-w-0 truncate">{row.node.header.label}</span>
                <span aria-hidden className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-hover px-[7px] text-xs font-semibold tabular-nums text-muted">
                  {row.node.count}
                </span>
              </button>
            </h3>
          </div>
        ) : (
          <div key={`r:${row.node.path}`} role="group" aria-label={row.node.header.label}>
            <Records node={row.node} indent={ROW_PAD + (row.depth - 1) * LEVEL_PX + UNDER_CHEVRON} p={p} />
          </div>
        ),
      )}
    </div>
  );
}
