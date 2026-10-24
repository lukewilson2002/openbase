/**
 * The list view's body: a collapsible outline, drawn as a tree for assistive technology (group
 * headings and records are all tree items, with their level, place and fold state; their names
 * read the title and every value shown). Group headers are grey bars that fold their group (with
 * the person's face for a person field, the choice's dot for a select) and say how many records
 * they hold; each group ends with an "Add" that pre-fills the group's values. Records are compact
 * rows: an optional prefix (a checkbox ticked in place, a choice, a person), the title (with the
 * view's description under it, when it has one), then select values as pills and other values as
 * "Label value". With a parent field, a record sits under the record it links to, one level deeper.
 *
 * Keyboard: one heading or row is the tab stop; Up, Down, Home and End move between them, Left and
 * Right fold and unfold a group or a row with sub-items (Left on a row goes to its parent, or its
 * heading), Enter opens a row (or folds a heading), Space selects it, Ctrl or Cmd with Enter changes
 * its prefix, Delete deletes it (or the selection), Tab and Shift+Tab indent and outdent a row under
 * a parent field (where they cannot, Tab leaves the list), and Alt with Up or Down moves a row in the
 * manual order, into the next group when it passes the end of its own. Rows can also be dragged:
 * above or below another row, or onto a group's heading to put the row first in that group.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { Collaborator, Field, GroupHeader, LinkRef, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { Avatar } from "@/components/ui/avatar";
import { type MenuAnchor } from "@/components/ui/anchored-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { accentHue } from "@/lib/colors";
import type { FormatCtx } from "@/lib/cells/format";
import { displayShapeOf, selectChoicesOf } from "@/lib/cells/kinds";
import { swatchColor } from "@/lib/cells/palette";
import { isWritable } from "@/lib/cells/wire";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { holdClicks } from "@/shell/sortable";
import { cardTitle, descriptionText, fieldsToShow } from "../common/cardFields";
import { DescriptionHover } from "../common/description";
import { menuAnchorOf } from "../common/RecordMenu";
import type { RecordSelection } from "../common/useRecordSelection";
import { useRovingFocus, type RovingFocus } from "../common/useRovingFocus";
import { RowPrefix } from "./RowPrefix";
import {
  buildOutline,
  flattenOutline,
  foldRows,
  foldedAncestors,
  groupDefaults,
  indentTarget,
  leafNodes,
  nestRows,
  outdentValue,
  parentLinkOf,
  planDrop,
  rowLabel,
  type DropPlan,
  type GroupNode,
  type NestedRow,
} from "./outline";

/** Rows rendered per group before "Show more" (a group can hold thousands). */
export const ROWS_PER_GROUP = 200;
/** Indent of one outline level, and of records under their group's chevron. */
const LEVEL_PX = 20;
const ROW_PAD = 16;
const UNDER_CHEVRON = 30;
/** Indent of a sub-item under its parent, and the width the title column starts with. */
const NEST_PX = 20;
/** Levels of sub-items that indent further; deeper rows stay at the last indent. */
const MAX_INDENTS = 6;
const TITLE_PX = 190;

/** What a row's menu and its Tab keys can do to where the row sits in the sub-item tree. */
export interface RowTreeActions {
  /** Make it a sub-item of the row above it at its level (absent when there is none). */
  indent?: () => void;
  /** Move it out one level (absent for a row that is not a sub-item). */
  outdent?: () => void;
  /** Add a record under it. */
  addSub?: () => void;
}

