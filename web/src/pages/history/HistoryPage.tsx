/**
 * One History for everything the person can open: the changes and comments on records in every
 * project of every workspace they belong to (`GET /api/history`), like the Trash page but for
 * keeping up. Activity on one record is grouped into a card; days are told apart by a heading;
 * every item shows how long ago and the exact time. The filters live in the URL (`?workspace=`,
 * `?base=`, `?user=`, `?kind=`, `?order=oldest`) so the menus can link to a filtered feed and the
 * back button undoes a filter.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api, type HistoryFilter, type HistoryKind } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ActivityPage, Field } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { BaseFilter, FILTER_BUTTON, WorkspaceFilter } from "@/components/filters/PlaceFilters";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { FormatCtx } from "@/lib/cells/format";
import { cn } from "@/lib/cn";
import { browserTimeZone } from "@/lib/format";
import { HomeShell } from "@/shell/HomeShell";
import { groupActivity, sectionByDay } from "./activity";
import { ActivityCard } from "./ActivityCard";

/** The type chips: what each one asks the server for. */
const KIND_CHIPS: { kind: HistoryKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "update", label: "Changes" },
  { kind: "create", label: "New records" },
  { kind: "delete", label: "Deleted" },
  { kind: "comment", label: "Comments" },
];

const KINDS: readonly string[] = ["create", "update", "delete", "restore", "comment"];
const isKind = (k: string | null): k is HistoryKind => !!k && KINDS.includes(k);

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const { data: me } = useMe();
  const timeZone = me?.timezone || browserTimeZone();
  const baseId = params.get("base");
  const userId = params.get("user");
  const kindParam = params.get("kind");
  const kind = isKind(kindParam) ? kindParam : null;
  const order = params.get("order") === "oldest" ? "oldest" : "newest";
  // A project's History links with `?base=` alone: the workspace filter shows the project's workspace.
  const workspaceId = params.get("workspace") ?? workspaces.data?.find((w) => w.bases.some((b) => b.id === baseId))?.id ?? null;

  const filter: HistoryFilter = {
    ...(params.get("workspace") ? { workspace: params.get("workspace")! } : {}),
    ...(baseId ? { base: baseId } : {}),
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
    // Keep the cards on screen while another filter loads, instead of flashing a spinner.
    placeholderData: keepPreviousData,
  });

  const update = (next: { workspace?: string | null; base?: string | null; user?: string | null; kind?: HistoryKind | null; order?: "newest" | "oldest" }) => {
    const out = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "order" && v === "newest")) out.set(k, v);
      else out.delete(k);
    }
    setParams(out);
  };

  const items = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
  const fields = useMemo(() => Object.assign({}, ...(feed.data?.pages.map((p) => p.fields) ?? [])) as Record<string, Field>, [feed.data]);
  const people = usePeople(workspaceId, workspaces.data?.map((w) => w.id) ?? []);
  const nameOf = useMemo(() => new Map(people.map((p) => [p.id, p.name] as const)), [people]);
  const authors = useMemo(() => new Map(items.flatMap((i) => (i.author ? [[i.author.id, i.author.name] as const] : []))), [items]);
  const format = useMemo<FormatCtx>(() => ({ timeZone, userName: (id) => nameOf.get(id) ?? authors.get(id) }), [timeZone, nameOf, authors]);
  const now = useNow();
  const sections = useMemo(() => sectionByDay(groupActivity(items, timeZone), now, timeZone), [items, timeZone, now]);

  const filtered = !!(workspaceId || baseId || userId || kind);

  return (
    <HomeShell workspaceId={workspaceId ?? undefined}>
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6 md:px-8 md:py-8">
        <div>
          <h1 className="text-[1.625rem] leading-tight tracking-[-0.015em]">History</h1>
          <p className="mt-1 text-sm text-muted">Recent changes and comments across your projects.</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <WorkspaceFilter workspaces={workspaces.data ?? []} value={workspaceId} onChange={(id) => update({ workspace: id, base: null })} />
            <BaseFilter
              workspaces={workspaces.data ?? []}
              workspaceId={workspaceId}
              value={baseId}
              fallbackName={items.find((i) => i.place.base_id === baseId)?.place.base_name}
              onChange={(id, ws) => update({ base: id, workspace: id ? ws : workspaceId })}
            />
            <PersonFilter people={people} value={userId} fallbackName={userId ? authors.get(userId) : undefined} onChange={(id) => update({ user: id })} />
            <button
              type="button"
              aria-label={`Sort: ${order === "newest" ? "Newest first" : "Oldest first"}`}
              onClick={() => update({ order: order === "newest" ? "oldest" : "newest" })}
              className={cn(FILTER_BUTTON, "bg-surface sm:ml-auto")}
            >
              {order === "newest" ? <ArrowDownWideNarrow aria-hidden className="size-4 shrink-0" /> : <ArrowUpNarrowWide aria-hidden className="size-4 shrink-0" />}
              <span className="truncate">{order === "newest" ? "Newest first" : "Oldest first"}</span>
            </button>
          </div>
          {/* One swipeable row on phones, rather than two lines of chips above the feed. */}
          <div
            role="group"
            aria-label="What kind of activity"
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
                    on ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:bg-hover",
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        {feed.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner className="size-5" label="Loading the history" />
          </div>
        ) : feed.isError && items.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-surface p-7 text-center text-sm">
            <p className="text-muted">Could not load the history: {errorMessage(feed.error)}</p>
            <Button onClick={() => void feed.refetch()}>Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-line-strong bg-surface p-7 text-center text-sm text-muted">
            {filtered ? "No activity like that yet." : "Nothing has happened yet. Changes and comments will show up here."}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {sections.map((section) => (
              <section key={section.day} aria-label={section.label} className="flex flex-col gap-2.5">
                <h2 className="flex items-center gap-3 text-[0.8125rem] font-semibold text-muted">
                  {section.label}
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </h2>
                {section.groups.map((group) => (
                  <ActivityCard key={group.key} group={group} fields={fields} format={format} now={now} />
                ))}
              </section>
            ))}
            {feed.isFetchNextPageError && (
              <p role="alert" className="text-center text-sm text-danger">
                Could not load more: {errorMessage(feed.error)}
              </p>
            )}
            {feed.hasNextPage ? (
              <Button variant="secondary" className="self-center" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                Load more
              </Button>
            ) : (
              <p className="text-center text-[0.8125rem] text-faint">That is everything{order === "newest" ? " so far" : ""}.</p>
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

interface Person {
  id: string;
  name: string;
  email: string;
}

/** The people of the chosen workspace, or of all of them, by name (for the person picker and user cells). */
function usePeople(workspaceId: string | null, all: string[]): Person[] {
  const ids = workspaceId ? [workspaceId] : all;
  return useQueries({
    queries: ids.map((id) => ({ queryKey: keys.workspaceMembers(id), queryFn: () => api.workspaces.members(id), staleTime: 60_000 })),
    // Combined here so the list keeps its identity while nothing about the people changed.
    combine: (results) => {
      const out = new Map<string, Person>();
      for (const r of results) for (const m of r.data ?? []) if (!out.has(m.user_id)) out.set(m.user_id, { id: m.user_id, name: m.name, email: m.email });
      return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

function PersonFilter({ people, value, fallbackName, onChange }: { people: Person[]; value: string | null; fallbackName?: string; onChange: (id: string | null) => void }) {
  const current = people.find((p) => p.id === value);
  const label = current?.name ?? (value ? (fallbackName ?? "This person") : "Everyone");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`Person: ${label}`} className={cn(FILTER_BUTTON, value ? "bg-primary-soft" : "bg-surface")}>
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--ob-avail))] overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v || null)}>
          <DropdownMenuRadioItem value="">Everyone</DropdownMenuRadioItem>
          {people.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              <span aria-hidden className="flex">
                <Avatar name={p.name} email={p.email} size="sm" className="size-5 text-[0.5625rem]" />
              </span>
              <span className="truncate">{p.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
