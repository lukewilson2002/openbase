/**
 * A project's tables in the menu, each expanding into its views, with the "…" menus for their
 * actions. A tap on a table opens the view last used in it on this device; the chevron only shows
 * the views. In the open project every action is there; the dialogs behind most of them
 * (`BaseDialogs`) exist only inside the project's page, so in another project the menus keep what
 * needs no dialog (duplicating, locking) and "Add table"/"Add view" are left out.
 */
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, FileUp, Lock, LockOpen, Pencil, Plus, Shapes, Share2, Table2, Trash2, User as UserIcon } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import type { BaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { canShareView } from "@/components/share/shareView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { lastViewOf } from "@/lib/lastPlace";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { useCloseMenu } from "./AppShell";
import { RowChevron, rowActionClass } from "./Sidebar";
import { useOpenState } from "./useOpenState";

export interface NavTablesProps {
  schema: BaseSchema;
  /** Only in the open project; see the file comment. */
  activeTableId: string | undefined;
  activeViewId: string | undefined;
  /** The open project's dialogs (`BaseDialogContext`); absent for any other project. */
  onDialog: ((dialog: BaseDialog) => void) | null;
}

/** The address a table's row opens: the view last used in it (if it still exists), else `BaseShell` picks its first. */
function tablePath(baseId: string, table: Table, currentViewId?: string): string {
  const view = table.views.find((v) => v.id === (currentViewId ?? lastViewOf(table.id)));
  return `/base/${baseId}/${table.id}${view ? `/${view.id}` : ""}`;
}

export function NavTables({ schema, activeTableId, activeViewId, onDialog }: NavTablesProps) {
  const [toggled, toggle] = useOpenState("ob-tables-open");
  const canManage = basePermissions.manageTables(schema.role);
  return (
    <ul aria-label={`Tables in ${schema.name}`} className="flex flex-col gap-0.5">
      {schema.tables.length === 0 && <li className="py-1 pl-[42px] text-xs text-muted">No tables yet.</li>}
      {schema.tables.map((t) => (
        <TableItem
          key={t.id}
          schema={schema}
          table={t}
          active={t.id === activeTableId}
          activeViewId={activeViewId}
          expanded={toggled[t.id] ?? t.id === activeTableId}
          onToggle={(open) => toggle(t.id, open)}
          onDialog={onDialog}
        />
      ))}
      {onDialog && canManage && (
        <li>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] pl-[38px] pr-2 text-left text-[0.8125rem] text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover pointer-coarse:h-11"
              >
                <Plus aria-hidden className="size-3.5 shrink-0" /> Add table
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onDialog({ kind: "create-table" })}>
                <Table2 aria-hidden className="size-4" /> New empty table
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDialog({ kind: "create-table-csv" })}>
                <FileUp aria-hidden className="size-4" /> New table from CSV…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      )}
    </ul>
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
  onToggle: (open: boolean) => void;
  onDialog: ((dialog: BaseDialog) => void) | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const closeMenu = useCloseMenu();
  const canManage = basePermissions.manageTables(schema.role);
  const canImport = !!onDialog && basePermissions.importRecords(schema.role);
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
        <RowChevron expanded={expanded} label={`${expanded ? "Hide" : "Show"} views of ${t.name}`} controls={viewsId} onClick={() => onToggle(!expanded)} />
        <Link
          to={tablePath(schema.id, t, active ? activeViewId : undefined)}
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
                  {onDialog && (
                    <>
                      <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-table", table: t })}>
                        <Pencil aria-hidden className="size-4" /> Rename table
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onDialog({ kind: "table-icon", table: t })}>
                        <Shapes aria-hidden className="size-4" /> Change icon…
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => duplicate.mutate(t.id)}>
                    <Copy aria-hidden className="size-4" /> Duplicate table
                  </DropdownMenuItem>
                  {onDialog && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger disabled={schema.tables.length <= 1} onSelect={() => onDialog({ kind: "delete-table", table: t })}>
                        <Trash2 aria-hidden className="size-4" /> Delete table
                      </DropdownMenuItem>
                    </>
                  )}
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

function ViewList({ id, schema, table, activeViewId, onDialog }: { id: string; schema: BaseSchema; table: Table; activeViewId: string | undefined; onDialog: ((dialog: BaseDialog) => void) | null }) {
  const shared = table.views.filter((v) => !v.personal);
  const mine = table.views.filter((v) => v.personal);
  const canCreate = !!onDialog && basePermissions.createView(schema.role);
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

function ViewItem({ schema, table, view: v, active, onDialog }: { schema: BaseSchema; table: Table; view: View; active: boolean; onDialog: ((dialog: BaseDialog) => void) | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const closeMenu = useCloseMenu();
  const role = schema.role;
  const Icon = VIEW_TYPE_META[v.type].icon;
  const canConfigure = basePermissions.configureView(role, v);
  const canLock = basePermissions.lockView(role, v);
  const canShare = !!onDialog && canShareView(role, v);
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
      {(canConfigure || canShare || canLock) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`Options for ${v.name}`} size="sm" noTooltip className={rowActionClass}>
              <Ellipsis aria-hidden className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {canConfigure && (
              <>
                {onDialog && (
                  <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-view", view: v })}>
                    <Pencil aria-hidden className="size-4" /> Rename view
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => duplicate.mutate(v.id)}>
                  <Copy aria-hidden className="size-4" /> Duplicate view
                </DropdownMenuItem>
              </>
            )}
            {canShare && (
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
            {canConfigure && onDialog && (
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
