/**
 * The view tabs of a collection (COL-2), under its header: the default view first, reading "All clients",
 * then the saved views, each with its layout's icon and name. A personal view wears a person glyph and a
 * locked one a lock. Tabs that do not fit go into a More menu (the open view always stays on the strip).
 * There is no + tab: new views come from Save as view (COL-5).
 *
 * A right-click, the menu key, or on a touch screen a press held without moving opens the view's menu
 * (rename, duplicate, share, lock, move, delete). A press held and then moved drags the tab to a new place
 * among the views of its kind, for those who may reorder them; "Move left" and "Move right" in the menu are
 * the same change without a pointer. The tab strip is a Radix `Tabs`; the views are pages of their own
 * (addresses), so choosing a tab navigates.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ArrowRight, ChevronDown, Lock, User as UserIcon } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SheetMenu, SheetMenuGroup } from "@/components/ui/sheet-menu";
import { Tabs, TabsList, TabsTrigger, tabTriggerClass } from "@/components/ui/tabs";
import { ViewMenuItems, hasViewActions } from "@/components/viewbar/ViewMenuItems";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { dropOrder, fitTabs, siblingIds, viewTabs, type ViewTab } from "@/lib/viewTabs";
import { ActionMenu, MenuItem, SheetModeContext } from "@/shell/menuItems";
import { MenuGroups } from "@/shell/NavRowMenu";
import { holdClicks } from "@/shell/sortable";
import { moveId, useReorder } from "@/shell/useReorder";
import { VIEW_TYPE_META } from "@/views/meta";
import { useBaseDialog } from "./BaseDialogs";
import { basePermissions } from "./permissions";

/** Room kept for the More button when some tabs have to go into it. */
const MORE_WIDTH = 88;
/** The space between two tabs (`gap-1` on the list). */
const TAB_GAP = 4;
/** After a press held on a touch screen opened a menu, the touch's own click or press is not a choice of that tab. */
const HOLD_GUARD_MS = 700;

const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

const tabAnnouncements: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragCancel: () => undefined,
  onDragEnd: ({ active, over }) => (over && over.id !== active.id ? "Moved the view." : undefined),
};

const lockedLabel = "Locked view";
const personalLabel = "Personal view";

/** The glyphs after a view's name: a person for a personal view, a lock for a locked one. */
function Marks({ view }: { view: View }) {
  return (
    <>
      {view.personal && (
        <span role="img" aria-label={personalLabel} className="inline-flex shrink-0 opacity-80">
          <Icon icon={UserIcon} size="sm" />
        </span>
      )}
      {view.locked && (
        <span role="img" aria-label={lockedLabel} className="inline-flex shrink-0 opacity-80">
          <Icon icon={Lock} size="sm" />
        </span>
      )}
    </>
  );
}

/** The layout's glyph, for a menu row (the default view is a grid). */
function tabIconType(tab: ViewTab) {
  return VIEW_TYPE_META[tab.view.type]?.icon ?? VIEW_TYPE_META.grid.icon;
}

/** A tab's layout icon; the default view reads "All clients" with none, since it is simply every record. */
function tabIcon(tab: ViewTab) {
  if (tab.view.is_default) return undefined;
  const Glyph = tabIconType(tab);
  return <Glyph />;
}

interface TabProps {
  tab: ViewTab;
  /** Whether the person may drag it (and there is somewhere to drag it to). */
  draggable: boolean;
  onMenu: ((anchor: MenuAnchor) => void) | null;
}

function Tab({ tab, draggable, onMenu }: TabProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: tab.view.id, disabled: !draggable });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!onMenu) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    // The menu key has no pointer position: the menu hangs under the tab.
    onMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY, width: 1, height: 1 } : { x: r.left, y: r.bottom, width: r.width, height: 1 });
  };
  return (
    <TabsTrigger
      ref={setNodeRef}
      value={tab.view.id}
      icon={tabIcon(tab)}
      style={style}
      data-sortable={draggable ? "" : undefined}
      data-dragging={isDragging || undefined}
      onContextMenu={onContextMenu}
      // No attributes from dnd-kit: its role="button" would replace the tab's role.
      {...listeners}
      className={cn("select-none [-webkit-touch-callout:none]", isDragging && "relative z-20 cursor-grabbing rounded-md bg-surface shadow-pop")}
    >
      <span className="truncate">{tab.label}</span>
      <Marks view={tab.view} />
    </TabsTrigger>
  );
}

