/**
 * What can be done with a view, as menu items: rename, duplicate, share, lock or unlock, delete, each
 * for those who may. A view tab's menu shows them (with its own Move left and right). Drawn as
 * dropdown items on a desktop and as rows of a bottom sheet on a phone (`MenuItem`).
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, LockOpen, Pencil, Share2, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import type { BaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { canShareView } from "@/components/share/shareView";
import { useToast } from "@/components/ui/toast";
import { MenuItem, MenuSeparator } from "@/shell/menuItems";

/** Whether anyone in this role has something to do with the view (else no menu at all). */
export function hasViewActions(schema: BaseSchema, view: View, onDialog: ((dialog: BaseDialog) => void) | null): boolean {
  const role = schema.role;
  return basePermissions.configureView(role, view) || basePermissions.lockView(role, view) || (!!onDialog && canShareView(role, view));
}

/** `extra` is more items for the menu of a place that has its own (reordering), before Delete. */
export function ViewMenuItems({ schema, table, view: v, onDialog, extra }: { schema: BaseSchema; table: Table; view: View; onDialog: ((dialog: BaseDialog) => void) | null; extra?: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const role = schema.role;
  const canConfigure = basePermissions.configureView(role, v);
  const canLock = basePermissions.lockView(role, v);
  const canShare = !!onDialog && canShareView(role, v);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.base(schema.id) });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.views.duplicate(id),
    onSuccess: async (view) => {
      await refresh();
      if (view?.id) navigate(`/base/${schema.id}/${table.id}/${view.id}`);
    },
    onError: (e) => toast.error(e, "Could not duplicate view"),
  });
  const toggleLock = useMutation({
    mutationFn: (view: View) => api.views.update(view.id, { locked: !view.locked }),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not change the lock"),
  });

  return (
    <>
      {canConfigure && (
        <>
          {onDialog && (
            <MenuItem icon={Pencil} onSelect={() => onDialog({ kind: "rename-view", view: v })}>
              Rename view
            </MenuItem>
          )}
          <MenuItem icon={Copy} onSelect={() => duplicate.mutate(v.id)}>
            Duplicate view
          </MenuItem>
        </>
      )}
      {canShare && onDialog && (
        <MenuItem icon={Share2} onSelect={() => onDialog({ kind: "share", table, view: v, tab: "view" })}>
          Share view…
        </MenuItem>
      )}
      {canLock && (
        <MenuItem icon={v.locked ? LockOpen : Lock} onSelect={() => toggleLock.mutate(v)}>
          {v.locked ? "Unlock view" : "Lock view"}
        </MenuItem>
      )}
      {extra}
      {canConfigure && onDialog && (
        <>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger disabled={v.is_default} onSelect={() => onDialog({ kind: "delete-view", table, view: v })}>
            Delete view
          </MenuItem>
        </>
      )}
    </>
  );
}
