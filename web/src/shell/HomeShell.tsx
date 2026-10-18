/**
 * The shell of the home pages (a workspace's members and settings, account, admin, trash): the logo
 * and "Search everything" in the top bar, and the menu with the Inbox, the navigation tree and the
 * Trash of everything.
 */
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { WorkspaceTile } from "@/components/icons/EntityIcon";
import { AppShell, useOpenMenu } from "./AppShell";
import { NavDialogsProvider } from "./NavDialogs";
import { NavTrashLink, NavTree } from "./NavTree";
import { SearchEverything } from "./SearchEverything";

export { useCreateWorkspace } from "./useCreateWorkspace";

export interface HomeShellProps {
  /** The workspace the page belongs to: it is open in the menu, and named in a phone's top bar. */
  workspaceId?: string;
  /** Extra top bar content, before the search. */
  topBar?: ReactNode;
  children: ReactNode;
}

export function HomeShell({ workspaceId: pageWorkspace, topBar, children }: HomeShellProps) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  // One Trash page for everything; a workspace's Trash is that page filtered to it.
  const trashOf = pathname === "/trash" ? params.get("workspace") : null;
  const workspaceId = pageWorkspace ?? trashOf ?? undefined;
  const allTrash = pathname === "/trash" && !params.has("workspace") && !params.has("base");
  return (
    <NavDialogsProvider>
      <AppShell
        topBar={
          <>
            {workspaceId && <PhoneWorkspaceTitle workspaceId={workspaceId} />}
            {topBar}
            <SearchEverything />
          </>
        }
        hidePhoneLogo={!!workspaceId}
        sidebar={<NavTree workspaceId={workspaceId} />}
        sidebarFooter={<NavTrashLink active={allTrash} />}
      >
        {children}
      </AppShell>
    </NavDialogsProvider>
  );
}

/** On a phone the open workspace names the page from the top bar; tapping it opens the menu. */
function PhoneWorkspaceTitle({ workspaceId }: { workspaceId: string }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const openMenu = useOpenMenu();
  const ws = workspaces.data?.find((w) => w.id === workspaceId);
  if (!ws) return null;
  return (
    <div className="min-w-0 md:hidden">
      <button type="button" onClick={openMenu} aria-label={`Workspace: ${ws.name}. Show menu`} className="flex h-11 max-w-full items-center gap-2 rounded-[10px] px-1.5 text-[1.0625rem] font-bold text-fg hover:bg-hover">
        <WorkspaceTile ws={ws} size="sm" className="size-[26px] rounded-[7px] text-[0.8125rem]" />
        <span className="min-w-0 truncate">{ws.name}</span>
      </button>
    </div>
  );
}
