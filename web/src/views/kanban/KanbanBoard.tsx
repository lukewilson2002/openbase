/**
 * The kanban board: stacks of cards with drag and drop (dnd-kit; pointer and keyboard). While a
 * card is dragged the board shows its own provisional card order (`drag.override`); a drop
 * reports a `DropPlan` to the host, which writes it optimistically. The provisional order stays
 * until the data changes (the optimistic update arrives) so the card never snaps back.
 *
 * Keyboard: Tab to a card, Space to pick it up, arrow keys to move between stacks and cards,
 * Space to drop, Escape to cancel; Enter opens the record.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, MoreHorizontal, Plus } from "lucide-react";
import type { Field, TableRecord } from "@/api/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import type { FormatCtx } from "@/lib/cells/format";
import { colorDotClass } from "@/lib/colors";
import { CardBody } from "../common/CardBody";
import { cardTitle, itemsLabel } from "../common/cardFields";
import { planDrop, type DropPlan, type Stack } from "./stacks";

const STACK_PREFIX = "stack:";
/** Cards rendered per stack before "Show more" (a stack can hold thousands). */
export const CARDS_PER_STACK = 50;

type Items = Record<string, string[]>;

export interface KanbanBoardProps {
  stacks: readonly Stack[];
  primary: Field | undefined;
  /** Fields shown on cards (already minus title, cover, description and hidden fields). */
  fields: readonly Field[];
  coverField?: Field;
  descriptionField?: Field;
  format: FormatCtx;
  emails: ReadonlyMap<string, string>;
  colors: Readonly<Record<string, string>>;
  canEdit: boolean;
  canConfigure: boolean;
  /** The view sorts: cards cannot be reordered by hand. */
  hasSorts: boolean;
  collapsed: ReadonlySet<string>;
  onToggleCollapse(key: string): void;
  onMoveStack(key: string, dir: -1 | 1): void;
  onDrop(plan: DropPlan): void;
  onAddCard(key: string): void;
  /** Adds a stack (a new choice of the stack field); omitted where that is not possible or allowed. */
  onAddStack?: (name: string) => Promise<void>;
  onOpen(recordId: string): void;
}

function findContainer(items: Items, id: UniqueIdentifier): string | undefined {
  if (typeof id === "string" && id.startsWith(STACK_PREFIX)) return id.slice(STACK_PREFIX.length);
  return Object.keys(items).find((k) => items[k]!.includes(id as string));
}

interface DragState {
  activeId: string | null;
  originKey: string | null;
  override: Items | null;
  /** The base items the override was made from; the override lapses once they change. */
  basis: Items | null;
}

const IDLE: DragState = { activeId: null, originKey: null, override: null, basis: null };

