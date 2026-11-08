/**
 * The frame of every signed-in screen. There is no global top bar (NAV-5); each screen draws its own header
 * inside `main` (`ScreenHeader`, or the collection header), and that header holds the sidebar's toggle and the
 * search button. On a desktop the sidebar is docked, resizable and collapsible (the toggle, or Ctrl+\) and the
 * notifications open beside it. A phone has no sidebar: its three tabs are the bottom navigation (PH-1), and the
 * Collections tab holds what the sidebar holds (NAV-7).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useUnreadCount } from "@/components/notifications/Notifications";
import { useOwnRecordCounts } from "@/hooks/useCountRefresh";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { workspaceToOpen } from "@/pages/workspace/lastWorkspace";
import { BottomNav, HideBottomNavProvider, isRecordPath } from "./bottomNav";
import { MenuControlContext, type MenuControl } from "./menuContext";
import { SearchBarProvider, type SearchHere } from "./SearchEverything";
import { useSidebarPrefs, useSidebarShortcut } from "./sidebarPrefs";
import { DockedSidebar } from "./Sidebar";
import { SidebarContent } from "./SidebarContent";

// Tailwind's `md` (raised to 1024px in styles/index.css): from here up the desktop layout, with the menu docked beside the page.
export { DESKTOP_QUERY };

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
  const menuId = useId();
  const { pathname } = useLocation();
  const unread = useUnreadCount();
  useOwnRecordCounts();
  // `retryOnMount` off: a failed list that the screen above shows an error for must not start again (and flip that screen back to loading) just because the shell mounted under it.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, retryOnMount: false });
  // Screens that hide the bottom navigation (full-screen editors) register here; a record page hides it by its address.
  const [hiders, setHiders] = useState(0);
  const registerHider = useCallback(() => {
    setHiders((n) => n + 1);
    return () => setHiders((n) => n - 1);
  }, []);

  // The tabs lead to the page's workspace, else the one used last; with none (first run) there is nowhere to lead.
  const tabsWorkspace = workspaceId ?? workspaceToOpen(workspaces.data ?? [])?.id;
  const bottomNav = !desktop && !!tabsWorkspace && hiders === 0 && !isRecordPath(pathname);
  // The toast stands above the bar (--bottom-nav-height), and so do floating buttons.
  useEffect(() => {
    if (!bottomNav) return;
    const root = document.documentElement;
    root.style.setProperty("--bottom-nav-height", "var(--bottom-nav-size)");
    return () => void root.style.removeProperty("--bottom-nav-height");
  }, [bottomNav]);

  const expanded = !prefs.collapsed;
  // Folding unmounts the sidebar: with focus inside it, focus would fall to the page and the next Tab would start from the top.
  const refocusToggle = useRef(false);
  const toggle = useCallback(() => {
    refocusToggle.current = !prefs.collapsed && !!document.getElementById(menuId)?.contains(document.activeElement);
    setPrefs({ collapsed: !prefs.collapsed });
  }, [prefs.collapsed, setPrefs, menuId]);
  useEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    document.querySelector<HTMLElement>("[data-menu-toggle]")?.focus();
  }, [prefs.collapsed]);
  // Notifications is in the sidebar, so a hidden sidebar carries its unread mark on the toggle.
  const flagUnread = unread > 0 && !expanded;
  const toggleLabel = expanded ? "Hide menu" : flagUnread ? `Show menu (${unread} unread in Notifications)` : "Show menu";
  const control = useMemo<MenuControl>(() => ({ toggle, expanded, toggleLabel, flagUnread, menuId }), [toggle, expanded, toggleLabel, flagUnread, menuId]);
  useSidebarShortcut(toggle);

  return (
    <MenuControlContext.Provider value={control}>
      <HideBottomNavProvider register={registerHider}>
        <SearchBarProvider here={searchHere}>
          <div
            className={cn(
              "flex",
              fill ? "h-dvh overflow-hidden" : "min-h-dvh",
              bottomNav ? "pb-[calc(var(--bottom-nav-size)+env(safe-area-inset-bottom))]" : !fill && "pb-[env(safe-area-inset-bottom)]",
              className,
            )}
          >
            {desktop && !prefs.collapsed && (
              <DockedSidebar id={menuId} width={prefs.width} onResize={(width, persist) => setPrefs({ width }, persist)}>
                <SidebarContent mode="docked" workspaceId={workspaceId} tableId={tableId} />
              </DockedSidebar>
            )}
            <main aria-label={mainLabel} className={cn("flex min-w-0 flex-1 flex-col", fill && "overflow-hidden")}>
              {children}
            </main>
            {bottomNav && tabsWorkspace && <BottomNav workspaceId={tabsWorkspace} />}
          </div>
        </SearchBarProvider>
      </HideBottomNavProvider>
    </MenuControlContext.Provider>
  );
}
