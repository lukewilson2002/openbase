/**
 * The start of the view toolbar: the open table's icon (a tap changes it, for those who may) and its
 * name, then one icon button
 * per view of that table (the view type's icon, the open one highlighted, the view's name as its
 * tooltip and accessible name, small badges for personal and locked views). Views past what fits go
 * into a "…" menu, and a trailing "+" adds a view for those who may. Which table to open is the
 * menu's job, not the toolbar's.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Ellipsis, Lock, Plus, Table2, User as UserIcon } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { IconPicker } from "@/components/icons/IconPicker";
import { TableIcon } from "@/components/icons/TableIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";

/** How many view buttons show before the rest go into "…": the toolbar shares its row with the tools. */
const SHOWN_ON_DESKTOP = 8;
const SHOWN_ON_PHONE = 4;
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
  const qc = useQueryClient();
  const toast = useToast();
  const setIcon = useMutation({
    mutationFn: (icon: string | null) => api.tables.update(table.id, { icon }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.base(schema.id) }),
    onError: (e) => toast.error(e, "Could not change the table's icon"),
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [fixedRefs] = useState(() => [headingRef, moreRef]);
  const labelled = useLabelsFit(rootRef, measureRef, fixedRefs, desktop);
  // Names fit: one button per view. Else icons, one per view type, and what does not fit goes into "…".
  const { shown, hidden } = labelled ? { shown: singles, hidden: [] } : splitGroups(groupViews(table.views), view.id, desktop ? SHOWN_ON_DESKTOP : SHOWN_ON_PHONE);

  return (
    <div ref={rootRef} className={cn("relative flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5", className)}>
      <h2 ref={headingRef} className="mr-1 flex min-w-0 max-w-full items-center gap-1 text-[0.9375rem] font-bold">
        {basePermissions.manageTables(schema.role) ? (
          <IconPicker value={table.icon} onChange={(icon) => setIcon.mutate(icon)} label={`Change the icon of ${table.name}`}>
            <button
              type="button"
              aria-label={`Change the icon of ${table.name}`}
              title="Change icon"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover pointer-coarse:size-10"
            >
              <TableIcon icon={table.icon} className="size-[1.125rem]" />
            </button>
          </IconPicker>
        ) : (
          <span className="inline-flex size-8 shrink-0 items-center justify-center text-muted">
            <TableIcon icon={table.icon} className="size-[1.125rem]" />
          </span>
        )}
        <span className="min-w-0 truncate pr-1.5">{table.name}</span>
      </h2>
      <nav aria-label={`Views of ${table.name}`} className="flex items-center gap-0.5">
        {shown.map((g) => (
          <GroupButton key={g.views[0]!.id} group={g} activeId={view.id} labelled={labelled} to={to} tableName={table.name} />
        ))}
      </nav>
      <div ref={moreRef} className="flex items-center gap-0.5 empty:hidden">
        {hidden.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`${count(hidden)} more ${count(hidden) === 1 ? "view" : "views"}`} noTooltip className={cn(buttonClass, "rounded-[9px] data-[state=open]:bg-hover")}>
                <Ellipsis aria-hidden className="size-[1.125rem]" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label={`More views of ${table.name}`} aria-labelledby={undefined} className="w-60">
              {hidden.flatMap((g) => g.views).map((v) => (
                <ViewMenuItem key={v.id} view={v} to={to(v)} active={v.id === view.id} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
function GroupButton({ group, activeId, labelled, to, tableName }: { group: ViewGroup; activeId: string; labelled: boolean; to: (v: View) => string; tableName: string }) {
  const Icon = VIEW_TYPE_META[group.type]?.icon ?? Table2;
  const active = group.views.some((v) => v.id === activeId);
  const tone = active ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-hover hover:text-fg";
  if (group.views.length === 1) {
    const v = group.views[0]!;
    const link = (
      <Link to={to(v)} aria-label={v.name} aria-current={active ? "page" : undefined} className={cn(buttonClass, labelled && labelledClass, "no-underline", tone)}>
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${group.views.length} ${typeLabel.toLowerCase()} views${open ? `, ${open.name} open` : ""}`}
          title={open?.name ?? `${typeLabel} views`}
          className={cn(buttonClass, "gap-0.5 pl-1.5 pr-1", tone, "data-[state=open]:bg-hover")}
        >
          <Icon aria-hidden className="size-[1.125rem] shrink-0" />
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={`${typeLabel} views of ${tableName}`} aria-labelledby={undefined} className="w-60">
        {group.views.map((v) => (
          <ViewMenuItem key={v.id} view={v} to={to(v)} active={v.id === activeId} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenuItem({ view: v, to, active }: { view: View; to: string; active: boolean }) {
  const Icon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
  return (
    <DropdownMenuItem asChild>
      <Link to={to} aria-current={active ? "page" : undefined}>
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
