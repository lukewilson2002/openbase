/**
 * What the sidebar holds, top to bottom (NAV-1): the workspace switcher, "Search everything", the rows for
 * Home, Notifications and Automations, the Collections (top-level collections, then folders), and the
 * footer with History, Trash, Workspace settings and the person's avatar and name.
 *
 * It is drawn from the workspaces list alone. That list is asked for again when the window regains focus and
 * every 60 seconds, so the counts of the folders the open page is not in stay current (BE-9); the folder the
 * person is in is kept live by its own event stream (`useBaseEvents`).
 *
 * One component serves the docked sidebar, the phone's drawer and the Collections tab's screen (`mode`); they
 * differ only in how Notifications opens and whether the middle scrolls inside the sidebar.
 */
import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { NotificationsPanel, NotificationsRow, unreadBadge, useUnreadCount } from "@/components/notifications/Notifications";
import { Icon } from "@/components/ui/icon";
import { NavRow } from "@/components/ui/nav-row";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { atLeast } from "@/lib/roles";
import { workspaceToOpen } from "@/pages/workspace/lastWorkspace";
import { useCloseMenu } from "./menuContext";
import { NavTree } from "./NavTree";
import { ProfileMenu } from "./ProfileMenu";
import { shortcutLabel, useOpenSearch } from "./SearchEverything";
import { SidebarLayout } from "./Sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export const WORKSPACES_REFRESH_MS = 60_000;

export type SidebarMode =
  /** Docked beside a desktop screen: Notifications opens in a popover beside it. */
  | "docked"
  /** The phone's drawer: Notifications replaces the menu (`onOpenNotifications`). */
  | "drawer"
  /** A screen of its own (the phone's Collections tab): Notifications is its own screen. */
  | "page";

export interface SidebarContentProps {
  mode: SidebarMode;
  /** The workspace of the page; without one (account, admin) the sidebar shows the one last used. */
  workspaceId?: string;
  /** The open collection, for the selected row. */
  tableId?: string;
  /** In the drawer: show the notifications in its place. */
  onOpenNotifications?: () => void;
}

export function SidebarContent({ mode, workspaceId, tableId, onOpenNotifications }: SidebarContentProps) {
  const { pathname } = useLocation();
  const closeMenu = useCloseMenu();
  const openSearch = useOpenSearch();
  const workspaces = useQuery({
    queryKey: keys.workspaces,
    queryFn: api.workspaces.list,
    refetchInterval: WORKSPACES_REFRESH_MS,
    refetchOnWindowFocus: "always",
  });
  const list = workspaces.data ?? [];
  const ws = list.find((w) => w.id === workspaceId) ?? workspaceToOpen(list);

  // Without a workspace of its own, Home is wherever `/` leads (the workspace used last).
  const home = ws ? `/workspace/${ws.id}` : "/";
  const automations = ws ? `/workspace/${ws.id}/automations` : undefined;
  const settings = ws ? `/workspace/${ws.id}/settings` : undefined;
  // A tap on the page already open navigates nowhere, so the drawer is closed by hand.
  const link = (to: string, label: string) => (
    <NavRow asChild selected={pathname === to}>
      <Link to={to} onClick={closeMenu}>
        {label}
      </Link>
    </NavRow>
  );

  const top = (
    <div className="flex flex-col gap-2">
      <WorkspaceSwitcher workspaces={list} current={ws} />
      <button
        type="button"
        onClick={() => {
          closeMenu();
          openSearch();
        }}
        className="flex h-control-md w-full min-w-0 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-ui text-muted transition-colors hover:text-fg max-md:h-control-touch"
      >
        <Icon icon={Search} />
        <span className="min-w-0 flex-1 truncate">Search everything</span>
        <kbd className="rounded-xs border border-line px-1 font-sans text-meta text-muted max-md:hidden pointer-coarse:hidden">{shortcutLabel()}</kbd>
      </button>
      <div className="flex flex-col gap-0.5">
        {link(home, "Home")}
        <Notifications mode={mode} onOpenDrawer={onOpenNotifications} />
        {ws && atLeast(ws.role, "creator") && automations && link(automations, "Automations")}
      </div>
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-0.5">
      {ws && (
        <>
          <NavRow asChild selected={pathname === "/history"}>
            <Link to={`/history?workspace=${encodeURIComponent(ws.id)}`} onClick={closeMenu}>
              History
            </Link>
          </NavRow>
          <NavRow asChild selected={pathname === "/trash"}>
            <Link to={`/trash?workspace=${encodeURIComponent(ws.id)}`} onClick={closeMenu}>
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
    <SidebarLayout top={top} footer={footer} scroll={mode !== "page"}>
      {ws ? (
        <NavTree ws={ws} tableId={tableId} />
      ) : workspaces.isSuccess ? (
        <p className="px-2 py-1 text-meta text-muted">No workspaces yet. Open the switcher to make one.</p>
      ) : null}
    </SidebarLayout>
  );
}

/** The Notifications row, with the unread count: a popover beside the docked sidebar, a swap inside the drawer, a screen on the Collections tab. */
function Notifications({ mode, onOpenDrawer }: { mode: SidebarMode; onOpenDrawer?: () => void }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { pathname } = useLocation();
  const unread = useUnreadCount();
  useEffect(() => setOpen(false), [pathname]);
  if (mode === "page") {
    return (
      <NavRow
        asChild
        selected={pathname === "/notifications"}
        count={unread > 0 ? <span data-testid="notifications-badge" className="font-semibold text-primary-ink">{unreadBadge(unread)}</span> : undefined}
      >
        <Link to="/notifications" aria-label={unread > 0 ? `Notifications, ${unread} unread` : undefined}>
          Notifications
        </Link>
      </NavRow>
    );
  }
  if (mode === "drawer") return <NotificationsRow open={false} onClick={onOpenDrawer} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <NotificationsRow open={open} />
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
