/**
 * What the shell lets a screen's header do with the docked sidebar: fold it, and show its state. The sidebar
 * belongs to `AppShell` but its toggle sits in each screen's own header, so the two meet here. A phone has no
 * sidebar to fold (it has the bottom navigation), and its headers have no toggle.
 */
import { createContext, useContext } from "react";

export interface MenuControl {
  toggle: () => void;
  /** Whether the sidebar is showing. */
  expanded: boolean;
  /** The toggle's accessible name; it carries the unread count while a hidden sidebar holds the Notifications row. */
  toggleLabel: string;
  /** Whether a hidden sidebar has unread notifications to flag on its toggle. */
  flagUnread: boolean;
  /** The id of the sidebar the toggle controls. */
  menuId: string;
}

export const MenuControlContext = createContext<MenuControl>({
  toggle: () => {},
  expanded: false,
  toggleLabel: "Show menu",
  flagUnread: false,
  menuId: "",
});

export function useMenuControl(): MenuControl {
  return useContext(MenuControlContext);
}
