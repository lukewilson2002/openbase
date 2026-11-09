/**
 * A touch hold that opens a row's action sheet (COL-9, PH-6): a finger that rests on a card or row for the
 * hold time and lets go without moving opens its menu; a hold that then moves is a drag (the card's own
 * drag sensor takes it, where the card can be dragged) and a finger that moves before the hold is up is a
 * scroll. A mouse or pen has the right-click menu, so only touch is read here.
 *
 * Spread `handlers` on the card or row. The menu opens a moment after the finger lifts, not on the lift:
 * the browser sends the click of a still press right after it, and a sheet that was already there would
 * take that click for a tap on its dimmed screen. The click is swallowed so the press does not also open
 * the record. Android also sends a `contextmenu` event while the finger is still down; `onContextMenu`
 * reads it as the hold (and opens the menu itself where no finger is involved, a right-click). iOS sends
 * none, which is why the hold is timed here instead.
 */
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from "./holdToDrag";

/** Where a menu hangs (the same shape as the anchored menu's). */
export interface HoldAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long after a hold's release a click is still the hold's own. */
const CLICK_WINDOW_MS = 600;
/** The pause between the lift and the sheet, so the click that follows lands on the card, not the sheet. */
const OPEN_DELAY_MS = 80;

interface Press {
  id: number;
  x: number;
  y: number;
  timer: number;
  /** The hold time passed with the finger still. */
  held: boolean;
  /** The finger moved past the tolerance: a scroll before the hold, a drag after it. */
  moved: boolean;
  /** `contextmenu` arrived during the press (Android's long press). */
  contextMenu: boolean;
}

export interface HoldMenuHandlers {
  onPointerDown(e: PointerEvent<Element>): void;
  onPointerMove(e: PointerEvent<Element>): void;
  onPointerUp(e: PointerEvent<Element>): void;
  onPointerCancel(e: PointerEvent<Element>): void;
  onClickCapture(e: MouseEvent<Element>): void;
  /** A right-click opens the menu at the pointer; a long press on a touch screen is read as the hold. */
  onContextMenu(e: MouseEvent<Element>): void;
}

/**
 * A hold is not started on a link or a button of its own inside the card (a tick box, a chip that opens something), nor on
 * something drawn elsewhere in the page whose events still reach the card through React (the card's own sheet or menu).
 */
function ignored(target: EventTarget | null, on?: Element): boolean {
  if (on && target instanceof Node && !on.contains(target)) return true;
  return target instanceof Element && target.closest("a, [data-no-hold]") !== null;
}

/**
 * `open` is called with where the finger was (or the pointer, for a right-click). Pass `enabled` false for a
 * row that has no menu.
 */
export function useHoldMenu(open: (anchor: HoldAnchor) => void, enabled = true): HoldMenuHandlers {
  const press = useRef<Press | null>(null);
  const opening = useRef(0);
  const swallowUntil = useRef(0);
  const latest = useRef(open);
  latest.current = open;

  const clear = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(
    () => () => {
      clear();
      window.clearTimeout(opening.current);
    },
    [clear],
  );

  const openSoon = useCallback((x: number, y: number) => {
    swallowUntil.current = Date.now() + CLICK_WINDOW_MS;
    window.clearTimeout(opening.current);
    opening.current = window.setTimeout(() => latest.current({ x, y, width: 1, height: 1 }), OPEN_DELAY_MS);
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<Element>) => {
      if (!enabled || e.pointerType !== "touch" || ignored(e.target, e.currentTarget)) return;
      clear();
      const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0, held: false, moved: false, contextMenu: false };
      p.timer = window.setTimeout(() => {
        p.held = true;
      }, TOUCH_HOLD_MS);
      press.current = p;
    },
    [enabled, clear],
  );

  const onPointerMove = useCallback((e: PointerEvent<Element>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId || p.moved) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TOUCH_HOLD_TOLERANCE_PX) {
      p.moved = true;
      // Before the hold is up this is a swipe: nothing is waiting any more.
      if (!p.held) window.clearTimeout(p.timer);
    }
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent<Element>) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      press.current = null;
      window.clearTimeout(p.timer);
      if (p.held && !p.moved) openSoon(e.clientX, e.clientY);
    },
    [openSoon],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<Element>) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      press.current = null;
      window.clearTimeout(p.timer);
      // The browser's own long press can end the touch with a cancel after `contextmenu`; a cancel after
      // the finger moved is a scroll taking over.
      if (p.contextMenu && !p.moved) openSoon(e.clientX, e.clientY);
    },
    [openSoon],
  );

  const onClickCapture = useCallback((e: MouseEvent<Element>) => {
    // A tap on the sheet this hold opened is the sheet's own.
    if (Date.now() >= swallowUntil.current || !e.currentTarget.contains(e.target as Node)) return;
    swallowUntil.current = 0;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onContextMenu = useCallback(
    (e: MouseEvent<Element>) => {
      if (!enabled || ignored(e.target, e.currentTarget)) return;
      e.preventDefault();
      const p = press.current;
      if (p) {
        // A finger is down: this is its long press. The lift opens the menu.
        p.contextMenu = true;
        p.held = true;
        return;
      }
      // The keyboard's menu key sends 0, 0: hang the menu on the element.
      const r = e.currentTarget.getBoundingClientRect();
      latest.current(e.clientX === 0 && e.clientY === 0 ? { x: r.left + 12, y: r.top + 12, width: 1, height: 1 } : { x: e.clientX, y: e.clientY, width: 1, height: 1 });
    },
    [enabled],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenu };
}
