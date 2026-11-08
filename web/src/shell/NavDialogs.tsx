/**
 * The dialogs the sidebar's rows open: a new workspace, folder or collection, renames, colors, deletes,
 * CSV imports, sharing a folder and inviting people to a workspace. They live here, around the page
 * rather than inside the sidebar, because a dialog opened from a sheet (the phone's workspace switcher) or a
 * menu would vanish with it when it closes. Every shell wraps its frame in `NavDialogsProvider`; the
 * sidebar, the phone's sheets and the empty folder's page open dialogs through `useNavDialog`. A collection's dialogs work
 * from any page, so a collection of another folder can be renamed or imported into without opening it.
 * The view dialogs stay in `BaseDialogs`, which needs the open folder's schema.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, TableSummary, WorkspaceSummary } from "@/api/types";
import { ColorDialog } from "@/components/ColorDialog";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { ImportCsvDialog, NewTableFromCsvDialog } from "@/components/csv/LazyCsvDialogs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { defaultViewPath } from "@/lib/views";
import { WorkspaceDialogs, type WorkspaceDialog } from "@/pages/workspace/WorkspaceDialogs";
import { useCreateWorkspace } from "./useCreateWorkspace";

export type NavDialog =
  | { kind: "create-workspace" }
  /** Rename, recolor or delete a workspace. Its icon is no longer offered from the sidebar (decision 3). */
  | { kind: "workspace"; ws: WorkspaceSummary; dialog: Exclude<NonNullable<WorkspaceDialog>, "icon"> }
  | { kind: "invite"; ws: WorkspaceSummary }
  | { kind: "create-folder"; workspaceId: string }
  | { kind: "rename-folder"; base: BaseSummary }
  | { kind: "folder-color"; base: BaseSummary }
  | { kind: "delete-folder"; base: BaseSummary }
  | { kind: "share-folder"; base: BaseSummary; workspaceName: string }
  | { kind: "create-collection"; baseId: string }
  | { kind: "create-collection-csv"; baseId: string }
  | { kind: "rename-collection"; baseId: string; table: TableSummary }
  | { kind: "collection-color"; baseId: string; table: TableSummary }
  | { kind: "delete-collection"; baseId: string; table: TableSummary }
  | { kind: "import-csv"; baseId: string; table: TableSummary };

const NavDialogContext = createContext<(dialog: NavDialog) => void>(() => {});

/** Opens one of the sidebar's dialogs; a no-op outside `NavDialogsProvider`. */
export function useNavDialog(): (dialog: NavDialog) => void {
  return useContext(NavDialogContext);
}

export function NavDialogsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<NavDialog | null>(null);
  return (
    <NavDialogContext.Provider value={setDialog}>
      {children}
      <NavDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </NavDialogContext.Provider>
  );
}

