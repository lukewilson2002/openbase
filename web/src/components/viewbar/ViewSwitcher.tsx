/**
 * The start of the view toolbar: a button per view of the open table (the table itself is named in
 * the top bar). The buttons carry the views' names while all of them fit; else each is just its
 * type's icon, views of one type share one button listing them, and what still does not fit goes
 * into a "…" menu. Personal and locked views wear small badges, and a trailing "+" adds a view for
 * those who may. A right-click (or a held press on a phone) on a view's button opens the view's menu:
 * rename, duplicate, share, lock, delete, as on its row in the menu. Which table to open is the
 * menu's job, not the toolbar's.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, Ellipsis, Lock, Plus, Table2, User as UserIcon } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { AnchoredMenu, type MenuAnchor } from "@/components/ui/anchored-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { TOUCH_HOLD_TOLERANCE_PX } from "@/lib/holdToDrag";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { ViewMenuItems, hasViewActions } from "./ViewMenuItems";

/** How many view buttons show before the rest go into "…": the toolbar shares its row with the tools. */
const SHOWN_ON_DESKTOP = 8;
const SHOWN_ON_PHONE = 4;
/** How long a finger rests on a view button before its menu opens (as a long press elsewhere on a phone). */
const LONG_PRESS_MS = 500;
/** On a desktop the tools share the row: names show only while all of them fit in this much of it. */
const DESKTOP_SHARE = 0.45;

const buttonClass = "relative inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] text-[0.875rem] font-medium transition-colors pointer-coarse:h-11 pointer-coarse:min-w-11";
const labelledClass = "px-2.5";

/** One button: a view on its own, or (once only icons fit) every view of one type when there are several. */
export interface ViewGroup {
  type: View["type"];
  views: View[];
}

/** The views as icon buttons, in order: views of the same type share the button of the first. */
export function groupViews(views: readonly View[]): ViewGroup[] {
  const groups: ViewGroup[] = [];
  for (const v of views) {
    const group = groups.find((g) => g.type === v.type);
    if (group) group.views.push(v);
    else groups.push({ type: v.type, views: [v] });
  }
  return groups;
}

/** Which buttons show: the first few, but never leaving the open view's out of sight. */
export function splitGroups(groups: readonly ViewGroup[], activeId: string, limit: number): { shown: ViewGroup[]; hidden: ViewGroup[] } {
  let shown = groups.slice(0, limit);
  const active = groups.find((g) => g.views.some((v) => v.id === activeId));
  if (active && !shown.includes(active)) shown = [...groups.slice(0, Math.max(0, limit - 1)), active];
  return { shown, hidden: groups.filter((g) => !shown.includes(g)) };
}

/**
 * Whether every view can have a button with its name: yes when all of them fit in full, else every
 * button is just an icon (and views of one type share one). A hidden copy with the names is measured
 * against the room the switcher has, so showing or hiding the names never changes the answer.
 */
function useLabelsFit(rootRef: RefObject<HTMLDivElement | null>, measureRef: RefObject<HTMLDivElement | null>, fixedRef: RefObject<HTMLElement | null>[], desktop: boolean): boolean {
  const [fit, setFit] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const fixed = fixedRef.reduce((sum, r) => sum + (r.current?.offsetWidth ?? 0), 0);
      const style = getComputedStyle(root);
      const gaps = 4 * (fixedRef.length + 1);
      const room = desktop
        ? Math.min(parseFloat(style.maxWidth) || Infinity, (root.parentElement?.clientWidth ?? 0) * DESKTOP_SHARE)
        : root.clientWidth;
      setFit(measure.scrollWidth > 0 && measure.scrollWidth <= room - fixed - gaps);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(root);
    ro.observe(measure);
    if (root.parentElement) ro.observe(root.parentElement);
    return () => ro.disconnect();
  }, [rootRef, measureRef, fixedRef, desktop]);
  return fit;
}

