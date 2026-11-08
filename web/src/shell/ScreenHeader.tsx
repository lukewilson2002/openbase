/**
 * The header a screen draws for itself inside `main` (NAV-5: the app has no global top bar). On a desktop it holds
 * the sidebar's toggle, the screen's title and whatever the screen puts beside it, then its actions
 * and the search button. On a phone it is the `PhoneHeader` (PH-2) the screen describes in `phone`. It does
 * not stick: a screen that wants a header on screen while it scrolls lays it out in its own column.
 */
import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useMenuControl } from "./menuContext";
import { PhoneHeader, type PhoneHeaderProps } from "./PhoneHeader";
import { SearchButton } from "./SearchEverything";

export interface ScreenHeaderProps {
  /** The screen's one `h1`: its name. Leave it out when the screen's body starts with its own heading. */
  title?: ReactNode;
  /** Before the title (a path, a mark). */
  leading?: ReactNode;
  /** Between the title and the actions; takes the room the title leaves. */
  children?: ReactNode;
  /** At the end, before the search button. */
  actions?: ReactNode;
  /** The same header on a phone: its left side, title and buttons (a phone has none of the desktop's `leading`, `children` or `actions`). */
  phone?: Omit<PhoneHeaderProps, "className">;
  className?: string;
}

/** Folds the docked sidebar; flags unread notifications while it is hidden. */
function MenuToggle() {
  const menu = useMenuControl();
  return (
    <IconButton
      label={menu.toggleLabel}
      onClick={menu.toggle}
      aria-keyshortcuts="Control+Backslash Meta+Backslash"
      aria-expanded={menu.expanded}
      aria-controls={menu.expanded ? menu.menuId : undefined}
      className="relative"
    >
      <Icon icon={PanelLeft} />
      {menu.flagUnread && <span aria-hidden data-testid="menu-unread-dot" className="absolute right-1.5 top-1.5 size-2 rounded-pill bg-primary ring-2 ring-surface" />}
    </IconButton>
  );
}

export function ScreenHeader({ title, leading, children, actions, phone, className }: ScreenHeaderProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (!desktop) return <PhoneHeader title={title} {...phone} className={className} />;
  return (
    <header className={cn("flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)] md:px-4", className)}>
      <MenuToggle />
      {leading}
      {title && <h1 className="min-w-0 truncate text-h3 md:text-h2">{title}</h1>}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions}
      <SearchButton />
    </header>
  );
}
