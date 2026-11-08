/**
 * What the shell lets a screen's header do with the main menu: fold it or open the drawer, and show its state.
 * The menu belongs to `AppShell` (a docked panel on a desktop, a drawer on a phone) but its toggle
 * sits in each screen's own header, so the two meet here.
 */
import { createContext, useContext, type RefObject } from "react";

export interface MenuControl {
  close: () => void;
  toggle: () => void;
  /** Whether the menu is showing: docked and unfolded on a desktop, the drawer open on a phone. */
  expanded: boolean;
  /** The toggle's accessible name; it carries the unread count while a hidden menu holds the Notifications row. */
  toggleLabel: string;
  /** Whether a hidden menu has unread notifications to flag on its toggle. */
  flagUnread: boolean;
  /** Where the drawer gives focus back to, and the id of the menu the toggle controls. */
  toggleRef: RefObject<HTMLButtonElement | null>;
  menuId: string;
  /** Desktop layout: the toggle folds the docked menu instead of opening a drawer. */
  desktop: boolean;
}

const NOOP_REF: RefObject<HTMLButtonElement | null> = { current: null };

export const MenuControlContext = createContext<MenuControl>({
  close: () => {},
  toggle: () => {},
  expanded: false,
  toggleLabel: "Show menu",
  flagUnread: false,
  toggleRef: NOOP_REF,
  menuId: "",
  desktop: false,
});

export function useMenuControl(): MenuControl {
  return useContext(MenuControlContext);
}

/**
 * For menu items that act without changing the URL (picking the view already open): the drawer
 * closes only on navigation by itself and would otherwise stay over the page.
 */
export function useCloseMenu(): () => void {
  return useContext(MenuControlContext).close;
}
