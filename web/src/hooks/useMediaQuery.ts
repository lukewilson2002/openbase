import { useCallback, useSyncExternalStore } from "react";

/** Whether a CSS media query matches now; re-renders when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** The primary pointer is a finger: no hover, and focusing a text field opens the on-screen keyboard. */
export const COARSE_POINTER = "(pointer: coarse)";

/**
 * Tailwind's `md` (raised to 1024px in styles/index.css): from here up the desktop layout. It lives here
 * rather than in shell/AppShell, which re-exports it, so the ui components can switch between a dialog
 * and a sheet without importing the shell.
 */
export const DESKTOP_QUERY = "(min-width: 1024px)";
