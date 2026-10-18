/**
 * "Search everything" in the home pages' top bar: workspaces, bases, tables, views and records
 * across every workspace the person can open (`GET /api/search`). A combobox with its results in
 * a list below, grouped by kind; ⌘K / Ctrl+K jumps to it from anywhere on the page, the arrow keys
 * move through the results, Enter opens one and Escape closes the list. On a phone it is a search
 * button that opens the same box over the page.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, MessageSquare, Search, Table2, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { SearchResult } from "@/api/types";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { VIEW_TYPE_META } from "@/views/meta";
import type { ViewType } from "@/api/types";
import { DESKTOP_QUERY } from "./AppShell";

export const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;

type Kind = SearchResult["kind"];
const KINDS: readonly Kind[] = ["workspace", "base", "table", "view", "record", "comment"];
const HEADINGS: Record<Kind, string> = { workspace: "Workspaces", base: "Projects", table: "Tables", view: "Views", record: "Records", comment: "Comments" };

/** Where a result opens. A record, and a comment's record, opens expanded over its table, the way notification links do. */
export function searchResultHref(r: SearchResult): string {
  const e = encodeURIComponent;
  const base = r.base_id ?? r.id;
  switch (r.kind) {
    case "workspace":
      return `/workspace/${e(r.workspace_id || r.id)}`;
    case "base":
      return `/base/${e(r.id)}`;
    case "table":
      return `/base/${e(base)}/${e(r.id)}`;
    case "view":
      return `/base/${e(base)}/${e(r.table_id ?? "")}/${e(r.id)}`;
    case "record":
    case "comment":
      return `/base/${e(base)}/${e(r.table_id ?? "")}?record=${e(r.record_id ?? r.id)}`;
    default:
      // The server types `kind` as a plain string; a kind added there later still opens somewhere sensible.
      return r.base_id ? `/base/${e(r.base_id)}` : `/workspace/${e(r.workspace_id)}`;
  }
}

/** "Household › Chores › Chores": the places a result sits in, outermost first. */
export function searchResultPath(r: SearchResult): string {
  const parts: (string | null | undefined)[] =
    r.kind === "workspace" ? [] : r.kind === "base" ? [r.workspace_name] : r.kind === "table" ? [r.workspace_name, r.base_name] : [r.workspace_name, r.base_name, r.table_name];
  return parts.filter((p): p is string => !!p).join(" › ");
}

/** The results in display order (grouped by kind), each with its index in the flat list the arrows walk. */
function groupResults(results: readonly SearchResult[]): { kind: Kind; items: { r: SearchResult; index: number }[] }[] {
  let index = 0;
  return KINDS.map((kind) => ({ kind, items: results.filter((r) => r.kind === kind).map((r) => ({ r, index: index++ })) })).filter((g) => g.items.length > 0);
}

function useSearch(query: string) {
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const res = useQuery({
    queryKey: keys.search(q, SEARCH_LIMIT),
    // The signal drops answers for text the person has already typed past.
    queryFn: ({ signal }) => api.search.everything(q, { limit: SEARCH_LIMIT, signal }),
    enabled: q.length > 0,
    staleTime: 30_000,
    // The last answer stays up while the next one loads, so the list does not blink on each key.
    placeholderData: (prev) => prev,
    retry: false,
  });
  // While the debounce catches up with the typing, the answer on screen is for older text.
  const settling = q !== query.trim() || res.isPlaceholderData;
  return { q, res, settling };
}

function ResultIcon({ r }: { r: SearchResult }) {
  // Results carry a workspace's colour but not its icon; the sidebar's cached list has it, so the
  // tile here matches the one in the sidebar instead of falling back to a letter.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled: r.kind === "workspace" });
  const wsIcon = workspaces.data?.find((w) => w.id === r.workspace_id)?.icon;
  const tile = "flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-subtle text-muted [&>svg]:size-4";
  switch (r.kind) {
    case "workspace":
      return <WorkspaceTile ws={{ name: r.workspace_name || r.name, color: r.workspace_color, icon: wsIcon }} size="md" className="size-7 rounded-[7px] text-[0.8125rem]" />;
    case "base":
      return <EntityTile name={r.name} icon={r.base_icon} color={r.base_color ?? "gray"} size="md" className="size-7 rounded-[7px]" />;
    case "table":
      return (
        <span aria-hidden className={tile}>
          <Table2 />
        </span>
      );
    case "view": {
      const Icon = VIEW_TYPE_META[r.view_type as ViewType]?.icon ?? Table2;
      return (
        <span aria-hidden className={tile}>
          <Icon />
        </span>
      );
    }
    case "record":
      return (
        <span aria-hidden className={tile}>
          <FileText />
        </span>
      );
    case "comment":
      return (
        <span aria-hidden className={tile}>
          <MessageSquare />
        </span>
      );
  }
}

