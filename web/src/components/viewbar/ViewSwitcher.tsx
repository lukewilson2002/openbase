/**
 * The start of the view toolbar: one button naming the open view (its type's icon, its name, a chevron),
 * which opens the list of the table's views. The table's default grid comes first (it is not one of the
 * views: a plain grid of every record, where the fields are arranged), then a line, then the views in
 * their order; when a type has several views they share one row, named after the open one (or the
 * first) with how many more there are ("Board +2"): the row opens the view it names, and its "+2 ›"
 * end, a hover or → opens a submenu of them all. Personal
 * and locked views wear small marks, and "Add view" at the end of the list adds one, for those who may.
 * A right-click (or a held press on a phone) on a view in the list opens the view's menu over it:
 * rename, duplicate, share, lock, delete; a right-click on the button does so
 * for the open view; that menu also moves a view up or down among the table's views (the side menu
 * lists tables only). Which table to open is the menu's job, not the toolbar's.
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, Check, ChevronDown, Grid3x3, Lock, Plus, Table2, User as UserIcon } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
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
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { namedViews } from "@/lib/views";
import { moveId, useReorder } from "@/shell/useReorder";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { ViewMenuItems, hasViewActions } from "./ViewMenuItems";

/** How long a finger rests on a view in the list before its menu opens (as a long press elsewhere on a phone). */
const LONG_PRESS_MS = 500;

const buttonClass = "relative inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] text-[0.875rem] font-medium transition-colors pointer-coarse:h-11 pointer-coarse:min-w-11";

/** The views of one type, in order. */
export interface ViewGroup {
  type: View["type"];
  views: View[];
}

/** The views grouped by type, the types in the order of their first view. */
export function groupViews(views: readonly View[]): ViewGroup[] {
  const groups: ViewGroup[] = [];
  for (const v of views) {
    const group = groups.find((g) => g.type === v.type);
    if (group) group.views.push(v);
    else groups.push({ type: v.type, views: [v] });
  }
  return groups;
}

