/**
 * Back from a record's page lands where the list was left (PH-4). A page is a route of its own, so the
 * collection screen unmounts behind it and remounts on the way back; without help it would start at the top.
 * The screen notes how far each of its scrollers has been scrolled, against its history entry (`location.key`,
 * which browser back, Escape and the phone's back link all return to, however the page was opened), and puts
 * them back when it mounts with that entry.
 *
 * A scroller opts in with `data-scroll-restore="<name>"` (the grid's own and the calendar's, which belong to
 * libraries, are found by their classes; the calendar's are named by their order). The rows a long list scrolls over arrive after the screen is drawn, so the restoring
 * tries on every frame until the scroller can reach the place or a few seconds go by, and stops at once if the
 * person scrolls or touches the screen themselves.
 */
import { useEffect, useRef, type HTMLAttributes } from "react";
import { useLocation } from "react-router";

interface Spot {
  top: number;
  left: number;
}

const ROOT = "data-scroll-root";
const NAMED = "data-scroll-restore";
/** Glide Data Grid's own scroller: the library draws it, so it cannot carry the attribute. */
const GRID = ".dvn-scroller";
/** FullCalendar's scrollers (the week and day grids, the list): several, so they are named by their order. */
const CALENDAR = ".fc-scroller";
/** Screens remembered at most; an entry is a handful of numbers. */
const KEEP = 40;
const GIVE_UP_MS = 4000;

const spots = new Map<string, Map<string, Spot>>();
/** While the screen is putting its scroll back, the scrolling is ours and is not noted. */
let restoring = false;

function scrollersOf(root: ParentNode): [string, HTMLElement][] {
  const found: [string, HTMLElement][] = [];
  if (root instanceof HTMLElement && root.hasAttribute(NAMED)) found.push([root.getAttribute(NAMED)!, root]);
  let calendar = 0;
  for (const el of root.querySelectorAll<HTMLElement>(`[${NAMED}], ${GRID}, ${CALENDAR}`)) found.push([el.getAttribute(NAMED) ?? (el.matches(CALENDAR) ? `calendar:${calendar++}` : "grid"), el]);
  return found;
}

/** Notes the scroll of the screen under `root` against its history entry. */
export function rememberScroll(entryKey: string, root: ParentNode): void {
  const now = new Map<string, Spot>();
  for (const [name, el] of scrollersOf(root)) if (el.scrollTop > 0 || el.scrollLeft > 0) now.set(name, { top: el.scrollTop, left: el.scrollLeft });
  spots.delete(entryKey);
  if (now.size > 0) spots.set(entryKey, now);
  while (spots.size > KEEP) spots.delete(spots.keys().next().value!);
}

/** The entries a page was opened from: the screen they are shown at again takes the keyboard back (A11Y-1). */
const opened = new Set<string>();

/** A page is being opened from the screen at this history entry. */
export function markOpenedFrom(entryKey: string): void {
  opened.add(entryKey);
  while (opened.size > KEEP) opened.delete(opened.values().next().value!);
}

const cells = new Map<string, { col: number; row: number }>();

/** The grid cell that was selected when a page was opened from it, to select again on the way back. */
export function rememberOpenedCell(entryKey: string, cell: { col: number; row: number }): void {
  cells.set(entryKey, cell);
  while (cells.size > KEEP) cells.delete(cells.keys().next().value!);
}

export function openedCell(entryKey: string): { col: number; row: number } | undefined {
  return cells.get(entryKey);
}

/** Whether a page was opened from the screen at this entry. */
export function wasOpenedFrom(entryKey: string): boolean {
  return opened.has(entryKey);
}

/** The screen has taken the keyboard back: that is done once per visit. */
export function forgetOpenedFrom(entryKey: string): void {
  opened.delete(entryKey);
}

/** What was noted for a history entry (for tests). */
export function scrollMemoryOf(entryKey: string): ReadonlyMap<string, Spot> | undefined {
  return spots.get(entryKey);
}

/** Puts the noted scroll back, patiently. Returns what stops it. */
function restore(root: HTMLElement, wanted: ReadonlyMap<string, Spot>): () => void {
  let frame = 0;
  let stopped = false;
  const started = performance.now();
  restoring = true;
  const stop = () => {
    restoring = false;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const t of ["wheel", "touchstart", "pointerdown", "keydown"]) root.removeEventListener(t, stop);
  };
  for (const t of ["wheel", "touchstart", "pointerdown", "keydown"]) root.addEventListener(t, stop, { passive: true });
  const step = () => {
    if (stopped) return;
    const pending = new Set(wanted.keys());
    for (const [name, el] of scrollersOf(root)) {
      const spot = wanted.get(name);
      if (!spot) continue;
      if (Math.abs(el.scrollTop - spot.top) > 1) el.scrollTop = spot.top;
      if (Math.abs(el.scrollLeft - spot.left) > 1) el.scrollLeft = spot.left;
      // A scroller too short for the place yet (its rows are still coming) is tried again next frame.
      if (Math.abs(el.scrollTop - spot.top) <= 1 && Math.abs(el.scrollLeft - spot.left) <= 1) pending.delete(name);
    }
    if (pending.size === 0 || performance.now() - started > GIVE_UP_MS) return stop();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
}

/** The scroller that holds a collection screen: it puts back the scroll noted for the entry it is shown at. */
export function RestoredScroll(props: HTMLAttributes<HTMLDivElement>) {
  const { key } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Scroll events do not bubble but can be caught on the way down; one note a frame is plenty.
    let frame = 0;
    const onScroll = () => {
      if (restoring || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        rememberScroll(key, root);
      });
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const wanted = spots.get(key);
    const stopRestoring = wanted ? restore(root, new Map(wanted)) : undefined;
    return () => {
      root.removeEventListener("scroll", onScroll, { capture: true });
      cancelAnimationFrame(frame);
      stopRestoring?.();
    };
  }, [key]);
  return <div {...props} ref={ref} {...{ [ROOT]: "", [NAMED]: "page" }} />;
}
