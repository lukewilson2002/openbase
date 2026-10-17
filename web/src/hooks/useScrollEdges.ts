/**
 * Whether a scrolling element has more to show above and below what is in view, kept current as it
 * scrolls, resizes or its content grows. Used to shade the edge where there is more to scroll.
 */
import { useCallback, useEffect, useState } from "react";

export interface ScrollEdges {
  above: boolean;
  below: boolean;
}

/** Scroll positions within a pixel of an end count as the end (fractional scroll offsets). */
const SLACK = 1;

export function scrollEdges(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): ScrollEdges {
  return {
    above: el.scrollTop > SLACK,
    below: el.scrollTop + el.clientHeight < el.scrollHeight - SLACK,
  };
}

export function useScrollEdges<T extends HTMLElement>(): [(el: T | null) => void, ScrollEdges] {
  const [edges, setEdges] = useState<ScrollEdges>({ above: false, below: false });
  const [el, setEl] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    // Three numbers read per event; the state only changes when an edge appears or goes.
    const update = () => {
      const next = scrollEdges(el);
      setEdges((prev) => (prev.above === next.above && prev.below === next.below ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The box changes size with the window; its content with sections opening and closing.
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const content = new MutationObserver(update);
    content.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
      content.disconnect();
    };
  }, [el]);

  return [ref, edges];
}
