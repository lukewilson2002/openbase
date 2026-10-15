import { Suspense, lazy } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { DeletedWorkspaces } from "@/components/trash/DeletedWorkspaces";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage } from "@/shell/AppPage";

const TrashDialog = lazy(() => import("@/components/trash/TrashDialog").then((m) => ({ default: m.TrashDialog })));

/** Deleted workspaces, restorable for a while. Deleted bases, tables and records are in each base's own trash. */
export function TrashPage() {
  const [params] = useSearchParams();
  const baseId = params.get("base");
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
      {baseId && <BaseTrash baseId={baseId} />}
    </AppPage>
  );
}

/**
 * A base's menu links its Trash here (`?base=`), to the one Trash page that lists everything. Until
 * that page lists a base's tables, fields and records itself, this opens the base's own trash over
 * it, so restoring them stays one click from the base; closing it goes back to the base.
 */
function BaseTrash({ baseId }: { baseId: string }) {
  const navigate = useNavigate();
  const base = useQuery({ queryKey: keys.base(baseId), queryFn: () => api.bases.get(baseId) });
  if (!base.data) return null;
  return (
    <Suspense fallback={null}>
      <TrashDialog open schema={base.data} onOpenChange={(open) => !open && void navigate(`/base/${baseId}`)} />
    </Suspense>
  );
}
