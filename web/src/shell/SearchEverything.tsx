/**
 * "Search everything" (NAV-9): the command palette that Ctrl K or Cmd K opens from anywhere, and that the
 * sidebar's search row and every header's search button open too. It searches records, collections, folders,
 * views, workspaces and comments across every workspace the person can open (`GET /api/search`), or only inside
 * this workspace or this folder, and lists the actions that fit what was typed ("New record in Clients",
 * "New collection", "Go to Home", "Open settings"). The field, the grouped list and the keys are the core
 * `CommandPalette`'s; this file decides what is searched and what each row does.
 *
 * The shell owns it ({@link SearchBarProvider}); a screen puts a {@link SearchButton} in its header.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, House, Plus, Search, Settings, type LucideIcon } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { recordKeys, recordsApi } from "@/api/records";
import type { SearchResult, TextMatch, ViewType, WorkspaceSummary } from "@/api/types";
import { useDebounced } from "@/components/record/editors/useDebounced";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { CommandPalette, type CommandGroup, type CommandItem } from "@/components/ui/command-palette";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { basePermissions } from "@/base/permissions";
import { atLeast } from "@/lib/roles";
import { foldersOf, topLevelOf } from "@/lib/topLevel";
import { workspaceToOpen } from "@/pages/workspace/lastWorkspace";
import { VIEW_TYPE_META } from "@/views/meta";
import { useNavDialog } from "./NavDialogs";

export const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;
/** How many "New record in ..." actions one search lists: a word that is in many collection names must not bury the results. */
const NEW_RECORD_ACTIONS = 5;

type Kind = "record" | "table" | "base" | "view" | "workspace" | "comment";
/** The order the groups show in (NAV-9); comments, which the search also finds, come last. */
const KINDS: readonly Kind[] = ["record", "table", "base", "view", "workspace", "comment"];
const HEADINGS: Record<Kind, string> = { record: "Records", table: "Collections", base: "Folders", view: "Views", workspace: "Workspaces", comment: "Comments" };

/** Where the page is, for the "This folder" and "This workspace" scopes. */
export interface SearchHere {
  workspaceId?: string;
  baseId?: string;
}

/** What a search is narrowed to; neither means everything. */
export interface SearchScope {
  workspace?: string;
  base?: string;
}

/**
 * Where a result opens. A record, and a comment's record, opens expanded over its collection, the way notification
 * links do; the record page (Phase 5) will take that over here.
 */
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
      <mark key={m.start} className="rounded-xs bg-primary-soft px-px text-fg">
        {chars.slice(m.start, m.end).join("")}
      </mark>,
    );
    at = m.end;
  }
  if (at < chars.length) parts.push(chars.slice(at).join(""));
  return <>{parts}</>;
}

/**
 * Whether an action fits what was typed: every word typed starts a word of the action's name or keywords, in any
 * order, so "new rec cli" finds "New record in Clients" and "home" finds "Go to Home". Nothing typed matches nothing.
 */
