import { useLayoutEffect, useRef } from "react";

/**
 * Puts focus back on the control that opened a Radix dialog when it closes (A11Y-1). Radix does this only for a
 * dialog opened with its own `Dialog.Trigger`; the app opens most of them from state, so by default focus would
 * land on the page. Spread the result on `Dialog.Content`, calling its `onOpenAutoFocus` from yours (and from
 * `onCloseAutoFocus` if you have one). When the opener is gone by then (it was a menu item) Radix's own
 * fallback applies.
 *
 * Pass `open`: the opener is noted as the dialog opens, before its content mounts, because a field in the content
 * with `autoFocus` takes focus before `onOpenAutoFocus` runs and would be noted in the opener's place.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const note = () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
  useLayoutEffect(() => {
    if (open) note();
  }, [open]);
  return {
    /** Notes what has focus, which at this moment is still the opener; an opener noted as the dialog opened stays. */
    noteOpener() {
      if (!opener.current?.isConnected) note();
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