export interface ListOutlineProps {
  records: readonly TableRecord[];
  groups: readonly GroupHeader[];
  /** Records the view holds in all. Without groups the one list has this many; absent: the records given. */
  total?: number;
  /** Rows present per group path ("" without groups); a group not listed is whole. See `withTails`. */
  loadedRows?: ReadonlyMap<string, number>;
  /** Rows of a group past those loaded are on their way ("loading") or could not be fetched ("error"). */
  rowStatus?: "loading" | "error";
  /** A group shows more rows than it has loaded: fetch its first `upTo`. */
  onNeedRows?(path: string, upTo: number): void;
  onRetryRows?(): void;
  primary: Field | undefined;
  /** Fields shown beside the title (already without the description field). */
  fields: readonly Field[];
  /** Text field read under each title as a clamped excerpt (the whole of it on hover). */
  descriptionField?: Field;
  /** Every field of the table, to tell what a group header groups by (a person, a choice...). */
  tableFields: readonly Field[];
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  people?: readonly Collaborator[];
  colors: Readonly<Record<string, string>>;
  collapsed: ReadonlySet<string>;
  canEdit: boolean;
  /** Field drawn at the start of every row (a checkbox, a choice, a person) and changed there. */
  prefix?: Field;
  onPrefixChange?(recordId: string, value: unknown): void;
  /** Self-link field that nests a record under the one it links to. */
  parentField?: Field;
  /** Rows with sub-items that are folded. */
  folded?: ReadonlySet<string>;
  onToggleFold?(recordId: string): void;
  /** Link `recordId` under a parent (an empty list for none). `label` names the step for Undo. */
  onSetParent?(recordId: string, parent: LinkRef[], label: string): void | Promise<unknown>;
  onToggle(path: string): void;
  onOpen(recordId: string): void;
  /** Add a record starting with these field values (a group's values; empty when ungrouped). */
  onAdd(defaults: Record<string, unknown>): void;
  /** Selecting rows: Ctrl/Cmd-click, Shift-click, Space and the tick boxes. Omit for a list that cannot select. */
  selection?: RecordSelection;
  /** Delete these records (the Delete key). */
  onDelete?(ids: readonly string[]): void;
  /** A right-click (or the menu key) on a row. */
  onRecordMenu?(recordId: string, anchor: MenuAnchor, tree: RowTreeActions): void;
  /**
   * Present when rows can be put in a new place by hand: dragging or Alt+Up/Down. The plan says
   * where, and which group values change with it; "blocked" is a drop into a group whose field
   * cannot be written to.
   */
  onReorder?(recordId: string, plan: DropPlan | "blocked"): void | Promise<unknown>;
  /** The record open in the panel: its row is brought into view, even past the first rows of its group. */
  reveal?: string | null;
}

/** The rows of one group that holds records, as they are drawn. */
interface Leaf {
  path: string;
  node: GroupNode | null;
  /** Levels of groups above its rows. */
  depth: number;
  indent: number;
  count: number;
  loaded: number;
  /** Rows it should have loaded for what is shown. */
  needed: number;
  limit: number;
  all: NestedRow[];
  shown: NestedRow[];
  /** Rows (and rows not loaded yet) that "Show more" would reveal. */
  remaining: number;
}

/** What the rows and groups of one outline share. */
interface Ui {
  p: ListOutlineProps;
  roving: RovingFocus;
  showMore(leaf: Leaf): void;
  /** Whether rows can be dragged. */
  draggable: boolean;
  treeOf(recordId: string): RowTreeActions;
}

const IDLE = { activeId: null as string | null, activeGroup: null as string | null };
/** The row being dragged and the group it came from, for the drop markers. */
const DragCtx = createContext(IDLE);

/** Pills say what they are by their colour and wording; other values need their field's name. */
const isPill = (f: Field) => {
  const shape = displayShapeOf(f);
  return shape === "select" || shape === "multi_select";
};

const ROW_BORDER = "border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))]";