export function ViewSwitcher({ schema, table, view, className }: { schema: BaseSchema; table: Table; view: View; className?: string }) {
  const openDialog = useBaseDialog();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const canCreateView = !!openDialog && basePermissions.createView(schema.role);
  const singles: ViewGroup[] = table.views.map((v) => ({ type: v.type, views: [v] }));
  const to = (v: View) => `/base/${schema.id}/${table.id}/${v.id}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [fixedRefs] = useState(() => [moreRef]);
  const labelled = useLabelsFit(rootRef, measureRef, fixedRefs, desktop);
  // A right-click or a held press on a view button: the view's own menu, as on its row in the menu.
  const [menu, setMenu] = useState<{ view: View; anchor: MenuAnchor } | null>(null);
  const hasMenu = (v: View) => hasViewActions(schema, v, openDialog);
  const onMenu = (v: View, anchor: MenuAnchor) => setMenu({ view: v, anchor });
  // Names fit: one button per view. Else icons, one per view type, and what does not fit goes into "…".
  const { shown, hidden } = labelled ? { shown: singles, hidden: [] } : splitGroups(groupViews(table.views), view.id, desktop ? SHOWN_ON_DESKTOP : SHOWN_ON_PHONE);

  return (
    <div ref={rootRef} className={cn("relative flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5", className)}>
      <nav aria-label={`Views of ${table.name}`} className="flex items-center gap-0.5">
        {shown.map((g) => (
          <GroupButton key={g.views[0]!.id} group={g} activeId={view.id} labelled={labelled} to={to} tableName={table.name} onMenu={onMenu} hasMenu={hasMenu} />
        ))}
      </nav>
      <div ref={moreRef} className="flex items-center gap-0.5 empty:hidden">
        {hidden.length > 0 && (
          <ViewsDropdown
            label={`More views of ${table.name}`}
            views={hidden.flatMap((g) => g.views)}
            activeId={view.id}
            to={to}
            onMenu={onMenu}
            hasMenu={hasMenu}
            trigger={
              <IconButton label={`${count(hidden)} more ${count(hidden) === 1 ? "view" : "views"}`} noTooltip className={cn(buttonClass, "rounded-[9px] data-[state=open]:bg-hover")}>
                <Ellipsis aria-hidden className="size-[1.125rem]" />
              </IconButton>
            }
          />
        )}
        {canCreateView && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Add view" className={cn(buttonClass, "rounded-[9px] data-[state=open]:bg-hover")}>
                <Plus aria-hidden className="size-[1.125rem]" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
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
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <AnchoredMenu anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} label={menu ? `Options for ${menu.view.name}` : "View options"}>
        {menu && <ViewMenuItems schema={schema} table={table} view={menu.view} onDialog={openDialog} />}
      </AnchoredMenu>
      {/* The buttons with their names, out of sight: measured to decide whether the names fit. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-0.5">
        {table.views.map((v) => {
          const Icon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
          return (
            <span key={v.id} className={cn(buttonClass, labelledClass)}>
              <Icon className="size-[1.125rem]" />
              {v.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function count(groups: readonly ViewGroup[]): number {
  return groups.reduce((n, g) => n + g.views.length, 0);
}

/** A view on its own is a link (with its name when names fit); several views of one type are one icon opening their names. */
/**
 * Opens a view's menu like a context menu: a right-click (or the keyboard's menu key, Shift+F10) at the
 * pointer, or under the button when there is no pointer; on a touch screen a press held without
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

function GroupButton({
  group,
  activeId,
  labelled,
  to,
  tableName,
  onMenu,
  hasMenu,
}: {
  group: ViewGroup;
  activeId: string;
  labelled: boolean;
  to: (v: View) => string;
  tableName: string;
  onMenu?: (view: View, anchor: MenuAnchor) => void;
  hasMenu?: (view: View) => boolean;
}) {
  const Icon = VIEW_TYPE_META[group.type]?.icon ?? Table2;
  const active = group.views.some((v) => v.id === activeId);
  const tone = active ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-hover hover:text-fg";
  const single = group.views.length === 1 ? group.views[0]! : null;
  // Only a view with something to do takes the gesture; for the others the browser's own menu stays.
  const gesture = useMenuGesture(single && onMenu && hasMenu?.(single) ? (anchor) => onMenu(single, anchor) : undefined);
  if (single) {
    const v = single;
    const link = (
      // `-webkit-touch-callout: none`: a held press opens the view's menu, not iOS's link preview.
      <Link {...gesture} to={to(v)} aria-label={v.name} aria-current={active ? "page" : undefined} className={cn(buttonClass, labelled && labelledClass, "no-underline select-none [-webkit-touch-callout:none]", tone)}>
        <Icon aria-hidden className="size-[1.125rem] shrink-0" />
        {labelled && <span aria-hidden>{v.name}</span>}
        <ViewBadges view={v} />
      </Link>
    );
    return labelled ? link : <Tooltip content={v.name}>{link}</Tooltip>;
  }
  const typeLabel = VIEW_TYPE_META[group.type]?.label ?? group.type;
  const open = group.views.find((v) => v.id === activeId);
  return (
    <ViewsDropdown
      label={`${typeLabel} views of ${tableName}`}
      views={group.views}
      activeId={activeId}
      to={to}
      onMenu={onMenu}
      hasMenu={hasMenu}
      trigger={
        <button
          type="button"
          aria-label={`${group.views.length} ${typeLabel.toLowerCase()} views${open ? `, ${open.name} open` : ""}`}
          title={open?.name ?? `${typeLabel} views`}
          className={cn(buttonClass, "gap-0.5 pl-1.5 pr-1", tone, "data-[state=open]:bg-hover")}
        >
          <Icon aria-hidden className="size-[1.125rem] shrink-0" />
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
        </button>
      }
    />
  );
}

/**
 * A dropdown of views (the views of one type sharing a button, or those that did not fit). A
 * right-click or a held press on one of them closes it and opens that view's own menu in its place.
 */
function ViewsDropdown({
  label,
  views,
  activeId,
  to,
  trigger,
  onMenu,
  hasMenu,
}: {
  label: string;
  views: readonly View[];
  activeId: string;
  to: (v: View) => string;
  trigger: React.ReactElement;
  onMenu?: (view: View, anchor: MenuAnchor) => void;
  hasMenu?: (view: View) => boolean;
}) {
  const [open, setOpen] = useState(false);
  // The view whose menu opens once this dropdown is gone. Not on a timer: the dropdown hands the focus
  // back to its button as it goes (when depends on its closing animation), and focus landing outside
  // the new menu would close that one at once. So the hand-back is skipped and the menu opens then.
  const pending = useRef<{ view: View; anchor: MenuAnchor } | null>(null);
  const menuFor = (v: View) =>
    onMenu && hasMenu?.(v)
      ? (anchor: MenuAnchor) => {
          pending.current = { view: v, anchor };
          setOpen(false);
        }
      : undefined;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={label}
        aria-labelledby={undefined}
        className="w-60"
        onCloseAutoFocus={(e) => {
          const next = pending.current;
          if (!next || !onMenu) return;
          pending.current = null;
          e.preventDefault();
          onMenu(next.view, next.anchor);
        }}
      >
        {views.map((v) => (
          <ViewMenuItem key={v.id} view={v} to={to(v)} active={v.id === activeId} onMenu={menuFor(v)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenuItem({ view: v, to, active, onMenu }: { view: View; to: string; active: boolean; onMenu?: (anchor: MenuAnchor) => void }) {
  const Icon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
  const gesture = useMenuGesture(onMenu);
  return (
    <DropdownMenuItem asChild>
      <Link {...gesture} to={to} aria-current={active ? "page" : undefined} className="[-webkit-touch-callout:none]">
        <Icon aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{v.name}</span>
        {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
        {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
        {active && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
      </Link>
    </DropdownMenuItem>
  );
}

/** Personal and locked views carry a tiny mark in the corner of their button. */
function ViewBadges({ view }: { view: View }) {
  const badge = "absolute size-3 rounded-full bg-surface p-px text-muted";
  return (
    <>
      {view.personal && <UserIcon aria-label="Personal view" role="img" className={cn(badge, "-bottom-px -right-px")} />}
      {view.locked && <Lock aria-label="Locked view" role="img" className={cn(badge, "-right-px -top-px")} />}
    </>
  );
}
