/**
 * The phone's bottom navigation (PH-1): a 64 px bar with three tabs, Home, Collections and Notifications, above
 * the home indicator. It is the phone's main menu (the `nav` landmark the docked sidebar is on a desktop), and
 * the only way between the three: there is no drawer. It hides on record pages and on full-screen editors:
 * a route that matches `isRecordPath` hides it by itself, and any other screen calls `useHideBottomNav()`.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Bell, House, LayoutGrid, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { useUnreadCount, unreadBadge } from "@/components/notifications/Notifications";
import { cn } from "@/lib/cn";

/** `/base/:baseId/:tableId/r/:recordId`, with or without the view before the `r`: a record page (PH-4), which is a screen of its own. */
export function isRecordPath(pathname: string): boolean {
  return /^\/base\/[^/]+\/[^/]+(?:\/[^/]+)?\/r\/[^/]+\/?$/.test(pathname);
}

export type NavTab = "home" | "collections" | "notifications";

/** Which tab a path belongs to; none for the screens the tabs do not lead to (account, members, history ...). */
export function tabOf(pathname: string, workspaceId: string): NavTab | null {
  if (pathname === `/workspace/${workspaceId}`) return "home";
  // A collection screen is inside the Collections tab: that is where the way back leads.
  if (pathname === `/workspace/${workspaceId}/collections` || pathname.startsWith("/base/")) return "collections";
  if (pathname === "/notifications") return "notifications";
  return null;
}

const HideBottomNav = createContext<(() => () => void) | null>(null);

export function HideBottomNavProvider({ register, children }: { register: () => () => void; children: ReactNode }) {
  return <HideBottomNav value={register}>{children}</HideBottomNav>;
}

/** Hides the bottom navigation while the calling screen is mounted (or while `hidden` is true): for full-screen editors. */
export function useHideBottomNav(hidden = true): void {
  const register = useContext(HideBottomNav);
  useEffect(() => (hidden ? register?.() : undefined), [hidden, register]);
}

const TABS: { tab: NavTab; label: string; icon: LucideIcon }[] = [
  { tab: "home", label: "Home", icon: House },
  { tab: "collections", label: "Collections", icon: LayoutGrid },
  { tab: "notifications", label: "Notifications", icon: Bell },
];

export function BottomNav({ workspaceId }: { workspaceId: string }) {
  const { pathname } = useLocation();
  const unread = useUnreadCount();
  const current = tabOf(pathname, workspaceId);
  const to: Record<NavTab, string> = { home: `/workspace/${workspaceId}`, collections: `/workspace/${workspaceId}/collections`, notifications: "/notifications" };
  return (
    <nav aria-label="Main menu" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <ul className="flex h-[var(--bottom-nav-size)]">
        {TABS.map((t) => {
          const badge = t.tab === "notifications" && unread > 0;
          const selected = current === t.tab;
          return (
            <li key={t.tab} className="min-w-0 flex-1">
              <Link
                to={to[t.tab]}
                aria-current={selected ? "page" : undefined}
                // The label comes first in the document and last on the screen: the name reads "Notifications 3 unread" and holds what is drawn (WCAG 2.5.3).
                className={cn("flex h-full flex-col-reverse items-center justify-center gap-0.5 text-meta no-underline", selected ? "font-semibold text-primary-text" : "font-medium text-muted")}
              >
                <span>{t.label}</span>
                <span className="relative">
                  <Icon icon={t.icon} size="fit" className="size-5.5" />
                  {badge && (
                    <span data-testid="notifications-badge" className="num absolute -top-1 left-full -ml-1.5 min-w-4 rounded-pill bg-primary px-1 text-center text-meta font-semibold leading-4 text-primary-fg">
                      {unreadBadge(unread)}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
