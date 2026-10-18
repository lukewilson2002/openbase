/**
 * The start of the view toolbar: the open table's icon and name as plain text, then one icon button
 * per view of that table (the view type's icon, the open one highlighted, the view's name as its
 * tooltip and accessible name, small badges for personal and locked views). Views past what fits go
 * into a "…" menu, and a trailing "+" adds a view for those who may. Which table to open is the
 * menu's job, not the toolbar's.
 */
import { Link } from "react-router";
import { Ellipsis, Lock, Plus, Table2, User as UserIcon } from "lucide-react";
import type { BaseSchema, Table, View } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";

/** How many views show as icons before the rest go into "…": the toolbar shares its row with the tools. */
const SHOWN_ON_DESKTOP = 8;
const SHOWN_ON_PHONE = 4;

const buttonClass = "relative inline-flex size-9 shrink-0 items-center justify-center rounded-[9px] transition-colors pointer-coarse:size-11";

/** Which views show as icons: the first few, but never leaving the open view out of sight. */
export function splitViews(views: readonly View[], activeId: string, limit: number): { shown: View[]; hidden: View[] } {
  let shown = views.slice(0, limit);
  const active = views.find((v) => v.id === activeId);
  if (active && !shown.includes(active)) shown = [...views.slice(0, Math.max(0, limit - 1)), active];
  return { shown, hidden: views.filter((v) => !shown.includes(v)) };
}

export function ViewSwitcher({ schema, table, view, className }: { schema: BaseSchema; table: Table; view: View; className?: string }) {
  const openDialog = useBaseDialog();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const canCreateView = !!openDialog && basePermissions.createView(schema.role);
  const { shown, hidden } = splitViews(table.views, view.id, desktop ? SHOWN_ON_DESKTOP : SHOWN_ON_PHONE);
  const to = (v: View) => `/base/${schema.id}/${table.id}/${v.id}`;

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5", className)}>
      <h2 className="mr-1 flex min-w-0 max-w-full items-center gap-2 px-1.5 text-[0.9375rem] font-bold">
        {table.icon ? <EntityIcon name={table.icon} className="size-4 text-muted" /> : <Table2 aria-hidden className="size-4 shrink-0 text-muted" />}
        <span className="min-w-0 truncate">{table.name}</span>
      </h2>
      <nav aria-label={`Views of ${table.name}`} className="flex items-center gap-0.5">
        {shown.map((v) => {
          const Icon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
          const active = v.id === view.id;
          return (
            <Tooltip key={v.id} content={v.name}>
              <Link
                to={to(v)}
                aria-label={v.name}
                aria-current={active ? "page" : undefined}
                className={cn(buttonClass, "no-underline", active ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-hover hover:text-fg")}
              >
                <Icon aria-hidden className="size-[1.125rem]" />
                <ViewBadges view={v} />
              </Link>
            </Tooltip>
          );
        })}
        {hidden.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`${hidden.length} more ${hidden.length === 1 ? "view" : "views"}`} noTooltip className={cn(buttonClass, "rounded-[9px] data-[state=open]:bg-hover")}>
                <Ellipsis aria-hidden className="size-[1.125rem]" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label={`More views of ${table.name}`} aria-labelledby={undefined} className="w-60">
              {hidden.map((v) => {
                const Icon = VIEW_TYPE_META[v.type]?.icon ?? Table2;
                return (
                  <DropdownMenuItem key={v.id} asChild>
                    <Link to={to(v)}>
                      <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{v.name}</span>
                      {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
                      {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </nav>
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