function Results({
  query,
  state,
  listId,
  active,
  onActive,
  onPick,
}: {
  query: string;
  state: ReturnType<typeof useSearch>;
  listId: string;
  active: number;
  onActive: (i: number) => void;
  onPick: (r: SearchResult) => void;
}) {
  const { res, settling } = state;
  const groups = useMemo(() => groupResults(res.data?.results ?? []), [res.data]);
  let body: ReactNode;
  if (res.isError) {
    body = (
      <p role="alert" className="px-4 py-5 text-center text-[0.8125rem] text-muted">
        Search is unavailable: {errorMessage(res.error)}
      </p>
    );
  } else if (groups.length === 0 && (!res.data || settling)) {
    body = (
      <div className="flex justify-center py-5">
        <Spinner label="Searching" />
      </div>
    );
  } else if (groups.length === 0) {
    body = <p className="px-4 py-5 text-center text-[0.8125rem] text-muted">No matches for “{query.trim()}”</p>;
  } else {
    body = groups.map((g) => (
      <div key={g.kind} role="group" aria-labelledby={`${listId}-${g.kind}`} className="py-1">
        <div id={`${listId}-${g.kind}`} role="presentation" className="px-3 pb-1 pt-1.5 text-xs font-semibold text-muted">
          {HEADINGS[g.kind]}
        </div>
        {g.items.map(({ r, index }) => {
          const path = searchResultPath(r);
          return (
            <div
              key={`${r.kind}-${r.id}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keeps focus in the box, so the list does not close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => index !== active && onActive(index)}
              onClick={() => onPick(r)}
              className={cn("mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 pointer-coarse:py-2.5", index === active && "bg-hover")}
            >
              <ResultIcon r={r} />
              {r.kind === "comment" ? (
                // A comment reads as what was said, then who said it on which record, and where.
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.875rem] text-fg">{r.snippet}</span>
                  <span className="block truncate text-xs text-muted">
                    {r.author_name ?? "Someone"} on {r.name || "Untitled"}
                    {path ? ` · ${path}` : ""}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.875rem] font-medium text-fg">{r.name || "Untitled"}</span>
                  {(path || r.snippet) && (
                    <span className="block truncate text-xs text-muted">
                      {path}
                      {path && r.snippet ? " · " : ""}
                      {r.snippet}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    ));
  }
  return (
    <div id={listId} role="listbox" aria-label="Search results" aria-busy={res.isFetching || settling} className="max-h-[min(28rem,calc(100dvh-8rem))] overflow-y-auto overscroll-contain py-1">
      {body}
    </div>
  );
}

/** The search field with its results; shared by the desktop box and the phone sheet. */
function SearchField({ autoFocus, inputRef, onDone, onEscapeEmpty, popup, className }: { autoFocus?: boolean; inputRef: React.RefObject<HTMLInputElement | null>; onDone?: () => void; onEscapeEmpty?: () => void; popup: boolean; className?: string }) {
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const state = useSearch(query);
  const results = state.res.data?.results;
  const flat = useMemo(() => groupResults(results ?? []).flatMap((g) => g.items.map((i) => i.r)), [results]);
  const showList = (popup ? open : true) && query.trim().length > 0;

  // New results start with nothing highlighted, so Enter does not open something the person never saw.
  useEffect(() => setActive(-1), [results]);

  const pick = (r: SearchResult) => {
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
    onDone?.();
    void navigate(searchResultHref(r));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((cur) => (cur < 0 ? (step > 0 ? 0 : flat.length - 1) : (cur + step + flat.length) % flat.length));
    } else if (e.key === "Enter") {
      const r = flat[active] ?? (state.settling ? undefined : flat[0]);
      if (r) {
        e.preventDefault();
        pick(r);
      }
    } else if (e.key === "Escape") {
      if (popup && open && query) {
        e.preventDefault();
        setOpen(false);
      } else if (query) {
        e.preventDefault();
        setQuery("");
      } else {
        onEscapeEmpty?.();
      }
    }
  };

  return (
    <div className={cn("relative", className)}>
      <label className="flex h-[38px] w-full items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-muted focus-within:border-primary focus-within:bg-surface pointer-coarse:h-11">
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="sr-only">Search everything</span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          autoFocus={autoFocus}
          placeholder="Search everything"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      {showList &&
        (popup ? (
          <div className="ob-pop-in absolute inset-x-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            <Results query={query} state={state} listId={listId} active={active} onActive={setActive} onPick={pick} />
          </div>
        ) : (
          <div className="mt-2">
            <Results query={query} state={state} listId={listId} active={active} onActive={setActive} onPick={pick} />
          </div>
        ))}
    </div>
  );
}

/** ⌘K on a Mac, Ctrl+K elsewhere (both work everywhere: people switch machines). */
function useSearchShortcut(onTrigger: () => void) {
  const ref = useRef(onTrigger);
  ref.current = onTrigger;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function SearchEverything() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return desktop ? <DesktopSearch /> : <PhoneSearch />;
}

function DesktopSearch() {
  const input = useRef<HTMLInputElement>(null);
  useSearchShortcut(() => {
    input.current?.focus();
    input.current?.select();
  });
  return (
    <div className="flex min-w-0 flex-1 justify-center">
      <SearchField popup inputRef={input} onEscapeEmpty={() => input.current?.blur()} className="w-full max-w-[420px]" />
    </div>
  );
}

function PhoneSearch() {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useSearchShortcut(() => setOpen(true));
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger aria-label="Search everything" className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-fg">
        <Search aria-hidden className="size-5" />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="ob-fade-in fixed inset-0 z-50 bg-overlay" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          className="ob-pop-in fixed inset-x-0 top-0 z-50 flex max-h-dvh flex-col border-b border-line bg-surface px-3 pb-3 pt-[max(0.5rem,env(safe-area-inset-top))] shadow-pop"
        >
          <div className="flex items-center gap-1">
            <D.Title className="sr-only">Search everything</D.Title>
            <SearchField inputRef={input} popup={false} onDone={() => setOpen(false)} onEscapeEmpty={() => setOpen(false)} className="min-w-0 flex-1" />
            <D.Close aria-label="Close search" className="inline-flex size-11 shrink-0 items-center justify-center self-start rounded-[10px] text-muted hover:bg-hover hover:text-fg">
              <X aria-hidden className="size-5" />
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
