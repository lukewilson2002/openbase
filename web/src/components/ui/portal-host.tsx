import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PortalHostValue {
  /** Where floating panels (popovers, menus, tooltips, dialogs, sheets) are drawn; `undefined` is the page's <body>. */
  container: HTMLElement | undefined;
  /** Draw modal pieces open in place, without the focus trap, scroll lock or `aria-hidden` on the rest of the page. */
  inline: boolean;
}

const DEFAULT: PortalHostValue = { container: undefined, inline: false };
const PortalHostContext = createContext<PortalHostValue>(DEFAULT);

/**
 * Moves the floating panels of everything inside it into `container`. The app never needs it: panels go to
 * <body>, as Radix does by default. The design reference page (`/__dev/design`) shows each theme in its own
 * column, and a panel in <body> would take the page's theme instead of its column's; with `inline` it also
 * shows a dialog or sheet open inside a frame, side by side with others, which a modal would not allow.
 */
export function PortalHost({ container, inline = false, children }: { container: HTMLElement | null; inline?: boolean; children: ReactNode }) {
  const value = useMemo<PortalHostValue>(() => ({ container: container ?? undefined, inline }), [container, inline]);
  return <PortalHostContext value={value}>{children}</PortalHostContext>;
}

export function usePortalHost(): PortalHostValue {
  return useContext(PortalHostContext);
}
