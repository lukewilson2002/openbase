import { useCallback, useState } from "react";

function read(key: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
    }
  } catch {
    /* unreadable or blocked storage: every row starts as its default (open only on the way to the page) */
  }
  return {};
}

/**
 * The menu's rows opened or closed by hand (workspaces, projects, tables), remembered on this device
 * like the menu's width. A row without an entry follows its default: open when the page is inside it.
 */
export function useOpenState(storageKey: string) {
  const [toggled, setToggled] = useState(() => read(storageKey));
  const toggle = useCallback(
    (id: string, open: boolean) => {
      setToggled((cur) => ({ ...cur, [id]: open }));
      try {
        // Merged into what is stored, not into this row's copy: rows of one kind each keep their own.
        localStorage.setItem(storageKey, JSON.stringify({ ...read(storageKey), [id]: open }));
      } catch {
        /* storage unavailable: the choice lasts for this page view */
      }
    },
    [storageKey],
  );
  return [toggled, toggle] as const;
}
