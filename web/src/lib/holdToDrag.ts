/**
 * Press-and-hold before a touch drag, for drags built on pointer events (the timeline's bars and
 * lanes). A mouse or pen drags as soon as it is pressed. A finger has to rest for a moment first:
 * moving straight away is a swipe, and the browser scrolls instead (the element must allow panning,
 * not `touch-none`). Once the hold has started a drag, the page stops scrolling under the finger; a
 * chart that is wider than the screen scrolls itself when the drag reaches its edge (see the timeline).
 *
 * dnd-kit boards (kanban) get the same rule from its TouchSensor with these constants.
 */
import { useCallback, useEffect, useRef, type PointerEvent } from "react";

/** How long a finger must rest before it can drag (a swipe moves sooner). */
export const TOUCH_HOLD_MS = 250;
/** How far it may drift during that hold before the press counts as a swipe. */
export const TOUCH_HOLD_TOLERANCE_PX = 8;

/** What a pointer release meant, for the element that saw the press. */
export type Release =
  /** A finger let go before its hold was up: a tap. */
  | "tap"
  /** The press had started a drag (any pointer): finish it. */
  | "drag"
  /** Nothing to do: the press became a scroll, or was never ours. */
  | "none";

export interface HoldToDrag {
  /**
   * Call on pointerdown with what starts the drag. A mouse or pen starts it now; a finger after the
   * hold, unless it moves or lifts first. `start` gets no event: read what it needs beforehand.
   */
  press(e: PointerEvent<Element>, start: () => void): void;
  /** Call first in pointermove: false while a finger is still holding (ignore the move). */
  move(e: PointerEvent<Element>): boolean;
  /** Call in pointerup and pointercancel (`cancel` true) to learn what the press was. */
  release(e: PointerEvent<Element>, cancel?: boolean): Release;
}

/** Stops the page scrolling while a touch drag is under way (`touch-action` cannot change mid-touch). */
function blockScroll(e: TouchEvent): void {
  if (e.cancelable) e.preventDefault();
}

export function useHoldToDrag(): HoldToDrag {
  const waiting = useRef<{ id: number; x: number; y: number; timer: number } | null>(null);
  const dragging = useRef<number | null>(null);

  const stopBlocking = useCallback(() => window.removeEventListener("touchmove", blockScroll), []);
  const clearWait = useCallback(() => {
    if (waiting.current) window.clearTimeout(waiting.current.timer);
    waiting.current = null;
  }, []);
  useEffect(
    () => () => {
      clearWait();
      stopBlocking();
    },
    [clearWait, stopBlocking],
  );

  const press = useCallback(
    (e: PointerEvent<Element>, start: () => void) => {
      clearWait();
      if (e.pointerType !== "touch") {
        dragging.current = e.pointerId;
        start();
        return;
      }
      const id = e.pointerId;
      const timer = window.setTimeout(() => {
        waiting.current = null;
        dragging.current = id;
        window.addEventListener("touchmove", blockScroll, { passive: false });
        start();
      }, TOUCH_HOLD_MS);
      waiting.current = { id, x: e.clientX, y: e.clientY, timer };
    },
    [clearWait],
  );

  const move = useCallback(
    (e: PointerEvent<Element>) => {
      const w = waiting.current;
      if (w && w.id === e.pointerId) {
        // Moving during the hold: a swipe. Let the browser scroll; this press is over.
        if (Math.hypot(e.clientX - w.x, e.clientY - w.y) > TOUCH_HOLD_TOLERANCE_PX) clearWait();
        return false;
      }
      return dragging.current === e.pointerId;
    },
    [clearWait],
  );

  const release = useCallback(
    (e: PointerEvent<Element>, cancel = false): Release => {
      const w = waiting.current;
      if (w && w.id === e.pointerId) {
        clearWait();
        return cancel ? "none" : "tap";
      }
      if (dragging.current === e.pointerId) {
        dragging.current = null;
        stopBlocking();
        return "drag";
      }
      return "none";
    },
    [clearWait, stopBlocking],
  );

  return { press, move, release };
}
