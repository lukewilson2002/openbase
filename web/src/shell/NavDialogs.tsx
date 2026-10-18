/**
 * The dialogs the menu's workspace and project rows open: a new workspace or project, a
 * spreadsheet import, rename, icon, delete, and inviting people. They live here, around the page
 * rather than inside the menu, because on a phone the menu is a drawer that unmounts when it
 * closes, and a dialog inside it would vanish with it. Both shells (the home pages and a project)
 * wrap their frame in `NavDialogsProvider`; the menu and the empty workspace page open dialogs
 * through `useNavDialog`. A table's and a view's dialogs stay in `BaseDialogs`, which needs the
 * open project's schema.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { NewTableFromCsvDialog } from "@/components/csv/LazyCsvDialogs";
import { IconPickerDialog } from "@/components/icons/IconPicker";
import { iconPatch } from "@/components/icons/iconPatch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { WorkspaceDialogs, type WorkspaceDialog } from "@/pages/workspace/WorkspaceDialogs";
import { useCreateWorkspace } from "./useCreateWorkspace";

export type NavDialog =
  | { kind: "create-workspace" }
  /** Rename, change the icon of, or delete a workspace. */
  | { kind: "workspace"; ws: WorkspaceSummary; dialog: NonNullable<WorkspaceDialog> }
  | { kind: "invite"; ws: WorkspaceSummary }
  | { kind: "create-project"; workspaceId: string }
  | { kind: "import-project"; workspaceId: string }
  | { kind: "rename-project"; base: BaseSummary }
  | { kind: "project-icon"; base: BaseSummary }
  | { kind: "delete-project"; base: BaseSummary }
  | { kind: "share-project"; base: BaseSummary; workspaceName: string };

const NavDialogContext = createContext<(dialog: NavDialog) => void>(() => {});

/** Opens one of the menu's dialogs; a no-op outside `NavDialogsProvider`. */
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

  const createBase = useMutation({
    mutationFn: (v: { workspaceId: string; name: string; icon?: string | null; empty: boolean }) => api.bases.create(v.workspaceId, { name: v.name, ...(v.icon ? { icon: v.icon } : {}), empty: v.empty }),
    onSuccess: () => void refreshWorkspaces(),
  });
  const updateBase = useMutation({
    mutationFn: (v: { id: string; name?: string; icon?: string | null }) => api.bases.update(v.id, { name: v.name, icon: v.icon }),
    onSuccess: (_base, v) => {
      void refreshWorkspaces();
      void qc.invalidateQueries({ queryKey: keys.base(v.id) });
    },
    onError: (e) => toast.error(e, "Could not change the project"),
  });
  const deleteBase = useMutation({
    mutationFn: (base: BaseSummary) => api.bases.remove(base.id),
    onSuccess: async (_res, base) => {
      // Gone from the menu at once, so leaving its page does not land on it again through the last place.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => cur?.map((w) => (w.id === base.workspace_id ? { ...w, bases: w.bases.filter((b) => b.id !== base.id) } : w)));
      if (pathname.startsWith(`/base/${base.id}`)) await navigate(`/workspace/${base.workspace_id}`, { replace: true });
      void refreshWorkspaces();
      void qc.invalidateQueries({ queryKey: keys.trash });
    },
  });

  const renaming = dialog?.kind === "rename-project" ? dialog.base : null;
  return (
    <>
      <NameDialog
        open={dialog?.kind === "create-workspace"}
        onOpenChange={onOpenChange}
        title="New workspace"
        submitLabel="Create workspace"
        withIcon
        onSubmit={(name, icon) => createWorkspace.mutateAsync({ name, icon })}
      />
      {dialog?.kind === "workspace" && <WorkspaceDialogs ws={dialog.ws} open={dialog.dialog} onClose={onClose} />}
      {dialog?.kind === "invite" && <ShareDialog open onOpenChange={onOpenChange} scope="workspace" workspace={dialog.ws} />}

      <NameDialog
        open={dialog?.kind === "create-project"}
        onOpenChange={onOpenChange}
        title="New project"
        label="Project name"
        submitLabel="Create project"
        withIcon
        onSubmit={async (name, icon) => {
          if (dialog?.kind !== "create-project") return;
          const base = await createBase.mutateAsync({ workspaceId: dialog.workspaceId, name, icon, empty: true });
          await navigate(`/base/${base.id}`);
        }}
      />
      {dialog?.kind === "import-project" && (
        <NewTableFromCsvDialog open onOpenChange={onOpenChange} createBase={async (name) => (await createBase.mutateAsync({ workspaceId: dialog.workspaceId, name, empty: true })).id} />
      )}
      <NameDialog
        open={!!renaming}
        onOpenChange={onOpenChange}
        title="Rename project"
        label="Project name"
        initialValue={renaming?.name ?? ""}
        withIcon
        initialIcon={renaming?.icon ?? null}
        onSubmit={(name, icon) => (renaming ? updateBase.mutateAsync({ id: renaming.id, name, ...iconPatch(renaming.icon, icon) }) : undefined)}
      />
      <IconPickerDialog
        open={dialog?.kind === "project-icon"}
        onOpenChange={onOpenChange}
        title="Project icon"
        value={dialog?.kind === "project-icon" ? dialog.base.icon : null}
        onChange={(icon) => dialog?.kind === "project-icon" && updateBase.mutate({ id: dialog.base.id, icon })}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-project"}
        onOpenChange={onOpenChange}
        title={`Delete ${dialog?.kind === "delete-project" ? dialog.base.name : "project"}?`}
        description="The project moves to the trash and can be restored for 30 days."
        confirmLabel="Delete project"
        destructive
        onConfirm={() => (dialog?.kind === "delete-project" ? deleteBase.mutateAsync(dialog.base) : undefined)}
      />
      {dialog?.kind === "share-project" && <ShareDialog open onOpenChange={onOpenChange} scope="base" base={dialog.base} workspaceName={dialog.workspaceName} table={null} view={null} initialTab="invite" />}
    </>
  );
}
