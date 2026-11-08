import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Keeps focus on the page when the control that holds it leaves it (A11Y-1). A bar that closes after Reset, or a
 * toolbar that goes away with the selection, takes its focused button along, and focus falls to the top of the
 * page, so the next Tab starts over. Watch the element the buttons live in: when it unmounts, or when the caller
 * runs the returned `rescue` after the buttons went (a bar that stays mounted and closes), focus that had been
 * inside goes to `fallback(host)`, where `host` is the element the watched one sits in. Focus that moved to
 * another element on purpose is left alone.
 */
export function useFocusRescue(rootRef: RefObject<HTMLElement | null>, fallback: (host: HTMLElement) => HTMLElement | null | undefined): () => void {
  const inside = useRef(false);
  const host = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const rescue = useCallback(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (inside.current && lost && host.current?.isConnected) fallbackRef.current(host.current)?.focus();
    if (lost) inside.current = false;
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // After it unmounts the root no longer knows where it was.
    host.current = root.parentElement;
    const enter = () => {
      inside.current = true;
    };
    // A relatedTarget says focus went to another element; none says it went nowhere (or the element left the page).
    const leave = (e: FocusEvent) => {
      if (e.relatedTarget) inside.current = false;
    };
    root.addEventListener("focusin", enter);
    root.addEventListener("focusout", leave);
    return () => {
      root.removeEventListener("focusin", enter);
      root.removeEventListener("focusout", leave);
      rescue();
    };
  }, [rootRef, rescue]);

  return rescue;
}
