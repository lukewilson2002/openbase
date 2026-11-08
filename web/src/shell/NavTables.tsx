/**
 * The collections of one folder (or of the workspace's top level) as sidebar rows: the collection's
 * color mark, its name and its record count (NAV-2). A row is a link that opens the collection in the view
 * last used in it on this device (`BaseShell` picks that view from the address without one, and checks it
 * still exists); its "…" menu and a right-click hold Rename, Color, Duplicate, Import CSV, Move up, Move
 * down and Delete (NAV-3). Views are tabs inside the collection and are not in the sidebar.
 *
 * Collections can be put in another order by those who manage them (creators): drag a row, or use "Move up"
 * and "Move down" in its menu (see `sortable.tsx`).
 */
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, FileUp, Palette, Pencil, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, TableSummary } from "@/api/types";
import { basePermissions } from "@/base/permissions";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { NavRow } from "@/components/ui/nav-row";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useCloseMenu } from "./menuContext";
import { useNavDialog } from "./NavDialogs";
import { MenuGroups, RowMenu, countSlotClass, rowEndClass } from "./NavRowMenu";
import { MoveItems, SortableGroup, SortableRow, useRowMenu } from "./sortable";
import { useReorder } from "./useReorder";

const countFormat = new Intl.NumberFormat();

/** The address a collection's row opens: no view, so the one last used in it (else its first) is picked there. */
export function collectionPath(baseId: string, tableId: string): string {
  return `/base/${baseId}/${tableId}`;
}

export interface CollectionListProps {
  id?: string;
  base: BaseSummary;
  activeTableId: string | undefined;
  /** The list's accessible name. */
  label: string;
  /** Extra room on the left (a folder's collections sit 20 px in). */
  className?: string;
  /** Said when the folder has no collection; the top level says nothing of its own. */
  empty?: string;
}

export function CollectionList({ id, base, activeTableId, label, className, empty }: CollectionListProps) {
  const reorder = useReorder();
  return (
    <SortableGroup group={`tables-${base.id}`} items={base.tables} idOf={(t) => t.id} enabled={basePermissions.manageTables(base.role)} onReorder={(ids) => reorder({ kind: "tables", baseId: base.id, ids })}>
      {(tables) => (
        <ul id={id} aria-label={label} className={cn("flex flex-col gap-0.5", className)}>
          {tables.length === 0 && empty && <li className="px-2 py-1 text-meta text-muted">{empty}</li>}
          {tables.map((t) => (
            <CollectionRow key={t.id} base={base} table={t} active={t.id === activeTableId} />
          ))}
        </ul>
      )}
    </SortableGroup>
  );
}

function CollectionRow({ base, table: t, active }: { base: BaseSummary; table: TableSummary; active: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const closeMenu = useCloseMenu();
  const openDialog = useNavDialog();
  const { menu, onContextMenu } = useRowMenu();
  const canManage = basePermissions.manageTables(base.role);
  const canImport = basePermissions.importRecords(base.role);
  const duplicate = useMutation({
    mutationFn: () => api.tables.duplicate(t.id),
    onSuccess: async (table) => {
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      await qc.invalidateQueries({ queryKey: keys.base(base.id) });
      if (table?.id) await navigate(collectionPath(base.id, table.id));
    },
    onError: (e) => toast.error(e, "Could not duplicate the collection"),
  });

  return (
    <SortableRow
      id={t.id}
      label={t.name}
      className="flex flex-col"
      rowClassName="group/item relative flex items-center"
      // Without a menu the browser's own is left alone.
      onContextMenu={canManage || canImport ? onContextMenu : undefined}
      row={
        <>
          <NavRow asChild hue={t.color} markName={t.name} selected={active} className={rowEndClass} count={<span className={countSlotClass}>{countFormat.format(t.record_count)}</span>}>
            <Link to={collectionPath(base.id, t.id)} onClick={closeMenu}>
              {t.name}
            </Link>
          </NavRow>
          {(canManage || canImport) && (
            <RowMenu label={`Collection options for ${t.name}`} menu={menu}>
              <MenuGroups
                groups={[
                  [
                    canManage && (
                      <DropdownMenuItem key="rename" onSelect={() => openDialog({ kind: "rename-collection", baseId: base.id, table: t })}>
                        <Icon icon={Pencil} /> Rename
                      </DropdownMenuItem>
                    ),
                    canManage && (
                      <DropdownMenuItem key="color" onSelect={() => openDialog({ kind: "collection-color", baseId: base.id, table: t })}>
                        <Icon icon={Palette} /> Color
                      </DropdownMenuItem>
                    ),
                    canManage && (
                      <DropdownMenuItem key="duplicate" onSelect={() => duplicate.mutate()}>
                        <Icon icon={Copy} /> Duplicate
                      </DropdownMenuItem>
                    ),
                    canImport && (
                      <DropdownMenuItem key="import" onSelect={() => openDialog({ kind: "import-csv", baseId: base.id, table: t })}>
                        <Icon icon={FileUp} /> Import CSV
                      </DropdownMenuItem>
                    ),
                    canManage && <MoveItems key="move" separator="before" />,
                  ],
                  [
                    canManage && (
                      // The server keeps at least one collection in a folder.
                      <DropdownMenuItem key="delete" danger disabled={base.tables.length <= 1} onSelect={() => openDialog({ kind: "delete-collection", baseId: base.id, table: t })}>
                        <Icon icon={Trash2} /> Delete
                      </DropdownMenuItem>
                    ),
                  ],
                ]}
              />
            </RowMenu>
          )}
        </>
      }
    />
  );
}
