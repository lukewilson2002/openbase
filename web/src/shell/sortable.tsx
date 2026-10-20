/**
 * Drag and drop for the menu's tree, shared by its four levels (workspaces, a workspace's projects, a
 * project's tables, a table's shared or personal views). One `ReorderRoot` (a dnd-kit context) wraps the
 * whole tree; each group of siblings is a `SortableGroup` with its own list, so a row only ever moves
 * among its own siblings (a project never changes workspace, a view never goes to another table or
 * between Shared and Personal). A `SortableRow` is one tree row: the drag starts on the row itself
 * (the chevron, the name, not the "…" button) after the mouse has moved a few pixels, or after a finger has
 * rested on it for a moment, so a click or tap and the drawer's scrolling still work, and the click that
 * ends a drag opens or folds nothing. The row lifts where it is and the siblings step aside; an open row
 * takes its children along. Only people who may reorder a group get drag handles; a group of one has
 * nothing to move. The fixed rows (Inbox, Notifications, Automations, History, Trash) are not in any group.
 *
 * Dragging has no keyboard form (dnd-kit's keyboard sensor would take Enter and Space from the rows'
 * links and buttons): each reorderable row's "…" menu has "Move up" and "Move down" instead
 * (`MoveItems`), which go through the same path as a drop.
 */
import { createContext, useContext, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type CollisionDetection, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { applyOrder, moveId } from "./useReorder";

/** Marks what must not start a drag: the "…" buttons (they open menus). */
export const NO_DRAG = { "data-no-drag": "" } as const;

const skip = (target: EventTarget | null) => target instanceof Element && !!target.closest("[data-no-drag]");

// dnd-kit's own sensors, except that a press on a `NO_DRAG` element never starts a drag.
class RowMouseSensor extends MouseSensor {
  static override activators = MouseSensor.activators.map((a) => ({ ...a, handler: ((e, o) => (skip(e.nativeEvent.target) ? false : a.handler(e, o))) as typeof a.handler }));
}
class RowTouchSensor extends TouchSensor {
  static override activators = TouchSensor.activators.map((a) => ({ ...a, handler: ((e, o) => (skip(e.nativeEvent.target) ? false : a.handler(e, o))) as typeof a.handler }));
}

/** What a row tells the context about itself and its group when it is picked up. */
interface RowData {
  group: string;
  label: string;
  ids: string[];
  commit: (ids: string[]) => void;
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Rows compete only with the rows of their own group (the children of an open row are other groups). */
const withinGroup: CollisionDetection = (args) => {
  const group = (args.active.data.current as RowData | undefined)?.group;
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => (c.data.current as RowData | undefined)?.group === group) });
};

const announcements: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragCancel: () => undefined,
  onDragEnd: ({ active, over }) => {
    const row = active.data.current as RowData | undefined;
    if (!row || !over) return undefined;
    const to = row.ids.indexOf(String(over.id));
    return to < 0 ? undefined : `Moved ${row.label} to position ${to + 1} of ${row.ids.length}.`;
  },
};

const InRoot = createContext(false);

const preventDefault = (e: Event) => e.preventDefault();

/**
 * Keep the click that ends a drag from following a link. dnd-kit stops that click from reaching
 * React (so a name does not fold its row) but not the browser's default, so a table's or a view's
 * link would still open its page; like dnd-kit's own listener, this one outlives the drop briefly.
 */
export function holdClicks() {
  window.addEventListener("click", preventDefault, { capture: true });
  return () => window.setTimeout(() => window.removeEventListener("click", preventDefault, { capture: true }), 50);
}

/** The one drag context of the tree: wrap everything that has `SortableGroup`s in it. */
export function ReorderRoot({ children }: { children: ReactNode }) {
  const id = useId();
  const sensors = useSensors(
    useSensor(RowMouseSensor, { activationConstraint: { distance: 5 } }),
    // A finger must rest on the row first: moving straight away is a swipe that scrolls the menu.
    useSensor(RowTouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
  );
  const release = useRef<(() => void) | null>(null);
  const onDragStart = () => {
    release.current?.();
    release.current = holdClicks();
  };
  const onDragCancel = () => {
    release.current?.();
    release.current = null;
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    onDragCancel();
    const from = active.data.current as RowData | undefined;
    const to = over?.data.current as RowData | undefined;
    if (!over || !from || !to || from.group !== to.group || active.id === over.id) return;
    const a = from.ids.indexOf(String(active.id));
    const b = from.ids.indexOf(String(over.id));
    if (a >= 0 && b >= 0) from.commit(arrayMove(from.ids, a, b));
  };
  return (
    <InRoot.Provider value>
      <DndContext
        id={id}
        sensors={sensors}
        collisionDetection={withinGroup}
        modifiers={[verticalOnly]}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements, screenReaderInstructions: { draggable: "Drag with the pointer, or use Move up and Move down in the row's options menu." } }}
      >
        {children}
      </DndContext>
    </InRoot.Provider>
  );
}

