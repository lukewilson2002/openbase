/**
 * One History for everything the person can open: the changes and comments on records in every
 * folder of every workspace they belong to (`GET /api/history`), like the Trash page but for
 * keeping up (APP-9). Activity on one record is grouped into a card; days are told apart by a heading;
 * every item shows how long ago and the exact time. The filters are chips in a bar like a collection's, and
 * live in the URL (`?workspace=`, `?base=`, `?table=`, `?user=`, `?kind=`, `?order=oldest`) so the menus can
 * link to a filtered feed and the back button undoes a filter.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api, type HistoryFilter, type HistoryKind } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ActivityPage, Field } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { PlaceFilterBar, type PlaceFilterValue, type PlacePerson } from "@/components/filters/PlaceFilterBar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { FormatCtx } from "@/lib/cells/format";
import { browserTimeZone } from "@/lib/format";
import { topLevelOf } from "@/lib/topLevel";
import { HomeShell } from "@/shell/HomeShell";
import { groupActivity, sectionByDay } from "./activity";
import { ActivityCard } from "./ActivityCard";

/** What the kind filter offers, with the words the page uses for each. */
const KINDS: { value: HistoryKind; label: string }[] = [
  { value: "update", label: "Changes" },
  { value: "create", label: "New records" },
  { value: "delete", label: "Deleted" },
  { value: "restore", label: "Restored" },
  { value: "comment", label: "Comments" },
];
const isKind = (k: string | null): k is HistoryKind => !!k && KINDS.some((x) => x.value === k);

