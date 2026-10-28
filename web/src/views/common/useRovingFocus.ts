/**
 * Roving focus for a view with many cards or rows: one of them is the tab stop (`tabIndex` 0, the
 * rest -1), so Tab passes through the view in one press and the arrow keys move between the items.
 * The item last focused stays the tab stop; until one is, it is the first.
 *
 *   const roving = useRovingFocus(ids);
 *   <div ref={roving.containerRef} onKeyDown={...roving.focusKey(next)}>
 *     {ids.map((id) => <Card key={id} {...roving.itemProps(id)} />)}
 */
import { useCallback, useMemo, useRef, useState } from "react";

export interface RovingItemProps {
  "data-nav": string;
  tabIndex: 0 | -1;
  onFocus: () => void;
}

export interface RovingFocus {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The key of the tab stop. */
  active: string | null;
  /** Make the item the tab stop and move focus to it. */
  focusKey(key: string): void;
  /** Spread on the item's element. */
  itemProps(key: string): RovingItemProps;
}

export function useRovingFocus(keys: readonly string[]): RovingFocus {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const known = useMemo(() => new Set(keys), [keys]);
  // The remembered item can leave (deleted, folded away): the first one takes over.
  const active = current !== null && known.has(current) ? current : (keys[0] ?? null);

  const focusKey = useCallback((key: string) => {
    setCurrent(key);
    const items = containerRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [];
    for (const el of items) {
      if (el.dataset.nav === key) {
        el.focus();
        return;
      }
    }
  }, []);

  const itemProps = useCallback(
    (key: string): RovingItemProps => ({ "data-nav": key, tabIndex: key === active ? 0 : -1, onFocus: () => setCurrent(key) }),
    [active],
  );

  return useMemo(() => ({ containerRef, active, focusKey, itemProps }), [active, focusKey, itemProps]);
}
