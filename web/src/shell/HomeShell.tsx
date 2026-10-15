/**
 * The shell of the home pages (workspace pages, account, admin, trash): the logo and "Search
 * everything" in the top bar, and a menu with the Inbox, the person's workspaces (each opening
 * into its Bases, Members, Trash and Settings) and the Trash of everything.
 */
import { useCallback, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LayoutGrid, Plus, Settings, Trash2, Users } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { WorkspaceTile } from "@/components/icons/EntityIcon";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { AppShell } from "./AppShell";
import { SearchEverything } from "./SearchEverything";
import { SidebarHeading, SidebarLink, sidebarActiveClass } from "./Sidebar";
import { useCreateWorkspace } from "./useCreateWorkspace";
import { WorkspacePicker } from "./WorkspacePicker";

export { useCreateWorkspace } from "./useCreateWorkspace";

export type WorkspaceSection = "bases" | "members" | "trash" | "settings";

export interface HomeShellProps {
  /** The workspace the page belongs to: it is expanded in the menu, and named in a phone's top bar. */
  workspaceId?: string;
  section?: WorkspaceSection;
  /** Extra top bar content, before the search. */
  topBar?: ReactNode;
  children: ReactNode;
}

export function HomeShell({ workspaceId: pageWorkspace, section: pageSection, topBar, children }: HomeShellProps) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  // One Trash page for everything; a workspace's Trash is that page filtered to it.
  const trashOf = pathname === "/trash" ? params.get("workspace") : null;
  const workspaceId = pageWorkspace ?? trashOf ?? undefined;
  const section = pageSection ?? (trashOf ? "trash" : undefined);
  const allTrash = pathname === "/trash" && !params.has("workspace") && !params.has("base");
  return (
    <AppShell
      topBar={
        <>
          {workspaceId && <PhoneWorkspaceTitle workspaceId={workspaceId} />}
          {topBar}
          <SearchEverything />
        </>
      }
      hidePhoneLogo={!!workspaceId}
      sidebar={<WorkspaceMenu workspaceId={workspaceId} section={section} />}
      sidebarFooter={
        <SidebarLink to="/trash" muted active={allTrash} icon={<Trash2 />}>
          Trash
        </SidebarLink>
      }
    >
      {children}
    </AppShell>
  );
}

/** On a phone the open workspace names the page from the top bar, and switches to another one. */
function PhoneWorkspaceTitle({ workspaceId }: { workspaceId: string }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const ws = workspaces.data?.find((w) => w.id === workspaceId);
  if (!ws) return null;
  return (
    <div className="min-w-0 md:hidden">
      <WorkspacePicker
        currentId={ws.id}
        trigger={
          <button type="button" aria-label={`Workspace: ${ws.name}. Switch workspace`} className="flex h-11 max-w-full items-center gap-2 rounded-[10px] px-1.5 text-[1.0625rem] font-bold text-fg hover:bg-hover">
            <WorkspaceTile ws={ws} size="sm" className="size-[26px] rounded-[7px] text-[0.8125rem]" />
            <span className="min-w-0 truncate">{ws.name}</span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
          </button>
        }
      />
    </div>
  );
}

const EXPANDED_KEY = "ob-workspaces-open";

function readExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
    }
  } catch {
    /* unreadable or blocked storage: every workspace starts closed but the open one */
  }
  return {};
}

/** Workspaces opened or closed by hand, remembered on this device like the menu's width. */
function useExpandedWorkspaces() {
  const [toggled, setToggled] = useState(readExpanded);
  const toggle = useCallback((id: string, open: boolean) => {
    setToggled((cur) => {
      const next = { ...cur, [id]: open };
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the choice lasts for this page view */
      }
      return next;
    });
  }, []);
  return [toggled, toggle] as const;
}

function WorkspaceMenu({ workspaceId, section }: { workspaceId?: string; section?: WorkspaceSection }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const [creating, setCreating] = useState(false);
  const create = useCreateWorkspace();
  const [toggled, toggle] = useExpandedWorkspaces();

  return (
    <section aria-label="Workspaces" className="flex flex-col gap-0.5">
      <SidebarHeading
        action={
          <IconButton label="New workspace" size="sm" onClick={() => setCreating(true)} className="size-8 rounded-lg">
            <Plus aria-hidden className="size-4" />
          </IconButton>
        }
      >
        Workspaces
      </SidebarHeading>
      <ul className="flex flex-col gap-0.5">
        {(workspaces.data ?? []).map((ws) => (
          <WorkspaceItem
            key={ws.id}
            ws={ws}
            current={ws.id === workspaceId}
            section={ws.id === workspaceId ? (section ?? "bases") : undefined}
            // The open workspace is expanded unless it was closed by hand.
            expanded={toggled[ws.id] ?? ws.id === workspaceId}
            onToggle={(open) => toggle(ws.id, open)}
          />
        ))}
      </ul>
      {workspaces.isSuccess && workspaces.data.length === 0 && <p className="px-3 py-1 text-xs text-muted">No workspaces yet.</p>}
      <NameDialog open={creating} onOpenChange={setCreating} title="New workspace" submitLabel="Create workspace" withIcon onSubmit={(name, icon) => create.mutateAsync({ name, icon })} />
    </section>
  );
}

const subItemClass = "flex h-[34px] min-w-0 items-center gap-2.5 rounded-[9px] px-2.5 text-[0.875rem] text-muted no-underline transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-11 [&>svg]:size-4 [&>svg]:shrink-0";

function WorkspaceItem({ ws, current, section, expanded, onToggle }: { ws: WorkspaceSummary; current: boolean; section: WorkspaceSection | undefined; expanded: boolean; onToggle: (open: boolean) => void }) {
  const groupId = `ws-${ws.id}-pages`;
  const sub = (to: string, name: WorkspaceSection, icon: ReactNode, label: string) => (
    <SidebarLink to={to} end active={section === name} className={cn(subItemClass, section === name && sidebarActiveClass)} iconClassName="[&>svg]:size-4" icon={icon}>
      {label}
    </SidebarLink>
  );
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onToggle(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? groupId : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${ws.name}`}
          className="inline-flex h-9 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-11"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
        </button>
        <SidebarLink to={`/workspace/${ws.id}`} active={false} className={cn("flex-1 px-2.5", current && "font-semibold")} icon={<WorkspaceTile ws={ws} size="sm" className="size-[22px] text-xs" />}>
          {ws.name}
        </SidebarLink>
      </div>
      {expanded && (
        <div id={groupId} role="group" aria-label={ws.name} className="flex flex-col gap-px pb-1.5 pl-[30px]">
          {sub(`/workspace/${ws.id}`, "bases", <LayoutGrid aria-hidden />, "Bases")}
          {sub(`/workspace/${ws.id}/members`, "members", <Users aria-hidden />, "Members")}
          {sub(`/trash?workspace=${encodeURIComponent(ws.id)}`, "trash", <Trash2 aria-hidden />, "Trash")}
          {atLeast(ws.role, "owner") && sub(`/workspace/${ws.id}/settings`, "settings", <Settings aria-hidden />, "Settings")}
        </div>
      )}
    </li>
  );
}
