import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_KEY = "ob-sidebar";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 400;
export const SIDEBAR_DEFAULT = 256;

export interface SidebarPrefs {
  width: number;
  collapsed: boolean;
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

export function readSidebarPrefs(): SidebarPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const { width, collapsed } = parsed as Partial<Record<keyof SidebarPrefs, unknown>>;
      return { width: typeof width === "number" && Number.isFinite(width) ? clampWidth(width) : SIDEBAR_DEFAULT, collapsed: collapsed === true };
    }
  } catch {
    /* unreadable or blocked storage: start from the defaults */
  }
  return { width: SIDEBAR_DEFAULT, collapsed: false };
}

function save(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode, quota): the choice lasts for this page view */
  }
}

/** The docked menu's width and collapsed state, remembered per device. */
export function useSidebarPrefs() {
  const [prefs, setPrefs] = useState<SidebarPrefs>(readSidebarPrefs);
  const update = useCallback((patch: Partial<SidebarPrefs>, persist = true) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch, ...(patch.width !== undefined ? { width: clampWidth(patch.width) } : {}) };
      if (persist) save(next);
      return next;
    });
  }, []);
  return [prefs, update] as const;
}

/**
 * Ctrl+\ (Cmd+\ on a Mac) folds and unfolds the sidebar from anywhere. A key press that something
 * already used (an editor, a dialog) is left alone, and so is a press with another modifier.
 */
export function useSidebarShortcut(toggle: () => void): void {
  const ref = useRef(toggle);
  ref.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
