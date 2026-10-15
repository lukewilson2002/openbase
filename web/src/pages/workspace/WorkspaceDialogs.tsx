import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { IconPickerDialog } from "@/components/icons/IconPicker";
import { iconPatch } from "@/components/icons/iconPatch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { rememberWorkspace } from "./lastWorkspace";

export type WorkspaceDialog = "rename" | "icon" | "delete" | null;

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { id: string; name?: string; icon?: string | null }) => api.workspaces.update(v.id, { name: v.name, icon: v.icon }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.workspaces }),
    onError: (e) => toast.error(e, "Could not update workspace"),
  });
}

/** Rename, change the icon of and delete a workspace (owners). Deleting leaves for the home page. */
export function WorkspaceDialogs({ ws, open, onClose }: { ws: WorkspaceSummary; open: WorkspaceDialog; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const update = useUpdateWorkspace();
  const remove = useMutation({
    mutationFn: () => api.workspaces.remove(ws.id),
    onSuccess: async () => {
      rememberWorkspace(null);
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      void qc.invalidateQueries({ queryKey: keys.deletedWorkspaces });
      await navigate("/", { replace: true });
    },
  });
  const onOpenChange = (o: boolean) => !o && onClose();

  return (
    <>
      <NameDialog
        open={open === "rename"}
        onOpenChange={onOpenChange}
        title="Rename workspace"
        initialValue={ws.name}
        withIcon
        initialIcon={ws.icon ?? null}
        onSubmit={(name, icon) => update.mutateAsync({ id: ws.id, name, ...iconPatch(ws.icon, icon) })}
      />
      <IconPickerDialog open={open === "icon"} onOpenChange={onOpenChange} title="Workspace icon" value={ws.icon} onChange={(icon) => update.mutate({ id: ws.id, icon })} />
      <ConfirmDialog
        open={open === "delete"}
        onOpenChange={onOpenChange}
        title={`Delete ${ws.name}?`}
        description="The workspace and all of its bases move to the trash. Restore it from Trash in the menu for 30 days."
        confirmLabel="Delete workspace"
        destructive
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  );
}
