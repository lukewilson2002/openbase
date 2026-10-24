/**
 * The list view's body: a collapsible outline. Group headers are grey bars that fold their group
 * (with the person's face for a person field, the choice's dot for a select) and say how many
 * records they hold; each group ends with an "Add" that pre-fills the group's values. Records are
 * compact rows: the title (with the view's description under it, when it has one), then select
 * values as pills and other values as "Label value".
 *
 * Keyboard: one heading or row is the tab stop; Up, Down, Home and End move between them, Left and
 * Right fold and unfold a group (Left on a row goes to its heading), Enter opens a row, Space selects
 * it, Delete deletes it (or the selection), and Alt with Up or Down moves a row in the manual order,
 * into the next group when it passes the end of its own. Rows can also be dragged: above or below
 * another row, or onto a group's heading to put the row first in that group.
 */
import { createContext, useContext, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { Field, GroupHeader, TableRecord } from "@/api/types";
import { CellValue } from "@/components/record/CellValue";
import { Avatar } from "@/components/ui/avatar";
import { type MenuAnchor } from "@/components/ui/anchored-menu";
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
import { buildOutline, flattenOutline, groupDefaults, leafNodes, planDrop, type DropPlan, type GroupNode } from "./outline";

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
  /** Selecting rows: Ctrl/Cmd-click, Shift-click, Space and the tick boxes. Omit for a list that cannot select. */
  selection?: RecordSelection;
  /** Delete these records (the Delete key). */
  onDelete?(ids: readonly string[]): void;
  /** A right-click (or the menu key) on a row. */
  onRecordMenu?(recordId: string, anchor: MenuAnchor): void;
  /**
   * Present when rows can be put in a new place by hand: dragging or Alt+Up/Down. The plan says
   * where, and which group values change with it; "blocked" is a drop into a group whose field
   * cannot be written to.
   */
  onReorder?(recordId: string, plan: DropPlan | "blocked"): void | Promise<unknown>;
  /** The record open in the panel: its row is brought into view, even past the first rows of its group. */
  reveal?: string | null;
}

/** What the rows and groups of one outline share. */
interface Ui {
  p: ListOutlineProps;
  roving: RovingFocus;
  /** Rows shown per group (by path; "" without groups). */
  limits: Readonly<Record<string, number>>;
  showMore(key: string, total: number): void;
  /** Whether rows can be dragged. */
  draggable: boolean;
}

const IDLE = { activeId: null as string | null, activeGroup: null as string | null };
/** The row being dragged and the group it came from, for the drop markers. */
const DragCtx = createContext(IDLE);

/** Pills say what they are by their colour and wording; other values need their field's name. */
const isPill = (f: Field) => {
  const shape = displayShapeOf(f);
  return shape === "select" || shape === "multi_select";
};

