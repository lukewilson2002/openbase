/**
 * The base's menu (below the Inbox, which the shell adds): the tables, the open one expanded into
 * its views, each with a "…" menu for its actions; then Automations, Trash and Members above the
 * profile. The workspace is reached from the top bar's pickers. The dialogs these actions open live
 * in BaseDialogs, outside the menu.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, Ellipsis, FileUp, Lock, LockOpen, Pencil, Plus, Shapes, Share2, Table2, Trash2, User as UserIcon, Users, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { canShareView } from "@/components/share/shareView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useCloseMenu } from "@/shell/AppShell";
import { SidebarHeading, SidebarLink } from "@/shell/Sidebar";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import type { BaseDialog } from "./BaseDialogs";
import { basePermissions } from "./permissions";

export interface BaseSidebarProps {
  schema: BaseSchema;
  activeTableId: string | undefined;
  activeViewId: string | undefined;
  onDialog: (dialog: BaseDialog) => void;
}

/** Hidden until the row is hovered or the button focused, with a mouse; always there for a finger. */
const rowActionClass =
  "absolute right-0.5 top-1/2 size-7 -translate-y-1/2 opacity-100 pointer-coarse:size-9 md:pointer-fine:opacity-0 md:pointer-fine:focus-visible:opacity-100 md:pointer-fine:group-hover/item:opacity-100 data-[state=open]:opacity-100";

