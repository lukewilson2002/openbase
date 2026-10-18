/**
 * Tap, not press, for things that open on a finger. Radix opens a dropdown menu on pointerdown for
 * every pointer, so on iOS a swipe that starts on a menu button opens the menu instead of scrolling.
 * `useTapGuard` keeps a mouse exactly as it was and gives a finger (or a pen) the phone rule: the
 * press only counts as a tap when the finger lets go in the same place. A press that moves, or that
 * the browser takes over for scrolling (`pointercancel`), opens nothing.
 *
 * Spread the handlers on the trigger and put `onPointerDown` first: it calls `preventDefault()` for a
 * touch, which Radix's own handler checks before it opens. `onTap` runs from the click that follows
 * a clean tap; a browser sends no click after a scroll, and the movement check covers a click that
 * arrives anyway. `onTap` is not called for a mouse (its press opened already) or for the keyboard
 * (Radix opens on the key and cancels it, so no click follows). A click with no press before it at
 * all is a screen reader or switch control activating the button: that opens too.
 */
import { useCallback, useRef, type PointerEvent } from "react";
import { TOUCH_HOLD_TOLERANCE_PX } from "./holdToDrag";

/** The pointer types that tap rather than press: fingers, and a pen on a tablet. */
function isTouchLike(e: PointerEvent<Element>): boolean {
  return e.pointerType === "touch" || e.pointerType === "pen";
}

export interface TapGuardHandlers {
  onPointerDown: (e: PointerEvent<Element>) => void;
  onPointerMove: (e: PointerEvent<Element>) => void;
  onPointerUp: (e: PointerEvent<Element>) => void;
  onPointerCancel: (e: PointerEvent<Element>) => void;
  onClick: () => void;
}

type Gesture =
  /** Nothing is pending: the next click came without a press (assistive technology). */
  | { phase: "idle" }
  /** A mouse pressed: Radix opened on it, the click that follows is not a second toggle. */
  | { phase: "pressed" }
  /** A finger is down at (x, y) and has not moved too far. */
  | { phase: "down"; id: number; x: number; y: number }
  /** The finger lifted in place: the click that follows is a tap. */
  | { phase: "tapped" }
  /** The finger moved or was taken over: whatever follows is not a tap. */
  | { phase: "swiped" };

export function useTapGuard(onTap: () => void): TapGuardHandlers {
  const gesture = useRef<Gesture>({ phase: "idle" });
  const tap = useRef(onTap);
  tap.current = onTap;

  const onPointerDown = useCallback((e: PointerEvent<Element>) => {
    if (!isTouchLike(e)) {
      gesture.current = { phase: "pressed" };
      return;
    }
    gesture.current = { phase: "down", id: e.pointerId, x: e.clientX, y: e.clientY };
    // Radix opens on a pointerdown nobody cancelled: a touch waits for the tap.
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<Element>) => {
    const g = gesture.current;
    if (g.phase !== "down" || g.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > TOUCH_HOLD_TOLERANCE_PX) gesture.current = { phase: "swiped" };
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<Element>) => {
    const g = gesture.current;
    if (g.phase !== "down" || g.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y) > TOUCH_HOLD_TOLERANCE_PX;
    gesture.current = moved ? { phase: "swiped" } : { phase: "tapped" };
  }, []);

  // iOS fires this when it takes the touch over to scroll.
  const onPointerCancel = useCallback(() => {
    gesture.current = { phase: "swiped" };
  }, []);

  const onClick = useCallback(() => {
    const was = gesture.current.phase;
    gesture.current = { phase: "idle" };
    if (was === "tapped" || was === "idle") tap.current();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}
