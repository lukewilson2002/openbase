/**
 * The shell of the workspace-level screens (Home, a workspace's members, settings and automations,
 * account, admin, history, trash): the main menu with the tree and the History and Trash of
 * everything, and, inside `main`, the screen's own header (NAV-5).
 */
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { ColorMark } from "@/components/ui/color-mark";
import { AppShell } from "./AppShell";
import { NavDialogsProvider } from "./NavDialogs";
import { NavGlobalLinks, NavTree } from "./NavTree";
import { ScreenHeader } from "./ScreenHeader";

export { useCreateWorkspace } from "./useCreateWorkspace";

export interface HomeShellProps {
  /** The workspace the page belongs to: it is open in the menu, and named in a phone's header. */
  workspaceId?: string;
  /** The screen's name, as the header's `h1`. Leave it out when the page's content starts with its own heading. */
  title?: ReactNode;
  /** The header's actions, before the search. */
  actions?: ReactNode;
  children: ReactNode;
}

export function HomeShell({ workspaceId: pageWorkspace, title, actions, children }: HomeShellProps) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  // One Trash and one History for everything; a workspace's is that page filtered to it.
  const filteredTo = pathname === "/trash" || pathname === "/history" ? params.get("workspace") : null;
  const workspaceId = pageWorkspace ?? filteredTo ?? undefined;
  const unfiltered = !params.has("workspace") && !params.has("base");
  const globalPage = unfiltered && pathname === "/trash" ? "trash" : unfiltered && pathname === "/history" ? "history" : null;
  return (
    <NavDialogsProvider>
      <AppShell workspaceId={workspaceId} searchHere={workspaceId ? { workspaceId } : undefined} sidebar={<NavTree workspaceId={workspaceId} />} sidebarFooter={<NavGlobalLinks page={globalPage} />}>
        <ScreenHeader title={title} actions={actions} leading={workspaceId ? <PhoneWorkspaceName workspaceId={workspaceId} /> : undefined} />
        {children}
      </AppShell>
    </NavDialogsProvider>
  );
}

/** On a phone the open workspace names the screen from its header (a desktop's menu shows it). */
function PhoneWorkspaceName({ workspaceId }: { workspaceId: string }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const ws = workspaces.data?.find((w) => w.id === workspaceId);
  if (!ws) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 text-ui font-semibold md:hidden">
      <ColorMark hue={ws.color} name={ws.name} size={24} />
      <span className="min-w-0 truncate">{ws.name}</span>
    </span>
  );
}