interface GroupState {
  group: string;
  /** The group's ids as shown, in order. */
  ids: string[];
  /** Whether its rows can be moved: allowed, in a `ReorderRoot`, and more than one. */
  sortable: boolean;
  commit: (ids: string[]) => void;
}

const GroupContext = createContext<GroupState | null>(null);
const RowContext = createContext<string | null>(null);

/**
 * A list of siblings that may be reordered. `children` draws the list from `items` as shown: in the
 * order of a drop that has not come back from the cache yet. `onReorder` gets the new ids of the whole
 * group and settles when the change has been answered. `group` must be unique in the tree.
 */
export function SortableGroup<T>({
  group,
  items,
  idOf,
  enabled,
  onReorder,
  children,
}: {
  group: string;
  items: T[];
  idOf: (item: T) => string;
  /** Whether the person may reorder this group (the server checks as well). */
  enabled: boolean;
  onReorder: (ids: string[]) => Promise<unknown>;
  children: (items: T[]) => ReactNode;
}) {
  const inRoot = useContext(InRoot);
  // The order of the last drop until its request is answered: the cache is told at once, but only
  // reaches the screen a moment later, and the rows must not step back to the old order in between.
  const [pending, setPending] = useState<string[] | null>(null);
  const shown = pending ? applyOrder(items, pending, idOf) : items;
  const ids = shown.map(idOf);
  const sortable = enabled && inRoot && ids.length > 1;
  const commit = (next: string[]) => {
    setPending(next);
    void onReorder(next).finally(() => setPending(null));
  };
  const body = children(shown);
  return (
    <GroupContext.Provider value={{ group, ids, sortable, commit }}>
      {sortable ? (
        <SortableContext id={group} items={ids} strategy={verticalListSortingStrategy}>
          {body}
        </SortableContext>
      ) : (
        body
      )}
    </GroupContext.Provider>
  );
}

/** The row's own place in its group, for its menu: `null` when it cannot be moved. */
function useRowMove() {
  const group = useContext(GroupContext);
  const id = useContext(RowContext);
  if (!group?.sortable || id === null) return null;
  const at = group.ids.indexOf(id);
  if (at < 0) return null;
  return {
    canUp: at > 0,
    canDown: at < group.ids.length - 1,
    move: (delta: -1 | 1) => {
      const next = moveId(group.ids, id, delta);
      if (next) group.commit(next);
    },
  };
}

/** "Move up" and "Move down" for a "…" menu: nothing when the row cannot be moved; disabled at the ends. */
export function MoveItems({ separator }: { separator?: "before" | "after" }) {
  const row = useRowMove();
  if (!row) return null;
  return (
    <>
      {separator === "before" && <DropdownMenuSeparator />}
      <DropdownMenuItem disabled={!row.canUp} onSelect={() => row.move(-1)}>
        <ArrowUp aria-hidden className="size-4" /> Move up
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!row.canDown} onSelect={() => row.move(1)}>
        <ArrowDown aria-hidden className="size-4" /> Move down
      </DropdownMenuItem>
      {separator === "after" && <DropdownMenuSeparator />}
    </>
  );
}

interface RowProps {
  id: string;
  /** What screen readers call the row. */
  label: string;
  /** The `li`'s classes. */
  className?: string;
  /** The row proper (what the drag takes hold of): chevron, name and "…". */
  rowClassName?: string;
  row: ReactNode;
  /** What hangs under the row (its open children): lifted along with it. */
  children?: ReactNode;
}

/** A tree row: a plain `li` unless its group can be reordered. */
export function SortableRow(props: RowProps) {
  const group = useContext(GroupContext);
  return <RowContext.Provider value={props.id}>{group?.sortable ? <DraggableRow {...props} group={group} /> : <PlainRow {...props} />}</RowContext.Provider>;
}

function PlainRow({ className, rowClassName, row, children }: RowProps) {
  return (
    <li className={className}>
      <div className={rowClassName}>{row}</div>
      {children}
    </li>
  );
}

function DraggableRow({ id, label, className, rowClassName, row, children, group }: RowProps & { group: GroupState }) {
  const data: RowData = { group: group.group, label, ids: group.ids, commit: group.commit };
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, data });
  const rowEvents = listeners as HTMLAttributes<HTMLDivElement> | undefined;
  return (
    <li
      ref={setNodeRef}
      data-sortable=""
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, "motion-reduce:transition-none!", isDragging && "relative z-20 rounded-[10px] bg-surface shadow-pop")}
    >
      {/* No attributes from dnd-kit: its role="button" and tabIndex would turn the row into a control around the controls inside it. */}
      <div {...rowEvents} data-drag-handle="" className={cn(rowClassName, "select-none [-webkit-touch-callout:none]", isDragging && "cursor-grabbing")}>
        {row}
      </div>
      {children}
    </li>
  );
}
