/**
 * The frame of every signed-in page outside a base: a top bar (menu toggle, logo, a slot for the
 * page, notifications) over the main menu and the page itself. On a desktop the menu is docked,
 * resizable and collapsible; on a phone it is a drawer that the same toggle opens.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { PanelLeft } from "lucide-react";
import { BrandMark, Logo } from "@/components/Logo";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useSidebarPrefs } from "./sidebarPrefs";
import { DockedSidebar, SidebarDrawer } from "./Sidebar";

/** Tailwind's `md`: from here up the menu is docked beside the page. */
export const DESKTOP_QUERY = "(min-width: 768px)";

/** Closes the phone drawer; a no-op on a desktop, where the menu is docked. */
const CloseMenuContext = createContext<() => void>(() => {});

/**
 * For menu items that act without changing the URL (picking the view already open): the drawer
 * closes only on navigation by itself and would otherwise stay over the page.
 */
export function useCloseMenu(): () => void {
  return useContext(CloseMenuContext);
}

export interface AppShellProps {
  /** The menu's own content (sections and items); it scrolls when long. */
  sidebar: ReactNode;
  /** Items pinned above the profile button at the bottom of the menu. */
  sidebarFooter?: ReactNode;
  /** Page content for the top bar, between the logo and the notifications. */
  topBar?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * The page is exactly one screen tall and scrolls inside itself (a base: its grid has its own
   * scrollbars, and a page scrollbar next to them would scroll the toolbar away).
   */
  fill?: boolean;
  /** Accessible name of the page's main landmark (e.g. the open view's name). */
  mainLabel?: string;
  /** Leave the logo out on phones, where a page title with its own tile needs the room more. */
  hidePhoneLogo?: boolean;
}

export function AppShell({ sidebar, sidebarFooter, topBar, children, className, fill, mainLabel, hidePhoneLogo }: AppShellProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [prefs, setPrefs] = useSidebarPrefs();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { pathname, search } = useLocation();

  // A tap on a menu item navigates; the drawer must not stay open over the page it opened.
  useEffect(() => setDrawerOpen(false), [pathname, search]);
  // Growing the window past the breakpoint docks the menu; a drawer left open would cover it.
  useEffect(() => {
    if (desktop) setDrawerOpen(false);
  }, [desktop]);

  const expanded = desktop ? !prefs.collapsed : drawerOpen;
  const toggle = () => (desktop ? setPrefs({ collapsed: !prefs.collapsed }) : setDrawerOpen((o) => !o));
  const closeMenu = useCallback(() => setDrawerOpen(false), []);

  return (
    <CloseMenuContext.Provider value={closeMenu}>
      <div className={cn(fill ? "flex h-dvh flex-col overflow-hidden" : "min-h-dvh", className)}>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface pl-2 pr-3 sm:gap-3">
          <button
            ref={toggleRef}
            type="button"
            onClick={toggle}
            aria-label={expanded ? "Hide menu" : "Show menu"}
            title={expanded ? "Hide menu" : "Show menu"}
            aria-expanded={expanded}
            aria-controls={expanded ? menuId : undefined}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelLeft aria-hidden className="size-5" />
          </button>
          <Link to="/" aria-label="OpenBase home" className={cn("flex shrink-0 items-center", hidePhoneLogo && "max-sm:hidden")}>
            {/* The lockup needs ~120 px; on a phone the page title needs that room more. */}
            <Logo className="hidden h-9 sm:block" />
            <BrandMark small className="size-7 sm:hidden" />
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-2">{topBar}</div>
          <NotificationBell />
        </header>
        <div className={cn("flex", fill && "min-h-0 flex-1")}>
          {desktop && !prefs.collapsed && (
            <DockedSidebar id={menuId} width={prefs.width} onResize={(width, persist) => setPrefs({ width }, persist)} footer={sidebarFooter}>
              {sidebar}
            </DockedSidebar>
          )}
          <main aria-label={mainLabel} className={cn("min-w-0 flex-1", fill && "relative overflow-hidden")}>{children}</main>
        </div>
        {!desktop && (
          <SidebarDrawer id={menuId} open={drawerOpen} onOpenChange={setDrawerOpen} returnFocus={toggleRef} footer={sidebarFooter}>
            {sidebar}
          </SidebarDrawer>
        )}
      </div>
    </CloseMenuContext.Provider>
  );
}
