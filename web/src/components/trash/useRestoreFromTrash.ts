import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TrashItem } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { trashItemName } from "./trashItem";

/**
 * `POST /api/trash/restore` for one trash item, with the toasts and the caches it touches: every
 * trash listing, the workspace list (bases and their table names), the base's schema (a restored
 * table, field or view shows up in the open base) and records (a restored record or field shows
 * up in every view).
 */
export function useRestoreFromTrash() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (item: TrashItem) => api.trash.restore({ kind: item.kind, id: item.id }),
    onSuccess: (_res, item) => {
      toast.toast({ title: `Restored ${trashItemName(item)}`, variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.trash });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      if (item.base_id) void qc.invalidateQueries({ queryKey: keys.base(item.base_id) });
      if (item.kind === "record" || item.kind === "field") void qc.invalidateQueries({ queryKey: ["records"] });
    },
    onError: (e, item) => {
      toast.error(e, `Could not restore ${trashItemName(item)}`);
      // It may have been restored, or removed for good, somewhere else in the meantime.
      void qc.invalidateQueries({ queryKey: keys.trash });
    },
  });
}
