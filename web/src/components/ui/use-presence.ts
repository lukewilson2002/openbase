import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Keeps something mounted while its leaving animation runs, for the pieces that are not Radix primitives
 * (a docked side panel, a toast). Put `ref` on the element and `data-state={state}` beside it: the CSS in
 * styles/index.css (`.ob-slide-in[data-state="closed"]` and its siblings) plays the exit, and the element
 * goes away when it ends. Where nothing animates (jsdom, a browser that skips the animation) it goes away
 * at once, so nothing waits on motion that never comes.
 */
export function usePresence<T extends HTMLElement>(open: boolean): { mounted: boolean; state: "open" | "closed"; ref: RefObject<T | null> } {
  const [mounted, setMounted] = useState(open);
  const ref = useRef<T>(null);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    const el = ref.current;
    const name = el ? getComputedStyle(el).animationName : "none";
    if (!el || !name || name === "none") {
      setMounted(false);
      return;
    }
    const done = () => setMounted(false);
    el.addEventListener("animationend", done, { once: true });
    el.addEventListener("animationcancel", done, { once: true });
    // A tab in the background pauses animations and never ends them; do not hold the element for that.
    const fallback = setTimeout(done, 600);
    return () => {
      el.removeEventListener("animationend", done);
      el.removeEventListener("animationcancel", done);
      clearTimeout(fallback);
    };
  }, [open, mounted]);

  return { mounted: open || mounted, state: open ? "open" : "closed", ref };
}
