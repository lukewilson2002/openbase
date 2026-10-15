/**
 * The frame of every signed-in page: a top bar (menu toggle, then the logo or the base's place
 * pickers, then a slot for the page) over the main menu and the page itself. The menu always starts
 * with the Inbox. On a desktop the menu is docked, resizable and collapsible and the Inbox opens
 * beside it; on a phone the menu is a drawer that the same toggle opens and the Inbox opens inside it.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Menu, PanelLeft } from "lucide-react";
import { BrandMark, Logo } from "@/components/Logo";
import { InboxPanel, InboxRow, useUnreadCount } from "@/components/notifications/Inbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  /** The menu's own content (sections and items), below the Inbox; it scrolls when long. */
  sidebar: ReactNode;
  /** Items pinned above the profile button at the bottom of the menu. */
  sidebarFooter?: ReactNode;
  /** Page content for the top bar, after the logo (or `brand`). */
  topBar?: ReactNode;
  /** Replaces the logo at the start of the top bar on a desktop (a base's workspace and base pickers). */
  brand?: ReactNode;
  /** The phone drawer's top row in place of its "Menu" title (a base's workspace and base pickers). */
  drawerHeader?: ReactNode;
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

export function AppShell({ sidebar, sidebarFooter, topBar, brand, drawerHeader, children, className, fill, mainLabel, hidePhoneLogo }: AppShellProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [prefs, setPrefs] = useSidebarPrefs();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerInbox, setDrawerInbox] = useState(false);
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
  // The drawer opens on its menu, not on the inbox it was left on.
  useEffect(() => {
    if (!drawerOpen) setDrawerInbox(false);
  }, [drawerOpen]);

  const expanded = desktop ? !prefs.collapsed : drawerOpen;
  const toggle = () => (desktop ? setPrefs({ collapsed: !prefs.collapsed }) : setDrawerOpen((o) => !o));
  const closeMenu = useCallback(() => setDrawerOpen(false), []);
  // The Inbox is in the menu, so a hidden menu carries its unread mark on the toggle.
  const flagUnread = unread > 0 && !expanded;
  const toggleLabel = expanded ? "Hide menu" : flagUnread ? `Show menu (${unread} unread in Inbox)` : "Show menu";

  return (
    <CloseMenuContext.Provider value={closeMenu}>
      <div className={cn(fill ? "flex h-dvh flex-col overflow-hidden" : "min-h-dvh", className)}>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-1.5 md:gap-3 md:px-3">
          <button
            ref={toggleRef}
            type="button"
            onClick={toggle}
            aria-label={toggleLabel}
            title={expanded ? "Hide menu" : "Show menu"}
            aria-expanded={expanded}
            aria-controls={expanded ? menuId : undefined}
            className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-hover hover:text-fg md:size-10"
          >
            {/* A drawer on a phone, a panel that docks and folds on a desktop. */}
            {desktop ? <PanelLeft aria-hidden className="size-5" /> : <Menu aria-hidden className="size-[22px] text-fg" />}
            {flagUnread && <span aria-hidden data-testid="menu-unread-dot" className="absolute right-2 top-2 size-[9px] rounded-full bg-primary ring-2 ring-surface" />}
          </button>
          {brand && desktop ? (
            brand
          ) : (
            <Link to="/" aria-label="OpenBase home" className={cn("flex shrink-0 items-center", (hidePhoneLogo || brand) && "max-md:hidden")}>
              {/* The lockup needs ~120 px; on a phone the page title needs that room more. */}
              <Logo className="hidden h-9 sm:block" />
              <BrandMark small className="size-7 sm:hidden" />
            </Link>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">{topBar}</div>
        </header>
        <div className={cn("flex", fill && "min-h-0 flex-1")}>
          {desktop && !prefs.collapsed && (
            <DockedSidebar id={menuId} width={prefs.width} onResize={(width, persist) => setPrefs({ width }, persist)} inbox={<DockedInbox />} footer={sidebarFooter}>
              {sidebar}
            </DockedSidebar>
          )}
          <main aria-label={mainLabel} className={cn("min-w-0 flex-1", fill && "relative overflow-hidden")}>{children}</main>
        </div>
        {!desktop && (
          <SidebarDrawer
            id={menuId}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            returnFocus={toggleRef}
            header={drawerHeader}
            inbox={<InboxRow open={drawerInbox} onClick={() => setDrawerInbox(true)} />}
            inboxPanel={drawerInbox ? <InboxPanel onOpened={closeMenu} className="flex-1" /> : undefined}
            onCloseInbox={() => setDrawerInbox(false)}
            footer={sidebarFooter}
          >
            {sidebar}
          </SidebarDrawer>
        )}
      </div>
    </CloseMenuContext.Provider>
  );
}

/** The Inbox row of the docked menu, opening the notifications beside the menu. */
function DockedInbox() {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InboxRow open={open} />
      </PopoverTrigger>
      {/* Beside the menu rather than over it: the row's right edge is 12 px inside the menu's border. */}
      <PopoverContent
        side="right"
        align="start"
        sideOffset={20}
        alignOffset={-4}
        aria-labelledby={headingId}
        className="flex max-h-[min(36rem,calc(100dvh-5rem))] w-[22.5rem] flex-col overflow-hidden rounded-[14px] p-0"
      >
        <InboxPanel headingId={headingId} onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
