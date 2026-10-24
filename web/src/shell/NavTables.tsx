/**
 * A project's tables in the menu, with the "…" menus for their actions. A table is one row, without
 * views under it: a tap opens the view last used in it on this device (its default grid if none),
 * and its views are in the toolbar's view list, where they are also put in order. Adding is in the
 * menus: a view in the table's ("Add view"), a table in the project's. In the open project every
 * action is there; the dialogs behind most of them (`BaseDialogs`) exist only inside the project's
 * page, so in another project the menus keep what needs no dialog (duplicating, Edit schema).
 *
 * Tables can be put in another order by those who manage them (creators): drag a row, or use "Move
 * up" and "Move down" in its "…" menu (see `sortable.tsx`).
 */
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Columns3, Copy, Ellipsis, FileUp, Pencil, Plus, Shapes, Sheet, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table } from "@/api/types";
import type { BaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityIcon } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { lastViewOf } from "@/lib/lastPlace";
import { defaultViewPath } from "@/lib/views";
import { VIEW_TYPES, VIEW_TYPE_META } from "@/views/meta";
import { useCloseMenu } from "./AppShell";
import { rowActionClass, rowNamePadClass, sidebarActiveClass } from "./Sidebar";
import { MoveItems, NO_DRAG, SortableGroup, SortableRow, useRowMenu } from "./sortable";
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
  const reorder = useReorder();
  return (
    <SortableGroup group={`tables-${schema.id}`} items={schema.tables} idOf={(t) => t.id} enabled={basePermissions.manageTables(schema.role)} onReorder={(ids) => reorder({ kind: "tables", baseId: schema.id, ids })}>
      {(tables) => (
        <ul aria-label={`Tables in ${schema.name}`} className="flex flex-col gap-0.5">
          {tables.length === 0 && <li className="py-1 pl-1.5 text-xs text-muted">No tables yet.</li>}
          {tables.map((t) => (
            <TableItem
              key={t.id}
              schema={schema}
              table={t}
              active={t.id === activeTableId}
              activeViewId={activeViewId}
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
  onDialog,
}: {
  schema: BaseSchema;
  table: Table;
  active: boolean;
  activeViewId: string | undefined;
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
  const { menu, onContextMenu } = useRowMenu();

  return (
    <SortableRow
      id={t.id}
      label={t.name}
      className="flex flex-col gap-0.5"
      rowClassName="group/item relative flex items-center"
      onContextMenu={onContextMenu}
      row={
        <>
          <Link
            to={tablePath(schema.id, t, active ? activeViewId : undefined)}
            onClick={closeMenu}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-1.5 text-[0.875rem] no-underline transition-colors pointer-coarse:h-11",
              rowNamePadClass,
              // The open table is the row in the app's colour, and the one bold name in the menu.
              active ? cn(sidebarActiveClass, "font-semibold") : "text-fg hover:bg-hover",
            )}
          >
            {/* Its own icon, or a table's: where the project's chevron is, so the names line up under its tile. */}
            {t.icon ? <EntityIcon name={t.icon} className={cn("size-4 shrink-0", !active && "text-muted")} /> : <Sheet aria-hidden className={cn("size-4 shrink-0", !active && "text-muted")} />}
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
          </Link>
          <DropdownMenu {...menu}>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Table options for ${t.name}`} size="sm" noTooltip className={cn(rowActionClass, active && "text-primary-fg hover:bg-primary-fg/15 hover:text-primary-fg")} {...NO_DRAG}>
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
    />
  );
}
