/**
 * The dialogs the open folder's screen opens (from the collection header and the view tabs): renamed and
 * deleted views, Share, and the collection's settings. They live here, beside the page rather than inside
 * the header or the tabs, because they need the open folder's schema. The sidebar's dialogs (folders,
 * collections, CSV imports) are `NavDialogs`, which work from any page.
 */
import { createContext, useContext } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CollectionSettings } from "./CollectionSettings";

export type BaseDialog =
  | { kind: "rename-view"; view: View }
  | { kind: "delete-view"; table: Table; view: View }
  | { kind: "share"; table: Table | null; view: View | null; tab: "invite" | "view" }
  | { kind: "collection-settings"; table: Table };

/**
 * Opens one of these dialogs from anywhere inside the open folder (a view tab's menu);
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
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });
  const onOpenChange = (open: boolean) => !open && onClose();

  const renameView = useMutation({ mutationFn: (v: { id: string; name: string }) => api.views.update(v.id, { name: v.name }), onSuccess: refresh });
  const removeView = useMutation({
    mutationFn: (v: { id: string; tableId: string }) => api.views.remove(v.id),
    onSuccess: async (_r, v) => {
      await refresh();
      if (v.id === activeViewId) navigate(`/base/${schema.id}/${v.tableId}`, { replace: true });
    },
  });

  // The share dialog follows the schema: a link made or a view renamed shows without reopening it.
  const shareTable = dialog?.kind === "share" && dialog.table ? (schema.tables.find((t) => t.id === dialog.table!.id) ?? dialog.table) : null;

  return (
    <>
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

      {dialog?.kind === "collection-settings" && (
        // Follows the schema as the share dialog does; a collection deleted meanwhile closes it.
        <CollectionSettingsFor schema={schema} table={dialog.table} onOpenChange={onOpenChange} />
      )}
      {dialog?.kind === "share" && (
        <ShareDialog open onOpenChange={onOpenChange} scope="base" base={schema} workspaceName={schema.workspace_name} table={shareTable} view={dialog.view} initialTab={dialog.tab} />
      )}
    </>
  );
}

function CollectionSettingsFor({ schema, table, onOpenChange }: { schema: BaseSchema; table: Table; onOpenChange: (open: boolean) => void }) {
  const current = schema.tables.find((t) => t.id === table.id) ?? table;
  return <CollectionSettings table={current} baseId={schema.id} open onOpenChange={onOpenChange} />;
}