export function ViewSwitcher({ schema, table, view, className }: { schema: BaseSchema; table: Table; view: View; className?: string }) {
  const openDialog = useBaseDialog();
  const canCreateView = !!openDialog && basePermissions.createView(schema.role);
  const named = namedViews(table);
  const defaultView = table.views.find((v) => v.is_default);
  const to = (v: View) => `/base/${schema.id}/${table.id}/${v.id}`;
  // A right-click or a held press on a view: the view's own menu, as on its row in the menu.
  const [menu, setMenu] = useState<{ view: View; anchor: MenuAnchor } | null>(null);
  const hasMenu = (v: View) => hasViewActions(schema, v, openDialog);
  const menuFor = (v: View) => (hasMenu(v) ? (anchor: MenuAnchor) => setMenu({ view: v, anchor }) : undefined);
  // The list stays open under a view's menu (it is not modal, so the menu can take the focus and the pointer).
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;
  const stayWhileMenuOpen = (e: Event) => {
    if (menuOpenRef.current) e.preventDefault();
  };
  const keepStill = (e: React.PointerEvent) => {
    if (menu !== null) e.preventDefault();
  };
  const [listOpen, setListOpen] = useState(false);
  const navigate = useNavigate();
  const openView = (v: View) => {
    setListOpen(false);
    void navigate(to(v));
  };
  // Views are put in order here (the menu lists tables only): a view moves among the shared ones or
  // among the personal ones, for those who may reorder them (as for creating them).
  const reorder = useReorder();
  const moveItems = (v: View) => {
    const siblings = named.filter((x) => !!x.personal === !!v.personal).map((x) => x.id);
    const may = v.personal ? basePermissions.createView(schema.role) : basePermissions.createSharedView(schema.role);
    if (!may || siblings.length < 2) return null;
    const move = (delta: -1 | 1) => {
      const ids = moveId(siblings, v.id, delta);
      if (ids) void reorder({ kind: "views", baseId: schema.id, tableId: table.id, ids });
    };
    const at = siblings.indexOf(v.id);
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={at <= 0} onSelect={() => move(-1)}>
          <ArrowUp aria-hidden className="size-4" /> Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={at >= siblings.length - 1} onSelect={() => move(1)}>
          <ArrowDown aria-hidden className="size-4" /> Move down
        </DropdownMenuItem>
      </>
    );
  };
  const isDefault = !!view.is_default;
  const Icon = isDefault ? Grid3x3 : (VIEW_TYPE_META[view.type]?.icon ?? Table2);
  const name = isDefault ? "Default grid" : view.name;
  const openMenu = isDefault ? undefined : menuFor(view);

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <DropdownMenu modal={false} open={listOpen} onOpenChange={setListOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`View: ${name}`}
              onContextMenu={
                openMenu &&
                ((e) => {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY, width: 1, height: 1 } : { x: r.left, y: r.bottom, width: r.width, height: 1 });
                })
              }
              className={cn(buttonClass, "min-w-0 shrink justify-start bg-primary pl-2.5 pr-2 text-primary-fg hover:bg-primary-hover data-[state=open]:bg-primary-hover")}
            >
              <Icon aria-hidden className="size-[1.125rem] shrink-0" />
              <span className="min-w-0 truncate">{name}</span>
              {view.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 opacity-80" />}
              {view.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 opacity-80" />}
              <ChevronDown aria-hidden className="size-4 shrink-0 opacity-80" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            aria-label={`Views of ${table.name}`}
            aria-labelledby={undefined}
            className="w-64"
            onFocusOutside={stayWhileMenuOpen}
            onPointerDownOutside={stayWhileMenuOpen}
            onInteractOutside={stayWhileMenuOpen}
          >
            {defaultView && <ViewMenuItem view={defaultView} name="Default grid" icon={Grid3x3} to={to(defaultView)} active={isDefault} still={menu !== null} />}
            {defaultView && named.length > 0 && <DropdownMenuSeparator />}
            {groupViews(named).map((g) => {
              const props = (v: View) => ({ view: v, to: to(v), active: v.id === view.id, onMenu: menuFor(v), still: menu !== null });
              if (g.views.length === 1) return <ViewMenuItem key={g.type} {...props(g.views[0]!)} />;
              // Several of one type: one row, named like any other (the open one, or the first) with how
              // many more there are, opening a submenu of them all.
              const meta = VIEW_TYPE_META[g.type];
              const TypeIcon = meta?.icon ?? Table2;
              const heading = `${meta?.label ?? g.type} views`;
              const shown = g.views.find((v) => v.id === view.id) ?? g.views[0]!;
              const more = g.views.length - 1;
              return (
                <DropdownMenuSub key={g.type}>
                  <DropdownMenuSubTrigger
                    aria-label={`${heading}: ${shown.name} and ${more} more`}
                    // Crossed on the way into a view's menu, it neither opens its views nor takes the focus.
                    onPointerMove={keepStill}
                    onPointerLeave={keepStill}
                    // The row opens the view it names; its "+2 ›" end (or hovering, or →) opens the others.
                    onClick={(e) => {
                      const end = e.currentTarget.querySelector("[data-more]")?.getBoundingClientRect();
                      if (end && end.width > 0 && e.clientX >= end.left) return;
                      e.preventDefault();
                      openView(shown);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      openView(shown);
                    }}
                    onContextMenu={(e) => {
                      const open = menuFor(shown);
                      if (!open) return;
                      e.preventDefault();
                      open({ x: e.clientX, y: e.clientY, width: 1, height: 1 });
                    }}
                    className={cn(shown.id === view.id && "font-medium")}
                  >
                    <TypeIcon aria-hidden className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{shown.name}</span>
                    <span aria-hidden data-more="" className="shrink-0 text-xs text-muted">+{more}</span>
                    {shown.id === view.id && <Check aria-hidden className="size-4 shrink-0 text-primary-text" />}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent aria-label={heading} aria-labelledby={undefined} className="w-60" onFocusOutside={stayWhileMenuOpen} onPointerDownOutside={stayWhileMenuOpen} onInteractOutside={stayWhileMenuOpen}>
                    {g.views.map((v) => (
                      <ViewMenuItem key={v.id} {...props(v)} />
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
            {canCreateView && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Plus aria-hidden className="size-4 shrink-0 text-muted" />
                    Add view
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent aria-label="Add view" className="w-72">
                    {!basePermissions.createSharedView(schema.role) && <DropdownMenuLabel>Editors can create personal views.</DropdownMenuLabel>}
                    {VIEW_TYPES.map((type) => {
                      const meta = VIEW_TYPE_META[type];
                      return (
                        <DropdownMenuItem key={type} onSelect={() => openDialog({ kind: "create-view", table, type })} className="items-start gap-2.5 rounded-lg px-2.5 py-2">
                          <meta.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                          <span className="min-w-0">
                            <span className="block font-medium">{meta.label}</span>
                            <span className="block text-xs text-muted">{meta.description}</span>
                          </span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <AnchoredMenu anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} label={menu ? `Options for ${menu.view.name}` : "View options"}>
          {menu && <ViewMenuItems schema={schema} table={table} view={menu.view} onDialog={openDialog} extra={moveItems(menu.view)} />}
        </AnchoredMenu>
    </div>
  );
}

/**
 * Opens a view's menu like a context menu: a right-click (or the keyboard's menu key, Shift+F10) at the
 * pointer, or under the item when there is no pointer; on a touch screen a press held without
 * moving, after which the lift does not also follow the link.
 */
function useMenuGesture(onMenu: ((anchor: MenuAnchor) => void) | undefined) {
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(false);
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => cancel, []);
  if (!onMenu) return {};
  return {
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      cancel();
      if (opened.current) return; // the long press already opened it (Android fires both)
      const r = e.currentTarget.getBoundingClientRect();
      onMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY, width: 1, height: 1 } : { x: r.left, y: r.top, width: r.width, height: r.height });
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      opened.current = false;
      if (e.pointerType !== "touch") return;
      const { clientX: x, clientY: y } = e;
      hold.current = {
        x,
        y,
        timer: setTimeout(() => {
          hold.current = null;
          opened.current = true;
          onMenu({ x, y, width: 1, height: 1 });
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const h = hold.current;
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > TOUCH_HOLD_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (!opened.current) return;
      opened.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * `still`: a view's menu is open over the list. The pointer crossing the list on its way into that menu
 * must not take the focus out of it (a list item takes the focus when the pointer moves over it, and the
 * list when the pointer leaves one), or the menu closes; a prevented event is what tells Radix not to.
 */
function ViewMenuItem({
  view: v,
  name = v.name,
  icon,
  to,
  active,
  onMenu,
  still,
}: {
  view: View;
  name?: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  to: string;
  active: boolean;
  onMenu?: (anchor: MenuAnchor) => void;
  still: boolean;
}) {
  const Icon = icon ?? VIEW_TYPE_META[v.type]?.icon ?? Table2;
  const gesture = useMenuGesture(onMenu);
  const keep = (e: React.PointerEvent) => {
    if (still) e.preventDefault();
  };
  return (
    <DropdownMenuItem asChild>
      <Link
        {...gesture}
        onPointerMove={(e) => {
          gesture.onPointerMove?.(e);
          keep(e);
        }}
        onPointerLeave={keep}
        to={to}
        aria-current={active ? "page" : undefined}
        className={cn("[-webkit-touch-callout:none]", active && "font-medium")}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
        {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
        {active && <Check aria-hidden className="size-4 shrink-0 text-primary-text" />}
      </Link>
    </DropdownMenuItem>
  );
}

