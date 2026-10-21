/**
 * Whether the page (or anything in it) is being scrolled. Previews that open on hover wait for the
 * scrolling to stop: cards passing under a still pointer are not being pointed at.
 */

/** How long nothing must scroll before scrolling counts as over. */
export const SCROLL_SETTLE_MS = 350;

let last = -Infinity;
let listening = false;

function mark() {
  last = performance.now();
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Capturing: a scroll of any element (a list, the grid) reaches the window this way, as does a wheel.
  window.addEventListener("scroll", mark, { capture: true, passive: true });
  window.addEventListener("wheel", mark, { capture: true, passive: true });
}

/** Something scrolled in the last moment. */
export function scrolledRecently(): boolean {
  listen();
  return performance.now() - last < SCROLL_SETTLE_MS;
}

/** Calls `fn` once nothing has scrolled for a moment (at once if nothing is scrolling); returns a cancel. */
export function whenScrollSettles(fn: () => void): () => void {
  listen();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const wait = SCROLL_SETTLE_MS - (performance.now() - last);
    if (wait <= 0) fn();
    else timer = setTimeout(check, wait);
  };
  check();
  return () => clearTimeout(timer);
}

/** Starts listening (before the first scroll that matters). */
export function watchScrolling(): void {
  listen();
}
