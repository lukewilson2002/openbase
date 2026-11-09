import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { ColorDialog } from "@/components/ColorDialog";
import { NameDialog } from "@/components/NameDialog";
import { movesToTrash, useTrashDays } from "@/components/trash/retention";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { workspaceColor } from "@/lib/workspaceColor";
import { rememberWorkspace } from "./lastWorkspace";

export type WorkspaceDialog = "rename" | "color" | "delete" | null;

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { id: string; name?: string; color?: string }) => api.workspaces.update(v.id, { name: v.name, color: v.color }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.workspaces }),
    onError: (e) => toast.error(e, "Could not update workspace"),
  });
}

/** Rename, change the color of and delete a workspace (owners). Deleting leaves for the home page. Workspaces have colors, not icons (decision 3). */
export function WorkspaceDialogs({ ws, open, onClose }: { ws: WorkspaceSummary; open: WorkspaceDialog; onClose: () => void }) {
  const qc = useQueryClient();
  const trashDays = useTrashDays();
  const navigate = useNavigate();
  const update = useUpdateWorkspace();
  const remove = useMutation({
    mutationFn: () => api.workspaces.remove(ws.id),
    onSuccess: async () => {
      rememberWorkspace(null);
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      void qc.invalidateQueries({ queryKey: keys.trash });
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
        onSubmit={(name) => update.mutateAsync({ id: ws.id, name })}
      />
      <ColorDialog open={open === "color"} onOpenChange={onOpenChange} title="Workspace color" value={workspaceColor(ws)} onChange={(color) => update.mutate({ id: ws.id, color })} />
      <ConfirmDialog
        open={open === "delete"}
        onOpenChange={onOpenChange}
        title={`Delete ${ws.name}?`}
        description={movesToTrash(trashDays, "The workspace and everything in it", true)}
        confirmLabel="Delete workspace"
        destructive
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  );
}
