/**
 * What can be done with a view, as menu items: rename, duplicate, share, lock or unlock, delete, each
 * for those who may. The menu's "…" on a view row and the toolbar's right-click menu on a view button
 * show the same items from here.
 */
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, LockOpen, Pencil, Share2, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";
import type { BaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { canShareView } from "@/components/share/shareView";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";

/** Whether anyone in this role has something to do with the view (else no menu at all). */
export function hasViewActions(schema: BaseSchema, view: View, onDialog: ((dialog: BaseDialog) => void) | null): boolean {
  const role = schema.role;
  return basePermissions.configureView(role, view) || basePermissions.lockView(role, view) || (!!onDialog && canShareView(role, view));
}

export function ViewMenuItems({ schema, table, view: v, onDialog }: { schema: BaseSchema; table: Table; view: View; onDialog: ((dialog: BaseDialog) => void) | null }) {
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
            <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-view", view: v })}>
              <Pencil aria-hidden className="size-4" /> Rename view
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => duplicate.mutate(v.id)}>
            <Copy aria-hidden className="size-4" /> Duplicate view
          </DropdownMenuItem>
        </>
      )}
      {canShare && onDialog && (
        <DropdownMenuItem onSelect={() => onDialog({ kind: "share", table, view: v, tab: "view" })}>
          <Share2 aria-hidden className="size-4" /> Share view…
        </DropdownMenuItem>
      )}
      {canLock && (
        <DropdownMenuItem onSelect={() => toggleLock.mutate(v)}>
          {v.locked ? <LockOpen aria-hidden className="size-4" /> : <Lock aria-hidden className="size-4" />}
          {v.locked ? "Unlock view" : "Lock view"}
        </DropdownMenuItem>
      )}
      {canConfigure && onDialog && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger disabled={table.views.length <= 1} onSelect={() => onDialog({ kind: "delete-view", table, view: v })}>
            <Trash2 aria-hidden className="size-4" /> Delete view
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