function Row({ record, indent, u, groupPath, grouped }: { record: TableRecord; indent: number; u: Ui; groupPath: string; grouped: boolean }) {
  const { p } = u;
  // Every field the view shows that has something in it (Hide fields decides which); empty ones are left out.
  const shown = fieldsToShow(p.fields, record, p.format, Infinity);
  const color = p.colors[record.id];
  const title = cardTitle(p.primary, record, p.format);
  const description = descriptionText(p.descriptionField, p.descriptionField ? record.values[p.descriptionField.id] : undefined, p.format);
  const sel = p.selection;
  const selected = !!sel?.has(record.id);
  const { setNodeRef, listeners, transform, transition, isDragging, isOver } = useSortable({ id: record.id, disabled: !u.draggable, data: { group: groupPath } });
  const drag = useContext(DragCtx);
  // Another group's row under the dragged one: dropping here puts the row in that group, above this one.
  const joining = isOver && drag.activeId !== null && drag.activeId !== record.id && drag.activeGroup !== groupPath;
  return (
    <div
      ref={setNodeRef}
      role={grouped ? undefined : "listitem"}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/row relative motion-reduce:transition-none!", isDragging && "z-20 bg-surface shadow-pop")}
    >
      <div
        role="button"
        {...u.roving.itemProps(`r:${record.id}`)}
        {...listeners}
        data-record-id={record.id}
        data-selected={selected || undefined}
        aria-label={title}
        // Once something is selected a click selects, so the rows say which are.
        aria-pressed={sel && sel.count > 0 ? selected : undefined}
        onClick={(e) => {
          // A link in the row goes where it points.
          if ((e.target as HTMLElement).closest("a")) return;
          if (!sel?.handleClick(record.id, e)) p.onOpen(record.id);
        }}
        onContextMenu={(e) => {
          if (!p.onRecordMenu || (e.target as HTMLElement).closest("a")) return;
          e.preventDefault();
          p.onRecordMenu(record.id, menuAnchorOf(e));
        }}
        style={{ paddingLeft: indent }}
        className={cn(
          "relative flex min-h-11 cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] py-2 pr-10 outline-none hover:bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          selected && "bg-primary-soft hover:bg-primary-soft",
          joining && "shadow-[inset_0_2px_0_var(--primary)]",
          u.draggable && "select-none",
        )}
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
      {/* Beside the row, not in it: a control inside a button is not reachable by a screen reader. */}
      {sel && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${title}`}
          tabIndex={-1}
          onClick={() => sel.toggle(record.id)}
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
  );
}

function Records({ node, indent, u }: { node: GroupNode | null; indent: number; u: Ui }) {
  const { p } = u;
  const key = node?.path ?? "";
  const limit = u.limits[key] ?? ROWS_PER_GROUP;
  const start = node?.start ?? 0;
  const count = node?.count ?? p.records.length;
  const slice = p.records.slice(start, start + Math.min(count, limit));
  return (
    <>
      <SortableContext items={slice.map((r) => r.id)} strategy={verticalListSortingStrategy} disabled={!u.draggable}>
        {slice.map((r) => (
          <Row key={r.id} record={r} indent={indent} u={u} groupPath={key} grouped={node !== null} />
        ))}
      </SortableContext>
      {count > limit && (
        <button type="button" onClick={() => u.showMore(key, count)} className="w-full border-b border-line py-1.5 text-xs text-muted hover:bg-hover">
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

/** A group's heading: folds the group, and takes a dragged row to the start of the group. */
function GroupHeading({ row, u }: { row: Extract<ReturnType<typeof flattenOutline>[number], { kind: "group" }>; u: Ui }) {
  const { p } = u;
  const { setNodeRef, isOver } = useDroppable({ id: `group:${row.node.path}`, disabled: !u.draggable });
  const drag = useContext(DragCtx);
  const target = isOver && drag.activeId !== null;
  return (
    <div ref={setNodeRef} role="treeitem" aria-expanded={!row.collapsed} aria-level={row.depth + 1} data-group={row.node.path}>
      <h3 className="text-[0.875rem]">
        <button
          type="button"
          {...u.roving.itemProps(`g:${row.node.path}`)}
          onClick={() => p.onToggle(row.node.path)}
          aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.node.header.label}`}
          style={{ paddingLeft: ROW_PAD + row.depth * LEVEL_PX }}
          className={cn(
            "flex min-h-11 w-full items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] pr-4 text-left font-semibold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            headingFill(row.node.header, p),
            target && "shadow-[inset_0_0_0_2px_var(--primary)]",
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
  );
}

export function ListOutline(p: ListOutlineProps) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState(IDLE);
  const roots = useMemo(() => buildOutline(p.groups), [p.groups]);
  const rows = useMemo(() => flattenOutline(roots, p.collapsed), [roots, p.collapsed]);
  const grouped = p.groups.length > 0;
  const ids = useMemo(() => p.records.map((r) => r.id), [p.records]);

  // Everything that can take focus, in the order it is drawn, and the group each row is in.
  const { navKeys, groupOf } = useMemo(() => {
    const keys: string[] = [];
    const groupOf = new Map<string, string>();
    const add = (path: string, start: number, count: number) => {
      for (const r of p.records.slice(start, start + Math.min(count, limits[path] ?? ROWS_PER_GROUP))) {
        keys.push(`r:${r.id}`);
        groupOf.set(r.id, path);
      }
    };
    if (!grouped) add("", 0, p.records.length);
    else
      for (const row of rows) {
        if (row.kind === "group") keys.push(`g:${row.node.path}`);
        else add(row.node.path, row.node.start, row.node.count);
      }
    return { navKeys: keys, groupOf };
  }, [p.records, rows, grouped, limits]);
  const roving = useRovingFocus(navKeys);

  const draggable = !!p.onReorder && p.canEdit;
  const u: Ui = {
    p,
    roving,
    limits,
    showMore: (key, total) => setLimits((cur) => ({ ...cur, [key]: Math.min(total, (cur[key] ?? ROWS_PER_GROUP) + ROWS_PER_GROUP) })),
    draggable,
  };

  // The open record's row is drawn (its group may show only the first rows) and brought into view.
  const { reveal } = p;
  useEffect(() => {
    if (!reveal) return;
    const at = ids.indexOf(reveal);
    if (at < 0) return;
    const leaf = grouped ? leafNodes(roots).find((n) => at >= n.start && at < n.start + n.count) : null;
    const path = leaf?.path ?? "";
    const need = at - (leaf?.start ?? 0) + 1;
    setLimits((cur) => ((cur[path] ?? ROWS_PER_GROUP) >= need ? cur : { ...cur, [path]: Math.ceil(need / ROWS_PER_GROUP) * ROWS_PER_GROUP }));
  }, [reveal, ids, grouped, roots]);
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
  const reorder = (id: string, over: Parameters<typeof planDrop>[3], upward = false, neighbour?: string) => {
    const plan = planDrop(ids, roots, id, over, canSet);
    if (!plan) return undefined;
    // Up past the first row of a group lands after the last row of the one above, not before it.
    if (plan !== "blocked" && upward && neighbour && groupOf.get(neighbour) !== groupOf.get(id)) return p.onReorder?.(id, { ...plan, beforeId: undefined, afterId: neighbour });
    return p.onReorder?.(id, plan);
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
    const row = key.startsWith("r:");
    const id = key.slice(2);
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
        if (row) return;
        e.preventDefault();
        if (p.collapsed.has(id)) p.onToggle(id);
        else go(at + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!row) {
          if (!p.collapsed.has(id)) p.onToggle(id);
        } else if (grouped) {
          roving.focusKey(`g:${groupOf.get(id)}`);
        }
        break;
      case "Enter":
        if (!row) return;
        e.preventDefault();
        p.onOpen(id);
        break;
      case " ":
        if (!row || !sel) return;
        e.preventDefault();
        sel.toggle(id);
        break;
      case "Delete":
        if (!row || !p.canEdit || !p.onDelete) return;
        e.preventDefault();
        p.onDelete([id]);
        break;
    }
  };

  const body = !grouped ? (
    <div ref={roving.containerRef} role="list" aria-label="Records" onKeyDown={onKeyDown}>
      <Records node={null} indent={ROW_PAD} u={u} />
    </div>
  ) : (
    <div ref={roving.containerRef} role="tree" aria-label="Grouped records" onKeyDown={onKeyDown}>
      {rows.map((row) =>
        row.kind === "group" ? (
          <GroupHeading key={`g:${row.node.path}`} row={row} u={u} />
        ) : (
          <div key={`r:${row.node.path}`} role="group" aria-label={row.node.header.label}>
            <Records node={row.node} indent={ROW_PAD + (row.depth - 1) * LEVEL_PX + UNDER_CHEVRON} u={u} />
          </div>
        ),
      )}
    </div>
  );
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={finishDrag}>
      <DragCtx.Provider value={drag}>{body}</DragCtx.Provider>
    </DndContext>
  );
}
