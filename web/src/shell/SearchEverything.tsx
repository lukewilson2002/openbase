/**
 * "Search everything" in the top bar of every signed-in page: workspaces, projects, tables, views,
 * records and comments across every workspace the person can open (`GET /api/search`), or only
 * inside one workspace or project. A combobox with its results in a list below, grouped by kind,
 * each showing where the text matched; ⌘K / Ctrl+K jumps to it from anywhere, the arrow keys move
 * through the results, Enter opens one and Escape closes the list.
 *
 * The shell owns it ({@link SearchBarProvider}); a page puts a {@link SearchSlot} where the box
 * belongs in its top bar. When the slot has room the box sits in it; on a phone, or when the bar is
 * too crowded (a project's path, faces and Share), it is a search button at the bar's right end
 * ({@link SearchButton}) that opens the same box over the page.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, MessageSquare, Search, Table2, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { SearchResult, TextMatch, WorkspaceSummary } from "@/api/types";
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

/** The narrowest the box may be (px): its icon, "Search everything" and some room to type. */
export const SEARCH_FIELD_MIN = 220;
/** What the button takes from the bar (its width and the gap before it), which the box gets back when it replaces it. */
export const SEARCH_BUTTON_ROOM = 52;
/** Slack against flicker: a box that just folded into the button needs this much more to come back. */
const SEARCH_HYSTERESIS = 24;

/**
 * Whether the box fits a slot `width` px wide. `wide` is what the slot shows now: the box, or (when
 * false) nothing, with the button beside the bar taking {@link SEARCH_BUTTON_ROOM} that the box
 * would get back.
 */
export function searchFits(wide: boolean, width: number): boolean {
  return wide ? width >= SEARCH_FIELD_MIN : width + SEARCH_BUTTON_ROOM >= SEARCH_FIELD_MIN + SEARCH_HYSTERESIS;
}

type Kind = SearchResult["kind"];
const KINDS: readonly Kind[] = ["workspace", "base", "table", "view", "record", "comment"];
const HEADINGS: Record<Kind, string> = { workspace: "Workspaces", base: "Projects", table: "Tables", view: "Views", record: "Records", comment: "Comments" };

/** Where the page is, for the "This project" and "This workspace" scopes. */
export interface SearchHere {
  workspaceId?: string;
  baseId?: string;
}

/** What a search is narrowed to; neither means everything. */
export interface SearchScope {
  workspace?: string;
  base?: string;
}

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

/**
 * `text` with each of `matches` in a `<mark>`. Offsets count code points, as the server sends them
 * (`Array.from`, not string indexes, so an emoji before a match does not shift it); a range that
 * does not fit the text is left unmarked rather than cutting a character.
 */
export function Highlight({ text, matches }: { text: string; matches?: readonly TextMatch[] | null }) {
  if (!matches?.length) return <>{text}</>;
  const chars = Array.from(text);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.start < at || m.end <= m.start || m.end > chars.length) continue;
    if (m.start > at) parts.push(chars.slice(at, m.start).join(""));
    parts.push(
      <mark key={m.start} className="rounded-[3px] bg-primary-soft px-px text-fg">
        {chars.slice(m.start, m.end).join("")}
      </mark>,
    );
    at = m.end;
  }
  if (at < chars.length) parts.push(chars.slice(at).join(""));
  return <>{parts}</>;
}

/** The results in display order (grouped by kind), each with its index in the flat list the arrows walk. */
function groupResults(results: readonly SearchResult[]): { kind: Kind; items: { r: SearchResult; index: number }[] }[] {
  let index = 0;
  return KINDS.map((kind) => ({ kind, items: results.filter((r) => r.kind === kind).map((r) => ({ r, index: index++ })) })).filter((g) => g.items.length > 0);
}