export interface CollectionTabsProps {
  schema: BaseSchema;
  table: Table;
  /** The open view. */
  view: View;
}

export function CollectionTabs({ schema, table, view }: CollectionTabsProps) {
  const navigate = useNavigate();
  const openDialog = useBaseDialog();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const reorder = useReorder();
  const dndId = useId();
  const role = schema.role;

  const tabs = useMemo(() => viewTabs(table), [table]);
  const activeIndex = tabs.findIndex((t) => t.view.id === view.id);
  const to = (v: View) => `/base/${schema.id}/${table.id}/${v.id}`;

  // ---- which tabs fit ---------------------------------------------------------------------------
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<number[]>(() => tabs.map((_, i) => i));
  const signature = tabs.map((t) => `${t.view.id}\u0000${t.label}\u0000${t.view.type}\u0000${t.view.personal ? 1 : 0}${t.view.locked ? 1 : 0}`).join("\u0001");
  useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = measureRef.current;
    if (!row || !probe) return;
    const fit = () => {
      const widths = [...probe.children].map((el) => ((el as HTMLElement).offsetWidth || 0) + TAB_GAP);
      // A row with no width has not been laid out (or is not shown): nothing is known to be too wide for it.
      const next = row.clientWidth > 0 ? fitTabs(widths, row.clientWidth, MORE_WIDTH, activeIndex) : widths.map((_, i) => i);
      setShown((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver(fit);
    watcher.observe(row);
    return () => watcher.disconnect();
    // The signature stands for the tabs' labels and glyphs, which decide their widths.
  }, [signature, activeIndex]);
  const visible = tabs.filter((_, i) => shown.includes(i));
  const hidden = tabs.filter((_, i) => !shown.includes(i));

  // ---- a view's menu ----------------------------------------------------------------------------
  const [menu, setMenu] = useState<{ view: View; anchor: MenuAnchor } | null>(null);
  const held = useRef(0);
  const mayMove = (v: View) => (v.personal ? basePermissions.createView(role) : basePermissions.createSharedView(role));
  const canDrag = (v: View) => !v.is_default && mayMove(v) && siblingIds(table.views, v).length > 1;
  const hasMenu = (v: View) => !v.is_default && hasViewActions(schema, v, openDialog);
  const moveItems = (v: View) => {
    const siblings = siblingIds(table.views, v);
    if (!mayMove(v) || siblings.length < 2) return null;
    const at = siblings.indexOf(v.id);
    const move = (delta: -1 | 1) => {
      const ids = moveId(siblings, v.id, delta);
      if (ids) void reorder({ kind: "views", baseId: schema.id, tableId: table.id, ids });
    };
    return (
      <>
        <MenuItem icon={ArrowLeft} disabled={at <= 0} onSelect={() => move(-1)}>
          Move left
        </MenuItem>
        <MenuItem icon={ArrowRight} disabled={at >= siblings.length - 1} onSelect={() => move(1)}>
          Move right
        </MenuItem>
      </>
    );
  };

  // ---- dragging ---------------------------------------------------------------------------------
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // A finger must rest first: moving straight away is a swipe along the strip.
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
  );
  const release = useRef<(() => void) | null>(null);
  const onDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    release.current?.();
    release.current = null;
    const moved = over && over.id !== active.id;
    if (moved) {
      const ids = dropOrder(table.views, String(active.id), String(over.id));
      if (ids) void reorder({ kind: "views", baseId: schema.id, tableId: table.id, ids });
      return;
    }
    // A hold released without moving is a long press: the tab's menu.
    const tab = tabs.find((t) => t.view.id === active.id);
    if (tab && hasMenu(tab.view) && "touches" in activatorEvent) {
      held.current = Date.now();
      const r = active.rect.current.initial;
      setMenu({ view: tab.view, anchor: { x: r?.left ?? 0, y: (r?.top ?? 0) + (r?.height ?? 0), width: r?.width ?? 1, height: 1 } });
    }
  };

  const open = (id: string) => {
    // The tap that ends a long press can still arrive as a press on the tab: not a choice of it.
    if (Date.now() - held.current < HOLD_GUARD_MS) return;
    const next = tabs.find((t) => t.view.id === id);
    if (next && next.view.id !== view.id) void navigate(to(next.view));
  };

  const menuItems = menu && <ViewMenuItems schema={schema} table={table} view={menu.view} onDialog={openDialog} extra={moveItems(menu.view)} />;

  return (
    <Tabs value={view.id} onValueChange={open} activationMode="manual" className="shrink-0 border-b border-line bg-surface px-4 md:px-10">
      <div ref={rowRef} className="relative flex items-stretch">
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[horizontalOnly]}
          onDragStart={() => {
            release.current?.();
            release.current = holdClicks();
          }}
          onDragCancel={() => {
            release.current?.();
            release.current = null;
          }}
          onDragEnd={onDragEnd}
          accessibility={{ announcements: tabAnnouncements, screenReaderInstructions: { draggable: "Drag with the pointer, or use Move left and Move right in the view's menu." } }}
        >
          <SortableContext items={visible.map((t) => t.view.id)} strategy={horizontalListSortingStrategy}>
            <TabsList aria-label={`Views of ${table.name}`} className="min-w-0 overflow-y-visible overflow-x-clip border-b-0">
              {visible.map((tab) => (
                <Tab
                  key={tab.view.id}
                  tab={tab}
                  draggable={canDrag(tab.view)}
                  onMenu={hasMenu(tab.view) ? (anchor) => setMenu({ view: tab.view, anchor }) : null}
                />
              ))}
            </TabsList>
          </SortableContext>
        </DndContext>
        {hidden.length > 0 && <MoreViews tabs={hidden} onOpen={(v) => void navigate(to(v))} />}
        {/* The same tabs, unseen, to learn how wide each is: a tab that went into More still has a width. */}
        <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex h-0 gap-0 overflow-hidden">
          {tabs.map((tab) => {
            const glyph = tabIcon(tab);
            return (
              <span key={tab.view.id} className={cn(tabTriggerClass, "shrink-0")}>
                {glyph && <span className="inline-flex shrink-0 [&>svg]:size-[0.9375rem]">{glyph}</span>}
                <span>{tab.label}</span>
                <Marks view={tab.view} />
              </span>
            );
          })}
        </div>
      </div>
      {desktop ? (
        <AnchoredMenu anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} label={menu ? `Options for ${menu.view.name}` : "View options"}>
          {menuItems}
        </AnchoredMenu>
      ) : (
        <SheetMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} title={menu?.view.name ?? "View"}>
          {menu && (
            <SheetModeContext value>
              <SheetMenuGroup>{menuItems}</SheetMenuGroup>
            </SheetModeContext>
          )}
        </SheetMenu>
      )}
    </Tabs>
  );
}

/** The tabs that did not fit, as a menu: a dropdown on a desktop, a bottom sheet on a phone. */
function MoreViews({ tabs, onOpen }: { tabs: ViewTab[]; onOpen: (view: View) => void }) {
  const rows = tabs.map((tab) => (
    <MenuItem key={tab.view.id} icon={tabIconType(tab)} onSelect={() => onOpen(tab.view)}>
      {tab.label}
      <Marks view={tab.view} />
    </MenuItem>
  ));
  return (
    <ActionMenu
      title="More views"
      trigger={
        <Button variant="ghost" size="sm" className="shrink-0 self-center text-muted">
          More <Icon icon={ChevronDown} size="sm" />
        </Button>
      }
    >
      <MenuGroups groups={[rows]} />
    </ActionMenu>
  );
}
