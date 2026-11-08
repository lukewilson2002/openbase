/**
 * `/workspace/:workspaceId/automations`: every automation of the workspace, grouped by folder (APP-5).
 * A row opens the automation in its editor, which stays at `/base/:baseId/automations/:automationId`.
 * Creators and owners manage automations, so the screen is theirs; the folders listed are the ones the
 * person can open (NAV-10), the top level first. Every group links to its folder's automations, where
 * the first one is made, so the top level (which has no row or menu in the sidebar) is as reachable as a folder.
 */
import { Link, useNavigate, useParams } from "react-router";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { Automation, BaseSummary, WorkspaceSummary } from "@/api/types";
import { TRIGGER_LABELS } from "@/automations/model";
import { basePermissions } from "@/base/permissions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorMark } from "@/components/ui/color-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedRow } from "@/components/ui/feed-row";
import { Skeleton } from "@/components/ui/skeleton";
import { foldersOf, topLevelOf } from "@/lib/topLevel";
import { HomeShell } from "@/shell/HomeShell";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceAutomationsPage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} title="Automations">
      {ws ? <ByFolder ws={ws} /> : fallback}
    </HomeShell>
  );
}

function ByFolder({ ws }: { ws: WorkspaceSummary }) {
  const top = topLevelOf(ws);
  const groups = [...(top ? [{ base: top, label: "Top level" }] : []), ...foldersOf(ws).map((base) => ({ base, label: base.name }))].filter((g) => basePermissions.manageAutomations(g.base.role));
  const lists = useQueries({
    queries: groups.map((g) => ({ queryKey: keys.automations(g.base.id), queryFn: () => api.automations.list(g.base.id) })),
  });

  if (groups.length === 0) {
    return <EmptyState title="Automations are for creators" description="Only creators and owners can see and change a folder's automations. Ask one of them for access." className="py-20" />;
  }
  const loading = lists.some((l) => l.isPending);
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6" aria-busy={loading}>
      <p className="text-label text-muted">Do things automatically when records change, forms arrive, on a schedule or from a webhook.</p>
      {groups.map((g, i) => (
        <FolderGroup key={g.base.id} base={g.base} label={g.label} list={lists[i]!} />
      ))}
    </div>
  );
}

function FolderGroup({ base, label, list }: { base: BaseSummary; label: string; list: UseQueryResult<Automation[]> }) {
  const navigate = useNavigate();
  return (
    <section aria-labelledby={`automations-${base.id}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`automations-${base.id}`} className="flex min-w-0 items-center gap-2 text-h3">
          <ColorMark hue={base.color} name={base.name} size={14} />
          <span className="truncate">{label}</span>
        </h2>
        {/* The folder's own page holds the New automation button; a group with none yet is where the first one starts. */}
        <Button asChild size="sm">
          <Link to={`/base/${base.id}/automations`} aria-label={`New automation in ${label}`}>
            New automation
          </Link>
        </Button>
      </div>
      {list.isPending ? (
        <Card padded={false} aria-hidden>
          <Skeleton className="m-2 h-8" />
        </Card>
      ) : list.isError ? (
        <div role="alert" className="flex items-center gap-3 text-label text-muted">
          <span>Could not load these automations: {errorMessage(list.error)}</span>
          <Button size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : list.data.length === 0 ? (
        <p className="text-label text-muted">No automations yet.</p>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {list.data.map((a) => {
              const to = `/base/${base.id}/automations/${a.id}`;
              return (
                <li key={a.id}>
                  <FeedRow title={a.name} meta={`${a.enabled ? "On" : "Off"} · ${TRIGGER_LABELS[a.trigger.type]}`} href={to} onOpen={() => void navigate(to)} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
