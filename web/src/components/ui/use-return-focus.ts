import { useLayoutEffect, useRef } from "react";

/** What opened each open sheet, for a dialog that a row of the sheet opens (the row is gone when the sheet closes). */
const openerOfSheet = new WeakMap<Element, HTMLElement>();

/**
 * Where focus should return when `el` is what opened a dialog. A menu item or a sheet's row closes its menu as it
 * acts, so it is gone by the time the dialog closes; the button that opened the menu stands in for it.
 */
function standIn(el: HTMLElement): HTMLElement {
  let target = el;
  // A menu inside a menu (a sheet menu opened from a dropdown's row) is walked out of, one level at a time.
  for (let hops = 0; hops < 5; hops++) {
    const menu = target.closest<HTMLElement>('[role="menu"]');
    const sheet = target.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    // The dropdown's own trigger says it controls the open menu; the menu is the nearer container when it is inside a dialog.
    const next = (menu && (!sheet || sheet.contains(menu)) ? triggerOf(menu) : undefined) ?? (sheet ? openerOfSheet.get(sheet) : undefined);
    if (!next || next === target) break;
    target = next;
  }
  return target;
}

function triggerOf(menu: HTMLElement): HTMLElement | undefined {
  if (!menu.id) return undefined;
  return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? undefined;
}

/**
 * Puts focus back on the control that opened a Radix dialog when it closes (A11Y-1). Radix does this only for a
 * dialog opened with its own `Dialog.Trigger`; the app opens most of them from state, so by default focus would
 * land on the page. Spread the result on `Dialog.Content`, calling its `onOpenAutoFocus` from yours (and from
 * `onCloseAutoFocus` if you have one). When the opener is gone by then (it was a menu item or a row of a sheet)
 * the button that opened that menu or sheet gets the focus instead.
 *
 * Pass `open`: the opener is noted as the dialog opens, before its content mounts, because a field in the content
 * with `autoFocus` takes focus before `onOpenAutoFocus` runs and would be noted in the opener's place.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  // Who to return to when `opener` is gone by then: the button of the menu or sheet it was in.
  const stand = useRef<HTMLElement | null>(null);
  const note = () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    stand.current = opener.current && standIn(opener.current);
  };
  useLayoutEffect(() => {
    if (open) note();
  }, [open]);
  return {
    /**
     * Notes what has focus, which at this moment is still the opener; an opener noted as the dialog opened stays (and so does the button standing in for it).
     * Pass the content when it can be the home of an opener itself (a sheet): a dialog opened from one of its rows
     * returns to the button that opened the sheet.
     */
    noteOpener(content?: Element | null) {
      if (!opener.current?.isConnected && !stand.current?.isConnected) note();
      if (content && stand.current) openerOfSheet.set(content, stand.current);
    },
    onCloseAutoFocus(event: Event) {
      const el = opener.current?.isConnected ? opener.current : stand.current;
      opener.current = null;
      stand.current = null;
      if (event.defaultPrevented || !el?.isConnected) return;
      event.preventDefault();
      el.focus({ preventScroll: true });
    },
  };
}
