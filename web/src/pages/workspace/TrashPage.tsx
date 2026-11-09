/**
 * One Trash for everything the person could restore, from every workspace they belong to
 * (`GET /api/trash`), narrowed by workspace, folder and kind (APP-10). The filters live in the URL
 * (`?workspace=`, `?base=`, `?kind=`) so every Trash link in the menus opens it pre-filtered and
 * the back button undoes a filter.
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api, type TrashFilter, type TrashKind } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TrashItem } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { PlaceFilterBar, type PlaceFilterValue } from "@/components/filters/PlaceFilterBar";
import { trashDaysLeft, trashItemDeleted, trashItemHue, trashItemName, trashItemPlace, retentionDays } from "@/components/trash/trashItem";
import { useRestoreFromTrash } from "@/components/trash/useRestoreFromTrash";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorMark } from "@/components/ui/color-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedRow } from "@/components/ui/feed-row";
import { Skeleton } from "@/components/ui/skeleton";
import { topLevelOf } from "@/lib/topLevel";
import { HomeShell } from "@/shell/HomeShell";

/** The kind chips, in the order of the design. Views have no chip: they show under All. */
const KIND_CHIPS: { kind: TrashKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "record", label: "Records" },
  { kind: "field", label: "Properties" },
  { kind: "table", label: "Collections" },
  { kind: "base", label: "Folders" },
  { kind: "workspace", label: "Workspaces" },
];

const KINDS: readonly string[] = ["workspace", "base", "table", "field", "view", "record"];
const isTrashKind = (k: string | null): k is TrashKind => !!k && KINDS.includes(k);
const PARTS = ["workspace", "base"] as const;

export function TrashPage() {
  const [params, setParams] = useSearchParams();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const baseId = params.get("base");
  const kindParam = params.get("kind");
  const kind = isTrashKind(kindParam) ? kindParam : null;
  const list = useMemo(() => workspaces.data ?? [], [workspaces.data]);
  // A folder's Trash links with `?base=` alone: the sidebar shows the folder's workspace.
  const workspaceId = params.get("workspace") ?? list.find((w) => w.bases.some((b) => b.id === baseId))?.id ?? null;

  const filter: TrashFilter = {
    ...(params.get("workspace") ? { workspace_id: params.get("workspace")! } : {}),
    ...(baseId ? { base_id: baseId } : {}),
    ...(kind ? { kind } : {}),
  };
  const listing = useQuery({
    queryKey: keys.trashListing(filter),
    queryFn: () => api.trash.all(filter),
    // Deleting things elsewhere does not touch this cache, so ask again whenever the page opens.
    staleTime: 0,
    // Keep the rows on screen while another filter loads, instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });

  const update = (next: Partial<PlaceFilterValue>) => {
    const out = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) out.set(k, v);
      else out.delete(k);
    }
    setParams(out);
  };

  const filtered = !!(params.get("workspace") || baseId || kind);
  const topLevel = useMemo(() => new Set(list.flatMap((w) => (topLevelOf(w) ? [topLevelOf(w)!.id] : []))), [list]);

  return (
    <HomeShell workspaceId={workspaceId ?? undefined} title="Trash">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 md:px-10">
        <p className="text-label text-muted">Things stay here for {retentionDays(listing.data?.items ?? [])} days, then they're removed for good.</p>

        <PlaceFilterBar
          parts={PARTS}
          workspaces={list}
          value={{ workspace: params.get("workspace"), base: baseId, table: null, user: null, kind: null }}
          onChange={update}
          fallbackNames={{ base: listing.data?.items.find((i) => i.base_id === baseId)?.base_name ?? undefined }}
          label="Filter the trash"
          placeholder="Type to filter by workspace or folder"
        />
        <div role="group" aria-label="What kind of thing" className="flex flex-wrap gap-1.5">
          {KIND_CHIPS.map((c) => {
            const on = c.kind === kind;
            return (
              <Button key={c.label} size="sm" variant={on ? "soft" : "secondary"} aria-pressed={on} onClick={() => update({ kind: c.kind })} className="rounded-pill">
                {c.label}
              </Button>
            );
          })}
        </div>

        {listing.isPending ? (
          <Card padded={false} aria-hidden>
            <Skeleton className="m-2 h-10" />
            <Skeleton className="m-2 h-10" />
          </Card>
        ) : listing.isError ? (
          <div role="alert" className="flex flex-col items-center gap-3 text-ui text-muted">
            <p>Could not load the trash: {errorMessage(listing.error)}</p>
            <Button onClick={() => void listing.refetch()}>Try again</Button>
          </div>
        ) : listing.data.items.length === 0 ? (
          <EmptyState title={filtered ? "Nothing like that in the trash." : "The trash is empty."} />
        ) : (
          <TrashList items={listing.data.items} topLevel={topLevel} />
        )}
      </div>
    </HomeShell>
  );
}

function TrashList({ items, topLevel }: { items: TrashItem[]; topLevel: ReadonlySet<string> }) {
  const { data: me } = useMe();
  const restore = useRestoreFromTrash();
  const now = Date.now();
  return (
    <Card padded={false}>
      <ul aria-label="Deleted items" className="divide-y divide-line">
        {items.map((item) => {
          const name = trashItemName(item);
          const restoring = restore.isPending && restore.variables?.kind === item.kind && restore.variables.id === item.id;
          const left = trashDaysLeft(item, now);
          return (
            <li key={`${item.kind}:${item.id}`}>
              <FeedRow
                leading={<ColorMark hue={trashItemHue(item)} name={name} size={14} />}
                title={name}
                wrapMeta
                // On a phone the days left have no column of their own, so they lead the line.
                meta={
                  <>
                    <span className="md:hidden">{left} · </span>
                    {trashItemPlace(item, topLevel)} · {trashItemDeleted(item, me?.id, now)}
                  </>
                }
                trailing={
                  <span className="flex items-center gap-3">
                    <span className="max-md:hidden">{left}</span>
                    <Button aria-label={`Restore ${name}`} size="sm" loading={restoring} disabled={restore.isPending} onClick={() => restore.mutate(item)}>
                      Restore
                    </Button>
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
