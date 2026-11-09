/**
 * A dropdown menu opened at an arbitrary screen position (grid headers, cell right-clicks, the
 * summary bar, a right-click on a view button). It hangs off a fixed anchor of the given size, so it
 * needs no trigger of its own in the DOM.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function AnchoredMenu({ anchor, onClose, children, label, align = "start" }: { anchor: MenuAnchor | null; onClose: () => void; children: ReactNode; label: string; align?: "start" | "end" }) {
  // The trigger is an invisible anchor, so Radix has nowhere real to return focus to. The menu stays mounted through
  // its leaving animation, which lets focus fall to <body> after a caller has already refocused its own surface, so
  // take it back to what had it when the menu opened (the grid canvas, a view button). A layout effect runs before
  // the menu takes focus. Left alone when something else (a dialog the item opened) has focus by then.
  const opener = useRef<HTMLElement | null>(null);
  const isOpen = anchor !== null;
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [isOpen]);
  return (
    <DropdownMenu
      title={label}
      open={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: "fixed", left: anchor?.x ?? -9999, top: anchor?.y ?? -9999, width: Math.max(1, anchor?.width ?? 1), height: Math.max(1, anchor?.height ?? 1), pointerEvents: "none" }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={label} aria-labelledby={undefined} sideOffset={2} className="max-h-[min(28rem,var(--ob-avail))] overflow-y-auto" onCloseAutoFocus={(e) => {
          e.preventDefault();
          const el = opener.current;
          opener.current = null;
          const active = document.activeElement;
          if (el?.isConnected && (!active || active === document.body)) el.focus({ preventScroll: true });
        }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
