/**
 * What the sidebar holds, top to bottom (NAV-1): the workspace switcher, "Search everything", the rows for
 * Home, Notifications and Automations, the Collections (top-level collections, then folders), and the
 * footer with History, Trash, Workspace settings and the person's avatar and name.
 *
 * It is drawn from the workspaces list alone. That list is asked for again when the window regains focus and
 * every 60 seconds, so the counts of the folders the open page is not in stay current (BE-9); the folder the
 * person is in is kept live by its own event stream (`useBaseEvents`).
 *
 * One component serves the docked sidebar and the phone's Collections tab (`mode`, NAV-7). The tab has the
 * bottom navigation and a header search button already, so it leaves out the search row and the Home and
 * Notifications rows, and its middle flows with the screen instead of scrolling inside itself.
 */
import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { NotificationsPanel, NotificationsRow } from "@/components/notifications/Notifications";
import { Icon } from "@/components/ui/icon";
import { NavRow } from "@/components/ui/nav-row";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { atLeast } from "@/lib/roles";
import { workspaceToOpen } from "@/pages/workspace/lastWorkspace";
import { NavTree } from "./NavTree";
import { ProfileMenu } from "./ProfileMenu";
import { shortcutLabel, useOpenSearch } from "./SearchEverything";
import { SidebarLayout } from "./Sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export const WORKSPACES_REFRESH_MS = 60_000;

export type SidebarMode =
  /** Docked beside a desktop screen: Notifications opens in a popover beside it. */
  | "docked"
  /** A screen of its own, the phone's Collections tab. */
  | "page";

export interface SidebarContentProps {
  mode: SidebarMode;
  /** The workspace of the page; without one (account, admin) the sidebar shows the one last used. */
  workspaceId?: string;
  /** The open collection, for the selected row. */
  tableId?: string;
}

export function SidebarContent({ mode, workspaceId, tableId }: SidebarContentProps) {
  const { pathname } = useLocation();
  const docked = mode === "docked";
  const openSearch = useOpenSearch();
  const workspaces = useQuery({
    queryKey: keys.workspaces,
    queryFn: api.workspaces.list,
    refetchInterval: WORKSPACES_REFRESH_MS,
    refetchOnWindowFocus: "always",
    // The screen above may be showing this list's error; mounting under it must not start the request again (see AppShell).
    retryOnMount: false,
  });
  const list = workspaces.data ?? [];
  const ws = list.find((w) => w.id === workspaceId) ?? workspaceToOpen(list);

  // Without a workspace of its own, Home is wherever `/` leads (the workspace used last).
  const home = ws ? `/workspace/${ws.id}` : "/";
  const automations = ws ? `/workspace/${ws.id}/automations` : undefined;
  const settings = ws ? `/workspace/${ws.id}/settings` : undefined;
  const link = (to: string, label: string) => (
    <NavRow asChild selected={pathname === to}>
      <Link to={to}>{label}</Link>
    </NavRow>
  );

  const top = (
    <div className="flex flex-col gap-2">
      <WorkspaceSwitcher workspaces={list} current={ws} />
      {docked && (
        <button
          type="button"
          onClick={openSearch}
          className="flex h-control-md w-full min-w-0 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-ui text-muted transition-colors hover:text-fg"
        >
          <Icon icon={Search} />
          <span className="min-w-0 flex-1 truncate">Search everything</span>
          <kbd className="rounded-xs border border-line px-1 font-sans text-meta text-muted pointer-coarse:hidden">{shortcutLabel()}</kbd>
        </button>
      )}
      <div className="flex flex-col gap-0.5">
        {docked && link(home, "Home")}
        {docked && <Notifications />}
        {ws && atLeast(ws.role, "creator") && automations && link(automations, "Automations")}
      </div>
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-0.5">
      {ws && (
        <>
          <NavRow asChild selected={pathname === "/history"}>
            <Link to={`/history?workspace=${encodeURIComponent(ws.id)}`}>
              History
            </Link>
          </NavRow>
          <NavRow asChild selected={pathname === "/trash"}>
            <Link to={`/trash?workspace=${encodeURIComponent(ws.id)}`}>
              Trash
            </Link>
          </NavRow>
          {atLeast(ws.role, "owner") && settings && link(settings, "Workspace settings")}
        </>
      )}
      <ProfileMenu />
    </div>
  );

  return (
    <SidebarLayout top={top} footer={footer} scroll={docked}>
      {ws ? (
        <NavTree ws={ws} tableId={tableId} />
      ) : workspaces.isSuccess ? (
        <p className="px-2 py-1 text-meta text-muted">No workspaces yet. Open the switcher to make one.</p>
      ) : null}
    </SidebarLayout>
  );
}

/** The Notifications row, with the unread count: opens a popover beside the docked sidebar. */
function Notifications() {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <NotificationsRow open={open} selected={pathname === "/notifications"} />
      </PopoverTrigger>
      {/* Beside the sidebar rather than over it. */}
      <PopoverContent
        side="right"
        align="start"
        sideOffset={20}
        alignOffset={-4}
        aria-labelledby={headingId}
        className="flex max-h-[min(36rem,var(--ob-avail))] w-[22.5rem] flex-col overflow-hidden p-0"
      >
        <NotificationsPanel headingId={headingId} onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
