/**
 * "Recently deleted workspaces" on the Trash page: the caller's own deleted workspaces (they must be
 * an owner) with a Restore button each. `GET /api/trash/workspaces`, then `POST /api/trash/restore`.
 * A deleted workspace has no trash endpoint of its own any more, so this is the way back to it.
 * Renders nothing while loading, when the list is empty, or when it cannot be loaded.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TrashItem } from "@/api/types";
import { EntityLabel } from "@/components/icons/EntityIcon";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { relativeTime } from "@/lib/relativeTime";
import { DEFAULT_RETENTION_DAYS } from "./api";

export function DeletedWorkspaces() {
  const qc = useQueryClient();
  const toast = useToast();
  const [restoring, setRestoring] = useState<string | null>(null);
  const listing = useQuery({ queryKey: keys.deletedWorkspaces, queryFn: api.trash.deletedWorkspaces });

  const restore = useMutation({
    mutationFn: (item: TrashItem) => api.trash.restore({ kind: "workspace", id: item.id }),
    onMutate: (item) => setRestoring(item.id),
    onSuccess: (_res, item) => {
      toast.toast({ title: `Restored ${item.name}`, variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      void qc.invalidateQueries({ queryKey: keys.deletedWorkspaces });
    },
    onError: (e, item) => {
      toast.error(e, `Could not restore ${item.name}`);
      // It may have been restored (or purged) elsewhere in the meantime.
      void qc.invalidateQueries({ queryKey: keys.deletedWorkspaces });
    },
    onSettled: () => setRestoring(null),
  });

  const items = listing.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="deleted-workspaces">
      <h2 id="deleted-workspaces" className="text-[0.9375rem]">
        Recently deleted workspaces
      </h2>
      <p className="mb-3 mt-1 text-[0.8125rem] text-muted">
        A deleted workspace and its bases stay here for {DEFAULT_RETENTION_DAYS} days by default, then they are removed for good. Restore brings it back as it was.
      </p>
      <ul className="divide-y divide-line rounded-md border border-line bg-surface">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-medium">
                <EntityLabel icon={item.icon}>{item.name}</EntityLabel>
              </p>
              <p className="text-xs text-muted">Deleted {relativeTime(item.deleted_at)}</p>
            </div>
            <Button size="sm" aria-label={`Restore ${item.name}`} loading={restoring === item.id} disabled={restore.isPending} onClick={() => restore.mutate(item)}>
              <RotateCcw aria-hidden className="size-3.5" /> Restore
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
