/**
 * The kanban board: stacks of cards with drag and drop (dnd-kit; pointer and keyboard). While a
 * card is dragged the board shows its own provisional card order (`drag.override`); a drop
 * reports a `DropPlan` to the host, which writes it optimistically. The provisional order stays
 * until the data changes (the optimistic update arrives) so the card never snaps back.
 *
 * Stacks are dragged by their header (one save per drop, see `onReorderStacks`). While a card is
 * dragged an empty "Uncategorized" stack is offered when the board has none, so a drop can clear the value.
 *
 * Cards: click opens, Ctrl/Cmd-click and Shift-click select (the tick box does on a touch screen), and the
 * selection can be moved to a stack, duplicated or deleted from the bar, the Delete key or the card's menu
 * (right-click, or the menu key).
 *
 * Keyboard: one card is the tab stop and the arrow keys move between cards and stacks (Home and End go to
 * the first and last card of a stack), Space picks a card up, the arrows move it between stacks and cards,
 * Space drops it and Escape cancels; Enter opens the record, X selects it, Delete deletes it. Keys on a link
 * inside a card are the link's own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, CopyPlus, EyeOff, Eye, Maximize2, MoreHorizontal, MoveRight, Palette, Pencil, Plus, SquareCheck, Trash2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import type { Field, TableRecord } from "@/api/types";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import type { FormatCtx } from "@/lib/cells/format";
import { accentHue } from "@/lib/colors";
import { CardBody } from "../common/CardBody";
import { cardTitle, itemsLabel } from "../common/cardFields";
import { SelectionBar } from "../common/SelectionBar";
import { useRecordSelection, type RecordSelection } from "../common/useRecordSelection";
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
  /** Most fields a card shows (the non-empty ones); the card's default when omitted. */
  cardLimit?: number;
  /** How a cover fills its box: crop to fill, or fit inside. */
  coverFit?: "cover" | "contain";
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
  /** Stacks dragged into a new order: the keys of the shown stacks, left to right. Omitted: headers do not drag. */
  onReorderStacks?: (keys: string[]) => void;
  onDrop(plan: DropPlan): void;
  onAddCard(key: string): void;
  /** Filled with a function giving the stack the toolbar's Add adds to: the focused card's, the selection's, else the first one in view (null: none to say). */
  addTargetRef?: MutableRefObject<(() => string | null) | null>;
  /** Adds a stack (a new choice of the stack field); omitted where that is not possible or allowed. */
  onAddStack?: (name: string) => Promise<void>;
  /** Why a stack cannot be added here, shown where the add button would be. */
  addStackNote?: string;
  /** Leave a stack off the board (this view only); omitted when the person may not change the view. */
  onHideStack?: (key: string) => void;
  /** Stacks the view hides, to bring back. */
  hiddenStacks?: readonly Stack[];
  onShowStack?: (key: string) => void;
  /** Rename, recolour or delete the choice a stack stands for; omitted for fields without choices or for people who may not edit them. */
  onRenameStack?: (key: string, name: string) => Promise<void>;
  onColorStack?: (key: string, color: string) => Promise<void>;
  onDeleteStack?: (key: string) => Promise<void>;
  /** Name of the stack field, for what a drop on the empty Uncategorized stack clears. */
  fieldName?: string;
  /** The empty Uncategorized stack offered while a card is dragged (see `clearStack`). */
  clearStack?: Stack | null;
  onOpen(recordId: string): void;
  /** Delete records (a confirmation for several is the host's); `done` clears the selection. */
  onDeleteRecords(ids: string[], done?: () => void): void;
  onDuplicateRecords(ids: string[], done?: () => void): void;
  onMoveRecords(ids: string[], stackKey: string, done?: () => void): void;
}

const isStackId = (id: UniqueIdentifier): id is string => typeof id === "string" && id.startsWith(STACK_PREFIX);

function findContainer(items: Items, id: UniqueIdentifier): string | undefined {
  if (isStackId(id)) return id.slice(STACK_PREFIX.length);
  return Object.keys(items).find((k) => items[k]!.includes(String(id)));
}