export function actionMatches(query: string, label: string, keywords = ""): boolean {
  const words = `${label} ${keywords}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const typed = query.toLowerCase().split(/\s+/).filter(Boolean);
  return typed.length > 0 && typed.every((t) => words.some((w) => w.startsWith(t)));
}

/** The results in display order, grouped by kind. */
export function groupResults(results: readonly SearchResult[]): { kind: Kind; items: SearchResult[] }[] {
  return KINDS.map((kind) => ({ kind, items: results.filter((r) => r.kind === kind) })).filter((g) => g.items.length > 0);
}

// ---- searching ---------------------------------------------------------------------------------------

function useSearch(query: string, scope: SearchScope, enabled: boolean) {
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const res = useQuery({
    queryKey: keys.search(q, SEARCH_LIMIT, scope),
    // The signal drops answers for text the person has already typed past.
    queryFn: ({ signal }) => api.search.everything(q, { limit: SEARCH_LIMIT, workspace: scope.workspace, base: scope.base, signal }),
    enabled: enabled && q.length > 0,
    staleTime: 30_000,
    // The last answer stays up while the next one loads, so the list does not blink on each key.
    placeholderData: (prev) => prev,
    retry: false,
  });
  // While the debounce catches up with the typing, the answer on screen is for older text.
  const settling = q !== query.trim() || res.isPlaceholderData;
  return { res, settling };
}

// ---- scopes ------------------------------------------------------------------------------------------

type ScopeId = "all" | "workspace" | "folder";

interface ScopeChoice {
  id: ScopeId;
  label: string;
  /** Shown on hover: what exactly it narrows to. */
  title: string;
  scope: SearchScope;
}

const EVERYWHERE: ScopeChoice = { id: "all", label: "Everywhere", title: "Search everything you can open", scope: {} };

/**
 * Everywhere, then this workspace and this folder when the page is in them. The top-level project is not a folder
 * to the person (its collections sit under the workspace), so it has no "This folder" of its own.
 */
function useScopeChoices(here: SearchHere | undefined, workspaces: WorkspaceSummary[] | undefined): ScopeChoice[] {
  return useMemo(() => {
    const out = [EVERYWHERE];
    const ws = here?.workspaceId ? workspaces?.find((w) => w.id === here.workspaceId) : undefined;
    const folder = here?.baseId && ws ? foldersOf(ws).find((b) => b.id === here.baseId) : undefined;
    if (here?.workspaceId) out.push({ id: "workspace", label: "This workspace", title: ws ? `Only in ${ws.name}` : "Only in this workspace", scope: { workspace: here.workspaceId } });
    if (here?.baseId && folder) out.push({ id: "folder", label: "This folder", title: `Only in ${folder.name}`, scope: { base: here.baseId } });
    return out;
  }, [here?.workspaceId, here?.baseId, workspaces]);
}

function ScopeChips({ choices, current, onChoose }: { choices: ScopeChoice[]; current: ScopeId; onChoose: (c: ScopeChoice) => void }) {
  return (
    <div role="group" aria-label="Search in" className="flex flex-wrap items-center gap-1.5">
      {choices.map((c) => {
        const on = c.id === current;
        return (
          <Button
            key={c.id}
            size="sm"
            variant={on ? "soft" : "secondary"}
            aria-pressed={on}
            title={c.title}
            // Keeps focus in the field, so typing goes on.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(c)}
          >
            {on && <Icon icon={Check} size="sm" />}
            {c.label}
          </Button>
        );
      })}
    </div>
  );
}

// ---- rows --------------------------------------------------------------------------------------------

/** What the palette needs to know about the places a result names, from the sidebar's cached list. */
interface Places {
  tableColor: (tableId: string | null | undefined) => string | undefined;
  isTopLevel: (baseId: string | null | undefined) => boolean;
}

function placesOf(workspaces: WorkspaceSummary[] | undefined): Places {
  const colors = new Map<string, string>();
  const tops = new Set<string>();
  for (const w of workspaces ?? []) {
    const top = topLevelOf(w);
    if (top) tops.add(top.id);
    for (const b of w.bases) for (const t of b.tables) colors.set(t.id, t.color);
  }
  return { tableColor: (id) => (id ? colors.get(id) : undefined), isTopLevel: (id) => !!id && tops.has(id) };
}

/** The mark column is 14 px wide so a record's 8 px mark and a collection's 14 px mark leave the names aligned. */
function Lead({ children }: { children: ReactNode }) {
  return <span className="flex w-3.5 shrink-0 items-center justify-center">{children}</span>;
}

function leadingOf(r: SearchResult, places: Places): ReactNode {
  switch (r.kind) {
    case "record":
    case "comment":
      return (
        <Lead>
          <ColorMark size={8} hue={places.tableColor(r.table_id)} name={r.table_name ?? ""} />
        </Lead>
      );
    case "table":
      return (
        <Lead>
          <ColorMark size={14} hue={places.tableColor(r.table_id ?? r.id)} name={r.name} />
        </Lead>
      );
    case "base":
      return (
        <Lead>
          <ColorMark size={14} hue={r.base_color} name={r.name} />
        </Lead>
      );
    case "workspace":
      return (
        <Lead>
          <ColorMark size={14} hue={r.workspace_color} name={r.workspace_name || r.name} />
        </Lead>
      );
    case "view": {
      // A view's small layout icon says how it shows its records, which is what tells two views apart.
      const meta = VIEW_TYPE_META[r.view_type as ViewType];
      return meta ? <Icon icon={meta.icon} className="text-muted" /> : undefined;
    }
    default:
      return undefined;
  }
}

/** The quiet text at a row's right end: where it is. A workspace is named only when it is not the one the person is in. */
function hintOf(r: SearchResult, here: SearchHere | undefined, places: Places): string | undefined {
  const parts: (string | null | undefined)[] = [];
  if (r.kind === "record" || r.kind === "view" || r.kind === "comment") parts.push(r.table_name);
  else if (r.kind === "table" && !places.isTopLevel(r.base_id)) parts.push(r.base_name);
  if (r.kind !== "workspace" && (!here?.workspaceId || r.workspace_id !== here.workspaceId)) parts.push(r.workspace_name);
  const text = parts.filter((p): p is string => !!p).join(" · ");
  return text || undefined;
}

function itemOf(r: SearchResult, here: SearchHere | undefined, places: Places, go: (r: SearchResult) => void): CommandItem {
  const comment = r.kind === "comment";
  return {
    id: `${r.kind}-${r.id}`,
    // A comment reads as what was said; everything else by its name.
    label: comment ? <Highlight text={r.snippet ?? ""} matches={r.snippet_matches} /> : r.name ? <Highlight text={r.name} matches={r.name_matches} /> : "Untitled",
    leading: leadingOf(r, places),
    hint: hintOf(r, here, places),
    detail: comment ? (
      `${r.author_name ?? "Someone"} on ${r.name || "Untitled"}`
    ) : r.snippet ? (
      // Found by another property: what it says there, around the match.
      <>
        {r.field_name && <span>{r.field_name}: </span>}
        <Highlight text={r.snippet} matches={r.snippet_matches} />
      </>
    ) : undefined,
    onSelect: () => go(r),
  };
}

// ---- actions -----------------------------------------------------------------------------------------

interface PaletteAction {
  id: string;
  label: string;
  keywords?: string;
  icon: LucideIcon;
  hint?: string;
  /** Offered before anything is typed. */
  suggested?: boolean;
  run: () => void;
}

function usePaletteActions(here: SearchHere | undefined, workspaces: WorkspaceSummary[] | undefined, scope: ScopeId): PaletteAction[] {
  const navigate = useNavigate();
  const openDialog = useNavDialog();
  const qc = useQueryClient();
  const toast = useToast();
  return useMemo(() => {
    const list = workspaces ?? [];
    const ws = list.find((w) => w.id === here?.workspaceId) ?? workspaceToOpen(list);
    const out: PaletteAction[] = [];

    // A new record goes into a collection the person can add to, within what the scope covers; this folder's first.
    const inScope = list.filter((w) => scope === "all" || w.id === here?.workspaceId);
    const places = inScope.flatMap((w) => w.bases.filter((b) => scope !== "folder" || b.id === here?.baseId).map((b) => ({ w, b })));
    const rank = (b: { id: string; workspace_id: string }) => (b.id === here?.baseId ? 0 : b.workspace_id === here?.workspaceId ? 1 : 2);
    places.sort((a, z) => rank(a.b) - rank(z.b));
    for (const { w, b } of places) {
      if (!atLeast(b.role, "editor")) continue;
      for (const t of b.tables) {
        out.push({
          id: `new-record-${t.id}`,
          label: `New record in ${t.name}`,
          keywords: "add create",
          icon: Plus,
          hint: w.id !== ws?.id ? w.name : topLevelOf(w)?.id === b.id ? undefined : b.name,
          run: () => {
            // An empty record, opened to fill in; the page that opens it also teaches the lists about it.
            void recordsApi
              .create(t.id, { records: [{ values: {} }], typecast: true })
              .then((res) => {
                const rec = res.records[0];
                if (!rec) throw new Error("The server did not return the new record");
                void qc.invalidateQueries({ queryKey: recordKeys.table(t.id) });
                void qc.invalidateQueries({ queryKey: keys.workspaces });
                void navigate(`/base/${encodeURIComponent(b.id)}/${encodeURIComponent(t.id)}?record=${encodeURIComponent(rec.id)}`);
              })
              .catch((e: unknown) => toast.error(e, "Could not add the record"));
          },
        });
      }
    }

    // A new collection goes into the open folder when the person may add there, else into the workspace's top level.
    const folder = ws?.bases.find((b) => b.id === here?.baseId);
    const top = ws ? topLevelOf(ws) : undefined;
    const target = folder && basePermissions.manageTables(folder.role) ? folder : top && basePermissions.manageTables(top.role) ? top : undefined;
    if (target) out.push({ id: "new-collection", label: "New collection", keywords: "add create", icon: Plus, suggested: true, run: () => openDialog({ kind: "create-collection", baseId: target.id }) });

    out.push({ id: "home", label: "Go to Home", icon: House, suggested: true, run: () => void navigate(ws ? `/workspace/${encodeURIComponent(ws.id)}` : "/") });
    // Workspace settings are the owners'; everyone else has their account's.
    const settings = ws && atLeast(ws.role, "owner") ? `/workspace/${encodeURIComponent(ws.id)}/settings` : "/account";
    out.push({ id: "settings", label: "Open settings", keywords: ws && atLeast(ws.role, "owner") ? "workspace" : "account", icon: Settings, suggested: true, run: () => void navigate(settings) });
    return out;
  }, [workspaces, here?.workspaceId, here?.baseId, scope, navigate, openDialog, qc, toast]);
}

// ---- the palette -------------------------------------------------------------------------------------

function SearchPalette({ open, onOpenChange, here, inputRef }: { open: boolean; onOpenChange: (open: boolean) => void; here?: SearchHere; inputRef: RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState<ScopeId>("all");
  // `retryOnMount` off like the shell's own reads of the list: a failed list that the screen shows an error for must not start again under it.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, retryOnMount: false, enabled: open });
  const choices = useScopeChoices(here, workspaces.data);
  const choice = choices.find((c) => c.id === scopeId) ?? EVERYWHERE;
  const typed = query.trim();
  const { res, settling } = useSearch(query, choice.scope, open);
  const places = useMemo(() => placesOf(workspaces.data), [workspaces.data]);
  const actions = usePaletteActions(here, workspaces.data, choice.id);

  // A fresh palette each time: nothing typed, looking everywhere.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setScopeId("all");
    }
  }, [open]);

  const scopeName = choice.id === "all" ? undefined : choice.title.replace(/^Only in /, "");
  const go = useCallback((r: SearchResult) => void navigate(searchResultHref(r)), [navigate]);

  const groups = useMemo<CommandGroup[]>(() => {
    // The top-level project is where the workspace's own collections live: not a folder to list.
    const found = typed ? (res.data?.results ?? []).filter((r) => !(r.kind === "base" && places.isTopLevel(r.id))) : [];
    const out: CommandGroup[] = groupResults(found).map((g) => ({ id: g.kind, label: HEADINGS[g.kind], stale: settling, items: g.items.map((r) => itemOf(r, here, places, go)) }));
    const fitting = actions.filter((a) => (typed ? actionMatches(typed, a.label, a.keywords) : a.suggested));
    // Actions follow the results, so Enter on a name opens that, not "New record in" it; with nothing found they are all there is.
    const offered = [...fitting.filter((a) => !a.id.startsWith("new-record-")), ...fitting.filter((a) => a.id.startsWith("new-record-")).slice(0, NEW_RECORD_ACTIONS)];
    out.push({ id: "actions", label: "Actions", items: offered.map((a) => ({ id: a.id, label: a.label, leading: <Icon icon={a.icon} className="text-muted" />, hint: a.hint, onSelect: a.run })) });
    return out;
  }, [typed, res.data, settling, places, here, go, actions]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      inputRef={inputRef}
      placeholder="Search records, collections and actions"
      emptyText={typed ? `No matches for “${typed}”${scopeName ? ` in ${scopeName}` : ""}` : "Type to search"}
      busy={!!typed && settling}
      error={typed && res.isError ? `Search is unavailable: ${errorMessage(res.error)}` : undefined}
      scopes={
        choices.length > 1 ? (
          <ScopeChips
            choices={choices}
            current={choice.id}
            onChoose={(c) => {
              setScopeId(c.id);
              inputRef.current?.focus();
            }}
          />
        ) : undefined
      }
    />
  );
}

// ---- the shell's side ---------------------------------------------------------------------------------

interface SearchBar {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SearchBarContext = createContext<SearchBar | null>(null);

/**
 * The palette of one screen frame: whether it is open, Ctrl K / Cmd K for it, and the palette itself, which
 * lives here so every header's button and the sidebar's row open the same one.
 */
export function SearchBarProvider({ here, children }: { here?: SearchHere; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useSearchShortcut(() => {
    // Already open: the key selects what was typed, so the next letters replace it.
    if (openRef.current) inputRef.current?.select();
    else setOpen(true);
  });
  const value = useMemo<SearchBar>(() => ({ open, setOpen }), [open]);
  return (
    <SearchBarContext.Provider value={value}>
      {children}
      <SearchPalette open={open} onOpenChange={setOpen} here={here} inputRef={inputRef} />
    </SearchBarContext.Provider>
  );
}

function useSearchBar(): SearchBar {
  const bar = useContext(SearchBarContext);
  if (!bar) throw new Error("SearchButton and useOpenSearch need a SearchBarProvider (AppShell has one)");
  return bar;
}

/** Opens the palette, for another control (the sidebar's "Search everything" row). */
export function useOpenSearch(): () => void {
  const { setOpen } = useSearchBar();
  return useCallback(() => setOpen(true), [setOpen]);
}

/** The search button at a header's right end: 34 px on a desktop, 44 on a phone. */
export function SearchButton() {
  const open = useOpenSearch();
  return (
    <IconButton label="Search everything" aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" onClick={open}>
      <Icon icon={Search} />
    </IconButton>
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

/**
 * ⌘K on a Mac, Ctrl+K elsewhere (both work everywhere: people switch machines). An editor that uses the key for
 * something of its own (a link in the rich text editor) handles it and calls `preventDefault`; that key press
 * reaches this window listener afterwards, sees it was handled and leaves it alone.
 */
function useSearchShortcut(onTrigger: () => void) {
  const ref = useRef(onTrigger);
  ref.current = onTrigger;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
