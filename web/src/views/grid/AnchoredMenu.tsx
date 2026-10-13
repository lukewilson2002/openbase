/**
 * A dropdown menu opened at an arbitrary screen position (grid headers, cell right-clicks, the
 * summary bar). The canvas has no DOM trigger, so the menu hangs off a 1px fixed anchor.
 */
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function AnchoredMenu({ anchor, onClose, children, label, align = "start" }: { anchor: MenuAnchor | null; onClose: () => void; children: ReactNode; label: string; align?: "start" | "end" }) {
  return (
    <DropdownMenu
      open={anchor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: "fixed", left: anchor?.x ?? -9999, top: anchor?.y ?? -9999, width: Math.max(1, anchor?.width ?? 1), height: Math.max(1, anchor?.height ?? 1), pointerEvents: "none" }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={label} sideOffset={2} className="max-h-[min(28rem,80dvh)] overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