export function BaseSidebar({ schema, activeTableId, activeViewId, onDialog }: BaseSidebarProps) {
  const canManage = basePermissions.manageTables(schema.role);
  // Tables opened or closed by hand; the open table is expanded unless closed here.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isExpanded = (t: Table) => toggled[t.id] ?? t.id === activeTableId;

  return (
    <div className="flex flex-col">
      <nav aria-label="Tables" className="flex flex-col gap-0.5">
        <SidebarHeading
          action={
            canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Add table" size="sm" noTooltip className="size-8 rounded-lg">
                  <Plus aria-hidden className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onDialog({ kind: "create-table" })}>
                  <Table2 aria-hidden className="size-4" /> New empty table
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDialog({ kind: "create-table-csv" })}>
                  <FileUp aria-hidden className="size-4" /> New table from CSV…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )
          }
        >
          Tables
        </SidebarHeading>
        {schema.tables.length === 0 ? (
          <p className="px-3 py-1 text-xs text-muted">No tables yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {schema.tables.map((t) => (
              <TableItem
                key={t.id}
                schema={schema}
                table={t}
                active={t.id === activeTableId}
                activeViewId={activeViewId}
                expanded={isExpanded(t)}
                onToggle={() => setToggled((cur) => ({ ...cur, [t.id]: !isExpanded(t) }))}
                onDialog={onDialog}
              />
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}

function TableItem({
  schema,
  table: t,
  active,
  activeViewId,
  expanded,
  onToggle,
  onDialog,
}: {
  schema: BaseSchema;
  table: Table;
  active: boolean;
  activeViewId: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onDialog: (dialog: BaseDialog) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const closeMenu = useCloseMenu();
  const canManage = basePermissions.manageTables(schema.role);
  const canImport = basePermissions.importRecords(schema.role);
  const duplicate = useMutation({
    mutationFn: (id: string) => api.tables.duplicate(id),
    onSuccess: async (table) => {
      await qc.invalidateQueries({ queryKey: keys.base(schema.id) });
      if (table?.id) navigate(`/base/${schema.id}/${table.id}`);
    },
    onError: (e) => toast.error(e, "Could not duplicate table"),
  });
  const viewsId = `views-${t.id}`;

  return (
    <li className="flex flex-col gap-0.5">
      <div className="group/item relative flex items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={expanded ? viewsId : undefined}
          aria-label={`${expanded ? "Hide" : "Show"} views of ${t.name}`}
          className="inline-flex h-9 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
        </button>
        <Link
          to={`/base/${schema.id}/${t.id}`}
          onClick={closeMenu}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-1.5 pr-8 text-[0.875rem] text-fg no-underline transition-colors hover:bg-hover pointer-coarse:h-11 pointer-coarse:pr-10",
            active && "font-semibold",
          )}
        >
          {/* A table's own icon when it has one; the chevron already marks a plain table. */}
          {t.icon && <EntityIcon name={t.icon} className="size-4 shrink-0 text-muted" />}
          <span className="min-w-0 flex-1 truncate">{t.name}</span>
        </Link>
        {(canManage || canImport) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Table options for ${t.name}`} size="sm" noTooltip className={rowActionClass}>
                <Ellipsis aria-hidden className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {canImport && (
                <DropdownMenuItem onSelect={() => onDialog({ kind: "import", table: t })}>
                  <FileUp aria-hidden className="size-4" /> Import CSV…
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-table", table: t })}>
                    <Pencil aria-hidden className="size-4" /> Rename table
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onDialog({ kind: "table-icon", table: t })}>
                    <Shapes aria-hidden className="size-4" /> Change icon…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => duplicate.mutate(t.id)}>
                    <Copy aria-hidden className="size-4" /> Duplicate table
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger disabled={schema.tables.length <= 1} onSelect={() => onDialog({ kind: "delete-table", table: t })}>
                    <Trash2 aria-hidden className="size-4" /> Delete table
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {expanded && <ViewList id={viewsId} schema={schema} table={t} activeViewId={active ? activeViewId : undefined} onDialog={onDialog} />}
    </li>
  );
}

function ViewList({ id, schema, table, activeViewId, onDialog }: { id: string; schema: BaseSchema; table: Table; activeViewId: string | undefined; onDialog: (dialog: BaseDialog) => void }) {
  const shared = table.views.filter((v) => !v.personal);
  const mine = table.views.filter((v) => v.personal);
  const canCreate = basePermissions.createView(schema.role);
  const canCreateShared = basePermissions.createSharedView(schema.role);
  const item = (v: View) => <ViewItem key={v.id} schema={schema} table={table} view={v} active={v.id === activeViewId} onDialog={onDialog} />;

  return (
    <div id={id} className="flex flex-col gap-0.5 pb-1">
      <ul className="flex flex-col gap-0.5" aria-label="Shared views">
        {shared.map(item)}
      </ul>
      {mine.length > 0 && (
        <>
          <div className="pb-0.5 pl-[38px] pt-1.5 text-xs font-semibold text-muted">Personal</div>
          <ul className="flex flex-col gap-0.5" aria-label="Personal views">
            {mine.map(item)}
          </ul>
        </>
      )}
      {canCreate && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] pl-[38px] pr-2 text-left text-[0.8125rem] text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover pointer-coarse:h-11"
            >
              <Plus aria-hidden className="size-3.5 shrink-0" /> Add view
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {!canCreateShared && <DropdownMenuLabel>Editors can create personal views.</DropdownMenuLabel>}
            {VIEW_TYPES.map((type) => {
              const meta = VIEW_TYPE_META[type];
              return (
                <DropdownMenuItem key={type} onSelect={() => onDialog({ kind: "create-view", table, type })} className="items-start">
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

function ViewItem({ schema, table, view: v, active, onDialog }: { schema: BaseSchema; table: Table; view: View; active: boolean; onDialog: (dialog: BaseDialog) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const closeMenu = useCloseMenu();
  const role = schema.role;
  const Icon = VIEW_TYPE_META[v.type].icon;
  const canConfigure = basePermissions.configureView(role, v);
  const canLock = basePermissions.lockView(role, v);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.views.duplicate(id),
    onSuccess: async (view) => {
      await refresh();
      if (view?.id) navigate(`/base/${schema.id}/${table.id}/${view.id}`);
    },
    onError: (e) => toast.error(e, "Could not duplicate view"),
  });
  const toggleLock = useMutation({
    mutationFn: (view: View) => api.views.update(view.id, { locked: !view.locked }),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not change the lock"),
  });

  return (
    <li className="group/item relative">
      <Link
        to={`/base/${schema.id}/${table.id}/${v.id}`}
        onClick={closeMenu}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-[34px] items-center gap-2.5 rounded-[10px] pl-[38px] pr-8 text-[0.875rem] no-underline transition-colors pointer-coarse:h-11 pointer-coarse:pr-10",
          active ? "bg-primary-soft font-semibold text-primary-ink" : "text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{v.name}</span>
        {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
        {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
      </Link>
      {(canConfigure || canLock) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`Options for ${v.name}`} size="sm" noTooltip className={rowActionClass}>
              <Ellipsis aria-hidden className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {canConfigure && (
              <>
                <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-view", view: v })}>
                  <Pencil aria-hidden className="size-4" /> Rename view
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => duplicate.mutate(v.id)}>
                  <Copy aria-hidden className="size-4" /> Duplicate view
                </DropdownMenuItem>
              </>
            )}
            {canShareView(role, v) && (
              <DropdownMenuItem onSelect={() => onDialog({ kind: "share", table, view: v, tab: "view" })}>
                <Share2 aria-hidden className="size-4" /> Share view…
              </DropdownMenuItem>
            )}
            {canLock && (
              <DropdownMenuItem onSelect={() => toggleLock.mutate(v)}>
                {v.locked ? <LockOpen aria-hidden className="size-4" /> : <Lock aria-hidden className="size-4" />}
                {v.locked ? "Unlock view" : "Lock view"}
              </DropdownMenuItem>
            )}
            {canConfigure && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger disabled={table.views.length <= 1} onSelect={() => onDialog({ kind: "delete-view", table, view: v })}>
                  <Trash2 aria-hidden className="size-4" /> Delete view
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/**
 * Pinned above the profile: the base's automations (creators), its trash (creators: the one Trash
 * page, filtered to this base) and the workspace's members.
 */
export function BaseSidebarFooter({ schema, section }: { schema: BaseSchema; section?: "automations" }) {
  return (
    <>
      {basePermissions.manageAutomations(schema.role) && (
        <SidebarLink to={`/base/${schema.id}/automations`} end={false} muted active={section === "automations"} icon={<Zap />}>
          Automations
        </SidebarLink>
      )}
      {basePermissions.manageTables(schema.role) && (
        <SidebarLink to={`/trash?base=${encodeURIComponent(schema.id)}`} muted active={false} icon={<Trash2 />}>
          Trash
        </SidebarLink>
      )}
      <SidebarLink to={`/workspace/${schema.workspace_id}/members`} muted active={false} icon={<Users />}>
        Members
      </SidebarLink>
    </>
  );
}
