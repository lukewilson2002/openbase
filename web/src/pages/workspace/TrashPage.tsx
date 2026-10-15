import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { DeletedWorkspaces } from "@/components/trash/DeletedWorkspaces";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage } from "@/shell/AppPage";

/** Deleted workspaces, restorable for a while. Deleted bases, tables and records are in each base's own trash. */
export function TrashPage() {
  const listing = useQuery({ queryKey: keys.deletedWorkspaces, queryFn: api.trash.deletedWorkspaces });
  const empty = listing.isSuccess && listing.data.items.length === 0;
  return (
    <AppPage title="Trash">
      <p className="-mt-3 mb-6 text-[0.8125rem] text-muted">Deleted bases, tables and records are in the trash of the base they were in.</p>
      {empty || listing.isError ? (
        <EmptyState icon={<Trash2 />} title="No deleted workspaces" description="A workspace you delete waits here before it is removed for good, so you can bring it back." />
      ) : (
        <DeletedWorkspaces />
      )}
    </AppPage>
  );
}
