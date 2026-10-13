import { useCallback, useState } from "react";

function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** A set of strings (collapsed stacks and groups) remembered per browser; works without storage. */
export function usePersistedSet(storageKey: string): readonly [ReadonlySet<string>, (key: string) => void, (keys: Iterable<string>) => void] {
  const [set, setSet] = useState<ReadonlySet<string>>(() => read(storageKey));
  const save = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* storage unavailable: the state lasts for this page view */
      }
    },
    [storageKey],
  );
  const toggle = useCallback(
    (key: string) =>
      setSet((cur) => {
        const next = new Set(cur);
        if (!next.delete(key)) next.add(key);
        save(next);
        return next;
      }),
    [save],
  );
  const replace = useCallback(
    (keys: Iterable<string>) => {
      const next = new Set(keys);
      save(next);
      setSet(next);
    },
    [save],
  );
  return [set, toggle, replace] as const;
}
