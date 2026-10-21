/**
 * One Trash for everything the person could restore, from every workspace they belong to
 * (`GET /api/trash`), narrowed by workspace, base and kind. The filters live in the URL
 * (`?workspace=`, `?base=`, `?kind=`) so every Trash link in the menus opens it pre-filtered and
 * the back button undoes a filter.
 */
import { useSearchParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Eye, PanelLeft, PanelTop, Table2 } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api, type TrashFilter, type TrashKind } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TrashItem } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { BaseFilter, WorkspaceFilter } from "@/components/filters/PlaceFilters";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { trashDaysLeft, trashItemDeleted, trashItemName, trashItemPlace, retentionDays } from "@/components/trash/trashItem";
import { useRestoreFromTrash } from "@/components/trash/useRestoreFromTrash";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { HomeShell } from "@/shell/HomeShell";

/** The type chips, in the order of the design. Views have no chip: they show under All. */
const KIND_CHIPS: { kind: TrashKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "record", label: "Records" },
  { kind: "field", label: "Fields" },
  { kind: "table", label: "Tables" },
  { kind: "base", label: "Projects" },
  { kind: "workspace", label: "Workspaces" },
];

const KINDS: readonly string[] = ["workspace", "base", "table", "field", "view", "record"];
const isTrashKind = (k: string | null): k is TrashKind => !!k && KINDS.includes(k);

export function TrashPage() {
  const [params, setParams] = useSearchParams();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const baseId = params.get("base");
  const kindParam = params.get("kind");
  const kind = isTrashKind(kindParam) ? kindParam : null;
  // A base's Trash links with `?base=` alone: the workspace filter shows the base's workspace.
  const workspaceId = params.get("workspace") ?? workspaces.data?.find((w) => w.bases.some((b) => b.id === baseId))?.id ?? null;

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
    // Keep the rows on screen while another filter loads, instead of flashing a spinner.
    placeholderData: keepPreviousData,
  });

  const update = (next: { workspace?: string | null; base?: string | null; kind?: TrashKind | null }) => {
    const out = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) out.set(k, v);
      else out.delete(k);
    }
    setParams(out);
  };

  const filtered = !!(workspaceId || baseId || kind);

  return (
    <HomeShell workspaceId={workspaceId ?? undefined}>
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6 md:px-8 md:py-8">
        <h1 className="text-[1.625rem] leading-tight tracking-[-0.015em]">Trash</h1>

        <div className="flex flex-wrap items-center gap-2">
          <WorkspaceFilter workspaces={workspaces.data ?? []} value={workspaceId} onChange={(id) => update({ workspace: id, base: null })} />
          <BaseFilter
            workspaces={workspaces.data ?? []}
            workspaceId={workspaceId}
            value={baseId}
            fallbackName={listing.data?.items.find((i) => i.base_id === baseId)?.base_name}
            onChange={(id, ws) => update({ base: id, workspace: id ? ws : workspaceId })}
          />
          <span aria-hidden className="mx-1 h-[22px] w-px bg-line max-sm:hidden" />
          {/* One swipeable row on phones, rather than two lines of chips above the list. */}
          <div
            role="group"
            aria-label="What kind of thing"
            className="flex flex-wrap gap-1 max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-4 max-sm:[scrollbar-width:none]"
          >
            {KIND_CHIPS.map((c) => {
              const on = c.kind === kind;
              return (
                <button
                  key={c.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ kind: c.kind })}
                  className={cn(
                    "h-8 shrink-0 rounded-full border px-3 text-[0.8125rem] font-semibold transition-colors pointer-coarse:h-10",
                    on ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-muted hover:bg-hover",
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        {listing.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner className="size-5" label="Loading the trash" />
          </div>
        ) : listing.isError ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-surface p-7 text-center text-sm">
            <p className="text-muted">Could not load the trash: {errorMessage(listing.error)}</p>
            <Button onClick={() => void listing.refetch()}>Try again</Button>
          </div>
        ) : listing.data.items.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-line-strong bg-surface p-7 text-center text-sm text-muted">
            {filtered ? "Nothing like that in the trash." : "The trash is empty."}
          </p>
        ) : (
          <TrashList items={listing.data.items} />
        )}

        <p className="text-[0.8125rem] text-faint">Things stay here for {retentionDays(listing.data?.items ?? [])} days, then they're removed for good.</p>
      </div>
    </HomeShell>
  );
}

function TrashList({ items }: { items: TrashItem[] }) {
  const { data: me } = useMe();
  const restore = useRestoreFromTrash();
  const now = Date.now();
  return (
    <ul aria-label="Deleted items" className="overflow-hidden rounded-[14px] border border-line bg-surface">
      {items.map((item) => {
        const name = trashItemName(item);
        const restoring = restore.isPending && restore.variables?.kind === item.kind && restore.variables.id === item.id;
        const left = trashDaysLeft(item, now);
        return (
          <li key={`${item.kind}:${item.id}`} className="flex items-center gap-3.5 border-b border-[color-mix(in_srgb,var(--line)_60%,var(--surface))] px-4 py-3.5 last:border-b-0 sm:px-[18px]">
            <ItemIcon item={item} />
            <div className="min-w-0 flex-1">
              <p className="min-w-0 break-words text-[0.9375rem] font-semibold">{name}</p>
              <p className="mt-0.5 text-[0.8125rem] text-muted sm:truncate">
                {trashItemPlace(item)} · {trashItemDeleted(item, me?.id, now)}
              </p>
              <p className="mt-0.5 text-[0.8125rem] text-faint sm:hidden">{left}</p>
            </div>
            <span className="whitespace-nowrap text-[0.8125rem] text-faint max-sm:hidden">{left}</span>
            <Button
              aria-label={`Restore ${name}`}
              loading={restoring}
              disabled={restore.isPending}
              onClick={() => restore.mutate(item)}
              className="h-9 shrink-0 rounded-[9px] px-3.5 text-sm font-semibold"
            >
              Restore
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const PLAIN_ICONS = { record: PanelTop, field: PanelLeft, table: Table2, view: Eye } as const;

/** A deleted base or workspace shows its own tile; anything else a grey icon of its kind. */
function ItemIcon({ item }: { item: TrashItem }) {
  const tile = "size-9 rounded-[9px]";
  if (item.kind === "workspace") return <WorkspaceTile ws={{ name: item.name, icon: item.icon, color: item.workspace_color }} size="md" className={cn(tile, "text-[0.9375rem]")} />;
  if (item.kind === "base") return <EntityTile name={item.name} icon={item.icon ?? item.base_icon} color={item.base_color} size="md" className={tile} />;
  const Icon = PLAIN_ICONS[item.kind as keyof typeof PLAIN_ICONS] ?? PanelTop;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center bg-subtle text-muted", tile)}>
      <Icon className="size-[18px]" strokeWidth={1.8} />
    </span>
  );
}