function NavDialogs({ dialog, onClose }: { dialog: NavDialog | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const createWorkspace = useCreateWorkspace();
  const onOpenChange = (open: boolean) => !open && onClose();
  const refreshWorkspaces = () => qc.invalidateQueries({ queryKey: keys.workspaces });
  const refreshBase = (baseId: string) => {
    void refreshWorkspaces();
    void qc.invalidateQueries({ queryKey: keys.base(baseId) });
  };

  const createBase = useMutation({
    mutationFn: (v: { workspaceId: string; name: string; color?: string | null }) => api.bases.create(v.workspaceId, { name: v.name, ...(v.color ? { color: v.color } : {}), empty: true }),
    onSuccess: () => void refreshWorkspaces(),
  });
  const updateBase = useMutation({
    mutationFn: (v: { id: string; name?: string; color?: string }) => api.bases.update(v.id, { name: v.name, color: v.color }),
    onSuccess: (_base, v) => refreshBase(v.id),
    onError: (e) => toast.error(e, "Could not change the folder"),
  });
  const deleteBase = useMutation({
    mutationFn: (base: BaseSummary) => api.bases.remove(base.id),
    onSuccess: async (_res, base) => {
      // Gone from the sidebar at once, so leaving its page does not land on it again through the last place.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => cur?.map((w) => (w.id === base.workspace_id ? { ...w, bases: w.bases.filter((b) => b.id !== base.id) } : w)));
      if (pathname.startsWith(`/base/${base.id}`)) await navigate(`/workspace/${base.workspace_id}`, { replace: true });
      void refreshWorkspaces();
      void qc.invalidateQueries({ queryKey: keys.trash });
    },
  });
  const createTable = useMutation({
    mutationFn: (v: { baseId: string; name: string }) => api.tables.create(v.baseId, v.name),
    onSuccess: async (table, v) => {
      refreshBase(v.baseId);
      // A new collection opens in its default grid, its only view.
      await navigate(defaultViewPath(v.baseId, table));
    },
  });
  const updateTable = useMutation({
    mutationFn: (v: { id: string; baseId: string; name?: string; color?: string }) => api.tables.update(v.id, { name: v.name, color: v.color }),
    onSuccess: (_table, v) => refreshBase(v.baseId),
    onError: (e) => toast.error(e, "Could not change the collection"),
  });
  const deleteTable = useMutation({
    mutationFn: (v: { baseId: string; table: TableSummary }) => api.tables.remove(v.table.id),
    onSuccess: async (_res, v) => {
      refreshBase(v.baseId);
      void qc.invalidateQueries({ queryKey: keys.trash });
      if (pathname.startsWith(`/base/${v.baseId}/${v.table.id}`)) await navigate(`/base/${v.baseId}`, { replace: true });
    },
  });

  const renamingFolder = dialog?.kind === "rename-folder" ? dialog.base : null;
  const renamingCollection = dialog?.kind === "rename-collection" ? dialog : null;
  return (
    <>
      <NameDialog
        open={dialog?.kind === "create-workspace"}
        onOpenChange={onOpenChange}
        title="New workspace"
        submitLabel="Create workspace"
        withColor
        onSubmit={(name, _icon, color) => createWorkspace.mutateAsync({ name, color })}
      />
      {dialog?.kind === "workspace" && <WorkspaceDialogs ws={dialog.ws} open={dialog.dialog} onClose={onClose} />}
      {dialog?.kind === "invite" && <ShareDialog open onOpenChange={onOpenChange} scope="workspace" workspace={dialog.ws} />}

      <NameDialog
        open={dialog?.kind === "create-folder"}
        onOpenChange={onOpenChange}
        title="New folder"
        label="Folder name"
        submitLabel="Create folder"
        withColor
        onSubmit={async (name, _icon, color) => {
          if (dialog?.kind !== "create-folder") return;
          const base = await createBase.mutateAsync({ workspaceId: dialog.workspaceId, name, color });
          await navigate(`/base/${base.id}`);
        }}
      />
      <NameDialog
        open={!!renamingFolder}
        onOpenChange={onOpenChange}
        title="Rename folder"
        label="Folder name"
        initialValue={renamingFolder?.name ?? ""}
        onSubmit={(name) => (renamingFolder ? updateBase.mutateAsync({ id: renamingFolder.id, name }) : undefined)}
      />
      <ColorDialog
        open={dialog?.kind === "folder-color"}
        onOpenChange={onOpenChange}
        title="Folder color"
        value={dialog?.kind === "folder-color" ? dialog.base.color : null}
        onChange={(color) => dialog?.kind === "folder-color" && updateBase.mutate({ id: dialog.base.id, color })}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-folder"}
        onOpenChange={onOpenChange}
        title={`Delete ${dialog?.kind === "delete-folder" ? dialog.base.name : "folder"}?`}
        description="The folder and its collections move to the trash and can be restored for 30 days."
        confirmLabel="Delete folder"
        destructive
        // The server refuses the workspace's top level and says why; the dialog stays open with that answer.
        onConfirm={() => (dialog?.kind === "delete-folder" ? deleteBase.mutateAsync(dialog.base) : undefined)}
      />
      {dialog?.kind === "share-folder" && <ShareDialog open onOpenChange={onOpenChange} scope="base" base={dialog.base} workspaceName={dialog.workspaceName} table={null} view={null} initialTab="invite" />}

      <NameDialog
        open={dialog?.kind === "create-collection"}
        onOpenChange={onOpenChange}
        title="New collection"
        label="Collection name"
        submitLabel="Create collection"
        onSubmit={(name) => (dialog?.kind === "create-collection" ? createTable.mutateAsync({ baseId: dialog.baseId, name }) : undefined)}
      />
      {dialog?.kind === "create-collection-csv" && <NewTableFromCsvDialog open onOpenChange={onOpenChange} baseId={dialog.baseId} />}
      {dialog?.kind === "import-csv" && <ImportInto baseId={dialog.baseId} table={dialog.table} onOpenChange={onOpenChange} />}
      <NameDialog
        open={!!renamingCollection}
        onOpenChange={onOpenChange}
        title="Rename collection"
        label="Collection name"
        initialValue={renamingCollection?.table.name ?? ""}
        onSubmit={(name) => (renamingCollection ? updateTable.mutateAsync({ id: renamingCollection.table.id, baseId: renamingCollection.baseId, name }) : undefined)}
      />
      <ColorDialog
        open={dialog?.kind === "collection-color"}
        onOpenChange={onOpenChange}
        title="Collection color"
        value={dialog?.kind === "collection-color" ? dialog.table.color : null}
        onChange={(color) => dialog?.kind === "collection-color" && updateTable.mutate({ id: dialog.table.id, baseId: dialog.baseId, color })}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-collection"}
        onOpenChange={onOpenChange}
        title={`Delete ${dialog?.kind === "delete-collection" ? dialog.table.name : "collection"}?`}
        description="The collection and its records move to the trash and can be restored for 30 days."
        confirmLabel="Delete collection"
        destructive
        onConfirm={() => (dialog?.kind === "delete-collection" ? deleteTable.mutateAsync({ baseId: dialog.baseId, table: dialog.table }) : undefined)}
      />
    </>
  );
}

/** The import dialog needs the collection's properties, which the sidebar's summaries do not carry: it loads the folder's schema first. */
function ImportInto({ baseId, table, onOpenChange }: { baseId: string; table: TableSummary; onOpenChange: (open: boolean) => void }) {
  const schema = useQuery({ queryKey: keys.base(baseId), queryFn: () => api.bases.get(baseId) });
  const full = schema.data?.tables.find((t) => t.id === table.id);
  if (!full) return null;
  return <ImportCsvDialog open onOpenChange={onOpenChange} baseId={baseId} table={full} />;
}