const PARTS = ["workspace", "base", "table", "user", "kind"] as const;

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const { data: me } = useMe();
  const timeZone = me?.timezone || browserTimeZone();
  const baseId = params.get("base");
  const tableId = params.get("table");
  const userId = params.get("user");
  const kindParam = params.get("kind");
  const kind = isKind(kindParam) ? kindParam : null;
  const order = params.get("order") === "oldest" ? "oldest" : "newest";
  const list = useMemo(() => workspaces.data ?? [], [workspaces.data]);
  // A folder's History links with `?base=` alone: the sidebar shows the folder's workspace.
  const workspaceId = params.get("workspace") ?? list.find((w) => w.bases.some((b) => b.id === baseId))?.id ?? null;

  const filter: HistoryFilter = {
    ...(params.get("workspace") ? { workspace: params.get("workspace")! } : {}),
    ...(baseId ? { base: baseId } : {}),
    ...(tableId ? { table: tableId } : {}),
    ...(userId ? { user: userId } : {}),
    ...(kind ? { kind } : {}),
    ...(order === "oldest" ? { order } : {}),
  };
  const feed = useInfiniteQuery({
    queryKey: keys.historyFeed(filter),
    queryFn: ({ pageParam }) => api.history.list({ ...filter, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ActivityPage) => last.next ?? undefined,
    // Changes happen elsewhere and this cache is not told, so ask again whenever the page opens.
    staleTime: 0,
    // Keep the cards on screen while another filter loads, instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });

  const update = (next: Partial<PlaceFilterValue & { order: "newest" | "oldest" }>) => {
    const out = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "order" && v === "newest")) out.set(k, v);
      else out.delete(k);
    }
    setParams(out);
  };

  const items = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
  const fields = useMemo(() => Object.assign({}, ...(feed.data?.pages.map((p) => p.fields) ?? [])) as Record<string, Field>, [feed.data]);
  const people = usePeople(
    workspaceId,
    list.map((w) => w.id),
  );
  const nameOf = useMemo(() => new Map(people.map((p) => [p.id, p.name] as const)), [people]);
  const authors = useMemo(() => new Map(items.flatMap((i) => (i.author ? [[i.author.id, i.author.name] as const] : []))), [items]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => nameOf.get(id) ?? authors.get(id) }), [timeZone, nameOf, authors]);
  const topLevel = useMemo(() => new Set(list.flatMap((w) => (topLevelOf(w) ? [topLevelOf(w)!.id] : []))), [list]);
  const now = useNow();
  const sections = useMemo(() => sectionByDay(groupActivity(items, timeZone), now, timeZone), [items, timeZone, now]);

  const filtered = !!(params.get("workspace") || baseId || tableId || userId || kind);
  const asc = order === "oldest";

  return (
    <HomeShell workspaceId={workspaceId ?? undefined} title="History">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 md:px-10">
        <p className="text-label text-muted">Recent changes and comments across your folders.</p>

        <div className="flex flex-wrap items-start gap-2">
          <PlaceFilterBar
            parts={PARTS}
            workspaces={list}
            people={people}
            kinds={KINDS}
            value={{ workspace: params.get("workspace"), base: baseId, table: tableId, user: userId, kind }}
            onChange={update}
            fallbackNames={{
              base: items.find((i) => i.place.base_id === baseId)?.place.base_name,
              table: items.find((i) => i.place.table_id === tableId)?.place.table_name,
              user: userId ? authors.get(userId) : undefined,
            }}
            label="Filter the history"
            placeholder="Filter by workspace, folder, collection, person or kind"
          />
          <Button aria-label={`Sort: ${asc ? "Oldest first" : "Newest first"}`} onClick={() => update({ order: asc ? "newest" : "oldest" })} className="max-md:w-full">
            <Icon icon={asc ? ArrowUpNarrowWide : ArrowDownWideNarrow} />
            {asc ? "Oldest first" : "Newest first"}
          </Button>
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {feed.isSuccess ? `${items.length}${feed.hasNextPage ? " or more" : ""} ${items.length === 1 ? "item" : "items"} of activity` : ""}
        </p>

        {feed.isPending ? (
          <div aria-hidden className="flex flex-col gap-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : feed.isError && items.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-3 text-ui text-muted">
            <p>Could not load the history: {errorMessage(feed.error)}</p>
            <Button onClick={() => void feed.refetch()}>Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={filtered ? "No activity like that yet." : "Nothing has happened yet. Changes and comments will show up here."} />
        ) : (
          <div className="flex flex-col gap-5">
            {sections.map((section) => (
              <section key={section.day} aria-label={section.label} className="flex flex-col gap-2.5">
                <h2 className="flex items-center gap-3 text-label font-semibold text-muted">
                  {section.label}
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </h2>
                {section.groups.map((group) => (
                  <ActivityCard key={group.key} group={group} fields={fields} format={format} now={now} topLevel={topLevel} />
                ))}
              </section>
            ))}
            {feed.isFetchNextPageError && (
              <p role="alert" className="text-center text-ui text-danger">
                Could not load more: {errorMessage(feed.error)}
              </p>
            )}
            {feed.hasNextPage ? (
              <Button className="self-center" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                Load more
              </Button>
            ) : (
              <p className="text-center text-label text-faint">That is everything{order === "newest" ? " so far" : ""}.</p>
            )}
          </div>
        )}
      </div>
    </HomeShell>
  );
}

/** The current time, ticking each minute so "5 minutes ago" keeps up on a page left open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The people of the chosen workspace, or of all of them, by name (for the person picker and user cells). */
function usePeople(workspaceId: string | null, all: string[]): PlacePerson[] {
  const ids = workspaceId ? [workspaceId] : all;
  return useQueries({
    queries: ids.map((id) => ({ queryKey: keys.workspaceMembers(id), queryFn: () => api.workspaces.members(id), staleTime: 60_000 })),
    // Combined here so the list keeps its identity while nothing about the people changed.
    combine: (results) => {
      const out = new Map<string, PlacePerson>();
      for (const r of results) for (const m of r.data ?? []) if (!out.has(m.user_id)) out.set(m.user_id, { id: m.user_id, name: m.name, email: m.email });
      return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}
