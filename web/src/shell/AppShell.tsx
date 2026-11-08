/**
 * The frame of every signed-in screen: the main menu beside the screen itself. There is no global
 * top bar (NAV-5); each screen draws its own header inside `main` (`ScreenHeader`, or the collection
 * header), and that header holds the menu's toggle and the search button. The menu starts with Home,
 * Inbox and Notifications. On a desktop it is docked, resizable and collapsible and the notifications
 * open beside it; on a phone it is a drawer that the header's toggle opens and the notifications open
 * inside it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { House, Inbox, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { NotificationsPanel, NotificationsRow, useUnreadCount } from "@/components/notifications/Notifications";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { MenuControlContext, useCloseMenu, type MenuControl } from "./menuContext";
import { SearchBarProvider, type SearchHere } from "./SearchEverything";
import { useSidebarPrefs } from "./sidebarPrefs";
import { DockedSidebar, SidebarDrawer, SidebarLink } from "./Sidebar";

// Tailwind's `md` (raised to 1024px in styles/index.css): from here up the desktop layout, with the menu docked beside the page.
export { DESKTOP_QUERY, useCloseMenu };

export interface AppShellProps {
  /** The menu's own content (sections and items), below the Home, Inbox and Notifications rows; it scrolls when long. */
  sidebar: ReactNode;
  /** Items pinned above the profile button at the bottom of the menu. */
  sidebarFooter?: ReactNode;
  /** The screen: its header (which carries the menu's toggle), then its content. */
  children: ReactNode;
  className?: string;
  /**
   * The screen is exactly one screen tall and scrolls inside itself (a collection: its grid has
   * its own scrollbars, and a page scrollbar next to them would scroll the header away).
   */
  fill?: boolean;
  /** Accessible name of the screen's main landmark (e.g. the open view's name). */
  mainLabel?: string;
  /** Where the screen is, for the search's "This project" and "This workspace". */
  searchHere?: SearchHere;
  /** The workspace the menu's Home and Automations rows belong to; without one Home follows the last workspace. */
  workspaceId?: string;
}

export function AppShell({ sidebar, sidebarFooter, children, className, fill, mainLabel, searchHere, workspaceId }: AppShellProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [prefs, setPrefs] = useSidebarPrefs();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerNotifications, setDrawerNotifications] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { pathname, search } = useLocation();
  const unread = useUnreadCount();

  // A tap on a menu item navigates; the drawer must not stay open over the page it opened.
  useEffect(() => setDrawerOpen(false), [pathname, search]);
  // Growing the window past the breakpoint docks the menu; a drawer left open would cover it.
  useEffect(() => {
    if (desktop) setDrawerOpen(false);
  }, [desktop]);
  // The drawer opens on its menu, not on the notifications it was left on.
  useEffect(() => {
    if (!drawerOpen) setDrawerNotifications(false);
  }, [drawerOpen]);

  const expanded = desktop ? !prefs.collapsed : drawerOpen;
  const toggle = useCallback(() => (desktop ? setPrefs({ collapsed: !prefs.collapsed }) : setDrawerOpen((o) => !o)), [desktop, prefs.collapsed, setPrefs]);
  const closeMenu = useCallback(() => setDrawerOpen(false), []);
  // Notifications is in the menu, so a hidden menu carries its unread mark on the toggle.
  const flagUnread = unread > 0 && !expanded;
  const toggleLabel = expanded ? "Hide menu" : flagUnread ? `Show menu (${unread} unread in Notifications)` : "Show menu";
  const control = useMemo<MenuControl>(
    () => ({
      close: closeMenu,
      toggle,
      expanded,
      toggleLabel,
      flagUnread,
      toggleRef,
      menuId,
      desktop,
    }),
    [closeMenu, desktop, toggle, expanded, toggleLabel, flagUnread, menuId],
  );
  const topRows = (docked: boolean) => <TopRows docked={docked} workspaceId={workspaceId} notificationsOpen={drawerNotifications} onOpenNotifications={() => setDrawerNotifications(true)} />;

  return (
    <MenuControlContext.Provider value={control}>
      <SearchBarProvider here={searchHere}>
        <div className={cn("flex", fill ? "h-dvh overflow-hidden" : "min-h-dvh pb-[env(safe-area-inset-bottom)]", className)}>
          {desktop && !prefs.collapsed && (
            <DockedSidebar id={menuId} width={prefs.width} onResize={(width, persist) => setPrefs({ width }, persist)} topRows={topRows(true)} footer={sidebarFooter}>
              {sidebar}
            </DockedSidebar>
          )}
          <main aria-label={mainLabel} className={cn("flex min-w-0 flex-1 flex-col", fill && "overflow-hidden")}>
            {children}
          </main>
          {!desktop && (
            <SidebarDrawer
              id={menuId}
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              returnFocus={toggleRef}
              topRows={topRows(false)}
              notificationsPanel={drawerNotifications ? <NotificationsPanel onOpened={closeMenu} className="flex-1" /> : undefined}
              onCloseNotifications={() => setDrawerNotifications(false)}
              footer={sidebarFooter}
            >
              {sidebar}
            </SidebarDrawer>
          )}
        </div>
      </SearchBarProvider>
    </MenuControlContext.Provider>
  );
}

/**
 * The first rows of the menu: Home (the open workspace's, else wherever `/` leads), the Inbox,
 * Notifications and, for creators, the workspace's Automations. On a desktop (`docked`) Notifications
 * opens in a popover beside the menu; in the phone drawer it replaces the menu.
 */
function TopRows({ docked, workspaceId, notificationsOpen, onOpenNotifications }: { docked?: boolean; workspaceId?: string; notificationsOpen?: boolean; onOpenNotifications?: () => void }) {
  const { pathname } = useLocation();
  const closeMenu = useCloseMenu();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const ws = workspaceId ? workspaces.data?.find((w) => w.id === workspaceId) : undefined;
  const home = ws ? `/workspace/${ws.id}` : "/";
  const rowClass = "h-10 pointer-coarse:h-11";
  return (
    <div className="flex flex-col gap-0.5">
      {/* A tap on the page already open navigates nowhere, so the drawer is closed by hand. */}
      <SidebarLink to={home} icon={<House aria-hidden className="text-muted" />} active={pathname === home} onClick={closeMenu} className={rowClass}>
        Home
      </SidebarLink>
      <SidebarLink to="/inbox" icon={<Inbox aria-hidden className="text-muted" />} active={pathname === "/inbox"} onClick={closeMenu} className={rowClass}>
        Inbox
      </SidebarLink>
      {docked ? <DockedNotifications /> : <NotificationsRow open={!!notificationsOpen} onClick={onOpenNotifications} />}
      {ws && atLeast(ws.role, "creator") && (
        <SidebarLink to={`/workspace/${ws.id}/automations`} icon={<Zap aria-hidden className="text-muted" />} active={pathname === `/workspace/${ws.id}/automations`} onClick={closeMenu} className={rowClass}>
          Automations
        </SidebarLink>
      )}
    </div>
  );
}

/** The Notifications row of the docked menu, opening the list beside the menu. */
function DockedNotifications() {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <NotificationsRow open={open} />
      </PopoverTrigger>
      {/* Beside the menu rather than over it: the row's right edge is 12 px inside the menu's border. */}
      <PopoverContent
        side="right"
        align="start"
        sideOffset={20}
        alignOffset={-4}
        aria-labelledby={headingId}
        className="flex max-h-[min(36rem,var(--ob-avail))] w-[22.5rem] flex-col overflow-hidden rounded-[14px] p-0"
      >
        <NotificationsPanel headingId={headingId} onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