function useSearch(query: string, scope: SearchScope) {
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const res = useQuery({
    queryKey: keys.search(q, SEARCH_LIMIT, scope),
    // The signal drops answers for text the person has already typed past.
    queryFn: ({ signal }) => api.search.everything(q, { limit: SEARCH_LIMIT, workspace: scope.workspace, base: scope.base, signal }),
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

/** One scope the person can pick: its label in the chips and its query. */
interface ScopeChoice {
  key: string;
  label: string;
  /** Shown on hover: what exactly it narrows to. */
  title: string;
  scope: SearchScope;
}

const EVERYWHERE: ScopeChoice = { key: "all", label: "Everywhere", title: "Search everything you can open", scope: {} };

function scopeKey(s: SearchScope): string {
  return s.base ? `base:${s.base}` : s.workspace ? `ws:${s.workspace}` : "all";
}

/** The chips: Everywhere, then this project and this workspace when the page is in one. */
function useScopeChoices(here: SearchHere | undefined, workspaces: WorkspaceSummary[] | undefined): ScopeChoice[] {
  return useMemo(() => {
    const out = [EVERYWHERE];
    const ws = here?.workspaceId ? workspaces?.find((w) => w.id === here.workspaceId) : undefined;
    const base = here?.baseId ? workspaces?.flatMap((w) => w.bases).find((b) => b.id === here.baseId) : undefined;
    if (here?.baseId) out.push({ key: `base:${here.baseId}`, label: "This project", title: base ? `Only in ${base.name}` : "Only in this project", scope: { base: here.baseId } });
    if (here?.workspaceId) out.push({ key: `ws:${here.workspaceId}`, label: "This workspace", title: ws ? `Only in ${ws.name}` : "Only in this workspace", scope: { workspace: here.workspaceId } });
    return out;
  }, [here?.workspaceId, here?.baseId, workspaces]);
}

/** The chips over the results, and a picker for any other workspace or project. */
function ScopeBar({ here, scope, onScope }: { here?: SearchHere; scope: SearchScope; onScope: (s: SearchScope) => void }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const choices = useScopeChoices(here, workspaces.data);
  const current = scopeKey(scope);
  const inChips = choices.some((c) => c.key === current);
  const chip = "inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium transition-colors pointer-coarse:h-9 pointer-coarse:px-3.5";
  return (
    // One row: on a phone it scrolls sideways rather than pushing the results down.
    <div role="group" aria-label="Search in" className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-2 [scrollbar-width:none]">
      {choices.map((c) => {
        const on = c.key === current;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            title={c.title}
            // Keeps focus in the box, so the list stays open and typing goes on.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onScope(c.scope)}
            className={cn(chip, on ? "border-primary-soft-line bg-primary-soft text-fg" : "border-line text-muted hover:bg-hover hover:text-fg")}
          >
            {c.label}
          </button>
        );
      })}
      {(workspaces.data?.length ?? 0) > 0 && (
        <select
          aria-label="Search in a workspace or project"
          value={inChips ? "" : current}
          onChange={(e) => {
            const v = e.target.value;
            onScope(v.startsWith("base:") ? { base: v.slice(5) } : v.startsWith("ws:") ? { workspace: v.slice(3) } : {});
          }}
          className={cn(chip, "w-auto max-w-[11rem] cursor-pointer truncate bg-transparent pr-1 pointer-coarse:text-base", inChips ? "border-line text-muted hover:bg-hover hover:text-fg" : "border-primary-soft-line bg-primary-soft text-fg")}
        >
          <option value="">{inChips ? "Other…" : "Everywhere"}</option>
          {workspaces.data!.map((w) => (
            <optgroup key={w.id} label={w.name}>
              <option value={`ws:${w.id}`}>All of {w.name}</option>
              {w.bases.map((b) => (
                <option key={b.id} value={`base:${b.id}`}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}

/** The name of the place a scope narrows to, for "No matches … in Chores". */
function useScopeName(scope: SearchScope): string | undefined {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled: !!(scope.base || scope.workspace) });
  if (scope.base) return workspaces.data?.flatMap((w) => w.bases).find((b) => b.id === scope.base)?.name;
  if (scope.workspace) return workspaces.data?.find((w) => w.id === scope.workspace)?.name;
  return undefined;
}

function ResultRow({ r, index, listId, active, onActive, onPick }: { r: SearchResult; index: number; listId: string; active: boolean; onActive: (i: number) => void; onPick: (r: SearchResult) => void }) {
  const path = searchResultPath(r);
  return (
    <div
      id={`${listId}-${index}`}
      role="option"
      aria-selected={active}
      // Keeps focus in the box, so the list does not close before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !active && onActive(index)}
      onClick={() => onPick(r)}
      className={cn("mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 pointer-coarse:py-2.5", active && "bg-hover")}
    >
      <ResultIcon r={r} />
      {r.kind === "comment" ? (
        // A comment reads as what was said, then who said it on which record, and where.
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[0.875rem] text-fg">
            <Highlight text={r.snippet ?? ""} matches={r.snippet_matches} />
          </span>
          <span className="block truncate text-xs text-muted">
            {r.author_name ?? "Someone"} on {r.name || "Untitled"}
            {path ? ` · ${path}` : ""}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.875rem] font-medium text-fg">{r.name ? <Highlight text={r.name} matches={r.name_matches} /> : "Untitled"}</span>
          {/* Found by another field: what it says there, around the match, after the field's name. */}
          {r.snippet && (
            <span className="line-clamp-2 text-xs text-fg">
              {r.field_name && <span className="text-muted">{r.field_name}: </span>}
              <Highlight text={r.snippet} matches={r.snippet_matches} />
            </span>
          )}
          {path && <span className="block truncate text-xs text-muted">{path}</span>}
        </span>
      )}
    </div>
  );
}

function Results({
  query,
  state,
  scopeName,
  listId,
  active,
  onActive,
  onPick,
}: {
  query: string;
  state: ReturnType<typeof useSearch>;
  scopeName?: string;
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
    body = (
      <p className="px-4 py-5 text-center text-[0.8125rem] text-muted">
        No matches for “{query.trim()}”{scopeName ? ` in ${scopeName}` : ""}
      </p>
    );
  } else {
    body = groups.map((g) => (
      <div key={g.kind} role="group" aria-labelledby={`${listId}-${g.kind}`} className="py-1">
        <div id={`${listId}-${g.kind}`} role="presentation" className="px-3 pb-1 pt-1.5 text-xs font-semibold text-muted">
          {HEADINGS[g.kind]}
        </div>
        {g.items.map(({ r, index }) => (
          <ResultRow key={`${r.kind}-${r.id}`} r={r} index={index} listId={listId} active={index === active} onActive={onActive} onPick={onPick} />
        ))}
      </div>
    ));
  }
  return (
    <div id={listId} role="listbox" aria-label="Search results" aria-busy={res.isFetching || settling} className="max-h-[min(28rem,calc(100dvh-10rem))] overflow-y-auto overscroll-contain py-1">
      {body}
    </div>
  );
}

/** The search box with its scope chips and results; shared by the top bar's slot and the box the button opens. */
function SearchField({
  autoFocus,
  inputRef,
  here,
  onDone,
  onEscapeEmpty,
  popup,
  className,
}: {
  autoFocus?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  here?: SearchHere;
  onDone?: () => void;
  onEscapeEmpty?: () => void;
  popup: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>({});
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const state = useSearch(query, scope);
  const scopeName = useScopeName(scope);
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

  // The list stays open while focus moves between the box and its chips; it closes when focus leaves both.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  };
  // Escape on a chip closes the list too, and puts focus back in the box.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && e.target !== inputRef.current) {
      e.preventDefault();
      if (popup) setOpen(false);
      inputRef.current?.focus();
    }
  };
  const changeScope = (s: SearchScope) => {
    setScope(s);
    setOpen(true);
    inputRef.current?.focus();
  };

  const panel = (
    <>
      <ScopeBar here={here} scope={scope} onScope={changeScope} />
      <Results query={query} state={state} scopeName={scopeName} listId={listId} active={active} onActive={setActive} onPick={pick} />
    </>
  );

  return (
    <div className={cn("relative", className)} onBlur={onBlur} onKeyDown={onPanelKeyDown}>
      <label className="group/search flex h-[38px] w-full items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-muted focus-within:border-primary focus-within:bg-surface pointer-coarse:h-11">
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="sr-only">Search everything</span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-keyshortcuts="Meta+K Control+K"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          autoFocus={autoFocus}
          placeholder="Search everything"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          // 16px on a touch screen: iOS zooms into smaller text fields.
          className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-fg outline-none placeholder:text-muted pointer-coarse:text-base [&::-webkit-search-cancel-button]:hidden"
        />
        {/* The way here from anywhere, while the box waits: not once it has the focus or a query, nor on a touch screen. */}
        {popup && !query && (
          <kbd aria-hidden className="shrink-0 rounded-md border border-line bg-surface px-1.5 font-sans text-[0.75rem] leading-5 text-muted group-focus-within/search:hidden pointer-coarse:hidden">
            {shortcutLabel()}
          </kbd>
        )}
      </label>
      {showList &&
        (popup ? (
          // Wider than a narrow box, centred under it, never wider than the window.
          <div className="pointer-events-none absolute inset-x-0 top-[calc(100%+6px)] z-40 flex justify-center">
            <div className="ob-pop-in pointer-events-auto w-[max(100%,24rem)] max-w-[calc(100vw-1.5rem)] shrink-0 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">{panel}</div>
          </div>
        ) : (
          <div className="mt-2">{panel}</div>
        ))}
    </div>
  );
}

interface SearchBar {
  /** Whether the box is in the slot (else the button stands for it). */
  wide: boolean;
  here?: SearchHere;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The box the button opens. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** A slot reports its width as it changes (NaN before it is measured), or null when it goes away. */
  report: (width: number | null) => void;
}

const SearchBarContext = createContext<SearchBar | null>(null);

/**
 * The search of one top bar: whether its box fits the slot, the box the button opens, and ⌘K /
 * Ctrl+K for both. The box is in the slot only on a desktop, while a slot is there and wide enough;
 * otherwise (a phone, a bar without a slot, a crowded bar) the button stands for it.
 */
export function SearchBarProvider({ here, children }: { here?: SearchHere; children: ReactNode }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [slot, setSlot] = useState<{ present: boolean; fits: boolean }>({ present: false, fits: true });
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const report = useCallback((width: number | null) => {
    setSlot((cur) => {
      if (width === null) return cur.present ? { present: false, fits: cur.fits } : cur;
      // Before its first measurement a slot keeps what was decided last: browsers measure before they paint.
      const fits = Number.isNaN(width) ? cur.fits : searchFits(cur.present && cur.fits, width);
      return cur.present && cur.fits === fits ? cur : { present: true, fits };
    });
  }, []);
  const wide = desktop && slot.present && slot.fits;
  // The box the button opened gives way when the bar grows room for the box itself.
  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  useSearchShortcut(() => {
    if (wideRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setOpen(true);
    }
  });
  const value = useMemo<SearchBar>(() => ({ wide, here, inputRef, open, setOpen, report }), [wide, here, open, report]);
  return <SearchBarContext.Provider value={value}>{children}</SearchBarContext.Provider>;
}

function useSearchBar(): SearchBar {
  const bar = useContext(SearchBarContext);
  if (!bar) throw new Error("SearchSlot and SearchButton need a SearchBarProvider (AppShell has one)");
  return bar;
}

/**
 * Where the box goes in a top bar: a flexible space that holds the box, centred and at most 420 px
 * wide, while it is wide enough for it. It takes only the room the bar's other items leave over, so
 * it never pushes them; when that is too little it stays empty and the button appears at the bar's
 * end. Nothing on a phone.
 */
export function SearchSlot({ className }: { className?: string }) {
  const bar = useSearchBar();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const ref = useRef<HTMLDivElement>(null);
  const { report } = bar;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    report(NaN);
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (w !== undefined) report(w);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      report(null);
    };
  }, [report, desktop]);
  if (!desktop) return null;
  return (
    <div ref={ref} data-testid="search-slot" className={cn("flex min-w-0 flex-1 basis-0 justify-center", className)}>
      {bar.wide && <SearchField popup here={bar.here} inputRef={bar.inputRef} onEscapeEmpty={() => bar.inputRef.current?.blur()} className="w-full max-w-[420px]" />}
    </div>
  );
}

/** The search button at the top bar's right end while the box does not fit (always on a phone), and the box it opens. */
export function SearchButton() {
  const bar = useSearchBar();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const input = useRef<HTMLInputElement>(null);
  if (bar.wide) return null;
  return (
    <D.Root open={bar.open} onOpenChange={bar.setOpen}>
      <D.Trigger aria-label="Search everything" title={`Search everything (${shortcutLabel()})`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-fg md:size-10">
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
          className={cn(
            "ob-pop-in fixed z-50 flex flex-col bg-surface shadow-pop",
            // A phone: across the top. A desktop: under the button, at the bar's right end.
            desktop
              ? "right-3 top-2 max-h-[calc(100dvh-1rem)] w-[min(28rem,calc(100vw-1.5rem))] rounded-xl border border-line p-3"
              : "inset-x-0 top-0 max-h-dvh border-b border-line px-3 pb-3 pt-[max(0.5rem,env(safe-area-inset-top))]",
          )}
        >
          <div className="flex items-start gap-1">
            <D.Title className="sr-only">Search everything</D.Title>
            <SearchField inputRef={input} here={bar.here} popup={false} onDone={() => bar.setOpen(false)} onEscapeEmpty={() => bar.setOpen(false)} className="min-w-0 flex-1" />
            <D.Close aria-label="Close search" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-fg md:size-[38px]">
              <X aria-hidden className="size-5" />
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Whether the keyboard has a ⌘ key (a Mac, an iPad or iPhone with a keyboard). */
function isApple(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } = typeof navigator === "undefined" ? {} : navigator): boolean {
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "");
}

/** How the shortcut reads on this device: ⌘K on Apple keyboards, Ctrl K elsewhere. */
export function shortcutLabel(apple = isApple()): string {
  return apple ? "⌘K" : "Ctrl K";
}

/** ⌘K on a Mac, Ctrl+K elsewhere (both work everywhere: people switch machines). An editor that took the key (for a link) keeps it. */
function useSearchShortcut(onTrigger: () => void) {
  const ref = useRef(onTrigger);
  ref.current = onTrigger;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** A whole search on its own (a slot and its button) for a bar outside the app shell, and for tests. */
export function SearchEverything({ here }: { here?: SearchHere }) {
  return (
    <SearchBarProvider here={here}>
      <SearchSlot />
      <SearchButton />
    </SearchBarProvider>
  );
}