export function KanbanBoard(props: KanbanBoardProps) {
  const { stacks, hasSorts, onDrop } = props;
  const recordsById = useMemo(() => new Map(stacks.flatMap((s) => s.records.map((r) => [r.id, r] as const))), [stacks]);
  const baseItems = useMemo<Items>(() => Object.fromEntries(stacks.map((s) => [s.key, s.records.map((r) => r.id)])), [stacks]);
  const [drag, setDrag] = useState<DragState>(IDLE);
  const [shown, setShown] = useState<Record<string, number>>({});

  const override = drag.override && (drag.activeId || drag.basis === baseItems) ? drag.override : null;
  const items = override ?? baseItems;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const baseRef = useRef(baseItems);
  baseRef.current = baseItems;

  // A provisional order that never gets replaced (nothing changed) must not stick around.
  useEffect(() => {
    if (!drag.override || drag.activeId) return;
    const t = setTimeout(() => setDrag(IDLE), 2000);
    return () => clearTimeout(t);
  }, [drag]);

  // sortableKeyboardCoordinates also offers the card's own stack as a target, and that stack starts
  // left of and above its cards, so the first Left or Up press would only snap to the stack edge.
  // Leave it out: one press goes straight to the neighbouring stack or card.
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>((event, args) => {
    const { droppableContainers, active } = args.context;
    const own = active ? findContainer(itemsRef.current, active.id) : undefined;
    const ownId = own === undefined ? undefined : `${STACK_PREFIX}${own}`;
    const others = {
      getEnabled: () => droppableContainers.getEnabled().filter((c) => c.id !== ownId),
      get: (id: UniqueIdentifier) => droppableContainers.get(id),
    } as unknown as typeof droppableContainers;
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: others } });
  }, []);
  // A mouse drags once it moves a little. A finger has to press and hold a card first: moving
  // straight away is a swipe that scrolls the board (or a stack), not a drag of the cards it crosses.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setDrag({ activeId: id, originKey: findContainer(itemsRef.current, id) ?? null, override: itemsRef.current, basis: baseRef.current });
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const cur = itemsRef.current;
    const from = findContainer(cur, active.id);
    const to = findContainer(cur, over.id);
    if (!from || !to || from === to) return;
    const id = String(active.id);
    const target = cur[to]!;
    let at = target.length;
    if (!(typeof over.id === "string" && over.id.startsWith(STACK_PREFIX))) {
      const overIndex = target.indexOf(String(over.id));
      const translated = active.rect.current.translated;
      const below = !!translated && translated.top > over.rect.top + over.rect.height / 2;
      at = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
    }
    const next: Items = { ...cur, [from]: cur[from]!.filter((x) => x !== id), [to]: [...target.slice(0, at), id, ...target.slice(at)] };
    setDrag((d) => ({ ...d, override: next }));
  };

  const finish = (e: DragEndEvent | null) => {
    const origin = drag.originKey;
    const id = drag.activeId;
    if (!e || !e.over || !id || !origin) {
      setDrag(IDLE);
      return;
    }
    let cur = itemsRef.current;
    const to = findContainer(cur, id);
    if (!to) {
      setDrag(IDLE);
      return;
    }
    const overContainer = findContainer(cur, e.over.id);
    if (overContainer === to && !(typeof e.over.id === "string" && e.over.id.startsWith(STACK_PREFIX))) {
      const a = cur[to]!.indexOf(id);
      const o = cur[to]!.indexOf(String(e.over.id));
      if (a >= 0 && o >= 0 && a !== o) cur = { ...cur, [to]: arrayMove(cur[to]!, a, o) };
    }
    const plan = planDrop({ recordId: id, fromKey: origin, toKey: to, fromIds: baseRef.current[origin] ?? [], targetIds: cur[to]!, hasSorts });
    if (!plan) {
      setDrag(IDLE);
      return;
    }
    setDrag({ activeId: null, originKey: null, override: cur, basis: baseRef.current });
    onDrop(plan);
  };

  const activeRecord = drag.activeId ? recordsById.get(drag.activeId) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={finish} onDragCancel={() => setDrag(IDLE)}>
      <div className="flex h-full items-start gap-3 overflow-x-auto p-3 md:p-4" role="list" aria-label="Stacks">
        {stacks.map((stack, i) => (
          <StackColumn
            key={stack.key}
            stack={stack}
            index={i}
            count={stacks.length}
            ids={items[stack.key] ?? []}
            recordsById={recordsById}
            limit={shown[stack.key] ?? CARDS_PER_STACK}
            onShowMore={() => setShown((s) => ({ ...s, [stack.key]: (s[stack.key] ?? CARDS_PER_STACK) + CARDS_PER_STACK }))}
            activeId={drag.activeId}
            {...props}
          />
        ))}
        {props.onAddStack && <AddStack onAdd={props.onAddStack} />}
      </div>
      <DragOverlay>
        {activeRecord ? (
          <div data-drag-overlay className="relative cursor-grabbing overflow-hidden rounded-[10px] border border-primary bg-surface shadow-pop">
            <CardBody record={activeRecord} primary={props.primary} fields={props.fields} coverField={props.coverField} descriptionField={props.descriptionField} format={props.format} emails={props.emails} color={props.colors[activeRecord.id]} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface StackColumnProps extends KanbanBoardProps {
  stack: Stack;
  index: number;
  count: number;
  ids: string[];
  recordsById: ReadonlyMap<string, TableRecord>;
  limit: number;
  onShowMore(): void;
  activeId: string | null;
}

function StackColumn({ stack, index, count, ids, recordsById, limit, onShowMore, activeId, ...p }: StackColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${STACK_PREFIX}${stack.key}` });
  const isCollapsed = p.collapsed.has(stack.key);
  const visible = ids.slice(0, limit);
  if (activeId && ids.includes(activeId) && !visible.includes(activeId)) visible.push(activeId);
  const hidden = ids.length - visible.length;

  const header = (
    <div className="flex min-h-8 items-center gap-2 pl-1.5 pr-0.5">
      {stack.color && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", colorDotClass(stack.color))} />}
      <h2 className="min-w-0 flex-1 truncate text-[0.875rem] font-[650]">{stack.label}</h2>
      {isCollapsed && (
        <button
          type="button"
          aria-expanded={false}
          aria-label={`Expand ${stack.label}`}
          onClick={() => p.onToggleCollapse(stack.key)}
          className="inline-flex size-[30px] items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"
        >
          <ChevronDown aria-hidden className="size-4 -rotate-90" />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Options for ${stack.label}`} className="inline-flex size-[30px] items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover pointer-coarse:size-11">
            <MoreHorizontal aria-hidden className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => p.onToggleCollapse(stack.key)}>
            <ChevronsDownUp aria-hidden className="size-4" /> {isCollapsed ? "Expand stack" : "Collapse stack"}
          </DropdownMenuItem>
          {p.canConfigure && (
            <>
              <DropdownMenuItem disabled={index === 0} onSelect={() => p.onMoveStack(stack.key, -1)}>
                <ChevronLeft aria-hidden className="size-4" /> Move left
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === count - 1} onSelect={() => p.onMoveStack(stack.key, 1)}>
                <ChevronRight aria-hidden className="size-4" /> Move right
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const foot = (
    <div className="flex min-h-9 items-center justify-between gap-2">
      {p.canEdit && !isCollapsed ? (
        <button
          type="button"
          aria-label={`Add card to ${stack.label}`}
          onClick={() => p.onAddCard(stack.key)}
          className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[0.875rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          <Plus aria-hidden className="size-[15px]" /> Add
        </button>
      ) : (
        <span />
      )}
      <span className="pr-2 text-[0.8125rem] text-muted">{itemsLabel(ids.length)}</span>
    </div>
  );

  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={`Stack: ${stack.label}`}
      data-stack-key={stack.key}
      className={cn(
        "flex max-h-full shrink-0 flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--line)_40%,var(--bg))] p-2 outline-2 -outline-offset-2 transition-[outline-color]",
        isCollapsed ? "w-48" : "w-[min(280px,85vw)]",
        isOver ? "outline-primary" : "outline-transparent",
      )}
    >
      {header}
      {!isCollapsed && (
        <>
          <SortableContext items={visible} strategy={verticalListSortingStrategy}>
            <div role="group" className="-mx-1 flex min-h-10 flex-col gap-2 overflow-y-auto px-1 py-px" aria-label={`Cards in ${stack.label}`}>
              {visible.map((id) => {
                const rec = recordsById.get(id);
                return rec ? <KanbanCard key={id} record={rec} {...p} /> : null;
              })}
              {ids.length === 0 && <p className="px-2 py-2 text-center text-xs text-faint">No cards</p>}
            </div>
          </SortableContext>
          {hidden > 0 && (
            <button type="button" onClick={onShowMore} className="rounded-lg py-1.5 text-xs text-muted hover:bg-hover">
              Show {Math.min(hidden, CARDS_PER_STACK)} more ({hidden} hidden)
            </button>
          )}
        </>
      )}
      {foot}
    </section>
  );
}

/** "+ Add a stack" after the last stack: a new choice of the stack field, named in place. */
function AddStack({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[0.875rem] text-muted hover:bg-hover hover:text-fg"
      >
        <Plus aria-hidden className="size-[15px]" /> Add a stack
      </button>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onAdd(n);
      setName("");
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex w-[min(280px,85vw)] shrink-0 flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--line)_40%,var(--bg))] p-2">
      <Input
        autoFocus
        aria-label="Name of the new stack"
        placeholder="Stack name"
        value={name}
        maxLength={255}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!name.trim()}>
          Add stack
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function KanbanCard({ record, ...p }: { record: TableRecord } & KanbanBoardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: record.id, disabled: !p.canEdit });
  const title = cardTitle(p.primary, record, p.format);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    (listeners?.onKeyDown as ((ev: KeyboardEvent<HTMLDivElement>) => void) | undefined)?.(e);
    if (!e.defaultPrevented && e.key === "Enter") {
      e.preventDefault();
      p.onOpen(record.id);
    }
  };
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      aria-label={title}
      aria-roledescription={p.canEdit ? "draggable card" : "card"}
      data-record-id={record.id}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Links inside a card (urls, emails) keep their own behaviour.
        if (!(e.target as HTMLElement).closest("a")) p.onOpen(record.id);
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[10px] border border-line bg-surface text-left shadow-[0_1px_2px_rgb(15_20_30/0.04)] outline-none transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)] focus-visible:outline-2 focus-visible:outline-ring",
        // Press and hold starts a drag on touch screens: no text selection or iOS callout on the way.
        p.canEdit ? "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]" : "cursor-pointer",
        isDragging && "opacity-40",
      )}
    >
      <CardBody record={record} primary={p.primary} fields={p.fields} coverField={p.coverField} descriptionField={p.descriptionField} format={p.format} emails={p.emails} color={p.colors[record.id]} />
    </div>
  );
}
