/**
 * The sidebar's "Collections" section (NAV-1, NAV-2, NAV-3): the workspace's top-level collections, then its
 * folders, each folding open to its own collections. The tree is drawn from the workspaces list alone (folders
 * carry their collection summaries and record counts), so nothing is fetched when a folder unfolds. Which
 * project is the top level, and which of them a limited member may open, comes from `lib/topLevel.ts` (NAV-10).
 *
 * A click on a folder folds or unfolds it; the choice is remembered per device. Folders and collections can be
 * put in another order by dragging (creators), or with "Move up" and "Move down" in their menus.
 */
import { useEffect, useId, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpToLine, ChevronRight, Copy, FilePlus, FileUp, FolderPlus, Palette, Pencil, Plus, Share2, Table2, Trash2, Users, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { basePermissions } from "@/base/permissions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { NavRow } from "@/components/ui/nav-row";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { foldersOf, topLevelOf } from "@/lib/topLevel";
import { useNavDialog } from "./NavDialogs";
import { LinkItem, MenuGroups, RowMenu } from "./NavRowMenu";
import { CollectionList } from "./NavTables";
import { MoveItems, ReorderRoot, SortableGroup, SortableRow, useRowMenu } from "./sortable";
import { useOpenState } from "./useOpenState";
import { useReorder } from "./useReorder";

export const FOLDERS_OPEN_KEY = "ob-folders-open";

export function NavTree({ ws, tableId }: { ws: WorkspaceSummary; tableId?: string }) {
  const headingId = useId();
  const openDialog = useNavDialog();
  const reorder = useReorder();
  const top = topLevelOf(ws);
  const folders = foldersOf(ws);
  const canCreateCollection = !!top && basePermissions.manageTables(top.role);
  const canCreateFolder = atLeast(ws.role, "creator");
  const empty = (top?.tables.length ?? 0) === 0 && folders.length === 0;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-0.5">
      <div className="flex min-h-control-md items-center justify-between gap-2 pl-2 pr-1">
        <h2 id={headingId} className="text-label font-semibold text-muted">
          Collections
        </h2>
        {(canCreateCollection || canCreateFolder) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Add a collection or folder" size="sm" noTooltip>
                <Icon icon={Plus} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <MenuGroups
                groups={[
                  [
                    canCreateCollection && top && (
                      <DropdownMenuItem key="new" onSelect={() => openDialog({ kind: "create-collection", baseId: top.id })}>
                        <Icon icon={Table2} /> New collection
                      </DropdownMenuItem>
                    ),
                    canCreateCollection && top && (
                      <DropdownMenuItem key="csv" onSelect={() => openDialog({ kind: "create-collection-csv", baseId: top.id })}>
                        <Icon icon={FileUp} /> New collection from CSV
                      </DropdownMenuItem>
                    ),
                  ],
                  [
                    canCreateFolder && (
                      <DropdownMenuItem key="folder" onSelect={() => openDialog({ kind: "create-folder", workspaceId: ws.id })}>
                        <Icon icon={FolderPlus} /> New folder
                      </DropdownMenuItem>
                    ),
                  ],
                ]}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ReorderRoot>
        {top && <CollectionList base={top} activeTableId={tableId} label="Collections" />}
        <SortableGroup group={`folders-${ws.id}`} items={folders} idOf={(b) => b.id} enabled={folders.every((b) => basePermissions.editBase(b.role))} onReorder={(ids) => reorder({ kind: "projects", workspaceId: ws.id, ids })}>
          {(list) =>
            list.length > 0 && (
              <ul aria-label="Folders" className="flex flex-col gap-0.5">
                {list.map((b) => (
                  <FolderItem key={b.id} base={b} workspaceName={ws.name} workspaceRole={ws.role} activeTableId={tableId} />
                ))}
              </ul>
            )
          }
        </SortableGroup>
      </ReorderRoot>
      {empty && (
        <p className="px-2 py-1 text-meta text-muted">{canCreateCollection ? "No collections yet. Add one with the plus." : "Nothing to show yet."}</p>
      )}
    </section>
  );
}

function FolderItem({ base, workspaceName, workspaceRole, activeTableId }: { base: BaseSummary; workspaceName: string; workspaceRole: string; activeTableId: string | undefined }) {
  const [toggled, toggle] = useOpenState(FOLDERS_OPEN_KEY);
  const expanded = toggled[base.id] ?? true;
  const groupId = useId();
  const { menu, onContextMenu } = useRowMenu();
  const holdsActive = !!activeTableId && base.tables.some((t) => t.id === activeTableId);
  const folded = toggled[base.id] === false;
  const revealed = useRef<string | undefined>(undefined);
  // Landing on a collection (from a search, a link) inside a folder folded by hand shows where you are. Only a
  // change of collection reveals: folding the folder again while it holds the open one is the person's choice.
  useEffect(() => {
    if (!holdsActive || revealed.current === activeTableId) return;
    revealed.current = activeTableId;
    if (folded) toggle(base.id, true);
  }, [activeTableId, holdsActive, folded, base.id, toggle]);

  return (
    <SortableRow
      id={base.id}
      label={base.name}
      className="flex flex-col gap-0.5"
      rowClassName="group/item relative flex items-center"
      onContextMenu={onContextMenu}
      row={
        <>
          {/* The whole row is the fold button: the chevron beside the mark only shows its state. */}
          <NavRow
            hue={base.color}
            markName={base.name}
            aria-expanded={expanded}
            aria-controls={expanded ? groupId : undefined}
            onClick={() => toggle(base.id, !expanded)}
            className="pl-7 font-semibold max-md:pr-11 pointer-coarse:pr-11 md:pointer-fine:group-hover/item:pr-9 md:pointer-fine:group-focus-within/item:pr-9 md:pointer-fine:group-has-[[data-state=open]]/item:pr-9"
          >
            {base.name}
          </NavRow>
          <Icon icon={ChevronRight} size="sm" className={cn("pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
          <FolderMenu base={base} workspaceName={workspaceName} workspaceRole={workspaceRole} menu={menu} />
        </>
      }
    >
      {expanded && <CollectionList id={groupId} base={base} activeTableId={activeTableId} label={`Collections in ${base.name}`} className="ml-5" empty="No collections yet." />}
    </SortableRow>
  );
}

function FolderMenu({ base, workspaceName, workspaceRole, menu }: { base: BaseSummary; workspaceName: string; workspaceRole: string; menu: ReturnType<typeof useRowMenu>["menu"] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const openDialog = useNavDialog();
  const canEdit = basePermissions.editBase(base.role);
  const isOwner = atLeast(workspaceRole, "owner");
  const duplicate = useMutation({
    mutationFn: () => api.bases.duplicate(base.id, { name: `${base.name} copy`, include_records: true }),
    onSuccess: () => {
      toast.toast({ title: "Folder duplicated", variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
    onError: (e) => toast.error(e, "Could not duplicate the folder"),
  });
  const useAsTopLevel = useMutation({
    mutationFn: () => api.workspaces.setTopLevel(base.workspace_id, base.id),
    onSuccess: () => {
      toast.toast({ title: `${base.name} is now the top level`, variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
    onError: (e) => toast.error(e, "Could not change the top level"),
  });
  const canCreate = basePermissions.manageTables(base.role);
  return (
    <RowMenu label={`Folder options for ${base.name}`} menu={menu}>
      <MenuGroups
        groups={[
          [
            canEdit && (
              <DropdownMenuItem key="rename" onSelect={() => openDialog({ kind: "rename-folder", base })}>
                <Icon icon={Pencil} /> Rename
              </DropdownMenuItem>
            ),
            canEdit && (
              <DropdownMenuItem key="color" onSelect={() => openDialog({ kind: "folder-color", base })}>
                <Icon icon={Palette} /> Color
              </DropdownMenuItem>
            ),
          ],
          [
            canCreate && (
              <DropdownMenuItem key="new" onSelect={() => openDialog({ kind: "create-collection", baseId: base.id })}>
                <Icon icon={FilePlus} /> New collection
              </DropdownMenuItem>
            ),
            canCreate && (
              <DropdownMenuItem key="csv" onSelect={() => openDialog({ kind: "create-collection-csv", baseId: base.id })}>
                <Icon icon={FileUp} /> New collection from CSV
              </DropdownMenuItem>
            ),
          ],
          [
            basePermissions.manageSharing(base.role) && (
              <DropdownMenuItem key="share" onSelect={() => openDialog({ kind: "share-folder", base, workspaceName })}>
                <Icon icon={Share2} /> Share
              </DropdownMenuItem>
            ),
            <LinkItem key="access" to={`/workspace/${base.workspace_id}/members`} icon={<Icon icon={Users} />}>
              Access
            </LinkItem>,
            basePermissions.manageAutomations(base.role) && (
              <LinkItem key="automations" to={`/base/${base.id}/automations`} icon={<Icon icon={Zap} />}>
                Automations
              </LinkItem>
            ),
          ],
          [
            canEdit && (
              <DropdownMenuItem key="duplicate" onSelect={() => duplicate.mutate()}>
                <Icon icon={Copy} /> Duplicate
              </DropdownMenuItem>
            ),
            canEdit && <MoveItems key="move" />,
          ],
          [
            isOwner && (
              <DropdownMenuItem key="top" onSelect={() => useAsTopLevel.mutate()}>
                <Icon icon={ArrowUpToLine} /> Use as top level
              </DropdownMenuItem>
            ),
          ],
          [
            isOwner && (
              <DropdownMenuItem key="delete" danger onSelect={() => openDialog({ kind: "delete-folder", base })}>
                <Icon icon={Trash2} /> Delete
              </DropdownMenuItem>
            ),
          ],
        ]}
      />
    </RowMenu>
  );
}
