/**
 * The dialogs the open folder's views open (from the view toolbar): new, renamed and deleted views, and
 * Share. They live here, beside the page rather than inside the toolbar, because they need the open
 * folder's schema. The sidebar's dialogs (folders, collections, CSV imports) are `NavDialogs`, which work
 * from any page.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View, ViewType } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { VIEW_TYPE_META } from "@/views/meta";
import { basePermissions } from "./permissions";

export type BaseDialog =
  | { kind: "create-view"; table: Table; type: ViewType }
  | { kind: "rename-view"; view: View }
  | { kind: "delete-view"; table: Table; view: View }
  | { kind: "share"; table: Table | null; view: View | null; tab: "invite" | "view" };

/**
 * Opens one of these dialogs from anywhere inside the open folder (the view toolbar's Add view);
 * null outside a folder, where the callers leave those actions out.
 */
export const BaseDialogContext = createContext<((dialog: BaseDialog) => void) | null>(null);

export function useBaseDialog(): ((dialog: BaseDialog) => void) | null {
  return useContext(BaseDialogContext);
}

export interface BaseDialogsProps {
  schema: BaseSchema;
  activeViewId: string | undefined;
  dialog: BaseDialog | null;
  onClose: () => void;
}

export function BaseDialogs({ schema, activeViewId, dialog, onClose }: BaseDialogsProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canCreateShared = basePermissions.createSharedView(schema.role);
  const [personal, setPersonal] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });
  const onOpenChange = (open: boolean) => !open && onClose();

  // Each "new view" starts shared for creators; a tick left from the last one would surprise them.
  useEffect(() => {
    if (dialog?.kind === "create-view") setPersonal(false);
  }, [dialog]);

  const createView = useMutation({
    mutationFn: (v: { tableId: string; name: string; type: ViewType; personal: boolean }) => api.views.create(v.tableId, { name: v.name, type: v.type, personal: v.personal, config: null }),
    onSuccess: async (view, v) => {
      await refresh();
      navigate(`/base/${schema.id}/${v.tableId}/${view.id}`);
    },
  });
  const renameView = useMutation({ mutationFn: (v: { id: string; name: string }) => api.views.update(v.id, { name: v.name }), onSuccess: refresh });
  const removeView = useMutation({
    mutationFn: (v: { id: string; tableId: string }) => api.views.remove(v.id),
    onSuccess: async (_r, v) => {
      await refresh();
      if (v.id === activeViewId) navigate(`/base/${schema.id}/${v.tableId}`, { replace: true });
    },
  });

  const creating = dialog?.kind === "create-view" ? dialog : null;
  // The share dialog follows the schema: a link made or a view renamed shows without reopening it.
  const shareTable = dialog?.kind === "share" && dialog.table ? (schema.tables.find((t) => t.id === dialog.table!.id) ?? dialog.table) : null;

  return (
    <>
      <NameDialog
        open={!!creating}
        onOpenChange={onOpenChange}
        title={creating ? `New ${VIEW_TYPE_META[creating.type].label.toLowerCase()} view` : "New view"}
        initialValue={creating ? VIEW_TYPE_META[creating.type].defaultName : ""}
        submitLabel="Create view"
        extra={
          canCreateShared ? (
            <Checkbox checked={personal} onCheckedChange={setPersonal} label="Personal view (only visible to me)" />
          ) : (
            <p className="text-[0.8125rem] text-muted">This view will be personal: only you can see it.</p>
          )
        }
        onSubmit={(name) => (creating ? createView.mutateAsync({ tableId: creating.table.id, name, type: creating.type, personal: canCreateShared ? personal : true }) : undefined)}
      />
      <NameDialog
        open={dialog?.kind === "rename-view"}
        onOpenChange={onOpenChange}
        title="Rename view"
        initialValue={dialog?.kind === "rename-view" ? dialog.view.name : ""}
        onSubmit={(name) => (dialog?.kind === "rename-view" ? renameView.mutateAsync({ id: dialog.view.id, name }) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-view"}
        onOpenChange={onOpenChange}
        title={`Delete ${dialog?.kind === "delete-view" ? dialog.view.name : "view"}?`}
        description="Records are not affected; only this view is removed."
        confirmLabel="Delete view"
        destructive
        onConfirm={() => (dialog?.kind === "delete-view" ? removeView.mutateAsync({ id: dialog.view.id, tableId: dialog.table.id }) : undefined)}
      />

      {dialog?.kind === "share" && (
        <ShareDialog open onOpenChange={onOpenChange} scope="base" base={schema} workspaceName={schema.workspace_name} table={shareTable} view={dialog.view} initialTab={dialog.tab} />
      )}
    </>
  );
}