function Row({ row, leaf, u }: { row: NestedRow; leaf: Leaf; u: Ui }) {
  const { p } = u;
  const { record } = row;
  // Every field the view shows that has something in it (Hide fields decides which); empty ones are left out.
  const shown = fieldsToShow(p.fields, record, p.format, Infinity);
  const color = p.colors[record.id];
  const title = cardTitle(p.primary, record, p.format);
  const description = descriptionText(p.descriptionField, p.descriptionField ? record.values[p.descriptionField.id] : undefined, p.format);
  const sel = p.selection;
  const selected = !!sel?.has(record.id);
  const folded = row.children > 0 && !!p.folded?.has(record.id);
  const { setNodeRef, listeners, transform, transition, isDragging, isOver } = useSortable({ id: record.id, disabled: !u.draggable, data: { group: leaf.path } });
  const drag = useContext(DragCtx);
  // Another group's row under the dragged one: dropping here puts the row in that group, above this one.
  const joining = isOver && drag.activeId !== null && drag.activeId !== record.id && drag.activeGroup !== leaf.path;
  const prefixValue = p.prefix ? record.values[p.prefix.id] : undefined;
  const label = rowLabel(title, [...(p.prefix ? [{ field: p.prefix, value: prefixValue }] : []), ...shown.map((f) => ({ field: f, value: record.values[f.id] }))], description, p.format);
  const nested = !!p.parentField;
  // Sub-items indent inside the title column, so the values of every row still line up.
  const titleWidth = TITLE_PX + (p.prefix ? 28 : 0) + (nested ? NEST_PX : 0);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn("group/row relative motion-reduce:transition-none!", isDragging && "z-20 bg-surface shadow-pop")}>
      <div
        role="treeitem"
        {...u.roving.itemProps(`r:${record.id}`)}
        {...listeners}
        data-record-id={record.id}
        data-selected={selected || undefined}
        aria-label={label}
        aria-level={leaf.depth + 1 + row.depth}
        aria-posinset={row.pos}
        aria-setsize={nested ? row.size : leaf.count}
        aria-expanded={row.children > 0 ? !folded : undefined}
        // Once something is selected a click selects, so the rows say which are.
        aria-selected={sel ? selected : undefined}
        onClick={(e) => {
          // A link in the row goes where it points.
          if ((e.target as HTMLElement).closest("a")) return;
          if (!sel?.handleClick(record.id, e)) p.onOpen(record.id);
        }}
        onContextMenu={(e) => {
          if (!p.onRecordMenu || (e.target as HTMLElement).closest("a")) return;
          e.preventDefault();
          p.onRecordMenu(record.id, menuAnchorOf(e), u.treeOf(record.id));
        }}
        style={{ paddingLeft: leaf.indent, "--title-w": `${titleWidth}px` } as CSSProperties}
        className={cn(
          `relative flex min-h-11 cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 ${ROW_BORDER} py-2 pr-10 outline-none hover:bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`,
          selected && "bg-primary-soft hover:bg-primary-soft",
          joining && "shadow-[inset_0_2px_0_var(--primary)]",
          u.draggable && "select-none",
        )}
      >
        {color && <span aria-hidden data-row-color={color} className="absolute inset-y-0 left-0 w-1" style={{ background: swatchColor(color) }} />}
        <span className="flex w-full min-w-0 items-center gap-2 sm:w-(--title-w) sm:shrink-0">
          {row.depth > 0 && <span aria-hidden className="shrink-0" style={{ width: Math.min(row.depth, MAX_INDENTS) * NEST_PX }} />}
          {nested && (
            <span
              aria-hidden
              data-fold={row.children > 0 ? "" : undefined}
              onClick={(e) => {
                if (row.children === 0) return;
                e.stopPropagation();
                p.onToggleFold?.(record.id);
              }}
              onMouseDown={(e) => row.children > 0 && e.stopPropagation()}
              className={cn("flex size-5 shrink-0 items-center justify-center rounded text-muted", row.children > 0 && "hover:bg-hover")}
            >
              {row.children > 0 && <ChevronDown className={cn("size-4 transition-transform duration-200", folded && "-rotate-90")} />}
            </span>
          )}
          {p.prefix && (
            <RowPrefix
              field={p.prefix}
              value={prefixValue}
              title={title}
              canEdit={p.canEdit && !!p.onPrefixChange}
              onChange={(v) => p.onPrefixChange?.(record.id, v)}
              people={p.people ?? []}
              emails={p.emails}
              format={p.format}
            />
          )}
          <span className="min-w-0 truncate text-[0.875rem] font-medium">{title}</span>
          {folded && (
            <span aria-hidden className="shrink-0 rounded-full bg-hover px-1.5 text-xs tabular-nums text-muted">
              {row.children}
            </span>
          )}
        </span>
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
        {sel && (
          // Inside the row, so a screen reader finds it with the row; it only selects.
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${title}`}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              sel.toggle(record.id);
            }}
            className={cn(
              "absolute right-3 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded border bg-surface pointer-coarse:size-7",
              selected ? "border-primary bg-primary text-primary-fg" : "border-line-strong text-transparent",
              !selected && sel.count === 0 && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <Check aria-hidden className="size-3.5" strokeWidth={3} />
          </button>
        )}
      </div>
    </div>
  );
}

/** A line of the tree that does something when it is chosen (Add, Show more, Retry): a tree item too. */
function ActionRow({ navKey, level, indent, label, onActivate, u, children, className }: { navKey: string; level: number; indent: number; label: string; onActivate(): void; u: Ui; children: ReactNode; className?: string }) {
  return (
    <div
      role="treeitem"
      {...u.roving.itemProps(navKey)}
      aria-level={level}
      aria-label={label}
      onClick={onActivate}
      style={{ paddingLeft: indent }}
      className={cn(`flex w-full cursor-pointer items-center gap-1.5 pr-4 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`, className)}
    >
      {children}
    </div>
  );
}

function Records({ leaf, u }: { leaf: Leaf; u: Ui }) {
  const { p } = u;
  const { node } = leaf;
  const waiting = leaf.loaded < leaf.needed;
  return (
    <>
      <SortableContext items={leaf.shown.map((r) => r.record.id)} strategy={verticalListSortingStrategy} disabled={!u.draggable}>
        {leaf.shown.map((r) => (
          <Row key={r.record.id} row={r} leaf={leaf} u={u} />
        ))}
      </SortableContext>
      {waiting &&
        (p.rowStatus === "error" ? (
          <ActionRow navKey={`x:${leaf.path}`} level={leaf.depth + 1} indent={leaf.indent} label="Could not load more records. Retry" onActivate={() => p.onRetryRows?.()} u={u} className={`min-h-9 ${ROW_BORDER} text-xs text-danger`}>
            Could not load these records. <span className="underline">Retry</span>
          </ActionRow>
        ) : (
          <div role="treeitem" aria-level={leaf.depth + 1} aria-label="Loading records" aria-busy="true" aria-disabled="true" style={{ paddingLeft: leaf.indent }} className={`flex min-h-9 items-center gap-2 ${ROW_BORDER} text-xs text-muted`}>
            <Spinner className="size-3.5" label="Loading records" /> Loading records…
          </div>
        ))}
      {!waiting && leaf.remaining > 0 && (
        <ActionRow
          navKey={`m:${leaf.path}`}
          level={leaf.depth + 1}
          indent={leaf.indent}
          label={`Show ${Math.min(ROWS_PER_GROUP, leaf.remaining)} more records`}
          onActivate={() => u.showMore(leaf)}
          u={u}
          className={`justify-center border-b border-line py-1.5 pl-0 text-xs text-muted`}
        >
          Show {Math.min(ROWS_PER_GROUP, leaf.remaining)} more ({leaf.remaining} hidden)
        </ActionRow>
      )}
      {leaf.count === 0 && (
        <div role="treeitem" aria-level={leaf.depth + 1} aria-disabled="true" className="border-b border-line py-2 text-xs text-faint" style={{ paddingLeft: leaf.indent }}>
          No records
        </div>
      )}
      {node && p.canEdit && (
        <ActionRow
          navKey={`a:${leaf.path}`}
          level={leaf.depth + 1}
          indent={leaf.indent - 2}
          label={`Add record to ${node.header.label}`}
          onActivate={() => p.onAdd(groupDefaults(node))}
          u={u}
          className="h-10 text-[0.875rem] text-muted hover:text-fg pointer-coarse:h-11"
        >
          <Plus aria-hidden className="size-[15px]" /> Add
        </ActionRow>
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

/** A group's heading: folds the group, and takes a dragged row to the start of the group. */
function GroupHeading({ row, u }: { row: Extract<ReturnType<typeof flattenOutline>[number], { kind: "group" }>; u: Ui }) {
  const { p } = u;
  const { setNodeRef, isOver } = useDroppable({ id: `group:${row.node.path}`, disabled: !u.draggable });
  const drag = useContext(DragCtx);
  const target = isOver && drag.activeId !== null;
  const count = row.node.count;
  return (
    <div
      ref={setNodeRef}
      role="treeitem"
      {...u.roving.itemProps(`g:${row.node.path}`)}
      aria-expanded={!row.collapsed}
      aria-level={row.depth + 1}
      aria-posinset={row.node.pos}
      aria-setsize={row.node.size}
      aria-label={`${row.node.header.label}, ${count} ${count === 1 ? "record" : "records"}`}
      data-group={row.node.path}
      onClick={() => p.onToggle(row.node.path)}
      style={{ paddingLeft: ROW_PAD + row.depth * LEVEL_PX }}
      className={cn(
        `flex min-h-11 w-full cursor-pointer items-center gap-2.5 ${ROW_BORDER} pr-4 text-left text-[0.875rem] font-semibold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`,
        headingFill(row.node.header, p),
        target && "shadow-[inset_0_0_0_2px_var(--primary)]",
      )}
    >
      <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform duration-200", row.collapsed && "-rotate-90")} />
      <GroupMark header={row.node.header} p={p} />
      <span className="min-w-0 truncate">{row.node.header.label}</span>
      <span aria-hidden className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-hover px-[7px] text-xs font-semibold tabular-nums text-muted">
        {count}
      </span>
    </div>
  );
}

type Entry = { kind: "group"; row: Extract<ReturnType<typeof flattenOutline>[number], { kind: "group" }> } | { kind: "leaf"; leaf: Leaf };

export function ListOutline(p: ListOutlineProps) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState(IDLE);
  const roots = useMemo(() => buildOutline(p.groups), [p.groups]);
  const rows = useMemo(() => flattenOutline(roots, p.collapsed), [roots, p.collapsed]);
  const grouped = p.groups.length > 0;
  const ids = useMemo(() => p.records.map((r) => r.id), [p.records]);
  const byId = useMemo(() => new Map(p.records.map((r) => [r.id, r])), [p.records]);
  const parentId = p.parentField?.id ?? null;
  const folded = p.folded;

  // What is drawn, in the order it is drawn: headings, and for each group that holds records its rows.
  const entries = useMemo(() => {
    const make = (node: GroupNode | null, depth: number): Leaf => {
      const path = node?.path ?? "";
      const start = node?.start ?? 0;
      const count = node ? node.count : (p.total ?? p.records.length);
      const loaded = p.loadedRows?.get(path) ?? Math.max(0, Math.min(count, p.records.length - start));
      const limit = limits[path] ?? ROWS_PER_GROUP;
      const all = nestRows(p.records.slice(start, start + loaded), parentId);
      const visible = foldRows(all, folded ?? new Set());
      const shown = visible.slice(0, limit);
      return {
        path,
        node,
        depth,
        indent: node ? ROW_PAD + (depth - 1) * LEVEL_PX + UNDER_CHEVRON : ROW_PAD,
        count,
        loaded,
        needed: Math.min(count, limit),
        limit,
        all,
        shown,
        remaining: visible.length - shown.length + (count - loaded),
      };
    };
    if (!grouped) return [{ kind: "leaf", leaf: make(null, 0) }] as Entry[];
    return rows.map<Entry>((row) => (row.kind === "group" ? { kind: "group", row } : { kind: "leaf", leaf: make(row.node, row.depth) }));
  }, [rows, grouped, p.records, p.total, p.loadedRows, limits, parentId, folded]);

  // Everything that can take focus, in the order it is drawn, and where each row is.
  const { navKeys, rowAt } = useMemo(() => {
    const keys: string[] = [];
    const rowAt = new Map<string, { leaf: Leaf; row: NestedRow }>();
    for (const e of entries) {
      if (e.kind === "group") {
        keys.push(`g:${e.row.node.path}`);
        continue;
      }
      const { leaf } = e;
      for (const row of leaf.shown) {
        keys.push(`r:${row.record.id}`);
        rowAt.set(row.record.id, { leaf, row });
      }
      const waiting = leaf.loaded < leaf.needed;
      if (waiting && p.rowStatus === "error") keys.push(`x:${leaf.path}`);
      if (!waiting && leaf.remaining > 0) keys.push(`m:${leaf.path}`);
      if (leaf.node && p.canEdit) keys.push(`a:${leaf.path}`);
    }
    return { navKeys: keys, rowAt };
  }, [entries, p.rowStatus, p.canEdit]);
  const roving = useRovingFocus(navKeys);

  // Groups that show more rows than they have: the rows past the first records are fetched.
  const { onNeedRows } = p;
  useEffect(() => {
    for (const e of entries) if (e.kind === "leaf" && e.leaf.loaded < e.leaf.needed) onNeedRows?.(e.leaf.path, e.leaf.needed);
  }, [entries, onNeedRows]);

  const draggable = !!p.onReorder && p.canEdit;
  const u: Ui = {
    p,
    roving,
    showMore: (leaf) => setLimits((cur) => ({ ...cur, [leaf.path]: Math.min(leaf.count, leaf.limit + ROWS_PER_GROUP) })),
    draggable,
    treeOf: (id) => treeActionsOf(id),
  };

  // Where a row can go in the sub-item tree: under the row above it, out to its parent's level, or a new sub-item.
  function treeActionsOf(id: string): RowTreeActions {
    const at = rowAt.get(id);
    if (!at || !p.parentField || !p.canEdit || !p.onSetParent) return {};
    const { leaf, row } = at;
    const target = indentTarget(leaf.all, id);
    const outdent = outdentValue(leaf.all, id, p.parentField.id);
    const set = p.onSetParent;
    const nameOf = (r: TableRecord) => cardTitle(p.primary, r, p.format);
    return {
      indent: target
        ? () => {
            // Its new parent opens, so the row does not vanish into it.
            if (folded?.has(target.id)) p.onToggleFold?.(target.id);
            void set(id, [{ id: target.id, name: nameOf(target) }], "Indent");
          }
        : undefined,
      outdent: outdent ? () => void set(id, outdent, "Outdent") : undefined,
      addSub: () => p.onAdd({ ...(leaf.node ? groupDefaults(leaf.node) : {}), [p.parentField!.id]: [{ id, name: nameOf(row.record) }] }),
    };
  }

  // The open record's row is drawn (its group may show only the first rows, and a parent may be folded) and brought into view.
  const { reveal } = p;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!reveal) {
      opened.current = null;
      return;
    }
    const grow = (path: string, need: number) => setLimits((cur) => ((cur[path] ?? ROWS_PER_GROUP) >= need ? cur : { ...cur, [path]: Math.ceil(need / ROWS_PER_GROUP) * ROWS_PER_GROUP }));
    const entry = entries.find((e): e is Extract<Entry, { kind: "leaf" }> => e.kind === "leaf" && e.leaf.all.some((r) => r.record.id === reveal));
    if (!entry) {
      // Possibly in a group whose rows are not loaded yet: show rows up to where it would be, which fetches them.
      const at = ids.indexOf(reveal);
      const leaf = at >= 0 && grouped ? leafNodes(roots).find((n) => at >= n.start && at < n.start + n.count) : null;
      if (leaf) grow(leaf.path, at - leaf.start + 1);
      return;
    }
    const { leaf } = entry;
    // Folded parents above it open once, when the record is opened (folding them again afterwards is left alone).
    const hiding = opened.current === reveal ? [] : foldedAncestors(leaf.all, reveal, folded ?? new Set());
    opened.current = reveal;
    for (const id of hiding) p.onToggleFold?.(id);
    const open = new Set([...(folded ?? [])].filter((id) => !hiding.includes(id)));
    const need = foldRows(leaf.all, open).findIndex((r) => r.record.id === reveal) + 1;
    if (need > 0) grow(leaf.path, need);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new `reveal`, or its rows arriving, is what brings a row into view
  }, [reveal, ids, grouped, roots, entries]);
  useEffect(() => {
    if (!reveal) return;
    for (const el of roving.containerRef.current?.querySelectorAll<HTMLElement>("[data-record-id]") ?? []) {
      if (el.dataset.recordId === reveal) el.scrollIntoView?.({ block: "nearest" });
    }
  }, [reveal, limits, roving.containerRef]);

  const canSet = (fieldId: string) => {
    const f = p.tableFields.find((x) => x.id === fieldId);
    return !!f && isWritable(f) && f.type !== "link";
  };
  // Dropping a row next to another makes it that row's sibling: it takes the parent the other has.
  const withParent = (plan: DropPlan, id: string, over: Parameters<typeof planDrop>[3]): DropPlan => {
    if (!p.parentField) return plan;
    const parent = over.kind === "row" ? parentLinkOf(byId.get(over.id) ?? ({ values: {} } as TableRecord), p.parentField.id) : null;
    const dragged = byId.get(id);
    if (!dragged || parentLinkOf(dragged, p.parentField.id)?.id === (parent?.id ?? undefined)) return plan;
    // A record cannot go under itself or under one of its own sub-items.
    for (let up: string | undefined = parent?.id, hops = 0; up && hops < 1000; hops++) {
      if (up === id) return plan;
      up = parentLinkOf(byId.get(up) ?? ({ values: {} } as TableRecord), p.parentField.id)?.id;
    }
    return { ...plan, values: { ...plan.values, [p.parentField.id]: parent ? [parent] : [] } };
  };
  const reorder = (id: string, over: Parameters<typeof planDrop>[3], upward = false, neighbour?: string) => {
    const plan = planDrop(ids, roots, id, over, canSet);
    if (!plan) return undefined;
    if (plan === "blocked") return p.onReorder?.(id, plan);
    // Up past the first row of a group lands after the last row of the one above, not before it.
    const crossing = upward && neighbour && rowAt.get(neighbour)?.leaf.path !== rowAt.get(id)?.leaf.path;
    return p.onReorder?.(id, withParent(crossing ? { ...plan, beforeId: undefined, afterId: neighbour } : plan, id, over));
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // A finger must rest on a row first: moving straight away is a swipe that scrolls the list.
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
  );
  const [release, setRelease] = useState<(() => void) | null>(null);
  const finishDrag = () => {
    release?.();
    setRelease(null);
    setDrag(IDLE);
  };
  const onDragStart = (e: DragStartEvent) => {
    release?.();
    setRelease(() => holdClicks());
    setDrag({ activeId: String(e.active.id), activeGroup: (e.active.data.current as { group?: string } | undefined)?.group ?? "" });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    finishDrag();
    if (!over || active.id === over.id) return;
    const overId = String(over.id);
    reorder(String(active.id), overId.startsWith("group:") ? { kind: "group", path: overId.slice("group:".length) } : { kind: "row", id: overId });
  };

  const go = (at: number) => {
    const key = navKeys[Math.max(0, Math.min(navKeys.length - 1, at))];
    if (key) roving.focusKey(key);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const sel = p.selection;
    if (sel?.handleKeyDown(e, { onDelete: () => p.onDelete?.(sel.ids) })) return;
    const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-nav]") : null;
    // Keys pressed in a link inside a row belong to the link, not to the row.
    if (!el || e.target !== el) return;
    const key = el.dataset.nav!;
    const at = navKeys.indexOf(key);
    if (at < 0) return;
    const kind = key.slice(0, 2);
    const row = kind === "r:";
    const heading = kind === "g:";
    const id = key.slice(2);
    const here = row ? rowAt.get(id) : undefined;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!row || !draggable) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      for (let i = at + dir; i >= 0 && i < navKeys.length; i += dir) {
        if (!navKeys[i]!.startsWith("r:")) continue;
        const neighbour = navKeys[i]!.slice(2);
        // The row may be drawn again in its new place (another group): focus follows it there.
        void Promise.resolve(reorder(id, { kind: "row", id: neighbour }, dir < 0, neighbour)).then(() => roving.focusKey(key));
        break;
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") {
      // The prefix control of the row does what a click on it does: ticks the box, opens the choice menu.
      if (!row || !p.canEdit) return;
      const control = el.querySelector<HTMLElement>("[data-prefix]");
      if (!control) return;
      e.preventDefault();
      control.click();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(at + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        go(at - 1);
        break;
      case "Home":
        e.preventDefault();
        go(0);
        break;
      case "End":
        e.preventDefault();
        go(navKeys.length - 1);
        break;
      case "ArrowRight":
        if (row) {
          if (!here || here.row.children === 0) return;
          e.preventDefault();
          if (folded?.has(id)) p.onToggleFold?.(id);
          else go(at + 1);
          break;
        }
        if (!heading) return;
        e.preventDefault();
        if (p.collapsed.has(id)) p.onToggle(id);
        else go(at + 1);
        break;
      case "ArrowLeft":
        if (heading) {
          e.preventDefault();
          if (!p.collapsed.has(id)) p.onToggle(id);
        } else if (row && here) {
          if (here.row.children > 0 && !folded?.has(id)) {
            e.preventDefault();
            p.onToggleFold?.(id);
          } else if (here.row.parentId) {
            e.preventDefault();
            roving.focusKey(`r:${here.row.parentId}`);
          } else if (grouped) {
            e.preventDefault();
            roving.focusKey(`g:${here.leaf.path}`);
          }
        }
        break;
      case "Enter":
        e.preventDefault();
        if (row) p.onOpen(id);
        else if (heading) p.onToggle(id);
        else el.click();
        break;
      case " ":
        if (heading) {
          e.preventDefault();
          p.onToggle(id);
        } else if (row && sel) {
          e.preventDefault();
          sel.toggle(id);
        } else if (!row) {
          e.preventDefault();
          el.click();
        }
        break;
      case "Delete":
        if (!row || !p.canEdit || !p.onDelete) return;
        e.preventDefault();
        p.onDelete([id]);
        break;
      case "Tab": {
        // Under a parent field Tab indents and Shift+Tab outdents; where that cannot be done, focus moves on as usual.
        if (!row || !p.parentField) return;
        const act = e.shiftKey ? u.treeOf(id).outdent : u.treeOf(id).indent;
        if (!act) return;
        e.preventDefault();
        act();
        // The row is drawn in its new place: focus stays with it.
        window.setTimeout(() => roving.focusKey(key), 0);
        break;
      }
    }
  };

  const body = (
    <div ref={roving.containerRef} role="tree" aria-label={grouped ? "Grouped records" : "Records"} aria-multiselectable={p.selection ? true : undefined} onKeyDown={onKeyDown}>
      {entries.map((e) => (e.kind === "group" ? <GroupHeading key={`g:${e.row.node.path}`} row={e.row} u={u} /> : <Records key={`r:${e.leaf.path}`} leaf={e.leaf} u={u} />))}
    </div>
  );
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={finishDrag}>
      <DragCtx.Provider value={drag}>{body}</DragCtx.Provider>
    </DndContext>
  );
}