interface DragState {
  activeId: string | null;
  originKey: string | null;
  override: Items | null;
  /** The base items the override was made from; the override lapses once they change. */
  basis: Items | null;
}

const IDLE: DragState = { activeId: null, originKey: null, override: null, basis: null };

/** Stacks compete with stacks while a header is dragged, cards with cards and stacks while a card is. */
const collision: CollisionDetection = (args) => {
  if (isStackId(args.active.id)) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => isStackId(c.id)) });
  return closestCorners(args);
};

const SCREEN_READER_INSTRUCTIONS =
  "To pick up a card, press Space. Then use the arrow keys to move it between stacks and cards, Space to drop it, or Escape to cancel. Enter opens the card, X selects it and Delete deletes it.";

/** Cards of a stack's column, for the arrow keys. */
function cardsOf(stack: Element): HTMLElement[] {
  return [...stack.querySelectorAll<HTMLElement>("[data-record-id]")];
}

/** The card an arrow key moves to from `card`, or null at an edge. */
function neighbourCard(card: HTMLElement, key: string): HTMLElement | null {
  const stack = card.closest<HTMLElement>("[data-stack-key]");
  if (!stack) return null;
  const cards = cardsOf(stack);
  const at = cards.indexOf(card);
  switch (key) {
    case "ArrowDown":
      return cards[at + 1] ?? null;
    case "ArrowUp":
      return cards[at - 1] ?? null;
    case "Home":
      return cards[0] ?? null;
    case "End":
      return cards[cards.length - 1] ?? null;
    case "ArrowLeft":
    case "ArrowRight": {
      // The next stack that has cards, at the same height.
      for (let s = key === "ArrowLeft" ? stack.previousElementSibling : stack.nextElementSibling; s; s = key === "ArrowLeft" ? s.previousElementSibling : s.nextElementSibling) {
        const there = cardsOf(s);
        if (there.length > 0) return there[Math.min(at, there.length - 1)] ?? null;
      }
      return null;
    }
    default:
      return null;
  }
}

