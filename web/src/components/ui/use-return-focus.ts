import { useRef } from "react";

/**
 * Puts focus back on the control that opened a Radix dialog when it closes (A11Y-1). Radix does this only for a
 * dialog opened with its own `Dialog.Trigger`; the app opens most of them from state, so by default focus would
 * land on the page. Spread the result on `Dialog.Content`, calling its `onOpenAutoFocus` from yours (and from
 * `onCloseAutoFocus` if you have one). When the opener is gone by then (it was a menu item) Radix's own
 * fallback applies.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    /** Notes what has focus, which at this moment is still the opener. */
    noteOpener() {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus(event: Event) {
      const el = opener.current;
      opener.current = null;
      if (event.defaultPrevented || !el?.isConnected) return;
      event.preventDefault();
      el.focus({ preventScroll: true });
    },
  };
}
