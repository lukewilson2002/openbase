/**
 * A project's tables in the menu, each expanding into its views, with the "…" menus for their
 * actions. A tap on a table opens the view last used in it on this device (its default grid if
 * none); the chevron only shows the views. A table's default grid is not among them (the toolbar
 * has its icon, and "Edit schema" in the table's menu opens it). Adding is in the menus: a view in
 * the table's ("Add view"), a table in the project's. In the open project every action is there;
 * the dialogs behind most of them (`BaseDialogs`) exist only inside the project's page, so in
 * another project the menus keep what needs no dialog (duplicating, locking, Edit schema).
 *
 * Tables can be put in another order, and so can a table's shared views and its personal ones, each
 * among themselves: drag a row, or use "Move up" and "Move down" in its "…" menu (see `sortable.tsx`).
 * Tables are for those who manage them (creators), shared views for those who may create them, and personal
 * views for editors.
 *
 * Each level of the tree sits one indent (pl-3.5) inside the one above it, and its rows put their
 * icon where its tables put theirs (after the chevron): a table's views sit one indent further in.
 */
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Columns3, Copy, Ellipsis, FileUp, Lock, Pencil, Plus, Shapes, Trash2, User as UserIcon } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import type { BaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { ViewMenuItems, hasViewActions } from "@/components/viewbar/ViewMenuItems";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { lastViewOf } from "@/lib/lastPlace";
import { defaultViewPath, namedViews } from "@/lib/views";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { useCloseMenu } from "./AppShell";
import { RowChevron, rowActionClass } from "./Sidebar";
import { MoveItems, NO_DRAG, SortableGroup, SortableRow } from "./sortable";
import { useOpenState } from "./useOpenState";
import { useReorder } from "./useReorder";

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
  const reorder = useReorder();
  return (
    <SortableGroup group={`tables-${schema.id}`} items={schema.tables} idOf={(t) => t.id} enabled={basePermissions.manageTables(schema.role)} onReorder={(ids) => reorder({ kind: "tables", baseId: schema.id, ids })}>
      {(tables) => (
        <ul aria-label={`Tables in ${schema.name}`} className="flex flex-col gap-0.5">
          {tables.length === 0 && <li className="py-1 pl-[42px] text-xs text-muted">No tables yet.</li>}
          {tables.map((t) => (
            <TableItem
              key={t.id}
              schema={schema}
              table={t}
              active={t.id === activeTableId}
              activeViewId={activeViewId}
              // Opening a table leaves its views folded: only its chevron shows them.
              expanded={toggled[t.id] ?? false}
              onToggle={(open) => toggle(t.id, open)}
              onDialog={onDialog}
            />
          ))}
        </ul>
      )}
    </SortableGroup>
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
  const canCreateView = !!onDialog && basePermissions.createView(schema.role);
  const canCreateShared = basePermissions.createSharedView(schema.role);
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
    <SortableRow
      id={t.id}
      label={t.name}
      className="flex flex-col gap-0.5"
      rowClassName="group/item relative flex items-center"
      row={
        <>
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Table options for ${t.name}`} size="sm" noTooltip className={rowActionClass} {...NO_DRAG}>
                <Ellipsis aria-hidden className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {/* How every record of the table is laid out is changed in its default grid. */}
              <DropdownMenuItem
                onSelect={() => {
                  closeMenu();
                  navigate(defaultViewPath(schema.id, t));
                }}
              >
                <Columns3 aria-hidden className="size-4" /> Edit schema
              </DropdownMenuItem>
              {canCreateView && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Plus aria-hidden className="size-4" /> Add view
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-72">
                    {!canCreateShared && <DropdownMenuLabel>Editors can create personal views.</DropdownMenuLabel>}
                    {VIEW_TYPES.map((type) => {
                      const meta = VIEW_TYPE_META[type];
                      return (
                        <DropdownMenuItem key={type} onSelect={() => onDialog!({ kind: "create-view", table: t, type })} className="items-start">
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
              )}
              {(canManage || canImport) && <DropdownMenuSeparator />}
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
                  <MoveItems separator="before" />
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
        </>
      }
    >
      {expanded && <ViewList id={viewsId} schema={schema} table={t} activeViewId={active ? activeViewId : undefined} onDialog={onDialog} />}
    </SortableRow>
  );
}

function ViewList({ id, schema, table, activeViewId, onDialog }: { id: string; schema: BaseSchema; table: Table; activeViewId: string | undefined; onDialog: ((dialog: BaseDialog) => void) | null }) {
  const reorder = useReorder();
  const views = namedViews(table);
  const shared = views.filter((v) => !v.personal);
  const mine = views.filter((v) => v.personal);
  const item = (v: View) => <ViewItem key={v.id} schema={schema} table={table} view={v} active={v.id === activeViewId} onDialog={onDialog} />;
  // The two lists are ordered apart: a view never moves from Shared to Personal or back.
  const group = (name: "shared" | "personal", items: View[], enabled: boolean) => ({
    group: `views-${table.id}-${name}`,
    items,
    idOf: (v: View) => v.id,
    enabled,
    onReorder: (ids: string[]) => reorder({ kind: "views", baseId: schema.id, tableId: table.id, ids }),
  });

  return (
    <div id={id} className="flex flex-col gap-0.5 pb-1 pl-3.5">
      <SortableGroup {...group("shared", shared, basePermissions.createSharedView(schema.role))}>
        {(list) => (
          <ul className="flex flex-col gap-0.5" aria-label="Shared views">
            {list.map(item)}
          </ul>
        )}
      </SortableGroup>
      {mine.length > 0 && (
        <>
          <div className="pb-0.5 pl-[34px] pt-1.5 text-xs font-semibold text-muted">Personal</div>
          <SortableGroup {...group("personal", mine, basePermissions.createView(schema.role))}>
            {(list) => (
              <ul className="flex flex-col gap-0.5" aria-label="Personal views">
                {list.map(item)}
              </ul>
            )}
          </SortableGroup>
        </>
      )}
      {shared.length === 0 && mine.length === 0 && <p className="py-1 pl-[34px] text-xs text-muted">No views yet.</p>}
    </div>
  );
}

function ViewItem({ schema, table, view: v, active, onDialog }: { schema: BaseSchema; table: Table; view: View; active: boolean; onDialog: ((dialog: BaseDialog) => void) | null }) {
  const closeMenu = useCloseMenu();
  const Icon = VIEW_TYPE_META[v.type].icon;

  return (
    <SortableRow
      id={v.id}
      label={v.name}
      rowClassName="group/item relative"
      row={
        <>
          <Link
            to={`/base/${schema.id}/${table.id}/${v.id}`}
            onClick={closeMenu}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-[34px] items-center gap-2.5 rounded-[10px] pl-[34px] pr-8 text-[0.875rem] no-underline transition-colors pointer-coarse:h-11 pointer-coarse:pr-10",
              active ? "bg-primary-soft font-semibold text-primary-ink" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            {v.personal && <UserIcon aria-label="Personal view" role="img" className="size-3.5 shrink-0 text-muted" />}
            {v.locked && <Lock aria-label="Locked view" role="img" className="size-3.5 shrink-0 text-muted" />}
          </Link>
          {hasViewActions(schema, v, onDialog) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={`Options for ${v.name}`} size="sm" noTooltip className={rowActionClass} {...NO_DRAG}>
                  <Ellipsis aria-hidden className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <ViewMenuItems schema={schema} table={table} view={v} onDialog={onDialog} extra={<MoveItems separator="before" />} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  );
}