export function KanbanBoard(props: KanbanBoardProps) {
  const { stacks, hasSorts, onDrop, clearStack } = props;
  const [orderOverride, setOrderOverride] = useState<{ keys: string[]; basis: readonly Stack[] } | null>(null);
  // Dropped headers stay in their new places until the saved order comes back (the stacks then are new ones).
  const shownStacks = useMemo(() => {
    if (!orderOverride || orderOverride.basis !== stacks) return stacks;
    const byKey = new Map(stacks.map((s) => [s.key, s] as const));
    return orderOverride.keys.map((k) => byKey.get(k)).filter((s): s is Stack => !!s);
  }, [stacks, orderOverride]);
  const recordsById = useMemo(() => new Map(stacks.flatMap((s) => s.records.map((r) => [r.id, r] as const))), [stacks]);
  const baseItems = useMemo<Items>(() => Object.fromEntries([...stacks, ...(clearStack ? [clearStack] : [])].map((s) => [s.key, s.records.map((r) => r.id)])), [stacks, clearStack]);
  const [drag, setDrag] = useState<DragState>(IDLE);
  const [shown, setShown] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; id: string } | null>(null);

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

  // --- Selection and the tab stop ---------------------------------------------------------------

  const orderedIds = useMemo(() => shownStacks.flatMap((s) => s.records.map((r) => r.id)), [shownStacks]);
  const sel = useRecordSelection(orderedIds);
  const [tabStop, setTabStop] = useState<string | null>(null);
  // One card is the tab stop: the one last focused, else the first. Only cards that are drawn count: a
  // collapsed stack or one cut off by "Show more" has none, and a tab stop nobody can reach loses the board.
  const drawnIds = useMemo(
    () => shownStacks.flatMap((s) => (props.collapsed.has(s.key) ? [] : (items[s.key] ?? []).slice(0, shown[s.key] ?? CARDS_PER_STACK))),
    [shownStacks, props.collapsed, items, shown],
  );
  const stopId = tabStop !== null && drawnIds.includes(tabStop) ? tabStop : (drawnIds[0] ?? null);

  const deleteSelected = () => props.onDeleteRecords([...sel.ids], sel.clear);
  const onBoardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Menus and dialogs are drawn elsewhere in the page but their keys bubble through here.
    // While a card is carried, Escape cancels the drag and nothing else.
    if (!props.canEdit || drag.activeId || !e.currentTarget.contains(e.target as Node)) return;
    sel.handleKeyDown(e, { onDelete: deleteSelected });
  };

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

  // What a screen reader hears while a card or a stack is dragged: titles and stack names, not ids.
  const { primary, format } = props;
  const announcements = useMemo<Announcements>(() => {
    const labelOf = new Map([...stacks, ...(clearStack ? [clearStack] : [])].map((s) => [s.key, s.label] as const));
    const stackName = (key: string | undefined) => (key === undefined ? "a stack" : `the ${labelOf.get(key) ?? "unknown"} stack`);
    const titleOf = (id: UniqueIdentifier) => {
      const rec = recordsById.get(String(id));
      return rec ? cardTitle(primary, rec, format) : "the card";
    };
    const stackLabel = (id: UniqueIdentifier) => (labelOf.get(String(id).slice(STACK_PREFIX.length)) ?? "the stack");
    const where = (id: UniqueIdentifier, over: UniqueIdentifier | undefined): string => {
      const cur = itemsRef.current;
      const container = over === undefined ? findContainer(cur, id) : findContainer(cur, over);
      if (container === undefined) return "";
      const list = cur[container] ?? [];
      const at = list.indexOf(String(id));
      const overAt = over !== undefined && !isStackId(over) ? list.indexOf(String(over)) : -1;
      const pos = at >= 0 ? at : overAt;
      // dnd-kit announces before the provisional order has the card in its new stack.
      const total = at >= 0 ? list.length : list.length + 1;
      return pos >= 0 ? `${stackName(container)}, position ${pos + 1} of ${total}` : stackName(container);
    };
    return {
      onDragStart: ({ active }) => (isStackId(active.id) ? `Picked up the ${stackLabel(active.id)} stack.` : `Picked up ${titleOf(active.id)}, in ${where(active.id, undefined)}.`),
      onDragOver: ({ active, over }) => {
        // Right after pick-up dnd-kit reports the card over itself; saying so would drown "Picked up".
        if (!over || over.id === active.id) return undefined;
        if (isStackId(active.id)) return isStackId(over.id) && over.id !== active.id ? `The ${stackLabel(active.id)} stack is over the ${stackLabel(over.id)} stack.` : undefined;
        return `${titleOf(active.id)} is over ${where(active.id, over.id)}.`;
      },
      onDragEnd: ({ active, over }) => {
        if (isStackId(active.id)) return over ? `Dropped the ${stackLabel(active.id)} stack on the ${stackLabel(over.id)} stack.` : `The ${stackLabel(active.id)} stack was dropped where it was.`;
        return over ? `Dropped ${titleOf(active.id)} in ${where(active.id, over.id)}.` : `${titleOf(active.id)} was dropped where it was.`;
      },
      onDragCancel: ({ active }) => (isStackId(active.id) ? `Moving the ${stackLabel(active.id)} stack was cancelled.` : `Moving ${titleOf(active.id)} was cancelled.`),
    };
  }, [stacks, clearStack, recordsById, primary, format]);

  const onDragStart = (e: DragStartEvent) => {
    if (isStackId(e.active.id)) return;
    const id = String(e.active.id);
    setDrag({ activeId: id, originKey: findContainer(itemsRef.current, id) ?? null, override: itemsRef.current, basis: baseRef.current });
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || isStackId(active.id)) return;
    const cur = itemsRef.current;
    const from = findContainer(cur, active.id);
    const to = findContainer(cur, over.id);
    if (from === undefined || to === undefined || from === to) return;
    const id = String(active.id);
    const target = cur[to]!;
    let at = target.length;
    if (!isStackId(over.id)) {
      const overIndex = target.indexOf(String(over.id));
      const translated = active.rect.current.translated;
      const below = !!translated && translated.top > over.rect.top + over.rect.height / 2;
      at = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;
    }
    const next: Items = { ...cur, [from]: cur[from]!.filter((x) => x !== id), [to]: [...target.slice(0, at), id, ...target.slice(at)] };
    setDrag((d) => ({ ...d, override: next }));
  };

  const finishStack = (e: DragEndEvent) => {
    if (!e.over || !isStackId(e.active.id) || !isStackId(e.over.id) || e.over.id === e.active.id) return;
    const keys = shownStacks.map((s) => s.key);
    const from = keys.indexOf(e.active.id.slice(STACK_PREFIX.length));
    const to = keys.indexOf(e.over.id.slice(STACK_PREFIX.length));
    if (from < 0 || to < 0) return;
    const next = arrayMove(keys, from, to);
    setOrderOverride({ keys: next, basis: stacks });
    props.onReorderStacks?.(next);
  };

  const finish = (e: DragEndEvent | null) => {
    if (e && isStackId(e.active.id)) return finishStack(e);
    const origin = drag.originKey;
    const id = drag.activeId;
    if (!e || !e.over || !id || origin === null) {
      setDrag(IDLE);
      return;
    }
    let cur = itemsRef.current;
    const to = findContainer(cur, id);
    if (to === undefined) {
      setDrag(IDLE);
      return;
    }
    const overContainer = findContainer(cur, e.over.id);
    if (overContainer === to && !isStackId(e.over.id)) {
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
  const reorderable = !!props.onReorderStacks && props.canConfigure && shownStacks.length > 1;

  // --- The card's menu and the bulk actions ------------------------------------------------------

  const menuRecord = menu ? recordsById.get(menu.id) : undefined;
  /** What a bulk action on `id` acts on: the selection when the card is in it, else the card. */
  const targetsOf = (id: string): string[] => (sel.has(id) ? [...sel.ids] : [id]);
  const moveTargets = [...shownStacks, ...(clearStack ? [clearStack] : [])];

  const listRef = useRef<HTMLDivElement>(null);
  const lastStack = useRef<string | null>(null);
  const { addTargetRef } = props;
  useEffect(() => {
    if (!addTargetRef) return;
    addTargetRef.current = () => {
      const list = listRef.current;
      if (!list) return null;
      const keyOf = (el: Element | null | undefined) => el?.closest<HTMLElement>("[data-stack-key]")?.dataset.stackKey ?? null;
      // The stack focus last was in (pressing the toolbar's Add moves it away), if it is still drawn.
      const focused = lastStack.current !== null ? [...list.querySelectorAll<HTMLElement>("[data-stack-key]")].find((el) => el.dataset.stackKey === lastStack.current) : undefined;
      if (focused) return lastStack.current;
      for (const id of sel.ids) {
        const card = [...list.querySelectorAll<HTMLElement>("[data-record-id]")].find((el) => el.dataset.recordId === id);
        const key = keyOf(card);
        if (key !== null) return key;
      }
      // The first stack whose right edge is still on screen.
      const left = list.getBoundingClientRect().left;
      for (const stack of list.querySelectorAll<HTMLElement>("[data-stack-key]")) {
        if (stack.getBoundingClientRect().right >= left) return stack.dataset.stackKey ?? null;
      }
      return null;
    };
    return () => {
      addTargetRef.current = null;
    };
  });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={finish}
      onDragCancel={() => setDrag(IDLE)}
      accessibility={{ announcements, screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS } }}
    >
      <div className="relative h-full">
        <div ref={listRef} className="flex h-full items-start gap-3 overflow-x-auto p-3 md:p-4" role="list" aria-label="Stacks" onKeyDown={onBoardKeyDown} onFocus={(e) => { lastStack.current = e.target.closest<HTMLElement>("[data-stack-key]")?.dataset.stackKey ?? lastStack.current; }}>
          <SortableContext items={shownStacks.map((s) => `${STACK_PREFIX}${s.key}`)} strategy={horizontalListSortingStrategy}>
            {shownStacks.map((stack, i) => (
              <StackColumn
                key={stack.key}
                stack={stack}
                index={i}
                count={shownStacks.length}
                ids={items[stack.key] ?? []}
                recordsById={recordsById}
                limit={shown[stack.key] ?? CARDS_PER_STACK}
                onShowMore={() => setShown((s) => ({ ...s, [stack.key]: (s[stack.key] ?? CARDS_PER_STACK) + CARDS_PER_STACK }))}
                activeId={drag.activeId}
                reorderable={reorderable}
                selection={sel}
                stopId={stopId}
                onFocusCard={setTabStop}
                onCardMenu={(id, anchor) => setMenu({ id, anchor })}
                {...props}
              />
            ))}
          </SortableContext>
          {drag.activeId && clearStack && <ClearStack stack={clearStack} fieldName={props.fieldName} ids={items[clearStack.key] ?? []} />}
          {props.onAddStack ? <AddStack onAdd={props.onAddStack} /> : props.addStackNote ? <p className="w-44 shrink-0 self-start px-2 py-2.5 text-xs text-muted">{props.addStackNote}</p> : null}
          {props.hiddenStacks && props.hiddenStacks.length > 0 && props.onShowStack && <HiddenStacks stacks={props.hiddenStacks} onShow={props.onShowStack} />}
        </div>
        {sel.count > 0 && (
          <SelectionBar
            count={sel.count}
            onDuplicate={() => props.onDuplicateRecords([...sel.ids], sel.clear)}
            onDelete={deleteSelected}
            onClear={sel.clear}
          >
            {moveTargets.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <MoveRight aria-hidden className="size-4" /> Move to
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" side="top" className="max-h-[min(20rem,var(--ob-avail))]">
                  <DropdownMenuLabel>Move {sel.count.toLocaleString()} to</DropdownMenuLabel>
                  {moveTargets.map((s) => (
                    <DropdownMenuItem key={s.key} onSelect={() => props.onMoveRecords([...sel.ids], s.key, sel.clear)}>
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </SelectionBar>
        )}
      </div>
      {menu && menuRecord && (
        <CardMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          count={targetsOf(menu.id).length}
          selected={sel.has(menu.id)}
          canEdit={props.canEdit}
          stacks={moveTargets}
          currentKey={Object.keys(items).find((k) => items[k]!.includes(menu.id))}
          onOpen={() => props.onOpen(menu.id)}
          onToggleSelect={() => sel.toggle(menu.id)}
          onDuplicate={() => props.onDuplicateRecords(targetsOf(menu.id), sel.clear)}
          onDelete={() => props.onDeleteRecords(targetsOf(menu.id), sel.clear)}
          onMove={(key) => props.onMoveRecords(targetsOf(menu.id), key, sel.clear)}
        />
      )}
      <DragOverlay>
        {activeRecord ? (
          <div data-drag-overlay className="relative cursor-grabbing overflow-hidden rounded-[10px] border border-primary bg-surface shadow-pop">
            <CardBody
              record={activeRecord}
              primary={props.primary}
              fields={props.fields}
              coverField={props.coverField}
              descriptionField={props.descriptionField}
              coverFit={props.coverFit}
              limit={props.cardLimit}
              format={props.format}
              emails={props.emails}
              color={props.colors[activeRecord.id]}
            />
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
  /** Headers can be dragged to reorder the stacks. */
  reorderable: boolean;
  selection: RecordSelection;
  stopId: string | null;
  onFocusCard(id: string): void;
  onCardMenu(id: string, anchor: MenuAnchor): void;
}

type StackDialog = "rename" | "colour" | "delete";

function StackColumn({ stack, index, count, ids, recordsById, limit, onShowMore, activeId, reorderable, selection, stopId, onFocusCard, onCardMenu, ...p }: StackColumnProps) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging, isOver } = useSortable({
    id: `${STACK_PREFIX}${stack.key}`,
    // Cards still drop on a stack that cannot itself be dragged.
    disabled: { draggable: !reorderable },
    // The column lands where it was dropped; no animation between the drop and the saved order.
    animateLayoutChanges: () => false,
  });
  const [dialog, setDialog] = useState<StackDialog | null>(null);
  const isCollapsed = p.collapsed.has(stack.key);
  const visible = ids.slice(0, limit);
  if (activeId && ids.includes(activeId) && !visible.includes(activeId)) visible.push(activeId);
  const hidden = ids.length - visible.length;
  // Only a stack that is a choice of a select field has a name and a colour of its own.
  const isChoice = !stack.uncategorized && !!p.onRenameStack;

  const header = (
    <div ref={setActivatorNodeRef} {...(reorderable ? listeners : {})} className={cn("flex min-h-8 items-center gap-2 pl-1.5 pr-0.5", reorderable && "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]", isDragging && "cursor-grabbing")}>
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
              {p.onHideStack && (
                <DropdownMenuItem onSelect={() => p.onHideStack?.(stack.key)}>
                  <EyeOff aria-hidden className="size-4" /> Hide stack
                </DropdownMenuItem>
              )}
            </>
          )}
          {isChoice && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                <Pencil aria-hidden className="size-4" /> Rename stack
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("colour")}>
                <Palette aria-hidden className="size-4" /> Change colour
              </DropdownMenuItem>
              {p.onDeleteStack && (
                <DropdownMenuItem danger onSelect={() => setDialog("delete")}>
                  <Trash2 aria-hidden className="size-4" /> Delete stack
                </DropdownMenuItem>
              )}
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
          className="group/add flex h-9 items-center gap-1.5 rounded-lg px-2 text-[0.875rem] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          {/* Quiet until the button is pointed at or focused (always shown on touch, which cannot hover). */}
          <span className="flex items-center gap-1.5 opacity-50 transition-opacity group-hover/add:opacity-100 group-focus-visible/add:opacity-100 pointer-coarse:opacity-100">
            <Plus aria-hidden className="size-[15px]" /> Add
          </span>
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
      style={{ transform: CSS.Translate.toString(transform), transition: transform ? transition : undefined, zIndex: isDragging ? 20 : undefined }}
      className={cn(
        "flex max-h-full shrink-0 flex-col gap-2 rounded-xl p-2 outline-2 -outline-offset-2 transition-[outline-color]",
        // A coloured choice fills its stack with its colour (no dot needed); the rest stay neutral.
        stack.color ? `ob-hue-${accentHue(stack.color)} ob-fill` : "bg-[color-mix(in_srgb,var(--line)_40%,var(--bg))]",
        isCollapsed ? "w-48" : "w-[min(280px,85vw)]",
        isOver ? "outline-primary" : "outline-transparent",
        isDragging && "opacity-80 shadow-pop",
      )}
    >
      {header}
      {!isCollapsed && (
        <>
          <SortableContext items={visible} strategy={verticalListSortingStrategy}>
            <div role="group" className="-mx-1 flex min-h-10 flex-col gap-2 overflow-y-auto px-1 py-px" aria-label={`Cards in ${stack.label}`}>
              {visible.map((id) => {
                const rec = recordsById.get(id);
                return rec ? <KanbanCard key={id} record={rec} selection={selection} tabStop={id === stopId} onFocusCard={onFocusCard} onCardMenu={onCardMenu} {...p} /> : null;
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
      {dialog === "rename" && p.onRenameStack && <RenameStack stack={stack} onClose={() => setDialog(null)} onSave={(name) => p.onRenameStack!(stack.key, name)} />}
      {dialog === "colour" && p.onColorStack && <ColourStack stack={stack} onClose={() => setDialog(null)} onPick={(color) => p.onColorStack!(stack.key, color)} />}
      {dialog === "delete" && p.onDeleteStack && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={`Delete the stack "${stack.label}"?`}
          description={deleteStackText(stack, p.fieldName)}
          confirmLabel="Delete stack"
          destructive
          onConfirm={() => p.onDeleteStack!(stack.key)}
        />
      )}
    </section>
  );
}

/** What deleting a stack does, in plain words: the option goes from the field, its cards lose the value. */
export function deleteStackText(stack: Pick<Stack, "label" | "records">, fieldName = "the field"): string {
  const n = stack.records.length;
  const cards = n === 0 ? "No cards here use it." : `The ${n === 1 ? "card" : `${n.toLocaleString()} cards`} in this stack will keep ${n === 1 ? "its" : "their"} other values but have no ${fieldName} value, so ${n === 1 ? "it moves" : "they move"} to Uncategorized.`;
  return `This removes "${stack.label}" as an option of ${fieldName} in every view of the table. ${cards} Cards elsewhere that use it lose it as well.`;
}

function RenameStack({ stack, onClose, onSave }: { stack: Stack; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(stack.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || busy) return;
    if (trimmed === stack.label) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Rename stack" description="This renames the option in the field, so it changes everywhere the field is used." size="sm">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Input autoFocus aria-label="Stack name" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        {error && (
          <p role="alert" className="text-[0.8125rem] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!trimmed}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ColourStack({ stack, onClose, onPick }: { stack: Stack; onClose: () => void; onPick: (color: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const pick = async (color: string) => {
    if (color === stack.color) return onClose();
    setError(null);
    try {
      await onPick(color);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Colour of ${stack.label}`} description="This colours the option in the field, so it changes everywhere the field is used." size="sm">
      <ColorSwatchPicker value={stack.color} onChange={(c) => void pick(c)} label={`Colour of ${stack.label}`} />
      {error && (
        <p role="alert" className="mt-3 text-[0.8125rem] text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The empty Uncategorized stack that shows while a card is dragged: a drop here clears the card's value. */
function ClearStack({ stack, fieldName, ids }: { stack: Stack; fieldName?: string; ids: string[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${STACK_PREFIX}${stack.key}` });
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={`Stack: ${stack.label}`}
      data-stack-key={stack.key}
      className={cn(
        "flex min-h-24 w-[min(280px,85vw)] shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-3 text-center text-[0.8125rem] text-muted",
        isOver ? "border-primary bg-primary-soft" : "border-line-strong",
      )}
    >
      <h2 className="font-[650] text-fg">{stack.label}</h2>
      <p className="text-xs">{fieldName ? `Drop a card here to clear its ${fieldName}.` : "Drop a card here to clear its value."}</p>
      {ids.length > 0 && <p className="text-xs">{itemsLabel(ids.length)}</p>}
    </section>
  );
}

/** "N hidden stacks" after the last stack: brings them back one at a time. */
function HiddenStacks({ stacks, onShow }: { stacks: readonly Stack[]; onShow: (key: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[0.875rem] text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
          <Eye aria-hidden className="size-[15px]" /> {stacks.length === 1 ? "1 hidden stack" : `${stacks.length} hidden stacks`}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--ob-avail))]">
        {stacks.map((s) => (
          <DropdownMenuItem key={s.key} onSelect={() => onShow(s.key)}>
            Show {s.label} <span className="ml-auto pl-3 text-xs text-muted">{itemsLabel(s.records.length)}</span>
          </DropdownMenuItem>
        ))}
        {stacks.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => stacks.forEach((s) => onShow(s.key))}>Show all</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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

/** The menu of a card (right-click or the menu key): open it, select it, move it to a stack, copy it, delete it. */
function CardMenu({
  anchor,
  onClose,
  count,
  selected,
  canEdit,
  stacks,
  currentKey,
  onOpen,
  onToggleSelect,
  onDuplicate,
  onDelete,
  onMove,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
  /** Cards Duplicate, Delete and Move act on: the selection when the card is in it, else the card. */
  count: number;
  selected: boolean;
  canEdit: boolean;
  stacks: readonly Pick<Stack, "key" | "label">[];
  currentKey: string | undefined;
  onOpen: () => void;
  onToggleSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (key: string) => void;
}) {
  const many = count > 1;
  return (
    <AnchoredMenu anchor={anchor} onClose={onClose} label="Card menu">
      <DropdownMenuItem onSelect={onOpen}>
        <Maximize2 aria-hidden className="size-4" /> Open record
      </DropdownMenuItem>
      {canEdit && (
        <>
          <DropdownMenuItem onSelect={onToggleSelect}>
            <SquareCheck aria-hidden className="size-4" /> {selected ? "Deselect" : "Select"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {stacks.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <MoveRight aria-hidden className="size-4" /> Move to stack
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[min(20rem,var(--ob-avail))]">
                {stacks.map((s) => (
                  <DropdownMenuItem key={s.key} disabled={!many && s.key === currentKey} onSelect={() => onMove(s.key)}>
                    {s.key === currentKey && !many && <Check aria-hidden className="size-3.5" />} {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem onSelect={onDuplicate}>
            <CopyPlus aria-hidden className="size-4" /> Duplicate {many ? `${count} records` : "record"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={onDelete}>
            <Trash2 aria-hidden className="size-4" /> Delete {many ? `${count} records` : "record"}
          </DropdownMenuItem>
        </>
      )}
    </AnchoredMenu>
  );
}

function KanbanCard({
  record,
  selection: sel,
  tabStop,
  onFocusCard,
  onCardMenu,
  ...p
}: { record: TableRecord; selection: RecordSelection; tabStop: boolean; onFocusCard(id: string): void; onCardMenu(id: string, anchor: MenuAnchor): void } & KanbanBoardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: record.id, disabled: !p.canEdit });
  const title = cardTitle(p.primary, record, p.format);
  const selected = sel.has(record.id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    (listeners?.onKeyDown as ((ev: KeyboardEvent<HTMLDivElement>) => void) | undefined)?.(e);
    // Keys pressed on a link or button inside the card are that element's own (Enter follows the link).
    if (e.defaultPrevented || e.target !== e.currentTarget || isDragging) return;
    if (e.key === "Enter") {
      e.preventDefault();
      p.onOpen(record.id);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      const next = neighbourCard(e.currentTarget, e.key);
      e.preventDefault();
      next?.focus();
    } else if (p.canEdit && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      sel.toggle(record.id);
    } else if (p.canEdit && e.key === "Delete" && sel.count === 0) {
      // With a selection the board's Delete handler asks about all of it.
      e.preventDefault();
      // Focus stays on the board: the card below it, else the one above, takes over.
      (neighbourCard(e.currentTarget, "ArrowDown") ?? neighbourCard(e.currentTarget, "ArrowUp"))?.focus();
      p.onDeleteRecords([record.id]);
    }
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Links inside a card (urls, emails) keep their own behaviour.
    if (target.closest("a")) return;
    if (p.canEdit && target.closest("[data-select-tick]")) {
      sel.toggle(record.id);
      return;
    }
    if (p.canEdit && sel.handleClick(record.id, e)) return;
    p.onOpen(record.id);
  };
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={tabStop ? 0 : -1}
      aria-label={title}
      aria-roledescription={p.canEdit ? "draggable card" : "card"}
      // Once something is selected every card says whether it is part of it.
      aria-pressed={isDragging ? true : sel.count > 0 ? selected : undefined}
      // Without edit rights the card still opens, so it is not "disabled" (dnd-kit says so).
      aria-disabled={undefined}
      data-record-id={record.id}
      data-selected={selected || undefined}
      onFocus={() => onFocusCard(record.id)}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onCardMenu(record.id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY, width: 1, height: 1 } : { x: r.left + 12, y: r.top + 12, width: 1, height: 1 });
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative shrink-0 overflow-hidden rounded-[10px] border border-line bg-surface text-left shadow-[0_1px_2px_rgb(15_20_30/0.04)] outline-none transition-[border-color,box-shadow] hover:border-primary-soft-line hover:shadow-[0_4px_12px_rgb(15_20_30/0.08)] focus-visible:outline-2 focus-visible:outline-ring",
        // Press and hold starts a drag on touch screens: no text selection or iOS callout on the way.
        p.canEdit ? "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]" : "cursor-pointer",
        selected && "border-primary ring-2 ring-primary",
        isDragging && "opacity-40",
      )}
    >
      {p.canEdit && (
        // The tick box of a touch screen (no Ctrl-click there); the card's own click handler toggles.
        <span
          aria-hidden
          data-select-tick
          className={cn(
            "absolute left-1.5 top-1.5 z-[2] flex size-5 items-center justify-center rounded border bg-surface pointer-coarse:size-6",
            selected ? "border-primary bg-primary text-primary-fg" : "border-line-strong",
            !selected && sel.count === 0 && "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {selected && <Check className="size-3.5" strokeWidth={3} />}
        </span>
      )}
      <CardBody
        record={record}
        primary={p.primary}
        fields={p.fields}
        coverField={p.coverField}
        descriptionField={p.descriptionField}
        coverFit={p.coverFit}
        limit={p.cardLimit}
        format={p.format}
        emails={p.emails}
        color={p.colors[record.id]}
      />
    </div>
  );
}
