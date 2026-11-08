/**
 * The frame of every signed-in screen: the sidebar beside the screen itself. There is no global
 * top bar (NAV-5); each screen draws its own header inside `main` (`ScreenHeader`, or the collection
 * header), and that header holds the sidebar's toggle and the search button. On a desktop the sidebar is
 * docked, resizable and collapsible (the toggle, or Ctrl+\) and the notifications open beside it; on a
 * phone it is a drawer that the header's toggle opens and the notifications open inside it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { NotificationsPanel, useUnreadCount } from "@/components/notifications/Notifications";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { MenuControlContext, useCloseMenu, type MenuControl } from "./menuContext";
import { SearchBarProvider, type SearchHere } from "./SearchEverything";
import { useSidebarPrefs, useSidebarShortcut } from "./sidebarPrefs";
import { DockedSidebar, SidebarDrawer } from "./Sidebar";
import { SidebarContent } from "./SidebarContent";

// Tailwind's `md` (raised to 1024px in styles/index.css): from here up the desktop layout, with the menu docked beside the page.
export { DESKTOP_QUERY, useCloseMenu };

export interface AppShellProps {
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
  /** Where the screen is, for the search's "This folder" and "This workspace". */
  searchHere?: SearchHere;
  /** The workspace the sidebar shows; without one it shows the workspace used last. */
  workspaceId?: string;
  /** The open collection, which the sidebar marks. */
  tableId?: string;
}

export function AppShell({ children, className, fill, mainLabel, searchHere, workspaceId, tableId }: AppShellProps) {
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
  useSidebarShortcut(toggle);

  return (
    <MenuControlContext.Provider value={control}>
      <SearchBarProvider here={searchHere}>
        <div className={cn("flex", fill ? "h-dvh overflow-hidden" : "min-h-dvh pb-[env(safe-area-inset-bottom)]", className)}>
          {desktop && !prefs.collapsed && (
            <DockedSidebar id={menuId} width={prefs.width} onResize={(width, persist) => setPrefs({ width }, persist)}>
              <SidebarContent mode="docked" workspaceId={workspaceId} tableId={tableId} />
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
              notificationsPanel={drawerNotifications ? <NotificationsPanel onOpened={closeMenu} className="flex-1" /> : undefined}
              onCloseNotifications={() => setDrawerNotifications(false)}
            >
              <SidebarContent mode="drawer" workspaceId={workspaceId} tableId={tableId} onOpenNotifications={() => setDrawerNotifications(true)} />
            </SidebarDrawer>
          )}
        </div>
      </SearchBarProvider>
    </MenuControlContext.Provider>
  );
}
